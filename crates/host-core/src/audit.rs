use anyhow::Result;
use regex::Regex;
use rusqlite::params;
use serde_json::Value;
use std::sync::OnceLock;

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
    let redacted = bounded_payload(redact_value(payload));
    conn.prepare_cached(
        "INSERT INTO audit_log (ts, kind, session_id, payload_json) VALUES (?1, ?2, ?3, ?4)",
    )?
    .execute(params![now_ms(), kind, session_id, redacted])?;
    Ok(())
}

fn redact_value(value: Value) -> Value {
    redact_value_internal(value, 0)
}

const MAX_AUDIT_STRING_CHARS: usize = 2_048;
const MAX_AUDIT_DEPTH: usize = 5;
const MAX_AUDIT_FIELDS: usize = 48;
const MAX_AUDIT_ITEMS: usize = 32;
const MAX_AUDIT_PAYLOAD_BYTES: usize = 8 * 1024;

fn redact_value_internal(value: Value, depth: usize) -> Value {
    match value {
        Value::Object(map) => {
            if depth >= MAX_AUDIT_DEPTH {
                return Value::String("[DepthLimited]".into());
            }
            let mut out = serde_json::Map::new();
            let field_count = map.len();
            for (index, (k, v)) in map.into_iter().enumerate() {
                if index >= MAX_AUDIT_FIELDS {
                    break;
                }
                let key_l = k.to_ascii_lowercase();
                if key_l.contains("secret")
                    || key_l.contains("api_key")
                    || key_l.contains("apikey")
                    || key_l.contains("authorization")
                    || key_l.contains("token")
                    || key_l.contains("password")
                {
                    out.insert(k, Value::String("***REDACTED***".into()));
                } else if is_path_key(&key_l) {
                    out.insert(
                        k,
                        match v {
                            Value::String(path) => Value::String(redact_path(&path)),
                            other => redact_value_internal(other, depth + 1),
                        },
                    );
                } else {
                    out.insert(k, redact_value_internal(v, depth + 1));
                }
            }
            if field_count > MAX_AUDIT_FIELDS {
                out.insert(
                    "_omittedFields".into(),
                    Value::Number((field_count - MAX_AUDIT_FIELDS).into()),
                );
            }
            Value::Object(out)
        }
        Value::Array(arr) => {
            if depth >= MAX_AUDIT_DEPTH {
                return Value::String("[DepthLimited]".into());
            }
            let item_count = arr.len();
            let mut out = arr
                .into_iter()
                .take(MAX_AUDIT_ITEMS)
                .map(|item| redact_value_internal(item, depth + 1))
                .collect::<Vec<_>>();
            if item_count > MAX_AUDIT_ITEMS {
                out.push(Value::String(format!(
                    "[{} items omitted]",
                    item_count - MAX_AUDIT_ITEMS
                )));
            }
            Value::Array(out)
        }
        Value::String(s) => Value::String(redact_string(&s)),
        other => other,
    }
}

fn bounded_payload(value: Value) -> String {
    let serialized = value.to_string();
    if serialized.len() <= MAX_AUDIT_PAYLOAD_BYTES {
        return serialized;
    }
    match value {
        Value::Object(map) => serde_json::json!({
            "truncated": true,
            "originalBytes": serialized.len(),
            "type": "object",
            "fields": map.keys().take(MAX_AUDIT_FIELDS).collect::<Vec<_>>(),
        })
        .to_string(),
        Value::Array(items) => serde_json::json!({
            "truncated": true,
            "originalBytes": serialized.len(),
            "type": "array",
            "itemCount": items.len(),
        })
        .to_string(),
        _ => serde_json::json!({
            "truncated": true,
            "originalBytes": serialized.len(),
            "type": "value",
        })
        .to_string(),
    }
}

fn redact_string(value: &str) -> String {
    let mut safe = value.to_owned();
    safe = regex(r"(?i)(https?://)[^/\s:@]+:[^@\s]+@", "url_credentials")
        .replace_all(&safe, "$1***:***@")
        .into_owned();
    safe = regex(
        r"(?i)\b(bearer|basic)\s+[A-Za-z0-9+/_=.-]{8,}",
        "authorization_scheme",
    )
    .replace_all(&safe, "$1 ***REDACTED***")
    .into_owned();
    safe = regex(
        r#"(?i)\b((?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|password|api[_-]?key|apikey|authorization|proxy-authorization|cookie|set-cookie|credential|private[_-]?key|client[_-]?secret)\s*[:=]\s*)[^\s,;&}\"']+"#,
        "secret_assignment",
    )
    .replace_all(&safe, "$1***REDACTED***")
    .into_owned();
    safe = regex(
        r"(?i)\b(?:sk|rk|pk)-[A-Za-z0-9_-]{10,}\b|\b(?:gh[pousr]_|github_pat_|glpat-|xox[baprs]-|AIza|ya29\.)[A-Za-z0-9._-]{8,}\b",
        "provider_token",
    )
    .replace_all(&safe, "***REDACTED***")
    .into_owned();
    safe = regex(
        r#"(^|[\s(\"'=])((?:/|[A-Za-z]:[\\/]|\\\\)[^\s\"'=,;)}]*)"#,
        "absolute_path",
    )
    .replace_all(&safe, "$1<local-path>")
    .into_owned();

    let mut chars = safe.chars();
    let bounded: String = chars.by_ref().take(MAX_AUDIT_STRING_CHARS).collect();
    if chars.next().is_some() {
        format!("{bounded}…[truncated]")
    } else {
        bounded
    }
}

