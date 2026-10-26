//! Host-owned account creation and lifecycle for manifest provider templates.
use super::*;
use crate::db::{now_ms, Database};
use crate::providers::{self as accounts, ProviderPublic};
use crate::secrets::{secret_ref_for_provider_oauth, SecretStore};
use rusqlite::{params, OptionalExtension};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TemplateLookup {
    pub plugin_id: String,
    pub template_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CreateFromTemplate {
    pub plugin_id: String,
    pub template_id: String,
    pub name: Option<String>,
    pub secret_value: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct CompleteTemplateOAuth {
    pub id: String,
}

fn entries(manifest: &PluginManifest) -> &[Value] {
    manifest
        .contributes
        .as_ref()
        .and_then(|v| v.get("providerTemplates"))
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}
fn granted(plugins: &PluginManager, plugin_id: &str, definition: &Value) -> bool {
    let Some(plugin) = plugins.list().into_iter().find(|p| p.id == plugin_id) else {
        return false;
    };
    let has = |permission: &str| plugin.permissions.iter().any(|p| p == permission);
    plugin.enabled
        && has("provider.register")
        && (definition.get("adapter").is_none() || has("provider.inference"))
        && (definition.get("authKind").and_then(Value::as_str) != Some("oauth")
            || definition
                .get("oauth")
                .and_then(|o| o.get("flow"))
                .and_then(Value::as_str)
                .unwrap_or("custom")
                != "custom"
            || has("provider.oauth"))
}

pub(crate) fn get_template(plugins: &PluginManager, input: &TemplateLookup) -> Result<Value> {
    if input.plugin_id.is_empty()
        || input.plugin_id.len() > 256
        || input.template_id.is_empty()
        || input.template_id.len() > 64
    {
        bail!("PROVIDER_TEMPLATE_INVALID: invalid template identity");
    }
    let manifest = plugins
        .manifest_for(&input.plugin_id)?
        .ok_or_else(|| anyhow!("PROVIDER_TEMPLATE_UNAVAILABLE: plugin manifest missing"))?;
    let definition = entries(&manifest)
        .iter()
        .find(|t| t.get("id").and_then(Value::as_str) == Some(input.template_id.as_str()))
        .ok_or_else(|| anyhow!("PROVIDER_TEMPLATE_UNAVAILABLE: template missing"))?;
    if !granted(plugins, &input.plugin_id, definition) {
        bail!("PROVIDER_TEMPLATE_UNAVAILABLE: plugin is disabled or lacks required grants");
    }
    Ok(definition.clone())
}

fn declaration(
    manifest: &PluginManifest,
    definition: &Value,
) -> Result<providers::DeclaredPluginProvider> {
    let mut manifest = manifest.clone();
    manifest.contributes = Some(json!({"providers":[definition]}));
    providers::declared_providers(&manifest)
        .into_iter()
        .next()
        .ok_or_else(|| anyhow!("PROVIDER_TEMPLATE_INVALID: invalid stored definition"))
}

pub(crate) fn is_template_account(db: &Database, id: &str) -> Result<bool> {
    Ok(db
        .conn()
        .query_row(
            "SELECT 1 FROM provider_template_bindings WHERE provider_id = ?1",
            [id],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}
pub(crate) fn config_pending(raw: &str) -> bool {
    serde_json::from_str::<Value>(raw)
        .ok()
        .and_then(|v| v.get("pluginTemplate")?.get("pending")?.as_bool())
        .unwrap_or(false)
}
fn set_config(db: &Database, id: &str, update: impl FnOnce(&mut Value)) -> Result<()> {
    let raw: String =
        db.conn()
            .query_row("SELECT config_json FROM providers WHERE id=?1", [id], |r| {
                r.get(0)
            })?;
    let mut config: Value = serde_json::from_str(&raw)?;
    if !config.is_object() {
        bail!("PROVIDER_CONFIG_INVALID: stored config is not an object");
    }
    update(&mut config);
    db.conn().execute(
        "UPDATE providers SET config_json=?2, updated_at=?3 WHERE id=?1",
        params![id, serde_json::to_string(&config)?, now_ms()],
    )?;
    Ok(())
}
fn checked_name(name: &str) -> bool {
    !name.trim().is_empty()
        && name.encode_utf16().count() <= 128
        && !name.chars().any(char::is_control)
}

pub(crate) fn create_from_template(
    db: &Database,
    secrets: &SecretStore,
    plugins: &PluginManager,
    input: CreateFromTemplate,
) -> Result<ProviderPublic> {
    super::provider_cleanup::retry_pending(db, secrets, Some(&input.plugin_id))?;
    let definition = get_template(
        plugins,
        &TemplateLookup {
            plugin_id: input.plugin_id.clone(),
            template_id: input.template_id.clone(),
        },
    )?;
    if input
        .name
        .as_deref()
        .is_some_and(|name| !checked_name(name))
        || input.secret_value.as_deref().is_some_and(|s| {
            s.len() > 65536 || s.trim().is_empty() || s.chars().any(char::is_control)
        })
    {
        bail!("PROVIDER_TEMPLATE_INVALID: invalid name or secretValue");
    }
    let manifest = plugins
        .manifest_for(&input.plugin_id)?
        .ok_or_else(|| anyhow!("PROVIDER_TEMPLATE_UNAVAILABLE"))?;
    let provider = declaration(&manifest, &definition)?;
    if provider.auth_kind != "api_key" && input.secret_value.is_some() {
        bail!("PROVIDER_TEMPLATE_INVALID: secretValue is only valid for API-key accounts");
    }
    let id = uuid::Uuid::new_v4().to_string();
    let pending = provider.auth_kind == "oauth";
    let tx = db.conn().unchecked_transaction()?;
    providers::sync_provider_account(
        db,
        secrets,
        &input.plugin_id,
        &provider,
        &id,
        !pending,
        false,
    )?;
    db.conn().execute("INSERT INTO provider_template_bindings(provider_id,template_id,version,definition_json) VALUES(?1,?2,1,?3)",params![id,input.template_id,serde_json::to_string(&definition)?])?;
    set_config(db, &id, |config| {
        config["pluginTemplate"] = json!({"version":1,"pending":pending});
        if let Some(name) = input.name.as_deref() {
            config["pluginUserOverrides"] = json!({"name":name});
        }
    })?;
    if let Some(name) = input.name {
        db.conn().execute(
            "UPDATE providers SET name=?2 WHERE id=?1",
            params![id, name],
        )?;
    }
    tx.commit()?;
    if let Some(secret) = input.secret_value {
        if let Err(error) = accounts::set_provider_secret(db, secrets, &id, Some(&secret)) {
            accounts::delete_provider_row(db, secrets, &id)
                .context("cleanup failed template creation")?;
            return Err(error);
        }
    }
    accounts::get_provider(db, secrets, &id)?
        .ok_or_else(|| anyhow!("PROVIDER_TEMPLATE_INVALID: created account missing"))
}

/// Display-only metadata never invalidates credentials. Effective defaults are
/// normalized so adding explicit default flow/redirectPath is not a transport move.
fn sensitive(definition: &Value) -> Value {
    let oauth = if definition.get("authKind").and_then(Value::as_str) == Some("oauth") {
        let source = definition.get("oauth");
        json!({"flow":source.and_then(|v|v.get("flow")).cloned().unwrap_or(json!("custom")),
            "clientId":source.and_then(|v|v.get("clientId")),"authorizationUrl":source.and_then(|v|v.get("authorizationUrl")),
            "tokenUrl":source.and_then(|v|v.get("tokenUrl")),"deviceAuthorizationUrl":source.and_then(|v|v.get("deviceAuthorizationUrl")),
            "scopes":source.and_then(|v|v.get("scopes")).cloned().unwrap_or(json!([])),
            "redirectPath":source.and_then(|v|v.get("redirectPath")).cloned().unwrap_or(json!("/callback"))})
    } else {
        Value::Null
    };
    json!({"baseUrl":definition.get("baseUrl"),"apiStyle":definition.get("apiStyle").cloned().unwrap_or(json!("chat_completions")),
        "authKind":definition.get("authKind").cloned().unwrap_or(json!("api_key")),"vendorKey":definition.get("vendorKey").cloned().unwrap_or(json!("custom")),"adapter":definition.get("adapter"),"oauth":oauth})
}

pub(crate) fn reconcile_templates(
    db: &Database,
    secrets: &SecretStore,
    plugins: &PluginManager,
    plugin_id: &str,
    manifest: &PluginManifest,
    enabled: bool,
) -> Result<usize> {
    let mut stmt = db.conn().prepare("SELECT p.id,b.template_id,b.definition_json FROM providers p JOIN provider_template_bindings b ON b.provider_id=p.id WHERE p.owner_plugin_id=?1")?;
    let rows = stmt
        .query_map([plugin_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (id, template_id, old) in &rows {
        let definition = entries(manifest)
            .iter()
            .find(|t| t.get("id").and_then(Value::as_str) == Some(template_id));
        let Some(definition) = definition else {
            unavailable(db, id)?;
            continue;
        };
        let invalidated = sensitive(&serde_json::from_str(old)?) != sensitive(definition);
        let allowed = enabled && granted(plugins, plugin_id, definition);
        let provider = declaration(manifest, definition)?;
        let ready = provider.auth_kind != "oauth"
            || (!invalidated && secrets.has(&secret_ref_for_provider_oauth(id)));
        providers::sync_provider_account(
            db,
            secrets,
            plugin_id,
            &provider,
            id,
            allowed && ready,
            invalidated,
        )?;
        if invalidated {
            db.conn().execute(
                "DELETE FROM models WHERE provider_id=?1 AND source='discovered'",
                [id],
            )?;
        }
        set_config(db, id, |config| config["pluginEnabled"] = json!(allowed))?;
        db.conn().execute(
            "UPDATE provider_template_bindings SET definition_json=?2 WHERE provider_id=?1",
            params![id, serde_json::to_string(definition)?],
        )?;
    }
    Ok(rows.len())
}
fn unavailable(db: &Database, id: &str) -> Result<()> {
    db.conn()
        .execute("UPDATE providers SET enabled=0 WHERE id=?1", [id])?;
    set_config(db, id, |config| config["pluginEnabled"] = json!(false))
}

pub(crate) fn complete_oauth(
    db: &Database,
    secrets: &SecretStore,
    plugins: &PluginManager,
    input: CompleteTemplateOAuth,
) -> Result<ProviderPublic> {
    super::provider_cleanup::ensure_available(db, &input.id)?;
    let provider = accounts::get_provider(db, secrets, &input.id)?
        .ok_or_else(|| anyhow!("PROVIDER_TEMPLATE_UNAVAILABLE: account missing"))?;
    let template_id = provider
        .plugin_template_id
        .as_ref()
        .ok_or_else(|| anyhow!("PROVIDER_TEMPLATE_INVALID: not a template account"))?;
    let plugin_id = provider
        .owner_plugin_id
        .as_ref()
        .ok_or_else(|| anyhow!("PROVIDER_TEMPLATE_INVALID: account has no owner"))?;
    // Reconcile first: credentials written against an obsolete manifest must
    // not complete a login after its destination or OAuth configuration changed.
    let definition = get_template(
        plugins,
        &TemplateLookup {
            plugin_id: plugin_id.clone(),
            template_id: template_id.clone(),
        },
    )?;
    let manifest = plugins
        .manifest_for(plugin_id)?
        .ok_or_else(|| anyhow!("PROVIDER_TEMPLATE_UNAVAILABLE"))?;
    reconcile_templates(db, secrets, plugins, plugin_id, &manifest, true)?;
    if definition.get("authKind").and_then(Value::as_str) != Some("oauth")
        || !secrets.has(&secret_ref_for_provider_oauth(&input.id))
    {
        bail!("PROVIDER_TEMPLATE_OAUTH_REQUIRED: stored OAuth credential required");
    }
    let raw: String = db.conn().query_row(
        "SELECT config_json FROM providers WHERE id=?1",
        [&input.id],
        |r| r.get(0),
    )?;
    let enabled = providers::plugin_provider_user_overrides(&raw)
        .enabled
        .unwrap_or(true);
    set_config(db, &input.id, |config| {
        config["pluginTemplate"]["pending"] = json!(false)
    })?;
    db.conn().execute(
        "UPDATE providers SET enabled=?2 WHERE id=?1",
        params![input.id, enabled],
    )?;
    accounts::get_provider(db, secrets, &input.id)?
        .ok_or_else(|| anyhow!("PROVIDER_TEMPLATE_UNAVAILABLE"))
}

/// Startup-only: pending accounts represent abandoned login attempts, never
/// completed accounts requiring reauthentication. Cleanup failures propagate.
pub(crate) fn cleanup_pending(db: &Database, secrets: &SecretStore) -> Result<usize> {
    let mut stmt = db.conn().prepare("SELECT p.id,p.config_json FROM providers p JOIN provider_template_bindings b ON b.provider_id=p.id")?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut count = 0;
    for (id, raw) in rows {
        serde_json::from_str::<Value>(&raw)
            .context("pending template account cleanup encountered malformed config")?;
        if config_pending(&raw) {
            tracing::warn!(provider=%id,"removing abandoned pending template OAuth account");
            accounts::delete_provider_row(db, secrets, &id)
                .context("pending template OAuth account cleanup failed")?;
            count += 1;
        }
    }
    Ok(count)
}

pub(crate) fn pause_templates(db: &Database, plugin_id: &str) -> Result<()> {
    for id in providers::owned_provider_ids(db, plugin_id)? {
        if is_template_account(db, &id)? {
            unavailable(db, &id)?;
        }
    }
    Ok(())
}
