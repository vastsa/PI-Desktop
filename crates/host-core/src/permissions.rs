use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use uuid::Uuid;

use crate::db::{ms_to_ts, now_ms};

/// Longest string leaf kept in a permission request's args preview. Full args
/// (e.g. a Write's whole file content) would otherwise cross every stdio/IPC
/// hop and stall the renderer right as the dialog opens.
const ARGS_PREVIEW_MAX_CHARS: usize = 2_000;

fn preview_value(value: &serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::String(s) => {
            let total = s.chars().count();
            if total <= ARGS_PREVIEW_MAX_CHARS {
                return value.clone();
            }
            let head: String = s.chars().take(ARGS_PREVIEW_MAX_CHARS).collect();
            serde_json::Value::String(format!(
                "{head}… (+{} chars)",
                total - ARGS_PREVIEW_MAX_CHARS
            ))
        }
        serde_json::Value::Array(items) => {
            serde_json::Value::Array(items.iter().map(preview_value).collect())
        }
        serde_json::Value::Object(map) => serde_json::Value::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), preview_value(v)))
                .collect(),
        ),
        other => other.clone(),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PermissionDecision {
    AllowOnce,
    AllowSession,
    Deny,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Risk {
    Low,
    Medium,
    High,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRequest {
    pub request_id: String,
    pub session_id: String,
    pub tool_call_id: String,
    pub tool_name: String,
    pub risk: Risk,
    pub args_preview: serde_json::Value,
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command_shell_id: Option<String>,
}

pub struct PermissionRequestParams<'a> {
    pub session_id: &'a str,
    pub tool_call_id: &'a str,
    pub tool_name: &'a str,
    pub args_preview: serde_json::Value,
    pub reason: &'a str,
    pub declared_risk: Option<&'a str>,
    pub command_shell_id: Option<&'a str>,
}

pub struct PermissionEvaluationParams<'a> {
    pub session_id: &'a str,
    pub tool_name: &'a str,
    pub mode: &'a str,
    pub permission_mode: &'a str,
    pub session_grants: &'a HashMap<String, Vec<String>>,
    pub declared_risk: Option<&'a str>,
    pub requires_external_path_permission: bool,
    pub plan_safe_actions: Option<&'a [String]>,
}

#[derive(Debug)]
struct Pending {
    /// Creation time used by the `permissions.pending` read and ordering.
    created_at_ms: i64,
    /// Arrival order; two requests can share a millisecond.
    sequence: u64,
    session_id: String,
    tool_call_id: String,
    /// The request as it was emitted, already preview-bounded, so a client
    /// that attaches after the notification can render the same card.
    request: PermissionRequest,
    tx: Option<tokio::sync::oneshot::Sender<PermissionDecision>>,
}

/// One open permission request as returned by `permissions.pending`
/// (D374/D375). Pending requests are Host state, not connection state: a
/// late-attaching client reads them here instead of missing the notification.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingPermission {
    #[serde(flatten)]
    pub request: PermissionRequest,
    pub created_at: String,
}

/// Contract admission is independent of risk and automatic permission modes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContractAdmission {
    /// Fall through to the ordinary permission path.
    Allowed,
    /// Nothing says this call is safe, so a human decides before it runs.
    Approval,
    /// Denied outright by the contract mode.
    Denied,
}

#[derive(Default)]
pub struct PermissionManager {
    pending: HashMap<String, Pending>,
    next_sequence: u64,
}

impl PermissionManager {
    pub fn tool_risk_with_declared(tool_name: &str, declared: Option<&str>) -> Risk {
        match tool_name {
            "Read" | "Glob" | "Grep" | "ScheduledTaskList" | "TodoWrite" => Risk::Low,
            "Write" | "Edit" | "Bash" | "GenerateImages" => Risk::High,
            name if name.starts_with("plugin_") => match declared {
                Some("low") => Risk::Low,
                Some("high") => Risk::High,
                Some("medium") => Risk::Medium,
                // A missing or malformed manifest declaration is not a
                // low-risk grant. Medium preserves the normal approval path.
                _ => Risk::Medium,
            },
            // MCP servers are user-configured but their tools are opaque; a
            // self-declared annotation comes from the server, so it is not
            // trusted and never lowers the approval path.
            name if name.starts_with("mcp_") => Risk::Medium,
            _ => Risk::Medium,
        }
    }

