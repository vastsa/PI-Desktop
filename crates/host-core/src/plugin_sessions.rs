//! Host-owned P0/P1 session API for plugins.
//!
//! This module deliberately does not reuse the renderer's session RPCs. Every
//! query is scoped by the `(plugin_id, source_id, external_id)` origin sidecar,
//! and imported sessions do not acquire project/provider bindings unless an
//! explicit host-created project id is supplied.

use anyhow::{anyhow, Result};
use chrono::DateTime;
use rusqlite::{params, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

use crate::db::{ms_to_ts, now_ms, Database};
use crate::sessions::{self, UiMessage};
use crate::transcripts::{self, MessageRecord};

pub const MAX_IMPORT_MESSAGES: usize = 2_000;
pub const MAX_BATCH_SESSIONS: usize = 100;
pub const MAX_CONTENT_BYTES: usize = 512 * 1024;
pub const MAX_TOOL_VALUE_BYTES: usize = 256 * 1024;
pub const MAX_TOTAL_PAYLOAD_BYTES: usize = 32 * 1024 * 1024;
pub const MAX_JSON_DEPTH: usize = 8;
pub const MAX_TITLE_CHARS: usize = 200;
pub const MAX_EXTERNAL_ID_CHARS: usize = 256;
pub const MAX_SOURCE_CHARS: usize = 128;
pub const MAX_SOURCE_LABEL_CHARS: usize = 200;
pub const DEFAULT_LIST_LIMIT: usize = 50;
pub const MAX_LIST_LIMIT: usize = 200;
pub const DEFAULT_MESSAGE_LIMIT: usize = 100;
pub const MAX_MESSAGE_LIMIT: usize = 500;
pub const DEFAULT_CONTENT_LIMIT: usize = 64_000;
pub const MAX_CONTENT_LIMIT: usize = 512_000;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginMessageInput {
    role: String,
    content: String,
    created_at: String,
    model_id: Option<String>,
    provider_id: Option<String>,
    tool_name: Option<String>,
    tool_call_id: Option<String>,
    tool_status: Option<String>,
    tool_args: Option<Value>,
    tool_result: Option<Value>,
}

#[derive(Debug)]
struct PreparedImport {
    session_id: String,
    title: String,
    external_id: String,
    project_id: Option<i64>,
    created_at: String,
    created_ms: i64,
    updated_ms: i64,
    records: Vec<MessageRecord>,
    texts: Vec<Option<String>>,
    origin_json: String,
}

fn invalid(message: impl Into<String>) -> anyhow::Error {
    anyhow!("INVALID_PARAMS: {}", message.into())
}

fn limit(message: impl Into<String>) -> anyhow::Error {
    anyhow!("LIMIT_EXCEEDED: {}", message.into())
}

fn not_found(message: impl Into<String>) -> anyhow::Error {
    anyhow!("NOT_FOUND: {}", message.into())
}

fn code_error(code: &'static str, message: impl Into<String>) -> anyhow::Error {
    anyhow!("{code}: {}", message.into())
}

fn chars(value: &str) -> usize {
    value.chars().count()
}

fn required_text(value: &str, field: &str, max_chars: usize) -> Result<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(invalid(format!("{field} must not be empty")));
    }
    if chars(trimmed) > max_chars {
        return Err(limit(format!("{field} exceeds {max_chars} characters")));
    }
    Ok(trimmed.to_string())
}

fn optional_text(value: Option<String>, field: &str, max_chars: usize) -> Result<Option<String>> {
    let Some(value) = value else { return Ok(None) };
    if chars(&value) > max_chars {
        return Err(limit(format!("{field} exceeds {max_chars} characters")));
    }
    Ok(Some(value))
}

fn strict_timestamp(value: &str, field: &str) -> Result<(String, i64)> {
    if value.trim() != value || value.is_empty() {
        return Err(invalid(format!("{field} must be RFC3339")));
    }
    let parsed = DateTime::parse_from_rfc3339(value)
        .map_err(|_| invalid(format!("{field} must be RFC3339")))?;
    Ok((value.to_string(), parsed.timestamp_millis()))
}

fn json_depth(value: &Value) -> usize {
    match value {
        Value::Array(items) => 1 + items.iter().map(json_depth).max().unwrap_or(0),
        Value::Object(items) => 1 + items.values().map(json_depth).max().unwrap_or(0),
        _ => 1,
    }
}

pub fn validate_payload(value: &Value) -> Result<()> {
    let bytes = serde_json::to_vec(value)?.len();
    if bytes > MAX_TOTAL_PAYLOAD_BYTES {
        return Err(limit(format!(
            "payload exceeds {} MiB",
            MAX_TOTAL_PAYLOAD_BYTES / (1024 * 1024)
        )));
    }
    if json_depth(value) > MAX_JSON_DEPTH {
        return Err(limit(format!("JSON depth exceeds {MAX_JSON_DEPTH}")));
    }
    Ok(())
}

fn scrub_host_reserved(value: &mut Value) {
    match value {
        Value::Array(items) => items.iter_mut().for_each(scrub_host_reserved),
        Value::Object(object) => {
            object.retain(|key, _| !(key.starts_with("__pi") || key.starts_with("piDesktop.")));
            object.values_mut().for_each(scrub_host_reserved);
        }
        _ => {}
    }
}

fn validate_json_value(value: &Value, field: &str) -> Result<Value> {
    let mut sanitized = value.clone();
    scrub_host_reserved(&mut sanitized);
    if serde_json::to_vec(&sanitized)?.len() > MAX_TOOL_VALUE_BYTES {
        return Err(limit(format!(
            "{field} exceeds {} KiB",
            MAX_TOOL_VALUE_BYTES / 1024
        )));
    }
    Ok(sanitized)
}

