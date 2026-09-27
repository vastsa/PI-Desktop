use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::{Duration, Instant};
use uuid::Uuid;

pub const PERMISSION_TIMEOUT_MS: u64 = 120_000;

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

#[derive(Debug)]
struct Pending {
    created_at: Instant,
    session_id: String,
    tool_call_id: String,
    tx: Option<tokio::sync::oneshot::Sender<PermissionDecision>>,
}

#[derive(Default)]
pub struct PermissionManager {
    pending: HashMap<String, Pending>,
}

impl PermissionManager {
    pub fn tool_risk_with_declared(tool_name: &str, declared: Option<&str>) -> Risk {
        match tool_name {
            "Read" | "Glob" | "Grep" => Risk::Low,
            "Write" | "Edit" | "Bash" => Risk::High,
            name if name.starts_with("plugin_") => match declared {
                Some("low") => Risk::Low,
                Some("high") => Risk::High,
                Some("medium") => Risk::Medium,
                // A missing or malformed manifest declaration is not a
                // low-risk grant. Medium preserves the normal approval path.
                _ => Risk::Medium,
            },
            name if name.starts_with("mcp_") => Risk::Low,
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
        session_id: &str,
        tool_name: &str,
        mode: &str,
        permission_mode: &str,
        session_grants: &HashMap<String, Vec<String>>,
    ) -> Option<PermissionDecision> {
        self.evaluate_auto_with_permission_mode_and_risk(
            session_id,
            tool_name,
            mode,
            permission_mode,
            session_grants,
            None,
        )
    }

    #[cfg(test)]
    pub fn evaluate_auto_with_permission_mode_and_risk(
        &self,
        session_id: &str,
        tool_name: &str,
        mode: &str,
        permission_mode: &str,
        session_grants: &HashMap<String, Vec<String>>,
        declared_risk: Option<&str>,
    ) -> Option<PermissionDecision> {
        self.evaluate_auto_with_permission_mode_and_risk_and_path(
            session_id,
            tool_name,
            mode,
            permission_mode,
            session_grants,
            declared_risk,
            false,
        )
    }

    /// Evaluate a tool that explicitly targets a path outside the session's
    /// workspace and scratch roots. Outside-path access is an exception to the
    /// normal low-risk auto-allow rule: `auto` allows it, while every other
    /// mode needs a card (unless the session already granted this tool).
    pub fn evaluate_auto_with_permission_mode_and_risk_and_path(
        &self,
        session_id: &str,
        tool_name: &str,
        mode: &str,
        permission_mode: &str,
        session_grants: &HashMap<String, Vec<String>>,
        declared_risk: Option<&str>,
        requires_external_path_permission: bool,
    ) -> Option<PermissionDecision> {
        // The contract modes' tool allowlist is authoritative. This check
        // intentionally precedes low-risk classification, auto, grants, and
        // scratch paths, and covers Goal as well as Plan (D198).
        if crate::sessions::is_contract_mode(mode) && !Self::plan_mode_allows(tool_name) {
            return Some(PermissionDecision::Deny);
        }

        if requires_external_path_permission {
            if permission_mode == "auto" {
                return Some(PermissionDecision::AllowOnce);
            }
            if session_grants
                .get(session_id)
                .map(|g| g.iter().any(|t| t == tool_name))
                .unwrap_or(false)
            {
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
        if session_grants
            .get(session_id)
            .map(|g| g.iter().any(|t| t == tool_name))
            .unwrap_or(false)
        {
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
            timeout_ms: PERMISSION_TIMEOUT_MS,
            command_shell_id: command_shell_id.map(str::to_string),
        };
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.pending.insert(
            request_id,
            Pending {
                created_at: Instant::now(),
                session_id: session_id.to_string(),
                tool_call_id: tool_call_id.to_string(),
                tx: Some(tx),
            },
        );
        (request, rx)
    }

    pub fn resolve(
        &mut self,
        request_id: &str,
        decision: PermissionDecision,
    ) -> Result<(), String> {
        let Some(mut pending) = self.pending.remove(request_id) else {
            return Err("NOT_FOUND".into());
        };
        if pending.created_at.elapsed() > Duration::from_millis(PERMISSION_TIMEOUT_MS) {
            let _ = pending
                .tx
                .take()
                .map(|tx| tx.send(PermissionDecision::Deny));
            return Err("PERMISSION_TIMEOUT".into());
        }
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

    pub fn expire_stale(&mut self) {
        let timeout = Duration::from_millis(PERMISSION_TIMEOUT_MS);
        let stale: Vec<String> = self
            .pending
            .iter()
            .filter(|(_, p)| p.created_at.elapsed() > timeout)
            .map(|(k, _)| k.clone())
            .collect();
        for id in stale {
            if let Some(mut p) = self.pending.remove(&id) {
                if let Some(tx) = p.tx.take() {
                    let _ = tx.send(PermissionDecision::Deny);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn no_grants() -> HashMap<String, Vec<String>> {
        HashMap::new()
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

    #[test]
    fn plan_mode_denies_unavailable_tools_regardless_of_permission_mode() {
        let pm = PermissionManager::default();
        for mode in ["ask", "accept-edits", "auto"] {
            let d = pm.evaluate_auto_with_permission_mode("s", "Write", "plan", mode, &no_grants());
            assert_eq!(d, Some(PermissionDecision::Deny), "plan + {mode}");
        }
    }

    #[test]
    fn plan_bash_follows_permission_mode() {
        let pm = PermissionManager::default();
        assert_eq!(
            pm.evaluate_auto_with_permission_mode("s", "Bash", "plan", "ask", &no_grants()),
            None
        );
        assert_eq!(
            pm.evaluate_auto_with_permission_mode("s", "Bash", "plan", "auto", &no_grants()),
            Some(PermissionDecision::AllowOnce)
        );
    }

    #[test]
    fn plan_denial_wins_over_grants_and_scratch_exceptions() {
        let pm = PermissionManager::default();
        let mut grants = HashMap::new();
        grants.insert(
            "s".to_string(),
            vec!["Write".to_string(), "plugin_x_run".to_string()],
        );
        for tool in ["Write", "Edit", "plugin_x_run", "unknown"] {
            assert_eq!(
                pm.evaluate_auto_with_permission_mode("s", tool, "plan", "auto", &grants),
                Some(PermissionDecision::Deny),
                "{tool} must be denied in plan"
            );
        }
    }

    #[test]
    fn goal_mode_shares_plans_hard_deny_and_bash_semantics() {
        let pm = PermissionManager::default();
        let mut grants = HashMap::new();
        grants.insert(
            "s".to_string(),
            vec!["Write".to_string(), "plugin_x_run".to_string()],
        );
        for tool in ["Write", "Edit", "plugin_x_run", "unknown"] {
            for mode in ["ask", "accept-edits", "auto"] {
                assert_eq!(
                    pm.evaluate_auto_with_permission_mode("s", tool, "goal", mode, &grants),
                    Some(PermissionDecision::Deny),
                    "{tool} must be denied in goal + {mode}"
                );
            }
        }
        assert_eq!(
            pm.evaluate_auto_with_permission_mode("s", "Bash", "goal", "ask", &no_grants()),
            None
        );
        assert_eq!(
            pm.evaluate_auto_with_permission_mode("s", "Bash", "goal", "auto", &no_grants()),
            Some(PermissionDecision::AllowOnce)
        );
    }

    #[test]
    fn low_risk_auto_allows_in_every_mode() {
        let pm = PermissionManager::default();
        for mode in ["ask", "accept-edits", "auto"] {
            let d = pm.evaluate_auto_with_permission_mode("s", "Read", "agent", mode, &no_grants());
            assert_eq!(d, Some(PermissionDecision::AllowOnce), "Read + {mode}");
        }
    }

    #[test]
    fn external_paths_prompt_for_low_risk_tools_outside_auto() {
        let pm = PermissionManager::default();
        for mode in ["ask", "accept-edits"] {
            let decision = pm.evaluate_auto_with_permission_mode_and_risk_and_path(
                "s",
                "Read",
                "agent",
                mode,
                &no_grants(),
                None,
                true,
            );
            assert_eq!(
                decision, None,
                "Read outside workspace must prompt in {mode}"
            );
        }
        let auto = pm.evaluate_auto_with_permission_mode_and_risk_and_path(
            "s",
            "Read",
            "agent",
            "auto",
            &no_grants(),
            None,
            true,
        );
        assert_eq!(auto, Some(PermissionDecision::AllowOnce));
    }

    #[test]
    fn external_path_session_grant_still_applies() {
        let pm = PermissionManager::default();
        let mut grants = HashMap::new();
        grants.insert("s".to_string(), vec!["Grep".to_string()]);
        let decision = pm.evaluate_auto_with_permission_mode_and_risk_and_path(
            "s", "Grep", "plan", "ask", &grants, None, true,
        );
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
