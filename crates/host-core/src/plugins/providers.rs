use super::*;
use rusqlite::{params, OptionalExtension};

use crate::db::{now_ms, Database};
use crate::providers::{
    self, delete_provider_row, normalize_thinking_levels, provider_owner_plugin, ModelBinding,
};
use crate::secrets::SecretStore;

/// Upper bound on one declaration's model list.
pub(crate) const MAX_PLUGIN_PROVIDER_MODELS: usize = 64;

/// Provider ids created from a manifest carry this prefix so a plugin row is
/// recognizable without a database read (ADR 0259). A user-created provider id
/// is a UUID and can never collide with it.
pub(crate) const PLUGIN_PROVIDER_ID_PREFIX: &str = "plugin:";

/// Wire styles a manifest may declare. Mirrors the `apiStyle` enum of the
/// provider config schema; an unknown value fails manifest validation.
const PLUGIN_API_STYLES: [&str; 7] = [
    "chat_completions",
    "opencode_go",
    "responses",
    "anthropic_messages",
    "google_generative_ai",
    "openai_codex_responses",
    "pi_messages",
];

/// Auth kinds a manifest may declare.
const PLUGIN_AUTH_KINDS: [&str; 3] = ["api_key", "none", "oauth"];

pub(crate) fn is_known_api_style(value: &str) -> bool {
    PLUGIN_API_STYLES.contains(&value)
}

pub(crate) fn is_known_auth_kind(value: &str) -> bool {
    PLUGIN_AUTH_KINDS.contains(&value)
}

/// `providers.protocol` for a declared wire style, kept in step with the
/// mapping Electron main uses for vendor accounts (`protocolForApiStyle`).
fn protocol_for_api_style(api_style: &str) -> &'static str {
    match api_style {
        "anthropic_messages" => "anthropic",
        "responses" | "openai_codex_responses" => "openai",
        "google_generative_ai" => "google",
        "pi_messages" => "custom_http",
        _ => "openai_compatible",
    }
}

/// One provider a plugin declared in `contributes.providers`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DeclaredPluginProvider {
    pub id: String,
    pub name: String,
    pub vendor_key: String,
    pub base_url: Option<String>,
    pub api_style: String,
    pub auth_kind: String,
    pub models: Vec<ModelBinding>,
    pub inference: Option<Value>,
}

/// The provider row id a declaration materializes as.
pub(crate) fn plugin_provider_row_id(plugin_id: &str, declared_id: &str) -> String {
    format!("{PLUGIN_PROVIDER_ID_PREFIX}{plugin_id}:{declared_id}")
}

/// Thinking levels a declared model offers, as stated by the plugin.
///
/// Only canonical names survive, and each appears once, so a declaration cannot
/// publish a menu entry the runtime would refuse to send. An absent or unusable
/// list stays empty, which readers already treat as "no menu to offer".
fn declared_thinking_levels(model: &serde_json::Map<String, Value>) -> Vec<String> {
    let Some(levels) = model.get("thinkingLevels").and_then(Value::as_array) else {
        return Vec::new();
    };
    let declared: Vec<String> = levels
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect();
    normalize_thinking_levels(&declared)
}

/// The level a declared model opens on, when the plugin names one that exists.
///
/// A name outside the model's own list is dropped rather than stored: the
/// runtime selects a default by matching it against the available levels, and a
/// value that matches nothing would silently fall back to the first entry while
/// the row claimed otherwise.
fn declared_default_thinking_level(model: &serde_json::Map<String, Value>) -> Option<String> {
    let named = model
        .get("defaultThinkingLevel")
        .and_then(Value::as_str)?
        .trim();
    if named.is_empty() {
        return None;
    }
    let levels = declared_thinking_levels(model);
    levels
        .iter()
        .any(|level| level == named)
        .then(|| named.to_string())
}

