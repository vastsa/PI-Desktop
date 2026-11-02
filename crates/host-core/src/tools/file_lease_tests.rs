//! Deterministic gate at the real blocking-pool boundary, keyed by test workspace.
use super::*;
use std::collections::HashMap;
use std::future::{poll_fn, Future};
use std::sync::{Mutex as StdMutex, OnceLock};
use std::task::Poll;

struct Gate {
    entered: StdMutex<Option<tokio::sync::oneshot::Sender<()>>>,
    leave: StdMutex<std::sync::mpsc::Receiver<()>>,
}
static GATES: OnceLock<StdMutex<HashMap<PathBuf, Arc<Gate>>>> = OnceLock::new();

pub(super) fn pause(root: Option<&Path>) {
    let Some(gates) = GATES.get() else { return };
    let gate = gates
        .lock()
        .unwrap()
        .get(root.unwrap_or(Path::new("")))
        .cloned();
    if let Some(gate) = gate {
        if let Some(entered) = gate.entered.lock().unwrap().take() {
            let _ = entered.send(());
        }
        // The sender is test-owned: a panic drops it and unblocks the worker.
        let _ = gate.leave.lock().unwrap().recv();
    }
}

#[tokio::test]
async fn cancelling_transport_waiter_does_not_release_a_running_blocking_read_lease() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("actual"), "before").unwrap();
    std::fs::hard_link(dir.path().join("actual"), dir.path().join("alias")).unwrap();
    let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
    let (leave_tx, leave_rx) = std::sync::mpsc::channel();
    GATES.get_or_init(Default::default).lock().unwrap().insert(
        dir.path().to_owned(),
        Arc::new(Gate {
            entered: StdMutex::new(Some(entered_tx)),
            leave: StdMutex::new(leave_rx),
        }),
    );
    let budget = crate::tool_budget::ToolBudget::new();
    let roots = ContainedRoots::new();
    let args = json!({"path":"alias"});
    let resources = crate::file_resources::FileResources::resolve(
        Some(dir.path()),
        &roots,
        "Read",
        &args,
        false,
    );
    let permit = Arc::new(
        budget
            .acquire_files("s", "Read", false, resources.clone(), None)
            .await
            .unwrap(),
    );
    let mut execution = Box::pin(execute_tool_with_file_lease(
        Some(dir.path()),
        None,
        "Read",
        &args,
        ToolExecutionOptions {
            timeout_ms: None,
            bash_options: None,
            allow_external_paths: false,
            hashline: None,
            visualization_root: None,
        },
        Some(permit),
        Some(resources),
    ));
    poll_fn(|cx| {
        assert!(execution.as_mut().poll(cx).is_pending());
        Poll::Ready(())
    })
    .await;
    entered_rx.await.unwrap();
    drop(execution); // Equivalent to the RPC select cancelling its outer future.
    let write_resources = crate::file_resources::FileResources::resolve(
        Some(dir.path()),
        &roots,
        "Write",
        &json!({"path":"actual"}),
        false,
    );
    let mut write = Box::pin(budget.acquire_files("other", "Write", false, write_resources, None));
    poll_fn(|cx| {
        assert!(
            write.as_mut().poll(cx).is_pending(),
            "read lease was released before disk work ended"
        );
        Poll::Ready(())
    })
    .await;
    assert_eq!(budget.snapshot().active, 1);
    leave_tx.send(()).unwrap();
    drop(write.await.unwrap());
    assert_eq!(budget.snapshot().active, 0);
    GATES.get().unwrap().lock().unwrap().remove(dir.path());
}
