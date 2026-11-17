use super::*;
use crate::sessions;

#[test]
fn pending_completions_survive_pruning_and_restart_until_read_with_bounded_pages() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pi.sqlite");
    let db = Database::open(&path).unwrap();
    let session =
        sessions::create_session(&db, Some("Original title".into()), None, None, None, None)
            .unwrap();
    let mut ids = Vec::new();
    for _ in 0..205 {
        let turn = sessions::begin_turn(&db, &session.id, None, None).unwrap();
        let result = sessions::end_turn(&db, &turn, "completed", None, None, true).unwrap();
        ids.push(result.notification.unwrap().id);
        assert!(
            sessions::end_turn(&db, &turn, "completed", None, None, true)
                .unwrap()
                .notification
                .is_none()
        );
    }
    let (history, unread) = list(&db, false, 500).unwrap();
    assert_eq!(history.len(), 200);
    assert_eq!(unread, 200);
    let pruned_id = ids
        .iter()
        .find(|id| !history.iter().any(|n| &n.id == *id))
        .unwrap()
        .clone();
    assert!(mark_read(&db, &pruned_id).unwrap());
    assert!(!mark_read(&db, &pruned_id).unwrap());
    ids.retain(|id| id != &pruned_id);
    // Force timestamp ties to prove the ID tie-breaker across page boundaries.
    db.conn()
        .execute(
            "UPDATE pending_completion_notifications SET created_at = 42",
            [],
        )
        .unwrap();
    ids.sort_by(|a, b| b.cmp(a));
    let (first, count) = list_pending_completions(&db, 500, -10).unwrap();
    assert_eq!(first.len(), 200);
    assert_eq!(count, 204);
    assert_eq!(
        first.iter().map(|n| n.id.clone()).collect::<Vec<_>>(),
        ids[..200]
    );
    let (last, count) = list_pending_completions(&db, 500, 200).unwrap();
    assert_eq!(count, 204);
    assert_eq!(
        last.iter().map(|n| n.id.clone()).collect::<Vec<_>>(),
        ids[200..]
    );
    assert!(list_pending_completions(&db, 200, i64::MAX)
        .unwrap()
        .0
        .is_empty());
    assert_eq!(list_pending_completions(&db, 0, 0).unwrap().0.len(), 1);
    assert_eq!(list_pending_completions(&db, -10, 0).unwrap().0.len(), 1);
    assert!(sessions::rename_session(&db, &session.id, "New title").unwrap());
    drop(db);
    let db = Database::open(&path).unwrap();
    assert_eq!(list(&db, false, 200).unwrap().0.len(), 200);
    let (pending, count) = list_pending_completions(&db, 200, 0).unwrap();
    assert_eq!(count, 204);
    assert_eq!(pending[0].session_title, "Original title");
    assert_eq!(pending[0].created_at, ms_to_ts(42));
    assert!(pending[0].read_at.is_none());
    assert!(!mark_read(&db, &pruned_id).unwrap());
    assert!(mark_read(&db, &ids[0]).unwrap());
    let viewed_id = ids
        .iter()
        .find(|id| **id != ids[0] && !history.iter().any(|n| &n.id == *id))
        .unwrap();
    assert!(mark_read(&db, viewed_id).unwrap());
    assert!(!mark_read(&db, viewed_id).unwrap());
    assert_eq!(list_pending_completions(&db, 200, 0).unwrap().1, 202);
    drop(db);
    let db = Database::open(&path).unwrap();
    assert_eq!(list_pending_completions(&db, 200, 0).unwrap().1, 202);
    assert!(sessions::delete_session(&db, &session.id).unwrap());
    assert_eq!(list_pending_completions(&db, 200, 0).unwrap().1, 0);
}

