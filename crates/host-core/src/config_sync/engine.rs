use super::domains::{self, CategorySelection, LocalSnapshot, PortableEntity, RevisionManifest};
use super::merge::{self, MergeConflict};
use super::{
    create_vault, decrypt_object, encrypt_object, rewrap_vault, unlock_vault, vault_key_b64,
    vault_key_from_b64, VaultHeader, VaultKey, WebDavConfig, WebDavTransport,
};
use crate::agent_capabilities::CapabilityLevel;
use crate::mcp_servers::McpServerInput;
use crate::providers::{self, ProviderCreateInput, ProviderUpdateInput};
use crate::state::AppState;
use anyhow::{anyhow, bail, Context, Result};
use chrono::Utc;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tokio::sync::{mpsc, Mutex};
use uuid::Uuid;

#[path = "apply.rs"]
mod apply;
#[path = "coordinator.rs"]
mod coordinator;
#[path = "handlers.rs"]
mod handlers;
#[path = "engine_history.rs"]
mod history;
#[path = "engine_remote.rs"]
mod remote;
#[cfg(test)]
pub(crate) use apply::validate_application_references;
pub(crate) use apply::{apply_bundle, recover_import_journal};
pub(crate) use coordinator::{sync_if_enabled, sync_now};
pub(crate) use handlers::{
    approve, change_password, configure, disconnect, get_state, list_history, map_project, pause,
    reject, restore, test, unlock,
};
use history::cleanup_history;
use remote::{
    ensure_remote_collections, object_path, publish_head, read_remote_head, read_remote_manifest,
    read_remote_revision, revision_path, upload_snapshot, validate_remote_id,
};

