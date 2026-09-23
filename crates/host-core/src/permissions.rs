use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::{Duration, Instant};
use uuid::Uuid;

use crate::db::{ms_to_ts, now_ms};
pub mod grants;
pub mod permits;
mod requests;

pub const PERMISSION_TIMEOUT_MS: u64 = 120_000;
pub const REVIEW_TIMEOUT_MS: u64 = 20_000;

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
    pub timeout_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command_shell_id: Option<String>,
    pub review_state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope_label: Option<String>,
    pub permission_mode: String,
}

pub struct PermissionRequestParams<'a> {
    pub session_id: &'a str,
    pub tool_call_id: &'a str,
    pub tool_name: &'a str,
    pub args_preview: serde_json::Value,
    pub reason: &'a str,
    pub declared_risk: Option<&'a str>,
    pub command_shell_id: Option<&'a str>,
    pub review_state: &'a str,
    pub scope_label: Option<&'a str>,
    pub turn_id: Option<&'a str>,
    pub user_message_id: Option<&'a str>,
    pub permission_mode: &'a str,
    pub workspace_path: Option<&'a str>,
}

pub struct PermissionEvaluationParams<'a> {
    pub tool_name: &'a str,
    pub mode: &'a str,
    pub permission_mode: &'a str,
    pub declared_risk: Option<&'a str>,
    pub requires_external_path_permission: bool,
    pub plan_safe_actions: Option<&'a [String]>,
}

#[derive(Debug)]
struct Pending {
    created_at: Instant,
    /// Wall-clock twin of `created_at` for the `permissions.pending` read.
    created_at_ms: i64,
    /// Arrival order; two requests can share a millisecond.
    sequence: u64,
    session_id: String,
    tool_call_id: String,
    /// The request as it was emitted, already preview-bounded, so a client
    /// that attaches after the notification can render the same card.
    request: PermissionRequest,
    review_token: Option<String>,
    action_fingerprint: Option<String>,
    generation: PermissionGeneration,
    turn_id: Option<String>,
    user_message_id: Option<String>,
    workspace_path: Option<String>,
    actor_id: Option<String>,
    review_context_complete: bool,
    review_started_at: Option<Instant>,
    tx: Option<tokio::sync::oneshot::Sender<PermissionDecision>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PermissionGeneration {
    session: u64,
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
    pub expires_at: String,
    pub remaining_ms: u64,
}

#[derive(Default)]
pub struct PermissionManager {
    pending: HashMap<String, Pending>,
    next_sequence: u64,
    session_generations: HashMap<String, u64>,
}

impl PermissionManager {
    pub fn tool_risk_with_declared(tool_name: &str, declared: Option<&str>) -> Risk {
        match tool_name {
            "Read" | "Glob" | "Grep" | "ScheduledTaskList" | "Skill" | "BrowserPreview" => {
                Risk::Low
            }
            "Write" | "Edit" | "Bash" | "GenerateImages" => Risk::High,
            name if name.starts_with("plugin_") => match declared {
                Some("low") => Risk::Low,
                Some("high") => Risk::High,
                Some("medium") => Risk::Medium,
                // A missing or malformed manifest declaration is not a
                // low-risk grant. Medium preserves the normal approval path.
                _ => Risk::Medium,
            },
            name if name.starts_with("mcp_") => Risk::Medium,
            _ => Risk::Medium,
        }
    }

    /// The shared contract-mode allowlist. Plan and Goal expose the same
    /// read/inspect core plus Bash; only their submit tool differs, and that one
    /// is a sidecar-side tool that never reaches this gate. `new_context` is
    /// sidecar-side too, and listed so the two sides of the bridge agree.
    pub fn plan_mode_allows(tool_name: &str) -> bool {
        matches!(
            tool_name,
            "Read" | "Glob" | "Grep" | "Bash" | "BrowserPreview" | "new_context"
        )
    }