/// Read `contributes.providers` off a manifest that has already passed
/// `validate_contributions`. Shapes that validation rejects are skipped here
/// rather than re-reported: this function runs on every load and must not be
/// the place a plugin learns about a manifest error.
pub(crate) fn declared_providers(manifest: &PluginManifest) -> Vec<DeclaredPluginProvider> {
    let Some(entries) = manifest
        .contributes
        .as_ref()
        .and_then(Value::as_object)
        .and_then(|map| map.get("providers"))
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };
    entries
        .iter()
        .filter_map(|entry| {
            let obj = entry.as_object()?;
            let id = obj.get("id")?.as_str()?.trim().to_string();
            if id.is_empty() {
                return None;
            }
            let api_style = obj
                .get("apiStyle")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| is_known_api_style(value))
                .unwrap_or("chat_completions")
                .to_string();
            let auth_kind = obj
                .get("authKind")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| is_known_auth_kind(value))
                .unwrap_or("api_key")
                .to_string();
            let models = obj
                .get("models")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .take(MAX_PLUGIN_PROVIDER_MODELS)
                        .filter_map(|item| {
                            let model = item.as_object()?;
                            let model_id = model.get("id")?.as_str()?.trim().to_string();
                            if model_id.is_empty() {
                                return None;
                            }
                            Some(ModelBinding {
                                id: model_id,
                                alias: model
                                    .get("name")
                                    .and_then(Value::as_str)
                                    .map(str::trim)
                                    .filter(|value| !value.is_empty())
                                    .map(str::to_string),
                                context_window_source: None,
                                max_tokens_source: None,
                                context_window: model
                                    .get("contextWindow")
                                    .and_then(Value::as_u64)
                                    .and_then(|value| u32::try_from(value).ok())
                                    .unwrap_or(0),
                                max_tokens: model
                                    .get("maxTokens")
                                    .and_then(Value::as_u64)
                                    .and_then(|value| u32::try_from(value).ok())
                                    .unwrap_or(0),
                                thinking_levels: declared_thinking_levels(model),
                                default_thinking_level: declared_default_thinking_level(model),
                                thinking_protocol: model
                                    .get("thinkingProtocol")
                                    .and_then(Value::as_str)
                                    .map(str::to_string),
                                supports_reasoning_effort: None,
                                supports_images: model
                                    .get("supportsImages")
                                    .and_then(Value::as_bool),
                                supports_documents: None,
                                available_for_subagents: None,
                                native_web_search: None,
                            })
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            Some(DeclaredPluginProvider {
                id,
                name: obj
                    .get("name")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string)
                    .unwrap_or_else(|| {
                        obj.get("id")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string()
                    }),
                vendor_key: obj
                    .get("vendorKey")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string)
                    .unwrap_or_else(|| "custom".to_string()),
                base_url: obj
                    .get("baseUrl")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string),
                api_style,
                auth_kind,
                inference: super::provider_operations::declared_provider_operations(obj),
                models,
            })
        })
        .collect()
}

/// Explicit user-owned fields layered over a plugin provider declaration.
#[derive(Default)]
pub(crate) struct PluginProviderUserOverrides {
    pub name: Option<String>,
    pub enabled: Option<bool>,
    pub models: Option<Vec<ModelBinding>>,
}

pub(crate) fn plugin_provider_user_overrides(raw: &str) -> PluginProviderUserOverrides {
    let Ok(value) = serde_json::from_str::<Value>(raw) else {
        return PluginProviderUserOverrides::default();
    };
    let Some(overrides) = value.get("pluginUserOverrides") else {
        return PluginProviderUserOverrides::default();
    };
    PluginProviderUserOverrides {
        name: overrides
            .get("name")
            .and_then(Value::as_str)
            .map(str::to_owned),
        enabled: overrides.get("enabled").and_then(Value::as_bool),
        models: overrides
            .get("models")
            .and_then(|models| serde_json::from_value::<Vec<ModelBinding>>(models.clone()).ok()),
    }
}