fn parse_message(
    input: &PluginMessageInput,
    previous_ms: &mut Option<i64>,
    tool_call_map: &mut HashMap<String, String>,
) -> Result<UiMessage> {
    let role = input.role.trim();
    if !matches!(role, "user" | "assistant" | "tool") {
        return Err(invalid(format!("unknown message role {role:?}")));
    }
    if input.content.len() > MAX_CONTENT_BYTES {
        return Err(limit(format!(
            "message content exceeds {} KiB",
            MAX_CONTENT_BYTES / 1024
        )));
    }
    let (created_at, created_ms) = strict_timestamp(&input.created_at, "message.createdAt")?;
    if previous_ms.is_some_and(|previous| created_ms < previous) {
        return Err(invalid("message timestamps must be monotonic"));
    }
    *previous_ms = Some(created_ms);

    let model_id = optional_text(input.model_id.clone(), "message.modelId", 256)?;
    let provider_id = optional_text(input.provider_id.clone(), "message.providerId", 256)?;
    let (tool_name, tool_call_id, tool_status, tool_args, tool_result) = if role == "tool" {
        let tool_name = required_text(
            input.tool_name.as_deref().unwrap_or_default(),
            "message.toolName",
            256,
        )?;
        let external_call_id = required_text(
            input.tool_call_id.as_deref().unwrap_or_default(),
            "message.toolCallId",
            256,
        )?;
        let internal_call_id = tool_call_map
            .entry(external_call_id)
            .or_insert_with(|| Uuid::new_v4().to_string())
            .clone();
        let status = input.tool_status.as_deref().unwrap_or_default();
        if !matches!(status, "success" | "error") {
            return Err(invalid("message.toolStatus must be success or error"));
        }
        let args = input
            .tool_args
            .as_ref()
            .map(|value| validate_json_value(value, "message.toolArgs"))
            .transpose()?;
        let result = input
            .tool_result
            .as_ref()
            .map(|value| validate_json_value(value, "message.toolResult"))
            .transpose()?;
        (
            Some(tool_name),
            Some(internal_call_id),
            Some(status.to_string()),
            args,
            result,
        )
    } else {
        if input.tool_name.is_some()
            || input.tool_call_id.is_some()
            || input.tool_status.is_some()
            || input.tool_args.is_some()
            || input.tool_result.is_some()
        {
            return Err(invalid("tool fields are only valid for tool messages"));
        }
        (None, None, None, None, None)
    };

    Ok(UiMessage {
        id: Uuid::new_v4().to_string(),
        role: role.to_string(),
        content: input.content.clone(),
        attachments: None,
        created_at,
        thinking: None,
        status: None,
        model_id,
        provider_id,
        usage: None,
        response_duration_ms: None,
        response_output_tokens: None,
        error: None,
        revision_root_id: None,
        revision_count: None,
        active_revision: None,
        tool_name,
        tool_call_id,
        tool_status,
        tool_args,
        tool_result,
        tool_completed_at: None,
        tool_duration_ms: None,
        is_error: None,
        parent_tool_call_id: None,
        agent_name: None,
    })
}

fn prepare_import(
    db: &Database,
    item: &Value,
    session_id: String,
    source_label: Option<&str>,
) -> Result<PreparedImport> {
    let object = item
        .as_object()
        .ok_or_else(|| invalid("session must be an object"))?;
    let external_id = required_text(
        object
            .get("externalId")
            .and_then(Value::as_str)
            .unwrap_or_default(),
        "externalId",
        MAX_EXTERNAL_ID_CHARS,
    )?;
    let title = required_text(
        object
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or_default(),
        "title",
        MAX_TITLE_CHARS,
    )?;
    let created_at = object
        .get("createdAt")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("createdAt is required"))?;
    let updated_at = object
        .get("updatedAt")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("updatedAt is required"))?;
    let (created_at, created_ms) = strict_timestamp(created_at, "createdAt")?;
    let (_, updated_ms) = strict_timestamp(updated_at, "updatedAt")?;
    if created_ms > updated_ms {
        return Err(invalid("createdAt must be at or before updatedAt"));
    }
    let raw_messages = object
        .get("messages")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("messages must be an array"))?;
    if raw_messages.len() > MAX_IMPORT_MESSAGES {
        return Err(limit(format!("messages exceed {MAX_IMPORT_MESSAGES}")));
    }
    let mut messages = Vec::with_capacity(raw_messages.len());
    let mut previous_ms = None;
    let mut tool_call_map = HashMap::new();
    for raw in raw_messages {
        let message: PluginMessageInput =
            serde_json::from_value(raw.clone()).map_err(|error| invalid(error.to_string()))?;
        messages.push(parse_message(
            &message,
            &mut previous_ms,
            &mut tool_call_map,
        )?);
    }
    let mut records = Vec::with_capacity(messages.len());
    let mut texts = Vec::with_capacity(messages.len());
    for message in &messages {
        let (record, text) = sessions::ui_to_record(message);
        records.push(record);
        texts.push(text);
    }
    let project_path = optional_text(
        object
            .get("projectPath")
            .and_then(Value::as_str)
            .map(str::to_string),
        "projectPath",
        4_096,
    )?;
    let project_id = match object.get("projectId") {
        None | Some(Value::Null) => None,
        Some(value) => {
            let id = value
                .as_i64()
                .filter(|id| *id > 0)
                .ok_or_else(|| invalid("projectId must be a positive integer"))?;
            if db.project_path(id)?.is_none() {
                return Err(not_found("project not found"));
            }
            Some(id)
        }
    };
    let model_id = optional_text(
        object
            .get("modelId")
            .and_then(Value::as_str)
            .map(str::to_string),
        "modelId",
        256,
    )?;
    let provider_id = optional_text(
        object
            .get("providerId")
            .and_then(Value::as_str)
            .map(str::to_string),
        "providerId",
        256,
    )?;
    let origin_json = serde_json::to_string(&json!({
        "projectPath": project_path,
        "modelId": model_id,
        "providerId": provider_id,
    }))?;
    if let Some(label) = source_label {
        if chars(label) > MAX_SOURCE_LABEL_CHARS {
            return Err(limit(format!(
                "sourceLabel exceeds {MAX_SOURCE_LABEL_CHARS} characters"
            )));
        }
    }
    Ok(PreparedImport {
        session_id,
        title,
        external_id,
        project_id,
        created_at,
        created_ms,
        updated_ms,
        records,
        texts,
        origin_json,
    })
}

