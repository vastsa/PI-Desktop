//! Read-only completed-turn facts for plugins (`usage.read`).
//!
//! One flat row per completed turn of a non-deleted session: identifiers and
//! token counters only. No message body, no transcript, no dashboard shape.

use anyhow::{anyhow, Result};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use rusqlite::params;
use serde::Serialize;
use serde_json::{json, Value};

use crate::db::{now_ms, Database};

const DEFAULT_LIMIT: i64 = 200;
const MAX_LIMIT: i64 = 500;
const DEFAULT_WINDOW_MS: i64 = 30 * 24 * 3600 * 1000;
const MAX_WINDOW_MS: i64 = 365 * 24 * 3600 * 1000;

fn invalid(message: impl Into<String>) -> anyhow::Error {
    anyhow!("INVALID_PARAMS: {}", message.into())
}

pub(crate) struct PluginUsageCursor {
    ended_at: i64,
    id: String,
}

pub(crate) struct PluginUsageTurnQuery<'a> {
    pub from_ms: i64,
    pub to_ms: i64,
    pub session_id: Option<&'a str>,
    pub project_id: Option<i64>,
    pub cursor: Option<PluginUsageCursor>,
    pub limit: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginUsageTurn {
    pub turn_id: String,
    pub session_id: String,
    pub session_title: Option<String>,
    pub project_id: Option<i64>,
    pub provider_id: Option<String>,
    pub model_id: Option<String>,
    pub started_at: i64,
    pub ended_at: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    pub reasoning_tokens: i64,
}

pub(crate) fn encode_cursor(ended_at: i64, id: &str) -> String {
    B64.encode(format!("v1:{ended_at}:{id}"))
}

pub(crate) fn decode_cursor(raw: &str) -> Result<PluginUsageCursor> {
    let decoded = B64
        .decode(raw)
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .and_then(|text| {
            let rest = text.strip_prefix("v1:")?;
            let (ended, id) = rest.split_once(':')?;
            let ended = ended.parse::<i64>().ok()?;
            if id.is_empty() {
                return None;
            }
            Some(PluginUsageCursor {
                ended_at: ended,
                id: id.to_string(),
            })
        });
    decoded.ok_or_else(|| invalid("cursor is invalid"))
}

/// Absent/null bounds fall back to the last 30 days ending now. An explicit
/// pair may span at most 365 days and must be ordered. `toMs: null` is the
/// same as omitting the field (unlike a typed non-integer, which is rejected).
pub(crate) fn window_params(params: &Value) -> Result<(i64, i64)> {
    let to_ms = match params.get("toMs") {
        None | Some(Value::Null) => now_ms(),
        Some(value) => value
            .as_i64()
            .filter(|ms| *ms >= 0)
            .ok_or_else(|| invalid("toMs must be a non-negative integer"))?,
    };
    let from_ms = match params.get("fromMs") {
        None | Some(Value::Null) => to_ms - DEFAULT_WINDOW_MS,
        Some(value) => value
            .as_i64()
            .filter(|ms| *ms >= 0)
            .ok_or_else(|| invalid("fromMs must be a non-negative integer"))?,
    };
    if to_ms < from_ms {
        return Err(invalid("toMs must be >= fromMs"));
    }
    if to_ms - from_ms > MAX_WINDOW_MS {
        return Err(invalid("time window must span at most 365 days"));
    }
    Ok((from_ms, to_ms))
}

fn limit_param(params: &Value) -> Result<i64> {
    match params.get("limit") {
        None | Some(Value::Null) => Ok(DEFAULT_LIMIT),
        Some(value) => match value.as_i64() {
            Some(limit) if (1..=MAX_LIMIT).contains(&limit) => Ok(limit),
            _ => Err(invalid("limit must be an integer between 1 and 500")),
        },
    }
}

fn session_id_param(params: &Value) -> Result<Option<String>> {
    match params.get("sessionId") {
        None | Some(Value::Null) => Ok(None),
        Some(value) => {
            let session_id = value
                .as_str()
                .ok_or_else(|| invalid("sessionId must be a string"))?;
            if session_id.trim().is_empty() {
                return Err(invalid("sessionId must be a non-empty string"));
            }
            Ok(Some(session_id.to_string()))
        }
    }
}

fn project_id_param(params: &Value) -> Result<Option<i64>> {
    match params.get("projectId") {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_i64()
            .map(Some)
            .ok_or_else(|| invalid("projectId must be an integer")),
    }
}

fn cursor_param(params: &Value) -> Result<Option<PluginUsageCursor>> {
    match params.get("cursor") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(raw)) if raw.is_empty() => Ok(None),
        Some(Value::String(raw)) => Ok(Some(decode_cursor(raw)?)),
        Some(_) => Err(invalid("cursor must be a string")),
    }
}