pub(crate) fn set_plugin_provider_user_override(
    raw: &str,
    key: &str,
    value: Value,
) -> Result<String> {
    let mut config = serde_json::from_str::<Value>(raw).map_err(|_| {
        anyhow::anyhow!("PROVIDER_CONFIG_INVALID: stored provider config is malformed")
    })?;
    if !config.is_object() {
        bail!("PROVIDER_CONFIG_INVALID: stored provider config is not an object");
    }
    let overrides = config
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("PROVIDER_CONFIG_INVALID"))?
        .entry("pluginUserOverrides")
        .or_insert_with(|| serde_json::json!({}));
    let overrides = overrides.as_object_mut().ok_or_else(|| {
        anyhow::anyhow!("PROVIDER_CONFIG_INVALID: pluginUserOverrides is not an object")
    })?;
    overrides.insert(key.to_owned(), value);
    Ok(serde_json::to_string(&config)?)
}

/// Host-only lifecycle state is separate from the user's enablement preference.
fn config_with_plugin_lifecycle(
    raw: &str,
    enabled: bool,
    reset_credentials: bool,
) -> Result<String> {
    let mut config: Value = serde_json::from_str(raw)?;
    let object = config.as_object_mut().ok_or_else(|| {
        anyhow::anyhow!("PROVIDER_CONFIG_INVALID: stored provider config is not an object")
    })?;
    object.insert("pluginEnabled".into(), Value::Bool(enabled));
    if reset_credentials {
        object.remove("headers");
        object.remove("oauth");
    }
    Ok(serde_json::to_string(&config)?)
}

/// Legacy singleton reconciliation never adopts or removes template accounts.
pub(crate) fn sync_plugin_providers(
    db: &Database,
    secrets: &SecretStore,
    plugin_id: &str,
    declared: &[DeclaredPluginProvider],
    enabled: bool,
) -> Result<usize> {
    super::provider_cleanup::retry_pending(db, secrets, Some(plugin_id))?;
    for provider in declared {
        sync_provider_account(
            db,
            secrets,
            plugin_id,
            provider,
            &plugin_provider_row_id(plugin_id, &provider.id),
            enabled,
            false,
        )?;
    }
    let declared_rows: Vec<String> = declared
        .iter()
        .map(|provider| plugin_provider_row_id(plugin_id, &provider.id))
        .collect();
    for row_id in owned_provider_ids(db, plugin_id)? {
        if !declared_rows.contains(&row_id)
            && !super::provider_templates::is_template_account(db, &row_id)?
        {
            delete_provider_row(db, secrets, &row_id)?;
        }
    }
    Ok(declared.len())
}

