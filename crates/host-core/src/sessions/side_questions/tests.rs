use super::*;

fn message(id: &str, role: &str, content: &str) -> UiMessage {
    serde_json::from_value(json!({"id":id,"role":role,"content":content,"status":"complete","createdAt":"2026-11-17T00:00:00Z"})).unwrap()
}

fn parent(db: &Database) -> SessionSummary {
    let source = create_session(
        db,
        Some("Synthetic main conversation".into()),
        Some("agent".into()),
        None,
        None,
        None,
    )
    .unwrap();
    configure_session_with_thinking(db, &source.id, "agent", None, None, None, Some("auto"))
        .unwrap();
    append_message(
        db,
        &source.id,
        &message("source-user", "user", "inherited-only-needle"),
        None,
    )
    .unwrap();
    append_message(
        db,
        &source.id,
        &message("source-answer", "assistant", "Completed source answer"),
        None,
    )
    .unwrap();
    source
}

fn child(db: &Database, source: &str, reference_only: bool) -> SessionDetail {
    match create(db, source, Some("Side question"), reference_only).unwrap() {
        ForkSessionResult::Created(value) => *value,
        _ => panic!("Expected an independent child"),
    }
}

#[test]
fn selected_text_creates_an_empty_session_without_copying_the_parent() {
    let directory = tempfile::tempdir().unwrap();
    let db = Database::open_in_dir(directory.path()).unwrap();
    let source = parent(&db);
    let turn = begin_turn(&db, &source.id, None, None).unwrap();
    append_message(
        &db,
        &source.id,
        &message("live-user", "user", "Unfinished work"),
        Some(&turn),
    )
    .unwrap();
    let side = child(&db, &source.id, true);
    assert!(side.messages.is_empty());
    assert!(side.compactions.is_empty());
    assert_eq!(
        side.summary
            .side_question
            .as_ref()
            .unwrap()
            .inherited_message_count,
        0
    );
    assert!(session_has_running_turn(&db, &source.id).unwrap());
    assert_eq!(
        get_session(&db, &source.id)
            .unwrap()
            .unwrap()
            .messages
            .len(),
        3
    );
    assert_eq!(list_sessions(&db).unwrap().len(), 1);
    assert_eq!(list(&db, &source.id, "", false, 5, 0).unwrap().total, 1);
}

#[test]
fn a_first_live_turn_without_a_settled_prefix_starts_an_empty_side_conversation() {
    let directory = tempfile::tempdir().unwrap();
    let db = Database::open_in_dir(directory.path()).unwrap();
    let source = create_session(&db, None, None, None, None, None).unwrap();
    let turn = begin_turn(&db, &source.id, None, None).unwrap();
    append_message(
        &db,
        &source.id,
        &message("first-live", "user", "Still running"),
        Some(&turn),
    )
    .unwrap();
    let side = child(&db, &source.id, false);
    assert!(side.messages.is_empty());
    assert_eq!(
        side.summary.side_question.unwrap().inherited_message_count,
        0
    );
    assert!(session_has_running_turn(&db, &source.id).unwrap());
}

#[test]
fn a_busy_parent_only_contributes_a_settled_prefix_and_retains_its_turn() {
    let directory = tempfile::tempdir().unwrap();
    let db = Database::open_in_dir(directory.path()).unwrap();
    let source = parent(&db);
    let turn = begin_turn(&db, &source.id, None, None).unwrap();
    append_message(
        &db,
        &source.id,
        &message("live-user", "user", "Live question"),
        Some(&turn),
    )
    .unwrap();
    append_message(
        &db,
        &source.id,
        &message(
            "live-answer",
            "assistant",
            "Complete message in a live tool loop",
        ),
        Some(&turn),
    )
    .unwrap();
    let side = child(&db, &source.id, false);
    let origin = side.summary.side_question.as_ref().unwrap();
    assert_eq!(origin.through_message_id.as_deref(), Some("source-answer"));
    assert_eq!(origin.inherited_message_count, 2);
    assert_eq!(side.messages.len(), 2);
    assert_ne!(side.messages[0].id, "source-user");
    assert!(session_has_running_turn(&db, &source.id).unwrap());
    assert!(!session_has_running_turn(&db, &side.summary.id).unwrap());
    assert_eq!(side.summary.mode, "agent");
    assert_eq!(side.summary.permission_mode, "auto");
}

