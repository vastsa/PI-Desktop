//! Bounded model observations of an already-authorized, session-owned process.
use super::*;
use std::time::Duration;

const MODEL_STREAM_BYTES: usize = 8 * 1024;
const MODEL_COMMAND_BYTES: usize = 1024;

pub(crate) fn find(
    registry: &BackgroundTaskRegistry,
    session_id: &str,
    id: &str,
) -> Option<BackgroundTask> {
    registry
        .tasks
        .get(id)
        .filter(|task| task.session_id == session_id)
        .cloned()
}

fn tail(text: String, limit: usize) -> (String, bool) {
    let mut start = text.len().saturating_sub(limit);
    while !text.is_char_boundary(start) {
        start += 1;
    }
    (text[start..].to_owned(), start > 0)
}

pub(crate) async fn snapshot(task: &BackgroundTask, output: bool) -> serde_json::Value {
    let shared = task.shared.lock().await;
    // List results must also have a budget; commands may contain large scripts.
    let command = &task.command[..task.command.floor_char_boundary(MODEL_COMMAND_BYTES)];
    let mut result = serde_json::json!({
        "job": { "kind": "bash", "id": task.id },
        "command": command,
        "commandTruncated": command.len() < task.command.len(),
        "state": shared.state,
        "exitCode": shared.exit_code,
        "elapsedMs": task.elapsed_ms(),
        "stopRequested": *task.stop.borrow(),
    });
    if output {
        let (stdout, stdout_cut) = tail(TaskShared::render(&shared.stdout), MODEL_STREAM_BYTES);
        let (stderr, stderr_cut) = tail(TaskShared::render(&shared.stderr), MODEL_STREAM_BYTES);
        result["stdout"] = stdout.into();
        result["stderr"] = stderr.into();
        result["truncated"] = (shared.truncated || stdout_cut || stderr_cut).into();
    }
    result
}

/// Each RPC waits at most one second. Abandoning a caller's wait never signals
/// the process, and leaves at most this bounded observer on the Host.
pub(crate) async fn wait(task: &BackgroundTask, timeout_ms: u64) {
    let mut settled = task.settled.subscribe();
    let _ = tokio::time::timeout(Duration::from_millis(timeout_ms), async {
        settled.wait_for(Option::is_some).await
    })
    .await;
}

pub(crate) async fn stop(task: &BackgroundTask) -> Result<bool, String> {
    let shared = task.shared.lock().await;
    if shared.state != BackgroundTaskState::Running || *task.stop.borrow() {
        return Ok(false);
    }
    task.stop
        .send(true)
        .map_err(|_| "background task supervisor unavailable".to_string())?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task() -> (BackgroundTask, watch::Receiver<bool>) {
        let (stop, receiver) = watch::channel(false);
        (
            BackgroundTask {
                id: "process".into(),
                session_id: "owner".into(),
                command: "fixture".into(),
                command_shell_id: "bash".into(),
                started_at: Instant::now(),
                shared: Arc::new(Mutex::new(TaskShared {
                    state: BackgroundTaskState::Running,
                    exit_code: None,
                    stdout: VecDeque::new(),
                    stderr: VecDeque::new(),
                    stdout_bytes: 0,
                    stderr_bytes: 0,
                    truncated: false,
                })),
                stop,
                settled: watch::channel(None).0,
            },
            receiver,
        )
    }

    #[test]
    fn tail_preserves_unicode_and_exact_budget() {
        assert_eq!(tail("ab中文".into(), 4), ("文".into(), true));
        assert_eq!(tail("中文".into(), 6), ("中文".into(), false));
    }

    #[tokio::test]
    async fn command_preview_uses_a_utf8_prefix_independently_of_output_truncation() {
        let (mut task, _receiver) = task();
        for (command, expected, cut) in [
            ("fixture".into(), "fixture".into(), false),
            ("x".repeat(1024), "x".repeat(1024), false),
            ("x".repeat(1025), "x".repeat(1024), true),
            (format!("{}中", "x".repeat(1023)), "x".repeat(1023), true),
        ] {
            task.command = command;
            for output in [false, true] {
                let observed = snapshot(&task, output).await;
                assert_eq!(observed["command"], expected);
                assert_eq!(observed["commandTruncated"], cut);
                if output {
                    assert_eq!(observed["truncated"], false);
                }
            }
        }
        task.command = "fixture".into();
        task.shared
            .lock()
            .await
            .push_stderr(&("x".repeat(8192) + "last error"));
        let observed = snapshot(&task, true).await;
        assert_eq!(observed["commandTruncated"], false);
        assert_eq!(observed["truncated"], true);
        assert!(observed["stderr"].as_str().unwrap().ends_with("last error"));
    }

    #[tokio::test]
    async fn completed_before_wait_is_immediate_and_output_is_repeatable() {
        let (task, _receiver) = task();
        {
            let mut shared = task.shared.lock().await;
            shared.state = BackgroundTaskState::Failed;
            shared.exit_code = Some(1);
            shared.push_stdout(&"中".repeat(10000));
            shared.push_stderr("final assertion error");
        }
        task.settled.send_replace(Some(task.started_at.elapsed()));
        tokio::time::timeout(Duration::from_millis(100), wait(&task, 1000))
            .await
            .unwrap();
        let first = snapshot(&task, true).await;
        let second = snapshot(&task, true).await;
        assert_eq!(first["stderr"], second["stderr"]);
        assert_eq!(first["exitCode"], 1);
        assert_eq!(first["truncated"], true);
        assert!(first["stdout"].as_str().unwrap().len() <= MODEL_STREAM_BYTES);
        assert!(!stop(&task).await.unwrap());
    }

    #[tokio::test]
    async fn waiting_does_not_stop_and_foreign_ids_are_not_resolved() {
        let (task, receiver) = task();
        let mut registry = BackgroundTaskRegistry::default();
        registry.tasks.insert(task.id.clone(), task.clone());
        assert!(find(&registry, "foreign", "process").is_none());
        assert!(find(&registry, "owner", "missing").is_none());
        assert!(find(&registry, "owner", "process").is_some());
        wait(&task, 0).await;
        assert!(!*receiver.borrow());
        assert!(stop(&task).await.unwrap());
        assert!(*receiver.borrow());
        assert!(!stop(&task).await.unwrap());
        let observed = snapshot(&task, true).await;
        assert_eq!(observed["state"], "running");
        assert_eq!(observed["stopRequested"], true);
    }
}
