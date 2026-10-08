use anyhow::{anyhow, bail, Result};
use serde_json::{Map, Value};

use super::{array_of, is_contrib_id, require_permission, PluginManifest};

pub(super) fn validate(map: &Map<String, Value>, manifest: &PluginManifest) -> Result<()> {
    let Some(transforms) = map.get("composerTransforms") else {
        return Ok(());
    };
    let entries = array_of(transforms, "contributes.composerTransforms")?;
    if !entries.is_empty() {
        require_permission(manifest, "composer.transform", "composer transforms")?;
    }

    let mut seen: Vec<&str> = Vec::new();
    for entry in entries {
        let obj = entry.as_object().ok_or_else(|| {
            anyhow!("PLUGIN_INVALID: contributes.composerTransforms entry must be an object")
        })?;
        let id = obj
            .get("id")
            .and_then(Value::as_str)
            .filter(|id| is_contrib_id(id))
            .ok_or_else(|| {
                anyhow!("PLUGIN_INVALID: composer transform id is missing or invalid")
            })?;
        if seen.contains(&id) {
            bail!("PLUGIN_INVALID: duplicate composer transform id {id}");
        }
        seen.push(id);
        for field in ["title", "undoTitle"] {
            let Some(value) = obj.get(field) else {
                if field == "title" {
                    bail!("PLUGIN_INVALID: composer transform {id} requires a title");
                }
                continue;
            };
            if !is_plugin_label(value) {
                bail!("PLUGIN_INVALID: composer transform {id} has an invalid {field}");
            }
        }
    }
    Ok(())
}

/// Composer labels accept either a plain string or both contract locales.
fn is_plugin_label(value: &Value) -> bool {
    if value.as_str().is_some_and(|label| !label.trim().is_empty()) {
        return true;
    }
    value.as_object().is_some_and(|localized| {
        ["en", "zh-CN"].iter().all(|locale| {
            localized
                .get(*locale)
                .and_then(Value::as_str)
                .is_some_and(|label| !label.trim().is_empty())
        })
    })
}
