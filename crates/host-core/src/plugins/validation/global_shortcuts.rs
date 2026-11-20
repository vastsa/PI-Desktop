use anyhow::{anyhow, bail, Result};
use serde_json::{Map, Value};

use super::{array_of, is_shortcut_id, is_shortcut_shape, require_permission, PluginManifest};

pub(super) fn validate(map: &Map<String, Value>, manifest: &PluginManifest) -> Result<()> {
    let Some(shortcuts) = map.get("globalShortcuts") else {
        return Ok(());
    };
    let entries = array_of(shortcuts, "contributes.globalShortcuts")?;
    if entries.len() > 8 {
        bail!("PLUGIN_INVALID: contributes.globalShortcuts allows at most 8 entries");
    }
    // The gate is the permission, not the contribution: a declared shortcut
    // without `keyboard.globalShortcut` would otherwise register silently.
    if !entries.is_empty() {
        require_permission(manifest, "keyboard.globalShortcut", "global shortcuts")?;
    }
    let command_ids: Vec<&str> = map
        .get("commands")
        .and_then(Value::as_array)
        .map(|commands| {
            commands
                .iter()
                .filter_map(|command| command.get("id").and_then(Value::as_str))
                .collect()
        })
        .unwrap_or_default();
    let mut seen: Vec<&str> = Vec::new();
    for entry in entries {
        let obj = entry.as_object().ok_or_else(|| {
            anyhow!("PLUGIN_INVALID: contributes.globalShortcuts entry must be an object")
        })?;
        let id = obj
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| is_shortcut_id(id))
            .ok_or_else(|| anyhow!("PLUGIN_INVALID: global shortcut id is missing or invalid"))?;
        if seen.contains(&id) {
            bail!("PLUGIN_INVALID: duplicate global shortcut id {id}");
        }
        seen.push(id);
        let command = obj
            .get("command")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|command| !command.is_empty())
            .ok_or_else(|| anyhow!("PLUGIN_INVALID: global shortcut {id} requires a command"))?;
        if !command_ids.contains(&command) {
            bail!("PLUGIN_INVALID: global shortcut {id} references an undeclared command");
        }
        if let Some(default) = obj.get("default") {
            if !is_shortcut_shape(default) {
                bail!("PLUGIN_INVALID: global shortcut {id} has an invalid default");
            }
        }
    }
    Ok(())
}
