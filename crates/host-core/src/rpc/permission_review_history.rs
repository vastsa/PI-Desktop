use super::*;
use rusqlite::params as sql_params;
use std::collections::HashSet;

/// Persist only a typed, bounded numeric projection; audit redacts arbitrary
/// token-like keys, including the `inputTokens` field of MessageUsage.
pub(super) fn safe_usage(result: &Value) -> Value {
    let Some(input) = result.get("usage").and_then(Value::as_object) else {
        return Value::Null;
    };
    let mut usage = serde_json::Map::new();
    for (public, stored) in [
        ("inputTokens", "input"),
        ("outputTokens", "output"),
        ("cacheReadTokens", "cacheRead"),
        ("cacheWriteTokens", "cacheWrite"),
        ("reasoningTokens", "reasoning"),
        ("totalTokens", "total"),
    ] {
        if let Some(value) = input.get(public) {
            if !value.as_u64().is_some_and(|number| number <= 1_000_000_000) {
                return Value::Null;
            }
            usage.insert(stored.to_string(), value.clone());
        }
    }
    if !usage.contains_key("input") || !usage.contains_key("output") || !usage.contains_key("total")
    {
        return Value::Null;
    }
    Value::Object(usage)
}

fn public_usage(value: Option<&Value>) -> Value {
    let Some(stored) = value.and_then(Value::as_object) else {
        return Value::Null;
    };
    let mut usage = serde_json::Map::new();
    for (public, key) in [
        ("inputTokens", "input"),
        ("outputTokens", "output"),
        ("cacheReadTokens", "cacheRead"),
        ("cacheWriteTokens", "cacheWrite"),
        ("reasoningTokens", "reasoning"),
        ("totalTokens", "total"),
    ] {
        if let Some(value) = stored
            .get(key)
            .filter(|value| value.as_u64().is_some_and(|n| n <= 1_000_000_000))
        {
            usage.insert(public.to_string(), value.clone());
        }
    }
    if !usage.contains_key("inputTokens")
        || !usage.contains_key("outputTokens")
        || !usage.contains_key("totalTokens")
    {
        return Value::Null;
    }
    Value::Object(usage)
}

/// Review outcomes are retained by the existing audit log, independently of
/// the ephemeral permission request and the parent agent's token accounting.
pub(super) async fn list(
    state: &Arc<Mutex<AppState>>,
    params: &Value,
) -> Result<Value, JsonRpcError> {
    let session_id = params
        .get("sessionId")
        .and_then(Value::as_str)
        .filter(|id| !id.trim().is_empty())
        .ok_or_else(|| rpc_err(1002, "sessionId required", "INVALID_PARAMS"))?;
    let st = state.lock().await;
    if sessions::get_session(&st.db, session_id)
        .map_err(|error| rpc_err(1000, error.to_string(), "INTERNAL"))?
        .is_none()
    {
        return Err(rpc_err(1007, "session not found", "SESSION_NOT_FOUND"));
    }
    let mut statement = st.db.conn().prepare_cached(
        "SELECT ts, payload_json FROM audit_log WHERE session_id = ?1 AND kind = 'permission_review' ORDER BY id DESC LIMIT 256",
    ).map_err(|error| rpc_err(1000, error.to_string(), "INTERNAL"))?;
    let rows = statement
        .query_map(sql_params![session_id], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| rpc_err(1000, error.to_string(), "INTERNAL"))?;
    let mut seen = HashSet::new();
    let mut entries = Vec::new();
    for row in rows {
        let (reviewed_at, payload) =
            row.map_err(|error| rpc_err(1000, error.to_string(), "INTERNAL"))?;
        let Ok(value) = serde_json::from_str::<Value>(&payload) else {
            continue;
        };
        let Some(request_id) = value.get("requestId").and_then(Value::as_str) else {
            continue;
        };
        if !seen.insert(request_id.to_string()) {
            continue;
        }
        let mut entry = json!({
            "requestId": request_id,
            "sessionId": session_id,
            "reviewedAt": reviewed_at,
            "decision": value.get("decision"),
            "reason": value.get("reason"),
            "toolCallId": value.get("toolCallId"),
            "actorId": value.get("actorId"),
            "toolName": value.get("toolName"),
            "latencyMs": value.get("latencyMs"),
            "decisionSource": value.get("decisionSource"),
            "reviewerProviderId": value.get("reviewerProviderId"),
            "reviewerModelId": value.get("reviewerModelId"),
            "usage": public_usage(value.get("usage")),
        });
        if let Some(fields) = entry.as_object_mut() {
            fields.retain(|_, value| !value.is_null());
        }
        entries.push(entry);
        if entries.len() == 100 {
            break;
        }
    }
    Ok(json!({ "entries": entries }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn review_history_survives_restart_deduplicates_request_and_keeps_usage() {
        let dir = tempfile::tempdir().unwrap();
        let app = AppState::open(dir.path()).unwrap();
        let session = sessions::create_session(
            &app.db,
            Some("review".into()),
            Some("agent".into()),
            None,
            None,
            None,
        )
        .unwrap();
        let record = json!({
            "requestId": "once", "decision": "allow_once", "reason": "Bounded change",
            "reviewerProviderId": "test", "reviewerModelId": "local",
            "decisionSource": "auto_review", "latencyMs": 27,
            "usage": safe_usage(&json!({"usage": {
                "inputTokens": 42, "outputTokens": 7, "totalTokens": 49,
            }})),
        });
        audit::append(
            &app.db,
            "permission_review",
            Some(&session.id),
            record.clone(),
        )
        .unwrap();
        audit::append(&app.db, "permission_review", Some(&session.id), record).unwrap();
        drop(app);
        let reopened = Arc::new(Mutex::new(AppState::open(dir.path()).unwrap()));
        let outcome = list(&reopened, &json!({"sessionId": session.id}))
            .await
            .unwrap();
        assert_eq!(outcome["entries"].as_array().unwrap().len(), 1);
        let entry = &outcome["entries"][0];
        assert_eq!(entry["requestId"], "once");
        assert_eq!(entry["reviewerModelId"], "local");
        assert_eq!(entry["usage"]["inputTokens"], 42);
        assert_eq!(entry["usage"]["outputTokens"], 7);
        assert_eq!(entry["usage"]["totalTokens"], 49);
    }

    #[test]
    fn malformed_or_oversized_usage_does_not_enter_audit() {
        assert!(safe_usage(&json!({"usage": {
            "inputTokens": -1, "outputTokens": 1, "totalTokens": 2,
        }}))
        .is_null());
        assert!(safe_usage(&json!({"usage": {
            "inputTokens": 1_000_000_001u64, "outputTokens": 1, "totalTokens": 2,
        }}))
        .is_null());
    }
}
