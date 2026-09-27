use anyhow::Result;
use rusqlite::params;
use serde_json::Value;

use crate::db::{now_ms, Database};

pub fn append(db: &Database, kind: &str, session_id: Option<&str>, payload: Value) -> Result<()> {
    append_to(db.conn(), kind, session_id, payload)
}

/// Append using an existing transaction so security-relevant state changes
/// and their audit record commit or roll back together.
pub fn append_tx(
    tx: &rusqlite::Transaction<'_>,
    kind: &str,
    session_id: Option<&str>,
    payload: Value,
) -> Result<()> {
    append_to(tx, kind, session_id, payload)
}

fn append_to(
    conn: &rusqlite::Connection,
    kind: &str,
    session_id: Option<&str>,
    payload: Value,
) -> Result<()> {
    // Redact obvious secrets in payload serialization path (best-effort).
    let redacted = redact_value(payload);
    conn.prepare_cached(
        "INSERT INTO audit_log (ts, kind, session_id, payload_json) VALUES (?1, ?2, ?3, ?4)",
    )?
    .execute(params![now_ms(), kind, session_id, redacted.to_string()])?;
    Ok(())
}

fn redact_value(value: Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut out = serde_json::Map::new();
            for (k, v) in map {
                let key_l = k.to_ascii_lowercase();
                if key_l.contains("secret")
                    || key_l.contains("api_key")
                    || key_l.contains("apikey")
                    || key_l.contains("authorization")
                    || key_l.contains("token")
                    || key_l.contains("password")
                {
                    out.insert(k, Value::String("***REDACTED***".into()));
                } else {
                    out.insert(k, redact_value(v));
                }
            }
            Value::Object(out)
        }
        Value::Array(arr) => Value::Array(arr.into_iter().map(redact_value).collect()),
        Value::String(s) => {
            if s.starts_with("sk-") && s.len() > 12 {
                Value::String("***REDACTED***".into())
            } else {
                Value::String(s)
            }
        }
        other => other,
    }
}
