//! `memory.*` JSON-RPC methods (ADR 0371).
//!
//! The surface is deliberately small: write, recall, list, patch, forget and
//! stats. Injection into the agent prompt happens in `agent-runtime`, not
//! here; this module only owns the store.

use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::Mutex;

use super::{rpc_err, JsonRpcError};
use crate::memory::{
    ListFilter, MemoryKind, MemoryScope, MemorySource, NewMemory, RecallQuery, TidyPolicy,
    MAX_PINNED,
};
use crate::state::AppState;

pub(super) async fn handle(
    state: Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    match method {
        "memory.remember" => remember(state, params).await,
        "memory.recall" => recall(state, params).await,
        "memory.list" => list(state, params).await,
        "memory.update" => update(state, params).await,
        "memory.supersede" => supersede(state, params).await,
        "memory.pinned" => pinned(state, params).await,
        "memory.forget" => forget(state, params).await,
        "memory.tidy" => tidy(state, params).await,
        "memory.stats" => stats(state, params).await,
        "memory.entries" => entries(state, params).await,
        "memory.writeEntries" => write_entries(state, params).await,
        other => Err(rpc_err(
            1003,
            format!("unknown memory method: {other}"),
            "METHOD_NOT_FOUND",
        )),
    }
}

fn invalid(message: impl Into<String>) -> JsonRpcError {
    rpc_err(1002, message, "INVALID_PARAMS")
}

fn internal(error: anyhow::Error) -> JsonRpcError {
    rpc_err(1000, error.to_string(), "INTERNAL")
}

fn required_str<'a>(params: &'a Value, name: &str) -> Result<&'a str, JsonRpcError> {
    params
        .get(name)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| invalid(format!("{name} required")))
}

fn optional_str(params: &Value, name: &str) -> Result<Option<String>, JsonRpcError> {
    match params.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                Ok(None)
            } else {
                Ok(Some(trimmed.to_string()))
            }
        }
        Some(_) => Err(invalid(format!("{name} must be a string"))),
    }
}

fn optional_usize(params: &Value, name: &str) -> Result<Option<usize>, JsonRpcError> {
    match params.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => {
            let number = value
                .as_u64()
                .ok_or_else(|| invalid(format!("{name} must be a non-negative integer")))?;
            Ok(Some(number as usize))
        }
    }
}

fn optional_bool(params: &Value, name: &str) -> Result<Option<bool>, JsonRpcError> {
    match params.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_bool()
            .map(Some)
            .ok_or_else(|| invalid(format!("{name} must be a boolean"))),
    }
}

fn scope_param(params: &Value) -> Result<Option<MemoryScope>, JsonRpcError> {
    match optional_str(params, "scope")? {
        None => Ok(None),
        Some(value) => MemoryScope::parse(&value)
            .map(Some)
            .map_err(|_| invalid(format!("unknown scope: {value}"))),
    }
}

async fn remember(state: Arc<Mutex<AppState>>, params: Value) -> Result<Value, JsonRpcError> {
    let scope = scope_param(&params)?.ok_or_else(|| invalid("scope required"))?;
    let kind_value = required_str(&params, "kind")?;
    let kind = MemoryKind::parse(kind_value)
        .map_err(|_| invalid(format!("unknown kind: {kind_value}")))?;
    let source = match optional_str(&params, "source")? {
        None => MemorySource::Agent,
        Some(value) => {
            MemorySource::parse(&value).map_err(|_| invalid(format!("unknown source: {value}")))?
        }
    };
    let tags = match params.get("tags") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(items)) => {
            let mut out = Vec::with_capacity(items.len());
            for item in items {
                let tag = item
                    .as_str()
                    .ok_or_else(|| invalid("tags must be an array of strings"))?
                    .trim();
                if !tag.is_empty() {
                    out.push(tag.to_string());
                }
            }
            out
        }
        Some(_) => return Err(invalid("tags must be an array of strings")),
    };
    let confidence = match params.get("confidence") {
        None | Some(Value::Null) => 0.7,
        Some(value) => value
            .as_f64()
            .ok_or_else(|| invalid("confidence must be a number"))?,
    };
    let pinned = optional_bool(&params, "pinned")?.unwrap_or(false);

    let mut input = NewMemory::new(
        scope,
        kind,
        required_str(&params, "title")?,
        required_str(&params, "body")?,
    );
    input.project_path = optional_str(&params, "projectPath")?;
    input.session_id = optional_str(&params, "sessionId")?;
    input.tags = tags;
    input.source = source;
    input.confidence = confidence;
    input.pinned = pinned;

    let st = state.lock().await;
    let outcome = st.db.remember(input).map_err(|error| {
        let message = error.to_string();
        if message.contains("needs ") || message.contains("cannot carry") {
            invalid(message)
        } else {
            internal(error)
        }
    })?;
    Ok(json!({ "memory": outcome.memory, "deduped": outcome.deduped }))
}