#[test]
fn pending_completions_only_track_original_unseen_success_and_acknowledge_exact_id() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    let session =
        sessions::create_session(&db, Some("Result".into()), None, None, None, None).unwrap();
    for (status, notify) in [("completed", false), ("error", true), ("aborted", true)] {
        let turn = sessions::begin_turn(&db, &session.id, None, None).unwrap();
        let result = sessions::end_turn(&db, &turn, status, Some("CODE"), None, notify).unwrap();
        assert_eq!(result.notification.is_some(), status == "error");
        assert_eq!(list_pending_completions(&db, 200, 0).unwrap().1, 0);
        assert!(
            sessions::end_turn(&db, &turn, "completed", None, None, true)
                .unwrap()
                .notification
                .is_none()
        );
    }
    let mut originals = Vec::new();
    for _ in 0..2 {
        let turn = sessions::begin_turn(&db, &session.id, None, None).unwrap();
        originals.push(
            sessions::end_turn(&db, &turn, "completed", None, None, true)
                .unwrap()
                .notification
                .unwrap(),
        );
    }
    let original = &originals[0];
    let (pending, count) = list_pending_completions(&db, 200, 0).unwrap();
    assert_eq!(count, 2);
    assert_eq!(
        serde_json::to_value(pending.iter().find(|n| n.id == original.id).unwrap()).unwrap(),
        serde_json::to_value(original).unwrap()
    );
    assert!(mark_read(&db, &original.id).unwrap());
    let read_at = list(&db, false, 200)
        .unwrap()
        .0
        .into_iter()
        .find(|n| n.id == original.id)
        .unwrap()
        .read_at;
    assert!(read_at.is_some());
    assert_eq!(list_pending_completions(&db, 200, 0).unwrap().1, 1);
    assert!(!mark_read(&db, "missing").unwrap());
    assert!(
        mark_read(&db, &original.id).unwrap(),
        "history row remains idempotently readable"
    );
    let (pending, count) = list_pending_completions(&db, 200, 0).unwrap();
    assert_eq!(count, 1);
    assert_eq!(pending[0].id, originals[1].id);
    assert_eq!(
        list(&db, false, 200)
            .unwrap()
            .0
            .into_iter()
            .find(|n| n.id == original.id)
            .unwrap()
            .read_at,
        read_at
    );
    assert!(
        sessions::end_turn(&db, &original.turn_id, "completed", None, None, true)
            .unwrap()
            .notification
            .is_none()
    );
    assert_eq!(list_pending_completions(&db, 200, 0).unwrap().1, 1);
    assert!(mark_read(&db, &originals[1].id).unwrap());
    assert_eq!(list_pending_completions(&db, 200, 0).unwrap().1, 0);
}

#[test]
fn pending_completion_mark_all_read_acknowledges_pruned_pages_across_restart() {
    assert_bulk_acknowledgement(mark_all_read, false);
}

#[test]
fn pending_completion_clear_acknowledges_pruned_pages_across_restart() {
    assert_bulk_acknowledgement(clear, true);
}

