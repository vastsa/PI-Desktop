use super::*;
use crate::session_collaboration::{self as collaboration, repository};
use uuid::Uuid;

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
fn setting(db: &Database, on: bool) {
    db.set_setting("app", &json!({"sessionMessagesInCurrentTurn":on}))
        .unwrap();
}
fn send(db: &Database, source: &str, target: &str, key: &str, kind: &str) -> repository::Message {
    let value = collaboration::handle(db, "session.collaboration.send", &json!({
        "sourceSessionId":source,"pluginId":"fixture","sessionId":target,
        "content":format!("Report {key}"),"kind":kind,"idempotencyKey":key,"notifyOnCompletion":false
    })).unwrap();
    repository::get(db, value["message"]["id"].as_str().unwrap())
        .unwrap()
        .unwrap()
}
fn take(db: &Database, session: &str, turn: &str, request: &str) -> Value {
    receive(db, &json!({"sessionId":session,"turnId":turn,"requestId":request,"enabledPluginIds":["fixture"]})).unwrap()
}
fn end(db: &Database, turn: &str, status: &str) {
    sessions::end_turn(db, turn, status, None, None, false).unwrap();
    collaboration::settle_turn(db, turn).unwrap();
}
fn count(db: &Database, sql: &str) -> i64 {
    db.conn().query_row(sql, [], |r| r.get(0)).unwrap()
}

