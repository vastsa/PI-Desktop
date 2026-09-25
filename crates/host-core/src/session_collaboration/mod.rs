//! Durable provenance, idempotent delivery and turn-bound outcomes. Execution
//! remains owned by Agent Host; this module never starts a runtime.
use anyhow::{anyhow, Result};
use rusqlite::params;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    db::{ms_to_ts, now_ms, Database},
    sessions,
};
mod permissions;
mod projections;
mod provenance;
mod repository;
mod settlement;
pub use provenance::{prepare_append, validate_replacement};
pub use repository::{get, Message};
pub use settlement::{begin_turn, begin_turn_with_permission_ceiling, recover, settle_turn};
pub const SCHEMA: &str = include_str!("schema.sql");

pub(super) fn string<'a>(input: &'a Value, key: &str, limit: usize) -> Result<&'a str> {
    let value = input
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow!("INVALID_ARGUMENT: {key} required"))?;
    if value.chars().count() > limit {
        return Err(anyhow!("LIMIT_EXCEEDED: {key} too long"));
    }
    Ok(value)
}

fn send_record(db: &Database, input: &Value, target: &str, kind: &str) -> Result<Message> {
    let source = string(input, "sourceSessionId", 256)?;
    let plugin = string(input, "pluginId", 256)?;
    let content = string(input, "content", 65_536)?;
    let key = string(input, "idempotencyKey", 256)?;
    let notify = input
        .get("notifyOnCompletion")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    if let Some(existing) = repository::existing(db, plugin, source, key)? {
        if existing.target_session_id != target
            || existing.content != content
            || existing.kind != kind
            || existing.notify_on_completion != notify
        {
            return Err(anyhow!(
                "IDEMPOTENCY_CONFLICT: key was already used for another message"
            ));
        }
        return Ok(existing);
    }
    if source == target {
        return Err(anyhow!(
            "INVALID_ARGUMENT: cannot send a session message to itself"
        ));
    }
    if sessions::session_mode(db, source)?.as_deref() != Some("agent")
        || sessions::session_mode(db, target)?.as_deref() != Some("agent")
    {
        return Err(anyhow!(
            "PERMISSION_DENIED: session communication requires Agent mode"
        ));
    }
    let permission_ceiling = permissions::effective_mode(db, source)?;
    permissions::check_target(db, target, &permission_ceiling)?;
    let pending: i64 = db.conn().query_row(
        "SELECT COUNT(*) FROM session_collaboration_messages
        WHERE target_session_id=?1 AND status='queued'",
        params![target],
        |row| row.get(0),
    )?;
    if pending >= 8 {
        return Err(anyhow!("AGENT_BUSY: target session inbox is full"));
    }
    let at = ms_to_ts(now_ms());
    let message = Message {
        id: Uuid::new_v4().to_string(),
        plugin_id: plugin.into(),
        source_session_id: source.into(),
        source_title: repository::title(db, source)?,
        target_session_id: target.into(),
        target_title: repository::title(db, target)?,
        kind: kind.into(),
        content: content.into(),
        status: "queued".into(),
        notify_on_completion: notify,
        turn_id: None,
        reply_to_message_id: None,
        result: None,
        error: None,
        created_at: at.clone(),
        updated_at: at,
        remaining_hops: repository::remaining_hops(
            db,
            source,
            input.get("sourceTurnId").and_then(Value::as_str),
        )?,
        permission_ceiling,
    };
    repository::insert(db, &message, key)?;
    Ok(message)
}

