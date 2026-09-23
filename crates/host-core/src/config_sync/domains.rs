use super::{object_id, VaultKey};
use crate::agent_capabilities::CapabilityLevel;
use crate::state::AppState;
use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;

#[path = "domains_capture.rs"]
mod capture_impl;
pub(crate) use capture_impl::{
    capture, global_instruction_path_for_sync, remove_instruction_file, write_instruction_file,
};
#[cfg(test)]
pub(crate) use capture_impl::{capture_instructions, capture_memory, capture_projects};

pub const DOMAIN_APPLICATION: &str = "application";
pub const DOMAIN_PROVIDERS: &str = "providers";
pub const DOMAIN_MCP: &str = "mcp";
pub const DOMAIN_SKILLS: &str = "skills";
pub const DOMAIN_SUBAGENTS: &str = "subagents";
pub const DOMAIN_INSTRUCTIONS: &str = "instructions";
pub const DOMAIN_PROJECTS: &str = "projects";
pub const DOMAIN_PLUGINS: &str = "plugins";
pub const DOMAIN_AUTOMATION: &str = "automation";
pub const DOMAIN_MEMORY: &str = "memory";
pub const MAX_INSTRUCTION_BYTES: usize = 32 * 1024;

pub(crate) const PORTABLE_APPLICATION_FIELDS: &[&str] = &[
    "theme",
    "language",
    "fontFamily",
    "fontScale",
    "thinkingDisplayMode",
    "enterToSend",
    "largePasteThreshold",
    "defaultProviderId",
    "defaultModelId",
    "defaultMode",
    "infiniteProviderRetry",
    "keybindings",
    "linkOpenTarget",
    "contextUsageDisplay",
    "chatContentMaxWidth",
    "promptEnhancementCustomTemplate",
    "promptEnhancementUserTemplate",
    "promptEnhancementProviderId",
    "promptEnhancementModelId",
    "promptEnhancementThinkingLevel",
    "imageGeneration",
    "imageGenerationModels",
    "speech",
];

const PROJECT_IDENTITY_NAMESPACE: &str = "configSyncIdentities";
const PROJECT_IDENTITY_KEY: &str = "projects";
const PROJECT_GROUP_IDENTITY_KEY: &str = "groups";

pub const ALL_DOMAINS: [&str; 10] = [
    DOMAIN_APPLICATION,
    DOMAIN_PROVIDERS,
    DOMAIN_MCP,
    DOMAIN_SKILLS,
    DOMAIN_SUBAGENTS,
    DOMAIN_INSTRUCTIONS,
    DOMAIN_PROJECTS,
    DOMAIN_PLUGINS,
    DOMAIN_AUTOMATION,
    DOMAIN_MEMORY,
];

/// Contract metadata for each portable domain. Capture/apply code below is
/// deliberately explicit per domain; this registry keeps the portability,
/// identity, merge, activation, and recovery policy reviewable in one place.
#[derive(Debug, Clone, Copy)]
#[allow(dead_code)]
pub struct DomainAdapterSpec {
    pub domain: &'static str,
    pub schema_version: u32,
    pub exportable_fields: &'static [&'static str],
    pub secret_fields: &'static [&'static str],
    pub local_overlays: &'static [&'static str],
    pub identity: &'static str,
    pub references: &'static [&'static str],
    pub merge_granularity: &'static str,
    pub activation_policy: &'static str,
    pub recovery_policy: &'static str,
}