#[test]
fn default_off_tasks_and_preexisting_queue_keep_original_admission() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    let parent = session(&db, "Parent");
    let child = session(&db, "Worker");
    let turn = sessions::begin_turn(&db, &parent, None, None).unwrap();
    let old = send(&db, &child, &parent, "old", "message");
    assert!(old.current_turn.is_none());
    setting(&db, true);
    let retry = send(&db, &child, &parent, "old", "message");
    assert_eq!(retry.id, old.id);
    assert!(retry.current_turn.is_none());
    assert!(send(&db, &child, &parent, "task", "task")
        .current_turn
        .is_none());
    let fresh = send(&db, &child, &parent, "new", "message");
    assert_eq!(fresh.current_turn.unwrap().turn_id, turn);
    assert_eq!(
        take(&db, &parent, &turn, "r")["messages"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn multiple_workers_are_received_once_in_parent_turn_without_finishing_other_worker() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    setting(&db, true);
    let parent = session(&db, "Parent");
    let w8 = session(&db, "worker08");
    let w9 = session(&db, "worker09");
    let parent_turn = sessions::begin_turn(&db, &parent, None, None).unwrap();
    let w9_turn = sessions::begin_turn(&db, &w9, None, None).unwrap();
    let first = send(&db, &w8, &parent, "08", "message");
    let second = send(&db, &w9, &parent, "09-progress", "message");
    let received = take(&db, &parent, &parent_turn, "request-1");
    assert_eq!(received["messages"].as_array().unwrap().len(), 2);
    assert_eq!(
        take(&db, &parent, &parent_turn, "request-1"),
        received,
        "lost reply reuses the receipt"
    );
    assert!(take(&db, &parent, &parent_turn, "request-2")["messages"]
        .as_array()
        .unwrap()
        .is_empty());
    assert_eq!(count(&db, "SELECT COUNT(*) FROM turns"), 2);
    assert_eq!(
        count(&db, "SELECT COUNT(*) FROM messages WHERE role='user'"),
        2
    );
    let worker_status: String = db
        .conn()
        .query_row(
            "SELECT status FROM turns WHERE id=?1",
            params![w9_turn],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(worker_status, "running");
    for m in [&first, &second] {
        let updated = repository::get(&db, &m.id).unwrap().unwrap();
        assert_eq!(updated.turn_id.as_deref(), Some(parent_turn.as_str()));
        assert_eq!(updated.status, "running");
        assert!(collaboration::begin_turn(&db, &parent, &m.id, None, None).is_err());
        release(&db, &json!({"messageId":m.id,"turnId":parent_turn})).unwrap();
        assert_eq!(
            repository::get(&db, &m.id)
                .unwrap()
                .unwrap()
                .current_turn
                .unwrap()
                .state,
            "accepted"
        );
    }
    let transcript = sessions::get_session(&db, &parent).unwrap().unwrap();
    assert!(transcript
        .messages
        .iter()
        .all(|m| m.steering != Some(true) && m.session_message.is_some()));
    end(&db, &parent_turn, "completed");
    assert_eq!(
        repository::get(&db, &first.id).unwrap().unwrap().status,
        "completed"
    );
    assert_eq!(
        repository::get(&db, &second.id).unwrap().unwrap().status,
        "completed"
    );
    assert!(repository::pending_callbacks(&db, Some(&parent))
        .unwrap()
        .is_empty());
}

#[test]
fn completion_receipt_uses_same_path_and_never_generates_an_acknowledgement_loop() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    setting(&db, true);
    let parent = session(&db, "Parent");
    let child = session(&db, "Worker");
    let pt = sessions::begin_turn(&db, &parent, None, None).unwrap();
    let task = collaboration::handle(
        &db,
        "session.collaboration.send",
        &json!({
            "sourceSessionId":parent,"pluginId":"fixture","sessionId":child,
            "content":"Inspect","kind":"task","idempotencyKey":"task","notifyOnCompletion":true
        }),
    )
    .unwrap();
    let id = task["message"]["id"].as_str().unwrap();
    let ct = collaboration::begin_turn(&db, &child, id, None, None).unwrap();
    end(&db, &ct, "completed");
    let notices = take(&db, &parent, &pt, "notice");
    assert_eq!(
        notices["messages"][0]["sessionMessage"]["kind"],
        "completion"
    );
    assert_eq!(
        notices["messages"][0]["sessionMessage"]["replyToMessageId"],
        id
    );
    end(&db, &pt, "completed");
    assert_eq!(
        count(
            &db,
            "SELECT COUNT(*) FROM session_collaboration_messages WHERE kind='completion'"
        ),
        1
    );
}

#[test]
fn ended_or_released_offer_falls_back_once_but_not_to_another_active_turn() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    setting(&db, true);
    let parent = session(&db, "Parent");
    let child = session(&db, "Worker");
    let turn = sessions::begin_turn(&db, &parent, None, None).unwrap();
    let m = send(&db, &child, &parent, "late", "message");
    end(&db, &turn, "completed");
    assert!(take(&db, &parent, &turn, "too-late")["messages"]
        .as_array()
        .unwrap()
        .is_empty());
    assert_eq!(
        repository::get(&db, &m.id)
            .unwrap()
            .unwrap()
            .current_turn
            .unwrap()
            .state,
        "fallback"
    );
    let next = sessions::begin_turn(&db, &parent, None, None).unwrap();
    assert!(take(&db, &parent, &next, "new-turn")["messages"]
        .as_array()
        .unwrap()
        .is_empty());
    end(&db, &next, "completed");
    let fallback = collaboration::begin_turn(&db, &parent, &m.id, None, None).unwrap();
    assert_ne!(fallback, turn);
    assert!(collaboration::begin_turn(&db, &parent, &m.id, None, None).is_err());
}

