use anyhow::{anyhow, Result};
use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};

use crate::db::{ms_to_ts, now_ms, Database};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CurrentTurnDelivery {
    pub turn_id: String,
    pub state: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: String,
    pub plugin_id: String,
    pub source_session_id: String,
    pub source_title: String,
    pub target_session_id: String,
    pub target_title: String,
    pub kind: String,
    pub content: String,
    pub status: String,
    pub notify_on_completion: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_to_message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub permission_ceiling: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_turn: Option<CurrentTurnDelivery>,
    #[serde(skip)]
    pub remaining_hops: i64,
}

pub(super) const SELECT: &str = "SELECT id,plugin_id,source_session_id,source_title,
 target_session_id,target_title,kind,content,status,notify_on_completion,turn_id,
 reply_to_message_id,result,error,created_at,updated_at,remaining_hops,permission_ceiling,
 (SELECT c.turn_id FROM session_collaboration_current_turn c WHERE c.message_id=session_collaboration_messages.id),
 (SELECT c.state FROM session_collaboration_current_turn c WHERE c.message_id=session_collaboration_messages.id)
 FROM session_collaboration_messages";

pub(super) fn row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Message> {
    let current_turn = match row.get::<_, Option<String>>(18)? {
        Some(turn_id) => Some(CurrentTurnDelivery {
            turn_id,
            state: row.get(19)?,
        }),
        None => None,
    };
    let turn_id = row.get::<_, Option<String>>(10)?.or_else(|| {
        current_turn
            .as_ref()
            .filter(|receipt| receipt.state == "accepted")
            .map(|receipt| receipt.turn_id.clone())
    });
    Ok(Message {
        id: row.get(0)?,
        plugin_id: row.get(1)?,
        source_session_id: row.get(2)?,
        source_title: row.get(3)?,
        target_session_id: row.get(4)?,
        target_title: row.get(5)?,
        kind: row.get(6)?,
        content: row.get(7)?,
        status: row.get(8)?,
        notify_on_completion: row.get(9)?,
        turn_id,
        reply_to_message_id: row.get(11)?,
        result: row.get(12)?,
        error: row.get(13)?,
        created_at: ms_to_ts(row.get(14)?),
        updated_at: ms_to_ts(row.get(15)?),
        remaining_hops: row.get(16)?,
        permission_ceiling: row.get(17)?,
        current_turn,
    })
}

pub fn get(db: &Database, id: &str) -> Result<Option<Message>> {
    Ok(db
        .conn()
        .prepare_cached(&format!("{SELECT} WHERE id=?1"))?
        .query_row(params![id], row)
        .optional()?)
}

pub(super) fn existing(
    db: &Database,
    plugin: &str,
    source: &str,
    key: &str,
) -> Result<Option<Message>> {
    Ok(db
        .conn()
        .prepare_cached(&format!(
            "{SELECT} WHERE plugin_id=?1 AND source_session_id=?2 AND idempotency_key=?3"
        ))?
        .query_row(params![plugin, source, key], row)
        .optional()?)
}

pub(super) fn title(db: &Database, id: &str) -> Result<String> {
    db.conn()
        .query_row(
            "SELECT title FROM sessions WHERE id=?1 AND deleted_at IS NULL",
            params![id],
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(|| anyhow!("NOT_FOUND: session {id}"))
}

pub(super) fn bounded(value: &str, limit: usize) -> String {
    value.chars().take(limit).collect()
}

pub(super) fn insert(db: &Database, message: &Message, key: &str) -> Result<()> {
    db.conn().execute(
        "INSERT INTO session_collaboration_messages
        (id,plugin_id,source_session_id,source_title,target_session_id,target_title,kind,content,
         status,notify_on_completion,turn_id,reply_to_message_id,idempotency_key,remaining_hops,
         result,error,created_at,updated_at,permission_ceiling)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?17,?18)",
        params![
            message.id,
            message.plugin_id,
            message.source_session_id,
            message.source_title,
            message.target_session_id,
            message.target_title,
            message.kind,
            message.content,
            message.status,
            message.notify_on_completion,
            message.turn_id,
            message.reply_to_message_id,
            key,
            message.remaining_hops,
            message.result,
            message.error,
            now_ms(),
            message.permission_ceiling
        ],
    )?;
    Ok(())
}