    /// Builtins a contract mode refuses: the ones that write files or session
    /// state (`Write`, `Edit`, `TodoWrite`, `GenerateImages`, `PluginScaffold`,
    /// `PluginPack`, the `ScheduledTask*` tools), the delegation family that
    /// spawns and controls work (`Task*`), and `JevClassify`, whose Agent-only
    /// paid call must not run from a reference retained across a mode switch.
    /// Every other name reaches the ordinary permission path, so the gate
    /// answers by effect instead of by provenance (ADR 0331). `PluginCheck` and
    /// `Skill` are absent because they only read, and the runtime never creates
    /// either outside Agent mode. `packages/agent-runtime/src/mode-tool-access.ts`
    /// mirrors this list, and a test asserts the two stay identical.
    const CONTRACT_MODE_STATE_CHANGING: [&str; 14] = [
        "Write",
        "Edit",
        "TodoWrite",
        "GenerateImages",
        "PluginScaffold",
        "PluginPack",
        "ScheduledTaskCreate",
        "ScheduledTaskUpdate",
        "ScheduledTaskDelete",
        "Task",
        "TaskWait",
        "TaskList",
        "TaskStop",
        "JevClassify",
    ];

    /// The contract modes' own gate, asked before risk, permission mode,
    /// grants, and scratch paths.
    ///
    /// `Denied` is a hard deny that no permission mode or session grant can
    /// re-enable. `Approval` routes the call to a permission card. `Allowed`
    /// falls through to the ordinary permission path, which still applies
    /// risk, the effective permission mode, grants, and the external-path rule.
    pub fn contract_admission(
        tool_name: &str,
        plan_safe_actions: Option<&[String]>,
    ) -> ContractAdmission {
        if Self::CONTRACT_MODE_STATE_CHANGING.contains(&tool_name) {
            return ContractAdmission::Denied;
        }
        if tool_name == "Bash" || tool_name.starts_with("mcp_") {
            return ContractAdmission::Approval;
        }
        if tool_name.starts_with("plugin_") {
            // The declaration is the escape hatch (ADR 0211): without one the
            // plugin runtime refuses the call too, so a card would be theater.
            // The per-action restriction is enforced there, in
            // `apps/desktop/electron/main/plugin-runtime.ts`, where a plugin
            // tool's `execute` rejects an undeclared action in plan/goal.
            return if plan_safe_actions.is_some_and(|actions| !actions.is_empty()) {
                ContractAdmission::Allowed
            } else {
                ContractAdmission::Denied
            };
        }
        ContractAdmission::Allowed
    }

    /// Auto-decision with an effective permission mode (D115).
    ///
    /// `permission_mode` is the already-resolved effective mode — the
    /// caller collapses `inherit` against the global default before calling.
    /// A contract mode's hard deny stays above every permission mode: `auto`
    /// cannot re-enable `Write`/`Edit` in Plan or Goal, and cannot skip the card
    /// `Bash` or a user MCP tool needs.
    #[cfg(test)]
    pub fn evaluate_auto_with_permission_mode(
        &self,
        session_id: &str,
        tool_name: &str,
        mode: &str,
        permission_mode: &str,
        session_grants: &HashMap<String, Vec<String>>,
    ) -> Option<PermissionDecision> {
        self.evaluate_auto_with_permission_mode_and_risk(PermissionEvaluationParams {
            session_id,
            tool_name,
            mode,
            permission_mode,
            session_grants,
            declared_risk: None,
            requires_external_path_permission: false,
            plan_safe_actions: None,
        })
    }

    #[cfg(test)]
    pub fn evaluate_auto_with_permission_mode_and_risk(
        &self,
        params: PermissionEvaluationParams<'_>,
    ) -> Option<PermissionDecision> {
        self.evaluate_auto_with_permission_mode_and_risk_and_path(params)
    }

