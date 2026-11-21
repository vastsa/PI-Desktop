//! The environment's setup script: run once in a new worktree.
//!
//! It is the same Bash tool call the local worktree setup command makes
//! (`session_worktrees::lifecycle::run_setup`): the worktree as root, a
//! 30-minute limit, and a bounded tail of the output kept for the status row.
//! The script is owner-authored configuration and runs without a permission
//! prompt, as the local setup command does.

use std::path::Path;
use std::sync::Arc;

use serde_json::{json, Value};
use tokio::sync::{mpsc, watch};

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
    pub on_output: Option<Arc<dyn Fn(String) + Send + Sync>>,
}

const LIVE_LOG_TAIL_LIMIT: usize = 16 * 1024;
const LIVE_BUFFER_CAP: usize = 32 * 1024;

fn bounded_tail(text: &str, max_bytes: usize) -> &str {
    if text.len() <= max_bytes {
        return text;
    }
    let mut start = text.len() - max_bytes;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    &text[start..]
}

fn extract_output_chunk(raw: &str) -> Option<String> {
    let value: Value = serde_json::from_str(raw).ok()?;
    if value.get("method").and_then(|method| method.as_str()) != Some("tools.output") {
        return None;
    }
    value
        .get("params")
        .and_then(|params| params.get("chunk"))
        .and_then(|chunk| chunk.as_str())
        .map(str::to_string)
}

/// Run the script and return its status with the last 16 KiB of its output.
pub async fn run(run: SetupRun<'_>) -> (SetupStatus, String) {
    let (output_tx, drain) = match run.on_output {
        Some(cb) => {
            let (tx, mut rx) = mpsc::unbounded_channel::<String>();
            let task = async move {
                let mut buf = String::new();
                let mut omitted = false;
                while let Some(raw) = rx.recv().await {
                    let Some(chunk) = extract_output_chunk(&raw) else {
                        continue;
                    };
                    if chunk.is_empty() {
                        continue;
                    }
                    buf.push_str(&chunk);
                    if buf.len() > LIVE_BUFFER_CAP {
                        buf = bounded_tail(&buf, LIVE_LOG_TAIL_LIMIT).to_string();
                        omitted = true;
                    }
                    let tail = if omitted || buf.len() > LIVE_LOG_TAIL_LIMIT {
                        format!(
                            "[earlier output omitted]\n{}",
                            bounded_tail(&buf, LIVE_LOG_TAIL_LIMIT)
                        )
                    } else {
                        buf.clone()
                    };
                    cb(tail);
                }
            };
            (Some(tx), Some(task))
        }
        None => (None, None),
    };
    let args = json!({ "command": run.script });
    let exec = execute_tool_with_path_access(
        Some(run.root),
        None,
        "Bash",
        &args,
        ToolExecutionOptions {
            timeout_ms: Some(SETUP_TIMEOUT_MS),
            bash_options: Some(BashExecutionOptions {
                session_id: run.session_id.to_string(),
                tool_call_id: format!("workspace-git-setup-{}", run.short_id),
                command_shell_id: run.shell_id,
                timeout_ms: Some(SETUP_TIMEOUT_MS),
                cancellation: Some(run.cancellation),
                output_tx,
                extra_env: run.env,
                run_in_background: false,
                continuation_turn_id: None,
                app_state: None,
            }),
            allow_external_paths: false,
            hashline: None,
            visualization_root: None,
        },
    );
    let result = match drain {
        Some(drain) => {
            let (result, ()) = tokio::join!(exec, drain);
            result
        }
        None => exec.await,
    };
    let status = if result.ok {
        SetupStatus::Ok
    } else {
        SetupStatus::Failed
    };
    (status, setup_log(&result.content))
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;

    #[tokio::test]
    async fn run_streams_live_output_tail_via_callback() {
        let dir = tempfile::tempdir().unwrap();
        let (_cancel_tx, cancel_rx) = watch::channel(false);
        let updates: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = updates.clone();
        let (status, final_log) = run(SetupRun {
            root: dir.path(),
            script: "echo step-one; echo step-two",
            shell_id: crate::tools::shell::default_shell_id().to_string(),
            env: Vec::new(),
            session_id: "s-setup",
            short_id: "0123456789ab",
            cancellation: cancel_rx,
            on_output: Some(Arc::new(move |tail| {
                sink.lock().unwrap().push(tail);
            })),
        })
        .await;
        assert_eq!(status, SetupStatus::Ok);
        assert!(final_log.contains("step-one"));
        assert!(final_log.contains("step-two"));
        let captured = updates.lock().unwrap();
        assert!(!captured.is_empty(), "expected live setup output updates");
        let last = captured.last().unwrap();
        assert!(last.contains("step-one"), "{last}");
        assert!(last.contains("step-two"), "{last}");
        assert!(
            !last.contains("\"tools.output\""),
            "must unwrap JSON-RPC envelope: {last}"
        );
    }
}
