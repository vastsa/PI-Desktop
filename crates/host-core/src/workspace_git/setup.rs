//! The environment's setup script: run once in a new worktree.
//!
//! It is the same Bash tool call the local worktree setup command makes
//! (`session_worktrees::lifecycle::run_setup`): the worktree as root, a
//! 30-minute limit, and a bounded tail of the output kept for the status row.
//! The script is owner-authored configuration and runs without a permission
//! prompt, as the local setup command does.

use std::path::Path;

use serde_json::json;
use tokio::sync::watch;

use super::registry::SetupStatus;
use crate::session_worktrees::lifecycle::{setup_log, SETUP_TIMEOUT_MS};
use crate::tools::{execute_tool_with_path_access, BashExecutionOptions, ToolExecutionOptions};

/// What identifies one setup run to the Bash tool.
pub struct SetupRun<'a> {
    pub root: &'a Path,
    pub script: &'a str,
    pub shell_id: String,
    /// The worktree's tool environment (`environment::for_tool`).
    pub env: Vec<(String, String)>,
    pub session_id: &'a str,
    /// The worktree's short id; names the tool call.
    pub short_id: &'a str,
    pub cancellation: watch::Receiver<bool>,
}

/// Run the script and return its status with the last 16 KiB of its output.
pub async fn run(run: SetupRun<'_>) -> (SetupStatus, String) {
    let result = execute_tool_with_path_access(
        Some(run.root),
        None,
        "Bash",
        &json!({ "command": run.script }),
        ToolExecutionOptions {
            timeout_ms: Some(SETUP_TIMEOUT_MS),
            bash_options: Some(BashExecutionOptions {
                session_id: run.session_id.to_string(),
                tool_call_id: format!("workspace-git-setup-{}", run.short_id),
                command_shell_id: run.shell_id,
                timeout_ms: Some(SETUP_TIMEOUT_MS),
                cancellation: Some(run.cancellation),
                output_tx: None,
                extra_env: run.env,
                run_in_background: false,
                continuation_turn_id: None,
                app_state: None,
            }),
            allow_external_paths: false,
            hashline: None,
            visualization_root: None,
        },
    )
    .await;
    let status = if result.ok {
        SetupStatus::Ok
    } else {
        SetupStatus::Failed
    };
    (status, setup_log(&result.content))
}