    /// Evaluate a tool that explicitly targets a path outside the session's
    /// workspace and scratch roots. Outside-path access is an exception to the
    /// normal low-risk auto-allow rule: `auto` allows it, while every other
    /// mode needs a card (unless the session already granted this tool).
    pub fn evaluate_auto_with_permission_mode_and_risk_and_path(
        &self,
        params: PermissionEvaluationParams<'_>,
    ) -> Option<PermissionDecision> {
        let PermissionEvaluationParams {
            session_id,
            tool_name,
            mode,
            permission_mode,
            session_grants,
            declared_risk,
            requires_external_path_permission,
            plan_safe_actions,
        } = params;
        let has_session_grant = session_grants
            .get(session_id)
            .is_some_and(|grants| grants.iter().any(|name| name == tool_name));
        // A contract mode decides first, and that decision precedes low-risk
        // classification, auto, grants, and scratch paths, so none of them can
        // re-enable what it denied (D198, and Goal shares Plan's gate).
        if crate::sessions::is_contract_mode(mode) {
            match Self::contract_admission(tool_name, plan_safe_actions) {
                ContractAdmission::Denied => return Some(PermissionDecision::Deny),
                // No permission mode short-circuits an opaque tool: `Bash` and
                // an MCP tool are exactly the case where `auto` must not decide.
                ContractAdmission::Approval => {
                    return has_session_grant.then_some(PermissionDecision::AllowSession);
                }
                ContractAdmission::Allowed => {}
            }
        }

        if requires_external_path_permission {
            if permission_mode == "auto" {
                return Some(PermissionDecision::AllowOnce);
            }
            if has_session_grant {
                return Some(PermissionDecision::AllowSession);
            }
            return None;
        }

        let risk = Self::tool_risk_with_declared(tool_name, declared_risk);
        if matches!(risk, Risk::Low) {
            return Some(PermissionDecision::AllowOnce);
        }
        let mode_allows = match permission_mode {
            "auto" => true,
            "accept-edits" => matches!(tool_name, "Write" | "Edit"),
            _ => false,
        };
        if mode_allows {
            return Some(PermissionDecision::AllowOnce);
        }
        if has_session_grant {
            return Some(PermissionDecision::AllowSession);
        }
        None
    }

    #[cfg(test)]
    pub fn create_request(
        &mut self,
        session_id: &str,
        tool_call_id: &str,
        tool_name: &str,
        args_preview: serde_json::Value,
        reason: &str,
    ) -> (
        PermissionRequest,
        tokio::sync::oneshot::Receiver<PermissionDecision>,
    ) {
        self.create_request_with_risk_and_shell(PermissionRequestParams {
            session_id,
            tool_call_id,
            tool_name,
            args_preview,
            reason,
            declared_risk: None,
            command_shell_id: None,
        })
    }

    pub fn create_request_with_risk_and_shell(
        &mut self,
        params: PermissionRequestParams<'_>,
    ) -> (
        PermissionRequest,
        tokio::sync::oneshot::Receiver<PermissionDecision>,
    ) {
        let PermissionRequestParams {
            session_id,
            tool_call_id,
            tool_name,
            args_preview,
            reason,
            declared_risk,
            command_shell_id,
        } = params;
        let request_id = Uuid::new_v4().to_string();
        let request = PermissionRequest {
            request_id: request_id.clone(),
            session_id: session_id.to_string(),
            tool_call_id: tool_call_id.to_string(),
            tool_name: tool_name.to_string(),
            risk: Self::tool_risk_with_declared(tool_name, declared_risk),
            args_preview: preview_value(&args_preview),
            reason: reason.to_string(),
            command_shell_id: command_shell_id.map(str::to_string),
        };
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.next_sequence += 1;
        self.pending.insert(
            request_id,
            Pending {
                created_at_ms: now_ms(),
                sequence: self.next_sequence,
                session_id: session_id.to_string(),
                tool_call_id: tool_call_id.to_string(),
                request: request.clone(),
                tx: Some(tx),
            },
        );
        (request, rx)
    }