/// One shared transport/default reconciliation path for singleton and account rows.
pub(super) fn sync_provider_account(
    db: &Database,
    secrets: &SecretStore,
    plugin_id: &str,
    provider: &DeclaredPluginProvider,
    row_id: &str,
    enabled: bool,
    invalidate: bool,
) -> Result<usize> {
    super::provider_cleanup::ensure_available(db, row_id)?;
    let now = now_ms();
    // A row already sitting on this id that another plugin — or the user —
    // owns must fail loudly. The upsert's own guard would turn it into a
    // silent no-op, and a provider that claims to be synced but is not is
    // worse than a refused load.
    match provider_owner_plugin(db, row_id)? {
        Some(owner) if owner == plugin_id => {}
        Some(owner) => {
            bail!("PLUGIN_INVALID: provider {row_id} is owned by plugin {owner}, not {plugin_id}")
        }
        None if provider_row_exists(db, row_id)? => bail!(
            "PLUGIN_INVALID: provider {row_id} already exists and is not owned by {plugin_id}"
        ),
        None => {}
    }
    let (existing_config, existing_secret_ref, existing_base_url, existing_api_style, existing_protocol, existing_auth_kind): (
            Option<String>, Option<String>, Option<String>, Option<String>, Option<String>, Option<String>,
        ) = db.conn().query_row(
            "SELECT config_json, secret_ref, base_url, api_style, protocol, auth_kind FROM providers WHERE id = ?1",
            params![row_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)),
        ).optional()?.unwrap_or((None, None, None, None, None, None));
    let overrides = existing_config
        .as_deref()
        .map(plugin_provider_user_overrides)
        .unwrap_or_default();
    let models = overrides
        .models
        .clone()
        .unwrap_or_else(|| providers::normalize_model_bindings(&provider.models));
    let endpoint_changed = invalidate
        || existing_config.is_some()
            && (existing_base_url.as_deref().unwrap_or("").trim()
                != provider.base_url.as_deref().unwrap_or("").trim()
                || existing_api_style.as_deref().unwrap_or("") != provider.api_style
                || existing_protocol.as_deref().unwrap_or("")
                    != protocol_for_api_style(&provider.api_style)
                || existing_auth_kind.as_deref().unwrap_or("") != provider.auth_kind);
    // Forget metadata for bindings removed from the effective selection.
    let removed_models =
        providers::config_model_bindings(existing_config.as_deref().unwrap_or("{}"), None, row_id)
            .into_iter()
            .filter(|binding| {
                !models
                    .iter()
                    .any(|model| model.id.eq_ignore_ascii_case(&binding.id))
            })
            .map(|binding| binding.id)
            .collect::<Vec<_>>();
    providers::forget_cached_models(db, row_id, &removed_models)?;
    // Preserve credentials only while their destination and auth remain unchanged.
    let config =
        providers::config_with_model_bindings(existing_config.as_deref().unwrap_or("{}"), &models)?;
    let config = config_with_plugin_lifecycle(&config, enabled, endpoint_changed)?;
    let config = super::provider_operations::config_with_provider_operations(
        &config,
        provider.inference.as_ref(),
    )?;
    // Credentials must never follow a declaration to a changed destination.
    if endpoint_changed {
        for credential_ref in [
            crate::secrets::secret_ref_for_provider(row_id),
            crate::secrets::secret_ref_for_provider_oauth(row_id),
        ] {
            secrets.delete(&credential_ref)?;
            db.conn()
                .prepare_cached("DELETE FROM secrets_meta WHERE secret_ref = ?1")?
                .execute(params![credential_ref])?;
        }
    }

    let secret_ref = if endpoint_changed {
        None
    } else if provider.auth_kind == "api_key" {
        existing_secret_ref
    } else {
        if existing_secret_ref.is_some() {
            let api_key_ref = crate::secrets::secret_ref_for_provider(row_id);
            secrets.delete(&api_key_ref)?;
            db.conn()
                .prepare_cached("DELETE FROM secrets_meta WHERE secret_ref = ?1")?
                .execute(params![api_key_ref])?;
        }
        None
    };
    if provider.auth_kind != "oauth" {
        let oauth_ref = crate::secrets::secret_ref_for_provider_oauth(row_id);
        secrets.delete(&oauth_ref)?;
        db.conn()
            .prepare_cached("DELETE FROM secrets_meta WHERE secret_ref = ?1")?
            .execute(params![oauth_ref])?;
    }
    // The public projection derives the default from the first binding, so
    // the declared order is the plugin's choice of default.
    let default_model_id = models.first().map(|model| model.id.clone());
    db.conn()
        .prepare_cached(
            "INSERT INTO providers (
                    id, name, vendor_key, type, protocol, enabled, base_url, auth_kind,
                    api_style, default_model_id, config_json, owner_plugin_id,
                    secret_ref, created_at, updated_at
                 ) VALUES (?1, ?2, ?3, 'openai_compatible', ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
                           ?12, ?13, ?13)
                 ON CONFLICT(id) DO UPDATE SET
                    name = excluded.name,
                    vendor_key = excluded.vendor_key,
                    protocol = excluded.protocol,
                    enabled = excluded.enabled,
                    base_url = excluded.base_url,
                    auth_kind = excluded.auth_kind,
                    api_style = excluded.api_style,
                    default_model_id = excluded.default_model_id,
                    config_json = excluded.config_json,
                    owner_plugin_id = excluded.owner_plugin_id,
                    secret_ref = excluded.secret_ref,
                    updated_at = excluded.updated_at
                 WHERE providers.owner_plugin_id = excluded.owner_plugin_id",
        )?
        .execute(params![
            row_id,
            overrides.name.as_deref().unwrap_or(&provider.name),
            provider.vendor_key,
            protocol_for_api_style(&provider.api_style),
            if enabled
                && overrides.enabled.unwrap_or(true)
                && !super::provider_templates::config_pending(&config)
            {
                1
            } else {
                0
            },
            provider.base_url,
            provider.auth_kind,
            provider.api_style,
            default_model_id,
            config,
            plugin_id,
            secret_ref,
            now
        ])?;
    if endpoint_changed {
        let declared_model_ids: Vec<String> = models.iter().map(|model| model.id.clone()).collect();
        providers::forget_missing_discovered_models(db, row_id, &declared_model_ids)?;
    }
    Ok(1)
}

