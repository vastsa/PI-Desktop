use super::*;

fn session(db: &Database, title: &str) -> String {
    sessions::create_session_with_options(
        db,
        sessions::SessionCreateOptions {
            title: Some(title.into()),
            mode: Some("agent".into()),
            permission_mode: Some("ask".into()),
            ..Default::default()
        },
    )
    .unwrap()
    .id
}

fn send(db: &Database, source: &str, target: &str, key: &str) -> Message {
    send_record(
        db,
        &json!({"sourceSessionId":source,"pluginId":"pi.session-orchestrator",
        "content":"Review the change","idempotencyKey":key,"notifyOnCompletion":true}),
        target,
        "task",
    )
    .unwrap()
}

fn ui(role: &str, content: &str) -> sessions::UiMessage {
    serde_json::from_value(
        json!({"id":Uuid::new_v4().to_string(),"role":role,"content":content,
        "createdAt":ms_to_ts(now_ms())}),
    )
    .unwrap()
}

fn turn_count(db: &Database, session_id: &str) -> i64 {
    db.conn()
        .query_row(
            "SELECT COUNT(*) FROM turns WHERE session_id=?1",
            params![session_id],
            |row| row.get(0),
        )
        .unwrap()
}

#[test]
fn sessions_are_reused_and_send_is_idempotent() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    let parent = session(&db, "Parent");
    let child = session(&db, "Existing conversation");
    let first = send(&db, &parent, &child, "one");
    assert_eq!(send(&db, &parent, &child, "one").id, first.id);
    assert_eq!(
        send(&db, &child, &parent, "reply").target_session_id,
        parent
    );
    let mismatch = send_record(
        &db,
        &json!({"sourceSessionId":parent,"pluginId":"pi.session-orchestrator",
        "content":"different","idempotencyKey":"one"}),
        &child,
        "task",
    )
    .unwrap_err();
    assert!(mismatch.to_string().starts_with("IDEMPOTENCY_CONFLICT"));
    let count: i64 = db
        .conn()
        .query_row("SELECT COUNT(*) FROM sessions", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 2);
}

#[test]
fn projections_expose_readable_model_names_and_session_discovery_links() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    let parent = session(&db, "Parent");
    let child = session(&db, "Linked child");
    db.conn()
        .execute(
            "INSERT INTO providers(id,name,created_at,updated_at) VALUES(?1,?2,?3,?3)",
            params!["provider-id", "Readable Provider", now_ms()],
        )
        .unwrap();
    db.conn()
        .execute(
            "INSERT INTO models(provider_id,model_id,display_name,updated_at) VALUES(?1,?2,?3,?4)",
            params!["provider-id", "model-id", "Readable Model", now_ms()],
        )
        .unwrap();
    db.conn()
        .execute(
            "UPDATE sessions SET provider_id=?1,model_id=?2 WHERE id=?3",
            params!["provider-id", "model-id", child],
        )
        .unwrap();
    db.conn()
        .execute(
            "INSERT INTO session_collaboration_links(session_id,created_by_session_id,plugin_id,created_at)
             VALUES(?1,?2,?3,?4)",
            params![child, parent, "pi.session-orchestrator", now_ms()],
        )
        .unwrap();

    let child_summary = handle(
        &db,
        "session.collaboration.status",
        &json!({"sessionId":child}),
    )
    .unwrap();
    assert_eq!(child_summary["providerName"], "Readable Provider");
    assert_eq!(child_summary["modelName"], "Readable Model");
    assert_eq!(child_summary["createdBySession"]["sessionId"], parent);

    let parent_summary = handle(
        &db,
        "session.collaboration.status",
        &json!({"sessionId":parent}),
    )
    .unwrap();
    assert_eq!(parent_summary["createdSessions"][0]["sessionId"], child);
    assert_eq!(parent_summary["createdSessions"][0]["available"], true);

    let listed = handle(&db, "session.collaboration.list", &json!({})).unwrap();
    let sessions = listed["sessions"].as_array().unwrap();
    assert!(sessions.iter().any(|entry| entry["sessionId"] == parent));
    assert!(sessions.iter().any(|entry| entry["sessionId"] == child));
    assert_eq!(
        sessions
            .iter()
            .find(|entry| entry["sessionId"] == child)
            .unwrap()["providerName"],
        "Readable Provider"
    );
}

