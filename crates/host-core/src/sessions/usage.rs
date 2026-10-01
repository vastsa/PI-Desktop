//! Durable physical-request accounting in the existing turn JSON column.
//! No transcript row, second database, or schema migration is needed.

use anyhow::{anyhow, Result};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Map, Value};

use crate::db::Database;

const TOKENS: [&str; 6] = [
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "reasoningTokens",
    "totalTokens",
];
const COSTS: [&str; 5] = ["input", "output", "cacheRead", "cacheWrite", "total"];

fn operations(usage: &Value) -> Vec<Value> {
    if let Some(records) = usage
        .get("operations")
        .and_then(Value::as_array)
        .filter(|v| !v.is_empty())
    {
        return records.clone();
    }
    if usage.get("operationId").and_then(Value::as_str).is_some() {
        let mut record = usage.clone();
        if let Some(object) = record.as_object_mut() {
            object.remove("operations");
            object.remove("aggregation");
        }
        return vec![record];
    }
    vec![]
}

fn count(value: &Value, key: &str) -> i64 {
    value.get(key).and_then(Value::as_i64).unwrap_or(0).max(0)
}

fn known_cost(record: &Value) -> bool {
    record.get("costStatus").and_then(Value::as_str) != Some("unknown")
        && COSTS.iter().all(|key| {
            record
                .get("cost")
                .and_then(|c| c.get(key))
                .and_then(Value::as_f64)
                .is_some_and(|n| n.is_finite() && n >= 0.0)
        })
}
fn sum_counts(records: &[Value], key: &str) -> i64 {
    records.iter().fold(0_i64, |total, record| {
        total.saturating_add(count(record, key))
    })
}
fn validate(usage: &Value) -> Result<()> {
    let records = operations(usage);
    if records.is_empty() {
        return Err(anyhow!("usage requires a physical operation identity"));
    }
    for record in records {
        if record
            .get("operationId")
            .and_then(Value::as_str)
            .is_none_or(str::is_empty)
        {
            return Err(anyhow!("usage operationId required"));
        }
        for key in TOKENS {
            if record.get(key).is_none()
                && !["inputTokens", "outputTokens", "totalTokens"].contains(&key)
            {
                continue;
            }
            if record
                .get(key)
                .and_then(Value::as_i64)
                .is_none_or(|v| v < 0)
            {
                return Err(anyhow!("invalid usage token count"));
            }
        }
    }
    Ok(())
}

/// End-turn is a snapshot, not another charge. Union its ledger with requests
/// already persisted before the process stopped. Legacy token-only snapshots
/// retain their historical replacement semantics.
pub(super) fn merge_usage(existing: Option<&Value>, incoming: &Value) -> Value {
    let Some(existing) = existing else {
        return incoming.clone();
    };
    let left = operations(existing);
    let right = operations(incoming);
    if left.is_empty() && right.is_empty() {
        return incoming.clone();
    }
    let mut records: Vec<Value> = Vec::new();
    for record in left.iter().chain(&right) {
        let Some(id) = record.get("operationId").and_then(Value::as_str) else {
            continue;
        };
        if let Some(index) = records
            .iter()
            .position(|v| v.get("operationId").and_then(Value::as_str) == Some(id))
        {
            let previous = &records[index];
            let incoming_count = count(record, "totalTokens");
            let previous_count = count(previous, "totalTokens");
            if incoming_count > previous_count
                || (incoming_count == previous_count
                    && (!known_cost(previous)
                        || (known_cost(record)
                            && record.get("costStatus").and_then(Value::as_str)
                                == Some("reported"))))
            {
                records[index] = record.clone();
            }
        } else {
            records.push(record.clone());
        }
    }
    let mut merged = Map::new();
    let mut has_legacy = false;
    for key in TOKENS {
        let left_count: i64 = sum_counts(&left, key);
        let right_count: i64 = sum_counts(&right, key);
        let residual = count(existing, key)
            .saturating_sub(left_count)
            .max(count(incoming, key).saturating_sub(right_count))
            .max(0);
        has_legacy |= residual > 0;
        let total = sum_counts(&records, key).saturating_add(residual);
        if total > 0
            || ["inputTokens", "outputTokens", "totalTokens"].contains(&key)
            || existing.get(key).is_some()
            || incoming.get(key).is_some()
        {
            merged.insert(key.into(), json!(total));
        }
    }
    let known = !has_legacy
        && records.iter().all(known_cost)
        && COSTS.iter().all(|key| {
            records
                .iter()
                .filter_map(|v| v.get("cost")?.get(key)?.as_f64())
                .sum::<f64>()
                .is_finite()
        });
    if known {
        let mut cost = Map::new();
        for key in COSTS {
            let total: f64 = records
                .iter()
                .filter_map(|v| v.get("cost")?.get(key)?.as_f64())
                .sum();
            cost.insert(key.into(), json!(total));
        }
        merged.insert("cost".into(), Value::Object(cost));
        let reported = records
            .iter()
            .all(|v| v.get("costStatus").and_then(Value::as_str) == Some("reported"));
        merged.insert(
            "costStatus".into(),
            json!(if reported { "reported" } else { "estimated" }),
        );
    } else {
        merged.insert("costStatus".into(), json!("unknown"));
    }
    merged.insert("aggregation".into(), json!("aggregate"));
    merged.insert("operations".into(), Value::Array(records));
    Value::Object(merged)
}