pub const DOMAIN_ADAPTERS: &[DomainAdapterSpec] = &[
    DomainAdapterSpec {
        domain: DOMAIN_APPLICATION,
        schema_version: 1,
        exportable_fields: &[
            "theme",
            "language",
            "fontFamily",
            "fontScale",
            "thinkingDisplayMode",
            "enterToSend",
            "keybindings",
            "display bindings",
            "provider/model bindings",
        ],
        secret_fields: &[],
        local_overlays: &[
            "window geometry",
            "default command shell",
            "network proxy",
            "developer mode",
            "onboarding state",
            "permission mode",
        ],
        identity: "application",
        references: &["provider ids", "model ids"],
        merge_granularity: "field",
        activation_policy: "immediate-safe-settings-only",
        recovery_policy: "import journal",
    },
    DomainAdapterSpec {
        domain: DOMAIN_PROVIDERS,
        schema_version: 1,
        exportable_fields: &[
            "provider identity",
            "models",
            "aliases",
            "parameters",
            "ordering",
            "defaults",
        ],
        secret_fields: &["portableApiKey"],
        local_overlays: &["OAuth sessions", "readiness flags", "catalog caches"],
        identity: "user-owned provider id",
        references: &["model bindings"],
        merge_granularity: "provider aggregate",
        activation_policy: "review when credential-bearing or destination changes",
        recovery_policy: "database plus secret-store journal",
    },
    DomainAdapterSpec {
        domain: DOMAIN_MCP,
        schema_version: 1,
        exportable_fields: &[
            "scope",
            "transport",
            "command",
            "args",
            "endpoint",
            "desired enabled state",
        ],
        secret_fields: &["env", "headers"],
        local_overlays: &["device approval", "local path bindings"],
        identity: "scope plus user-owned MCP id",
        references: &["project mapping"],
        merge_granularity: "one definition",
        activation_policy: "approval required before discovery",
        recovery_policy: "capability write journal",
    },
    DomainAdapterSpec {
        domain: DOMAIN_SKILLS,
        schema_version: 1,
        exportable_fields: &["metadata", "instructions", "bounded package resources"],
        secret_fields: &[],
        local_overlays: &[
            "external symlink targets",
            "execution approval",
            "dependencies",
        ],
        identity: "scope plus skill id",
        references: &["project mapping", "package resources"],
        merge_granularity: "one package",
        activation_policy: "approval required before discovery",
        recovery_policy: "bounded package write journal",
    },
    DomainAdapterSpec {
        domain: DOMAIN_SUBAGENTS,
        schema_version: 1,
        exportable_fields: &[
            "definition",
            "prompt",
            "model references",
            "tool preferences",
        ],
        secret_fields: &[],
        local_overlays: &["global-only ownership", "privileges", "execution approval"],
        identity: "global subagent id",
        references: &["provider/model ids"],
        merge_granularity: "one definition",
        activation_policy: "approval required before discovery",
        recovery_policy: "capability write journal",
    },
    DomainAdapterSpec {
        domain: DOMAIN_INSTRUCTIONS,
        schema_version: 1,
        exportable_fields: &[
            "fixed global file",
            "registered project-root file",
            "group text",
        ],
        secret_fields: &["instruction content"],
        local_overlays: &["unregistered repository files", "symlink targets"],
        identity: "scope plus project/group identity",
        references: &["project mapping"],
        merge_granularity: "one file or group text",
        activation_policy: "approval required before write",
        recovery_policy: "atomic file replacement journal",
    },
    DomainAdapterSpec {
        domain: DOMAIN_PROJECTS,
        schema_version: 1,
        exportable_fields: &[
            "logical identity",
            "name",
            "group roots",
            "ordering",
            "pinned",
        ],
        secret_fields: &[],
        local_overlays: &["absolute folder bindings"],
        identity: "host-assigned logical project/group id",
        references: &["root mappings"],
        merge_granularity: "project or ordered group",
        activation_policy: "mapping and approval required",
        recovery_policy: "database import journal",
    },
    DomainAdapterSpec {
        domain: DOMAIN_PLUGINS,
        schema_version: 1,
        exportable_fields: &["installation intent", "id/version/source metadata"],
        secret_fields: &[],
        local_overlays: &[
            "binaries",
            "plugin database",
            "permission grants",
            "activation",
        ],
        identity: "plugin id",
        references: &["future validated SDK settings only"],
        merge_granularity: "one installation intent",
        activation_policy: "explicit installation and activation",
        recovery_policy: "overlay journal",
    },
    DomainAdapterSpec {
        domain: DOMAIN_AUTOMATION,
        schema_version: 1,
        exportable_fields: &["task definition", "prompt", "schedule", "references"],
        secret_fields: &["credential references"],
        local_overlays: &["execution ownership", "enabled state on new device"],
        identity: "automation id",
        references: &["project mapping", "provider/model ids"],
        merge_granularity: "one task",
        activation_policy: "approval plus local execution ownership",
        recovery_policy: "database import journal",
    },
    DomainAdapterSpec {
        domain: DOMAIN_MEMORY,
        schema_version: 1,
        exportable_fields: &["opt-in app-managed project/group memory"],
        secret_fields: &["memory content"],
        local_overlays: &["category subscription"],
        identity: "project/group identity",
        references: &["project mapping"],
        merge_granularity: "one memory unit",
        activation_policy: "mapping and approval required",
        recovery_policy: "database import journal",
    },
];