async fn recall(state: Arc<Mutex<AppState>>, params: Value) -> Result<Value, JsonRpcError> {
    let query = required_str(&params, "query")?.to_string();
    let limit = optional_usize(&params, "limit")?;
    let st = state.lock().await;
    let hits = st
        .db
        .recall(RecallQuery {
            query,
            scope: scope_param(&params)?,
            project_path: optional_str(&params, "projectPath")?,
            session_id: optional_str(&params, "sessionId")?,
            limit,
        })
        .map_err(internal)?;
    Ok(json!({ "memories": hits }))
}

fn memory_target(params: &Value) -> Result<crate::memory_entries::MemoryTarget, JsonRpcError> {
    let value = required_str(params, "target")?;
    crate::memory_entries::MemoryTarget::parse(value)
        .ok_or_else(|| invalid(format!("unknown memory target: {value}")))
}

/// Entries for one target, in stored order (ADR 0378).
async fn entries(state: Arc<Mutex<AppState>>, params: Value) -> Result<Value, JsonRpcError> {
    let target = memory_target(&params)?;
    let st = state.lock().await;
    let entries = st.db.memory_entries(target).map_err(internal)?;
    Ok(json!({ "target": target.as_str(), "entries": entries }))
}

/// Replace one target's whole entry list.
///
/// A whole-list write keeps the batch semantics honest: the caller already holds
/// the list (it is in the model's prompt), frees space and spends it in one
/// call, and the host validates only the final result — the same contract as
/// `applyMemoryBatch` in `@pi-desktop/agent-runtime`. A budget violation is the
/// model's mistake, so it reports as invalid params rather than an internal
/// failure.
async fn write_entries(state: Arc<Mutex<AppState>>, params: Value) -> Result<Value, JsonRpcError> {
    let target = memory_target(&params)?;
    let items = params
        .get("entries")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("entries must be an array of strings"))?;
    let mut requested = Vec::with_capacity(items.len());
    for item in items {
        requested.push(
            item.as_str()
                .ok_or_else(|| invalid("entries must be an array of strings"))?
                .to_string(),
        );
    }
    let st = state.lock().await;
    let written = st
        .db
        .write_memory_entries(target, &requested)
        .map_err(|error| invalid(error.to_string()))?;
    Ok(json!({ "target": target.as_str(), "entries": written }))
}

async fn list(state: Arc<Mutex<AppState>>, params: Value) -> Result<Value, JsonRpcError> {
    let kind = match optional_str(&params, "kind")? {
        None => None,
        Some(value) => {
            Some(MemoryKind::parse(&value).map_err(|_| invalid(format!("unknown kind: {value}")))?)
        }
    };
    let st = state.lock().await;
    let (memories, total) = st
        .db
        .list_memories(&ListFilter {
            scope: scope_param(&params)?,
            project_path: optional_str(&params, "projectPath")?,
            session_id: optional_str(&params, "sessionId")?,
            kind,
            pinned: optional_bool(&params, "pinned")?,
            include_superseded: optional_bool(&params, "includeSuperseded")?.unwrap_or(false),
            limit: optional_usize(&params, "limit")?,
            offset: optional_usize(&params, "offset")?,
        })
        .map_err(internal)?;
    Ok(json!({ "memories": memories, "total": total }))
}