#[test]
fn permission_settings_plugin_and_approval_gates_are_rechecked_at_acceptance() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    setting(&db, true);
    let parent = session(&db, "Parent");
    let child = session(&db, "Worker");
    let turn = sessions::begin_turn(&db, &parent, None, None).unwrap();
    let m = send(&db, &child, &parent, "permission", "message");
    db.conn()
        .execute(
            "UPDATE sessions SET permission_mode='auto' WHERE id=?1",
            params![parent],
        )
        .unwrap();
    assert!(take(&db, &parent, &turn, "unsafe")["messages"]
        .as_array()
        .unwrap()
        .is_empty());
    assert_eq!(
        repository::get(&db, &m.id)
            .unwrap()
            .unwrap()
            .current_turn
            .unwrap()
            .state,
        "fallback"
    );
    db.conn()
        .execute(
            "UPDATE sessions SET permission_mode='ask' WHERE id=?1",
            params![parent],
        )
        .unwrap();
    let m = send(&db, &child, &parent, "approval", "message");
    db.conn().execute("INSERT INTO plan_approvals(request_id,session_id,turn_id,tool_call_id,plan_json,status,created_at,updated_at)
        VALUES('approval',?1,?2,'approval-tool','{}','pending',1,1)",params![parent,turn]).unwrap();
    assert!(take(&db, &parent, &turn, "approval")["messages"]
        .as_array()
        .unwrap()
        .is_empty());
    db.conn().execute("DELETE FROM plan_approvals", []).unwrap();
    setting(&db, false);
    assert!(take(&db, &parent, &turn, "disabled-setting")["messages"]
        .as_array()
        .unwrap()
        .is_empty());
    setting(&db, true);
    let result=receive(&db,&json!({"sessionId":parent,"turnId":turn,"requestId":"disabled-plugin","enabledPluginIds":[]})).unwrap();
    assert!(result["messages"].as_array().unwrap().is_empty());
    assert_eq!(
        repository::get(&db, &m.id)
            .unwrap()
            .unwrap()
            .current_turn
            .unwrap()
            .state,
        "fallback"
    );
}

#[test]
fn receipt_provenance_cannot_be_forged_or_reused_in_another_session_or_turn() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    setting(&db, true);
    let parent = session(&db, "Parent");
    let child = session(&db, "Worker");
    let turn = sessions::begin_turn(&db, &parent, None, None).unwrap();
    let m = send(&db, &child, &parent, "origin", "message");
    assert!(take(&db, &child, &turn, "wrong-target")["messages"]
        .as_array()
        .unwrap()
        .is_empty());
    let mut ui = input(&m).unwrap();
    assert!(sessions::append_message(&db, &parent, &ui, Some(&turn)).is_err());
    take(&db, &parent, &turn, "accept");
    ui.session_message = Some(json!({"sourceSessionId":"forged"}));
    assert_eq!(
        prepare_append(&db, &parent, &ui, Some(&turn))
            .unwrap()
            .unwrap()
            .session_message
            .unwrap()["sourceSessionId"],
        child
    );
    ui.content = "forged content".into();
    assert!(sessions::append_message(&db, &parent, &ui, Some(&turn)).is_err());
    let valid = input(&m).unwrap();
    assert!(sessions::append_message(&db, &child, &valid, Some(&turn)).is_err());
    assert!(sessions::append_message(&db, &parent, &valid, Some("other-turn")).is_err());
    let mut steering = valid.clone();
    steering.steering = Some(true);
    assert!(sessions::append_message(&db, &parent, &steering, Some(&turn)).is_err());
}

#[test]
fn accepted_input_constrains_hops_and_cannot_cancel_unrelated_parent_work() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    setting(&db, true);
    let parent = session(&db, "Parent");
    let child = session(&db, "Worker");
    let turn = sessions::begin_turn(&db, &parent, None, None).unwrap();
    let m = send(&db, &child, &parent, "hop", "message");
    db.conn()
        .execute(
            "UPDATE session_collaboration_messages SET remaining_hops=1 WHERE id=?1",
            params![m.id],
        )
        .unwrap();
    take(&db, &parent, &turn, "accept");
    let err = collaboration::handle(
        &db,
        "session.collaboration.send",
        &json!({
            "sourceSessionId":parent,"sourceTurnId":turn,"sessionId":child,"pluginId":"fixture",
            "content":"Loop","idempotencyKey":"loop"
        }),
    )
    .unwrap_err();
    assert!(err.to_string().contains("LIMIT_EXCEEDED"));
    let err = collaboration::handle(
        &db,
        "session.collaboration.cancel",
        &json!({"sessionId":parent,"messageId":m.id}),
    )
    .unwrap_err();
    assert!(err.to_string().contains("CONFLICT"));
    assert_eq!(
        count(&db, "SELECT COUNT(*) FROM turns WHERE status='running'"),
        1
    );
}