    /// Auto-decision with an effective permission mode (D115).
    ///
    /// `permission_mode` is the already-resolved effective mode — the
    /// caller collapses `inherit` against the global default before calling.
    /// The contract modes' hard deny for unavailable tools stays above every
    /// permission mode: `auto` cannot re-enable Write/Edit/plugins in Plan or
    /// Goal.
    #[cfg(test)]
    pub fn evaluate_auto_with_permission_mode(
        &self,
        _session_id: &str,
        tool_name: &str,
        mode: &str,
        permission_mode: &str,
    ) -> Option<PermissionDecision> {
        self.evaluate_auto_with_permission_mode_and_risk(PermissionEvaluationParams {
            tool_name,
            mode,
            permission_mode,
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
            tool_name,
            mode,
            permission_mode,
            declared_risk,
            requires_external_path_permission,
            plan_safe_actions,
        } = params;
        // The contract modes' tool allowlist is authoritative. This check
        // intentionally precedes low-risk classification, auto, grants, and
        // scratch paths, and covers Goal as well as Plan (D198).
        //
        // Plugin tools get a narrow carve-out: a plugin may declare a
        // non-empty `planSafeActions` list (ADR 0211). When the host verifies
        // that declaration, it admits the plugin tool in
        // contract modes and the plugin-runtime enforces the per-action
        // restriction at execute time. Without the list the plugin tool
        // stays Plan-denied, exactly as ADR 0052 / ADR 0053 require.
        if crate::sessions::is_contract_mode(mode) && !Self::plan_mode_allows(tool_name) {
            if tool_name.starts_with("plugin_") {
                if let Some(actions) = plan_safe_actions {
                    if !actions.is_empty() {
                        // Fall through; plugin-runtime will gate the
                        // actual action.
                    } else {
                        return Some(PermissionDecision::Deny);
                    }
                } else {
                    return Some(PermissionDecision::Deny);
                }
            } else {
                return Some(PermissionDecision::Deny);
            }
        }

        if requires_external_path_permission {
            if permission_mode == "auto" {
                return Some(PermissionDecision::AllowOnce);
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
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn review_request(
        pm: &mut PermissionManager,
        session_id: &str,
    ) -> (
        PermissionRequest,
        tokio::sync::oneshot::Receiver<PermissionDecision>,
    ) {
        let (request, receiver) = pm.create_request_with_risk_and_shell(PermissionRequestParams {
            session_id,
            tool_call_id: "call",
            tool_name: "Write",
            args_preview: serde_json::json!({"path": "a.txt"}),
            reason: "writes a file",
            declared_risk: None,
            command_shell_id: None,
            review_state: "awaiting_review",
            scope_label: Some("Write: a.txt"),
            turn_id: Some("turn"),
            user_message_id: Some("user"),
            permission_mode: "ask",
            workspace_path: None,
        });
        pm.bind_action(&request.request_id, "bound-action");
        (request, receiver)
    }

    #[test]
    fn executor_loss_falls_back_without_resetting_permission_deadline() {
        let mut pm = PermissionManager::default();
        let (request, mut receiver) = review_request(&mut pm, "session");
        let (token, _, fingerprint, _, _, _) = pm.claim_review(&request.request_id).unwrap();
        pm.set_review_context_complete(&request.request_id, &token, true);
        let before = pm.pending_requests(Some("session"))[0].expires_at.clone();
        assert_eq!(pm.fallback_reviews(), vec![request.request_id.clone()]);
        assert_eq!(pm.review_state(&request.request_id), Some("user"));
        assert_eq!(pm.pending_requests(Some("session"))[0].expires_at, before);
        assert!(pm
            .resolve_review(&request.request_id, &token, &fingerprint, "allow_once")
            .is_err());
        assert!(matches!(
            receiver.try_recv(),
            Err(tokio::sync::oneshot::error::TryRecvError::Empty)
        ));
        assert!(pm.fallback_reviews().is_empty());
    }

    #[test]
    fn review_requires_host_complete_context_and_one_matching_token() {
        let mut pm = PermissionManager::default();
        let (request, mut receiver) = review_request(&mut pm, "session");
        let (token, _, fingerprint, _, _, _) = pm.claim_review(&request.request_id).unwrap();
        assert_eq!(fingerprint, "bound-action");
        assert!(pm
            .resolve_review(&request.request_id, &token, "changed", "allow_once")
            .is_err());
        assert_eq!(
            pm.resolve_review(&request.request_id, &token, "bound-action", "allow_once")
                .unwrap(),
            "needs_user"
        );
        assert!(receiver.try_recv().is_err());
        assert_eq!(pm.review_state(&request.request_id), Some("user"));
        assert!(pm
            .resolve_review(&request.request_id, &token, "bound-action", "allow_once")
            .is_err());
        pm.resolve(&request.request_id, PermissionDecision::Deny)
            .unwrap();
        assert_eq!(receiver.try_recv().unwrap(), PermissionDecision::Deny);
    }

    #[test]
    fn takeover_timeout_and_session_invalidation_reject_late_review() {
        let mut pm = PermissionManager::default();
        let (first, mut first_receiver) = review_request(&mut pm, "first");
        let (second, mut second_receiver) = review_request(&mut pm, "second");
        let (first_token, _, _, _, _, _) = pm.claim_review(&first.request_id).unwrap();
        pm.set_review_context_complete(&first.request_id, &first_token, true);
        pm.invalidate_session("first");
        assert_eq!(first_receiver.try_recv().unwrap(), PermissionDecision::Deny);
        assert!(pm
            .resolve_review(
                &first.request_id,
                &first_token,
                "bound-action",
                "allow_once"
            )
            .is_err());
        let (second_token, _, _, _, _, _) = pm.claim_review(&second.request_id).unwrap();
        pm.set_review_context_complete(&second.request_id, &second_token, true);
        pm.pending
            .get_mut(&second.request_id)
            .unwrap()
            .review_started_at =
            Some(Instant::now() - Duration::from_millis(REVIEW_TIMEOUT_MS + 1));
        assert_eq!(
            pm.resolve_review(
                &second.request_id,
                &second_token,
                "bound-action",
                "allow_once"
            )
            .unwrap(),
            "needs_user"
        );
        assert!(second_receiver.try_recv().is_err());
        let third = review_request(&mut pm, "second").0;
        let (third_token, _, _, _, _, _) = pm.claim_review(&third.request_id).unwrap();
        pm.takeover_review(&third.request_id).unwrap();
        assert!(pm
            .resolve_review(
                &third.request_id,
                &third_token,
                "bound-action",
                "allow_once"
            )
            .is_err());
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
        assert!(all[0].remaining_ms <= PERMISSION_TIMEOUT_MS);
        assert!(all[0].expires_at > all[0].created_at);
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
    fn ask_mode_prompts_for_high_risk() {
        let pm = PermissionManager::default();
        for tool in ["Write", "Edit", "Bash"] {
            let d = pm.evaluate_auto_with_permission_mode("s", tool, "agent", "ask");
            assert!(d.is_none(), "{tool} should prompt under ask");
        }
    }

    #[test]
    fn accept_edits_allows_file_tools_only() {
        let pm = PermissionManager::default();
        for tool in ["Write", "Edit"] {
            let d = pm.evaluate_auto_with_permission_mode("s", tool, "agent", "accept-edits");
            assert_eq!(d, Some(PermissionDecision::AllowOnce), "{tool}");
        }
        let bash = pm.evaluate_auto_with_permission_mode("s", "Bash", "agent", "accept-edits");
        assert!(bash.is_none(), "Bash still prompts under accept-edits");
    }

    #[test]
    fn auto_allows_all_high_risk_in_agent_mode() {
        let pm = PermissionManager::default();
        for tool in ["Write", "Edit", "Bash", "plugin_x_run"] {
            let d = pm.evaluate_auto_with_permission_mode("s", tool, "agent", "auto");
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

    #[test]
    fn plan_mode_denies_unavailable_tools_regardless_of_permission_mode() {
        let pm = PermissionManager::default();
        for mode in ["ask", "accept-edits", "auto"] {
            let d = pm.evaluate_auto_with_permission_mode("s", "Write", "plan", mode);
            assert_eq!(d, Some(PermissionDecision::Deny), "plan + {mode}");
        }
    }

    #[test]
    fn plan_bash_follows_permission_mode() {
        let pm = PermissionManager::default();
        assert_eq!(
            pm.evaluate_auto_with_permission_mode("s", "Bash", "plan", "ask"),
            None
        );
        assert_eq!(
            pm.evaluate_auto_with_permission_mode("s", "Bash", "plan", "auto"),
            Some(PermissionDecision::AllowOnce)
        );
    }

    #[test]
    fn plan_denial_wins_over_auto_and_scratch_exceptions() {
        let pm = PermissionManager::default();
        for tool in ["Write", "Edit", "plugin_x_run", "unknown"] {
            assert_eq!(
                pm.evaluate_auto_with_permission_mode("s", tool, "plan", "auto"),
                Some(PermissionDecision::Deny),
                "{tool} must be denied in plan"
            );
        }
    }

    #[test]
    fn goal_mode_shares_plans_hard_deny_and_bash_semantics() {
        let pm = PermissionManager::default();
        for tool in ["Write", "Edit", "plugin_x_run", "unknown"] {
            for mode in ["ask", "accept-edits", "auto"] {
                assert_eq!(
                    pm.evaluate_auto_with_permission_mode("s", tool, "goal", mode),
                    Some(PermissionDecision::Deny),
                    "{tool} must be denied in goal + {mode}"
                );
            }
        }
        assert_eq!(
            pm.evaluate_auto_with_permission_mode("s", "Bash", "goal", "ask"),
            None
        );
        assert_eq!(
            pm.evaluate_auto_with_permission_mode("s", "Bash", "goal", "auto"),
            Some(PermissionDecision::AllowOnce)
        );
    }

    #[test]
    fn low_risk_auto_allows_in_every_mode() {
        let pm = PermissionManager::default();
        for mode in ["ask", "accept-edits", "auto"] {
            let d = pm.evaluate_auto_with_permission_mode("s", "Read", "agent", mode);
            assert_eq!(d, Some(PermissionDecision::AllowOnce), "Read + {mode}");
        }
    }

    #[test]
    fn external_paths_prompt_for_low_risk_tools_outside_auto() {
        let pm = PermissionManager::default();
        for mode in ["ask", "accept-edits"] {
            let decision = pm.evaluate_auto_with_permission_mode_and_risk_and_path(
                PermissionEvaluationParams {
                    tool_name: "Read",
                    mode: "agent",
                    permission_mode: mode,
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
                tool_name: "Read",
                mode: "agent",
                permission_mode: "auto",
                declared_risk: None,
                requires_external_path_permission: true,
                plan_safe_actions: None,
            });
        assert_eq!(auto, Some(PermissionDecision::AllowOnce));
    }

    #[test]
    fn external_path_still_requires_approval_in_plan() {
        let pm = PermissionManager::default();
        let decision =
            pm.evaluate_auto_with_permission_mode_and_risk_and_path(PermissionEvaluationParams {
                tool_name: "Grep",
                mode: "plan",
                permission_mode: "ask",
                declared_risk: None,
                requires_external_path_permission: true,
                plan_safe_actions: None,
            });
        assert_eq!(decision, None);
    }

    #[test]
    fn mcp_calls_require_review_in_ask_and_accept_edits() {
        let pm = PermissionManager::default();
        for mode in ["ask", "accept-edits"] {
            let decision =
                pm.evaluate_auto_with_permission_mode("s", "mcp_server_delete", "agent", mode);
            assert_eq!(decision, None);
        }
        assert!(matches!(
            PermissionManager::tool_risk_with_declared("mcp_server_delete", Some("low")),
            Risk::Medium
        ));
    }

    #[test]
    fn contract_mode_admits_plugin_tools_only_with_plan_safe_actions() {
        let pm = PermissionManager::default();
        let denied =
            pm.evaluate_auto_with_permission_mode_and_risk_and_path(PermissionEvaluationParams {
                tool_name: "plugin_x_run",
                mode: "plan",
                permission_mode: "auto",
                declared_risk: None,
                requires_external_path_permission: false,
                plan_safe_actions: None,
            });
        assert_eq!(denied, Some(PermissionDecision::Deny));

        let empty: [String; 0] = [];
        let empty_denied =
            pm.evaluate_auto_with_permission_mode_and_risk_and_path(PermissionEvaluationParams {
                tool_name: "plugin_x_run",
                mode: "goal",
                permission_mode: "auto",
                declared_risk: None,
                requires_external_path_permission: false,
                plan_safe_actions: Some(&empty),
            });
        assert_eq!(empty_denied, Some(PermissionDecision::Deny));

        let actions = ["navigate".to_string()];
        let admitted =
            pm.evaluate_auto_with_permission_mode_and_risk_and_path(PermissionEvaluationParams {
                tool_name: "plugin_x_run",
                mode: "plan",
                permission_mode: "auto",
                declared_risk: None,
                requires_external_path_permission: false,
                plan_safe_actions: Some(&actions),
            });
        assert_eq!(admitted, Some(PermissionDecision::AllowOnce));
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
        for mode in ["ask", "accept-edits"] {
            assert!(manager
                .evaluate_auto_with_permission_mode("s", "GenerateImages", "agent", mode)
                .is_none());
        }
        assert_eq!(
            manager.evaluate_auto_with_permission_mode("s", "GenerateImages", "plan", "auto"),
            Some(PermissionDecision::Deny)
        );
        assert_eq!(
            manager.evaluate_auto_with_permission_mode("s", "GenerateImages", "goal", "auto"),
            Some(PermissionDecision::Deny)
        );
    }
}