pub(super) fn recent(db: &Database, id: &str, limit: usize) -> Result<Vec<Message>> {
    let mut statement = db.conn().prepare_cached(&format!("{SELECT}
        WHERE source_session_id=?1 OR target_session_id=?1 ORDER BY created_at DESC,rowid DESC LIMIT ?2"))?;
    let values = statement
        .query_map(params![id, limit as i64], row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(values)
}

pub(super) fn latest_incoming(
    db: &Database,
    id: &str,
    turn: Option<&str>,
) -> Result<Option<Message>> {
    Ok(db
        .conn()
        .prepare_cached(&format!(
            "{SELECT}
        WHERE target_session_id=?1 AND (?2 IS NULL OR turn_id=?2 OR EXISTS(
          SELECT 1 FROM session_collaboration_current_turn c WHERE c.message_id=session_collaboration_messages.id
          AND c.turn_id=?2 AND c.state='accepted'))
        ORDER BY created_at DESC,rowid DESC LIMIT 1"
        ))?
        .query_row(params![id, turn], row)
        .optional()?)
}

pub fn pending_callbacks(db: &Database, session_id: Option<&str>) -> Result<Vec<Message>> {
    let mut statement = db.conn().prepare_cached(&format!(
        "{SELECT}
        WHERE (kind='completion' OR EXISTS(SELECT 1 FROM session_collaboration_current_turn c
          WHERE c.message_id=session_collaboration_messages.id))
        AND status='queued' AND (?1 IS NULL OR target_session_id=?1)
        ORDER BY created_at LIMIT 64"
    ))?;
    let values = statement
        .query_map(params![session_id], row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(values)
}

pub fn fail_queued(db: &Database, id: &str, error: &str) -> Result<()> {
    db.conn().execute(
        "UPDATE session_collaboration_messages SET status='failed',error=?2,updated_at=?3
        WHERE id=?1 AND status='queued'",
        params![id, bounded(error, 2000), now_ms()],
    )?;
    Ok(())
}

pub fn origin(message: &Message) -> Value {
    let mut value = json!({"messageId":message.id,"sourceSessionId":message.source_session_id,
        "sourceTitle":message.source_title,"targetSessionId":message.target_session_id,"kind":message.kind});
    if let Some(reply) = &message.reply_to_message_id {
        value["replyToMessageId"] = json!(reply);
    }
    value
}

pub(super) fn remaining_hops(db: &Database, source: &str, turn: Option<&str>) -> Result<i64> {
    if let Some(turn) = turn {
        let current: bool = db.conn().query_row(
            "SELECT EXISTS(SELECT 1 FROM turns WHERE id=?1 AND session_id=?2 AND status='running')",
            params![turn, source],
            |row| row.get(0),
        )?;
        if !current {
            return Err(anyhow!(
                "PERMISSION_DENIED: sending turn is no longer active"
            ));
        }
    }
    let remaining: Option<i64> = db.conn().query_row(
        "SELECT MIN(m.remaining_hops) FROM session_collaboration_messages m
         LEFT JOIN session_collaboration_current_turn c ON c.message_id=m.id AND c.state='accepted'
         JOIN turns t ON t.id=COALESCE(m.turn_id,c.turn_id)
         WHERE t.session_id=?1 AND t.status='running' AND (?2 IS NULL OR t.id=?2)",
        params![source, turn],
        |row| row.get(0),
    )?;
    let budget = remaining.unwrap_or(9) - 1;
    if budget < 1 {
        return Err(anyhow!(
            "LIMIT_EXCEEDED: autonomous communication limit reached; await user input"
        ));
    }
    Ok(budget)
}