fn assert_bulk_acknowledgement(action: fn(&Database) -> Result<()>, clears_history: bool) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pi.sqlite");
    let db = Database::open(&path).unwrap();
    let session = sessions::create_session(&db, None, None, None, None, None).unwrap();
    let mut turns = Vec::new();
    for _ in 0..203 {
        let turn = sessions::begin_turn(&db, &session.id, None, None).unwrap();
        assert!(
            sessions::end_turn(&db, &turn, "completed", None, None, true)
                .unwrap()
                .notification
                .is_some()
        );
        turns.push(turn);
    }
    drop(db);
    let db = Database::open(&path).unwrap();
    assert_eq!(list_pending_completions(&db, 200, 200).unwrap().0.len(), 3);
    assert_eq!(list(&db, false, 200).unwrap().0.len(), 200);
    for _ in 0..2 {
        action(&db).unwrap();
        assert_eq!(list_pending_completions(&db, 200, 0).unwrap().1, 0);
        assert!(list_pending_completions(&db, 200, 200)
            .unwrap()
            .0
            .is_empty());
        let (history, unread) = list(&db, false, 200).unwrap();
        assert_eq!(unread, 0);
        assert_eq!(history.len(), if clears_history { 0 } else { 200 });
    }
    drop(db);
    let db = Database::open(&path).unwrap();
    assert_eq!(list_pending_completions(&db, 200, 0).unwrap().1, 0);
    for turn in turns {
        assert!(
            sessions::end_turn(&db, &turn, "completed", None, None, true)
                .unwrap()
                .notification
                .is_none()
        );
    }
    assert_eq!(list_pending_completions(&db, 200, 0).unwrap().1, 0);
    let turn = sessions::begin_turn(&db, &session.id, None, None).unwrap();
    let new_completion = sessions::end_turn(&db, &turn, "completed", None, None, true)
        .unwrap()
        .notification
        .unwrap();
    drop(db);
    let db = Database::open(&path).unwrap();
    let (pending, count) = list_pending_completions(&db, 200, 0).unwrap();
    assert_eq!(count, 1);
    assert_eq!(pending[0].id, new_completion.id);
    assert_eq!(list(&db, true, 200).unwrap().1, 1);
    action(&db).unwrap();
    assert_eq!(list_pending_completions(&db, 200, 0).unwrap().1, 0);
}

#[test]
fn pending_completion_insert_and_all_acknowledgements_are_transactional() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    let session = sessions::create_session(&db, None, None, None, None, None).unwrap();
    let turn = sessions::begin_turn(&db, &session.id, None, None).unwrap();
    db.conn()
        .execute_batch(
            "CREATE TRIGGER reject_pending BEFORE INSERT ON pending_completion_notifications
         BEGIN SELECT RAISE(ABORT, 'test insert failure'); END;",
        )
        .unwrap();
    assert!(sessions::end_turn(&db, &turn, "completed", None, None, true).is_err());
    assert!(list(&db, false, 200).unwrap().0.is_empty());
    assert_eq!(
        db.conn()
            .query_row("SELECT status FROM turns WHERE id = ?1", [&turn], |row| row
                .get::<_, String>(0))
            .unwrap(),
        "running"
    );
    db.conn()
        .execute_batch("DROP TRIGGER reject_pending")
        .unwrap();
    let original = sessions::end_turn(&db, &turn, "completed", None, None, true)
        .unwrap()
        .notification
        .unwrap();
    let failed_turn = sessions::begin_turn(&db, &session.id, None, None).unwrap();
    sessions::end_turn(&db, &failed_turn, "error", Some("MODEL_ERROR"), None, true).unwrap();
    db.conn()
        .execute_batch(
            "CREATE TRIGGER reject_acknowledgement BEFORE DELETE ON pending_completion_notifications
         BEGIN SELECT RAISE(ABORT, 'test acknowledgement failure'); END;",
        )
        .unwrap();
    for name in ["mark_read", "mark_all_read", "clear"] {
        let result = match name {
            "mark_read" => mark_read(&db, &original.id).map(|_| ()),
            "mark_all_read" => mark_all_read(&db),
            "clear" => clear(&db),
            _ => unreachable!(),
        };
        assert!(
            result.is_err(),
            "{name} must report projection delete failure"
        );
        let (history, unread) = list(&db, false, 200).unwrap();
        assert_eq!(history.len(), 2, "{name} must retain ordinary history");
        assert_eq!(unread, 2, "{name} must roll back ordinary read state");
        assert_eq!(list_pending_completions(&db, 200, 0).unwrap().1, 1);
    }
    db.conn()
        .execute_batch("DROP TRIGGER reject_acknowledgement")
        .unwrap();
    assert!(mark_read(&db, &original.id).unwrap());
    assert_eq!(list(&db, true, 200).unwrap().1, 1);
    assert_eq!(list_pending_completions(&db, 200, 0).unwrap().1, 0);
    clear(&db).unwrap();
    assert!(list(&db, false, 200).unwrap().0.is_empty());
}
