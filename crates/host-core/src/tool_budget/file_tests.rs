use super::*;
use crate::file_batches::BatchCall;
use crate::workspace::ContainedRoots;
use serde_json::json;
use std::future::{poll_fn, Future};
use std::pin::Pin;
use std::task::Poll;

#[tokio::test]
async fn unready_successor_cannot_form_a_fairness_cycle_through_another_batch() {
    let budget = ToolBudget::new();
    let a = call(0, "Read", "a");
    let b = call(1, "Write", "a");
    let ta = budget.register_file_call(a.clone()).unwrap();
    let tb = budget.register_file_call(b.clone()).unwrap();
    budget.seal_file_batch("batch", "s").unwrap();
    let _later = budget
        .begin_file_call(&tb, "s", None, "1", "Write", &b.args)
        .unwrap();
    let mut later =
        Box::pin(budget.acquire_files("s", "Write", false, FileResources::fence(true), Some(tb)));
    pending(later.as_mut()).await;
    let external = budget
        .acquire_files("external", "Write", false, FileResources::fence(true), None)
        .await
        .unwrap();
    let _first = budget
        .begin_file_call(&ta, "s", None, "0", "Read", &a.args)
        .unwrap();
    let mut first =
        Box::pin(budget.acquire_files("s", "Read", false, FileResources::fence(false), Some(ta)));
    pending(first.as_mut()).await;
    drop(external);
    drop(first.await.unwrap());
    drop(later.await.unwrap());
    budget.close_file_batch("batch", "s").unwrap();
    assert_eq!(budget.snapshot().active, 0);
}

async fn pending<T>(future: Pin<&mut impl Future<Output = T>>) {
    let mut future = future;
    poll_fn(|cx| {
        assert!(
            future.as_mut().poll(cx).is_pending(),
            "request overtook its resource/source-order predecessor"
        );
        Poll::Ready(())
    })
    .await;
}

fn call(index: u32, name: &str, path: &str) -> BatchCall {
    BatchCall {
        session_id: "s".into(),
        delegation_id: None,
        batch_id: "batch".into(),
        ordinal: index,
        tool_call_id: index.to_string(),
        tool_name: name.into(),
        args: json!({"path":path}),
    }
}

#[tokio::test]
async fn hard_link_source_order_survives_reversed_rpc_arrival_in_both_directions() {
    for write_first in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("actual"), "before").unwrap();
        std::fs::hard_link(dir.path().join("actual"), dir.path().join("alias")).unwrap();
        let budget = ToolBudget::new();
        let first = call(0, if write_first { "Write" } else { "Read" }, "alias");
        let second = call(1, if write_first { "Read" } else { "Write" }, "actual");
        let a = budget.register_file_call(first.clone()).unwrap();
        let b = budget.register_file_call(second.clone()).unwrap();
        budget.seal_file_batch("batch", "s").unwrap();
        let _second = budget
            .begin_file_call(&b, "s", None, "1", &second.tool_name, &second.args)
            .unwrap();
        let claims_b = FileResources::resolve(
            Some(dir.path()),
            &ContainedRoots::new(),
            &second.tool_name,
            &second.args,
            false,
        );
        let mut later =
            Box::pin(budget.acquire_files("s", &second.tool_name, false, claims_b, Some(b)));
        pending(later.as_mut()).await;
        assert_eq!(
            budget.snapshot().active,
            0,
            "waiting for an unknown predecessor must not occupy capacity"
        );
        let _first = budget
            .begin_file_call(&a, "s", None, "0", &first.tool_name, &first.args)
            .unwrap();
        let claims_a = FileResources::resolve(
            Some(dir.path()),
            &ContainedRoots::new(),
            &first.tool_name,
            &first.args,
            false,
        );
        let earlier = budget
            .acquire_files("s", &first.tool_name, false, claims_a, Some(a))
            .await
            .unwrap();
        pending(later.as_mut()).await;
        drop(earlier);
        let later = later.await.unwrap();
        drop(later);
        budget.close_file_batch("batch", "s").unwrap();
        assert_eq!(budget.snapshot().active, 0);
        assert_eq!(budget.snapshot().queued, 0);
    }
}

#[tokio::test]
async fn denied_predecessor_releases_later_call_without_consuming_capacity() {
    let budget = ToolBudget::new();
    let a = call(0, "Write", "a");
    let b = call(1, "Read", "b");
    let ta = budget.register_file_call(a.clone()).unwrap();
    let tb = budget.register_file_call(b.clone()).unwrap();
    budget.seal_file_batch("batch", "s").unwrap();
    let approval = budget
        .begin_file_call(&ta, "s", None, "0", "Write", &a.args)
        .unwrap();
    let _read = budget
        .begin_file_call(&tb, "s", None, "1", "Read", &b.args)
        .unwrap();
    let mut read =
        Box::pin(budget.acquire_files("s", "Read", false, FileResources::fence(false), Some(tb)));
    pending(read.as_mut()).await;
    assert_eq!(budget.snapshot().active, 0);
    drop(approval); // Permission denial before any identity lookup/admission.
    drop(read.await.unwrap());
    budget.close_file_batch("batch", "s").unwrap();
}

#[tokio::test]
async fn cross_session_aliases_conflict_but_independent_read_and_write_overlap() {
    let dir = tempfile::tempdir().unwrap();
    for name in ["a", "b"] {
        std::fs::write(dir.path().join(name), name).unwrap();
    }
    std::fs::hard_link(dir.path().join("a"), dir.path().join("alias")).unwrap();
    let resolve = |name, path| {
        FileResources::resolve(
            Some(dir.path()),
            &ContainedRoots::new(),
            name,
            &json!({"path":path}),
            false,
        )
    };
    let budget = ToolBudget::new();
    let read = budget
        .acquire_files("parent", "Read", false, resolve("Read", "alias"), None)
        .await
        .unwrap();
    let independent = budget
        .acquire_files("child", "Write", true, resolve("Write", "b"), None)
        .await
        .unwrap();
    let mut conflict = Box::pin(budget.acquire_files(
        "other-session",
        "Write",
        false,
        resolve("Write", "a"),
        None,
    ));
    pending(conflict.as_mut()).await;
    drop(independent);
    pending(conflict.as_mut()).await;
    drop(read);
    drop(conflict.await.unwrap());
    assert_eq!(budget.snapshot().active, 0);
}

#[tokio::test]
async fn cancelled_queue_entries_release_resources_and_do_not_starve_writers() {
    let budget = ToolBudget::new();
    let read = budget
        .acquire_files("r", "Read", false, FileResources::fence(false), None)
        .await
        .unwrap();
    let mut writer =
        Box::pin(budget.acquire_files("w", "Write", false, FileResources::fence(true), None));
    pending(writer.as_mut()).await;
    let mut later_read =
        Box::pin(budget.acquire_files("later", "Read", false, FileResources::fence(false), None));
    pending(later_read.as_mut()).await;
    drop(read);
    // Writer was granted before its waiter consumed the permit. Cancelling at
    // exactly this point must undo both capacity and its resource reservation.
    drop(writer);
    drop(later_read.await.unwrap());
    assert_eq!(budget.snapshot().active, 0);
    assert_eq!(budget.snapshot().queued, 0);
}
