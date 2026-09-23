use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::Path;
use uuid::Uuid;

use crate::tools::hashline::{parse_ops, ParsedOp};
use crate::{audit, workspace};

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionGrant {
    pub id: String,
    pub session_id: String,
    pub actor_id: String,
    pub tool_name: String,
    pub scope: String,
    pub label: String,
    #[serde(skip)]
    fingerprint: String,
}

#[derive(Default)]
pub struct GrantStore {
    grants: HashMap<String, Vec<SessionGrant>>,
}

pub fn fingerprint(value: &Value) -> String {
    let raw = serde_json::to_vec(value).unwrap_or_default();
    hex::encode(Sha256::digest(&raw))
}

pub fn action_scope(
    tool_name: &str,
    args: &Value,
    workspace: Option<&Path>,
    scratch: Option<&Path>,
    shell: Option<&str>,
    config_fingerprint: Option<&str>,
) -> Result<(String, String, String), String> {
    let (scope, identity, label) = match tool_name {
        "Read" | "Write" | "Edit" | "Glob" | "Grep" => {
            let root = workspace.ok_or("WORKSPACE_REQUIRED")?;
            let requested = args.get("path").and_then(Value::as_str).unwrap_or(".");
            let (path, _) =
                workspace::resolve_tool_path_with_external(root, scratch, requested, true)?;
            let mut edit_label = "same file edit".to_string();
            let effects = if tool_name == "Edit" {
                let ops = args
                    .get("ops")
                    .and_then(Value::as_str)
                    .ok_or("EDIT_OPS_REQUIRED")?;
                let parsed = parse_ops(ops).map_err(|_| "EDIT_OPS_INVALID")?;
                let mut destination = None;
                let mut has_edit = false;
                let mut has_delete = false;
                for op in parsed.ops {
                    match op {
                        ParsedOp::Put { .. } | ParsedOp::Cut { .. } => has_edit = true,
                        ParsedOp::Rem => {
                            if has_delete {
                                return Err("EDIT_OPS_INVALID".into());
                            }
                            has_delete = true;
                        }
                        ParsedOp::Mv { dest } => {
                            if destination.is_some() {
                                return Err("EDIT_OPS_INVALID".into());
                            }
                            let (resolved, _) = workspace::resolve_tool_path_with_external(
                                root, scratch, &dest, true,
                            )?;
                            destination = Some(resolved);
                        }
                    }
                }
                if (has_delete && (has_edit || destination.is_some()))
                    || !(has_edit || has_delete || destination.is_some())
                {
                    return Err("EDIT_OPS_INVALID".into());
                }
                let operation = match (has_delete, destination.is_some(), has_edit) {
                    (true, _, _) => "delete",
                    (_, true, true) => "edit_and_move",
                    (_, true, false) => "move",
                    _ => "edit",
                };
                edit_label = match operation {
                    "move" | "edit_and_move" => {
                        let target = destination.as_ref().ok_or("EDIT_OPS_INVALID")?;
                        format!(
                            "{} to {}",
                            if has_edit { "edit and move" } else { "move" },
                            target.strip_prefix(root).unwrap_or(target).display()
                        )
                    }
                    "delete" => "delete file".to_string(),
                    _ => "same file edit".to_string(),
                };
                serde_json::json!({"effect": operation, "destination": destination})
            } else {
                Value::Null
            };
            let detail =
                serde_json::json!({"operation": tool_name, "path": path, "effects": effects});
            let label = format!(
                "{tool_name}: {} ({})",
                path.display(),
                if tool_name == "Edit" {
                    &edit_label
                } else {
                    "same operation"
                }
            );
            ("path", detail, label)
        }
        "Bash" => {
            let root = workspace.ok_or("WORKSPACE_REQUIRED")?;
            let cwd = workspace::simple_canonicalize(root).map_err(|_| "WORKSPACE_REQUIRED")?;
            let command = args
                .get("command")
                .and_then(Value::as_str)
                .ok_or("COMMAND_REQUIRED")?;
            let selected_shell = shell.ok_or("SHELL_REQUIRED")?;
            let redacted = audit::redact_string(command);
            let preview: String = redacted.chars().take(100).collect();
            let clipped = redacted.chars().count() > 100;
            (
                "command",
                serde_json::json!({"command": command, "cwd": cwd, "shell": selected_shell}),
                format!(
                    "Bash [{selected_shell}]: {}{}, cwd {}",
                    preview,
                    if clipped { "…" } else { "" },
                    cwd.display()
                ),
            )
        }
        _ => {
            let config = config_fingerprint.ok_or("TOOL_CONFIG_REQUIRED")?;
            (
                "external",
                serde_json::json!({"toolName": tool_name, "config": config, "args": args}),
                format!("{tool_name}: exact arguments"),
            )
        }
    };
    let scope_fingerprint = fingerprint(&identity);
    Ok((
        scope.to_string(),
        scope_fingerprint.clone(),
        format!("{label} [#{}]", &scope_fingerprint[..10]),
    ))
}

impl GrantStore {
    pub fn list(&self, session_id: &str) -> Vec<SessionGrant> {
        self.grants.get(session_id).cloned().unwrap_or_default()
    }

    pub fn allows(
        &self,
        session_id: &str,
        actor_id: &str,
        tool_name: &str,
        fingerprint: &str,
    ) -> bool {
        self.grants.get(session_id).is_some_and(|grants| {
            grants.iter().any(|grant| {
                grant.actor_id == actor_id
                    && grant.tool_name == tool_name
                    && grant.fingerprint == fingerprint
            })
        })
    }

