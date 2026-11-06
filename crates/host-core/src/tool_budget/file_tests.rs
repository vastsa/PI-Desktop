use super::*;
use crate::file_batches::BatchCall;
use crate::workspace::ContainedRoots;
use serde_json::json;
use std::future::{poll_fn, Future};
use std::pin::Pin;
use std::task::Poll;

fn coordinated_write(
    budget: &ToolBudget,
    root: &std::path::Path,
    index: u32,
) -> (PendingFileCall, Arc<FileResources>, String) {
    let path = format!("file-{index}");
    std::fs::write(root.join(&path), "before").unwrap();
    let mut c = call(index, "Write", &path);
    c.batch_id = format!("batch-{index}");
    let ticket = budget.register_file_call(c.clone()).unwrap();
    budget.seal_file_batch(&c.batch_id, "s").unwrap();
    let pending = budget
        .begin_file_call(&ticket, "s", None, &c.tool_call_id, "Write", &c.args)
        .unwrap();
    let resources =
        FileResources::resolve(Some(root), &ContainedRoots::new(), "Write", &c.args, false);
    (pending, resources, ticket)
}

#[tokio::test]
async fn independent_coordinated_writes_share_session_capacity() {
    let dir = tempfile::tempdir().unwrap();
    let budget = ToolBudget::new();
    let (_a, ra, ta) = coordinated_write(&budget, dir.path(), 0);
    let (_b, rb, tb) = coordinated_write(&budget, dir.path(), 1);
    let first = budget
        .acquire_files("s", "Write", false, ra, Some(ta))
        .await
        .unwrap();
    let mut second = Box::pin(budget.acquire_files("s", "Write", false, rb, Some(tb)));
    let second = poll_fn(|cx| match second.as_mut().poll(cx) {
        Poll::Ready(result) => Poll::Ready(result.unwrap()),
        Poll::Pending => panic!("independent coordinated write blocked by session capacity"),
    })
    .await;
    assert_eq!(budget.snapshot().mutations, 2);
    drop((first, second));
    assert_eq!(budget.snapshot().active, 0);
}

async fn ready<T>(future: Pin<&mut impl Future<Output = T>>) -> T {
    let mut future = future;
    poll_fn(|cx| match future.as_mut().poll(cx) {
        Poll::Ready(value) => Poll::Ready(value),
        Poll::Pending => panic!("eligible request did not acquire available capacity"),
    })
    .await
}

#[tokio::test]
async fn conservative_waiter_drains_coordinated_writes_before_refilling() {
    for legacy in [true, false] {
        let dir = tempfile::tempdir().unwrap();
        let budget = ToolBudget::new();
        let (_a, ra, ta) = coordinated_write(&budget, dir.path(), 0);
        let (_b, rb, tb) = coordinated_write(&budget, dir.path(), 1);
        let (_c, rc, tc) = coordinated_write(&budget, dir.path(), 2);
        let (_l, rl, _) = coordinated_write(&budget, dir.path(), 3);
        let a = budget
            .acquire_files("s", "Write", false, ra, Some(ta))
            .await
            .unwrap();
        let b = ready(Box::pin(budget.acquire_files("s", "Write", false, rb, Some(tb))).as_mut())
            .await
            .unwrap();
        let mut conservative = Box::pin(async {
            if legacy {
                budget.acquire("s", "Write").await
            } else {
                budget.acquire_files("s", "Write", false, rl, None).await
            }
        });
        pending(conservative.as_mut()).await;
        drop(a);
        let mut later = Box::pin(budget.acquire_files("s", "Write", false, rc, Some(tc)));
        pending(later.as_mut()).await; // immediate admission must respect the waiter
        drop(b); // dispatch must grant L, not C
        let l = ready(conservative.as_mut()).await.unwrap();
        pending(later.as_mut()).await;
        drop(l);
        drop(ready(later.as_mut()).await.unwrap());
        assert_eq!(budget.snapshot().active, 0);
        assert_eq!(budget.snapshot().queued, 0);
    }
}

#[tokio::test]
async fn conservative_active_write_blocks_coordinated_write_and_cancel_cleans_up() {
    let dir = tempfile::tempdir().unwrap();
    let budget = ToolBudget::new();
    let (_a, ra, ta) = coordinated_write(&budget, dir.path(), 0);
    let legacy = budget.acquire("s", "Write").await.unwrap();
    let mut waiting = Box::pin(budget.acquire_files("s", "Write", false, ra, Some(ta)));
    pending(waiting.as_mut()).await;
    drop(legacy); // reserves the coordinated permit before its waiter claims it
    assert_eq!(budget.snapshot().mutations, 1);
    drop(waiting);
    assert_eq!(budget.snapshot().active, 0);
    drop(budget.acquire("s", "Write").await.unwrap());
}