fn spawn(db: &Database, input: &Value) -> Result<Value> {
    let source = string(input, "sourceSessionId", 256)?;
    let plugin = string(input, "pluginId", 256)?;
    let key = string(input, "idempotencyKey", 256)?;
    let content = string(input, "content", 65_536)?;
    if let Some(existing) = repository::existing(db, plugin, source, key)? {
        if existing.content != content || existing.kind != "task" {
            return Err(anyhow!("IDEMPOTENCY_CONFLICT"));
        }
        return Ok(json!({"message":existing,"sessionId":existing.target_session_id}));
    }
    // Worker limits are read inside the transaction so the counts cannot go
    // stale between the check and the session/link inserts below.
    let tx = db.conn().unchecked_transaction()?;
    let is_worker: bool = db.conn().query_row(
        "SELECT EXISTS(SELECT 1 FROM session_collaboration_links WHERE session_id=?1)",
        params![source],
        |row| row.get(0),
    )?;
    if is_worker {
        return Err(anyhow!("PERMISSION_DENIED: workers may message existing sessions but cannot create further workers"));
    }
    let (parent_active,plugin_active): (i64,i64) = db.conn().query_row(
        "SELECT COALESCE(SUM(l.created_by_session_id=?1),0),COUNT(*) FROM session_collaboration_links l
        WHERE l.plugin_id=?2 AND (EXISTS(SELECT 1 FROM turns t WHERE t.session_id=l.session_id AND t.status='running')
        OR EXISTS(SELECT 1 FROM session_collaboration_messages m WHERE m.target_session_id=l.session_id AND m.status IN ('queued','running')))",
        params![source,plugin],|row|Ok((row.get(0)?,row.get(1)?)))?;
    if parent_active >= 4 || plugin_active >= 16 {
        return Err(anyhow!("LIMIT_EXCEEDED: active worker limit reached"));
    }
    let parent = sessions::get_session_with_options(
        db,
        source,
        sessions::SessionReadOptions {
            message_limit: Some(1),
            content_limit: Some(1),
            ..Default::default()
        },
    )?
    .ok_or_else(|| anyhow!("NOT_FOUND: parent session"))?;
    let created = sessions::create_session_with_options(
        db,
        sessions::SessionCreateOptions {
            title: Some(
                input
                    .get("title")
                    .and_then(Value::as_str)
                    .map(|value| repository::bounded(value, 80))
                    .unwrap_or_else(|| repository::bounded(content, 80)),
            ),
            mode: Some("agent".into()),
            provider_id: input
                .get("providerId")
                .and_then(Value::as_str)
                .map(str::to_owned),
            model_id: input
                .get("modelId")
                .and_then(Value::as_str)
                .map(str::to_owned),
            project_path: parent.summary.project_path,
            thinking_level: Some(parent.summary.thinking_level),
            permission_mode: Some(parent.summary.permission_mode),
        },
    )?;
    db.conn().execute("INSERT INTO session_collaboration_links(session_id,created_by_session_id,plugin_id,created_at) VALUES(?1,?2,?3,?4)",params![created.id,source,plugin,now_ms()])?;
    let message = send_record(db, input, &created.id, "task")?;
    tx.commit()?;
    Ok(json!({"sessionId":created.id,"message":message}))
}

pub fn handle(db: &Database, method: &str, input: &Value) -> Result<Value> {
    match method {
        "session.collaboration.spawn" => spawn(db, input),
        "session.collaboration.send" => {
            let target = string(input, "sessionId", 256)?;
            let kind = input
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or("message");
            if !matches!(kind, "task" | "message") {
                return Err(anyhow!("INVALID_ARGUMENT: invalid message kind"));
            }
            let tx = db.conn().unchecked_transaction()?;
            let message = send_record(db, input, target, kind)?;
            tx.commit()?;
            Ok(json!({"message":message}))
        }
        "session.collaboration.message" => {
            Ok(json!({"message":get(db,string(input,"messageId",256)?)?}))
        }
        "session.collaboration.status" => {
            projections::summary(db, string(input, "sessionId", 256)?)
        }
        "session.collaboration.list" => projections::list(db),
        "session.collaboration.result" => projections::result(db, input),
        "session.collaboration.pending" => Ok(
            json!({"messages":repository::pending_callbacks(db,input.get("sessionId").and_then(Value::as_str))?}),
        ),
        "session.collaboration.fail" => {
            let id = string(input, "messageId", 256)?;
            let tx = db.conn().unchecked_transaction()?;
            repository::fail_queued(db, id, string(input, "error", 2000)?)?;
            if let Some(message) = get(db, id)?.filter(|message| message.status == "failed") {
                settlement::callback(db, &message)?;
            }
            tx.commit()?;
            Ok(json!({"ok":true}))
        }
        "session.collaboration.settle" => {
            Ok(json!({"callback":settle_turn(db,string(input,"turnId",256)?)?}))
        }
        "session.collaboration.cancel" => settlement::cancel(db, input),
        _ => Err(anyhow!(
            "NOT_FOUND: unknown session collaboration operation"
        )),
    }
}

#[cfg(test)]
mod tests;