async fn update(state: Arc<Mutex<AppState>>, params: Value) -> Result<Value, JsonRpcError> {
    let id = required_str(&params, "id")?;
    let title = optional_str(&params, "title")?;
    let body = optional_str(&params, "body")?;
    let confidence = match params.get("confidence") {
        None | Some(Value::Null) => None,
        Some(value) => Some(
            value
                .as_f64()
                .ok_or_else(|| invalid("confidence must be a number"))?,
        ),
    };
    let pinned = optional_bool(&params, "pinned")?;
    let tags = match params.get("tags") {
        None | Some(Value::Null) => None,
        Some(Value::Array(items)) => {
            let mut out = Vec::with_capacity(items.len());
            for item in items {
                let tag = item
                    .as_str()
                    .ok_or_else(|| invalid("tags must be an array of strings"))?
                    .trim();
                if !tag.is_empty() {
                    out.push(tag.to_string());
                }
            }
            Some(out)
        }
        Some(_) => return Err(invalid("tags must be an array of strings")),
    };

    let st = state.lock().await;
    let memory = st
        .db
        .update_memory(
            id,
            title.as_deref(),
            body.as_deref(),
            tags.as_deref(),
            confidence,
            pinned,
        )
        .map_err(|error| {
            let message = error.to_string();
            if message.contains("not found") {
                rpc_err(1002, message, "MEMORY_NOT_FOUND")
            } else if message.contains("empty") || message.contains("exceeds") {
                invalid(message)
            } else {
                internal(error)
            }
        })?;
    Ok(json!({ "memory": memory }))
}

async fn supersede(state: Arc<Mutex<AppState>>, params: Value) -> Result<Value, JsonRpcError> {
    let id = required_str(&params, "id")?.to_string();
    let replacement_id = required_str(&params, "replacementId")?.to_string();
    let st = state.lock().await;
    st.db
        .supersede_memory(&id, &replacement_id)
        .map_err(|error| rpc_err(1002, error.to_string(), "MEMORY_NOT_FOUND"))?;
    Ok(json!({ "superseded": id, "replacementId": replacement_id }))
}

async fn pinned(state: Arc<Mutex<AppState>>, params: Value) -> Result<Value, JsonRpcError> {
    let limit = optional_usize(&params, "limit")?.unwrap_or(MAX_PINNED);
    let project_path = optional_str(&params, "projectPath")?;
    let session_id = optional_str(&params, "sessionId")?;
    let st = state.lock().await;
    let memories = st
        .db
        .pinned_memories(project_path.as_deref(), session_id.as_deref(), limit)
        .map_err(internal)?;
    Ok(json!({ "memories": memories }))
}

async fn forget(state: Arc<Mutex<AppState>>, params: Value) -> Result<Value, JsonRpcError> {
    let id = optional_str(&params, "id")?;
    let session_id = optional_str(&params, "sessionId")?;
    if id.is_none() && session_id.is_none() {
        return Err(invalid("id or sessionId required"));
    }
    let st = state.lock().await;
    if let Some(id) = id {
        let removed = st.db.forget_memory(&id).map_err(internal)?;
        return Ok(json!({ "removed": if removed { 1 } else { 0 } }));
    }
    let session_id = session_id.expect("checked above");
    let removed = st
        .db
        .forget_memories_for_session(&session_id)
        .map_err(internal)?;
    Ok(json!({ "removed": removed }))
}

async fn tidy(state: Arc<Mutex<AppState>>, params: Value) -> Result<Value, JsonRpcError> {
    let mut policy = TidyPolicy::default();
    if let Some(days) = optional_usize(&params, "maxAgeDays")? {
        policy.max_age_ms = (days as i64) * 24 * 3600 * 1000;
    }
    if let Some(value) = params.get("minConfidence") {
        if !value.is_null() {
            policy.min_confidence = value
                .as_f64()
                .ok_or_else(|| invalid("minConfidence must be a number"))?;
        }
    }
    if let Some(max_live) = optional_usize(&params, "maxLive")? {
        policy.max_live = max_live;
    }
    if let Some(expire) = optional_bool(&params, "expire")? {
        policy.expire = expire;
    }
    let st = state.lock().await;
    let outcome = st.db.tidy_memories(&policy).map_err(internal)?;
    Ok(
        json!({ "removed": outcome.total(), "expired": outcome.expired, "overflow": outcome.overflow }),
    )
}

async fn stats(state: Arc<Mutex<AppState>>, _params: Value) -> Result<Value, JsonRpcError> {
    let st = state.lock().await;
    let stats = st.db.memory_stats().map_err(internal)?;
    Ok(json!({ "stats": stats }))
}
