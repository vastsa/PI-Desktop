//! Optional current-turn inbox. The host records acceptance before acknowledging
//! it; the runtime pulls only at an actual, non-interrupting model boundary.
use super::{permissions, repository, settlement, string};
use crate::{
    db::{now_ms, Database},
    sessions::{self, UiMessage},
    turn_queue::{self, QueuedTurnInput},
};
use anyhow::{anyhow, Result};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};

const SETTING: &str = "sessionMessagesInCurrentTurn";
const MAX_ACCEPTED_PER_TURN: i64 = 128;

fn enabled(db: &Database) -> Result<bool> {
    Ok(db
        .get_setting("app")?
        .and_then(|v| v.get(SETTING).and_then(Value::as_bool))
        == Some(true))
}

/// Called only when a new message is inserted, never when an existing queued
/// message is retried or when the opt-in is changed.
pub(super) fn offer_new(db: &Database, message: &repository::Message) -> Result<()> {
    if message.kind == "task" || !enabled(db)? {
        return Ok(());
    }
    db.conn().execute(
        "INSERT INTO session_collaboration_current_turn(message_id,turn_id,state,created_at)
         SELECT ?1,t.id,'offered',?3 FROM turns t
         WHERE t.session_id=?2 AND t.status='running'
         ORDER BY t.started_at DESC,t.rowid DESC LIMIT 1",
        params![message.id, message.target_session_id, now_ms()],
    )?;
    Ok(())
}

fn input(message: &repository::Message) -> Result<UiMessage> {
    Ok(serde_json::from_value(json!({
        "id": format!("session-message:{}", message.id),
        "role": "user", "content": message.content, "createdAt": message.created_at,
        "sessionMessage": repository::origin(message)
    }))?)
}

fn accepted(
    db: &Database,
    session: &str,
    turn: &str,
    request: &str,
) -> Result<Vec<repository::Message>> {
    Ok(db
        .conn()
        .prepare_cached(&format!(
            "{} WHERE target_session_id=?1 AND id IN (
         SELECT message_id FROM session_collaboration_current_turn
         WHERE turn_id=?2 AND state='accepted' AND request_id=?3)
         ORDER BY created_at,rowid",
            repository::SELECT,
        ))?
        .query_map(params![session, turn, request], repository::row)?
        .collect::<rusqlite::Result<Vec<_>>>()?)
}