#[test]
fn turn_bound_result_and_callback_are_durable_and_exactly_once() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pi.sqlite");
    let db = Database::open(&path).unwrap();
    let parent = session(&db, "Parent");
    let child = session(&db, "Child");
    let message = send(&db, &parent, &child, "one");
    let turn = begin_turn(&db, &child, &message.id, None, None).unwrap();
    assert!(begin_turn(&db, &child, &message.id, None, None).is_err());
    sessions::append_message(&db, &child, &ui("user", &message.content), Some(&turn)).unwrap();
    sessions::append_message(
        &db,
        &child,
        &ui("assistant", "Authoritative final result"),
        Some(&turn),
    )
    .unwrap();
    assert!(settle_turn(&db, &turn).unwrap().is_none());
    sessions::end_turn(&db, &turn, "completed", None, None, false).unwrap();
    let receipt = settle_turn(&db, &turn).unwrap().unwrap();
    assert_eq!(settle_turn(&db, &turn).unwrap().unwrap().id, receipt.id);
    assert_eq!(
        receipt.reply_to_message_id.as_deref(),
        Some(message.id.as_str())
    );
    assert!(!receipt.notify_on_completion);
    let result = handle(
        &db,
        "session.collaboration.result",
        &json!({"sessionId":child,"messageId":message.id}),
    )
    .unwrap();
    assert_eq!(result["ready"], true);
    assert_eq!(result["message"]["result"], "Authoritative final result");
    drop(db);
    let db = Database::open(&path).unwrap();
    let detail = sessions::get_session(&db, &child).unwrap().unwrap();
    assert_eq!(
        detail.messages[0].session_message.as_ref().unwrap()["sourceSessionId"],
        parent
    );
    assert_eq!(get(&db, &message.id).unwrap().unwrap().status, "completed");
    assert_eq!(
        get(&db, &receipt.id).unwrap().unwrap().status,
        "interrupted"
    );
}

#[test]
fn failed_turn_does_not_promote_intermediate_output() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    let parent = session(&db, "Parent");
    let child = session(&db, "Child");
    let message = send(&db, &parent, &child, "one");
    let turn = begin_turn(&db, &child, &message.id, None, None).unwrap();
    sessions::append_message(
        &db,
        &child,
        &ui("assistant", "I will investigate"),
        Some(&turn),
    )
    .unwrap();
    sessions::end_turn(&db, &turn, "error", Some("PROVIDER_FAILED"), None, false).unwrap();
    settle_turn(&db, &turn).unwrap();
    let failed = get(&db, &message.id).unwrap().unwrap();
    assert_eq!(failed.status, "failed");
    assert!(failed.result.is_none());
    assert_eq!(failed.error.as_deref(), Some("PROVIDER_FAILED"));
}

#[test]
fn provenance_cannot_be_forged_or_stripped_and_permissions_are_rechecked() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    let parent = session(&db, "Parent");
    let child = session(&db, "Child");
    let message = send(&db, &parent, &child, "one");
    db.conn()
        .execute(
            "UPDATE sessions SET permission_mode='auto' WHERE id=?1",
            params![child],
        )
        .unwrap();
    assert!(begin_turn(&db, &child, &message.id, None, None)
        .unwrap_err()
        .to_string()
        .starts_with("PERMISSION_DENIED"));
    db.conn()
        .execute(
            "UPDATE sessions SET permission_mode='ask' WHERE id=?1",
            params![child],
        )
        .unwrap();
    let turn = begin_turn(&db, &child, &message.id, None, None).unwrap();
    assert!(sessions::append_message(&db, &child, &ui("user", "forged"), Some(&turn)).is_err());
    sessions::append_message(&db, &child, &ui("user", &message.content), Some(&turn)).unwrap();
    let mut detail = sessions::get_session(&db, &child).unwrap().unwrap();
    detail.messages[0].session_message = None;
    assert!(sessions::replace_messages(&db, &child, &detail.messages).is_err());
}

