//! `market.reviewSummaries` and `market.reviews` (plugin reviews, read-only).
//!
//! The desktop reads reviews anonymously through the host: the renderer never
//! touches the network, and no session or credential is involved. The trusted
//! center origin is captured under the host state lock and the lock is
//! released before any I/O, so a slow or down center cannot stall unrelated
//! host requests behind the five-second review deadline.

use std::sync::Arc;

use serde_json::{json, Value};
use tokio::sync::Mutex;

use super::{plugin_err, rpc_err, JsonRpcError};
use crate::plugins::reviews::{
    fetch_review_summaries, fetch_reviews, PluginReviewQuery, ReviewSentiment, ReviewSort,
};
use crate::state::AppState;

/// Longest plugin id accepted; the manifest and catalog alphabet is far
/// smaller, and the bound keeps a renderer bug from building an endless URL.
const MAX_PLUGIN_ID_LEN: usize = 128;
const MAX_CURSOR_LEN: usize = 4096;
const DEFAULT_REVIEW_LIMIT: u32 = 20;
const MAX_REVIEW_LIMIT: u32 = 100;

pub(super) async fn handle(
    state: &Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    match method {
        "market.reviewSummaries" => review_summaries(state, params).await,
        "market.reviews" => reviews(state, params).await,
        _ => Err(rpc_err(
            -32601,
            format!("method not found: {method}"),
            "NOT_FOUND",
        )),
    }
}

/// Rating summaries for the given plugin ids.
///
/// The renderer sends whatever ids it is showing; the host deduplicates them
/// and batches to the center's hundred-id limit. An empty list answers with an
/// empty map without touching the network, because there is nothing to ask.
async fn review_summaries(
    state: &Arc<Mutex<AppState>>,
    params: Value,
) -> Result<Value, JsonRpcError> {
    let ids = parse_ids(&params)?;
    if ids.is_empty() {
        return Ok(json!({ "summaries": {} }));
    }
    let origin = review_origin(state).await?;
    let summaries = tokio::task::spawn_blocking(move || fetch_review_summaries(&origin, &ids))
        .await
        .map_err(worker_error)?
        .map_err(plugin_err)?;
    Ok(json!({ "summaries": summaries }))
}

/// One page of public reviews, with the summary and the trusted webpage URL.
async fn reviews(state: &Arc<Mutex<AppState>>, params: Value) -> Result<Value, JsonRpcError> {
    let query = parse_query(&params)?;
    let origin = review_origin(state).await?;
    let page = tokio::task::spawn_blocking(move || fetch_reviews(&origin, &query))
        .await
        .map_err(worker_error)?
        .map_err(plugin_err)?;
    serde_json::to_value(page).map_err(|error| {
        rpc_err(
            1000,
            format!("review page is not serializable: {error}"),
            "INTERNAL",
        )
    })
}

/// Capture the trusted review origin and release the state lock.
///
/// The center must never be able to hold `AppState`: a request that awaits the
/// network while the lock is held would queue every other host method behind
/// its deadline.
async fn review_origin(state: &Arc<Mutex<AppState>>) -> Result<String, JsonRpcError> {
    let origin = {
        let st = state.lock().await;
        st.plugins.review_origin()
    };
    origin.map_err(plugin_err)
}

fn worker_error(error: tokio::task::JoinError) -> JsonRpcError {
    rpc_err(1000, format!("review worker failed: {error}"), "INTERNAL")
}

fn parse_ids(params: &Value) -> Result<Vec<String>, JsonRpcError> {
    let raw = params
        .get("pluginIds")
        .ok_or_else(|| rpc_err(1002, "pluginIds required", "INVALID_PARAMS"))?;
    let items = raw.as_array().ok_or_else(|| {
        rpc_err(
            1002,
            "pluginIds must be an array of strings",
            "INVALID_PARAMS",
        )
    })?;
    let mut ids = Vec::with_capacity(items.len());
    for item in items {
        let id = item.as_str().ok_or_else(|| {
            rpc_err(
                1002,
                "pluginIds must be an array of strings",
                "INVALID_PARAMS",
            )
        })?;
        ids.push(validate_plugin_id(id)?);
    }
    Ok(ids)
}

fn parse_query(params: &Value) -> Result<PluginReviewQuery, JsonRpcError> {
    let plugin_id = params
        .get("pluginId")
        .and_then(Value::as_str)
        .ok_or_else(|| rpc_err(1002, "pluginId required", "INVALID_PARAMS"))?;
    let plugin_id = validate_plugin_id(plugin_id)?;
    let cursor = match params.get("cursor") {
        None | Some(Value::Null) => None,
        Some(Value::String(value)) => {
            let value = value.trim();
            if value.is_empty() {
                None
            } else if value.len() > MAX_CURSOR_LEN || value.chars().any(char::is_control) {
                return Err(rpc_err(1002, "cursor is invalid", "INVALID_PARAMS"));
            } else {
                Some(value.to_string())
            }
        }
        Some(_) => return Err(rpc_err(1002, "cursor must be a string", "INVALID_PARAMS")),
    };
    let limit = match params.get("limit") {
        None | Some(Value::Null) => DEFAULT_REVIEW_LIMIT,
        Some(value) => {
            let number = value
                .as_u64()
                .ok_or_else(|| rpc_err(1002, "limit must be a number", "INVALID_PARAMS"))?;
            if number == 0 || number > u64::from(MAX_REVIEW_LIMIT) {
                return Err(rpc_err(
                    1002,
                    format!("limit must be between 1 and {MAX_REVIEW_LIMIT}"),
                    "INVALID_PARAMS",
                ));
            }
            number as u32
        }
    };
    let sentiment = match params.get("sentiment") {
        None | Some(Value::Null) => ReviewSentiment::All,
        Some(value) => ReviewSentiment::parse(value.as_str().unwrap_or_default())
            .ok_or_else(|| rpc_err(1002, "sentiment is invalid", "INVALID_PARAMS"))?,
    };
    let sort = match params.get("sort") {
        None | Some(Value::Null) => ReviewSort::Newest,
        Some(value) => ReviewSort::parse(value.as_str().unwrap_or_default())
            .ok_or_else(|| rpc_err(1002, "sort is invalid", "INVALID_PARAMS"))?,
    };
    Ok(PluginReviewQuery {
        plugin_id,
        cursor,
        limit,
        sentiment,
        sort,
    })
}

/// A plugin id as the catalog and manifests spell it.
fn validate_plugin_id(value: &str) -> Result<String, JsonRpcError> {
    let id = value.trim();
    let valid = !id.is_empty()
        && id.len() <= MAX_PLUGIN_ID_LEN
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'));
    if !valid {
        let shown: String = value.chars().take(80).collect();
        return Err(rpc_err(
            1002,
            format!("invalid pluginId: {shown}"),
            "INVALID_PARAMS",
        ));
    }
    Ok(id.to_string())
}
