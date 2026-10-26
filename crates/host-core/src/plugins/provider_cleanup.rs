//! Durable uninstall intent for plugin-owned accounts. The host-only config
//! marker outlives registry removal and is never a user enablement preference.
use super::*;
use crate::db::{now_ms, Database};
use crate::secrets::SecretStore;
use rusqlite::{params, OptionalExtension};

pub(crate) fn config_pending(raw: &str) -> bool {
    serde_json::from_str::<Value>(raw)
        .ok()
        .and_then(|v| v.get("pluginCleanupPending")?.as_bool())
        .unwrap_or(false)
}

pub(crate) fn ensure_available(db: &Database, id: &str) -> Result<()> {
    let raw: Option<String> = db
        .conn()
        .query_row("SELECT config_json FROM providers WHERE id=?1", [id], |r| {
            r.get(0)
        })
        .optional()?;
    if raw.as_deref().is_some_and(config_pending) {
        bail!("Provider credential cleanup is pending; retry uninstall.");
    }
    Ok(())
}

/// Commit ALL owned rows unavailable before any registry or secret-file write.
/// A transaction prevents a malformed config/write fault from marking only some.
fn mark_plugin(db: &Database, plugin_id: &str) -> Result<Vec<String>> {
    let tx = db.conn().unchecked_transaction()?;
    let rows = {
        let mut stmt = db
            .conn()
            .prepare("SELECT id,config_json FROM providers WHERE owner_plugin_id=?1 ORDER BY id")?;
        let rows = stmt.query_map([plugin_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    for (id, raw) in &rows {
        let mut config: Value = serde_json::from_str(raw)?;
        let object = config
            .as_object_mut()
            .ok_or_else(|| anyhow!("invalid stored provider config"))?;
        object.insert("pluginCleanupPending".into(), json!(true));
        object.insert("pluginEnabled".into(), json!(false));
        db.conn().execute(
            "UPDATE providers SET enabled=0,config_json=?2,updated_at=?3 WHERE id=?1",
            params![id, serde_json::to_string(&config)?, now_ms()],
        )?;
    }
    tx.commit()?;
    Ok(rows.into_iter().map(|(id, _)| id).collect())
}

fn delete_ids(db: &Database, secrets: &SecretStore, ids: &[String]) -> Result<usize> {
    let mut failed = false;
    for id in ids {
        if crate::providers::delete_provider_row(db, secrets, id).is_err() {
            // Do not log storage errors: their text may include blob paths.
            tracing::warn!(provider=%id,"plugin provider credential cleanup pending");
            failed = true;
        }
    }
    if failed {
        bail!("Provider credential cleanup is pending; retry uninstall.");
    }
    Ok(ids.len())
}

pub(crate) fn remove_plugin(
    db: &Database,
    secrets: &SecretStore,
    plugin_id: &str,
) -> Result<usize> {
    let ids = mark_plugin(db, plugin_id).map_err(|_| {
        anyhow!("Plugin uninstall could not persist cleanup intent; retry uninstall.")
    })?;
    delete_ids(db, secrets, &ids)
}

/// Retry tombstones even when their owner is registered again. Never adopt them.
/// With no owner filter, one plugin's fault cannot stop another plugin's retry.
pub(crate) fn retry_pending(
    db: &Database,
    secrets: &SecretStore,
    owner: Option<&str>,
) -> Result<usize> {
    let mut stmt = db.conn().prepare("SELECT id,config_json FROM providers WHERE owner_plugin_id IS NOT NULL AND (?1 IS NULL OR owner_plugin_id=?1) ORDER BY id")?;
    let rows = stmt.query_map([owner], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    })?;
    let ids = rows
        .collect::<rusqlite::Result<Vec<_>>>()?
        .into_iter()
        .filter(|(_, raw)| config_pending(raw))
        .map(|(id, _)| id)
        .collect::<Vec<_>>();
    delete_ids(db, secrets, &ids)
}

pub(crate) fn uninstall(
    db: &Database,
    secrets: &SecretStore,
    plugins: &mut PluginManager,
    id: &str,
) -> Result<bool> {
    plugins.check_uninstall(id)?;
    let ids = mark_plugin(db, id).map_err(|_| {
        anyhow!("Plugin uninstall could not persist cleanup intent; retry uninstall.")
    })?;
    let registry = plugins.uninstall(id);
    // Registry persistence can fail after mutating memory. Cleanup still runs;
    // surviving rows keep the durable intent even if the old registry returns.
    let cleanup = delete_ids(db, secrets, &ids);
    if registry.is_err() {
        tracing::warn!(
            plugin = id,
            "plugin registry removal failed; retry uninstall"
        );
        bail!("Plugin registry removal failed; retry uninstall.");
    }
    cleanup?;
    Ok(registry? || !ids.is_empty())
}