fn validate_source(source: &str) -> Result<String> {
    required_text(source, "source", MAX_SOURCE_CHARS)
}

fn parse_source_label(value: &Value) -> Result<Option<&str>> {
    let Some(raw) = value.get("sourceLabel") else {
        return Ok(None);
    };
    let label = raw
        .as_str()
        .ok_or_else(|| invalid("sourceLabel must be a string"))?;
    if chars(label) > MAX_SOURCE_LABEL_CHARS {
        return Err(limit(format!(
            "sourceLabel exceeds {MAX_SOURCE_LABEL_CHARS} characters"
        )));
    }
    Ok(Some(label))
}

fn cursor_offset(value: Option<&Value>) -> Result<usize> {
    let Some(value) = value else { return Ok(0) };
    let raw = value
        .as_str()
        .ok_or_else(|| invalid("cursor must be a string"))?;
    raw.parse::<usize>()
        .map_err(|_| invalid("cursor is invalid"))
}

fn find_origin(
    db: &Database,
    plugin_id: &str,
    source: &str,
    external_id: &str,
) -> Result<Option<String>> {
    Ok(db
        .conn()
        .prepare_cached(
            "SELECT session_id FROM session_import_origins
             WHERE plugin_id = ?1 AND source_id = ?2 AND external_id = ?3",
        )?
        .query_row(params![plugin_id, source, external_id], |row| row.get(0))
        .optional()?)
}

fn write_and_index(
    db: &Database,
    plugin_id: &str,
    source: &str,
    source_label: Option<&str>,
    prepared: &PreparedImport,
) -> Result<()> {
    sessions::invalidate_transcript_layout(&prepared.session_id);
    transcripts::write_transcript(
        db.data_dir(),
        &prepared.session_id,
        &prepared.created_at,
        &prepared.records,
    )?;
    let indexed = (|| -> Result<()> {
        let tx = db.conn().unchecked_transaction()?;
        tx.execute(
            "INSERT INTO sessions (
                id, title, project_id, provider_id, model_id, mode,
                thinking_level, permission_mode, source, last_seq,
                created_at, updated_at
            ) VALUES (?1, ?2, ?3, NULL, NULL, 'agent', 'off', 'inherit',
                       ?4, ?5, ?6, ?7)",
            params![
                prepared.session_id,
                prepared.title,
                prepared.project_id,
                source,
                prepared.records.len() as i64,
                prepared.created_ms,
                prepared.updated_ms
            ],
        )?;
        for (seq, record) in prepared.records.iter().enumerate() {
            sessions::insert_index_row(
                &tx,
                &prepared.session_id,
                seq as i64,
                None,
                record,
                prepared.texts[seq].as_deref(),
            )?;
        }
        tx.execute(
            "INSERT INTO session_import_origins (
                plugin_id, source_id, external_id, session_id, source_label,
                origin_json, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                plugin_id,
                source,
                prepared.external_id,
                prepared.session_id,
                source_label,
                prepared.origin_json,
                prepared.created_ms
            ],
        )?;
        tx.commit()?;
        Ok(())
    })();
    if let Err(error) = indexed {
        transcripts::remove_session_files(db.data_dir(), &prepared.session_id);
        return Err(error);
    }
    Ok(())
}

fn import_one(
    db: &Database,
    plugin_id: &str,
    source: &str,
    source_label: Option<&str>,
    item: &Value,
) -> Result<Value> {
    validate_payload(item)?;
    let prepared = prepare_import(db, item, Uuid::new_v4().to_string(), source_label)?;
    if let Some(session_id) = find_origin(db, plugin_id, source, &prepared.external_id)? {
        return Ok(json!({
            "sessionId": session_id,
            "imported": false,
            "skipped": true
        }));
    }
    match write_and_index(db, plugin_id, source, source_label, &prepared) {
        Ok(()) => Ok(json!({
            "sessionId": prepared.session_id,
            "imported": true,
            "skipped": false
        })),
        Err(error) if error.to_string().contains("UNIQUE constraint failed") => {
            let session_id =
                find_origin(db, plugin_id, source, &prepared.external_id)?.ok_or(error)?;
            Ok(json!({
                "sessionId": session_id,
                "imported": false,
                "skipped": true
            }))
        }
        Err(error) => Err(error),
    }
}

fn failure_result(external_id: &str, error: &anyhow::Error) -> Value {
    let message = error.to_string();
    let (error_code, error_message) = message
        .split_once(": ")
        .map(|(code, text)| (code.to_string(), text.to_string()))
        .unwrap_or_else(|| ("INTERNAL".into(), message));
    json!({
        "externalId": external_id,
        "sessionId": Value::Null,
        "status": "failed",
        "errorCode": error_code,
        "errorMessage": error_message,
    })
}

pub fn import(db: &Database, plugin_id: &str, params: &Value) -> Result<Value> {
    validate_payload(params)?;
    let source = validate_source(
        params
            .get("source")
            .and_then(Value::as_str)
            .unwrap_or_default(),
    )?;
    let source_label = parse_source_label(params)?;
    let item = params.clone();
    import_one(db, plugin_id, &source, source_label, &item)
}