/// Internal runtime-only RPC. enabledPluginIds is replaced by the RPC router
/// from the host registry, not trusted from sidecar/plugin input.
pub(super) fn receive(db: &Database, value: &Value) -> Result<Value> {
    let session = string(value, "sessionId", 256)?;
    let turn = string(value, "turnId", 256)?;
    let request = string(value, "requestId", 256)?;
    let mut messages = accepted(db, session, turn, request)?;
    if messages.is_empty() {
        let live: bool = db.conn().query_row(
            "SELECT EXISTS(SELECT 1 FROM turns t JOIN sessions s ON s.id=t.session_id
             WHERE t.id=?1 AND t.session_id=?2 AND t.status='running'
             AND s.deleted_at IS NULL AND s.mode='agent'
             AND NOT EXISTS(SELECT 1 FROM plan_approvals p WHERE p.session_id=s.id AND p.status='pending'))",
            params![turn, session], |row| row.get(0),
        )?;
        if !live || !enabled(db)? {
            return Ok(json!({"messages":[]}));
        }
        let count: i64 = db.conn().query_row(
            "SELECT COUNT(*) FROM session_collaboration_current_turn WHERE turn_id=?1 AND state='accepted'",
            params![turn], |row| row.get(0),
        )?;
        let candidates = db.conn().prepare_cached(&format!(
            "{} WHERE target_session_id=?1 AND status='queued' AND id IN (
             SELECT message_id FROM session_collaboration_current_turn WHERE turn_id=?2 AND state='offered')
             ORDER BY created_at,rowid LIMIT 8", repository::SELECT,
        ))?.query_map(params![session, turn], repository::row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let plugins = value.get("enabledPluginIds").and_then(Value::as_array);
        let tx = db.conn().unchecked_transaction()?;
        for (index, message) in candidates.iter().enumerate() {
            let allowed = plugins.is_some_and(|plugins| {
                plugins
                    .iter()
                    .any(|id| id.as_str() == Some(message.plugin_id.as_str()))
            }) && permissions::check_target(db, session, &message.permission_ceiling)
                .is_ok()
                && count + (index as i64) < MAX_ACCEPTED_PER_TURN;
            if !allowed {
                // Normal admission rechecks permission and reports its error;
                // the recipient's unrelated running task is not failed here.
                db.conn().execute(
                    "UPDATE session_collaboration_current_turn SET state='fallback' WHERE message_id=?1 AND state='offered'",
                    params![message.id],
                )?;
                continue;
            }
            db.conn().execute(
                "UPDATE session_collaboration_current_turn SET state='accepted',request_id=?2
                 WHERE message_id=?1 AND state='offered'",
                params![message.id, request],
            )?;
            db.conn().execute(
                "UPDATE session_collaboration_messages SET status='running',updated_at=?2 WHERE id=?1 AND status='queued'",
                params![message.id, now_ms()],
            )?;
        }
        tx.commit()?;
        messages = accepted(db, session, turn, request)?;
    }
    // The durable receipt precedes the file write. A retry (even after a lost
    // reply) repairs the same deterministic transcript ID, not a new prompt.
    let mut inputs = Vec::new();
    for message in messages {
        let ui = input(&message)?;
        sessions::append_message(db, session, &ui, Some(turn))?;
        inputs.push(ui);
    }
    Ok(json!({"messages":inputs}))
}

/// CAS release: a lost acknowledgement must never requeue an accepted input.
pub(super) fn release(db: &Database, value: &Value) -> Result<Value> {
    let id = string(value, "messageId", 256)?;
    let turn = string(value, "turnId", 256)?;
    db.conn().execute(
        "UPDATE session_collaboration_current_turn SET state='fallback'
         WHERE message_id=?1 AND turn_id=?2 AND state='offered'",
        params![id, turn],
    )?;
    Ok(json!({"message":repository::get(db,id)?}))
}

pub(super) fn prepare_append(
    db: &Database,
    session: &str,
    ui: &UiMessage,
    turn: Option<&str>,
) -> Result<Option<UiMessage>> {
    let Some(id) = ui.id.strip_prefix("session-message:") else {
        return Ok(None);
    };
    let Some(message) = repository::get(db, id)? else {
        return Ok(None);
    };
    let Some(receipt) = &message.current_turn else {
        return Ok(None);
    };
    if receipt.state != "accepted"
        || Some(receipt.turn_id.as_str()) != turn
        || message.target_session_id != session
        || ui.role != "user"
        || ui.parent_tool_call_id.is_some()
        || ui.steering == Some(true)
        || ui.content != message.content
        || ui.attachments.as_ref().is_some_and(|a| !a.is_empty())
    {
        return Err(anyhow!(
            "PERMISSION_DENIED: input does not match its current-turn receipt"
        ));
    }
    let mut canonical = ui.clone();
    canonical.session_message = Some(repository::origin(&message));
    Ok(Some(canonical))
}

