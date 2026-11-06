//! Tool membership is distinct from risk, approval and execution authority.

/// Host-selected tool membership, never a model-supplied permission grant.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToolPermissionPolicy {
    Agent,
    Contract,
}

impl ToolPermissionPolicy {
    /// Select only after Host execution-mode and Goal-binding validation.
    /// The execution remains Goal for its lifecycle and tool-specific guards.
    pub fn for_execution_mode(mode: &str) -> Self {
        if mode == "goal" {
            Self::Agent
        } else {
            Self::for_legacy_mode(mode)
        }
    }

    /// Preserve existing session semantics until an execution owner selects a policy.
    /// In particular, a legacy Goal remains subject to the contract hard deny.
    pub fn for_legacy_mode(mode: &str) -> Self {
        if crate::sessions::is_contract_mode(mode) {
            Self::Contract
        } else {
            Self::Agent
        }
    }

    pub fn contract_mode_allows(tool_name: &str) -> bool {
        matches!(
            tool_name,
            "Read" | "Glob" | "Grep" | "Bash" | "BrowserPreview" | "new_context"
        )
    }

    /// A plan-safe plugin still has its action restriction enforced at execution.
    pub fn allows_tool(self, tool_name: &str, plan_safe_actions: Option<&[String]>) -> bool {
        self == Self::Agent
            || Self::contract_mode_allows(tool_name)
            || (tool_name.starts_with("plugin_")
                && plan_safe_actions.is_some_and(|actions| !actions.is_empty()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::permissions::{PermissionDecision, PermissionEvaluationParams, PermissionManager};
    use std::collections::HashMap;

    #[test]
    fn legacy_goal_policy_stays_contract_before_autonomy_integration() {
        assert_eq!(
            ToolPermissionPolicy::for_legacy_mode("agent"),
            ToolPermissionPolicy::Agent
        );
        for mode in ["plan", "goal"] {
            assert_eq!(
                ToolPermissionPolicy::for_legacy_mode(mode),
                ToolPermissionPolicy::Contract
            );
        }
    }

    #[test]
    fn membership_matches_the_pre_split_contract_allowlist() {
        let empty = [];
        let actions = ["navigate".to_string()];
        for mode in ["agent", "plan", "goal", "legacy"] {
            for tool in [
                "Read",
                "Glob",
                "Grep",
                "Bash",
                "BrowserPreview",
                "new_context",
                "Write",
                "Edit",
                "TodoWrite",
                "Computer",
                "plugin_x_run",
                "mcp_srv_tool",
                "unknown",
            ] {
                for safe in [None, Some(empty.as_slice()), Some(actions.as_slice())] {
                    let expected = !crate::sessions::is_contract_mode(mode)
                        || matches!(
                            tool,
                            "Read" | "Glob" | "Grep" | "Bash" | "BrowserPreview" | "new_context"
                        )
                        || (tool.starts_with("plugin_")
                            && safe.is_some_and(|items| !items.is_empty()));
                    assert_eq!(
                        ToolPermissionPolicy::for_legacy_mode(mode).allows_tool(tool, safe),
                        expected,
                        "{mode}/{tool}/{safe:?}"
                    );
                }
            }
        }
    }

    #[test]
    fn agent_membership_is_not_approval_or_external_path_authority() {
        let manager = PermissionManager::default();
        let grants = HashMap::new();
        let evaluate = |tool, permission_mode, external| {
            manager.evaluate_auto_with_permission_mode_and_risk_and_path(
                PermissionEvaluationParams {
                    session_id: "session",
                    tool_name: tool,
                    tool_policy: ToolPermissionPolicy::Agent,
                    permission_mode,
                    session_grants: &grants,
                    declared_risk: None,
                    requires_external_path_permission: external,
                    plan_safe_actions: None,
                },
            )
        };
        assert_eq!(evaluate("Write", "ask", false), None);
        assert_eq!(evaluate("Read", "ask", true), None);
        assert_eq!(
            evaluate("Write", "accept-edits", false),
            Some(PermissionDecision::AllowOnce)
        );
        assert_eq!(evaluate("Bash", "accept-edits", false), None);
        assert_eq!(
            evaluate("Bash", "auto", false),
            Some(PermissionDecision::AllowOnce)
        );
    }
}

#[cfg(test)]
mod autonomous_tests {
    use super::*;

    #[test]
    fn execution_policy_preserves_the_original_goal_feature_membership() {
        let empty = [];
        let actions = ["navigate".to_string()];
        for mode in ["agent", "plan", "goal", "legacy"] {
            for tool in [
                "Read",
                "Glob",
                "Grep",
                "Bash",
                "BrowserPreview",
                "new_context",
                "Write",
                "Edit",
                "TodoWrite",
                "Computer",
                "plugin_x_run",
                "mcp_srv_tool",
                "unknown",
            ] {
                for safe in [None, Some(empty.as_slice()), Some(actions.as_slice())] {
                    let expected = mode != "plan"
                        || ToolPermissionPolicy::contract_mode_allows(tool)
                        || (tool.starts_with("plugin_")
                            && safe.is_some_and(|items| !items.is_empty()));
                    assert_eq!(
                        ToolPermissionPolicy::for_execution_mode(mode).allows_tool(tool, safe),
                        expected,
                        "{mode}/{tool}/{safe:?}"
                    );
                }
            }
        }
    }
}