pub fn import_batch(db: &Database, plugin_id: &str, params: &Value) -> Result<Value> {
    validate_payload(params)?;
    let source = validate_source(
        params
            .get("source")
            .and_then(Value::as_str)
            .unwrap_or_default(),
    )?;
    let source_label = parse_source_label(params)?;
    let items = params
        .get("sessions")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("sessions must be an array"))?;
    if items.len() > MAX_BATCH_SESSIONS {
        return Err(limit(format!(
            "batch exceeds {MAX_BATCH_SESSIONS} sessions"
        )));
    }
    let mode = params.get("mode").and_then(Value::as_str).unwrap_or("skip");
    if !matches!(mode, "skip" | "fail") {
        return Err(invalid("mode must be skip or fail"));
    }

    if mode == "skip" {
        let mut results = Vec::with_capacity(items.len());
        let mut imported = 0;
        let mut skipped = 0;
        let mut failed = 0;
        for item in items {
            let external_id = item.get("externalId").and_then(Value::as_str).unwrap_or("");
            match import_one(db, plugin_id, &source, source_label, item) {
                Ok(result) => {
                    if result.get("imported").and_then(Value::as_bool) == Some(true) {
                        imported += 1;
                        results.push(json!({
                            "externalId": external_id,
                            "sessionId": result["sessionId"],
                            "status": "imported"
                        }));
                    } else {
                        skipped += 1;
                        results.push(json!({
                            "externalId": external_id,
                            "sessionId": result["sessionId"],
                            "status": "skipped"
                        }));
                    }
                }
                Err(error) => {
                    failed += 1;
                    results.push(failure_result(external_id, &error));
                }
            }
        }
        return Ok(
            json!({ "results": results, "imported": imported, "skipped": skipped, "failed": failed }),
        );
    }

    let mut prepared = Vec::with_capacity(items.len());
    let mut errors = Vec::new();
    let mut seen = HashSet::new();
    for item in items {
        let external_id = item
            .get("externalId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        match prepare_import(db, item, Uuid::new_v4().to_string(), source_label) {
            Ok(value) => {
                if !seen.insert(value.external_id.clone()) {
                    errors.push((
                        external_id,
                        code_error("CONFLICT", "duplicate externalId in batch"),
                    ));
                } else if find_origin(db, plugin_id, &source, &value.external_id)?.is_some() {
                    errors.push((
                        external_id,
                        code_error("CONFLICT", "externalId already exists"),
                    ));
                } else {
                    prepared.push(value);
                }
            }
            Err(error) => errors.push((external_id, error)),
        }
    }
    if !errors.is_empty() {
        let mut results = Vec::with_capacity(items.len());
        let errors_by_id: HashMap<String, &anyhow::Error> = errors
            .iter()
            .map(|(id, error)| (id.clone(), error))
            .collect();
        for item in items {
            let external_id = item.get("externalId").and_then(Value::as_str).unwrap_or("");
            let error = errors_by_id.get(external_id).copied().unwrap_or_else(|| {
                errors
                    .first()
                    .map(|(_, error)| error)
                    .expect("batch error list is non-empty")
            });
            results.push(failure_result(external_id, error));
        }
        return Ok(
            json!({ "results": results, "imported": 0, "skipped": 0, "failed": items.len() }),
        );
    }

    let mut written: Vec<String> = Vec::with_capacity(prepared.len());
    for item in &prepared {
        sessions::invalidate_transcript_layout(&item.session_id);
        if let Err(error) = transcripts::write_transcript(
            db.data_dir(),
            &item.session_id,
            &item.created_at,
            &item.records,
        ) {
            for id in &written {
                transcripts::remove_session_files(db.data_dir(), id);
            }
            transcripts::remove_session_files(db.data_dir(), &item.session_id);
            return Err(error);
        }
        written.push(item.session_id.clone());
    }
    let indexed = (|| -> Result<()> {
        let tx = db.conn().unchecked_transaction()?;
        for item in &prepared {
            tx.execute(
                "INSERT INTO sessions (
                    id, title, project_id, provider_id, model_id, mode,
                    thinking_level, permission_mode, source, last_seq,
                    created_at, updated_at
                ) VALUES (?1, ?2, ?3, NULL, NULL, 'agent', 'off', 'inherit',
                           ?4, ?5, ?6, ?7)",
                params![
                    item.session_id,
                    item.title,
                    item.project_id,
                    source,
                    item.records.len() as i64,
                    item.created_ms,
                    item.updated_ms
                ],
            )?;
            for (seq, record) in item.records.iter().enumerate() {
                sessions::insert_index_row(
                    &tx,
                    &item.session_id,
                    seq as i64,
                    None,
                    record,
                    item.texts[seq].as_deref(),
                )?;
            }
            tx.execute(
                "INSERT INTO session_import_origins (
                    plugin_id, source_id, external_id, session_id, source_label,
                    origin_json, created_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    plugin_id,
                    source,
                    item.external_id,
                    item.session_id,
                    source_label,
                    item.origin_json,
                    item.created_ms
                ],
            )?;
        }
        tx.commit()?;
        Ok(())
    })();
    if let Err(error) = indexed {
        for id in &written {
            transcripts::remove_session_files(db.data_dir(), id);
        }
        return Err(error);
    }
    let results = prepared
        .iter()
        .map(|item| {
            json!({
                "externalId": item.external_id,
                "sessionId": item.session_id,
                "status": "imported"
            })
        })
        .collect::<Vec<_>>();
    Ok(json!({ "results": results, "imported": prepared.len(), "skipped": 0, "failed": 0 }))
}

