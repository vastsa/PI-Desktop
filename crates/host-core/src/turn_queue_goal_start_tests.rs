use super::*;
use crate::{goals, sessions};
use serde_json::json;

fn fixture() -> (tempfile::TempDir, Database, String, String) {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let session =
        sessions::create_session(&db, None, Some("agent".into()), None, None, None).unwrap();
    let goal = goals::start(
        &db,
        serde_json::from_value(json!({"sessionId":session.id,"objective":"startup"})).unwrap(),
    )
    .unwrap();
    (dir, db, session.id, goal.id)
}

fn input(session: &str, goal: Option<&str>) -> QueuedTurnInput {
    serde_json::from_value(json!({"sessionId":session,"principal":"desktop",
        "inputHash":"same-input","idempotencyKey":"startup","content":"startup",
        "permissionMode":"ask","goalStartId":goal}))
    .unwrap()
}

#[test]
fn goal_start_identity_survives_reopen_and_replacement_without_rebinding() {
    let (dir, db, session, goal) = fixture();
    let queued = push(&db, input(&session, Some(&goal))).unwrap();
    assert_eq!(queued.goal_start_id.as_deref(), Some(goal.as_str()));
    assert_eq!(push(&db, input(&session, Some(&goal))).unwrap(), queued);
    let next = goals::start(
        &db,
        serde_json::from_value(json!({"sessionId":session,"objective":"replacement"})).unwrap(),
    )
    .unwrap();
    assert_ne!(next.id, goal);
    assert_eq!(
        push(&db, input(&session, Some(&next.id)))
            .unwrap_err()
            .to_string(),
        "IDEMPOTENCY_CONFLICT"
    );
    drop(db);
    let db = Database::open_in_dir(dir.path()).unwrap();
    assert_eq!(list(&db, Some(&session)).unwrap(), vec![queued]);
    assert_eq!(
        db.conn()
            .query_row("SELECT count(*) FROM goal_turns", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        db.conn()
            .query_row("SELECT count(*) FROM turns", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn goal_start_rejects_foreign_missing_voice_and_collaboration_identities() {
    let (_dir, db, session, goal) = fixture();
    let foreign = sessions::create_session(&db, None, None, None, None, None).unwrap();
    for request in [
        input(&foreign.id, Some(&goal)),
        input(&session, Some("missing")),
        input(&session, Some(" ")),
        {
            let mut r = input(&session, Some(&goal));
            r.session_message_id = Some("collaboration".into());
            r
        },
        {
            let mut r = input(&session, Some(&goal));
            r.user_message_id = Some("voice-user".into());
            r.voice_origin = Some(VoiceOrigin {
                call_id: "call".into(),
                operation_id: "operation".into(),
            });
            r
        },
    ] {
        assert!(push(&db, request)
            .unwrap_err()
            .to_string()
            .starts_with("INVALID_ARGUMENT:"));
    }
    assert!(list(&db, None).unwrap().is_empty());
}

#[test]
fn v31_queue_upgrade_adds_nullable_start_identity_without_changing_legacy_entries() {
    let (dir, db, session, _) = fixture();
    let queued = push(&db, input(&session, None)).unwrap();
    assert!(serde_json::to_value(&queued)
        .unwrap()
        .get("goalStartId")
        .is_none());
    db.conn()
        .execute_batch("ALTER TABLE turn_queue DROP COLUMN goal_start_id; PRAGMA user_version=31;")
        .unwrap();
    drop(db);
    let db = Database::open_in_dir(dir.path()).unwrap();
    assert_eq!(list(&db, Some(&session)).unwrap(), vec![queued.clone()]);
    let backup = crate::db::migration_backup_path(&dir.path().join("pi.sqlite"), 31);
    assert!(backup.exists());
    let backup_db = rusqlite::Connection::open(&backup).unwrap();
    assert!(backup_db
        .prepare("SELECT goal_start_id FROM turn_queue")
        .is_err());
    assert_eq!(
        backup_db
            .query_row("SELECT id FROM turn_queue", [], |r| r.get::<_, String>(0))
            .unwrap(),
        queued.id
    );
    let bytes = std::fs::read(&backup).unwrap();
    drop(backup_db);
    drop(db);
    let db = Database::open_in_dir(dir.path()).unwrap();
    assert_eq!(list(&db, None).unwrap(), vec![queued]);
    assert_eq!(std::fs::read(backup).unwrap(), bytes);
}
