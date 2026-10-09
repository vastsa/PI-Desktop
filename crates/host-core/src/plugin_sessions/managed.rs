//! Live external transcripts are plugin-owned and never execute through the host agent.
use super::*;

pub fn create(db: &Database, plugin_id: &str, params: &Value) -> Result<Value> {
    validate_payload(params)?;
    let source = required_text(
        params
            .get("source")
            .and_then(Value::as_str)
            .unwrap_or_default(),
        "source",
        MAX_SOURCE_CHARS,
    )?;
    let external_id = required_text(
        params
            .get("externalId")
            .and_then(Value::as_str)
            .unwrap_or_default(),
        "externalId",
        MAX_EXTERNAL_ID_CHARS,
    )?;
    if let Some(id) = find_origin(db, plugin_id, &source, &external_id)? {
        if owner(db, &id)? != Some(plugin_id.to_string()) {
            return Err(code_error(
                "CONFLICT",
                "externalId already belongs to an imported session",
            ));
        }
        if own_session_row(db, plugin_id, &id)?.is_none() {
            return Err(not_found("managed session is deleted"));
        }
        return Ok(json!({"sessionId": id, "created": false}));
    }
    let mut input = params.clone();
    let timestamp = ms_to_ts(now_ms());
    input["createdAt"] = json!(timestamp);
    input["updatedAt"] = json!(timestamp);
    input["messages"] = json!([]);
    let label = parse_source_label(params)?;
    let mut prepared = prepare_import(db, &input, Uuid::new_v4().to_string(), label)?;
    let mut origin: Value = serde_json::from_str(&prepared.origin_json)?;
    origin["managed"] = json!(true);
    prepared.origin_json = serde_json::to_string(&origin)?;
    write_and_index(db, plugin_id, &source, label, &prepared)?;
    Ok(json!({"sessionId": prepared.session_id, "created": true}))
}