fn history_from_json(raw: Option<String>) -> Value {
    raw.and_then(|value| serde_json::from_str::<Value>(&value).ok())
        .unwrap_or_else(|| json!({ "projectPath": null, "modelId": null, "providerId": null }))
}

fn session_view(
    session_id: String,
    title: String,
    source: String,
    external_id: String,
    project_id: Option<i64>,
    message_count: i64,
    created_at: i64,
    updated_at: i64,
) -> Value {
    json!({
        "sessionId": session_id,
        "title": title,
        "source": source,
        "externalId": external_id,
        "projectId": project_id,
        "messageCount": message_count,
        "originKind": "imported",
        "bound": { "workspace": project_id.is_some(), "model": false },
        "createdAt": ms_to_ts(created_at),
        "updatedAt": ms_to_ts(updated_at),
    })
}

pub fn list(db: &Database, plugin_id: &str, params_value: &Value) -> Result<Value> {
    validate_payload(params_value)?;
    let page_limit = match params_value.get("limit") {
        None => DEFAULT_LIST_LIMIT,
        Some(value) => value
            .as_u64()
            .ok_or_else(|| invalid("limit must be a number"))?
            .try_into()
            .map_err(|_| limit("limit is too large"))?,
    };
    if page_limit == 0 || page_limit > MAX_LIST_LIMIT {
        return Err(limit(format!("limit must be 1..{MAX_LIST_LIMIT}")));
    }
    let offset = cursor_offset(params_value.get("cursor"))?;
    let source = params_value
        .get("source")
        .map(|value| {
            value
                .as_str()
                .ok_or_else(|| invalid("source must be a string"))
                .and_then(validate_source)
        })
        .transpose()?;
    let updated_after = params_value
        .get("updatedAfter")
        .and_then(Value::as_str)
        .map(|value| strict_timestamp(value, "updatedAfter").map(|(_, ms)| ms))
        .transpose()?;
    let mut sql = String::from(
        "SELECT s.id, s.title, s.source, oi.external_id, s.project_id, s.last_seq,
                s.created_at, s.updated_at
         FROM sessions s
         JOIN session_import_origins oi ON oi.session_id = s.id
         WHERE oi.plugin_id = ?1 AND s.deleted_at IS NULL",
    );
    if source.is_some() {
        sql.push_str(" AND oi.source_id = ?2");
    }
    if updated_after.is_some() {
        sql.push_str(if source.is_some() {
            " AND s.updated_at > ?3"
        } else {
            " AND s.updated_at > ?2"
        });
    }
    sql.push_str(if source.is_some() && updated_after.is_some() {
        " ORDER BY s.updated_at DESC, s.id DESC LIMIT ?4 OFFSET ?5"
    } else if source.is_some() {
        " ORDER BY s.updated_at DESC, s.id DESC LIMIT ?3 OFFSET ?4"
    } else if updated_after.is_some() {
        " ORDER BY s.updated_at DESC, s.id DESC LIMIT ?3 OFFSET ?4"
    } else {
        " ORDER BY s.updated_at DESC, s.id DESC LIMIT ?2 OFFSET ?3"
    });
    let mut stmt = db.conn().prepare(&sql)?;
    let mut rows = match (source, updated_after) {
        (Some(source), Some(updated_after)) => stmt.query(params![
            plugin_id,
            source,
            updated_after,
            page_limit as i64,
            offset as i64
        ])?,
        (Some(source), None) => {
            stmt.query(params![plugin_id, source, page_limit as i64, offset as i64])?
        }
        (None, Some(updated_after)) => stmt.query(params![
            plugin_id,
            updated_after,
            page_limit as i64,
            offset as i64
        ])?,
        (None, None) => stmt.query(params![plugin_id, page_limit as i64, offset as i64])?,
    };
    let mut items = Vec::new();
    while let Some(row) = rows.next()? {
        items.push(session_view(
            row.get(0)?,
            row.get(1)?,
            row.get::<_, Option<String>>(2)?.unwrap_or_default(),
            row.get(3)?,
            row.get(4)?,
            row.get(5)?,
            row.get(6)?,
            row.get(7)?,
        ));
    }
    let next_cursor = (items.len() == page_limit).then(|| (offset + items.len()).to_string());
    let mut response = Map::new();
    response.insert("items".into(), Value::Array(items));
    if let Some(cursor) = next_cursor {
        response.insert("nextCursor".into(), Value::String(cursor));
    }
    Ok(Value::Object(response))
}

fn own_session_row(
    db: &Database,
    plugin_id: &str,
    session_id: &str,
) -> Result<
    Option<(
        String,
        String,
        String,
        i64,
        i64,
        i64,
        Option<i64>,
        Option<String>,
    )>,
> {
    Ok(db
        .conn()
        .prepare_cached(
            "SELECT s.title, s.source, oi.external_id, s.last_seq,
                    s.created_at, s.updated_at, s.project_id, oi.origin_json
             FROM sessions s
             JOIN session_import_origins oi ON oi.session_id = s.id
             WHERE oi.plugin_id = ?1 AND s.id = ?2 AND s.deleted_at IS NULL",
        )?
        .query_row(params![plugin_id, session_id], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
                row.get(6)?,
                row.get(7)?,
            ))
        })
        .optional()?)
}

fn owns_session(db: &Database, plugin_id: &str, session_id: &str) -> Result<bool> {
    Ok(db
        .conn()
        .prepare_cached(
            "SELECT EXISTS(
                SELECT 1 FROM sessions s
                JOIN session_import_origins oi ON oi.session_id = s.id
                WHERE oi.plugin_id = ?1 AND s.id = ?2
            )",
        )?
        .query_row(params![plugin_id, session_id], |row| row.get(0))?)
}

