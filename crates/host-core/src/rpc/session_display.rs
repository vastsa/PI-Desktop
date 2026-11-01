//! Display-only turn attribution from the authoritative session index.
use super::{rpc_err, JsonRpcError};
use crate::{db::Database, sessions::SessionDetail};
use rusqlite::{params, OptionalExtension};
use serde_json::Value;

pub fn serialize(db: &Database, detail: Option<SessionDetail>) -> Result<Value, JsonRpcError> {
    let Some(detail) = detail else {
        return Ok(Value::Null);
    };
    let session_id = detail.summary.id.clone();
    let mut value = serde_json::to_value(detail)
        .map_err(|error| rpc_err(1000, error.to_string(), "INTERNAL"))?;
    let mut query = db
        .conn()
        .prepare_cached(
            "SELECT m.turn_id FROM messages m JOIN turns t ON t.id=m.turn_id
         WHERE m.session_id=?1 AND m.id=?2 AND t.session_id=?1",
        )
        .map_err(|error| rpc_err(1000, error.to_string(), "INTERNAL"))?;
    let mut stamp = |message: &mut Value| -> Result<(), JsonRpcError> {
        let Some(id) = message.get("id").and_then(Value::as_str) else {
            return Ok(());
        };
        let turn_id: Option<String> = query
            .query_row(params![session_id, id], |row| row.get(0))
            .optional()
            .map_err(|error| rpc_err(1000, error.to_string(), "INTERNAL"))?;
        if let Some(turn_id) = turn_id {
            message["turnId"] = Value::String(turn_id);
        }
        Ok(())
    };
    if let Some(messages) = value.get_mut("messages").and_then(Value::as_array_mut) {
        for message in messages {
            stamp(message)?;
        }
    }
    if let Some(parent) = value.get_mut("navigationParent") {
        stamp(parent)?;
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sessions::{self, UiMessage};
    use serde_json::json;

    #[test]
    fn turn_ids_survive_display_reload_and_bounded_history_without_user_rows() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("app.sqlite")).unwrap();
        let session = sessions::create_session(&db, None, None, None, None, None).unwrap();
        let first = sessions::begin_turn(&db, &session.id, None, None).unwrap();
        let message = |id: &str| {
            serde_json::from_value::<UiMessage>(json!({
                "id": id, "role": "assistant", "content": id,
                "createdAt": "2026-11-01T00:00:00Z", "status": "complete"
            }))
            .unwrap()
        };
        sessions::append_message(&db, &session.id, &message("first"), Some(&first)).unwrap();
        db.conn()
            .execute(
                "UPDATE turns SET status='completed' WHERE id=?1",
                params![first],
            )
            .unwrap();
        let second = sessions::begin_turn(&db, &session.id, None, None).unwrap();
        sessions::append_message(&db, &session.id, &message("second"), Some(&second)).unwrap();
        drop(db);
        let db = Database::open(&dir.path().join("app.sqlite")).unwrap();
        let detail = sessions::get_session_with_options(
            &db,
            &session.id,
            sessions::SessionReadOptions::default(),
        )
        .unwrap();
        let full = serialize(&db, detail).unwrap();
        assert_eq!(full["messages"][0]["turnId"], first);
        assert_eq!(full["messages"][1]["turnId"], second);
        assert!(full["messages"]
            .as_array()
            .unwrap()
            .iter()
            .all(|row| row["role"] == "assistant"));
        let detail = sessions::get_session_with_options(
            &db,
            &session.id,
            sessions::SessionReadOptions {
                message_limit: Some(1),
                ..Default::default()
            },
        )
        .unwrap();
        let page = serialize(&db, detail).unwrap();
        assert_eq!(page["messages"][0]["turnId"], second);
    }
}