    /// Open requests, oldest first, optionally scoped to one session. Requests
    /// remain open until an explicit decision or cancellation settles them.
    pub fn pending_requests(&self, session_id: Option<&str>) -> Vec<PendingPermission> {
        let mut open: Vec<&Pending> = self
            .pending
            .values()
            .filter(|pending| session_id.is_none_or(|id| pending.session_id == id))
            .collect();
        open.sort_by_key(|pending| (pending.created_at_ms, pending.sequence));
        open.into_iter()
            .map(|pending| PendingPermission {
                request: pending.request.clone(),
                created_at: ms_to_ts(pending.created_at_ms),
            })
            .collect()
    }

    pub fn resolve(
        &mut self,
        request_id: &str,
        decision: PermissionDecision,
    ) -> Result<(), String> {
        let Some(mut pending) = self.pending.remove(request_id) else {
            return Err("NOT_FOUND".into());
        };
        if let Some(tx) = pending.tx.take() {
            let _ = tx.send(decision);
        }
        Ok(())
    }

    /// Remove a request because its tool call was aborted. Sending deny also
    /// wakes a waiter that raced the cancellation signal; the caller still
    /// returns TOOL_ABORTED because cancellation is authoritative.
    pub fn cancel(&mut self, request_id: &str) -> bool {
        let Some(mut pending) = self.pending.remove(request_id) else {
            return false;
        };
        if let Some(tx) = pending.tx.take() {
            let _ = tx.send(PermissionDecision::Deny);
        }
        true
    }