/// The immutable session/turn pair is checked even when a durable outbox is
/// replayed after shutdown. Late writes may complete the old turn's bill, never
/// the newer turn's. Deleted sessions/turns are not recreated.
pub fn record_usage(db: &Database, session_id: &str, turn_id: &str, usage: &Value) -> Result<bool> {
    validate(usage)?;
    let existing: Option<Option<String>> = db
        .conn()
        .query_row(
            "SELECT usage_json FROM turns WHERE id = ?1 AND session_id = ?2",
            params![turn_id, session_id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(existing) = existing else {
        return Ok(false);
    };
    let parsed = existing
        .as_deref()
        .map(serde_json::from_str::<Value>)
        .transpose()?;
    let merged = merge_usage(parsed.as_ref(), usage);
    db.conn().execute(
        "UPDATE turns SET usage_json = ?1, input_tokens = ?2, output_tokens = ?3 WHERE id = ?4 AND session_id = ?5",
        params![merged.to_string(), count(&merged, "inputTokens"), count(&merged, "outputTokens"), turn_id, session_id],
    )?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn operation(id: &str, known: bool) -> Value {
        let mut value = json!({"operationId": id, "usageOrigin": "pi", "inputTokens": 12, "outputTokens": 3, "totalTokens": 15, "costStatus": "unknown"});
        if known {
            value["costStatus"] = json!("reported");
            value["cost"] = json!({"input": 0.12, "output": 0.03, "cacheRead": 0, "cacheWrite": 0, "total": 0.15});
        }
        value
    }

    #[test]
    fn usage_ledger_deduplicates_child_parent_and_replayed_snapshots() {
        let child = operation("child", true);
        let other = operation("classifier", false);
        let total = merge_usage(Some(&child), &other);
        assert_eq!(total["totalTokens"], 30);
        assert_eq!(total["costStatus"], "unknown");
        assert!(total.get("cost").is_none());
        assert_eq!(total["operations"][0]["cost"]["total"], 0.15);
        assert_eq!(merge_usage(Some(&total), &child), total);
        assert_eq!(merge_usage(Some(&total), &total), total);
    }

    #[test]
    fn equal_token_replay_preserves_known_cost() {
        let known = operation("request", true);
        let unknown = operation("request", false);
        for (left, right) in [(&known, &unknown), (&unknown, &known)] {
            let total = merge_usage(Some(left), right);
            assert_eq!(total["costStatus"], "reported");
            assert_eq!(total["cost"]["total"], 0.15);
        }
    }

    #[test]
    fn oversized_counts_cannot_overflow_the_ledger() {
        let left = json!({"operationId": "left", "inputTokens": i64::MAX, "outputTokens": 0, "totalTokens": i64::MAX});
        let right =
            json!({"operationId": "right", "inputTokens": 1, "outputTokens": 0, "totalTokens": 1});
        let total = merge_usage(Some(&left), &right);
        assert_eq!(total["totalTokens"], i64::MAX);
        assert_eq!(total["inputTokens"], i64::MAX);
    }

    #[test]
    fn usage_ledger_survives_restart_and_rejects_wrong_turn_owner() {
        let dir = std::env::temp_dir().join(format!("pi-usage-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("test.sqlite");
        let db = Database::open(&path).unwrap();
        let session = super::super::create_session(&db, None, None, None, None, None).unwrap();
        let turn = super::super::begin_turn(&db, &session.id, None, None).unwrap();
        let child = operation("child", true);
        assert!(!record_usage(&db, "other-session", &turn, &child).unwrap());
        assert!(record_usage(&db, &session.id, &turn, &child).unwrap());
        drop(db);
        let db = Database::open(&path).unwrap();
        assert!(record_usage(&db, &session.id, &turn, &child).unwrap());
        let parent = merge_usage(Some(&child), &operation("parent", true));
        super::super::end_turn(&db, &turn, "completed", None, Some(&parent), false).unwrap();
        super::super::end_turn(&db, &turn, "completed", None, Some(&parent), false).unwrap();
        assert!(record_usage(&db, &session.id, &turn, &child).unwrap());
        let stored: String = db
            .conn()
            .query_row(
                "SELECT usage_json FROM turns WHERE id = ?1",
                params![turn],
                |row| row.get(0),
            )
            .unwrap();
        let stored: Value = serde_json::from_str(&stored).unwrap();
        assert_eq!(stored["totalTokens"], 30);
        assert_eq!(stored["cost"]["total"], 0.3);
        assert_eq!(stored["operations"].as_array().unwrap().len(), 2);
        drop(db);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
