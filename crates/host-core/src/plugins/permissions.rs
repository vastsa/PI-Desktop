use super::*;

pub(crate) fn derive_settings(manifest: &PluginManifest) -> Vec<PluginSettingDefinition> {
    let Some(entries) = manifest
        .contributes
        .as_ref()
        .and_then(Value::as_object)
        .and_then(|map| map.get("settings"))
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };
    entries
        .iter()
        .filter_map(|entry| {
            let obj = entry.as_object()?;
            Some(PluginSettingDefinition {
                key: obj.get("key")?.as_str()?.to_string(),
                title: obj.get("title")?.as_str()?.to_string(),
                description: obj
                    .get("description")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                setting_type: obj.get("type")?.as_str()?.to_string(),
                default: obj.get("default").cloned(),
                enum_values: obj
                    .get("enum")
                    .and_then(Value::as_array)
                    .map(|values| {
                        values
                            .iter()
                            .filter_map(|value| {
                                let option = value.as_object()?;
                                Some(PluginSettingOption {
                                    label: option.get("label")?.as_str()?.to_string(),
                                    value: option.get("value")?.clone(),
                                })
                            })
                            .collect()
                    })
                    .unwrap_or_default(),
                command: obj
                    .get("command")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                scope: "plugin".into(),
            })
        })
        .collect()
}

/// Capability tokens the UI renders as badges.
pub(crate) fn derive_capabilities(manifest: &PluginManifest) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    if manifest
        .ui
        .as_ref()
        .and_then(|ui| ui.panel.as_ref())
        .is_some()
    {
        out.push("panel".into());
    }
    let map = manifest.contributes.as_ref().and_then(Value::as_object);
    let has = |key: &str| -> bool {
        map.and_then(|m| m.get(key))
            .and_then(Value::as_array)
            .map(|a| !a.is_empty())
            .unwrap_or(false)
    };
    if has("commands") {
        out.push("commands".into());
    }
    if has("views") {
        out.push("views".into());
    }
    if has("agentExtensions") {
        out.push("agentExtension".into());
    }
    if has("providers") {
        out.push("providers".into());
    }
    if has("agentTools") {
        out.push("tools".into());
    }
    if has("skills") {
        out.push("skills".into());
    }
    if has("themes") {
        out.push("themes".into());
    }
    if has("mcpServers") {
        out.push("mcp".into());
    }
    if has("services") {
        out.push("services".into());
    }
    let bus_declared = map
        .and_then(|m| m.get("bus"))
        .and_then(Value::as_object)
        .map(|bus| {
            ["publish", "subscribe"].iter().any(|key| {
                bus.get(*key)
                    .and_then(Value::as_array)
                    .map(|a| !a.is_empty())
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false);
    if bus_declared {
        out.push("bus".into());
    }
    let deny_declared = map
        .and_then(|m| m.get("permissionDeny"))
        .and_then(Value::as_object)
        .map(|deny| {
            ["tools", "paths", "commands"].iter().any(|key| {
                deny.get(*key)
                    .and_then(Value::as_array)
                    .map(|a| !a.is_empty())
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false);
    if deny_declared {
        out.push("permissionDeny".into());
    }
    out
}

impl PluginManager {
    /// Deny globs from enabled plugins whose activation scope matches the
    /// session workspace. Invalid manifests are skipped so a broken plugin
    /// cannot stall tool evaluation.
    pub fn contributed_deny_rules(
        &self,
        project_path: Option<&str>,
    ) -> Vec<crate::permission_deny::PermissionDenyRules> {
        let mut out = Vec::new();
        for plugin in &self.runtime {
            if !plugin.enabled {
                continue;
            }
            if !plugin
                .permissions
                .iter()
                .any(|permission| permission == "agent.permission.deny")
            {
                continue;
            }
            if !plugin.scope.matches(project_path) {
                continue;
            }
            let Some(path) = plugin.path.as_deref() else {
                continue;
            };
            let manifest_path = Path::new(path).join("manifest.json");
            let raw = match fs::read_to_string(&manifest_path) {
                Ok(raw) => raw,
                Err(error) => {
                    tracing::warn!(
                        plugin_id = %plugin.id,
                        path = %manifest_path.display(),
                        %error,
                        "skipping permissionDeny: unreadable plugin manifest"
                    );
                    continue;
                }
            };
            let value = match serde_json::from_str::<Value>(&raw) {
                Ok(value) => value,
                Err(error) => {
                    tracing::warn!(
                        plugin_id = %plugin.id,
                        %error,
                        "skipping permissionDeny: invalid plugin manifest JSON"
                    );
                    continue;
                }
            };
            let Some(deny) = value
                .get("contributes")
                .and_then(|contributes| contributes.get("permissionDeny"))
            else {
                continue;
            };
            match crate::permission_deny::parse_rules(deny) {
                Ok(rules) => {
                    if !rules.is_empty() {
                        out.push(rules);
                    }
                }
                Err(error) => {
                    tracing::warn!(
                        plugin_id = %plugin.id,
                        %error,
                        "skipping invalid plugin permissionDeny"
                    );
                }
            }
        }
        out
    }
}

pub(crate) fn permission_diff(old: &[String], new: &[String]) -> Vec<String> {
    new.iter()
        .filter(|p| !old.iter().any(|o| o == *p))
        .cloned()
        .collect()
}

pub(crate) fn sanitize_id(id: &str) -> String {
    id.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}