/// Turn every row a plugin owns off, keeping the credential and the user's
/// selections for the moment the plugin is enabled again.
pub(crate) fn set_plugin_providers_enabled(
    db: &Database,
    plugin_id: &str,
    enabled: bool,
) -> Result<usize> {
    let mut stmt = db
        .conn()
        .prepare_cached("SELECT id, config_json FROM providers WHERE owner_plugin_id = ?1")?;
    let rows = stmt.query_map(params![plugin_id], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    let rows = rows.collect::<rusqlite::Result<Vec<_>>>()?;
    for (id, config) in &rows {
        let remembered = plugin_provider_user_overrides(config)
            .enabled
            .unwrap_or(true);
        let enabled = enabled && !super::provider_cleanup::config_pending(config);
        let config = config_with_plugin_lifecycle(config, enabled, false)?;
        db.conn()
            .prepare_cached("UPDATE providers SET enabled = ?2, updated_at = ?3, config_json = ?4 WHERE id = ?1")?
            .execute(params![
                id,
                if enabled && remembered && !super::provider_templates::config_pending(&config) { 1 } else { 0 },
                now_ms(),
                config
            ])?;
    }
    Ok(rows.len())
}

/// Every provider row id a plugin owns.
pub(crate) fn owned_provider_ids(db: &Database, plugin_id: &str) -> Result<Vec<String>> {
    let mut stmt = db
        .conn()
        .prepare_cached("SELECT id FROM providers WHERE owner_plugin_id = ?1")?;
    let rows = stmt.query_map(params![plugin_id], |row| row.get(0))?;
    Ok(rows.collect::<rusqlite::Result<Vec<String>>>()?)
}

/// Drop every row a plugin owns and both of its credential references. Used on
/// uninstall, where the declaration is gone for good.
pub(crate) fn remove_plugin_providers(
    db: &Database,
    secrets: &SecretStore,
    plugin_id: &str,
) -> Result<usize> {
    super::provider_cleanup::remove_plugin(db, secrets, plugin_id)
}

/// Bring the database in line with what one plugin declares.
///
/// Callers treat a failure as a warning: the plugin's enablement has already
/// been decided, and a provider sync must never undo it.
pub(crate) fn reconcile_plugin(
    db: &Database,
    secrets: &SecretStore,
    plugins: &PluginManager,
    plugin_id: &str,
    enabled: bool,
) -> Result<usize> {
    super::provider_cleanup::retry_pending(db, secrets, Some(plugin_id))?;
    let manifest = match plugins.manifest_for(plugin_id) {
        Ok(Some(manifest)) => manifest,
        Ok(None) => {
            super::provider_templates::pause_templates(db, plugin_id)?;
            return Ok(0);
        }
        Err(error) => {
            super::provider_templates::pause_templates(db, plugin_id)?;
            return Err(error);
        }
    };
    let count = sync_plugin_providers(
        db,
        secrets,
        plugin_id,
        &declared_providers(&manifest),
        enabled,
    )?;
    Ok(count
        + super::provider_templates::reconcile_templates(
            db, secrets, plugins, plugin_id, &manifest, enabled,
        )?)
}

/// The same reconciliation for every registered plugin, used once at startup so
/// the provider table reflects the registry whatever path enabled a plugin.
pub(crate) fn reconcile_all(
    db: &Database,
    secrets: &SecretStore,
    plugins: &PluginManager,
) -> Result<usize> {
    let mut cleanup_failed = super::provider_cleanup::retry_pending(db, secrets, None).is_err();
    if super::provider_templates::cleanup_pending(db, secrets).is_err() {
        tracing::warn!("pending template account cleanup failed");
        cleanup_failed = true;
    }
    let registered: Vec<String> = plugins.list().into_iter().map(|p| p.id).collect();
    let mut written = 0usize;
    for plugin in plugins.list() {
        // One unreadable plugin must not stop the others from being reconciled,
        // and must not stop the orphan sweep below from running.
        match reconcile_plugin(db, secrets, plugins, &plugin.id, plugin.enabled) {
            Ok(count) => written += count,
            Err(error) => {
                tracing::warn!(plugin = %plugin.id, %error, "plugin provider sync failed");
            }
        }
    }
    // A plugin removed while the host was down — or an uninstall whose row
    // cleanup did not finish — would otherwise leave a provider nobody can
    // account for. Its owner is no longer registered, so the row goes.
    for owner in orphaned_owner_plugin_ids(db, &registered)? {
        tracing::warn!(plugin = %owner, "removing provider rows of an unregistered plugin");
        match remove_plugin_providers(db, secrets, &owner) {
            Ok(count) => written += count,
            Err(_) => {
                tracing::warn!(plugin=%owner, "orphan provider cleanup pending");
                cleanup_failed = true;
            }
        }
    }
    if cleanup_failed {
        bail!("Provider credential cleanup is pending; retry uninstall.");
    }
    Ok(written)
}

/// Owner ids present on provider rows that no longer name a registered plugin.
fn orphaned_owner_plugin_ids(db: &Database, registered: &[String]) -> Result<Vec<String>> {
    let mut stmt = db.conn().prepare_cached(
        "SELECT DISTINCT owner_plugin_id FROM providers WHERE owner_plugin_id IS NOT NULL",
    )?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
    let owners = rows.collect::<rusqlite::Result<Vec<String>>>()?;
    Ok(owners
        .into_iter()
        .filter(|owner| !registered.iter().any(|id| id == owner))
        .collect())
}

/// Whether a provider row exists at all, whatever owns it.
fn provider_row_exists(db: &Database, id: &str) -> Result<bool> {
    db.conn()
        .query_row("SELECT 1 FROM providers WHERE id = ?1", params![id], |_| {
            Ok(())
        })
        .optional()
        .map(|found| found.is_some())
        .map_err(Into::into)
}

impl PluginManager {
    /// The manifest of a registered plugin, re-read from disk.
    ///
    /// The declaration on disk is the source of truth for contributions, so a
    /// provider sync reads it rather than a copy captured at install time.
    ///
    /// `Ok(None)` means the declaration is unknown — no such row, no directory,
    /// or a manifest that belongs to a different plugin. Only the last case
    /// needs a guard: ids are only checked non-empty by the manifest while the
    /// install directory is derived from a sanitized id, so two ids can share
    /// one directory. Applying the wrong plugin's declaration would write its
    /// endpoint onto this plugin's rows and then delete this plugin's own.
    pub(crate) fn manifest_for(&self, id: &str) -> Result<Option<PluginManifest>> {
        let Some(plugin) = self.runtime.iter().find(|p| p.id == id) else {
            return Ok(None);
        };
        let path = match plugin.path.as_deref() {
            Some(path) => PathBuf::from(path),
            // An installed plugin that never recorded a path lives in the
            // standard install directory.
            None => self.installed_dir(id),
        };
        if !path.is_dir() {
            return Ok(None);
        }
        let manifest = Self::read_manifest(&path)?;
        if manifest.id != id {
            return Ok(None);
        }
        Ok(Some(manifest))
    }
}

#[cfg(test)]
mod tests;
