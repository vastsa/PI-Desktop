use super::*;

/// Resolve the same host-owned precedence for both Rust and desktop-local
/// execution. A delegate's explicit scope overrides the session/global mode,
/// but never bypasses the durable Plan/Goal hard deny.
pub(super) fn effective_permission_mode(
    state: &AppState,
    session_id: &str,
    delegate_scope: Option<&str>,
) -> Result<String, JsonRpcError> {
    let own = sessions::session_permission_mode(&state.db, session_id)
        .map_err(|error| rpc_err(1000, error.to_string(), "INTERNAL"))?
        .filter(|mode| mode != "inherit");
    let inherited = state
        .db
        .get_setting("app")
        .ok()
        .flatten()
        .and_then(|setting| {
            setting
                .get("defaultPermissionMode")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .filter(|mode| sessions::is_valid_permission_mode(mode) && mode != "inherit");
    Ok(delegate_scope
        .filter(|mode| sessions::is_valid_permission_mode(mode) && *mode != "inherit")
        .map(str::to_string)
        .or(own)
        .or(inherited)
        .unwrap_or_else(|| "ask".to_string()))
}

pub(super) fn effective_reviewer(
    state: &AppState,
    session_id: &str,
) -> Result<String, JsonRpcError> {
    let own = sessions::session_approval_reviewer(&state.db, session_id)
        .map_err(|error| rpc_err(1000, error.to_string(), "INTERNAL"))?
        .filter(|reviewer| reviewer != "inherit");
    let inherited = state
        .db
        .get_setting("app")
        .ok()
        .flatten()
        .and_then(|setting| {
            setting
                .get("approvalReviewer")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .filter(|reviewer| matches!(reviewer.as_str(), "user" | "auto_review"));
    Ok(own.or(inherited).unwrap_or_else(|| "user".to_string()))
}

fn exposed_tool_owner<'a>(
    tool_name: &str,
    kind: &str,
    ids: impl IntoIterator<Item = &'a str>,
) -> Option<&'a str> {
    let mut matching = ids.into_iter().filter(|id| {
        let exposed_id: String = id
            .chars()
            .map(|ch| {
                if ch.is_ascii_alphanumeric() || ch == '_' {
                    ch
                } else {
                    '_'
                }
            })
            .collect();
        tool_name.starts_with(&format!("{kind}_{exposed_id}_"))
    });
    let owner = matching.next()?;
    // Flattening IDs and separating names with underscores is not injective:
    // plugin_a_b_run can belong to either a or a_b. Never borrow one owner's
    // configuration or policy to authorize an ambiguous tool.
    matching.next().is_none().then_some(owner)
}

#[cfg(test)]
mod exposed_tool_owner_tests {
    use super::exposed_tool_owner;

    #[test]
    fn overlapping_plugin_ids_cannot_borrow_a_shorter_owners_policy() {
        assert_eq!(
            exposed_tool_owner("plugin_a_b_run", "plugin", ["a", "a_b"]),
            None
        );
        assert_eq!(
            exposed_tool_owner("plugin_a_b_run", "plugin", ["a_b"]),
            Some("a_b")
        );
    }

    #[test]
    fn normalized_collisions_and_mcp_prefixes_do_not_reuse_configuration() {
        assert_eq!(
            exposed_tool_owner("plugin_a_b_run", "plugin", ["a-b", "a_b"]),
            None
        );
        assert_eq!(exposed_tool_owner("mcp_a_b_run", "mcp", ["a", "a_b"]), None);
        assert_eq!(exposed_tool_owner("mcp_a_b_run", "mcp", ["a"]), Some("a"));
        assert_eq!(exposed_tool_owner("plugin_ab", "plugin", ["a"]), None);
    }
}

fn trusted_tool_config_fingerprint(
    state: &mut AppState,
    tool_name: &str,
    project: Option<&str>,
) -> Option<String> {
    if tool_name.starts_with("mcp_") {
        let servers = state.mcp_servers.active_for(project).ok()?;
        let owner = exposed_tool_owner(
            tool_name,
            "mcp",
            servers.iter().map(|server| server.id.as_str()),
        )?;
        return servers
            .iter()
            .find(|server| server.id == owner)
            .and_then(|server| serde_json::to_value(server).ok())
            .map(|record| grants::fingerprint(&record));
    }
    if tool_name.starts_with("plugin_") {
        let plugins = state.plugins.list();
        let owner = exposed_tool_owner(
            tool_name,
            "plugin",
            plugins.iter().map(|plugin| plugin.id.as_str()),
        )?;
        return plugins
            .iter()
            .find(|plugin| plugin.id == owner)
            .and_then(|plugin| serde_json::to_value(plugin).ok())
            .map(|record| grants::fingerprint(&record));
    }
    None
}

/// Caller-provided risk and Plan exemptions are advisory only. The installed
/// manifest is the host-owned declaration; dynamic, undeclared tools retain
/// the conservative Medium/Plan-denied behavior.
pub(super) fn trusted_plugin_tool_policy(
    state: &AppState,
    tool_name: &str,
) -> (Option<String>, Option<Vec<String>>) {
    if !tool_name.starts_with("plugin_") {
        return (None, None);
    }
    let plugins = state.plugins.list();
    let Some(owner) = exposed_tool_owner(
        tool_name,
        "plugin",
        plugins.iter().map(|plugin| plugin.id.as_str()),
    ) else {
        return (None, None);
    };
    for plugin in plugins
        .iter()
        .filter(|plugin| plugin.id == owner && plugin.enabled && plugin.status == "ready")
    {
        let exposed_id: String = plugin
            .id
            .chars()
            .map(|ch| {
                if ch.is_ascii_alphanumeric() || ch == '_' {
                    ch
                } else {
                    '_'
                }
            })
            .collect();
        let name = tool_name
            .strip_prefix(&format!("plugin_{exposed_id}_"))
            .unwrap_or_default();
        let Ok(Some(manifest)) = state.plugins.manifest_for(&plugin.id) else {
            continue;
        };
        let Some(tool) = manifest
            .contributes
            .as_ref()
            .and_then(|value| value.get("agentTools"))
            .and_then(Value::as_array)
            .and_then(|tools| {
                tools
                    .iter()
                    .find(|tool| tool.get("name").and_then(Value::as_str) == Some(name))
            })
        else {
            continue;
        };
        let risk = tool
            .get("risk")
            .and_then(Value::as_str)
            .filter(|risk| matches!(*risk, "low" | "medium" | "high"))
            .map(str::to_string);
        let plan_safe_actions = tool
            .get("planSafeActions")
            .and_then(Value::as_array)
            .filter(|actions| {
                !actions.is_empty()
                    && actions.iter().all(|action| {
                        action
                            .as_str()
                            .is_some_and(|action| !action.trim().is_empty())
                    })
            })
            .map(|actions| {
                actions
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            });
        return (risk, plan_safe_actions);
    }
    (None, None)
}

pub(super) fn tool_grant_scope(
    state: &mut AppState,
    tool_name: &str,
    args: &Value,
    workspace: Option<&str>,
    scratch: Option<&Path>,
    shell: Option<&str>,
) -> Option<(String, String, String)> {
    let config = trusted_tool_config_fingerprint(state, tool_name, workspace);
    grants::action_scope(
        tool_name,
        args,
        workspace.map(Path::new),
        scratch,
        shell,
        config.as_deref(),
    )
    .ok()
}
