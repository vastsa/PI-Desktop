//! The per-turn revision save and the session configure call run on every turn
//! and every model or mode switch, so neither may cost a read of the whole
//! transcript; and reading less must not change what they decide.

use super::*;

fn fixture() -> (tempfile::TempDir, Database, String) {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("test.sqlite")).unwrap();
    let session = create_session(&db, None, None, None, None, None).unwrap();
    (dir, db, session.id)
}

fn message(id: &str, role: &str, text: &str) -> UiMessage {
    serde_json::from_value(json!({
        "id": id, "role": role, "content": text, "createdAt": "2026-11-14T00:00:00Z"
    }))
    .unwrap()
}

/// `count` finished exchanges of ordinary history.
fn history(db: &Database, session: &str, count: usize) {
    for index in 0..count {
        append_message(
            db,
            session,
            &message(&format!("q{index}"), "user", "question"),
            None,
        )
        .unwrap();
        append_message(
            db,
            session,
            &message(&format!("r{index}"), "assistant", "answer"),
            None,
        )
        .unwrap();
    }
}

/// A regenerated user turn as `truncate_from` leaves it: the discarded variant
/// stored as revision 1, then the new prompt stamped as revision 2 of 2.
fn regenerated_root(db: &Database, session: &str, id: &str) -> UiMessage {
    let discarded = [
        message(id, "user", "first try"),
        message("old", "assistant", "dropped"),
    ];
    save_message_revision(db, session, id, &discarded, false).unwrap();
    let mut root = message(&format!("{id}-v2"), "user", "second try");
    root.revision_root_id = Some(id.into());
    root.revision_count = Some(2);
    root.active_revision = Some(2);
    append_message(db, session, &root, None).unwrap();
    root
}

fn stored_root(db: &Database, session: &str, id: &str) -> UiMessage {
    get_session(db, session)
        .unwrap()
        .unwrap()
        .messages
        .into_iter()
        .find(|message| message.id == id)
        .unwrap()
}

#[test]
fn turn_end_and_configure_skip_the_transcript_of_a_session_never_regenerated() {
    let (_dir, db, session) = fixture();
    history(&db, &session, 200);
    transcripts::take_whole_file_reads();

    assert!(save_active_branch_revision(&db, &session)
        .unwrap()
        .is_none());
    let summary = configure_session(&db, &session, "plan", None, None)
        .unwrap()
        .unwrap();
    assert_eq!(summary.mode, "plan");
    assert_eq!(transcripts::take_whole_file_reads(), 0);
}

#[test]
fn later_turns_on_a_regenerated_branch_read_only_the_branch() {
    let (_dir, db, session) = fixture();
    history(&db, &session, 300);
    regenerated_root(&db, &session, "u1");
    append_message(&db, &session, &message("a1", "assistant", "answer"), None).unwrap();
    let first = save_active_branch_revision(&db, &session).unwrap().unwrap();
    assert!(first.archived);
    assert_eq!((first.revision_count, first.active_revision), (2, 2));

    // The next turns on the same branch: the stamp is already right.
    for turn in 0..3 {
        append_message(
            &db,
            &session,
            &message(&format!("p{turn}"), "user", "more"),
            None,
        )
        .unwrap();
        append_message(
            &db,
            &session,
            &message(&format!("x{turn}"), "assistant", "ok"),
            None,
        )
        .unwrap();
        transcripts::take_whole_file_reads();
        let saved = save_active_branch_revision(&db, &session).unwrap().unwrap();
        assert_eq!(transcripts::take_whole_file_reads(), 0, "turn {turn}");
        assert!(!saved.archived);
        assert_eq!(saved.root_user_id, "u1");
        assert_eq!((saved.revision_count, saved.active_revision), (2, 2));
        assert_eq!(saved.root.id, "u1-v2");
    }
    let revisions = list_message_revisions(&db, &session, "u1").unwrap();
    let live = revisions
        .iter()
        .find(|revision| revision.revision_index == 2)
        .unwrap();
    assert_eq!(
        live.message_count, 8,
        "root, its answer and three exchanges"
    );
    let root = stored_root(&db, &session, "u1-v2");
    assert_eq!(
        (root.revision_count, root.active_revision),
        (Some(2), Some(2))
    );
}

#[test]
fn an_imported_pager_stamp_is_dropped_because_no_revisions_come_with_it() {
    let (_dir, db, session) = fixture();
    let mut summary = session_summary(&db, &session).unwrap().unwrap();
    summary.id = "import-pi-stamped".into();
    let mut root = message("u1", "user", "question");
    root.revision_root_id = Some("u0".into());
    root.revision_count = Some(3);
    root.active_revision = Some(3);
    assert!(import_session(&db, &summary, &[root, message("a1", "assistant", "answer")]).unwrap());

    let imported = stored_root(&db, "import-pi-stamped", "u1");
    assert_eq!(
        (
            imported.revision_root_id,
            imported.revision_count,
            imported.active_revision
        ),
        (None, None, None)
    );
    assert!(save_active_branch_revision(&db, "import-pi-stamped")
        .unwrap()
        .is_none());
}
