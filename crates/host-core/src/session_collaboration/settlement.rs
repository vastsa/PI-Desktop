use super::{
    repository::{self, Message},
    string,
};
use crate::{
    db::{ms_to_ts, now_ms, Database},
    sessions,
};
use anyhow::{anyhow, Result};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use uuid::Uuid;

/// Claim the delivery and create its actual turn in the same transaction.
pub fn begin_turn(
    db: &Database,
    session_id: &str,
    message_id: &str,
    provider: Option<&str>,
    model: Option<&str>,
) -> Result<String> {
    let tx = db.conn().unchecked_transaction()?;
    let message =
        repository::get(db, message_id)?.ok_or_else(|| anyhow!("NOT_FOUND: session message"))?;
    if message.target_session_id != session_id {
        return Err(anyhow!(
            "PERMISSION_DENIED: message belongs to another session"
        ));
    }
    if message.status != "queued"
        || message
            .current_turn
            .as_ref()
            .is_some_and(|c| c.state != "fallback")
    {
        return Err(anyhow!(
            "CONFLICT: session message already claimed or settled"
        ));
    }
    super::permissions::check_target(db, session_id, &message.permission_ceiling)?;
    let turn = sessions::begin_turn(db, session_id, provider, model)?;
    let claimed = db.conn().execute("UPDATE session_collaboration_messages SET status='running',turn_id=?2,updated_at=?3 WHERE id=?1 AND status='queued'",
        params![message_id,turn,now_ms()])?;
    if claimed == 0 {
        // Another claim won the race; dropping the transaction rolls the turn back.
        return Err(anyhow!(
            "CONFLICT: session message already claimed or settled"
        ));
    }
    tx.commit()?;
    Ok(turn)
}