#[test]
fn history_search_excludes_inherited_text_and_persists_archive_after_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let db = Database::open_in_dir(directory.path()).unwrap();
    let source = parent(&db);
    let side = child(&db, &source.id, false);
    assert_eq!(
        list(&db, &source.id, "inherited-only-needle", false, 20, 0)
            .unwrap()
            .total,
        0
    );
    append_message(
        &db,
        &side.summary.id,
        &message("side-user", "user", "cache-expiry-question"),
        None,
    )
    .unwrap();
    assert!(crate::session_search::search(&db, "cache-expiry", 0, 30)
        .unwrap()
        .hits
        .is_empty());
    assert_eq!(
        list(&db, &source.id, "cache-expiry", false, 20, 0)
            .unwrap()
            .total,
        1
    );
    assert!(archive(&db, &side.summary.id, true).unwrap());
    assert_eq!(list(&db, &source.id, "", false, 20, 0).unwrap().total, 0);
    drop(db);
    let db = Database::open_in_dir(directory.path()).unwrap();
    assert_eq!(list(&db, &source.id, "", true, 20, 0).unwrap().total, 1);
    assert!(archive(&db, &side.summary.id, false).unwrap());
    let another = child(&db, &source.id, true);
    let first = list(&db, &source.id, "", false, 1, 0).unwrap();
    let second = list(&db, &source.id, "", false, 1, 1).unwrap();
    assert_eq!(first.total, 2);
    assert_ne!(first.sessions[0].id, second.sessions[0].id);
    assert!(delete_session(&db, &another.summary.id).unwrap());
    assert!(origin(&db, &another.summary.id).unwrap().is_none());
}

#[test]
fn origin_failure_rolls_back_the_child_and_parent_deletion_preserves_a_child() {
    let directory = tempfile::tempdir().unwrap();
    let db = Database::open_in_dir(directory.path()).unwrap();
    let source = parent(&db);
    db.conn().execute_batch("CREATE TRIGGER reject_side_question BEFORE INSERT ON kv WHEN NEW.ns='session:side-question' BEGIN SELECT RAISE(ABORT,'synthetic origin failure'); END;").unwrap();
    assert!(create(&db, &source.id, None, false).is_err());
    assert_eq!(
        db.conn()
            .query_row("SELECT COUNT(*) FROM sessions", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
    db.conn()
        .execute_batch("DROP TRIGGER reject_side_question")
        .unwrap();
    let side = child(&db, &source.id, false);
    assert!(delete_session(&db, &source.id).unwrap());
    assert_eq!(
        get_session(&db, &side.summary.id)
            .unwrap()
            .unwrap()
            .messages
            .len(),
        2
    );
}

#[test]
fn side_tools_are_narrowed_by_the_host_and_a_running_child_cannot_be_deleted() {
    let directory = tempfile::tempdir().unwrap();
    let db = Database::open_in_dir(directory.path()).unwrap();
    let source = parent(&db);
    let side = child(&db, &source.id, true);
    for tool in ["Read", "Glob", "Grep"] {
        assert!(tool_allowed(&db, &side.summary.id, tool).unwrap());
    }
    for tool in [
        "Write",
        "Edit",
        "Bash",
        "Task",
        "Skill",
        "MemoryWrite",
        "plugin.synthetic",
    ] {
        assert!(!tool_allowed(&db, &side.summary.id, tool).unwrap());
        assert!(tool_allowed(&db, &source.id, tool).unwrap());
    }
    begin_turn(&db, &side.summary.id, None, None).unwrap();
    assert!(delete_session(&db, &side.summary.id).is_err());
    assert!(session_summary(&db, &side.summary.id).unwrap().is_some());
}

#[test]
fn side_completion_creates_no_notification() {
    let directory = tempfile::tempdir().unwrap();
    let db = Database::open_in_dir(directory.path()).unwrap();
    let source = parent(&db);
    let side = child(&db, &source.id, true);
    let turn = begin_turn(&db, &side.summary.id, None, None).unwrap();
    let result = end_turn_settling(&db, &turn, "completed", None, None, true, false).unwrap();
    assert!(result.updated);
    assert!(result.notification.is_none());
}