/// Read only the durable origin sidecar; disabled/uninstalled plugins keep ownership.
pub fn owner(db: &Database, session_id: &str) -> Result<Option<String>> {
    let row: Option<(String, String)> = db
        .conn()
        .query_row(
            "SELECT plugin_id, origin_json FROM session_import_origins WHERE session_id = ?1",
            params![session_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((plugin_id, raw)) = row else {
        return Ok(None);
    };
    let origin: Value = serde_json::from_str(&raw)?;
    Ok((origin.get("managed").and_then(Value::as_bool) == Some(true)).then_some(plugin_id))
}

pub fn append(db: &Database, plugin_id: &str, params: &Value) -> Result<Value> {
    validate_payload(params)?;
    let session_id = required_text(
        params
            .get("sessionId")
            .and_then(Value::as_str)
            .unwrap_or_default(),
        "sessionId",
        128,
    )?;
    if owner(db, &session_id)?.as_deref() != Some(plugin_id)
        || own_session_row(db, plugin_id, &session_id)?.is_none()
    {
        return Err(not_found("managed session not found"));
    }
    let external_id = required_text(
        params
            .get("externalId")
            .and_then(Value::as_str)
            .unwrap_or_default(),
        "externalId",
        MAX_EXTERNAL_ID_CHARS,
    )?;
    let input: PluginMessageInput = serde_json::from_value(
        params
            .get("message")
            .cloned()
            .ok_or_else(|| invalid("message required"))?,
    )?;
    // Imported tool-call ids are local to this transcript and stable across retries.
    let mut calls = HashMap::new();
    if let Some(id) = &input.tool_call_id {
        let id = id.trim();
        calls.insert(id.to_string(), format!("plugin:{session_id}:tool:{id}"));
    }
    let mut message = parse_message(&input, &mut None, &mut calls)?;
    message.id = format!("plugin:{session_id}:{external_id}");
    message.status = Some("complete".into());
    if let Some(author) = params.get("author") {
        message.agent_name = Some(required_text(
            author
                .as_str()
                .ok_or_else(|| invalid("author must be a string"))?,
            "author",
            256,
        )?);
    }
    let (record, _) = sessions::ui_to_record(&message);
    let existing = transcripts::read_transcript(db.data_dir(), &session_id)?
        .into_iter()
        .find(|item| item.id == message.id);
    if let Some(existing) = existing {
        if serde_json::to_value(existing)? != serde_json::to_value(record)? {
            return Err(code_error(
                "CONFLICT",
                "externalId has different message content",
            ));
        }
        let indexed: bool = db.conn().query_row(
            "SELECT EXISTS(SELECT 1 FROM messages WHERE session_id = ?1 AND id = ?2)",
            params![session_id, message.id],
            |row| row.get(0),
        )?;
        if !indexed {
            return Err(code_error(
                "INTERNAL",
                "managed transcript index needs recovery",
            ));
        }
        return Ok(json!({"messageId": message.id, "appended": false}));
    }
    sessions::append_message(db, &session_id, &message, None)?;
    Ok(json!({"messageId": message.id, "appended": true}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn managed_user_path_is_owned_durable_and_idempotent() {
        let temp = tempfile::tempdir().unwrap();
        let db = Database::open(&temp.path().join("test.sqlite")).unwrap();
        let request = json!({"source":"room", "externalId":"room-one", "title":"Room"});
        let first = create(&db, "plugin.one", &request).unwrap();
        let id = first["sessionId"].as_str().unwrap();
        assert_eq!(
            sessions::list_sessions(&db).unwrap()[0]
                .managed_by_plugin
                .as_deref(),
            Some("plugin.one")
        );
        assert_eq!(
            create(&db, "plugin.one", &request).unwrap()["sessionId"],
            id
        );
        assert_eq!(owner(&db, id).unwrap().as_deref(), Some("plugin.one"));
        let message = json!({"sessionId":id,"externalId":"message-one","author":"Remote member","message":{"role":"user","content":"hello","createdAt":"2026-10-08T00:00:00Z"}});
        assert!(append(&db, "plugin.two", &message).is_err());
        assert_eq!(
            append(&db, "plugin.one", &message).unwrap()["appended"],
            true
        );
        assert_eq!(
            append(&db, "plugin.one", &message).unwrap()["appended"],
            false
        );
        let mut conflict = message.clone();
        conflict["message"]["content"] = json!("changed");
        assert!(append(&db, "plugin.one", &conflict)
            .unwrap_err()
            .to_string()
            .starts_with("CONFLICT"));
        assert_eq!(
            sessions::get_session(&db, id)
                .unwrap()
                .unwrap()
                .messages
                .len(),
            1
        );
        drop(db);
        let db = Database::open(&temp.path().join("test.sqlite")).unwrap();
        assert_eq!(owner(&db, id).unwrap().as_deref(), Some("plugin.one"));
        assert_eq!(
            append(&db, "plugin.one", &message).unwrap()["appended"],
            false
        );
        super::super::delete(&db, "plugin.one", &json!({"sessionId":id,"mode":"trash"})).unwrap();
        assert_eq!(owner(&db, id).unwrap().as_deref(), Some("plugin.one"));
        assert!(append(&db, "plugin.one", &message).is_err());
        assert!(create(&db, "plugin.one", &request).is_err());
    }
    #[test]
    fn whitespace_tool_identity_retries_without_conflict() {
        let temp = tempfile::tempdir().unwrap();
        let db = Database::open(&temp.path().join("test.sqlite")).unwrap();
        let session = create(
            &db,
            "plugin.one",
            &json!({"source":"room","externalId":"one","title":"Room"}),
        )
        .unwrap();
        let id = session["sessionId"].as_str().unwrap();
        let input = json!({"sessionId":id,"externalId":"tool-one","message":{"role":"tool","content":"done","createdAt":"2026-10-08T00:00:00Z","toolName":"Read","toolCallId":" call-one ","toolStatus":"success"}});
        assert_eq!(append(&db, "plugin.one", &input).unwrap()["appended"], true);
        assert_eq!(
            append(&db, "plugin.one", &input).unwrap()["appended"],
            false
        );
    }
}