#[test]
fn steering_input_persists_without_inheriting_delivery_origin() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    let parent = session(&db, "Parent");
    let child = session(&db, "Child");
    let message = send(&db, &parent, &child, "one");
    let turn = begin_turn(&db, &child, &message.id, None, None).unwrap();

    // The delivery user row still receives host-derived origin.
    sessions::append_message(&db, &child, &ui("user", &message.content), Some(&turn)).unwrap();

    // Additional human input into the delivery turn keeps its human origin: it
    // must not be rejected as a delivery mismatch, must not inherit the
    // delivery's agent origin, and must drop a client-supplied origin.
    let mut steering = ui("user", "also update the docs");
    steering.steering = Some(true);
    steering.session_message = Some(json!({"messageId":"forged","kind":"task"}));
    sessions::append_message(&db, &child, &steering, Some(&turn)).unwrap();

    let detail = sessions::get_session(&db, &child).unwrap().unwrap();
    let delivery_row = detail
        .messages
        .iter()
        .find(|m| m.content == message.content)
        .expect("delivery user persisted");
    assert!(delivery_row.session_message.is_some());
    let appended = detail
        .messages
        .iter()
        .find(|m| m.id == steering.id)
        .expect("steering message persisted");
    assert_eq!(appended.content, "also update the docs");
    assert!(appended.session_message.is_none());

    // Steering must still target the delivery's session.
    let mut wrong = ui("user", "steer into another session");
    wrong.steering = Some(true);
    assert!(sessions::append_message(&db, &parent, &wrong, Some(&turn))
        .unwrap_err()
        .to_string()
        .starts_with("PERMISSION_DENIED"));
}

#[test]
fn queued_cancellation_keeps_the_session_and_notifies_once() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    let parent = session(&db, "Parent");
    let child = session(&db, "Child");
    let message = send(&db, &parent, &child, "one");
    let input = json!({"sessionId":child,"messageId":message.id,"pluginId":message.plugin_id,"sourceSessionId":parent});
    handle(&db, "session.collaboration.cancel", &input).unwrap();
    handle(&db, "session.collaboration.cancel", &input).unwrap();
    assert_eq!(get(&db, &message.id).unwrap().unwrap().status, "cancelled");
    assert_eq!(
        repository::pending_callbacks(&db, Some(&parent))
            .unwrap()
            .len(),
        1
    );
    assert!(sessions::get_session(&db, &child).unwrap().is_some());
}

#[test]
fn schema_v15_upgrade_preserves_sessions_and_adds_the_ledger() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pi.sqlite");
    let id;
    {
        let db = Database::open(&path).unwrap();
        id = session(&db, "Existing user session");
        db.conn()
            .execute_batch(
                "DROP TABLE session_collaboration_messages; DROP TABLE session_collaboration_links;
            ALTER TABLE turn_queue DROP COLUMN session_message_id; PRAGMA user_version=15;",
            )
            .unwrap();
    }
    let db = Database::open(&path).unwrap();
    assert_eq!(
        sessions::get_session(&db, &id)
            .unwrap()
            .unwrap()
            .summary
            .title,
        "Existing user session"
    );
    // A v15 file walks every later step in the same launch, so it lands on the
    // current version rather than the one this migration happens to produce.
    assert_eq!(
        db.conn()
            .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        crate::db::SCHEMA_VERSION
    );
    assert!(crate::db::migration_backup_path(&path, 15).exists());
    assert!(repository::pending_callbacks(&db, None).unwrap().is_empty());
}

