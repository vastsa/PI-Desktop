//! Publish and observe foreground Bash commands that outlive their initial wait.

use std::time::Instant;
use tokio::sync::{watch, Mutex};

use super::{
    bump_change_counter, jobs, register_task, BackgroundTask, BackgroundTaskState,
    MAX_RUNNING_TASKS_PER_SESSION, MAX_RUNNING_TASKS_TOTAL, RING_MAX_BYTES,
};

/// Publish an already-executing command only while its session still owns it.
pub(crate) async fn register_yielded_task(
    state: &Mutex<crate::state::AppState>,
    session_id: &str,
    command: &str,
    shell_id: &str,
    started_at: Instant,
    cancellation: Option<&watch::Receiver<bool>>,
    initial_output: [(String, bool); 2],
) -> Result<Option<(BackgroundTask, watch::Receiver<bool>, serde_json::Value)>, String> {
    let mut st = state.lock().await;
    if st.shutting_down
        || cancellation.is_some_and(|receiver| *receiver.borrow())
        || crate::sessions::tool_policy(&st.db, session_id).map_err(|err| err.to_string())?
            != Some(crate::sessions::ToolPolicy::Agent)
        || st.background_tasks.running_count_for(session_id) >= MAX_RUNNING_TASKS_PER_SESSION
        || st.background_tasks.running_count() >= MAX_RUNNING_TASKS_TOTAL
    {
        return Ok(None);
    }
    let (task, stop_rx) = register_task(
        &mut st.background_tasks,
        session_id,
        command,
        shell_id,
        started_at,
    );
    // While holding the registry lock, the newly created task cell is private.
    // Seed and snapshot it before publishing the registration to other callers.
    let [(stdout, out_truncated), (stderr, err_truncated)] = initial_output;
    task.append_yielded_output(true, &stdout, out_truncated)
        .await;
    task.append_yielded_output(false, &stderr, err_truncated)
        .await;
    let snapshot = jobs::snapshot(&task, true).await;
    bump_change_counter();
    Ok(Some((task, stop_rx, snapshot)))
}

impl BackgroundTask {
    pub(crate) async fn append_yielded_output(&self, is_stdout: bool, text: &str, truncated: bool) {
        if text.is_empty() && !truncated {
            return;
        }
        let mut shared = self.shared.lock().await;
        let mut offset = text.len().saturating_sub(RING_MAX_BYTES);
        while !text.is_char_boundary(offset) {
            offset += 1;
        }
        let dropped = if is_stdout {
            shared.push_stdout(&text[offset..])
        } else {
            shared.push_stderr(&text[offset..])
        };
        shared.truncated |= truncated || dropped || offset > 0;
    }

    pub(crate) async fn finish_yielded(
        &self,
        state: BackgroundTaskState,
        exit_code: Option<i32>,
        error: Option<&str>,
    ) {
        if let Some(error) = error {
            self.append_yielded_output(false, &format!("\n{error}\n"), false)
                .await;
        }
        let mut shared = self.shared.lock().await;
        shared.state = state;
        shared.exit_code = exit_code;
        self.settled.send_replace(Some(self.started_at.elapsed()));
        bump_change_counter();
    }
}
