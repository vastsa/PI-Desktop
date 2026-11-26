use serde_json::{json, Value};

use super::{remote_tools, rpc_err, session_display, JsonRpcError};
use crate::{
    db::Database,
    sessions::{self, SessionDetail},
    transcripts::restore,
};

pub(super) fn history_page(db: &Database, params: &Value) -> Result<Value, JsonRpcError> {
    let id = params
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| rpc_err(1002, "id required", "INVALID_PARAMS"))?;
    let before = match params.get("beforeItemId") {
        None => None,
        Some(Value::String(id)) => Some(id.as_str()),
        Some(_) => {
            return Err(rpc_err(
                1002,
                "beforeItemId must be a string",
                "INVALID_PARAMS",
            ))
        }
    };
    let limit = params
        .get("messageLimit")
        .and_then(Value::as_u64)
        .filter(|limit| *limit > 0)
        .ok_or_else(|| rpc_err(1002, "positive messageLimit required", "INVALID_PARAMS"))?
        .min(1_000) as usize;
    let Some(summary) = sessions::session_summary(db, id).map_err(internal)? else {
        return Ok(json!({ "messages": [], "hasMoreBefore": false }));
    };
    let page = restore::history_page(db.data_dir(), id, before, limit).map_err(|error| {
        if error.is::<restore::ReadLimit>() {
            rpc_err(1002, error.to_string(), "LIMIT_EXCEEDED")
        } else {
            internal(error)
        }
    })?;
    // Use the same turn attribution as session.get, without returning the
    // session summary or unrelated compaction and plan records to RACP.
    let mut result = session_display::serialize(
        db,
        Some(SessionDetail {
            summary,
            messages: page
                .messages
                .into_iter()
                .map(sessions::record_to_ui)
                .collect(),
            plan_history: Vec::new(),
            navigation_parent: None,
            message_start: None,
            message_end: None,
            has_more_after: None,
            has_more_before: Some(page.has_more_before),
            compaction: None,
            compactions: Vec::new(),
        }),
    )?;
    Ok(json!({
        "messages": result["messages"].take(),
        "hasMoreBefore": page.has_more_before,
    }))
}

fn internal(error: anyhow::Error) -> JsonRpcError {
    rpc_err(1000, error.to_string(), "INTERNAL")
}

pub(super) fn restore_context(db: &Database, params: &Value) -> Result<Value, JsonRpcError> {
    let id = params
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| rpc_err(1002, "id required", "INVALID_PARAMS"))?;
    if sessions::session_summary(db, id)
        .map_err(internal)?
        .is_none()
    {
        return Ok(json!({ "session": null }));
    }
    let excluded: Vec<String> = params
        .get("excludeMessageIds")
        .and_then(Value::as_array)
        .map(|ids| {
            ids.iter()
                .filter_map(Value::as_str)
                .take(2)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    let read = crate::transcripts::context_restore::read_context(db.data_dir(), id, &excluded)
        .map_err(|error| {
            if error.is::<restore::ReadLimit>() {
                rpc_err(
                    1002,
                    "A single active context record exceeds the restore budget",
                    "LIMIT_EXCEEDED",
                )
            } else {
                internal(error)
            }
        })?;
    Ok(json!({ "session": {
        "messages": read.messages.into_iter().map(sessions::record_to_ui).collect::<Vec<_>>(),
        "compaction": read.compaction,
        "overflow": read.overflow,
        "omittedMessages": read.omitted_messages,
        "readBytes": read.read_bytes,
    }}))
}

/// Reject obviously unbounded legacy reads before parsing the retained bodies.
/// This is a request budget, not a session-size limit: pages remain available.
pub(super) fn preflight_full_read(db: &Database, id: &str) -> Result<(), JsonRpcError> {
    let path = crate::transcripts::transcript_path(db.data_dir(), id).map_err(internal)?;
    match std::fs::metadata(path) {
        Ok(metadata) if metadata.len() > 32 * 1024 * 1024 => Err(rpc_err(
            1002,
            "Full history exceeds the per-request read budget; use a history window",
            "LIMIT_EXCEEDED",
        )),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(internal(error.into())),
    }
}

pub(super) fn get_session(db: &Database, params: &Value) -> Result<Value, JsonRpcError> {
    let id = params
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| rpc_err(1002, "id required", "INVALID_PARAMS"))?;
    let message_before = params.get("messageBefore").and_then(|v| v.as_i64());
    let message_around = params
        .get("messageAround")
        .and_then(|v| v.as_str())
        .map(str::to_owned);
    let message_limit = params.get("messageLimit").and_then(|v| v.as_i64());
    if message_before.is_some_and(|value| value < 0)
        || message_limit.is_some_and(|value| value <= 0)
        || (message_around.is_some() && (message_before.is_some() || message_limit.is_none()))
    {
        return Err(rpc_err(
            1002,
            "session read window must use non-negative messageBefore and positive messageLimit",
            "INVALID_PARAMS",
        ));
    }
    let content_limit = params
        .get("contentLimit")
        .and_then(|v| v.as_u64())
        .map(|limit| limit.min(256 * 1024) as usize);
    if params
        .get("contentLimit")
        .and_then(|value| value.as_u64())
        .is_some_and(|value| value == 0)
    {
        return Err(rpc_err(
            1002,
            "session contentLimit must be positive",
            "INVALID_PARAMS",
        ));
    }
    if message_limit.is_none() {
        preflight_full_read(db, id)?;
    }
    let session = sessions::get_session_with_options(
        db,
        id,
        sessions::SessionReadOptions {
            message_around,
            message_before,
            message_limit,
            content_limit,
        },
    )
    .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
    let session = remote_tools::decorate_session(db, session_display::serialize(db, session)?)?;
    Ok(json!({ "session": session }))
}
