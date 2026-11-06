//! Deterministic gates at the real blocking-pool boundary, keyed by workspace/path.
use super::*;
use std::collections::HashMap;
use std::future::{poll_fn, Future};
use std::sync::{Mutex as StdMutex, OnceLock};
use std::task::Poll;

struct Gate {
    entered: StdMutex<Option<tokio::sync::oneshot::Sender<()>>>,
    leave: StdMutex<std::sync::mpsc::Receiver<()>>,
}
type GateKey = (PathBuf, String);
static GATES: OnceLock<StdMutex<HashMap<GateKey, Arc<Gate>>>> = OnceLock::new();

pub(super) fn pause(root: Option<&Path>, path: Option<&str>) {
    let Some(gates) = GATES.get() else { return };
    let gate = gates
        .lock()
        .unwrap()
        .get(&(
            root.unwrap_or(Path::new("")).to_owned(),
            path.unwrap_or("").to_owned(),
        ))
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
        (dir.path().to_owned(), "alias".into()),
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
    GATES
        .get()
        .unwrap()
        .lock()
        .unwrap()
        .remove(&(dir.path().to_owned(), "alias".into()));
}

#[tokio::test]
async fn two_coordinated_blocking_writes_overlap_and_retain_cancelled_lease() {
    let dir = tempfile::tempdir().unwrap();
    let budget = crate::tool_budget::ToolBudget::new();
    let roots = ContainedRoots::new();
    let mut tickets = Vec::new();
    let mut pending = Vec::new();
    for (ordinal, path) in ["a", "b"].iter().enumerate() {
        std::fs::write(dir.path().join(path), "before").unwrap();
        let call = crate::file_batches::BatchCall {
            session_id: "s".into(),
            delegation_id: None,
            batch_id: "writes".into(),
            ordinal: ordinal as u32,
            tool_call_id: path.to_string(),
            tool_name: "Write".into(),
            args: json!({"path":path,"content":format!("after-{path}")}),
        };
        tickets.push((budget.register_file_call(call.clone()).unwrap(), call));
    }
    budget.seal_file_batch("writes", "s").unwrap();
    let mut executions = Vec::new();
    let mut entered = Vec::new();
    let mut releases = Vec::new();
    for (ticket, call) in &tickets {
        pending.push(
            budget
                .begin_file_call(ticket, "s", None, &call.tool_call_id, "Write", &call.args)
                .unwrap(),
        );
        let resources = crate::file_resources::FileResources::resolve(
            Some(dir.path()),
            &roots,
            "Write",
            &call.args,
            false,
        );
        let permit = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            budget.acquire_files("s", "Write", false, resources.clone(), Some(ticket.clone())),
        )
        .await
        .unwrap()
        .unwrap();
        let (tx, rx) = tokio::sync::oneshot::channel();
        let (leave, wait) = std::sync::mpsc::channel();
        GATES.get_or_init(Default::default).lock().unwrap().insert(
            (dir.path().to_owned(), call.tool_call_id.clone()),
            Arc::new(Gate {
                entered: StdMutex::new(Some(tx)),
                leave: StdMutex::new(wait),
            }),
        );
        entered.push(rx);
        releases.push(leave);
        executions.push(Box::pin(execute_tool_with_file_lease(
            Some(dir.path()),
            None,
            "Write",
            &call.args,
            ToolExecutionOptions {
                timeout_ms: None,
                bash_options: None,
                allow_external_paths: false,
                hashline: None,
                visualization_root: None,
            },
            Some(Arc::new(permit)),
            Some(resources),
        )));
    }
    for execution in &mut executions {
        poll_fn(|cx| {
            assert!(execution.as_mut().poll(cx).is_pending());
            Poll::Ready(())
        })
        .await;
    }
    for signal in entered {
        tokio::time::timeout(std::time::Duration::from_secs(5), signal)
            .await
            .unwrap()
            .unwrap();
    }
    assert_eq!(budget.snapshot().mutations, 2);
    // Both bodies entered before either was released. Dropping an outer future
    // tests execution ownership, not the user-facing Write Stop protocol.
    drop(executions.remove(0));
    let conflict = crate::file_resources::FileResources::resolve(
        Some(dir.path()),
        &roots,
        "Read",
        &json!({"path":"a"}),
        false,
    );
    let mut reader = Box::pin(budget.acquire_files("other", "Read", false, conflict, None));
    poll_fn(|cx| {
        assert!(reader.as_mut().poll(cx).is_pending());
        Poll::Ready(())
    })
    .await;
    releases[1].send(()).unwrap();
    assert!(executions.remove(0).await.ok);
    assert_eq!(budget.snapshot().mutations, 1);
    poll_fn(|cx| {
        assert!(reader.as_mut().poll(cx).is_pending());
        Poll::Ready(())
    })
    .await;
    releases[0].send(()).unwrap();
    drop(
        tokio::time::timeout(std::time::Duration::from_secs(5), reader)
            .await
            .unwrap()
            .unwrap(),
    );
    assert_eq!(
        std::fs::read_to_string(dir.path().join("a")).unwrap(),
        "after-a"
    );
    assert_eq!(
        std::fs::read_to_string(dir.path().join("b")).unwrap(),
        "after-b"
    );
    assert_eq!(budget.snapshot().active, 0);
    for path in ["a", "b"] {
        GATES
            .get()
            .unwrap()
            .lock()
            .unwrap()
            .remove(&(dir.path().to_owned(), path.into()));
    }
}
