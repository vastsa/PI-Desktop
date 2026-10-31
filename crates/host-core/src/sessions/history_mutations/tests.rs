use super::*;

fn fixture() -> (tempfile::TempDir, Database, String) {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("test.sqlite")).unwrap();
    let session = create_session(&db, None, None, None, None, None).unwrap();
    (dir, db, session.id)
}

fn message(id: &str, role: &str, text: &str) -> UiMessage {
    serde_json::from_value(json!({
        "id": id, "role": role, "content": text, "createdAt": "2026-10-26T00:00:00Z"
    }))
    .unwrap()
}

fn stopped_turn(db: &Database, session: &str, messages: &[UiMessage]) -> String {
    let turn = begin_turn(db, session, None, None).unwrap();
    for message in messages {
        append_message(db, session, message, Some(&turn)).unwrap();
    }
    end_turn(db, &turn, "aborted", None, None, false).unwrap();
    turn
}

fn ids(db: &Database, session: &str) -> Vec<String> {
    get_session(db, session)
        .unwrap()
        .unwrap()
        .messages
        .into_iter()
        .map(|m| m.id)
        .collect()
}

#[test]
fn delete_removes_one_nonuser_or_the_selected_user_turn_and_is_retry_safe() {
    let (_dir, db, session) = fixture();
    let turn = stopped_turn(
        &db,
        &session,
        &[
            message("u0", "user", "old"),
            message("a0", "assistant", "old answer"),
            message("u1", "user", "delete"),
            message("a1", "assistant", "answer"),
            message("t1", "tool", "result"),
            message("u2", "user", "keep"),
            message("a2", "assistant", "keep answer"),
        ],
    );
    assert_eq!(
        delete_message(&db, &session, "a0").unwrap().deleted_count,
        1
    );
    assert_eq!(
        delete_message(&db, &session, "u1").unwrap().deleted_count,
        3
    );
    assert!(!delete_message(&db, &session, "u1").unwrap().deleted);
    assert_eq!(ids(&db, &session), ["u0", "u2", "a2"]);
    let owner: String = db
        .conn()
        .query_row(
            "SELECT turn_id FROM messages WHERE session_id=?1 AND id='a2'",
            params![session],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(owner, turn);
}

#[test]
fn delete_archives_revision_families_before_removing_their_roots() {
    let (_dir, db, session) = fixture();
    let root = message("root", "user", "prompt");
    let answer = message("answer", "assistant", "answer");
    stopped_turn(&db, &session, &[root, answer]);
    // A live revision reference must become a stored payload before deletion.
    save_live_branch_revision(
        &db,
        &session,
        "root",
        1,
        &get_session(&db, &session).unwrap().unwrap().messages,
    )
    .unwrap();
    delete_message(&db, &session, "root").unwrap();
    let archived = transcripts::read_revision(db.data_dir(), &session, "root", 1)
        .unwrap()
        .unwrap();
    assert!(matches!(archived, transcripts::RevisionPayload::Stored(_)));
    let restored = activate_message_revision(&db, &session, "root", 1, &[]).unwrap();
    assert_eq!(restored[1].content, "answer");
}

#[test]
fn retract_removes_only_the_named_final_prompt_and_empty_reply_then_retry_is_safe() {
    let (_dir, db, session) = fixture();
    stopped_turn(&db, &session, &[message("old", "user", "keep")]);
    let turn = stopped_turn(
        &db,
        &session,
        &[
            message("pending", "user", "draft"),
            message("empty", "assistant", " \n"),
        ],
    );
    let result = retract_pending_prompt(&db, &session, "pending", Some(&turn)).unwrap();
    assert!(result.retracted);
    assert_eq!(result.removed_count, 2);
    assert_eq!(ids(&db, &session), ["old"]);
    assert_eq!(
        retract_pending_prompt(&db, &session, "pending", Some(&turn))
            .unwrap()
            .reason,
        Some("message_not_found")
    );
    assert_eq!(ids(&db, &session), ["old"]);
}

#[test]
fn retract_refuses_text_thinking_tools_new_user_steering_and_wrong_turn() {
    for (tail, reason) in [
        (message("reply", "assistant", "answer"), "reply_started"),
        (
            {
                let mut m = message("reply", "assistant", "");
                m.thinking = Some("thought".into());
                m
            },
            "reply_started",
        ),
        (message("tool", "tool", ""), "reply_started"),
        (
            message("new", "user", "new prompt"),
            "not_final_user_prompt",
        ),
    ] {
        let (_dir, db, session) = fixture();
        let turn = stopped_turn(&db, &session, &[message("pending", "user", "draft"), tail]);
        let before = ids(&db, &session);
        assert_eq!(
            retract_pending_prompt(&db, &session, "pending", Some(&turn))
                .unwrap()
                .reason,
            Some(reason)
        );
        assert_eq!(ids(&db, &session), before);
    }
    let (_dir, db, session) = fixture();
    let mut prompt = message("pending", "user", "steering");
    prompt.steering = Some(true);
    let turn = stopped_turn(&db, &session, &[prompt]);
    assert_eq!(
        retract_pending_prompt(&db, &session, "pending", Some(&turn))
            .unwrap()
            .reason,
        Some("steering_prompt")
    );
    assert_eq!(
        retract_pending_prompt(&db, &session, "pending", Some("another"))
            .unwrap()
            .reason,
        Some("steering_prompt")
    );
}

#[test]
fn retract_checks_durable_turn_identity_and_running_state() {
    let (_dir, db, session) = fixture();
    let turn = begin_turn(&db, &session, None, None).unwrap();
    append_message(
        &db,
        &session,
        &message("pending", "user", "draft"),
        Some(&turn),
    )
    .unwrap();
    assert_eq!(
        retract_pending_prompt(&db, &session, "pending", Some(&turn))
            .unwrap()
            .reason,
        Some("turn_running")
    );
    assert!(delete_message(&db, &session, "pending")
        .unwrap_err()
        .to_string()
        .starts_with("TURN_RUNNING"));
    end_turn(&db, &turn, "aborted", None, None, false).unwrap();
    assert_eq!(
        retract_pending_prompt(&db, &session, "pending", Some("wrong"))
            .unwrap()
            .reason,
        Some("turn_mismatch")
    );
    assert!(
        retract_pending_prompt(&db, &session, "pending", None)
            .unwrap()
            .retracted
    );
}

#[test]
fn retract_refuses_unattributed_or_superseded_turns_and_durable_checkpoints() {
    let (_dir, db, session) = fixture();
    append_message(&db, &session, &message("pending", "user", "draft"), None).unwrap();
    assert_eq!(
        retract_pending_prompt(&db, &session, "pending", None)
            .unwrap()
            .reason,
        Some("turn_not_found")
    );
    let (_dir, db, session) = fixture();
    let turn = stopped_turn(&db, &session, &[message("pending", "user", "draft")]);
    let next = stopped_turn(&db, &session, &[]);
    assert_ne!(turn, next);
    assert_eq!(
        retract_pending_prompt(&db, &session, "pending", Some(&turn))
            .unwrap()
            .reason,
        Some("turn_mismatch")
    );
    let (_dir, db, session) = fixture();
    let turn = stopped_turn(&db, &session, &[message("pending", "user", "draft")]);
    save_inflight_message(
        &db,
        &session,
        Some(&turn),
        &message("checkpoint", "assistant", "durable answer"),
    )
    .unwrap();
    assert_eq!(
        retract_pending_prompt(&db, &session, "pending", Some(&turn))
            .unwrap()
            .reason,
        Some("reply_started")
    );
    assert!(transcripts::read_inflight(db.data_dir(), &session)
        .unwrap()
        .is_some());
}

#[test]
fn canonical_activation_requires_a_durable_family_anchor_and_preserves_legacy_prefix() {
    let (_dir, db, session) = fixture();
    let root = message("root", "user", "archived");
    save_message_revision(&db, &session, "root", &[root], false).unwrap();
    stopped_turn(&db, &session, &[message("keep", "user", "safe")]);
    let result = activate_message_revision_canonical(&db, &session, "root", 1);
    assert!(result.unwrap_err().to_string().starts_with("NOT_FOUND"));
    assert_eq!(ids(&db, &session), ["keep"]);
    let prefix = message("legacy", "user", "explicit legacy prefix");
    let restored = activate_message_revision(&db, &session, "root", 1, &[prefix]).unwrap();
    assert_eq!(restored[0].id, "legacy");
    assert_eq!(
        activate_message_revision_canonical(&db, &session, "root", 1).unwrap()[0].id,
        "legacy"
    );
}

#[test]
fn delete_disposes_only_the_selected_turns_checkpoint() {
    let (_dir, db, session) = fixture();
    let turn = stopped_turn(&db, &session, &[message("pending", "user", "delete")]);
    save_inflight_message(
        &db,
        &session,
        Some(&turn),
        &message("checkpoint", "assistant", "partial answer"),
    )
    .unwrap();
    delete_message(&db, &session, "pending").unwrap();
    assert!(transcripts::read_inflight(db.data_dir(), &session)
        .unwrap()
        .is_none());
    assert!(ids(&db, &session).is_empty());

    let turn = stopped_turn(
        &db,
        &session,
        &[
            message("keep", "user", "keep"),
            message("reply", "assistant", "remove row"),
        ],
    );
    save_inflight_message(
        &db,
        &session,
        Some(&turn),
        &message("another", "assistant", "keep checkpoint"),
    )
    .unwrap();
    delete_message(&db, &session, "reply").unwrap();
    assert!(transcripts::read_inflight(db.data_dir(), &session)
        .unwrap()
        .is_some());
}

#[test]
fn bounded_delete_retains_collaboration_provenance() {
    let (_dir, db, session) = fixture();
    let mut collaboration = message("collaboration", "user", "agent input");
    collaboration.session_message =
        Some(json!({"messageId":"delivery", "sourceSessionId":"source"}));
    let created = session_created_at(&db, &session).unwrap();
    let (record, text) = ui_to_record(&collaboration);
    append_record(&db, &session, &created, &record, text.as_deref(), None).unwrap();
    stopped_turn(&db, &session, &[message("delete", "user", "human input")]);
    delete_message(&db, &session, "delete").unwrap();
    let kept = get_session(&db, &session).unwrap().unwrap().messages;
    assert_eq!(kept.len(), 1);
    assert_eq!(kept[0].session_message, collaboration.session_message);
}