pub(super) fn callback(db: &Database, message: &Message) -> Result<Option<Message>> {
    if !message.notify_on_completion || message.kind == "completion" {
        return Ok(None);
    }
    let key = format!("completion:{}", message.id);
    if let Some(existing) =
        repository::existing(db, &message.plugin_id, &message.target_session_id, &key)?
    {
        return Ok(Some(existing));
    }
    // A removed sender cannot receive a callback. The original result stays queryable.
    let target_title: Option<String> = db
        .conn()
        .query_row(
            "SELECT title FROM sessions WHERE id=?1 AND deleted_at IS NULL",
            params![message.source_session_id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(target_title) = target_title else {
        return Ok(None);
    };
    let content = json!({"sessionId":message.target_session_id,"messageId":message.id,
        "turnId":message.turn_id,"status":message.status,"result":message.result,"error":message.error}).to_string();
    let at = ms_to_ts(now_ms());
    let receipt = Message {
        id: Uuid::new_v4().to_string(),
        plugin_id: message.plugin_id.clone(),
        source_session_id: message.target_session_id.clone(),
        source_title: message.target_title.clone(),
        target_session_id: message.source_session_id.clone(),
        target_title,
        kind: "completion".into(),
        content,
        status: "queued".into(),
        notify_on_completion: false,
        turn_id: None,
        reply_to_message_id: Some(message.id.clone()),
        result: None,
        error: None,
        created_at: at.clone(),
        updated_at: at,
        remaining_hops: message.remaining_hops.saturating_sub(1),
        permission_ceiling: message.permission_ceiling.clone(),
        current_turn: None,
    };
    repository::insert(db, &receipt, &key)?;
    super::current_turn::offer_new(db, &receipt)?;
    repository::get(db, &receipt.id)
}

/// Must be called after the transcript outbox and durable turn have settled.
/// Repeated terminal notifications return the same receipt, never a new one.
pub fn settle_turn(db: &Database, turn_id: &str) -> Result<Option<Message>> {
    super::current_turn::settle(db, turn_id)?;
    let original = db
        .conn()
        .prepare_cached(&format!("{} WHERE turn_id=?1", repository::SELECT))?
        .query_row(params![turn_id], repository::row)
        .optional()?;
    let Some(message) = original else {
        return Ok(None);
    };
    let (status, error): (String, Option<String>) = db.conn().query_row(
        "SELECT status,error_code FROM turns WHERE id=?1",
        params![turn_id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    let outcome = match status.as_str() {
        "completed" => "completed",
        "error" => "failed",
        "aborted" => "cancelled",
        _ => return Ok(None),
    };
    let report = if outcome == "completed" {
        db.conn().query_row("SELECT text FROM messages WHERE turn_id=?1 AND role='assistant' ORDER BY seq DESC LIMIT 1",
            params![turn_id],|row|row.get::<_,Option<String>>(0)).optional()?.flatten()
            .map(|text|repository::bounded(&text,12_000))
    } else {
        None
    };
    let tx = db.conn().unchecked_transaction()?;
    db.conn().execute("UPDATE session_collaboration_messages SET status=?2,result=?3,error=?4,updated_at=?5 WHERE id=?1",
        params![message.id,outcome,report,error,now_ms()])?;
    let updated =
        repository::get(db, &message.id)?.ok_or_else(|| anyhow!("NOT_FOUND: settled message"))?;
    let receipt = callback(db, &updated)?;
    tx.commit()?;
    Ok(receipt)
}

pub(super) fn cancel(db: &Database, input: &Value) -> Result<Value> {
    let id = string(input, "sessionId", 256)?;
    repository::title(db, id)?;
    let selected = input.get("messageId").and_then(Value::as_str);
    if let Some(message_id) = selected {
        let message = repository::get(db, message_id)?
            .ok_or_else(|| anyhow!("NOT_FOUND: session message"))?;
        if message.target_session_id != id {
            return Err(anyhow!(
                "PERMISSION_DENIED: message belongs to another session"
            ));
        }
    }
    let plugin = input.get("pluginId").and_then(Value::as_str);
    let source = input.get("sourceSessionId").and_then(Value::as_str);
    let candidates = db
        .conn()
        .prepare_cached(&format!(
            "{} WHERE target_session_id=?1
        AND status IN ('queued','running') AND (?2 IS NULL OR id=?2)",
            repository::SELECT
        ))?
        .query_map(params![id, selected], repository::row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let tx = db.conn().unchecked_transaction()?;
    let mut message_ids = Vec::new();
    let mut turn_ids = Vec::new();
    for mut message in candidates {
        if plugin.is_some_and(|plugin| plugin != message.plugin_id)
            || source.is_some_and(|source| source != message.source_session_id)
        {
            if selected.is_some() {
                return Err(anyhow!(
                    "PERMISSION_DENIED: cannot cancel another sender's message"
                ));
            }
            continue;
        }
        if message
            .current_turn
            .as_ref()
            .is_some_and(|c| c.state == "accepted")
        {
            // Accepted context cannot be recalled. In particular, canceling a
            // message must not abort the recipient's unrelated work/other workers.
            if selected.is_some() {
                return Err(anyhow!(
                    "CONFLICT: current-turn input has already been accepted"
                ));
            }
            continue;
        }
        if message.status == "running" {
            if let Some(turn) = message.turn_id {
                turn_ids.push(turn);
            }
        } else {
            db.conn().execute(
                "DELETE FROM turn_queue WHERE session_message_id=?1",
                params![message.id],
            )?;
            db.conn().execute("UPDATE session_collaboration_messages SET status='cancelled',updated_at=?2 WHERE id=?1 AND status='queued'",
                params![message.id,now_ms()])?;
            message.status = "cancelled".into();
            callback(db, &message)?;
            message_ids.push(message.id);
        }
    }
    tx.commit()?;
    Ok(
        json!({"sessionId":id,"cancelled":true,"sessionRetained":true,
        "messageIds":message_ids,"runningTurnIds":turn_ids}),
    )
}

/// The startup fence keeps received data but never replays an unclaimed or
/// interrupted operation. Existing turn_queue rows are restored held by Agent Host.
pub fn recover(db: &Database) -> Result<()> {
    super::current_turn::recover(db)?;
    db.conn().execute("UPDATE session_collaboration_messages SET status='interrupted',
        error='Execution interrupted by application restart',updated_at=?1 WHERE status='running'
        OR (status='queued' AND NOT EXISTS(SELECT 1 FROM turn_queue q WHERE q.session_message_id=session_collaboration_messages.id)
        AND NOT EXISTS(SELECT 1 FROM session_collaboration_current_turn c WHERE c.message_id=session_collaboration_messages.id))",
        params![now_ms()])?;
    Ok(())
}