    pub fn cancel_for_tool(&mut self, session_id: &str, tool_call_id: &str) -> bool {
        let request_id = self
            .pending
            .iter()
            .find(|(_, pending)| {
                pending.session_id == session_id && pending.tool_call_id == tool_call_id
            })
            .map(|(request_id, _)| request_id.clone());
        request_id.is_some_and(|request_id| self.cancel(&request_id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn no_grants() -> HashMap<String, Vec<String>> {
        HashMap::new()
    }

    #[test]
    fn pending_requests_lists_open_requests_until_resolved() {
        let mut pm = PermissionManager::default();
        let (first, _rx1) = pm.create_request(
            "session-a",
            "call-1",
            "Bash",
            serde_json::json!({ "command": "ls" }),
            "high risk",
        );
        let (second, _rx2) = pm.create_request(
            "session-b",
            "call-2",
            "Write",
            serde_json::json!({ "path": "x" }),
            "high risk",
        );
        let all = pm.pending_requests(None);
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].request.request_id, first.request_id);
        assert_eq!(all[0].request.tool_name, "Bash");
        let scoped = pm.pending_requests(Some("session-b"));
        assert_eq!(scoped.len(), 1);
        assert_eq!(scoped[0].request.request_id, second.request_id);
        pm.resolve(&first.request_id, PermissionDecision::Deny)
            .unwrap();
        assert_eq!(pm.pending_requests(None).len(), 1);
        pm.cancel(&second.request_id);
        assert!(pm.pending_requests(None).is_empty());
    }

    #[test]
    fn pending_permissions_remain_resolvable_without_deadline() {
        let mut pm = PermissionManager::default();
        let (request, _rx) = pm.create_request(
            "session-a",
            "call-1",
            "Bash",
            serde_json::json!({ "command": "ls" }),
            "high risk",
        );
        let pending = pm
            .pending
            .get_mut(&request.request_id)
            .expect("request is pending");
        pending.created_at_ms = pending.created_at_ms.saturating_sub(121_000);

        assert_eq!(pm.pending_requests(None).len(), 1);
        assert!(pm
            .resolve(&request.request_id, PermissionDecision::AllowOnce)
            .is_ok());
    }

    #[test]
    fn ask_mode_prompts_for_high_risk() {
        let pm = PermissionManager::default();
        for tool in ["Write", "Edit", "Bash"] {
            let d = pm.evaluate_auto_with_permission_mode("s", tool, "agent", "ask", &no_grants());
            assert!(d.is_none(), "{tool} should prompt under ask");
        }
    }

    #[test]
    fn accept_edits_allows_file_tools_only() {
        let pm = PermissionManager::default();
        for tool in ["Write", "Edit"] {
            let d = pm.evaluate_auto_with_permission_mode(
                "s",
                tool,
                "agent",
                "accept-edits",
                &no_grants(),
            );
            assert_eq!(d, Some(PermissionDecision::AllowOnce), "{tool}");
        }
        let bash = pm.evaluate_auto_with_permission_mode(
            "s",
            "Bash",
            "agent",
            "accept-edits",
            &no_grants(),
        );
        assert!(bash.is_none(), "Bash still prompts under accept-edits");
    }

    #[test]
    fn auto_allows_all_high_risk_in_agent_mode() {
        let pm = PermissionManager::default();
        for tool in ["Write", "Edit", "Bash", "plugin_x_run"] {
            let d = pm.evaluate_auto_with_permission_mode("s", tool, "agent", "auto", &no_grants());
            assert!(
                matches!(d, Some(PermissionDecision::AllowOnce)),
                "{tool} should auto-allow"
            );
        }
    }

    #[test]
    fn plugin_risk_preserves_valid_declarations_and_defaults_to_medium() {
        assert!(matches!(
            PermissionManager::tool_risk_with_declared("plugin_x_run", Some("low")),
            Risk::Low
        ));
        assert!(matches!(
            PermissionManager::tool_risk_with_declared("plugin_x_run", Some("medium")),
            Risk::Medium
        ));
        assert!(matches!(
            PermissionManager::tool_risk_with_declared("plugin_x_run", Some("high")),
            Risk::High
        ));
        assert!(matches!(
            PermissionManager::tool_risk_with_declared("plugin_x_run", None),
            Risk::Medium
        ));
        assert!(matches!(
            PermissionManager::tool_risk_with_declared("plugin_x_run", Some("invalid")),
            Risk::Medium
        ));
    }

    /// A contract mode denies what changes state, whatever the permission mode
    /// would otherwise allow. `auto` and `accept-edits` cannot re-enable it,
    /// and neither can a session grant. The test drives the list itself, so it
    /// pins the wiring for every name on it; a state-changing builtin missing
    /// from the list is invisible here, which is the omission ADR 0331 accepts.
    #[test]
    fn contract_modes_deny_state_changing_builtins_in_every_permission_mode() {
        let pm = PermissionManager::default();
        let grants = HashMap::from([(
            "s".to_string(),
            PermissionManager::CONTRACT_MODE_STATE_CHANGING
                .iter()
                .map(|name| (*name).to_string())
                .collect::<Vec<_>>(),
        )]);
        for contract in ["plan", "goal"] {
            for mode in ["ask", "accept-edits", "auto"] {
                for tool in PermissionManager::CONTRACT_MODE_STATE_CHANGING {
                    assert_eq!(
                        pm.evaluate_auto_with_permission_mode("s", tool, contract, mode, &grants),
                        Some(PermissionDecision::Deny),
                        "{contract} + {mode} denies {tool} even with a session grant"
                    );
                }
            }
        }
    }

    /// The posture is deny-by-effect (ADR 0331): a builtin nobody classified is
    /// not refused here, it follows the ordinary permission path. `auto` admits
    /// it, every other permission mode asks.
    #[test]
    fn contract_modes_route_an_unclassified_builtin_to_the_normal_path() {
        let pm = PermissionManager::default();
        for contract in ["plan", "goal"] {
            assert_eq!(
                pm.evaluate_auto_with_permission_mode(
                    "s",
                    "an_unclassified_builtin",
                    contract,
                    "auto",
                    &no_grants()
                ),
                Some(PermissionDecision::AllowOnce),
                "{contract} + auto follows the ordinary path"
            );
            assert_eq!(
                pm.evaluate_auto_with_permission_mode(
                    "s",
                    "an_unclassified_builtin",
                    contract,
                    "ask",
                    &no_grants()
                ),
                None,
                "{contract} + ask takes a card"
            );
        }
    }

    #[test]
    fn contract_modes_require_approval_unless_the_tool_has_a_session_grant() {
        let pm = PermissionManager::default();
        let grants = HashMap::from([(
            "s".to_string(),
            vec!["Bash".to_string(), "mcp_srv_tool".to_string()],
        )]);
        for contract in ["plan", "goal"] {
            for mode in ["ask", "accept-edits", "auto"] {
                for tool in ["Bash", "mcp_srv_tool"] {
                    assert_eq!(
                        pm.evaluate_auto_with_permission_mode(
                            "s",
                            tool,
                            contract,
                            mode,
                            &no_grants()
                        ),
                        None,
                        "{contract} + {mode} must prompt for {tool} without a grant"
                    );
                    assert_eq!(
                        pm.evaluate_auto_with_permission_mode("s", tool, contract, mode, &grants),
                        Some(PermissionDecision::AllowSession),
                        "{contract} + {mode} must honor the grant for {tool}"
                    );
                    assert_eq!(
                        pm.evaluate_auto_with_permission_mode(
                            "other", tool, contract, mode, &grants
                        ),
                        None,
                        "{contract} + {mode} must not share {tool}'s grant across sessions"
                    );
                }
            }
        }
    }

    #[test]
    fn low_risk_auto_allows_in_every_mode() {
        let pm = PermissionManager::default();
        for mode in ["ask", "accept-edits", "auto"] {
            let d = pm.evaluate_auto_with_permission_mode("s", "Read", "agent", mode, &no_grants());
            assert_eq!(d, Some(PermissionDecision::AllowOnce), "Read + {mode}");
        }
    }

    /// TodoWrite is the session checklist: low risk, so the normal permission
    /// modes never prompt for it inside Agent mode, and part of the contract
    /// modes' hard deny — a Plan/Goal checklist is negotiated through the
    /// proposal instead of written directly.
    #[test]
    fn todo_write_is_low_risk_in_agent_and_denied_in_contract_modes() {
        let pm = PermissionManager::default();
        assert!(matches!(
            PermissionManager::tool_risk_with_declared("TodoWrite", None),
            Risk::Low
        ));
        for mode in ["ask", "accept-edits", "auto"] {
            assert_eq!(
                pm.evaluate_auto_with_permission_mode(
                    "s",
                    "TodoWrite",
                    "agent",
                    mode,
                    &no_grants()
                ),
                Some(PermissionDecision::AllowOnce),
                "agent + {mode}"
            );
        }
        let mut grants = HashMap::new();
        grants.insert("s".to_string(), vec!["TodoWrite".to_string()]);
        for contract in ["plan", "goal"] {
            for mode in ["ask", "accept-edits", "auto"] {
                assert_eq!(
                    pm.evaluate_auto_with_permission_mode(
                        "s",
                        "TodoWrite",
                        contract,
                        mode,
                        &grants
                    ),
                    Some(PermissionDecision::Deny),
                    "{contract} + {mode} denies even with a session grant"
                );
            }
        }
    }

    #[test]
    fn external_paths_prompt_for_low_risk_tools_outside_auto() {
        let pm = PermissionManager::default();
        for mode in ["ask", "accept-edits"] {
            let decision = pm.evaluate_auto_with_permission_mode_and_risk_and_path(
                PermissionEvaluationParams {
                    session_id: "s",
                    tool_name: "Read",
                    mode: "agent",
                    permission_mode: mode,
                    session_grants: &no_grants(),
                    declared_risk: None,
                    requires_external_path_permission: true,
                    plan_safe_actions: None,
                },
            );
            assert_eq!(
                decision, None,
                "Read outside workspace must prompt in {mode}"
            );
        }
        let auto =
            pm.evaluate_auto_with_permission_mode_and_risk_and_path(PermissionEvaluationParams {
                session_id: "s",
                tool_name: "Read",
                mode: "agent",
                permission_mode: "auto",
                session_grants: &no_grants(),
                declared_risk: None,
                requires_external_path_permission: true,
                plan_safe_actions: None,
            });
        assert_eq!(auto, Some(PermissionDecision::AllowOnce));
    }

    #[test]
    fn external_path_session_grant_still_applies() {
        let pm = PermissionManager::default();
        let mut grants = HashMap::new();
        grants.insert("s".to_string(), vec!["Grep".to_string()]);
        let decision =
            pm.evaluate_auto_with_permission_mode_and_risk_and_path(PermissionEvaluationParams {
                session_id: "s",
                tool_name: "Grep",
                mode: "plan",
                permission_mode: "ask",
                session_grants: &grants,
                declared_risk: None,
                requires_external_path_permission: true,
                plan_safe_actions: None,
            });
        assert_eq!(decision, Some(PermissionDecision::AllowSession));
    }

    #[test]
    fn session_grants_still_apply_under_ask() {
        let pm = PermissionManager::default();
        let mut grants = HashMap::new();
        grants.insert("s".to_string(), vec!["Bash".to_string()]);
        let d = pm.evaluate_auto_with_permission_mode("s", "Bash", "agent", "ask", &grants);
        assert_eq!(d, Some(PermissionDecision::AllowSession));
    }

    #[test]
    fn mcp_tools_default_to_medium_and_ignore_declared_risk() {
        for declared in [
            None,
            Some("low"),
            Some("medium"),
            Some("high"),
            Some("bogus"),
        ] {
            assert!(
                matches!(
                    PermissionManager::tool_risk_with_declared("mcp_srv_tool", declared),
                    Risk::Medium
                ),
                "mcp tool with declared {declared:?} must be medium"
            );
        }
    }

    #[test]
    fn mcp_tools_prompt_under_ask_and_accept_edits() {
        let pm = PermissionManager::default();
        for mode in ["ask", "accept-edits"] {
            for declared in [None, Some("low")] {
                let d =
                    pm.evaluate_auto_with_permission_mode_and_risk(PermissionEvaluationParams {
                        session_id: "s",
                        tool_name: "mcp_srv_tool",
                        mode: "agent",
                        permission_mode: mode,
                        session_grants: &no_grants(),
                        declared_risk: declared,
                        requires_external_path_permission: false,
                        plan_safe_actions: None,
                    });
                assert!(
                    d.is_none(),
                    "mcp tool must prompt under {mode} ({declared:?})"
                );
            }
        }
    }

    #[test]
    fn mcp_tools_auto_allow_under_auto() {
        let pm = PermissionManager::default();
        let d = pm.evaluate_auto_with_permission_mode(
            "s",
            "mcp_srv_tool",
            "agent",
            "auto",
            &no_grants(),
        );
        assert_eq!(d, Some(PermissionDecision::AllowOnce));
    }

    #[test]
    fn mcp_session_grant_skips_prompt() {
        let pm = PermissionManager::default();
        let mut grants = HashMap::new();
        grants.insert("s".to_string(), vec!["mcp_srv_tool".to_string()]);
        let d = pm.evaluate_auto_with_permission_mode("s", "mcp_srv_tool", "agent", "ask", &grants);
        assert_eq!(d, Some(PermissionDecision::AllowSession));
        let other =
            pm.evaluate_auto_with_permission_mode("s", "mcp_srv_other", "agent", "ask", &grants);
        assert!(other.is_none(), "grant is scoped to the exact tool name");
    }

    /// The escape hatch is a declaration, not a default: a plugin tool is
    /// admitted only when the plugin runtime will also hold it to the same
    /// action list. Without one the tool is refused, because an approval the
    /// callee then rejects would be theater.
    #[test]
    fn contract_mode_admits_plugin_tools_only_with_plan_safe_actions() {
        let pm = PermissionManager::default();
        let denied =
            pm.evaluate_auto_with_permission_mode_and_risk_and_path(PermissionEvaluationParams {
                session_id: "s",
                tool_name: "plugin_x_run",
                mode: "plan",
                permission_mode: "auto",
                session_grants: &no_grants(),
                declared_risk: None,
                requires_external_path_permission: false,
                plan_safe_actions: None,
            });
        assert_eq!(denied, Some(PermissionDecision::Deny));

        let empty: [String; 0] = [];
        let empty_denied =
            pm.evaluate_auto_with_permission_mode_and_risk_and_path(PermissionEvaluationParams {
                session_id: "s",
                tool_name: "plugin_x_run",
                mode: "goal",
                permission_mode: "auto",
                session_grants: &no_grants(),
                declared_risk: None,
                requires_external_path_permission: false,
                plan_safe_actions: Some(&empty),
            });
        assert_eq!(empty_denied, Some(PermissionDecision::Deny));

        let actions = ["navigate".to_string()];
        let admitted =
            pm.evaluate_auto_with_permission_mode_and_risk_and_path(PermissionEvaluationParams {
                session_id: "s",
                tool_name: "plugin_x_run",
                mode: "plan",
                permission_mode: "auto",
                session_grants: &no_grants(),
                declared_risk: None,
                requires_external_path_permission: false,
                plan_safe_actions: Some(&actions),
            });
        assert_eq!(admitted, Some(PermissionDecision::AllowOnce));
    }

    /// A read-only builtin keeps whatever permission behavior it already had.
    /// The contract mode neither grants it nor denies it, so the decision is
    /// identical to the one Agent mode reaches — including for the tools the
    /// risk classifier only rates medium, which still prompt under `ask`.
    #[test]
    fn contract_modes_leave_read_only_builtins_on_the_normal_path() {
        let pm = PermissionManager::default();
        for mode in ["ask", "accept-edits", "auto"] {
            for tool in ["Read", "Glob", "Grep", "BrowserPreview", "asktool"] {
                let in_agent =
                    pm.evaluate_auto_with_permission_mode("s", tool, "agent", mode, &no_grants());
                assert!(
                    in_agent != Some(PermissionDecision::Deny),
                    "fixture assumption: {tool} is not denied in Agent mode"
                );
                for contract in ["plan", "goal"] {
                    assert_eq!(
                        pm.evaluate_auto_with_permission_mode(
                            "s",
                            tool,
                            contract,
                            mode,
                            &no_grants()
                        ),
                        in_agent,
                        "{contract} + {mode} must not change {tool}'s normal decision"
                    );
                }
            }
        }
    }

    #[test]
    fn args_preview_truncates_long_strings() {
        let mut pm = PermissionManager::default();
        let content = "x".repeat(50_000);
        let args = serde_json::json!({ "path": "a.txt", "content": content });
        let (req, _rx) = pm.create_request("s", "tc1", "Write", args, "reason");
        let preview = req.args_preview.get("content").unwrap().as_str().unwrap();
        assert!(
            preview.chars().count() < 2_100,
            "content capped: {}",
            preview.len()
        );
        assert!(preview.ends_with("… (+48000 chars)"));
        assert_eq!(
            req.args_preview.get("path").unwrap().as_str().unwrap(),
            "a.txt"
        );
    }
}

#[cfg(test)]
mod image_generation_tests {
    use super::*;

    #[test]
    fn image_generation_requires_approval_and_is_not_plan_safe() {
        assert!(matches!(
            PermissionManager::tool_risk_with_declared("GenerateImages", None),
            Risk::High
        ));
        let manager = PermissionManager::default();
        let grants = HashMap::new();
        for mode in ["ask", "accept-edits"] {
            assert!(manager
                .evaluate_auto_with_permission_mode("s", "GenerateImages", "agent", mode, &grants)
                .is_none());
        }
        assert_eq!(
            manager.evaluate_auto_with_permission_mode(
                "s",
                "GenerateImages",
                "plan",
                "auto",
                &grants
            ),
            Some(PermissionDecision::Deny)
        );
        assert_eq!(
            manager.evaluate_auto_with_permission_mode(
                "s",
                "GenerateImages",
                "goal",
                "auto",
                &grants
            ),
            Some(PermissionDecision::Deny)
        );
    }
}