/// Keyset scan over completed turns of non-deleted sessions, ordered by
/// `ended_at ASC, id ASC`. Fetches `limit + 1` rows to learn `has_more`
/// without a separate COUNT, then trims to exactly `limit` rows.
pub(crate) fn list_turns(
    db: &Database,
    query: &PluginUsageTurnQuery<'_>,
) -> Result<(Vec<PluginUsageTurn>, bool)> {
    let mut statement = db.conn().prepare(
        "SELECT t.id, t.session_id, s.title, s.project_id, t.provider_id, t.model_id,
                t.started_at, t.ended_at, t.input_tokens, t.output_tokens, t.usage_json
         FROM turns t JOIN sessions s ON s.id = t.session_id
         WHERE s.deleted_at IS NULL
           AND t.status = 'completed' AND t.ended_at IS NOT NULL
           AND (?1 IS NULL OR t.ended_at > ?1 OR (t.ended_at = ?1 AND t.id > ?2))
           AND t.ended_at >= ?3 AND t.ended_at <= ?4
           AND (?5 IS NULL OR t.session_id = ?5)
           AND (?6 IS NULL OR s.project_id = ?6)
         ORDER BY t.ended_at ASC, t.id ASC
         LIMIT ?7",
    )?;
    let cursor_last = query.cursor.as_ref().map(|c| c.ended_at);
    let cursor_id = query.cursor.as_ref().map(|c| c.id.as_str());
    let fetch = query.limit + 1;
    let rows = statement.query_map(
        params![
            cursor_last,
            cursor_id,
            query.from_ms,
            query.to_ms,
            query.session_id,
            query.project_id,
            fetch,
        ],
        |row| {
            let usage_json: Option<String> = row.get(10)?;
            let parsed = usage_json
                .as_deref()
                .and_then(|json| serde_json::from_str::<Value>(json).ok());
            let token = |key: &str| {
                parsed
                    .as_ref()
                    .and_then(|u| u.get(key))
                    .and_then(Value::as_i64)
                    .unwrap_or(0)
            };
            let title: String = row.get(2)?;
            Ok(PluginUsageTurn {
                turn_id: row.get(0)?,
                session_id: row.get(1)?,
                session_title: if title.is_empty() { None } else { Some(title) },
                project_id: row.get(3)?,
                provider_id: row.get(4)?,
                model_id: row.get(5)?,
                started_at: row.get(6)?,
                ended_at: row.get(7)?,
                input_tokens: row.get::<_, Option<i64>>(8)?.unwrap_or(0),
                output_tokens: row.get::<_, Option<i64>>(9)?.unwrap_or(0),
                cache_read_tokens: token("cacheReadTokens"),
                cache_write_tokens: token("cacheWriteTokens"),
                reasoning_tokens: token("reasoningTokens"),
            })
        },
    )?;
    let mut turns: Vec<PluginUsageTurn> = rows
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(anyhow::Error::from)?;
    let has_more = turns.len() > query.limit as usize;
    if has_more {
        turns.truncate(query.limit as usize);
    }
    Ok((turns, has_more))
}

/// Parse plugin RPC params, run the keyset scan, and return the page JSON.
pub fn list_turns_page(db: &Database, params: &Value) -> Result<Value> {
    let (from_ms, to_ms) = window_params(params)?;
    let session_id = session_id_param(params)?;
    let project_id = project_id_param(params)?;
    let limit = limit_param(params)?;
    let cursor = cursor_param(params)?;
    let (turns, has_more) = list_turns(
        db,
        &PluginUsageTurnQuery {
            from_ms,
            to_ms,
            session_id: session_id.as_deref(),
            project_id,
            cursor,
            limit,
        },
    )?;
    let next_cursor = if has_more {
        turns
            .last()
            .map(|last| encode_cursor(last.ended_at, &last.turn_id))
    } else {
        None
    };
    Ok(json!({
        "turns": turns,
        "nextCursor": next_cursor,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn null_bounds_match_omitted_bounds() {
        let omitted = json!({});
        let nulls = json!({ "fromMs": null, "toMs": null });
        let (from_a, to_a) = window_params(&omitted).unwrap();
        let (from_b, to_b) = window_params(&nulls).unwrap();
        assert_eq!(to_a - from_a, DEFAULT_WINDOW_MS);
        assert_eq!(to_b - from_b, DEFAULT_WINDOW_MS);
        assert!((to_a - to_b).abs() < 5_000, "both use wall-clock now");
    }

    #[test]
    fn window_rejects_inverted_and_oversized_ranges() {
        let now = 2_000_000_000_000i64;
        assert!(window_params(&json!({ "fromMs": now, "toMs": now - 1 })).is_err());
        assert!(window_params(&json!({
            "fromMs": now - 366 * 24 * 3600 * 1000,
            "toMs": now
        }))
        .is_err());
        assert!(window_params(&json!({
            "fromMs": now - MAX_WINDOW_MS,
            "toMs": now
        }))
        .is_ok());
    }

    #[test]
    fn cursor_round_trips_ids_with_colons() {
        let raw = encode_cursor(42, "turn:with:colons");
        let cursor = decode_cursor(&raw).unwrap();
        assert_eq!(cursor.ended_at, 42);
        assert_eq!(cursor.id, "turn:with:colons");
        assert!(decode_cursor("not-a-cursor").is_err());
    }
}