pub(super) fn settle(db: &Database, turn: &str) -> Result<()> {
    let outcome: Option<(String, Option<String>)> = db
        .conn()
        .query_row(
            "SELECT status,error_code FROM turns WHERE id=?1 AND status!='running'",
            params![turn],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((status, error)) = outcome else {
        return Ok(());
    };
    let status = match status.as_str() {
        "completed" => "completed",
        "error" => "failed",
        _ => "cancelled",
    };
    let report = if status == "completed" {
        db.conn().query_row(
            "SELECT text FROM messages WHERE turn_id=?1 AND role='assistant' ORDER BY seq DESC LIMIT 1",
            params![turn], |row| row.get::<_, Option<String>>(0),
        ).optional()?.flatten().map(|text| repository::bounded(&text, 12_000))
    } else {
        None
    };
    let tx = db.conn().unchecked_transaction()?;
    db.conn().execute(
        "UPDATE session_collaboration_current_turn SET state='fallback' WHERE turn_id=?1 AND state='offered'",
        params![turn],
    )?;
    let messages = db.conn().prepare_cached(&format!(
        "{} WHERE status='running' AND id IN (SELECT message_id FROM session_collaboration_current_turn
         WHERE turn_id=?1 AND state='accepted')", repository::SELECT,
    ))?.query_map(params![turn], repository::row)?.collect::<rusqlite::Result<Vec<_>>>()?;
    for message in messages {
        db.conn().execute(
            "UPDATE session_collaboration_messages SET status=?2,result=?3,error=?4,updated_at=?5 WHERE id=?1",
            params![message.id, status, report, error, now_ms()],
        )?;
        if let Some(updated) = repository::get(db, &message.id)? {
            settlement::callback(db, &updated)?;
        }
    }
    tx.commit()?;
    Ok(())
}

// Same stable UTF-16 hash used by Agent Host hashInput. Recovery creates the
// ordinary durable queue row so restore() holds it until a controller attaches.
fn input_hash(message: &repository::Message) -> Result<String> {
    let encoded = format!(
        "{{\"text\":{},\"attachments\":[],\"sessionMessageId\":{}}}",
        serde_json::to_string(&message.content)?,
        serde_json::to_string(&message.id)?
    );
    let mut hash = 5381u32;
    let mut length = 0;
    for unit in encoded.encode_utf16() {
        hash = hash.wrapping_mul(33).wrapping_add(u32::from(unit));
        length += 1;
    }
    Ok(format!("{length}:{hash:x}"))
}

pub(super) fn recover(db: &Database) -> Result<()> {
    let pending = db
        .conn()
        .prepare_cached(&format!(
            "{} WHERE status IN ('queued','running') AND id IN (
         SELECT message_id FROM session_collaboration_current_turn)",
            repository::SELECT,
        ))?
        .query_map([], repository::row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for message in pending {
        let Some(receipt) = &message.current_turn else {
            continue;
        };
        if receipt.state == "accepted" {
            // Adoption is known even if both the RPC reply and transcript append
            // were lost. Preserve the input; never manufacture a second turn.
            sessions::append_message(
                db,
                &message.target_session_id,
                &input(&message)?,
                Some(&receipt.turn_id),
            )?;
            continue;
        }
        if message.status != "queued" {
            continue;
        }
        db.conn().execute(
            "UPDATE session_collaboration_current_turn SET state='fallback' WHERE message_id=?1 AND state='offered'",
            params![message.id],
        )?;
        let queued: bool = db.conn().query_row(
            "SELECT EXISTS(SELECT 1 FROM turn_queue WHERE session_message_id=?1)",
            params![message.id],
            |row| row.get(0),
        )?;
        if queued {
            continue;
        }
        let result = turn_queue::push(
            db,
            QueuedTurnInput {
                id: None,
                session_id: message.target_session_id.clone(),
                principal: "desktop".into(),
                idempotency_key: Some(format!("session-message:{}", message.id)),
                input_hash: input_hash(&message)?,
                content: message.content.clone(),
                session_message_id: Some(message.id.clone()),
                attachments: None,
                permission_mode: permissions::effective_mode(db, &message.target_session_id)?,
            },
        );
        if let Err(error) = result {
            if error.to_string() != "QUEUE_FULL" {
                return Err(error);
            }
            // A full restored queue is held. Keep this durable fallback pending
            // until normal queue draining makes room; never drop or auto-start it.
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;