pub fn get(db: &Database, plugin_id: &str, params_value: &Value) -> Result<Value> {
    validate_payload(params_value)?;
    let session_id = required_text(
        params_value
            .get("sessionId")
            .and_then(Value::as_str)
            .unwrap_or_default(),
        "sessionId",
        128,
    )?;
    let Some((
        title,
        source,
        external_id,
        message_count,
        created_at,
        updated_at,
        project_id,
        origin_json,
    )) = own_session_row(db, plugin_id, &session_id)?
    else {
        return Err(not_found("session not found"));
    };
    let project_path = project_id
        .map(|id| db.project_path(id))
        .transpose()?
        .flatten();
    let history = history_from_json(origin_json);
    Ok(json!({
        "sessionId": session_id,
        "title": title,
        "source": source,
        "externalId": external_id,
        "originKind": "imported",
        "projectId": project_id,
        "projectPath": project_path,
        "modelId": Value::Null,
        "providerId": Value::Null,
        "bound": { "workspace": project_id.is_some(), "model": false },
        "history": history,
        "messageCount": message_count,
        "createdAt": ms_to_ts(created_at),
        "updatedAt": ms_to_ts(updated_at),
    }))
}

fn truncate_chars(value: &str, limit: usize) -> (String, bool) {
    let mut chars = value.chars();
    let truncated = chars.clone().nth(limit).is_some();
    let result = chars.by_ref().take(limit).collect::<String>();
    (result, truncated)
}

fn plugin_message(record: MessageRecord, content_limit: usize) -> Value {
    let message = sessions::record_to_ui(record);
    let (content, content_truncated) = truncate_chars(&message.content, content_limit);
    let mut result = json!({
        "id": message.id,
        "role": message.role,
        "content": content,
        "createdAt": message.created_at,
        "origin": "external",
    });
    if content_truncated {
        result["contentTruncated"] = Value::Bool(true);
    }
    if message.role == "tool" {
        result["tool"] = json!({
            "name": message.tool_name,
            "callId": message.tool_call_id,
            "status": message.tool_status,
            "args": message.tool_args,
            "result": message.tool_result,
        });
    }
    result
}

pub fn list_messages(db: &Database, plugin_id: &str, params_value: &Value) -> Result<Value> {
    validate_payload(params_value)?;
    let session_id = required_text(
        params_value
            .get("sessionId")
            .and_then(Value::as_str)
            .unwrap_or_default(),
        "sessionId",
        128,
    )?;
    if own_session_row(db, plugin_id, &session_id)?.is_none() {
        return Err(not_found("session not found"));
    }
    let page_limit = match params_value.get("limit") {
        None => DEFAULT_MESSAGE_LIMIT,
        Some(value) => value
            .as_u64()
            .ok_or_else(|| invalid("limit must be a number"))?
            .try_into()
            .map_err(|_| limit("limit is too large"))?,
    };
    if page_limit == 0 || page_limit > MAX_MESSAGE_LIMIT {
        return Err(limit(format!("limit must be 1..{MAX_MESSAGE_LIMIT}")));
    }
    let content_limit = match params_value.get("contentLimit") {
        None => DEFAULT_CONTENT_LIMIT,
        Some(value) => value
            .as_u64()
            .ok_or_else(|| invalid("contentLimit must be a number"))?
            .try_into()
            .map_err(|_| limit("contentLimit is too large"))?,
    };
    if content_limit == 0 || content_limit > MAX_CONTENT_LIMIT {
        return Err(limit(format!(
            "contentLimit must be 1..{MAX_CONTENT_LIMIT}"
        )));
    }
    let order = params_value
        .get("order")
        .and_then(Value::as_str)
        .unwrap_or("asc");
    if !matches!(order, "asc" | "desc") {
        return Err(invalid("order must be asc or desc"));
    }
    let offset = cursor_offset(params_value.get("cursor"))?;
    let mut records = transcripts::read_transcript(db.data_dir(), &session_id)?;
    if order == "desc" {
        records.reverse();
    }
    let end = offset.saturating_add(page_limit).min(records.len());
    let items = if offset >= records.len() {
        Vec::new()
    } else {
        records[offset..end]
            .iter()
            .cloned()
            .map(|record| plugin_message(record, content_limit))
            .collect::<Vec<_>>()
    };
    let next_cursor = (end < records.len()).then(|| end.to_string());
    let mut response = Map::new();
    response.insert("items".into(), Value::Array(items));
    if let Some(cursor) = next_cursor {
        response.insert("nextCursor".into(), Value::String(cursor));
    }
    Ok(Value::Object(response))
}

pub fn rename(db: &Database, plugin_id: &str, params_value: &Value) -> Result<Value> {
    validate_payload(params_value)?;
    let session_id = required_text(
        params_value
            .get("sessionId")
            .and_then(Value::as_str)
            .unwrap_or_default(),
        "sessionId",
        128,
    )?;
    let title = required_text(
        params_value
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or_default(),
        "title",
        MAX_TITLE_CHARS,
    )?;
    if own_session_row(db, plugin_id, &session_id)?.is_none() {
        return Err(not_found("session not found"));
    }
    db.conn().execute(
        "UPDATE sessions SET title = ?1 WHERE id = ?2 AND deleted_at IS NULL",
        params![title, session_id],
    )?;
    Ok(json!({ "updated": true }))
}