    pub fn grant(
        &mut self,
        session_id: &str,
        actor_id: &str,
        tool_name: &str,
        scope: &str,
        fingerprint: &str,
        label: &str,
    ) {
        if self.allows(session_id, actor_id, tool_name, fingerprint) {
            return;
        }
        self.grants
            .entry(session_id.to_string())
            .or_default()
            .push(SessionGrant {
                id: Uuid::new_v4().to_string(),
                session_id: session_id.to_string(),
                actor_id: actor_id.to_string(),
                tool_name: tool_name.to_string(),
                scope: scope.to_string(),
                label: label.to_string(),
                fingerprint: fingerprint.to_string(),
            });
    }

    pub fn revoke(&mut self, session_id: &str, grant_id: &str) -> bool {
        let Some(grants) = self.grants.get_mut(session_id) else {
            return false;
        };
        let before = grants.len();
        grants.retain(|grant| grant.id != grant_id);
        before != grants.len()
    }

    pub fn clear(&mut self, session_id: &str) {
        self.grants.remove(session_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grant_never_crosses_actor_tool_or_scope() {
        let mut store = GrantStore::default();
        store.grant("session", "agent", "Bash", "command", "first", "command");
        assert!(store.allows("session", "agent", "Bash", "first"));
        assert!(!store.allows("session", "delegate", "Bash", "first"));
        assert!(!store.allows("other", "agent", "Bash", "first"));
        assert!(!store.allows("session", "agent", "Bash", "second"));
        let id = store.list("session")[0].id.clone();
        assert!(store.revoke("session", &id));
        assert!(!store.allows("session", "agent", "Bash", "first"));
    }

    #[test]
    fn file_move_scope_binds_destination() {
        let root = tempfile::tempdir().unwrap();
        let args = serde_json::json!({"path": "a.txt", "ops": "[a.txt#AAAA]\nMV b.txt"});
        let (_, first, _) =
            action_scope("Edit", &args, Some(root.path()), None, None, None).unwrap();
        let other = serde_json::json!({"path": "a.txt", "ops": "[a.txt#AAAA]\nMV c.txt"});
        let (_, second, _) =
            action_scope("Edit", &other, Some(root.path()), None, None, None).unwrap();
        assert_ne!(first, second);
    }

    #[test]
    fn edit_grant_reuses_canonical_source_and_operation_not_patch_bytes() {
        let root = tempfile::tempdir().unwrap();
        let first = serde_json::json!({"path": "a.txt", "ops": "[a.txt#AAAA]\nPUT 1.=1:\n+first"});
        let second =
            serde_json::json!({"path": "./a.txt", "ops": "[a.txt#BBBB]\nPUT 1.=1:\n+second"});
        let (_, first_scope, _) =
            action_scope("Edit", &first, Some(root.path()), None, None, None).unwrap();
        let (_, second_scope, _) =
            action_scope("Edit", &second, Some(root.path()), None, None, None).unwrap();
        assert_eq!(first_scope, second_scope);
        let mut grants = GrantStore::default();
        grants.grant(
            "session",
            "agent",
            "Edit",
            "path",
            &first_scope,
            "edit a.txt",
        );
        assert!(grants.allows("session", "agent", "Edit", &second_scope));
    }

    #[test]
    fn delete_move_and_mixed_move_cannot_borrow_an_edit_grant() {
        let root = tempfile::tempdir().unwrap();
        let scope = |ops: &str| {
            action_scope(
                "Edit",
                &serde_json::json!({"path": "a.txt", "ops": ops}),
                Some(root.path()),
                None,
                None,
                None,
            )
            .map(|(_, fingerprint, _)| fingerprint)
        };
        let edit = scope("[a.txt#AAAA]\nPUT 1.=1:\n+first").unwrap();
        let delete = scope("[a.txt#AAAA]\nREM").unwrap();
        let move_only = scope("[a.txt#AAAA]\nMV b.txt").unwrap();
        let edit_and_move = scope("[a.txt#AAAA]\nPUT 1.=1:\n+first\nMV b.txt").unwrap();
        assert_ne!(edit, delete);
        assert_ne!(edit, move_only);
        assert_ne!(edit, edit_and_move);
        assert_ne!(move_only, edit_and_move);
        assert!(scope("[a.txt#AAAA]\nREM\nMV b.txt").is_err());
        assert!(scope("[a.txt#AAAA]\nREM\nPUT 1.=1:\n+first").is_err());
    }

    #[test]
    fn grant_labels_distinguish_commands_without_exposing_secrets() {
        let root = tempfile::tempdir().unwrap();
        let args = serde_json::json!({"command": "echo token=ghp_abcdef0123456789"});
        let (_, first, label) =
            action_scope("Bash", &args, Some(root.path()), None, Some("bash"), None).unwrap();
        assert!(label.contains("Bash [bash]: echo token=***REDACTED***"));
        assert!(!label.contains("ghp_"));
        assert!(label.contains(&first[..10]));
        let (_, other, other_label) = action_scope(
            "Bash",
            &serde_json::json!({
            "command": "echo token=ghp_othersecrettoken1234"}),
            Some(root.path()),
            None,
            Some("bash"),
            None,
        )
        .unwrap();
        assert_ne!(first, other);
        assert_ne!(label, other_label);
        let (_, _, move_label) = action_scope(
            "Edit",
            &serde_json::json!({
                "path": "a.txt", "ops": "[a.txt#AAAA]\nMV results.txt",
            }),
            Some(root.path()),
            None,
            None,
            None,
        )
        .unwrap();
        assert!(move_label.contains("move to results.txt"));
    }
}