#[test]
fn deleted_creator_keeps_its_reference_and_reports_it_unavailable() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    let parent = session(&db, "Parent");
    let child = session(&db, "Child");
    let soft_parent = session(&db, "Soft parent");
    let soft_child = session(&db, "Soft child");
    for (linked, creator) in [(&child, &parent), (&soft_child, &soft_parent)] {
        db.conn()
            .execute(
                "INSERT INTO session_collaboration_links(session_id,created_by_session_id,plugin_id,created_at)
                 VALUES(?1,?2,?3,?4)",
                params![linked, creator, "pi.session-orchestrator", now_ms()],
            )
            .unwrap();
    }
    assert!(sessions::delete_session(&db, &parent).unwrap());
    db.conn()
        .execute(
            "UPDATE sessions SET deleted_at=?1 WHERE id=?2",
            params![now_ms(), soft_parent],
        )
        .unwrap();

    let removed = handle(
        &db,
        "session.collaboration.status",
        &json!({"sessionId":child}),
    )
    .unwrap();
    assert_eq!(removed["createdBySession"]["sessionId"], parent);
    // Without the session row the title falls back to the referenced id.
    assert_eq!(removed["createdBySession"]["title"], parent);
    assert_eq!(removed["createdBySession"]["available"], false);

    let soft_removed = handle(
        &db,
        "session.collaboration.status",
        &json!({"sessionId":soft_child}),
    )
    .unwrap();
    assert_eq!(soft_removed["createdBySession"]["sessionId"], soft_parent);
    assert_eq!(soft_removed["createdBySession"]["title"], "Soft parent");
    assert_eq!(soft_removed["createdBySession"]["available"], false);
}

#[test]
fn deleted_message_source_survives_the_ledger_and_reports_an_unavailable_peer() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    let parent = session(&db, "Parent");
    let child = session(&db, "Child");
    let message = send(&db, &parent, &child, "one");
    assert!(sessions::delete_session(&db, &parent).unwrap());
    // source_session_id has no foreign key, so the delivered row survives.
    assert_eq!(get(&db, &message.id).unwrap().unwrap().status, "queued");

    let summary = handle(
        &db,
        "session.collaboration.status",
        &json!({"sessionId":child}),
    )
    .unwrap();
    assert_eq!(summary["currentTask"]["senderSession"]["sessionId"], parent);
    assert_eq!(summary["currentTask"]["senderSession"]["available"], false);
    assert_eq!(summary["recentExchanges"][0]["peer"]["sessionId"], parent);
    assert_eq!(summary["recentExchanges"][0]["peer"]["available"], false);
}

#[test]
fn begin_turn_twice_reports_conflict_without_a_second_turn() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    let parent = session(&db, "Parent");
    let child = session(&db, "Child");
    let message = send(&db, &parent, &child, "one");
    let turn = begin_turn(&db, &child, &message.id, None, None).unwrap();
    let conflict = begin_turn(&db, &child, &message.id, None, None).unwrap_err();
    assert_eq!(
        conflict.to_string(),
        "CONFLICT: session message already claimed or settled"
    );
    assert_eq!(get(&db, &message.id).unwrap().unwrap().turn_id, Some(turn));
    assert_eq!(turn_count(&db, &child), 1);
}

#[test]
fn a_claim_that_loses_the_race_returns_conflict_and_rolls_back() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    let parent = session(&db, "Parent");
    let child = session(&db, "Child");
    let message = send(&db, &parent, &child, "one");
    // Simulates another actor settling the queued message between the read at
    // the start of begin_turn and its conditional claim.
    db.conn()
        .execute_batch(
            "CREATE TRIGGER settle_during_claim AFTER INSERT ON turns
             BEGIN
               UPDATE session_collaboration_messages SET status='cancelled'
               WHERE target_session_id=NEW.session_id AND status='queued';
             END;",
        )
        .unwrap();
    let conflict = begin_turn(&db, &child, &message.id, None, None).unwrap_err();
    assert!(conflict.to_string().starts_with("CONFLICT"));
    // The claim changed no row, so the transaction rolled back completely.
    assert_eq!(turn_count(&db, &child), 0);
    assert_eq!(get(&db, &message.id).unwrap().unwrap().status, "queued");
}