const CONFIG_NS: &str = "configSync";
const CONFIG_KEY: &str = "config";
const WEBDAV_SECRET_REF: &str = "secret:config-sync:webdav-password";
const FORMAT: &str = "pi-desktop-config-sync";
const REVISION_FORMAT: &str = "pi-desktop-config-revision";
const MAX_ENTITIES: usize = 4096;
const MAX_RESOURCES: usize = 4096;
const MAX_RETRIES: usize = 3;
const MAX_HISTORY_SCAN: usize = 256;
const MAX_RETAINED_REVISIONS: usize = 30;
const HISTORY_GRACE_SECONDS: i64 = 60 * 60;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredConfig {
    pub format: String,
    pub version: u32,
    pub endpoint: String,
    pub username: String,
    pub directory: String,
    pub device_label: String,
    pub allow_insecure_http: bool,
    pub categories: BTreeMap<String, bool>,
    pub include_secrets: bool,
    pub include_memory: bool,
    pub automatic_sync: bool,
    pub enabled: bool,
    pub paused: bool,
    pub vault_id: String,
    pub vault_header: VaultHeader,
    #[serde(default)]
    pub last_run_at: Option<String>,
    #[serde(default)]
    pub last_success_at: Option<String>,
    #[serde(default)]
    pub last_revision_id: Option<String>,
    #[serde(default)]
    pub last_error: Option<String>,
    #[serde(default)]
    pub last_error_code: Option<String>,
    #[serde(default)]
    pub last_local_digest: Option<String>,
    #[serde(default)]
    pub local_change_seen_at: Option<String>,
    #[serde(default)]
    pub retry_count: u32,
    #[serde(default)]
    pub next_retry_at: Option<String>,
    #[serde(default)]
    pub project_mappings: BTreeMap<String, String>,
    #[serde(default)]
    pub project_group_mappings: BTreeMap<String, Vec<String>>,
    #[serde(default)]
    pub dismissed: BTreeMap<String, String>,
    /// Approved plugin installation intent without plugin bytes or grants.
    #[serde(default)]
    pub plugin_intents: BTreeMap<String, Value>,
    #[serde(default)]
    pub recovery_points: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteHead {
    pub format: String,
    pub version: u32,
    pub revision_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PendingApproval {
    approval_id: String,
    entity: PortableEntity,
    reason: String,
    #[serde(default)]
    approved: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PendingBundle {
    manifest: RevisionManifest,
    #[serde(default)]
    local_before: Option<RevisionManifest>,
    #[serde(default)]
    resources: BTreeMap<String, Vec<u8>>,
    approvals: Vec<PendingApproval>,
    #[serde(default)]
    conflicts: Vec<MergeConflict>,
    #[serde(default = "default_journal_state")]
    journal_state: String,
    remote_revision_id: String,
}

fn default_journal_state() -> String {
    "staged".into()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicPendingApproval {
    id: String,
    domain: String,
    entity_id: String,
    label: String,
    reason: String,
    digest: String,
    created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    mapping_key: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicProjectMapping {
    logical_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    paths: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicHistoryEntry {
    revision_id: String,
    created_at: String,
    parent_revision_ids: Vec<String>,
    entity_count: usize,
    resource_count: usize,
    current: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecoveryPoint {
    format: String,
    version: u32,
    created_at: String,
    base: Option<RevisionManifest>,
    snapshot: LocalSnapshot,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicState {
    configured: bool,
    enabled: bool,
    paused: bool,
    locked: bool,
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    endpoint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    directory: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    device_label: Option<String>,
    categories: BTreeMap<String, bool>,
    include_secrets: bool,
    include_memory: bool,
    automatic_sync: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_run_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_success_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_revision_id: Option<String>,
    pending_approvals: Vec<PublicPendingApproval>,
    mappings: Vec<PublicProjectMapping>,
    #[serde(skip_serializing_if = "Option::is_none")]
    preview: Option<domains::PreviewCounts>,
}

fn default_categories() -> BTreeMap<String, bool> {
    CategorySelection::all_selected().0
}

fn selection(config: &StoredConfig) -> CategorySelection {
    let mut values = default_categories();
    values.extend(config.categories.clone());
    values.insert("credentials".to_string(), config.include_secrets);
    values.insert(domains::DOMAIN_MEMORY.to_string(), config.include_memory);
    CategorySelection(values)
}

fn identity_overrides(config: &StoredConfig) -> domains::ProjectIdentityOverrides {
    domains::ProjectIdentityOverrides::from_mappings(
        &config.project_mappings,
        &config.project_group_mappings,
    )
}

fn config_dir(st: &AppState) -> PathBuf {
    st.data_dir.join("config-sync")
}

fn local_path(st: &AppState, name: &str) -> PathBuf {
    config_dir(st).join(name)
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| anyhow!("config sync path has no parent"))?;
    fs::create_dir_all(parent)?;
    let name = path
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| "state".into());
    let temporary = parent.join(format!(".{name}.{}.tmp", Uuid::new_v4()));
    fs::write(&temporary, bytes).with_context(|| format!("write {}", temporary.display()))?;
    fs::rename(&temporary, path).with_context(|| format!("replace {}", path.display()))?;
    Ok(())
}

fn persist_encrypted<T: Serialize>(
    st: &AppState,
    key: &VaultKey,
    purpose: &str,
    path: &Path,
    value: &T,
) -> Result<()> {
    let plain = serde_json::to_vec(value)?;
    let encrypted = encrypt_object(key, purpose, &keyed_vault_id(st)?, &plain)?;
    atomic_write(path, &encrypted)
}

fn load_encrypted<T: for<'de> Deserialize<'de>>(
    st: &AppState,
    key: &VaultKey,
    purpose: &str,
    path: &Path,
) -> Result<Option<T>> {
    if !path.exists() {
        return Ok(None);
    }
    let bytes = fs::read(path).with_context(|| format!("read {}", path.display()))?;
    if bytes.len() > 64 * 1024 * 1024 {
        bail!("CONFIG_SYNC_LIMIT_EXCEEDED: local sync state is too large");
    }
    let plain = decrypt_object(key, purpose, &keyed_vault_id(st)?, &bytes)?;
    Ok(Some(
        serde_json::from_slice(&plain).context("decode local sync state")?,
    ))
}

fn keyed_vault_id(st: &AppState) -> Result<String> {
    let config =
        load_config(st)?.ok_or_else(|| anyhow!("CONFIG_SYNC_LOCKED: sync is not configured"))?;
    Ok(config.vault_id)
}

fn load_config(st: &AppState) -> Result<Option<StoredConfig>> {
    let Some(value) = st.db.kv_get(CONFIG_NS, CONFIG_KEY)? else {
        return Ok(None);
    };
    let config: StoredConfig =
        serde_json::from_value(value).context("decode config sync settings")?;
    if config.format != FORMAT || config.version != 1 {
        bail!("CONFIG_SYNC_UNSUPPORTED: unsupported local sync settings");
    }
    Ok(Some(config))
}

fn save_config(st: &AppState, config: &StoredConfig) -> Result<()> {
    st.db
        .kv_set(CONFIG_NS, CONFIG_KEY, &serde_json::to_value(config)?)
}

fn secret_ref_for_vault(vault_id: &str) -> String {
    format!("secret:config-sync:{vault_id}:vault-key")
}

fn local_vault_key(st: &AppState, config: &StoredConfig) -> Result<Option<VaultKey>> {
    let Some(encoded) = st.secrets.get(&secret_ref_for_vault(&config.vault_id))? else {
        return Ok(None);
    };
    Ok(Some(vault_key_from_b64(&encoded)?))
}

fn webdav_password(st: &AppState, config: &StoredConfig) -> Result<String> {
    if config.username.is_empty() {
        return Ok(String::new());
    }
    st.secrets
        .get(WEBDAV_SECRET_REF)?
        .ok_or_else(|| anyhow!("CONFIG_SYNC_LOCKED: WebDAV app password is not available"))
}

fn transport_with_password(config: &StoredConfig, password: String) -> Result<WebDavTransport> {
    WebDavTransport::new(&WebDavConfig {
        endpoint: config.endpoint.clone(),
        username: config.username.clone(),
        password,
        directory: config.directory.clone(),
        allow_insecure_http: config.allow_insecure_http,
    })
}

fn entity_key(entity: &PortableEntity) -> (String, String) {
    (entity.domain.clone(), entity.entity_id.clone())
}

fn approval_key(entity: &PortableEntity) -> String {
    format!("{}:{}", entity.domain, entity.entity_id)
}

fn conflict_base_id(entity_id: &str) -> Option<&str> {
    entity_id
        .strip_suffix(":local")
        .or_else(|| entity_id.strip_suffix(":remote"))
}

fn manifest_map(manifest: Option<&RevisionManifest>) -> BTreeMap<(String, String), PortableEntity> {
    manifest
        .map(|value| {
            value
                .entities
                .iter()
                .cloned()
                .map(|entity| (entity_key(&entity), entity))
                .collect()
        })
        .unwrap_or_default()
}

fn logical_entity_key(entity: &PortableEntity) -> (String, String) {
    (
        entity.domain.clone(),
        conflict_base_id(&entity.entity_id)
            .unwrap_or(&entity.entity_id)
            .to_string(),
    )
}

fn logical_manifest_map(
    manifest: Option<&RevisionManifest>,
) -> BTreeMap<(String, String), PortableEntity> {
    manifest
        .map(|value| {
            value
                .entities
                .iter()
                .cloned()
                .map(|entity| (logical_entity_key(&entity), entity))
                .collect()
        })
        .unwrap_or_default()
}

fn selected_manifests_equal(
    left: Option<&RevisionManifest>,
    right: Option<&RevisionManifest>,
    selection: &CategorySelection,
) -> bool {
    let left = manifest_map(left);
    let right = manifest_map(right);
    let keys = left
        .keys()
        .chain(right.keys())
        .cloned()
        .collect::<BTreeSet<_>>();
    keys.into_iter().all(|(domain, entity_id)| {
        !selection.is_selected(&domain)
            || left.get(&(domain.clone(), entity_id.clone())) == right.get(&(domain, entity_id))
    })
}

fn approval_reason(entity: &PortableEntity, conflict: bool, new_device: bool) -> String {
    if conflict {
        "conflict".into()
    } else if new_device {
        "newDevice".into()
    } else if entity.mapping_required {
        "mapping".into()
    } else if entity.secret_bearing {
        "dependency".into()
    } else {
        "securityChange".into()
    }
}

fn build_pending(
    config: &StoredConfig,
    base: Option<&RevisionManifest>,
    local: &RevisionManifest,
    remote: Option<&RevisionManifest>,
    merged: &merge::MergeResult,
    remote_revision_id: &str,
    resources: BTreeMap<String, Vec<u8>>,
) -> PendingBundle {
    let base_map = manifest_map(base);
    let local_map = manifest_map(Some(local));
    let remote_map = manifest_map(remote);
    let selected = selection(config);
    let conflict_ids: BTreeSet<(String, String)> = merged
        .conflicts
        .iter()
        .map(|conflict| (conflict.domain.clone(), conflict.entity_id.clone()))
        .collect();
    let mut approvals = Vec::new();
    for entity in &merged.entities {
        if !selected.is_selected(&entity.domain) {
            continue;
        }
        let key = entity_key(entity);
        let remote_entity = remote_map.get(&key);
        let remote_changed = remote_entity.is_some_and(|remote| {
            base_map
                .get(&key)
                .is_none_or(|base| base.digest != remote.digest)
        });
        let new_device = base.is_none() && remote_entity.is_some();
        let local_same = local_map
            .get(&key)
            .is_some_and(|local| local.digest == entity.digest);
        let conflict = entity.entity_id.ends_with(":local")
            || entity.entity_id.ends_with(":remote")
            || conflict_ids.contains(&key);
        if (remote_changed || conflict)
            && !local_same
            && (entity.requires_approval || entity.mapping_required || conflict)
            && config.dismissed.get(&approval_key(entity)) != Some(&entity.digest)
        {
            approvals.push(PendingApproval {
                approval_id: Uuid::new_v4().to_string(),
                entity: entity.clone(),
                reason: approval_reason(entity, conflict, new_device),
                approved: false,
            });
        }
    }
    PendingBundle {
        manifest: RevisionManifest {
            format: REVISION_FORMAT.to_string(),
            version: 1,
            revision_id: remote_revision_id.to_string(),
            parents: vec![],
            created_at: Utc::now().to_rfc3339(),
            entities: merged.entities.clone(),
            resource_ids: resources.keys().cloned().collect(),
        },
        local_before: Some(local.clone()),
        resources,
        approvals,
        conflicts: merged.conflicts.clone(),
        journal_state: default_journal_state(),
        remote_revision_id: remote_revision_id.to_string(),
    }
}

fn public_pending(bundle: Option<&PendingBundle>) -> Vec<PublicPendingApproval> {
    bundle
        .map(|bundle| {
            bundle
                .approvals
                .iter()
                .filter(|item| !item.approved)
                .map(|item| PublicPendingApproval {
                    id: item.approval_id.clone(),
                    domain: item.entity.domain.clone(),
                    entity_id: item.entity.entity_id.clone(),
                    label: item.entity.label.clone(),
                    reason: item.reason.clone(),
                    digest: item.entity.digest.clone(),
                    created_at: Utc::now().to_rfc3339(),
                    mapping_key: item
                        .entity
                        .payload
                        .get("projectGroupLogicalId")
                        .or_else(|| item.entity.payload.get("projectLogicalId"))
                        .or_else(|| item.entity.payload.get("workspaceProjectLogicalId"))
                        .or_else(|| item.entity.payload.get("logicalId"))
                        .and_then(Value::as_str)
                        .map(str::to_string),
                })
                .collect()
        })
        .unwrap_or_default()
}

fn public_mappings(config: &StoredConfig) -> Vec<PublicProjectMapping> {
    let mut mappings = config
        .project_mappings
        .iter()
        .map(|(logical_id, path)| {
            (
                logical_id.clone(),
                PublicProjectMapping {
                    logical_id: logical_id.clone(),
                    path: Some(path.clone()),
                    paths: None,
                },
            )
        })
        .collect::<BTreeMap<_, _>>();
    for (logical_id, paths) in &config.project_group_mappings {
        mappings.insert(
            logical_id.clone(),
            PublicProjectMapping {
                logical_id: logical_id.clone(),
                path: (paths.len() == 1).then(|| paths[0].clone()),
                paths: (paths.len() > 1).then(|| paths.clone()),
            },
        );
    }
    mappings.into_values().collect()
}

fn status(
    config: Option<&StoredConfig>,
    key: Option<&VaultKey>,
    pending: Option<&PendingBundle>,
    syncing: bool,
    local_changes_pending: bool,
) -> String {
    let Some(config) = config else {
        return "notConfigured".into();
    };
    if config.paused {
        return "paused".into();
    }
    if key.is_none() {
        return "locked".into();
    }
    if syncing {
        return "syncing".into();
    }
    if pending.is_some_and(|value| !value.approvals.is_empty()) {
        if pending.is_some_and(|value| !value.conflicts.is_empty()) {
            return "conflict".into();
        }
        return "awaitingActivation".into();
    }
    if config.last_error_code.as_deref() == Some("CONFLICT") {
        return "conflict".into();
    }
    if config.last_error_code.as_deref() == Some("UNSUPPORTED_SERVER") {
        return "unsupportedServer".into();
    }
    if config.last_error_code.as_deref() == Some("OFFLINE") {
        return "offline".into();
    }
    if config.last_error.is_some() {
        return "error".into();
    }
    if local_changes_pending {
        return "localChangesPending".into();
    }
    if config.last_success_at.is_some() {
        "upToDate".into()
    } else {
        "localChangesPending".into()
    }
}

pub fn public_state(st: &mut AppState) -> Result<Value> {
    let mut config = load_config(st)?;
    let Some(initial_config) = config.as_ref() else {
        return Ok(serde_json::to_value(PublicState {
            configured: false,
            enabled: false,
            paused: false,
            locked: false,
            status: "notConfigured".into(),
            endpoint: None,
            username: None,
            directory: None,
            device_label: None,
            categories: default_categories(),
            include_secrets: false,
            include_memory: false,
            automatic_sync: false,
            last_run_at: None,
            last_success_at: None,
            last_error: None,
            last_revision_id: None,
            pending_approvals: vec![],
            mappings: vec![],
            preview: None,
        })?);
    };
    let key = local_vault_key(st, initial_config)?;
    let mut pending = key
        .as_ref()
        .map(|key| load_pending(st, key))
        .transpose()?
        .flatten();
    if let (Some(key), Some(bundle)) = (key.as_ref(), pending.as_ref()) {
        if bundle.journal_state == "applying" {
            let mut recovered = config
                .take()
                .ok_or_else(|| anyhow!("CONFIG_SYNC_INVALID: sync configuration disappeared"))?;
            if let Err(error) = recover_import_journal(st, &mut recovered, key, bundle) {
                mark_error(&mut recovered, &error);
                save_config(st, &recovered)?;
            }
            config = Some(recovered);
            pending = load_pending(st, key)?;
        }
    }
    let config_ref = config
        .as_ref()
        .ok_or_else(|| anyhow!("CONFIG_SYNC_INVALID: sync configuration disappeared"))?;
    let syncing = st.config_sync_in_progress.load(Ordering::Relaxed);
    let preview = if let Some(bundle) = pending.as_ref() {
        let snapshot = LocalSnapshot {
            manifest: bundle.manifest.clone(),
            resources: bundle.resources.clone(),
        };
        Some(domains::preview(&snapshot, &selection(config_ref)))
    } else if let Some(key) = key.as_ref() {
        let snapshot = domains::capture(
            st,
            key,
            &selection(config_ref),
            config_ref.include_secrets,
            &config_ref.plugin_intents,
            &identity_overrides(config_ref),
        )?;
        Some(domains::preview(&snapshot, &selection(config_ref)))
    } else {
        None
    };
    let local_changes_pending = if syncing {
        false
    } else {
        match (
            key.as_ref(),
            config_ref.last_success_at.as_ref(),
            config_ref.last_local_digest.as_deref(),
        ) {
            (Some(key), Some(_), Some(expected)) => {
                let snapshot = domains::capture(
                    st,
                    key,
                    &selection(config_ref),
                    config_ref.include_secrets,
                    &config_ref.plugin_intents,
                    &identity_overrides(config_ref),
                )?;
                domains::snapshot_digest(&snapshot) != expected
            }
            _ => false,
        }
    };
    Ok(serde_json::to_value(PublicState {
        configured: true,
        enabled: config_ref.enabled,
        paused: config_ref.paused,
        locked: key.is_none(),
        status: status(
            Some(config_ref),
            key.as_ref(),
            pending.as_ref(),
            syncing,
            local_changes_pending,
        ),
        endpoint: Some(config_ref.endpoint.clone()),
        username: Some(config_ref.username.clone()),
        directory: Some(config_ref.directory.clone()),
        device_label: Some(config_ref.device_label.clone()),
        categories: config_ref.categories.clone(),
        include_secrets: config_ref.include_secrets,
        include_memory: config_ref.include_memory,
        automatic_sync: config_ref.automatic_sync,
        last_run_at: config_ref.last_run_at.clone(),
        last_success_at: config_ref.last_success_at.clone(),
        last_error: config_ref.last_error.clone(),
        last_revision_id: config_ref.last_revision_id.clone(),
        pending_approvals: public_pending(pending.as_ref()),
        mappings: public_mappings(config_ref),
        preview,
    })?)
}

fn parse_category_selection(
    value: Option<&Value>,
    existing: Option<&BTreeMap<String, bool>>,
    include_memory: bool,
) -> BTreeMap<String, bool> {
    let mut selected = existing.cloned().unwrap_or_else(default_categories);
    if let Some(object) = value.and_then(Value::as_object) {
        for (key, value) in object {
            if domains::ALL_DOMAINS.contains(&key.as_str()) && value.is_boolean() {
                selected.insert(key.clone(), value.as_bool().unwrap_or(true));
            }
        }
    }
    selected.insert("credentials".into(), false);
    selected.insert(domains::DOMAIN_MEMORY.into(), include_memory);
    selected
}

fn config_from_input(
    existing: Option<&StoredConfig>,
    input: &Value,
    header: VaultHeader,
) -> Result<StoredConfig> {
    let endpoint = input
        .get("endpoint")
        .and_then(Value::as_str)
        .or_else(|| existing.map(|value| value.endpoint.as_str()))
        .unwrap_or_default()
        .trim()
        .to_string();
    let username = input
        .get("username")
        .and_then(Value::as_str)
        .or_else(|| existing.map(|value| value.username.as_str()))
        .unwrap_or_default()
        .trim()
        .to_string();
    let directory = input
        .get("directory")
        .and_then(Value::as_str)
        .or_else(|| existing.map(|value| value.directory.as_str()))
        .unwrap_or_default()
        .trim()
        .to_string();
    let device_label = input
        .get("deviceLabel")
        .and_then(Value::as_str)
        .or_else(|| existing.map(|value| value.device_label.as_str()))
        .unwrap_or("This device")
        .trim()
        .to_string();
    if endpoint.is_empty() || device_label.is_empty() {
        bail!("CONFIG_SYNC_INVALID: endpoint and device label are required");
    }
    let include_memory = input
        .get("includeMemory")
        .and_then(Value::as_bool)
        .or_else(|| existing.map(|value| value.include_memory))
        .unwrap_or(false);
    let include_secrets = input
        .get("includeSecrets")
        .and_then(Value::as_bool)
        .or_else(|| existing.map(|value| value.include_secrets))
        .unwrap_or(false);
    let mut categories = parse_category_selection(
        input.get("categories"),
        existing.map(|value| &value.categories),
        include_memory,
    );
    categories.insert("credentials".into(), include_secrets);
    Ok(StoredConfig {
        format: FORMAT.into(),
        version: 1,
        endpoint,
        username,
        directory,
        device_label,
        allow_insecure_http: input
            .get("allowInsecureHttp")
            .and_then(Value::as_bool)
            .or_else(|| existing.map(|value| value.allow_insecure_http))
            .unwrap_or(false),
        categories,
        include_secrets,
        include_memory,
        automatic_sync: input
            .get("automaticSync")
            .and_then(Value::as_bool)
            .or_else(|| existing.map(|value| value.automatic_sync))
            .unwrap_or(true),
        enabled: true,
        paused: false,
        vault_id: header.vault_id.clone(),
        vault_header: header,
        last_run_at: existing.and_then(|value| value.last_run_at.clone()),
        last_success_at: existing.and_then(|value| value.last_success_at.clone()),
        last_revision_id: existing.and_then(|value| value.last_revision_id.clone()),
        last_error: None,
        last_error_code: None,
        last_local_digest: existing.and_then(|value| value.last_local_digest.clone()),
        local_change_seen_at: existing.and_then(|value| value.local_change_seen_at.clone()),
        retry_count: existing.map(|value| value.retry_count).unwrap_or(0),
        next_retry_at: existing.and_then(|value| value.next_retry_at.clone()),
        project_mappings: existing
            .map(|value| value.project_mappings.clone())
            .unwrap_or_default(),
        project_group_mappings: existing
            .map(|value| value.project_group_mappings.clone())
            .unwrap_or_default(),
        dismissed: existing
            .map(|value| value.dismissed.clone())
            .unwrap_or_default(),
        plugin_intents: existing
            .map(|value| value.plugin_intents.clone())
            .unwrap_or_default(),
        recovery_points: existing
            .map(|value| value.recovery_points.clone())
            .unwrap_or_default(),
    })
}

fn mark_error(config: &mut StoredConfig, error: &anyhow::Error) {
    let message = error.to_string();
    config.last_error_code = if message.starts_with("CONFIG_SYNC_UNSUPPORTED") {
        Some("UNSUPPORTED_SERVER".into())
    } else if message.starts_with("CONFIG_SYNC_CONFLICT") {
        Some("CONFLICT".into())
    } else if message.starts_with("CONFIG_SYNC_CRYPTO")
        || message.contains("401 Unauthorized")
        || message.contains("403 Forbidden")
        || message.contains("authentication")
    {
        Some("AUTH_REQUIRED".into())
    } else if super::remote_error_is_offline(error) {
        Some("OFFLINE".into())
    } else if message.starts_with("CONFIG_SYNC_LOCKED") {
        Some("LOCKED".into())
    } else {
        Some("ERROR".into())
    };
    config.last_error = Some(message.chars().take(500).collect());
}

fn clear_error(config: &mut StoredConfig) {
    config.last_error = None;
    config.last_error_code = None;
    config.retry_count = 0;
    config.next_retry_at = None;
}

fn retry_deadline(config: &StoredConfig) -> Option<chrono::DateTime<Utc>> {
    config
        .next_retry_at
        .as_deref()
        .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
        .map(|value| value.with_timezone(&Utc))
}

fn load_base(st: &AppState, key: &VaultKey) -> Result<Option<RevisionManifest>> {
    load_encrypted(st, key, "local-base", &local_path(st, "base.bin"))
}

fn load_pending(st: &AppState, key: &VaultKey) -> Result<Option<PendingBundle>> {
    load_encrypted(st, key, "local-pending", &local_path(st, "pending.bin"))
}

fn store_pending(st: &AppState, key: &VaultKey, pending: &PendingBundle) -> Result<()> {
    persist_encrypted(
        st,
        key,
        "local-pending",
        &local_path(st, "pending.bin"),
        pending,
    )
}

fn clear_pending(st: &AppState) -> Result<()> {
    let path = local_path(st, "pending.bin");
    if path.exists() {
        fs::remove_file(path)?;
    }
    Ok(())
}

fn store_base(st: &AppState, key: &VaultKey, manifest: &RevisionManifest) -> Result<()> {
    persist_encrypted(st, key, "local-base", &local_path(st, "base.bin"), manifest)
}

fn recovery_path(st: &AppState, filename: &str) -> Result<PathBuf> {
    if !filename.starts_with("recovery-")
        || !filename.ends_with(".bin")
        || filename.contains('/')
        || filename.contains('\\')
        || filename.contains("..")
    {
        bail!("CONFIG_SYNC_INVALID: local recovery filename is unsafe");
    }
    Ok(local_path(st, filename))
}

fn create_recovery_point(
    st: &AppState,
    config: &mut StoredConfig,
    key: &VaultKey,
    base: Option<RevisionManifest>,
    snapshot: LocalSnapshot,
) -> Result<()> {
    let filename = format!("recovery-{}.bin", Uuid::new_v4());
    let point = RecoveryPoint {
        format: "pi-desktop-config-recovery".into(),
        version: 1,
        created_at: Utc::now().to_rfc3339(),
        base,
        snapshot,
    };
    persist_encrypted(
        st,
        key,
        "local-recovery",
        &recovery_path(st, &filename)?,
        &point,
    )?;
    config.recovery_points.push(filename);
    while config.recovery_points.len() > MAX_RETAINED_REVISIONS {
        let old = config.recovery_points.remove(0);
        if let Ok(path) = recovery_path(st, &old) {
            if path.exists() {
                fs::remove_file(path)?;
            }
        }
    }
    Ok(())
}

fn send_state_notification(tx: &mpsc::UnboundedSender<String>, st: &mut AppState) {
    if let Ok(value) = public_state(st) {
        let note = json!({ "jsonrpc": "2.0", "method": "configSync.changed", "params": value });
        if let Ok(raw) = serde_json::to_string(&note) {
            let _ = tx.send(format!("{raw}\n"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config_sync::domains::{
        DOMAIN_APPLICATION, DOMAIN_MCP, DOMAIN_PROJECTS, DOMAIN_PROVIDERS, DOMAIN_SKILLS,
    };
    use crate::mcp_servers::McpServerInput;
    use crate::user_skills::UserSkillInput;
    use std::sync::Arc;
    use tokio::sync::mpsc;

    fn entity(entity_id: &str) -> PortableEntity {
        PortableEntity {
            domain: "providers".into(),
            entity_id: entity_id.into(),
            label: "Provider".into(),
            deleted: false,
            requires_approval: true,
            secret_bearing: false,
            mapping_required: false,
            digest: "digest".into(),
            payload: json!({}),
            resource_ids: Vec::new(),
        }
    }

    #[test]
    fn conflict_candidates_use_the_original_logical_entity_key() {
        let manifest = RevisionManifest {
            format: REVISION_FORMAT.into(),
            version: 1,
            revision_id: "revision".into(),
            parents: Vec::new(),
            created_at: String::new(),
            entities: vec![entity("provider:one:remote")],
            resource_ids: Vec::new(),
        };

        let mapped = logical_manifest_map(Some(&manifest));
        assert!(mapped.contains_key(&("providers".into(), "provider:one".into())));
        assert!(!mapped.contains_key(&("providers".into(), "provider:one:remote".into())));
    }

    #[test]
    fn opted_out_remote_changes_do_not_look_like_local_changes() {
        let base = RevisionManifest {
            format: REVISION_FORMAT.into(),
            version: 1,
            revision_id: "base".into(),
            parents: Vec::new(),
            created_at: String::new(),
            entities: vec![entity("provider:one")],
            resource_ids: Vec::new(),
        };
        let mut remote_entity = entity("provider:one");
        remote_entity.payload["name"] = Value::String("Remote edit".into());
        let remote = RevisionManifest {
            entities: vec![remote_entity],
            revision_id: "remote".into(),
            ..base.clone()
        };
        let mut selection = CategorySelection::default();
        selection.0.insert(DOMAIN_PROVIDERS.into(), false);
        assert!(selected_manifests_equal(
            Some(&base),
            Some(&remote),
            &selection
        ));
    }

    #[test]
    fn application_references_missing_provider_as_a_deferred_dependency() {
        let data_dir = tempfile::tempdir().expect("data directory");
        let state = AppState::open(data_dir.path()).expect("state");
        let error = validate_application_references(
            &state,
            &json!({ "defaultProviderId": "provider-from-remote" }),
        )
        .expect_err("missing provider should be staged");
        assert!(error
            .to_string()
            .starts_with("CONFIG_SYNC_DEPENDENCY: defaultProviderId"));
    }

    fn pending_approvals(value: &Value) -> Vec<(String, String, String)> {
        value
            .get("pendingApprovals")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|item| {
                (
                    item.get("id")
                        .and_then(Value::as_str)
                        .expect("approval id")
                        .to_string(),
                    item.get("digest")
                        .and_then(Value::as_str)
                        .expect("approval digest")
                        .to_string(),
                    item.get("domain")
                        .and_then(Value::as_str)
                        .expect("approval domain")
                        .to_string(),
                )
            })
            .collect()
    }

    async fn configure_test_device(
        data_dir: &Path,
        endpoint: &str,
    ) -> Result<Arc<Mutex<AppState>>> {
        let state = Arc::new(Mutex::new(AppState::open(data_dir)?));
        configure(
            state.clone(),
            json!({
                "endpoint": endpoint,
                "username": "",
                "appPassword": "",
                "directory": "config-sync-test",
                "deviceLabel": "test-device",
                "backupPassword": "portable-backup-password",
                "allowInsecureHttp": true,
                "categories": {
                    "application": true,
                    "providers": true,
                    "credentials": true,
                    "mcp": true,
                    "skills": true,
                    "projects": true,
                },
                "includeSecrets": true,
                "automaticSync": false,
            }),
        )
        .await?;
        Ok(state)
    }

    #[tokio::test]
    async fn two_devices_sync_credentials_capabilities_and_disjoint_edit() -> Result<()> {
        let fixture = crate::config_sync::transport::tests::fixture(false).await;
        let device_a_dir = tempfile::tempdir()?;
        let device_b_dir = tempfile::tempdir()?;
        let device_a = configure_test_device(device_a_dir.path(), &fixture.endpoint).await?;
        let device_b = configure_test_device(device_b_dir.path(), &fixture.endpoint).await?;
        let project_a = device_a_dir.path().join("project");
        let project_b = device_b_dir.path().join("project");
        std::fs::create_dir_all(&project_a)?;
        std::fs::create_dir_all(&project_b)?;
        let project_a = project_a.canonicalize()?;
        let project_b = project_b.canonicalize()?;

        let provider_id = {
            let mut state = device_a.lock().await;
            state
                .db
                .ensure_project(&project_a.to_string_lossy(), false)?;
            let provider = crate::providers::create_provider(
                &state.db,
                &state.secrets,
                serde_json::from_value(json!({
                    "name": "Portable provider",
                    "vendorKey": "portable-test",
                    "type": "openai_compatible",
                    "protocol": "openai_compatible",
                    "baseUrl": "https://provider.example.test/v1",
                    "authKind": "api_key_and_base_url",
                    "secretValue": "portable-api-key",
                    "models": [{
                        "id": "portable-model",
                        "alias": "Portable",
                        "contextWindow": 128000,
                        "maxTokens": 4096,
                        "thinkingLevels": []
                    }]
                }))?,
            )?;
            state
                .db
                .set_setting("app", &json!({ "theme": "light", "language": "en" }))?;
            state.mcp_servers.upsert(McpServerInput {
                id: "portable-server".into(),
                label: Some("Portable MCP".into()),
                level: Some("project".into()),
                project_path: Some(project_a.to_string_lossy().into_owned()),
                transport: Some("stdio".into()),
                command: Some("portable-mcp".into()),
                args: Some(vec!["--safe".into()]),
                enabled: Some(true),
                ..McpServerInput::default()
            })?;
            state.user_skills.create(UserSkillInput {
                id: Some("portable-skill".into()),
                name: Some("Portable Skill".into()),
                level: Some("project".into()),
                project_path: Some(project_a.to_string_lossy().into_owned()),
                body: Some("Use the portable project workflow.".into()),
                enabled: Some(true),
                ..UserSkillInput::default()
            })?;
            provider.id
        };

        {
            let mut state = device_a.lock().await;
            let config = load_config(&state)?.expect("configured device");
            let key = local_vault_key(&state, &config)?.expect("unlocked device");
            let snapshot = domains::capture(
                &mut state,
                &key,
                &selection(&config),
                config.include_secrets,
                &config.plugin_intents,
                &identity_overrides(&config),
            )?;
            let captured = snapshot
                .manifest
                .entities
                .iter()
                .map(|entity| entity.domain.as_str())
                .collect::<std::collections::BTreeSet<_>>();
            assert!(
                captured.contains(DOMAIN_PROVIDERS),
                "captured: {captured:?}"
            );
            assert!(captured.contains(DOMAIN_MCP), "captured: {captured:?}");
            assert!(captured.contains(DOMAIN_SKILLS), "captured: {captured:?}");
            assert!(captured.contains(DOMAIN_PROJECTS), "captured: {captured:?}");
        }

        let (tx, _rx) = mpsc::unbounded_channel();
        let initial_a_state = sync_now(device_a.clone(), tx.clone()).await?;
        assert!(pending_approvals(&initial_a_state).is_empty());
        {
            let state = device_a.lock().await;
            let config = load_config(&state)?.expect("configured device");
            let key = local_vault_key(&state, &config)?.expect("unlocked device");
            assert!(load_pending(&state, &key)?.is_none());
        }
        {
            let state = device_b.lock().await;
            let config = load_config(&state)?.expect("configured device");
            let key = local_vault_key(&state, &config)?.expect("unlocked device");
            let transport = transport_with_password(&config, String::new())?;
            let (head, _) = read_remote_head(&transport, &config, &key)
                .await?
                .expect("remote head");
            let (remote, _) =
                read_remote_revision(&transport, &config, &key, &head.revision_id).await?;
            assert!(!remote.entities.is_empty(), "remote entities missing");
            assert!(
                load_base(&state, &key)?.is_none(),
                "device B unexpectedly has base"
            );
            assert!(
                remote
                    .entities
                    .iter()
                    .any(|entity| entity.domain == DOMAIN_PROVIDERS && entity.requires_approval),
                "remote provider approval flag missing: {:?}",
                remote
                    .entities
                    .iter()
                    .map(|entity| (&entity.domain, entity.requires_approval))
                    .collect::<Vec<_>>()
            );
        }
        let received = sync_now(device_b.clone(), tx.clone()).await?;
        assert!(!pending_approvals(&received).is_empty());
        {
            let state = device_b.lock().await;
            state
                .db
                .set_setting("app", &json!({ "theme": "dark", "language": "en" }))?;
        }
        let after_unapproved_edit = sync_now(device_b.clone(), tx.clone()).await?;
        assert!(!pending_approvals(&after_unapproved_edit).is_empty());
        assert_eq!(
            device_b
                .lock()
                .await
                .db
                .get_setting("app")?
                .and_then(|value| {
                    value
                        .get("theme")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                }),
            Some("dark".into())
        );
        let initial_approvals = pending_approvals(&after_unapproved_edit);
        let domains = initial_approvals
            .iter()
            .map(|(_, _, domain)| domain.as_str())
            .collect::<std::collections::BTreeSet<_>>();
        assert!(domains.contains(DOMAIN_PROVIDERS), "domains: {domains:?}");
        assert!(domains.contains(DOMAIN_MCP), "domains: {domains:?}");
        assert!(domains.contains(DOMAIN_SKILLS), "domains: {domains:?}");
        assert!(domains.contains(DOMAIN_PROJECTS), "domains: {domains:?}");
        let mapping_key = received
            .get("pendingApprovals")
            .and_then(Value::as_array)
            .and_then(|items| {
                items.iter().find_map(|item| {
                    item.get("mappingKey")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
            })
            .expect("project mapping approval");
        map_project(
            device_b.clone(),
            json!({
                "logicalId": mapping_key,
                "paths": [project_b.to_string_lossy()]
            }),
        )
        .await?;

        for (approval_id, digest, domain) in initial_approvals {
            let result = approve(
                device_b.clone(),
                json!({ "approvalId": &approval_id, "digest": &digest }),
                tx.clone(),
            )
            .await;
            assert!(
                result.is_ok(),
                "approval failed id={approval_id} domain={domain}: {result:?}"
            );
        }
        let device_b_state = get_state(device_b.clone()).await?;
        assert!(pending_approvals(&device_b_state).is_empty());
        let repeated_b_state = sync_now(device_b.clone(), tx.clone()).await?;
        assert!(pending_approvals(&repeated_b_state).is_empty());
        {
            let mut state = device_b.lock().await;
            let provider = crate::providers::get_provider(&state.db, &state.secrets, &provider_id)?
                .expect("provider imported");
            assert!(provider.has_secret);
            assert!(state
                .mcp_servers
                .list(CapabilityLevel::Project, Some(&project_b.to_string_lossy()),)?
                .iter()
                .any(|record| record.id == "portable-server"));
            assert!(state
                .user_skills
                .list(CapabilityLevel::Project, Some(&project_b.to_string_lossy()),)?
                .iter()
                .any(|record| record.id == "portable-skill"));
            assert_eq!(
                state.db.get_setting("app")?.and_then(|value| {
                    value
                        .get("theme")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                }),
                Some("dark".into())
            );
        }

        {
            let state = device_b.lock().await;
            state
                .db
                .set_setting("app", &json!({ "theme": "light", "language": "en" }))?;
        }
        sync_now(device_b.clone(), tx.clone()).await?;
        {
            let state = device_b.lock().await;
            let config = load_config(&state)?.expect("configured device");
            let key = local_vault_key(&state, &config)?.expect("unlocked device");
            let transport = transport_with_password(&config, String::new())?;
            let (head, _) = read_remote_head(&transport, &config, &key)
                .await?
                .expect("remote head after device B edit");
            let (remote, _) =
                read_remote_revision(&transport, &config, &key, &head.revision_id).await?;
            let remote_theme = remote
                .entities
                .iter()
                .find(|entity| entity.domain == DOMAIN_APPLICATION)
                .and_then(|entity| entity.payload.get("theme"))
                .and_then(Value::as_str);
            assert_eq!(remote_theme, Some("light"));
        }
        sync_now(device_a.clone(), tx).await?;
        let state = device_a.lock().await;
        assert_eq!(
            state.db.get_setting("app")?.and_then(|value| {
                value
                    .get("theme")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            }),
            Some("light".into())
        );

        fixture.task.abort();
        Ok(())
    }
}
