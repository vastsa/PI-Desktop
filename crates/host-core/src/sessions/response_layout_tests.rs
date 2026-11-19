use super::*;

#[test]
fn response_layout_roundtrips_after_restart_and_legacy_rows_stay_absent() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pi.sqlite");
    let commentary = "Checking sources 🔎. ";
    let answer = "Here is the answer.";
    let thinking = "Consider the evidence 🧠.";
    let content = format!("{commentary}{answer}");
    let layout = json!([
        { "type": "thinking", "length": thinking.encode_utf16().count() },
        { "type": "commentary", "length": commentary.encode_utf16().count() },
        { "type": "search", "id": "search-1" },
        { "type": "text", "length": answer.encode_utf16().count() }
    ]);
    let hosted_search = json!({
        "status": "completed",
        "rounds": [{ "id": "search-1", "status": "completed", "query": "sources" }],
        "replay": [{
            "type": "hostedSearch", "phase": "server_tool_use", "blockId": "search-1",
            "name": "web_search", "input": { "query": "sources" }
        }]
    });
    let replay = json!({
        "version": 1,
        "blocks": [
            { "type": "thinking", "length": thinking.encode_utf16().count(), "signature": "sig-1" },
            { "type": "text", "length": commentary.encode_utf16().count(), "signature": "commentary-id" },
            { "type": "text", "length": answer.encode_utf16().count(), "signature": "answer-id" }
        ]
    });
    let session_id = {
        let db = Database::open(&path).unwrap();
        let session = create_session(&db, None, None, None, None, None).unwrap();
        let mut wire = json!({
            "id": "assistant-layout", "role": "assistant", "content": content,
            "thinking": thinking, "status": "complete", "createdAt": "2026-11-19T00:00:00Z",
            "responseLayout": layout, "hostedSearch": hosted_search, "providerReplay": replay
        });
        let message: UiMessage = serde_json::from_value(wire.clone()).unwrap();
        append_message(&db, &session.id, &message, None).unwrap();
        wire["id"] = json!("assistant-legacy");
        wire.as_object_mut().unwrap().remove("responseLayout");
        let legacy: UiMessage = serde_json::from_value(wire).unwrap();
        append_message(&db, &session.id, &legacy, None).unwrap();
        session.id
    };

    let db = Database::open(&path).unwrap();
    let records = transcripts::read_transcript(db.data_dir(), &session_id).unwrap();
    assert_eq!(records.len(), 2);
    assert_eq!(
        records[0].meta.as_ref().unwrap().get("responseLayout"),
        Some(&layout)
    );
    assert!(records[1]
        .meta
        .as_ref()
        .unwrap()
        .get("responseLayout")
        .is_none());
    // Layout is metadata only: text, hosted-search blocks and replay stay intact.
    assert_eq!(records[0].blocks, records[1].blocks);
    assert_eq!(
        records[0].blocks[0],
        json!({ "type": "thinking", "text": thinking })
    );
    let mut search_block = hosted_search.clone();
    search_block["type"] = json!("hostedSearch");
    assert_eq!(records[0].blocks[1], search_block);
    assert_eq!(
        records[0].blocks[2],
        json!({ "type": "text", "text": content })
    );
    for record in &records {
        assert_eq!(
            record.meta.as_ref().unwrap().get("providerReplay"),
            Some(&replay)
        );
    }

    let detail = get_session(&db, &session_id).unwrap().unwrap();
    let messages = serde_json::to_value(&detail.messages).unwrap();
    assert_eq!(messages[0]["responseLayout"], layout);
    assert!(messages[1].get("responseLayout").is_none());
    for message in &detail.messages {
        assert_eq!(message.content, content);
        assert_eq!(message.thinking.as_deref(), Some(thinking));
        assert_eq!(message.hosted_search.as_ref(), Some(&hosted_search));
        assert_eq!(message.provider_replay.as_ref(), Some(&replay));
    }
    // Pagination alone must retain layout; it does not clip message text.
    let page = get_session_with_options(
        &db,
        &session_id,
        SessionReadOptions {
            message_before: Some(1),
            message_limit: Some(1),
            ..Default::default()
        },
    )
    .unwrap()
    .unwrap();
    assert_eq!(page.messages.len(), 1);
    assert_eq!(
        serde_json::to_value(&page.messages[0]).unwrap()["responseLayout"],
        layout
    );
}