fn is_path_key(key: &str) -> bool {
    key.ends_with("path")
        || key.ends_with("cwd")
        || key.ends_with("root")
        || key.ends_with("file")
        || key.ends_with("filename")
        || key.ends_with("directory")
        || key.ends_with("dir")
        || key.ends_with("workspace")
        || key.ends_with("project")
}

fn redact_path(value: &str) -> String {
    let safe = redact_string(value);
    if let Some(home) = dirs::home_dir().and_then(|path| path.to_str().map(str::to_owned)) {
        if value == home {
            return "<home>".into();
        }
        for separator in ['/', '\\'] {
            let prefix = format!("{home}{separator}");
            if value.starts_with(&prefix) {
                return format!("<home>{}", redact_string(&value[prefix.len()..]));
            }
        }
    }
    if value.starts_with('/')
        || value.starts_with('\\')
        || value.as_bytes().get(1).is_some_and(|byte| *byte == b':')
    {
        return "<local-path>".into();
    }
    safe
}

fn regex(pattern: &str, name: &str) -> &'static Regex {
    static URL_CREDENTIALS: OnceLock<Regex> = OnceLock::new();
    static SECRET_ASSIGNMENT: OnceLock<Regex> = OnceLock::new();
    static AUTHORIZATION_SCHEME: OnceLock<Regex> = OnceLock::new();
    static PROVIDER_TOKEN: OnceLock<Regex> = OnceLock::new();
    static ABSOLUTE_PATH: OnceLock<Regex> = OnceLock::new();

    let slot = match name {
        "url_credentials" => &URL_CREDENTIALS,
        "secret_assignment" => &SECRET_ASSIGNMENT,
        "authorization_scheme" => &AUTHORIZATION_SCHEME,
        "provider_token" => &PROVIDER_TOKEN,
        "absolute_path" => &ABSOLUTE_PATH,
        _ => unreachable!("unknown audit redaction regex"),
    };
    slot.get_or_init(|| Regex::new(pattern).expect("audit redaction regex is valid"))
}

#[cfg(test)]
mod tests {
    use super::redact_value;
    use serde_json::json;

    #[test]
    fn redacts_secret_formats_inside_audit_strings() {
        let value = redact_value(json!({
            "detail": "Authorization: Bearer provider-secret-123456789 https://alice:password@example.com?access_token=secret-value sk-proj-abcdefghijklmnopqrstuvwxyz",
            "apiKey": "must-not-write",
        }));
        let detail = value["detail"].as_str().expect("redacted detail string");
        assert!(!detail.contains("provider-secret-123456789"));
        assert!(!detail.contains("alice:password@"));
        assert!(!detail.contains("access_token=secret-value"));
        assert!(!detail.contains("sk-proj-abcdefghijklmnopqrstuvwxyz"));
        assert_eq!(value["apiKey"], "***REDACTED***");
    }

    #[test]
    fn truncates_long_audit_strings() {
        let value = redact_value(json!({"detail": "x".repeat(3_000)}));
        assert!(value["detail"].as_str().unwrap().contains("[truncated]"));
    }

    #[test]
    fn bounds_large_audit_payloads_without_writing_invalid_json() {
        let value = redact_value(json!({
            "items": (0..100).map(|_| "x".repeat(2_000)).collect::<Vec<_>>(),
        }));
        let serialized = super::bounded_payload(value);
        assert!(serialized.len() <= super::MAX_AUDIT_PAYLOAD_BYTES);
        let parsed: serde_json::Value = serde_json::from_str(&serialized).expect("valid JSON");
        assert_eq!(parsed["truncated"], true);
    }

    #[test]
    fn redacts_absolute_paths_in_audit_payloads() {
        let value = redact_value(json!({
            "projectPath": "/Volumes/private/project",
            "detail": "failed while reading /Volumes/private/project/config.json",
        }));
        assert_eq!(value["projectPath"], "<local-path>");
        assert_eq!(value["detail"], "failed while reading <local-path>");
    }
}