#[tokio::test]
async fn cancelling_conservative_waiter_restores_second_slot_immediately() {
    let dir = tempfile::tempdir().unwrap();
    let budget = ToolBudget::new();
    let (_a, ra, ta) = coordinated_write(&budget, dir.path(), 0);
    let (_b, rb, tb) = coordinated_write(&budget, dir.path(), 1);
    let a = budget
        .acquire_files("s", "Write", false, ra, Some(ta))
        .await
        .unwrap();
    let mut legacy = Box::pin(budget.acquire("s", "Write"));
    pending(legacy.as_mut()).await;
    let mut b = Box::pin(budget.acquire_files("s", "Write", false, rb, Some(tb)));
    pending(b.as_mut()).await;
    drop(legacy);
    let b = ready(b.as_mut()).await.unwrap();
    assert_eq!(budget.snapshot().mutations, 2);
    drop((a, b));
    assert_eq!(budget.snapshot().active, 0);
}

#[tokio::test]
async fn coordinated_writes_preserve_global_limit_and_close_does_not_release_them() {
    let dir = tempfile::tempdir().unwrap();
    let budget = ToolBudget::new();
    let (_a, ra, ta) = coordinated_write(&budget, dir.path(), 0);
    let (_b, rb, tb) = coordinated_write(&budget, dir.path(), 1);
    let a = budget
        .acquire_files("s", "Write", false, ra, Some(ta))
        .await
        .unwrap();
    let b = ready(Box::pin(budget.acquire_files("s", "Write", false, rb, Some(tb))).as_mut())
        .await
        .unwrap();
    budget.close_file_batch("batch-0", "s").unwrap();
    budget.close_file_batch("batch-1", "s").unwrap();
    let mut other = Box::pin(budget.acquire("other", "Write"));
    pending(other.as_mut()).await;
    drop(a);
    drop(ready(other.as_mut()).await.unwrap());
    drop(b);
    assert_eq!(budget.snapshot().active, 0);
    drop(budget.acquire("s", "Write").await.unwrap());
}

#[tokio::test]
async fn unready_conservative_successor_does_not_block_its_predecessor() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("a"), "before").unwrap();
    let budget = ToolBudget::new();
    let a = call(0, "Write", "a");
    let b = call(1, "Write", "missing");
    let ta = budget.register_file_call(a.clone()).unwrap();
    let tb = budget.register_file_call(b.clone()).unwrap();
    budget.seal_file_batch("batch", "s").unwrap();
    let _pb = budget
        .begin_file_call(&tb, "s", None, "1", "Write", &b.args)
        .unwrap();
    let mut later =
        Box::pin(budget.acquire_files("s", "Write", false, FileResources::fence(true), Some(tb)));
    pending(later.as_mut()).await;
    let _pa = budget
        .begin_file_call(&ta, "s", None, "0", "Write", &a.args)
        .unwrap();
    let ra = FileResources::resolve(
        Some(dir.path()),
        &ContainedRoots::new(),
        "Write",
        &a.args,
        false,
    );
    let a = ready(Box::pin(budget.acquire_files("s", "Write", false, ra, Some(ta))).as_mut())
        .await
        .unwrap();
    pending(later.as_mut()).await;
    drop(a);
    drop(ready(later.as_mut()).await.unwrap());
}

#[tokio::test]
async fn coordinated_alias_writes_preserve_source_order_in_reversed_arrival() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("a"), "before").unwrap();
    std::fs::hard_link(dir.path().join("a"), dir.path().join("alias")).unwrap();
    for names in [["Write", "Write"], ["Edit", "Write"], ["Write", "Edit"]] {
        let budget = ToolBudget::new();
        let a = call(0, names[0], "a");
        let b = call(1, names[1], "alias");
        let ta = budget.register_file_call(a.clone()).unwrap();
        let tb = budget.register_file_call(b.clone()).unwrap();
        budget.seal_file_batch("batch", "s").unwrap();
        let _pb = budget
            .begin_file_call(&tb, "s", None, "1", names[1], &b.args)
            .unwrap();
        let rb = FileResources::resolve(
            Some(dir.path()),
            &ContainedRoots::new(),
            names[1],
            &b.args,
            false,
        );
        let mut later = Box::pin(budget.acquire_files("s", names[1], false, rb, Some(tb)));
        pending(later.as_mut()).await;
        let _pa = budget
            .begin_file_call(&ta, "s", None, "0", names[0], &a.args)
            .unwrap();
        let ra = FileResources::resolve(
            Some(dir.path()),
            &ContainedRoots::new(),
            names[0],
            &a.args,
            false,
        );
        let first =
            ready(Box::pin(budget.acquire_files("s", names[0], false, ra, Some(ta))).as_mut())
                .await
                .unwrap();
        pending(later.as_mut()).await;
        drop(first);
        drop(ready(later.as_mut()).await.unwrap());
        assert_eq!(budget.snapshot().active, 0);
    }
}

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