#[test]
fn lost_reply_and_jsonl_index_gap_are_repaired_without_duplicate_input() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    setting(&db, true);
    let parent = session(&db, "Parent");
    let child = session(&db, "Worker");
    let turn = sessions::begin_turn(&db, &parent, None, None).unwrap();
    let m = send(&db, &child, &parent, "gap", "message");
    take(&db, &parent, &turn, "request");
    db.conn()
        .execute(
            "DELETE FROM messages WHERE id=?1",
            params![format!("session-message:{}", m.id)],
        )
        .unwrap();
    take(&db, &parent, &turn, "request");
    assert_eq!(
        crate::transcripts::read_transcript(db.data_dir(), &parent)
            .unwrap()
            .len(),
        1
    );
    assert_eq!(count(&db, "SELECT COUNT(*) FROM messages"), 1);
}

#[test]
fn restart_distinguishes_known_acceptance_from_never_received_work() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pi.sqlite");
    let (parent, accepted_id, offered_id);
    {
        let db = Database::open(&path).unwrap();
        setting(&db, true);
        parent = session(&db, "Parent");
        let child = session(&db, "Worker");
        let _turn = sessions::begin_turn(&db, &parent, None, None).unwrap();
        accepted_id = send(&db, &child, &parent, "accepted", "message").id;
        offered_id = send(&db, &child, &parent, "offered", "message").id;
        // Crash after the durable receipt, before the transcript write/ack.
        db.conn().execute("UPDATE session_collaboration_current_turn SET state='accepted',request_id='lost' WHERE message_id=?1",params![accepted_id]).unwrap();
        db.conn()
            .execute(
                "UPDATE session_collaboration_messages SET status='running' WHERE id=?1",
                params![accepted_id],
            )
            .unwrap();
    }
    for _ in 0..2 {
        let db = Database::open(&path).unwrap();
        assert_eq!(
            repository::get(&db, &accepted_id).unwrap().unwrap().status,
            "interrupted"
        );
        assert_eq!(
            repository::get(&db, &offered_id).unwrap().unwrap().status,
            "queued"
        );
        let q = turn_queue::list(&db, Some(&parent)).unwrap();
        assert_eq!(q.len(), 1);
        assert_eq!(
            q[0].session_message_id.as_deref(),
            Some(offered_id.as_str())
        );
        assert_eq!(q[0].principal, "desktop");
        let messages = crate::transcripts::read_transcript(db.data_dir(), &parent).unwrap();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].id, format!("session-message:{accepted_id}"));
    }
}

#[test]
fn migration_from_v19_is_additive_and_does_not_offer_old_messages() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pi.sqlite");
    let id;
    {
        let db = Database::open(&path).unwrap();
        let a = session(&db, "Keep");
        let b = session(&db, "Worker");
        id = send(&db, &b, &a, "old", "message").id;
        db.conn()
            .execute_batch("DROP TABLE session_collaboration_current_turn; PRAGMA user_version=19;")
            .unwrap();
    }
    let db = Database::open(&path).unwrap();
    assert!(repository::get(&db, &id)
        .unwrap()
        .unwrap()
        .current_turn
        .is_none());
    assert_eq!(count(&db, "PRAGMA user_version"), 20);
    assert!(crate::db::migration_backup_path(&path, 19).exists());
    assert_eq!(count(&db, "SELECT COUNT(*) FROM sessions"), 2);
}

#[test]
fn cancelled_offer_is_never_received() {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    setting(&db, true);
    let parent = session(&db, "Parent");
    let child = session(&db, "Worker");
    let turn = sessions::begin_turn(&db, &parent, None, None).unwrap();
    let m = send(&db, &child, &parent, "cancelled", "message");
    collaboration::handle(
        &db,
        "session.collaboration.cancel",
        &json!({"sessionId":parent,"messageId":m.id}),
    )
    .unwrap();
    assert!(
        take(&db, &parent, &turn, &Uuid::new_v4().to_string())["messages"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}