pub fn delete(db: &Database, plugin_id: &str, params_value: &Value) -> Result<Value> {
    validate_payload(params_value)?;
    let session_id = required_text(
        params_value
            .get("sessionId")
            .and_then(Value::as_str)
            .unwrap_or_default(),
        "sessionId",
        128,
    )?;
    let mode = params_value
        .get("mode")
        .and_then(Value::as_str)
        .unwrap_or("trash");
    if !matches!(mode, "trash" | "purge") {
        return Err(invalid("mode must be trash or purge"));
    }
    if !owns_session(db, plugin_id, &session_id)? {
        return Err(not_found("session not found"));
    }
    if mode == "purge" {
        let changed = db.conn().execute(
            "DELETE FROM sessions WHERE id = ?1 AND EXISTS (
                SELECT 1 FROM session_import_origins
                WHERE session_id = ?1 AND plugin_id = ?2
             )",
            params![session_id, plugin_id],
        )?;
        if changed == 0 {
            return Err(not_found("session not found"));
        }
        sessions::invalidate_transcript_layout(&session_id);
        transcripts::remove_session_files(db.data_dir(), &session_id);
    } else {
        db.conn().execute(
            "UPDATE sessions SET deleted_at = ?1
             WHERE id = ?2 AND EXISTS (
                SELECT 1 FROM session_import_origins
                WHERE session_id = ?2 AND plugin_id = ?3
             )",
            params![now_ms(), session_id, plugin_id],
        )?;
    }
    Ok(json!({ "deleted": true }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;
    use tempfile::tempdir;

    fn db() -> (tempfile::TempDir, Database) {
        let dir = tempdir().unwrap();
        let db = Database::open_in_dir(dir.path()).unwrap();
        (dir, db)
    }

    fn item(external_id: &str, message_time: &str) -> Value {
        json!({
            "externalId": external_id,
            "title": "Imported",
            "projectPath": "/history/project",
            "modelId": "old-model",
            "providerId": "old-provider",
            "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": "2026-01-01T00:00:10Z",
            "messages": [{
                "role": "user",
                "content": "hello",
                "createdAt": message_time
            }]
        })
    }

    #[test]
    fn import_is_host_owned_idempotent_and_keeps_history_unbound() {
        let (_dir, db) = db();
        let input = item("external-1", "2026-01-01T00:00:01Z");
        let first = import(
            &db,
            "plugin.one",
            &json!({ "source": "legacy", "sourceLabel": "Legacy", "sourceItem": input }),
        );
        assert!(
            first.is_err(),
            "the envelope must not be accepted as an item"
        );
        let mut request = input.clone();
        request["source"] = json!("legacy");
        request["sourceLabel"] = json!("Legacy");
        let first = import(&db, "plugin.one", &request).unwrap();
        assert_eq!(first["imported"], true);
        let id = first["sessionId"].as_str().unwrap().to_string();
        assert_ne!(id, "external-1");
        let second = import(&db, "plugin.one", &request).unwrap();
        assert_eq!(second["sessionId"], id);
        assert_eq!(second["skipped"], true);
        let detail = get(&db, "plugin.one", &json!({ "sessionId": id })).unwrap();
        assert_eq!(detail["projectPath"], Value::Null);
        assert_eq!(detail["modelId"], Value::Null);
        assert_eq!(detail["history"]["projectPath"], "/history/project");
        assert_eq!(db.list_projects().unwrap().len(), 0);
    }

    #[test]
    fn import_can_use_an_explicit_host_project_id() {
        let (_dir, db) = db();
        let project_id = db.ensure_project("/history/project", false).unwrap();
        let mut input = item("external-bound", "2026-01-01T00:00:01Z");
        input["projectId"] = json!(project_id);
        input["source"] = json!("legacy");
        input["sourceLabel"] = json!("Legacy");

        let result = import(&db, "plugin.one", &input).unwrap();
        let session_id = result["sessionId"].as_str().unwrap();
        let detail = get(&db, "plugin.one", &json!({ "sessionId": session_id })).unwrap();
        assert_eq!(detail["projectId"], project_id);
        assert_eq!(detail["projectPath"], "/history/project");
        assert_eq!(detail["bound"]["workspace"], true);

        let listed = list(&db, "plugin.one", &json!({})).unwrap();
        assert_eq!(listed["items"][0]["projectId"], project_id);
        assert_eq!(listed["items"][0]["bound"]["workspace"], true);

        let mut batch_item = item("external-batch-bound", "2026-01-01T00:00:02Z");
        batch_item["projectId"] = json!(project_id);
        let batch = import_batch(
            &db,
            "plugin.one",
            &json!({ "source": "legacy", "sessions": [batch_item] }),
        )
        .unwrap();
        let batch_session_id = batch["results"][0]["sessionId"].as_str().unwrap();
        let batch_detail =
            get(&db, "plugin.one", &json!({ "sessionId": batch_session_id })).unwrap();
        assert_eq!(batch_detail["projectId"], project_id);
        assert_eq!(batch_detail["bound"]["workspace"], true);
    }

    #[test]
    fn import_rejects_unknown_project_ids_without_writing() {
        let (_dir, db) = db();
        let mut input = item("external-missing-project", "2026-01-01T00:00:01Z");
        input["projectId"] = json!(999_999);
        input["source"] = json!("legacy");
        assert!(import(&db, "plugin.one", &input)
            .unwrap_err()
            .to_string()
            .starts_with("NOT_FOUND"));
        let count: i64 = db
            .conn()
            .query_row("SELECT COUNT(*) FROM sessions", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn invalid_input_is_rejected_without_a_row() {
        let (_dir, db) = db();
        let mut input = item("bad", "2026-01-01T00:00:02Z");
        input["messages"][0]["role"] = json!("system");
        assert!(import(&db, "plugin.one", &input)
            .unwrap_err()
            .to_string()
            .starts_with("INVALID_PARAMS"));
        let count: i64 = db
            .conn()
            .query_row("SELECT COUNT(*) FROM sessions", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn batch_skip_is_partial_and_fail_rolls_back() {
        let (_dir, db) = db();
        let mut bad = item("bad", "2026-01-01T00:00:01Z");
        bad["messages"][0]["toolStatus"] = json!("running");
        let batch = json!({
            "source": "legacy",
            "sessions": [item("one", "2026-01-01T00:00:01Z"), bad],
            "mode": "skip"
        });
        let result = import_batch(&db, "plugin.one", &batch).unwrap();
        assert_eq!(result["imported"], 1);
        assert_eq!(result["failed"], 1);
        let fail_batch = json!({
            "source": "legacy",
            "sessions": [item("two", "2026-01-01T00:00:01Z"), bad],
            "mode": "fail"
        });
        let result = import_batch(&db, "plugin.one", &fail_batch).unwrap();
        assert_eq!(result["imported"], 0);
        assert_eq!(result["failed"], 2);
        let count: i64 = db
            .conn()
            .query_row("SELECT COUNT(*) FROM sessions", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn ownership_filters_other_plugins_and_purge_allows_reimport() {
        let (_dir, db) = db();
        let mut input = item("same", "2026-01-01T00:00:01Z");
        input["source"] = json!("legacy");
        let id = import(&db, "plugin.one", &input).unwrap()["sessionId"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(get(&db, "plugin.two", &json!({ "sessionId": id })).is_err());
        assert!(delete(
            &db,
            "plugin.one",
            &json!({ "sessionId": id, "mode": "purge" })
        )
        .is_ok());
        let reimported = import(&db, "plugin.one", &input).unwrap();
        assert_eq!(reimported["imported"], true);
        assert_ne!(reimported["sessionId"], id);
    }

    #[test]
    fn list_rename_trash_and_purge_follow_plugin_ownership() {
        let (_dir, db) = db();
        let mut input = item("lifecycle", "2026-01-01T00:00:01Z");
        input["source"] = json!("legacy");
        let id = import(&db, "plugin.one", &input).unwrap()["sessionId"]
            .as_str()
            .unwrap()
            .to_string();

        let listed = list(&db, "plugin.one", &json!({ "source": "legacy" })).unwrap();
        assert_eq!(listed["items"].as_array().unwrap().len(), 1);
        assert_eq!(
            list(&db, "plugin.two", &json!({})).unwrap()["items"],
            json!([])
        );

        rename(
            &db,
            "plugin.one",
            &json!({ "sessionId": id, "title": "Renamed" }),
        )
        .unwrap();
        assert_eq!(
            get(&db, "plugin.one", &json!({ "sessionId": id })).unwrap()["title"],
            "Renamed"
        );
        assert!(rename(
            &db,
            "plugin.two",
            &json!({ "sessionId": id, "title": "Nope" }),
        )
        .unwrap_err()
        .to_string()
        .starts_with("NOT_FOUND"));

        delete(
            &db,
            "plugin.one",
            &json!({ "sessionId": id, "mode": "trash" }),
        )
        .unwrap();
        assert!(list(&db, "plugin.one", &json!({})).unwrap()["items"]
            .as_array()
            .unwrap()
            .is_empty());
        assert!(get(&db, "plugin.one", &json!({ "sessionId": id })).is_err());

        delete(
            &db,
            "plugin.one",
            &json!({ "sessionId": id, "mode": "purge" }),
        )
        .unwrap();
        let reimported = import(&db, "plugin.one", &input).unwrap();
        assert_eq!(reimported["imported"], true);
        assert_ne!(reimported["sessionId"], id);
    }

    #[test]
    fn tool_import_scrubs_reserved_fields_and_rejects_invalid_timestamps() {
        let (_dir, db) = db();
        let mut input = item("tool", "2026-01-01T00:00:01Z");
        input["messages"] = json!([{
            "role": "tool",
            "content": "done",
            "createdAt": "2026-01-01T00:00:01Z",
            "toolName": "read",
            "toolCallId": "call-1",
            "toolStatus": "success",
            "toolArgs": { "keep": true, "__piSecret": "drop" },
            "toolResult": { "piDesktop.internal": "drop", "value": 1 }
        }]);
        input["source"] = json!("legacy");
        let id = import(&db, "plugin.one", &input).unwrap()["sessionId"].clone();
        let messages = list_messages(&db, "plugin.one", &json!({ "sessionId": id })).unwrap();
        assert_eq!(
            messages["items"][0]["tool"]["args"],
            json!({ "keep": true })
        );
        assert_eq!(
            messages["items"][0]["tool"]["result"],
            json!({ "value": 1 })
        );

        let mut invalid = item("bad-time", "2026-01-01T00:00:01Z");
        invalid["updatedAt"] = json!("not-a-timestamp");
        assert!(import(&db, "plugin.one", &invalid)
            .unwrap_err()
            .to_string()
            .starts_with("INVALID_PARAMS"));
    }

    #[test]
    fn list_messages_marks_external_and_paginates() {
        let (_dir, db) = db();
        let mut input = item("messages", "2026-01-01T00:00:01Z");
        input["messages"] = json!([
            { "role": "user", "content": "abcdefgh", "createdAt": "2026-01-01T00:00:01Z" },
            { "role": "assistant", "content": "reply", "createdAt": "2026-01-01T00:00:02Z" }
        ]);
        input["source"] = json!("legacy");
        let id = import(&db, "plugin.one", &input).unwrap()["sessionId"].clone();
        let page = list_messages(
            &db,
            "plugin.one",
            &json!({
                "sessionId": id,
                "limit": 1,
                "contentLimit": 4
            }),
        )
        .unwrap();
        assert_eq!(page["items"][0]["origin"], "external");
        assert_eq!(page["items"][0]["contentTruncated"], true);
        assert_eq!(page["nextCursor"], "1");
    }
}