pub fn adapter_for(domain: &str) -> Option<&'static DomainAdapterSpec> {
    DOMAIN_ADAPTERS
        .iter()
        .find(|adapter| adapter.domain == domain)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PortableEntity {
    pub domain: String,
    pub entity_id: String,
    pub label: String,
    pub deleted: bool,
    pub requires_approval: bool,
    pub secret_bearing: bool,
    pub mapping_required: bool,
    pub digest: String,
    pub payload: Value,
    #[serde(default)]
    pub resource_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RevisionManifest {
    pub format: String,
    pub version: u32,
    pub revision_id: String,
    #[serde(default)]
    pub parents: Vec<String>,
    pub created_at: String,
    pub entities: Vec<PortableEntity>,
    pub resource_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalSnapshot {
    pub manifest: RevisionManifest,
    pub resources: ResourceMap,
}

pub type ResourceMap = BTreeMap<String, Vec<u8>>;

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewCounts {
    pub supported: usize,
    pub excluded: usize,
    pub secret_bearing: usize,
    pub mapping_required: usize,
    pub pending_activation: usize,
    pub conflicts: usize,
    pub categories: Vec<CategoryPreview>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryPreview {
    pub category: String,
    pub supported: usize,
    pub excluded: usize,
    pub secret_bearing: usize,
    pub mapping_required: usize,
}

#[derive(Debug, Clone, Default)]
pub struct CategorySelection(pub BTreeMap<String, bool>);

impl CategorySelection {
    pub fn all_selected() -> Self {
        let mut values = BTreeMap::new();
        for domain in ALL_DOMAINS {
            values.insert(domain.to_string(), true);
        }
        values.insert("credentials".to_string(), false);
        values.insert(DOMAIN_MEMORY.to_string(), false);
        Self(values)
    }

    pub fn is_selected(&self, domain: &str) -> bool {
        self.0.get(domain).copied().unwrap_or(true)
    }

    pub fn include_secrets(&self, requested: bool) -> bool {
        requested && self.0.get("credentials").copied().unwrap_or(false)
    }
}

/// Local path bindings are overlays. They let a device keep using logical
/// identifiers received from another device without exporting filesystem
/// paths as portable data.
#[derive(Debug, Clone, Default)]
pub struct ProjectIdentityOverrides {
    pub project_ids: BTreeMap<String, String>,
    pub group_ids: BTreeMap<String, String>,
}

impl ProjectIdentityOverrides {
    pub fn from_mappings(
        project_mappings: &BTreeMap<String, String>,
        project_group_mappings: &BTreeMap<String, Vec<String>>,
    ) -> Self {
        let mut overrides = Self::default();
        for (logical_id, path) in project_mappings {
            overrides
                .project_ids
                .insert(path.clone(), logical_id.clone());
        }
        for (logical_id, paths) in project_group_mappings {
            for path in paths {
                overrides.group_ids.insert(path.clone(), logical_id.clone());
            }
        }
        overrides
    }
}

fn stable_id(prefix: &str, value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(prefix.as_bytes());
    hasher.update([0]);
    hasher.update(value.trim().to_lowercase().as_bytes());
    format!("{prefix}:{}", hex::encode(hasher.finalize()))
}

#[allow(clippy::too_many_arguments)]
fn digest_entity(
    domain: &str,
    entity_id: &str,
    deleted: bool,
    requires_approval: bool,
    secret_bearing: bool,
    mapping_required: bool,
    payload: &Value,
    resource_ids: &[String],
) -> String {
    let material = json!({
        "domain": domain,
        "entityId": entity_id,
        "deleted": deleted,
        "requiresApproval": requires_approval,
        "secretBearing": secret_bearing,
        "mappingRequired": mapping_required,
        "payload": payload,
        "resourceIds": resource_ids,
    });
    let mut hasher = Sha256::new();
    hasher.update(serde_json::to_vec(&material).unwrap_or_default());
    hex::encode(hasher.finalize())
}

pub fn refresh_digest(entity: &mut PortableEntity) {
    entity.digest = digest_entity(
        &entity.domain,
        &entity.entity_id,
        entity.deleted,
        entity.requires_approval,
        entity.secret_bearing,
        entity.mapping_required,
        &entity.payload,
        &entity.resource_ids,
    );
}

#[allow(clippy::too_many_arguments)]
fn entity(
    domain: &str,
    entity_id: impl Into<String>,
    label: impl Into<String>,
    payload: Value,
    requires_approval: bool,
    secret_bearing: bool,
    mapping_required: bool,
    resource_ids: Vec<String>,
) -> PortableEntity {
    let entity_id = entity_id.into();
    PortableEntity {
        domain: domain.to_string(),
        label: label.into(),
        digest: digest_entity(
            domain,
            &entity_id,
            false,
            requires_approval,
            secret_bearing,
            mapping_required,
            &payload,
            &resource_ids,
        ),
        entity_id,
        deleted: false,
        requires_approval,
        secret_bearing,
        mapping_required,
        payload,
        resource_ids,
    }
}

fn strip_keys(value: &mut Value, keys: &[&str]) {
    if let Some(object) = value.as_object_mut() {
        for key in keys {
            object.remove(*key);
        }
    }
}

fn project_logical_id(path: &str) -> String {
    stable_id("project-path", path)
}

fn project_group_logical_id(
    st: &mut AppState,
    group: &crate::db::ProjectGroupRecord,
) -> Result<String> {
    if group.legacy {
        return Ok(project_logical_id(&group.primary_path));
    }
    let mut identities = st
        .db
        .kv_get(PROJECT_IDENTITY_NAMESPACE, PROJECT_GROUP_IDENTITY_KEY)?
        .map(serde_json::from_value::<BTreeMap<String, String>>)
        .transpose()?
        .unwrap_or_default();
    if let Some(identity) = identities.get(&group.id) {
        return Ok(identity.clone());
    }
    let identity = format!("project-group:{}", Uuid::new_v4());
    identities.insert(group.id.clone(), identity.clone());
    st.db.kv_set(
        PROJECT_IDENTITY_NAMESPACE,
        PROJECT_GROUP_IDENTITY_KEY,
        &serde_json::to_value(identities)?,
    )?;
    Ok(identity)
}

fn project_identity_for_path(st: &mut AppState, path: &str) -> Result<String> {
    let project = st
        .db
        .list_projects()?
        .into_iter()
        .find(|project| project.path == path);
    let Some(project) = project else {
        return Ok(project_logical_id(path));
    };
    let mut identities = st
        .db
        .kv_get(PROJECT_IDENTITY_NAMESPACE, PROJECT_IDENTITY_KEY)?
        .map(serde_json::from_value::<BTreeMap<String, String>>)
        .transpose()?
        .unwrap_or_default();
    if let Some(identity) = identities.get(&project.id.to_string()) {
        return Ok(identity.clone());
    }
    let identity = format!("project:{}", Uuid::new_v4());
    identities.insert(project.id.to_string(), identity.clone());
    st.db.kv_set(
        PROJECT_IDENTITY_NAMESPACE,
        PROJECT_IDENTITY_KEY,
        &serde_json::to_value(identities)?,
    )?;
    Ok(identity)
}

fn project_scope(
    st: &mut AppState,
    path: &str,
    overrides: &ProjectIdentityOverrides,
) -> Result<(String, Option<String>, Option<usize>)> {
    let mapped_project_id = overrides.project_ids.get(path).cloned();
    let project_id = mapped_project_id
        .clone()
        .unwrap_or(project_identity_for_path(st, path)?);
    let Some(group) = st.db.project_group_for_path(path)? else {
        return Ok((project_id, None, None));
    };
    if group.legacy {
        return Ok((project_id, None, None));
    }
    let group_id = match overrides
        .group_ids
        .get(path)
        .or_else(|| overrides.group_ids.get(&group.primary_path))
        .cloned()
    {
        Some(group_id) => group_id,
        None => project_group_logical_id(st, &group)?,
    };
    let root_position = group.roots.iter().position(|root| root.path == path);
    let project_id = mapped_project_id.unwrap_or_else(|| {
        root_position
            .map(|position| stable_id("project-root", &format!("{group_id}:{position}")))
            .unwrap_or(project_id)
    });
    Ok((project_id, Some(group_id), root_position))
}

pub fn snapshot_digest(snapshot: &LocalSnapshot) -> String {
    let material = json!({
        "entities": snapshot
            .manifest
            .entities
            .iter()
            .map(|entity| json!({
                "domain": entity.domain,
                "entityId": entity.entity_id,
                "digest": entity.digest,
            }))
            .collect::<Vec<_>>(),
        "resources": snapshot.resources.keys().collect::<Vec<_>>(),
    });
    let mut hasher = Sha256::new();
    hasher.update(serde_json::to_vec(&material).unwrap_or_default());
    hex::encode(hasher.finalize())
}

pub fn preview(snapshot: &LocalSnapshot, selection: &CategorySelection) -> PreviewCounts {
    let mut counts = PreviewCounts::default();
    let mut by_category: BTreeMap<String, CategoryPreview> = BTreeMap::new();
    for entity in &snapshot.manifest.entities {
        let category =
            by_category
                .entry(entity.domain.clone())
                .or_insert_with(|| CategoryPreview {
                    category: entity.domain.clone(),
                    ..CategoryPreview::default()
                });
        if selection.is_selected(&entity.domain) {
            counts.supported += 1;
            category.supported += 1;
        } else {
            counts.excluded += 1;
            category.excluded += 1;
        }
        if entity.secret_bearing {
            counts.secret_bearing += 1;
            category.secret_bearing += 1;
        }
        if entity.mapping_required {
            counts.mapping_required += 1;
            category.mapping_required += 1;
        }
        if entity.requires_approval {
            counts.pending_activation += 1;
        }
    }
    counts.categories = by_category.into_values().collect();
    counts
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::AppState;

    #[test]
    fn adapter_registry_covers_every_portable_domain() {
        assert_eq!(DOMAIN_ADAPTERS.len(), ALL_DOMAINS.len());
        assert!(!PORTABLE_APPLICATION_FIELDS.contains(&"defaultPermissionMode"));
        for domain in ALL_DOMAINS {
            let adapter = adapter_for(domain).expect("portable domain adapter");
            assert_eq!(adapter.schema_version, 1);
            assert!(!adapter.identity.is_empty());
            assert!(!adapter.merge_granularity.is_empty());
            assert!(!adapter.activation_policy.is_empty());
            assert!(!adapter.recovery_policy.is_empty());
        }
    }

    #[test]
    fn captures_non_legacy_project_group_memory_as_a_separate_entity() {
        let data_dir = tempfile::tempdir().unwrap();
        let first = data_dir.path().join("first");
        let second = data_dir.path().join("second");
        std::fs::create_dir_all(&first).unwrap();
        std::fs::create_dir_all(&second).unwrap();

        let mut state = AppState::open(data_dir.path()).unwrap();
        let group = state
            .db
            .create_project_group(
                "Workspace",
                &[
                    first.to_string_lossy().into_owned(),
                    second.to_string_lossy().into_owned(),
                ],
            )
            .unwrap();
        state
            .db
            .set_project_group_memory(
                &group.id,
                &json!([{
                    "id": "note-1",
                    "title": "Context",
                    "content": "Keep this with the workspace",
                }]),
            )
            .unwrap();

        let entities = capture_memory(&mut state, &ProjectIdentityOverrides::default()).unwrap();
        let entity = entities
            .iter()
            .find(|entity| entity.payload["projectGroupLogicalId"].is_string())
            .expect("group memory entity");
        let logical_id = entity.payload["projectGroupLogicalId"]
            .as_str()
            .expect("group logical id");
        assert_eq!(entity.entity_id, format!("memory:{logical_id}"));
        assert!(entity.mapping_required);
        assert!(entity.secret_bearing);
        assert_eq!(entity.payload["memory"]["entries"][0]["id"], "note-1");
    }

    #[test]
    fn captures_shared_memory_after_agent_writes_and_recording_is_disabled() {
        let data_dir = tempfile::tempdir().unwrap();
        let project = data_dir.path().join("project");
        std::fs::create_dir_all(&project).unwrap();
        let path = project.to_string_lossy().into_owned();
        let mut state = AppState::open(data_dir.path()).unwrap();
        let group = state
            .db
            .create_project_group("Workspace", std::slice::from_ref(&path))
            .unwrap();
        state
            .db
            .set_project_group_memory(
                &group.id,
                &json!([
                    { "id": "existing", "title": "Stack", "content": "Use npm" }
                ]),
            )
            .unwrap();
        state.db.set_auto_memory_enabled(&path, true).unwrap();
        state
            .db
            .agent_upsert_project_memory(
                &path,
                Some("existing"),
                "Stack",
                "Use pnpm",
                Some("Stack"),
                Some("Use npm"),
            )
            .unwrap();
        state
            .db
            .agent_upsert_project_memory(&path, None, "Review", "Keep changes focused", None, None)
            .unwrap();
        state.db.set_auto_memory_enabled(&path, false).unwrap();

        let entities = capture_memory(&mut state, &ProjectIdentityOverrides::default()).unwrap();
        let memory_entities = entities
            .iter()
            .filter(|entity| entity.payload["projectGroupLogicalId"].is_string())
            .collect::<Vec<_>>();
        assert_eq!(memory_entities.len(), 1);
        let payload = &memory_entities[0].payload;
        let entries = payload["memory"]["entries"].as_array().unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0]["id"], "existing");
        assert_eq!(entries[0]["content"], "Use pnpm");
        assert_eq!(entries[1]["content"], "Keep changes focused");
        assert!(payload.get("autoRecordEnabled").is_none());
        assert!(payload["memory"].get("autoRecordEnabled").is_none());
        assert!(!state.db.get_auto_record_enabled(&path).unwrap());
    }

    #[test]
    fn captures_only_the_app_managed_project_instruction_file() {
        let data_dir = tempfile::tempdir().unwrap();
        let project = data_dir.path().join("project");
        let nested = project.join("nested");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(project.join("AGENTS.md"), "project guidance\n").unwrap();
        std::fs::write(nested.join("AGENTS.md"), "nested guidance\n").unwrap();

        let mut state = AppState::open(data_dir.path()).unwrap();
        state
            .db
            .ensure_project(&project.to_string_lossy(), false)
            .unwrap();
        let entities =
            capture_instructions(&mut state, &ProjectIdentityOverrides::default()).unwrap();
        let project_entities = entities
            .iter()
            .filter(|entity| entity.payload["scope"] == "project")
            .collect::<Vec<_>>();
        assert_eq!(project_entities.len(), 1);
        assert_eq!(project_entities[0].payload["content"], "project guidance\n");
        assert!(project_entities[0].mapping_required);
    }

    #[test]
    fn project_identities_are_local_stable_and_mapping_overrides_are_used() {
        let data_dir = tempfile::tempdir().unwrap();
        let project = data_dir.path().join("project");
        std::fs::create_dir_all(&project).unwrap();
        let mut state = AppState::open(data_dir.path()).unwrap();
        state
            .db
            .ensure_project(&project.to_string_lossy(), false)
            .unwrap();

        let first = capture_projects(&mut state, &ProjectIdentityOverrides::default()).unwrap();
        let second = capture_projects(&mut state, &ProjectIdentityOverrides::default()).unwrap();
        assert_eq!(
            first[0].payload["logicalId"],
            second[0].payload["logicalId"]
        );
        assert!(first[0].payload["logicalId"]
            .as_str()
            .is_some_and(|value| value.starts_with("project:")));
        let stored_path = state.db.list_projects().unwrap()[0].path.clone();

        let mut overrides = ProjectIdentityOverrides::default();
        overrides
            .project_ids
            .insert(stored_path, "project:from-other-device".into());
        let mapped = capture_projects(&mut state, &overrides).unwrap();
        assert_eq!(mapped[0].payload["logicalId"], "project:from-other-device");
    }
}
