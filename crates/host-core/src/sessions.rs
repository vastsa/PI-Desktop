use anyhow::{anyhow, Result};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::db::{ms_to_ts, now_ms, ts_to_ms, Database};
use crate::notifications::{self, Notification};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use crate::transcripts::{self, CompactionRecord, MessageRecord, RevisionRecord};

pub const MODES: [&str; 3] = ["plan", "goal", "agent"];

/// Compatibility normalization for v7 callers and imported records. The
/// persisted operating profile is now always `plan`, `goal` or `agent`.
pub fn normalize_mode(mode: Option<&str>) -> String {
    match mode {
        Some("plan") | Some("chat") => "plan".into(),
        Some("goal") => "goal".into(),
        Some("agent") => "agent".into(),
        _ => "agent".into(),
    }
}

pub fn is_valid_mode(mode: &str) -> bool {
    MODES.contains(&mode)
}

/// Plan and Goal negotiate a contract before executing (D198), so they share one
/// tool allowlist and one hard deny. Agent is the only executing mode.
pub fn is_contract_mode(mode: &str) -> bool {
    matches!(mode, "plan" | "goal")
}

/// Values accepted by the persisted per-session thinking selector.  Keep this
/// list in the host boundary so old clients cannot write arbitrary provider
/// options into the session row.
pub const THINKING_LEVELS: [&str; 7] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

pub fn is_valid_thinking_level(level: &str) -> bool {
    THINKING_LEVELS.contains(&level)
}

fn default_thinking_level() -> String {
    "off".to_string()
}

/// Per-session permission mode (D115). `inherit` defers to the global
/// default in settings; the rest override it for this session only.
pub const PERMISSION_MODES: [&str; 4] = ["inherit", "ask", "accept-edits", "auto"];

pub fn is_valid_permission_mode(mode: &str) -> bool {
    PERMISSION_MODES.contains(&mode)
}

fn default_permission_mode() -> String {
    "inherit".to_string()
}

fn validate_permission_mode(mode: &str) -> Result<()> {
    if is_valid_permission_mode(mode) {
        Ok(())
    } else {
        Err(anyhow!(
            "permissionMode must be one of {}",
            PERMISSION_MODES.join(", ")
        ))
    }
}

fn validate_thinking_level(level: &str) -> Result<()> {
    if is_valid_thinking_level(level) {
        Ok(())
    } else {
        Err(anyhow!(
            "thinkingLevel must be one of {}",
            THINKING_LEVELS.join(", ")
        ))
    }
}

/// Wire format is unchanged from v1: RFC3339 timestamps, `projectPath`
/// resolved from the projects table, flat tool fields on messages. Storage is
/// schema v7 (D119): transcript content lives in per-session JSONL files and
/// SQLite keeps session metadata plus per-message index rows (`seq`, `text`
/// for FTS, promoted filter columns).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub id: String,
    pub title: String,
    /// Number of messages in the current canonical transcript. This is the
    /// current value of the session's last_seq allocator after rewrites.
    #[serde(default)]
    pub message_count: i64,
    pub project_path: Option<String>,
    pub model_id: Option<String>,
    pub provider_id: Option<String>,
    pub mode: String,
    #[serde(default = "default_thinking_level")]
    pub thinking_level: String,
    #[serde(default = "default_permission_mode")]
    pub permission_mode: String,
    pub updated_at: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageUsage {
    pub input_tokens: i64,
    pub output_tokens: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_read_tokens: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_write_tokens: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_tokens: Option<i64>,
    pub total_tokens: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageAttachment {
    pub kind: String,
    pub name: String,
    #[serde(rename = "ref")]
    pub reference: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiMessage {
    pub id: String,
    pub role: String,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<MessageAttachment>>,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<MessageUsage>,
    /// Elapsed model streaming time for the response throughput statistic.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_duration_ms: Option<i64>,
    /// Partial output estimate used when a user stops before final usage arrives.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_output_tokens: Option<i64>,
    /// Structured AppError for an assistant turn that failed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<Value>,
    /// Stable regenerate-family key shared across rewritten user prompts.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision_root_id: Option<String>,
    /// For user messages that own regenerate history: total revision count.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision_count: Option<i64>,
    /// 1-based active revision index for the branch rooted at this user turn.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_revision: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_args: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_completed_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_duration_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_error: Option<bool>,
    /// Set on rows a subagent produced: the `Task` tool call that spawned it
    /// (ADR 0062). The transcript nests these under that call, and the agent
    /// runtime excludes them from the parent's model context.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_tool_call_id: Option<String>,
    /// Subagent definition name that produced the row.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDetail {
    #[serde(flatten)]
    pub summary: SessionSummary,
    pub messages: Vec<UiMessage>,
    /// Zero-based offset of the first returned message when the caller asked
    /// for a window. Omitted for the full-history form.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_start: Option<i64>,
    /// True when older messages exist outside the returned window.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub has_more_before: Option<bool>,
    /// The checkpoint that governs the next model request, i.e. the last of
    /// `compactions`. Kept as its own field because that is what the runtime
    /// restores on load.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compaction: Option<CompactionRecord>,
    /// The whole checkpoint chain, oldest first, so the transcript can show one
    /// row per compaction.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub compactions: Vec<CompactionRecord>,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct SessionReadOptions {
    /// Exclusive message sequence before which the window ends. When omitted,
    /// the window is taken from the end of the canonical transcript.
    pub message_before: Option<i64>,
    pub message_limit: Option<i64>,
    /// Maximum characters per UI text/value field. This is a presentation cap;
    /// the full transcript remains available to the sidecar's uncapped read.
    pub content_limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub session_id: String,
    pub session_title: String,
    pub message_id: String,
    pub role: String,
    pub snippet: String,
    pub created_at: String,
}

fn is_default_title(title: &str) -> bool {
    matches!(
        title.trim(),
        "" | "New task" | "New chat" | "新建任务" | "新对话"
    )
}

// ---- UiMessage ⇄ transcript record mapping -----------------------------------

/// UiMessage → persisted transcript record, plus the extracted plain text for
/// the search index row (None for tool rows, matching the FTS triggers).
fn ui_to_record(message: &UiMessage) -> (MessageRecord, Option<String>) {
    let mut meta_obj = serde_json::Map::new();
    if let Some(status) = &message.status {
        meta_obj.insert("status".into(), json!(status));
    }
    if let Some(model_id) = &message.model_id {
        meta_obj.insert("modelId".into(), json!(model_id));
    }
    if let Some(provider_id) = &message.provider_id {
        meta_obj.insert("providerId".into(), json!(provider_id));
    }
    if let Some(usage) = &message.usage {
        meta_obj.insert(
            "usage".into(),
            json!({
                "inputTokens": usage.input_tokens,
                "outputTokens": usage.output_tokens,
                "cacheReadTokens": usage.cache_read_tokens,
                "cacheWriteTokens": usage.cache_write_tokens,
                "reasoningTokens": usage.reasoning_tokens,
                "totalTokens": usage.total_tokens,
            }),
        );
    }
    if let Some(duration) = message.response_duration_ms {
        meta_obj.insert("responseDurationMs".into(), json!(duration));
    }
    if let Some(tokens) = message.response_output_tokens {
        meta_obj.insert("responseOutputTokens".into(), json!(tokens));
    }
    if let Some(error) = &message.error {
        meta_obj.insert("error".into(), error.clone());
    }
    if let Some(root_id) = &message.revision_root_id {
        meta_obj.insert("revisionRootId".into(), json!(root_id));
    }
    if let Some(count) = message.revision_count {
        meta_obj.insert("revisionCount".into(), json!(count));
    }
    if let Some(active) = message.active_revision {
        meta_obj.insert("activeRevision".into(), json!(active));
    }
    if let Some(parent) = &message.parent_tool_call_id {
        meta_obj.insert("parentToolCallId".into(), json!(parent));
    }
    if let Some(agent) = &message.agent_name {
        meta_obj.insert("agentName".into(), json!(agent));
    }
    let meta = if meta_obj.is_empty() {
        None
    } else {
        Some(Value::Object(meta_obj))
    };

    let mut blocks = Vec::with_capacity(2 + message.attachments.as_ref().map_or(0, Vec::len));
    if let Some(thinking) = &message.thinking {
        blocks.push(json!({ "type": "thinking", "text": thinking }));
    }
    let text = if message.role == "tool" {
        let mut block = serde_json::Map::new();
        block.insert("type".into(), json!("tool_call"));
        if let Some(v) = &message.tool_call_id {
            block.insert("callId".into(), json!(v));
        }
        if let Some(v) = &message.tool_name {
            block.insert("name".into(), json!(v));
        }
        if let Some(v) = &message.tool_args {
            block.insert("args".into(), v.clone());
        }
        if let Some(v) = &message.tool_result {
            block.insert("result".into(), v.clone());
        }
        if let Some(v) = &message.tool_completed_at {
            block.insert("completedAt".into(), json!(v));
        }
        if let Some(v) = message.tool_duration_ms {
            block.insert("durationMs".into(), json!(v));
        }
        if let Some(v) = &message.tool_status {
            block.insert("status".into(), json!(v));
        }
        if message.is_error.unwrap_or(false) {
            block.insert("isError".into(), json!(true));
        }
        if !message.content.is_empty() {
            block.insert("text".into(), json!(message.content));
        }
        blocks.push(Value::Object(block));
        None
    } else {
        blocks.push(json!({ "type": "text", "text": message.content }));
        if let Some(attachments) = &message.attachments {
            for attachment in attachments {
                let mut block = serde_json::Map::new();
                block.insert("type".into(), json!("attachment"));
                block.insert("kind".into(), json!(attachment.kind));
                block.insert("name".into(), json!(attachment.name));
                block.insert("ref".into(), json!(attachment.reference));
                if let Some(mime_type) = &attachment.mime_type {
                    block.insert("mimeType".into(), json!(mime_type));
                }
                if let Some(size) = attachment.size {
                    block.insert("size".into(), json!(size));
                }
                blocks.push(Value::Object(block));
            }
        }
        Some(message.content.clone())
    };

    (
        MessageRecord {
            id: message.id.clone(),
            role: message.role.clone(),
            tool_name: message.tool_name.clone(),
            is_error: message.is_error.unwrap_or(false),
            blocks: Value::Array(blocks),
            meta,
            created_at: message.created_at.clone(),
        },
        text,
    )
}

fn record_to_ui(record: MessageRecord) -> UiMessage {
    let blocks = match record.blocks {
        Value::Array(items) => items,
        _ => Vec::new(),
    };
    let meta = record.meta.unwrap_or(Value::Null);
    let status = meta
        .get("status")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let model_id = meta
        .get("modelId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let provider_id = meta
        .get("providerId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let usage = meta.get("usage").and_then(|value| {
        let input_tokens = value.get("inputTokens").and_then(|v| v.as_i64())?;
        let output_tokens = value.get("outputTokens").and_then(|v| v.as_i64())?;
        let total_tokens = value
            .get("totalTokens")
            .and_then(|v| v.as_i64())
            .unwrap_or(input_tokens + output_tokens);
        Some(MessageUsage {
            input_tokens,
            output_tokens,
            cache_read_tokens: value.get("cacheReadTokens").and_then(|v| v.as_i64()),
            cache_write_tokens: value.get("cacheWriteTokens").and_then(|v| v.as_i64()),
            reasoning_tokens: value.get("reasoningTokens").and_then(|v| v.as_i64()),
            total_tokens,
        })
    });
    let error = meta.get("error").cloned();
    let response_duration_ms = meta.get("responseDurationMs").and_then(|v| v.as_i64());
    let response_output_tokens = meta.get("responseOutputTokens").and_then(|v| v.as_i64());
    let revision_root_id = meta
        .get("revisionRootId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let revision_count = meta.get("revisionCount").and_then(|v| v.as_i64());
    let active_revision = meta.get("activeRevision").and_then(|v| v.as_i64());
    let parent_tool_call_id = meta
        .get("parentToolCallId")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let agent_name = meta
        .get("agentName")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let thinking = blocks
        .iter()
        .filter_map(|b| {
            (b.get("type").and_then(|t| t.as_str()) == Some("thinking"))
                .then(|| b.get("text").and_then(|v| v.as_str()))
                .flatten()
        })
        .collect::<Vec<_>>();
    let thinking = (!thinking.is_empty()).then(|| thinking.concat());
    let is_error = record.is_error.then_some(true);
    let attachments = blocks
        .iter()
        .filter_map(|block| {
            (block.get("type").and_then(|t| t.as_str()) == Some("attachment")).then(|| {
                Some(MessageAttachment {
                    kind: block.get("kind").and_then(|v| v.as_str())?.to_string(),
                    name: block.get("name").and_then(|v| v.as_str())?.to_string(),
                    reference: block.get("ref").and_then(|v| v.as_str())?.to_string(),
                    mime_type: block
                        .get("mimeType")
                        .and_then(|v| v.as_str())
                        .map(str::to_string),
                    size: block.get("size").and_then(|v| v.as_i64()),
                })
            })
        })
        .flatten()
        .collect::<Vec<_>>();
    let attachments = (!attachments.is_empty()).then_some(attachments);

    if record.role == "tool" {
        let block = blocks
            .iter()
            .find(|b| b.get("type").and_then(|t| t.as_str()) == Some("tool_call"))
            .cloned()
            .unwrap_or(Value::Null);
        let text = block
            .get("text")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_default();
        UiMessage {
            id: record.id,
            role: record.role,
            content: text,
            attachments: None,
            created_at: record.created_at,
            thinking,
            status,
            model_id,
            provider_id,
            usage,
            response_duration_ms,
            response_output_tokens,
            error,
            revision_root_id,
            revision_count,
            active_revision,
            tool_name: record.tool_name,
            tool_call_id: block
                .get("callId")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            tool_status: block
                .get("status")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            tool_args: block.get("args").cloned(),
            tool_result: block.get("result").cloned(),
            tool_completed_at: block
                .get("completedAt")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            tool_duration_ms: block.get("durationMs").and_then(|v| v.as_i64()),
            is_error,
            parent_tool_call_id,
            agent_name,
        }
    } else {
        let content = blocks
            .iter()
            .filter_map(|b| match b.get("type").and_then(|t| t.as_str()) {
                Some("text") => b.get("text").and_then(|v| v.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("");
        UiMessage {
            id: record.id,
            role: record.role,
            content,
            attachments,
            created_at: record.created_at,
            thinking,
            status,
            model_id,
            provider_id,
            usage,
            response_duration_ms,
            response_output_tokens,
            error,
            revision_root_id,
            revision_count,
            active_revision,
            tool_name: None,
            tool_call_id: None,
            tool_status: None,
            tool_args: None,
            tool_result: None,
            tool_completed_at: None,
            tool_duration_ms: None,
            is_error,
            parent_tool_call_id,
            agent_name,
        }
    }
}

const DISPLAY_TRUNCATION_MARKER: &str =
    "\n\n[truncated for display; the full content remains in the transcript]";

fn truncate_display_text(text: String, limit: usize) -> (String, bool) {
    if text.chars().count() <= limit {
        return (text, false);
    }
    let marker_len = DISPLAY_TRUNCATION_MARKER.chars().count();
    if limit <= marker_len {
        return (
            DISPLAY_TRUNCATION_MARKER.chars().take(limit).collect(),
            true,
        );
    }
    let head = limit - marker_len;
    (
        format!(
            "{}{}",
            text.chars().take(head).collect::<String>(),
            DISPLAY_TRUNCATION_MARKER
        ),
        true,
    )
}

fn preview_value(value: Value, limit: usize) -> Value {
    fn walk(value: Value, budget: &mut usize) -> Value {
        if *budget == 0 {
            return Value::String("[truncated for display]".into());
        }
        match value {
            Value::String(text) => {
                let (clipped, _) = truncate_display_text(text, *budget);
                *budget = (*budget).saturating_sub(clipped.chars().count());
                Value::String(clipped)
            }
            Value::Array(items) => {
                let mut output = Vec::with_capacity(items.len().min(32));
                for item in items {
                    if *budget == 0 || output.len() >= 256 {
                        output.push(Value::String("[truncated for display]".into()));
                        break;
                    }
                    output.push(walk(item, budget));
                }
                Value::Array(output)
            }
            Value::Object(object) => {
                let mut output = serde_json::Map::new();
                for (key, item) in object {
                    if *budget == 0 || output.len() >= 256 {
                        output.insert("_truncated".into(), Value::Bool(true));
                        break;
                    }
                    output.insert(key, walk(item, budget));
                }
                Value::Object(output)
            }
            other => other,
        }
    }

    let mut budget = limit.max(1);
    walk(value, &mut budget)
}

fn cap_record_block_value(value: &mut Value, budget: &mut usize) {
    let original = std::mem::take(value);
    *value = match original {
        Value::String(text) if *budget > 0 => {
            let (clipped, _) = truncate_display_text(text, *budget);
            *budget = budget.saturating_sub(clipped.chars().count());
            Value::String(clipped)
        }
        Value::String(_) => Value::String(String::new()),
        other => other,
    };
}

fn cap_record_blocks_for_display(record: &mut MessageRecord, limit: usize) {
    let Some(blocks) = record.blocks.as_array_mut() else {
        return;
    };
    let mut text_budget = limit.max(1);
    let mut thinking_budget = limit.max(1);
    for block in blocks {
        let Some(object) = block.as_object_mut() else {
            continue;
        };
        match object.get("type").and_then(Value::as_str) {
            Some("text") => {
                if let Some(text) = object.get_mut("text") {
                    cap_record_block_value(text, &mut text_budget);
                }
            }
            Some("thinking") => {
                if let Some(text) = object.get_mut("text") {
                    cap_record_block_value(text, &mut thinking_budget);
                }
            }
            Some("tool_call") => {
                for key in ["args", "result"] {
                    if let Some(value) = object.get_mut(key) {
                        *value = preview_value(std::mem::take(value), limit);
                    }
                }
                if let Some(text) = object.get_mut("text") {
                    cap_record_block_value(text, &mut text_budget);
                }
            }
            _ => {}
        }
    }
}

fn record_to_ui_for_display(mut record: MessageRecord, limit: usize) -> UiMessage {
    // Bound the canonical block values before record_to_ui concatenates text
    // blocks or clones tool payloads. This keeps a 50 MB selected line from
    // producing another 50 MB temporary UI string on the host.
    cap_record_blocks_for_display(&mut record, limit);
    let mut message = record_to_ui(record);
    let (content, _) = truncate_display_text(message.content, limit);
    message.content = content;
    if let Some(thinking) = message.thinking.take() {
        let (thinking, _) = truncate_display_text(thinking, limit);
        message.thinking = Some(thinking);
    }
    if let Some(args) = message.tool_args.take() {
        message.tool_args = Some(preview_value(args, limit));
    }
    if let Some(result) = message.tool_result.take() {
        message.tool_result = Some(preview_value(result, limit));
    }
    if let Some(error) = message.error.take() {
        message.error = Some(preview_value(error, limit));
    }
    message
}

fn dedupe_records(records: Vec<MessageRecord>) -> Vec<MessageRecord> {
    let mut ordered: Vec<MessageRecord> = Vec::with_capacity(records.len());
    let mut by_id: std::collections::HashMap<String, usize> =
        std::collections::HashMap::with_capacity(records.len());
    for record in records {
        match by_id.get(&record.id) {
            Some(&pos) => ordered[pos] = record,
            None => {
                by_id.insert(record.id.clone(), ordered.len());
                ordered.push(record);
            }
        }
    }
    ordered
}

fn record_index_text(record: &MessageRecord) -> Option<String> {
    if record.role == "tool" {
        return None;
    }
    let text = record
        .blocks
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|block| {
            (block.get("type").and_then(Value::as_str) == Some("text"))
                .then(|| block.get("text").and_then(Value::as_str))
                .flatten()
        })
        .collect::<String>();
    (!text.is_empty()).then_some(text)
}

fn collect_tool_call_ids(records: &[MessageRecord]) -> std::collections::HashMap<String, String> {
    let mut ids = std::collections::HashMap::new();
    for record in records {
        let Some(blocks) = record.blocks.as_array() else {
            continue;
        };
        for block in blocks {
            let Some(object) = block.as_object() else {
                continue;
            };
            for key in ["callId", "toolCallId"] {
                if let Some(id) = object.get(key).and_then(Value::as_str) {
                    ids.entry(id.to_string())
                        .or_insert_with(|| Uuid::new_v4().to_string());
                }
            }
        }
    }
    ids
}

fn clone_records_for_fork(
    records: Vec<MessageRecord>,
) -> (
    Vec<MessageRecord>,
    std::collections::HashMap<String, String>,
    std::collections::HashMap<String, String>,
) {
    let records = dedupe_records(records);
    let tool_call_ids = collect_tool_call_ids(&records);
    let message_ids = records
        .iter()
        .map(|record| (record.id.clone(), Uuid::new_v4().to_string()))
        .collect::<std::collections::HashMap<_, _>>();
    let cloned = records
        .into_iter()
        .map(|mut record| {
            record.id = message_ids
                .get(&record.id)
                .cloned()
                .unwrap_or_else(|| Uuid::new_v4().to_string());
            if let Some(meta) = record.meta.as_mut().and_then(Value::as_object_mut) {
                meta.remove("revisionRootId");
                meta.remove("revisionCount");
                meta.remove("activeRevision");
                if meta.is_empty() {
                    record.meta = None;
                }
            }
            if let Some(blocks) = record.blocks.as_array_mut() {
                for block in blocks {
                    let Some(object) = block.as_object_mut() else {
                        continue;
                    };
                    for key in ["callId", "toolCallId"] {
                        let Some(old_id) = object.get(key).and_then(Value::as_str) else {
                            continue;
                        };
                        if let Some(new_id) = tool_call_ids.get(old_id) {
                            object.insert(key.to_string(), json!(new_id));
                        }
                    }
                    // Review snapshots are owned by the source session's
                    // workspace. Keep the copied diff evidence visible, but
                    // prevent a fork from offering a rollback against a
                    // snapshot it does not own.
                    if object.get("type").and_then(Value::as_str) == Some("tool_call") {
                        if let Some(review) = object
                            .get_mut("result")
                            .and_then(Value::as_object_mut)
                            .and_then(|result| result.get_mut("details"))
                            .and_then(Value::as_object_mut)
                            .and_then(|details| details.get_mut("review"))
                            .and_then(Value::as_object_mut)
                        {
                            review.insert("reversible".into(), Value::Bool(false));
                        }
                    }
                }
            }
            record
        })
        .collect();
    (cloned, message_ids, tool_call_ids)
}

fn remap_value_strings(
    value: &mut Value,
    replacements: &std::collections::HashMap<String, String>,
) {
    match value {
        Value::String(text) => {
            if let Some(replacement) = replacements.get(text) {
                *text = replacement.clone();
            }
        }
        Value::Array(items) => {
            for item in items {
                remap_value_strings(item, replacements);
            }
        }
        Value::Object(object) => {
            for item in object.values_mut() {
                remap_value_strings(item, replacements);
            }
        }
        _ => {}
    }
}

fn clone_compaction_for_fork(
    mut compaction: CompactionRecord,
    message_ids: &std::collections::HashMap<String, String>,
    tool_call_ids: &std::collections::HashMap<String, String>,
) -> Option<CompactionRecord> {
    compaction.first_kept_message_id = compaction
        .first_kept_message_id
        .as_ref()
        .and_then(|id| message_ids.get(id).cloned());
    compaction.through_message_id = message_ids.get(&compaction.through_message_id)?.clone();
    compaction.id = Uuid::new_v4().to_string();
    if let Some(tail) = compaction.retained_tail.as_mut() {
        remap_value_strings(tail, tool_call_ids);
    }
    Some(compaction)
}

/// Insert one search/index row for a message whose content lives in the
/// transcript file.
fn insert_index_row(
    conn: &rusqlite::Connection,
    session_id: &str,
    seq: i64,
    turn_id: Option<&str>,
    record: &MessageRecord,
    text: Option<&str>,
) -> Result<()> {
    let mut stmt = conn.prepare_cached(
        "INSERT INTO messages (
            id, session_id, turn_id, seq, role, tool_name, is_error, text, created_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
    )?;
    stmt.execute(params![
        record.id,
        session_id,
        turn_id,
        seq,
        record.role,
        record.tool_name,
        record.is_error,
        text,
        ts_to_ms(&record.created_at),
    ])?;
    Ok(())
}

/// The session's created_at (RFC3339, used as the transcript header stamp) —
/// doubles as the existence check before any transcript file is touched.
fn session_created_at(db: &Database, session_id: &str) -> Result<String> {
    let ms: Option<i64> = db
        .conn()
        .prepare_cached("SELECT created_at FROM sessions WHERE id = ?1")?
        .query_row(params![session_id], |r| r.get(0))
        .optional()?;
    ms.map(ms_to_ts)
        .ok_or_else(|| anyhow!("session not found: {session_id}"))
}

const SUMMARY_SELECT: &str =
    "SELECT s.id, s.title, s.last_seq, p.path, s.model_id, s.provider_id, s.mode,
            s.thinking_level, s.permission_mode, s.updated_at, s.created_at
     FROM sessions s LEFT JOIN projects p ON p.id = s.project_id";

fn summary_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SessionSummary> {
    Ok(SessionSummary {
        id: row.get(0)?,
        title: row.get(1)?,
        message_count: row.get(2)?,
        project_path: row.get(3)?,
        model_id: row.get(4)?,
        provider_id: row.get(5)?,
        mode: row.get(6)?,
        thinking_level: row.get(7)?,
        permission_mode: row.get(8)?,
        updated_at: ms_to_ts(row.get(9)?),
        created_at: ms_to_ts(row.get(10)?),
    })
}

// ---- sessions ---------------------------------------------------------------

fn first_user_title(db: &Database, session_id: &str) -> Result<Option<String>> {
    let mut stmt = db.conn().prepare_cached(
        "SELECT text FROM messages
         WHERE session_id = ?1 AND role = 'user' AND text IS NOT NULL
         ORDER BY seq ASC LIMIT 1",
    )?;
    let content: Option<String> = stmt
        .query_row(params![session_id], |row| row.get(0))
        .optional()?;
    Ok(content.and_then(|c| {
        let t = c.trim().replace('\n', " ");
        let t = t.split_whitespace().collect::<Vec<_>>().join(" ");
        if t.is_empty() {
            None
        } else {
            let mut out = t.chars().take(48).collect::<String>();
            if t.chars().count() > 48 {
                out.push('…');
            }
            Some(out)
        }
    }))
}

pub fn list_sessions(db: &Database) -> Result<Vec<SessionSummary>> {
    let sql = format!("{SUMMARY_SELECT} ORDER BY s.updated_at DESC");
    let mut stmt = db.conn().prepare_cached(&sql)?;
    let rows = stmt.query_map([], summary_from_row)?;
    let mut out = Vec::new();
    for row in rows {
        let mut session = row?;
        if is_default_title(&session.title) {
            if let Some(title) = first_user_title(db, &session.id)? {
                // Persist so Recents stays stable across restarts.
                let _ = rename_session(db, &session.id, &title);
                session.title = title;
            }
        }
        out.push(session);
    }
    Ok(out)
}

/// Backwards-compatible session constructor.  New callers that need an
/// explicit thinking level should use [`create_session_with_thinking`].
pub fn create_session(
    db: &Database,
    title: Option<String>,
    mode: Option<String>,
    provider_id: Option<String>,
    model_id: Option<String>,
    project_path: Option<String>,
) -> Result<SessionSummary> {
    create_session_with_thinking(db, title, mode, provider_id, model_id, project_path, None)
}

pub fn create_session_with_thinking(
    db: &Database,
    title: Option<String>,
    mode: Option<String>,
    provider_id: Option<String>,
    model_id: Option<String>,
    project_path: Option<String>,
    thinking_level: Option<String>,
) -> Result<SessionSummary> {
    let now = now_ms();
    let id = Uuid::new_v4().to_string();
    let title = title.unwrap_or_else(|| "New task".into());
    let mode = normalize_mode(mode.as_deref());
    let thinking_level = thinking_level.unwrap_or_else(default_thinking_level);
    validate_thinking_level(&thinking_level)?;
    let project_id = match project_path
        .as_deref()
        .filter(|path| !path.trim().is_empty())
    {
        Some(path) => Some(db.ensure_project(path, false)?),
        None => None,
    };
    let project_path = match project_id {
        Some(id) => db.project_path(id)?,
        None => None,
    };
    db.conn()
        .prepare_cached(
            "INSERT INTO sessions (
                id, title, project_id, provider_id, model_id, mode, thinking_level,
                created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
        )?
        .execute(params![
            id,
            title,
            project_id,
            provider_id,
            model_id,
            mode,
            thinking_level,
            now
        ])?;
    Ok(SessionSummary {
        id,
        title,
        message_count: 0,
        project_path,
        model_id,
        provider_id,
        mode,
        thinking_level,
        permission_mode: default_permission_mode(),
        updated_at: ms_to_ts(now),
        created_at: ms_to_ts(now),
    })
}

/// The persisted per-session permission mode, or None for unknown sessions.
pub fn session_permission_mode(db: &Database, id: &str) -> Result<Option<String>> {
    Ok(db
        .conn()
        .prepare_cached("SELECT permission_mode FROM sessions WHERE id = ?1")?
        .query_row(params![id], |row| row.get(0))
        .optional()?)
}

/// Resolve the durable operating mode for authorization. Unknown sessions
/// return None so callers can fail closed instead of trusting sidecar input.
pub fn session_mode(db: &Database, id: &str) -> Result<Option<String>> {
    Ok(db
        .conn()
        .prepare_cached("SELECT mode FROM sessions WHERE id = ?1")?
        .query_row(params![id], |row| row.get::<_, String>(0))
        .optional()?
        .map(|mode| normalize_mode(Some(&mode))))
}

/// Process-wide cache of transcript layouts, keyed by session id.
///
/// The layout is derived data: it can always be rebuilt by scanning the file,
/// and `file_len` makes a stale entry detectable. Caching it turns a repeated
/// session open, and each older page, into a bounded seek-and-parse instead of
/// another full-history scan.
static TRANSCRIPT_LAYOUTS: OnceLock<Mutex<HashMap<String, transcripts::TranscriptLayout>>> =
    OnceLock::new();

fn layout_cache() -> &'static Mutex<HashMap<String, transcripts::TranscriptLayout>> {
    TRANSCRIPT_LAYOUTS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Return an up-to-date layout for one session, reusing the cached offsets and
/// scanning only what was appended since.
fn session_layout(db: &Database, session_id: &str) -> Result<transcripts::TranscriptLayout> {
    let cached = layout_cache()
        .lock()
        .ok()
        .and_then(|guard| guard.get(session_id).cloned())
        .unwrap_or_default();
    let layout = transcripts::refresh_layout(db.data_dir(), session_id, cached)?;
    if let Ok(mut guard) = layout_cache().lock() {
        guard.insert(session_id.to_string(), layout.clone());
    }
    Ok(layout)
}

/// Drop a session's cached layout. Called after a rewrite or a delete so the
/// next read rebuilds from the file rather than trusting stale offsets.
pub fn invalidate_transcript_layout(session_id: &str) {
    if let Ok(mut guard) = layout_cache().lock() {
        guard.remove(session_id);
    }
}

pub fn get_session(db: &Database, id: &str) -> Result<Option<SessionDetail>> {
    get_session_with_options(db, id, SessionReadOptions::default())
}

/// Load a session detail with an optional renderer-facing message window.
/// The uncapped default is intentionally retained for the sidecar and for
/// mutation paths that need the canonical transcript. Renderer callers should
/// request a bounded tail and a display content limit.
pub fn get_session_with_options(
    db: &Database,
    id: &str,
    options: SessionReadOptions,
) -> Result<Option<SessionDetail>> {
    let sql = format!("{SUMMARY_SELECT} WHERE s.id = ?1");
    let summary = db
        .conn()
        .prepare_cached(&sql)?
        .query_row(params![id], summary_from_row)
        .optional()?;
    let Some(summary) = summary else {
        return Ok(None);
    };

    let (records, compactions, message_start, has_more_before) =
        if let Some(raw_limit) = options.message_limit.filter(|limit| *limit > 0) {
            let limit = raw_limit.min(1_000) as usize;
            // Window coordinates are physical transcript lines, so they must be
            // clamped against the file layout rather than against `last_seq`.
            // The index counter is a deduplicated logical count: a retried
            // append leaves two lines with one id, and mixing the two spaces
            // silently dropped the newest messages of a long session.
            let layout = session_layout(db, id)?;
            let total = layout.message_count();
            let before = match options.message_before {
                Some(value) => (value.max(0) as usize).min(total),
                None => total,
            };
            let start = before.saturating_sub(limit);
            let read = transcripts::read_transcript_window_with_layout(
                db.data_dir(),
                id,
                &layout,
                start,
                Some(before.saturating_sub(start)),
            )?;
            (
                dedupe_records(read.messages),
                read.compactions,
                Some(start as i64),
                Some(start > 0),
            )
        } else {
            let read = transcripts::read_transcript_with_compactions(db.data_dir(), id)?;
            (dedupe_records(read.messages), read.compactions, None, None)
        };
    // Content comes from the transcript file; SQLite only indexes it. A
    // renderer window may additionally request a display cap so a single
    // pasted or tool-produced multi-megabyte message never crosses the UI IPC
    // boundary. The uncapped path remains lossless for model reconstruction.
    let messages = match options.content_limit {
        Some(limit) => records
            .into_iter()
            .map(|record| record_to_ui_for_display(record, limit))
            .collect(),
        None => records.into_iter().map(record_to_ui).collect(),
    };
    Ok(Some(SessionDetail {
        summary,
        message_start,
        has_more_before,
        messages,
        compaction: compactions.last().cloned(),
        compactions,
    }))
}

/// Create an independent session from the source session's current canonical
/// transcript. Regenerate revisions, turns, artifacts, notifications, scratch
/// data, and live runtime state are intentionally not copied.
pub enum ForkSessionResult {
    Created(Box<SessionDetail>),
    NotFound,
    Busy,
}

/// Create an independent session from the source transcript, optionally
/// stopping after one message. Message-scoped forks use this to keep later
/// turns out of the child while preserving the same cache/runtime isolation as
/// a full session fork.
pub fn fork_session_through(
    db: &Database,
    source_id: &str,
    title: Option<&str>,
    through_message_id: Option<&str>,
) -> Result<ForkSessionResult> {
    let Some(source) = get_session(db, source_id)? else {
        return Ok(ForkSessionResult::NotFound);
    };
    let has_running_turn: bool = db.conn().query_row(
        "SELECT EXISTS(
            SELECT 1 FROM turns WHERE session_id = ?1 AND status = 'running'
         )",
        params![source_id],
        |row| row.get(0),
    )?;
    if has_running_turn {
        return Ok(ForkSessionResult::Busy);
    }
    let mut source_records =
        dedupe_records(transcripts::read_transcript(db.data_dir(), source_id)?);
    if let Some(message_id) = through_message_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let Some(position) = source_records
            .iter()
            .position(|record| record.id == message_id)
        else {
            return Ok(ForkSessionResult::NotFound);
        };
        source_records.truncate(position + 1);
    }
    let source_compactions = transcripts::read_compactions(db.data_dir(), source_id)?;
    let (records, message_ids, tool_call_ids) = clone_records_for_fork(source_records);
    // Each checkpoint is remapped on its own: a message-scoped fork can cut the
    // anchor of a later checkpoint while the earlier ones stay intact.
    let compactions: Vec<CompactionRecord> = source_compactions
        .into_iter()
        .filter_map(|record| clone_compaction_for_fork(record, &message_ids, &tool_call_ids))
        .collect();
    let texts = records.iter().map(record_index_text).collect::<Vec<_>>();
    let id = Uuid::new_v4().to_string();
    let now = now_ms();
    let created_at = ms_to_ts(now);
    let requested_title = title.map(str::trim).filter(|value| !value.is_empty());
    let title = requested_title
        .map(|value| value.chars().take(100).collect::<String>())
        .unwrap_or_else(|| format!("{} (branch)", source.summary.title));

    invalidate_transcript_layout(&id);
    transcripts::write_transcript_with_compactions(
        db.data_dir(),
        &id,
        &created_at,
        &records,
        &compactions,
    )?;
    let indexed = (|| -> Result<()> {
        let tx = db.conn().unchecked_transaction()?;
        let inserted = tx
            .prepare_cached(
                "INSERT INTO sessions (
                    id, title, project_id, provider_id, model_id, mode, thinking_level,
                    permission_mode, source, pinned, last_seq, created_at, updated_at
                 )
                 SELECT ?1, ?2, project_id, provider_id, model_id, mode, thinking_level,
                        permission_mode, NULL, 0, ?3, ?4, ?4
                 FROM sessions WHERE id = ?5",
            )?
            .execute(params![id, title, records.len() as i64, now, source_id])?;
        if inserted == 0 {
            return Err(anyhow!("session not found: {source_id}"));
        }
        for (seq, record) in records.iter().enumerate() {
            insert_index_row(&tx, &id, seq as i64, None, record, texts[seq].as_deref())?;
        }
        tx.commit()?;
        Ok(())
    })();
    if let Err(error) = indexed {
        invalidate_transcript_layout(&id);
        transcripts::remove_session_files(db.data_dir(), &id);
        return Err(error);
    }

    let summary = SessionSummary {
        id,
        title,
        message_count: records.len() as i64,
        project_path: source.summary.project_path,
        model_id: source.summary.model_id,
        provider_id: source.summary.provider_id,
        mode: source.summary.mode,
        thinking_level: source.summary.thinking_level,
        permission_mode: source.summary.permission_mode,
        updated_at: created_at.clone(),
        created_at,
    };
    let messages = records.into_iter().map(record_to_ui).collect();
    Ok(ForkSessionResult::Created(Box::new(SessionDetail {
        summary,
        message_start: None,
        has_more_before: None,
        messages,
        compaction: compactions.last().cloned(),
        compactions,
    })))
}

/// Backwards-compatible configurator.  Omitting the thinking level preserves
/// the current persisted value.
#[allow(dead_code)]
pub fn configure_session(
    db: &Database,
    id: &str,
    mode: &str,
    provider_id: Option<&str>,
    model_id: Option<&str>,
) -> Result<Option<SessionSummary>> {
    configure_session_with_thinking(db, id, mode, provider_id, model_id, None, None)
}

#[allow(clippy::too_many_arguments)]
pub fn configure_session_with_thinking(
    db: &Database,
    id: &str,
    mode: &str,
    provider_id: Option<&str>,
    model_id: Option<&str>,
    thinking_level: Option<&str>,
    permission_mode: Option<&str>,
) -> Result<Option<SessionSummary>> {
    if !(is_valid_mode(mode) || mode == "chat") {
        return Err(anyhow!("mode must be plan or agent"));
    }
    let mode = normalize_mode(Some(mode));
    if let Some(level) = thinking_level {
        validate_thinking_level(level)?;
    }
    if let Some(mode) = permission_mode {
        validate_permission_mode(mode)?;
    }
    crate::plans::gate_session_configure(
        db,
        id,
        &mode,
        provider_id,
        model_id,
        thinking_level,
        permission_mode,
    )?;
    let changed = db
        .conn()
        .prepare_cached(
            "UPDATE sessions
             SET mode = ?2, provider_id = COALESCE(?3, provider_id),
                 model_id = COALESCE(?4, model_id),
                 thinking_level = COALESCE(?5, thinking_level),
                 permission_mode = COALESCE(?6, permission_mode), updated_at = ?7
             WHERE id = ?1",
        )?
        .execute(params![
            id,
            mode,
            provider_id,
            model_id,
            thinking_level,
            permission_mode,
            now_ms()
        ])?;
    if changed == 0 {
        return Ok(None);
    }
    Ok(get_session(db, id)?.map(|detail| detail.summary))
}

pub fn delete_session(db: &Database, id: &str) -> Result<bool> {
    let n = db
        .conn()
        .prepare_cached("DELETE FROM sessions WHERE id = ?1")?
        .execute(params![id])?;
    if n > 0 {
        // Here rather than in the RPC handler so every deletion path (UI,
        // failed scheduled-run cleanup) also drops the transcript files.
        invalidate_transcript_layout(id);
        transcripts::remove_session_files(db.data_dir(), id);
    }
    Ok(n > 0)
}

pub fn rename_session(db: &Database, id: &str, title: &str) -> Result<bool> {
    let n = db
        .conn()
        .prepare_cached("UPDATE sessions SET title = ?1, updated_at = ?2 WHERE id = ?3")?
        .execute(params![title, now_ms(), id])?;
    Ok(n > 0)
}

/// Per-message records plus their extracted index text, in input order.
fn records_and_texts(messages: &[UiMessage]) -> (Vec<MessageRecord>, Vec<Option<String>>) {
    let mut records = Vec::with_capacity(messages.len());
    let mut texts = Vec::with_capacity(messages.len());
    for message in messages {
        let (record, text) = ui_to_record(message);
        records.push(record);
        texts.push(text);
    }
    (records, texts)
}

pub fn append_message(
    db: &Database,
    session_id: &str,
    message: &UiMessage,
    turn_id: Option<&str>,
) -> Result<()> {
    let session_created = session_created_at(db, session_id)?;
    let (record, text) = ui_to_record(message);
    // Electron may replay an outbox entry after a host restart. Message ids
    // are globally unique, so an existing row is already the durable result.
    let already_appended: Option<i64> = db
        .conn()
        .query_row(
            "SELECT mid FROM messages WHERE id = ?1 AND session_id = ?2",
            params![record.id, session_id],
            |row| row.get(0),
        )
        .optional()?;
    if already_appended.is_some() {
        return Ok(());
    }
    // File first: the transcript is the source of truth. A crash before the
    // index commit costs one derived row (self-healed by the next rewrite),
    // never message content.
    transcripts::append_message(db.data_dir(), session_id, &session_created, &record)?;
    let conn = db.conn();
    let tx = conn.unchecked_transaction()?;
    let now = now_ms();
    let seq: Option<i64> = tx
        .prepare_cached(
            "UPDATE sessions SET last_seq = last_seq + 1, updated_at = ?2
             WHERE id = ?1 RETURNING last_seq",
        )?
        .query_row(params![session_id, now], |r| r.get(0))
        .optional()?;
    let Some(seq) = seq else {
        return Err(anyhow!("session not found: {session_id}"));
    };
    insert_index_row(&tx, session_id, seq - 1, turn_id, &record, text.as_deref())?;
    tx.commit()?;
    Ok(())
}

pub fn append_compaction(
    db: &Database,
    session_id: &str,
    compaction: &CompactionRecord,
) -> Result<()> {
    if compaction.id.trim().is_empty()
        || compaction.summary.trim().is_empty()
        || compaction.through_message_id.trim().is_empty()
        || compaction.tokens_before < 0
    {
        return Err(anyhow!("invalid compaction record"));
    }
    let session_created = session_created_at(db, session_id)?;
    transcripts::append_compaction(db.data_dir(), session_id, &session_created, compaction)
}

fn compaction_valid_for_records(compaction: &CompactionRecord, records: &[MessageRecord]) -> bool {
    let Some(through_index) = records
        .iter()
        .position(|record| record.id == compaction.through_message_id)
    else {
        return false;
    };
    compaction.first_kept_message_id.as_ref().is_none_or(|id| {
        records
            .iter()
            .position(|record| &record.id == id)
            .is_some_and(|index| index <= through_index)
    })
}

pub fn replace_messages(db: &Database, session_id: &str, messages: &[UiMessage]) -> Result<()> {
    let session_created = session_created_at(db, session_id)?;
    let (records, texts) = records_and_texts(messages);
    let compactions: Vec<CompactionRecord> =
        transcripts::read_compactions(db.data_dir(), session_id)?
            .into_iter()
            .filter(|record| compaction_valid_for_records(record, &records))
            .collect();
    invalidate_transcript_layout(session_id);
    transcripts::write_transcript_with_compactions(
        db.data_dir(),
        session_id,
        &session_created,
        &records,
        &compactions,
    )?;
    let conn = db.conn();
    // A rewrite reseats every index row, so the turn each surviving message was
    // produced in has to be carried across it. Dropping it here cost the whole
    // session its turn/token attribution on any regenerate.
    let mut owning_turns: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    {
        let mut stmt = conn.prepare_cached(
            "SELECT id, turn_id FROM messages
             WHERE session_id = ?1 AND turn_id IS NOT NULL",
        )?;
        let rows = stmt.query_map(params![session_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        for row in rows {
            let (id, turn_id) = row?;
            owning_turns.insert(id, turn_id);
        }
    }
    let tx = conn.unchecked_transaction()?;
    tx.prepare_cached("DELETE FROM messages WHERE session_id = ?1")?
        .execute(params![session_id])?;
    for (seq, record) in records.iter().enumerate() {
        insert_index_row(
            &tx,
            session_id,
            seq as i64,
            owning_turns.get(&record.id).map(String::as_str),
            record,
            texts[seq].as_deref(),
        )?;
    }
    tx.prepare_cached("UPDATE sessions SET last_seq = ?1, updated_at = ?2 WHERE id = ?3")?
        .execute(params![records.len() as i64, now_ms(), session_id])?;
    tx.commit()?;
    Ok(())
}

/// Persist the rollback state on the tool message that owns a review snapshot.
/// The tool result remains the message-local source of truth after restart.
pub fn update_tool_review_state(
    db: &Database,
    session_id: &str,
    message_id: &str,
    snapshot_id: &str,
    state: &str,
) -> Result<bool> {
    let Some(detail) = get_session(db, session_id)? else {
        return Ok(false);
    };
    let mut messages = detail.messages;
    let mut changed = false;
    for message in &mut messages {
        if message.id != message_id || message.role != "tool" {
            continue;
        }
        let Some(tool_result) = message.tool_result.as_mut().and_then(Value::as_object_mut) else {
            continue;
        };
        let Some(details) = tool_result
            .get_mut("details")
            .and_then(Value::as_object_mut)
        else {
            continue;
        };
        let Some(review) = details.get_mut("review").and_then(Value::as_object_mut) else {
            continue;
        };
        if review.get("snapshotId").and_then(Value::as_str) != Some(snapshot_id) {
            continue;
        }
        review.insert("state".into(), Value::String(state.to_string()));
        changed = true;
        break;
    }
    if changed {
        replace_messages(db, session_id, &messages)?;
    }
    Ok(changed)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageRevisionSummary {
    pub revision_index: i64,
    pub is_active: bool,
    pub created_at: String,
    pub message_count: i64,
}

/// Persist a discarded (or current) regenerate branch for a user root turn.
/// The branch payload goes to the append-only revisions file; SQLite keeps
/// the index row (identity, ordering, active flag, count).
pub fn save_message_revision(
    db: &Database,
    session_id: &str,
    root_user_id: &str,
    messages: &[UiMessage],
    make_active: bool,
) -> Result<MessageRevisionSummary> {
    if root_user_id.trim().is_empty() {
        return Err(anyhow!("rootUserId required"));
    }
    if messages.is_empty() {
        return Err(anyhow!("messages required"));
    }
    let conn = db.conn();
    let next_index: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(revision_index), 0) + 1
             FROM message_revisions
             WHERE session_id = ?1 AND root_user_id = ?2",
            params![session_id, root_user_id],
            |row| row.get(0),
        )
        .unwrap_or(1);
    let created = now_ms();
    let (records, _) = records_and_texts(messages);
    transcripts::append_revision(
        db.data_dir(),
        session_id,
        &RevisionRecord {
            root_user_id: root_user_id.to_string(),
            revision_index: next_index,
            created_at: ms_to_ts(created),
            messages: records,
        },
    )?;
    let tx = conn.unchecked_transaction()?;
    if make_active {
        tx.prepare_cached(
            "UPDATE message_revisions
             SET is_active = 0
             WHERE session_id = ?1 AND root_user_id = ?2",
        )?
        .execute(params![session_id, root_user_id])?;
    }
    let id = Uuid::new_v4().to_string();
    tx.prepare_cached(
        "INSERT INTO message_revisions (
            id, session_id, root_user_id, revision_index, is_active, message_count, created_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
    )?
    .execute(params![
        id,
        session_id,
        root_user_id,
        next_index,
        if make_active { 1 } else { 0 },
        messages.len() as i64,
        created
    ])?;
    tx.commit()?;
    Ok(MessageRevisionSummary {
        revision_index: next_index,
        is_active: make_active,
        created_at: ms_to_ts(created),
        message_count: messages.len() as i64,
    })
}

pub fn list_message_revisions(
    db: &Database,
    session_id: &str,
    root_user_id: &str,
) -> Result<Vec<MessageRevisionSummary>> {
    let mut stmt = db.conn().prepare_cached(
        "SELECT revision_index, is_active, created_at, message_count
         FROM message_revisions
         WHERE session_id = ?1 AND root_user_id = ?2
         ORDER BY revision_index ASC",
    )?;
    let rows = stmt.query_map(params![session_id, root_user_id], |row| {
        Ok(MessageRevisionSummary {
            revision_index: row.get(0)?,
            is_active: row.get::<_, i64>(1)? != 0,
            created_at: ms_to_ts(row.get(2)?),
            message_count: row.get(3)?,
        })
    })?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveRevisionSave {
    pub root_user_id: String,
    pub revision_count: i64,
    pub active_revision: i64,
    /// False when the branch was already archived and only the stamp was refreshed.
    pub archived: bool,
    /// The user root as it now stands on disk, for the renderer's pager.
    pub root: UiMessage,
}

/// Archive the branch that just finished as the active revision of its user
/// root, then stamp that root with the pager metadata.
///
/// This exists as one host call on purpose. Doing it from the app process meant
/// `session.get` -> `session.replaceMessages`, and that round trip raced the
/// same turn's final assistant message still draining the app's persistence
/// outbox: the stale snapshot went back to disk and deleted the answer. Here the
/// read, the archive and the stamp all happen under the RPC lock, and the stamp
/// rewrites one line instead of the whole transcript.
///
/// Returns `None` when the latest user turn owns no regenerate history, which is
/// every session that was never regenerated.
pub fn save_active_branch_revision(
    db: &Database,
    session_id: &str,
) -> Result<Option<ActiveRevisionSave>> {
    let Some(detail) = get_session(db, session_id)? else {
        return Ok(None);
    };
    let mut messages = detail.messages;
    let Some(root_index) = messages
        .iter()
        .rposition(|message| message.role == "user" && message.revision_count.is_some())
    else {
        return Ok(None);
    };
    let root_user_id = messages[root_index]
        .revision_root_id
        .clone()
        .unwrap_or_else(|| messages[root_index].id.clone());

    let existing = list_message_revisions(db, session_id, &root_user_id)?;
    let desired_active = messages[root_index].active_revision.unwrap_or(0);
    let already_archived = existing
        .iter()
        .any(|revision| revision.revision_index == desired_active);
    let mut active = if desired_active > 0 {
        desired_active
    } else {
        existing.len() as i64 + 1
    };
    let mut archived = false;
    if !already_archived {
        let saved =
            save_message_revision(db, session_id, &root_user_id, &messages[root_index..], true)?;
        active = saved.revision_index;
        archived = true;
    }
    let total = list_message_revisions(db, session_id, &root_user_id)?.len() as i64;
    if active < 1 {
        active = total;
    }

    let root = &mut messages[root_index];
    root.revision_root_id = Some(root_user_id.clone());
    root.revision_count = Some(total);
    root.active_revision = Some(active);
    let (record, _) = ui_to_record(root);
    invalidate_transcript_layout(session_id);
    transcripts::update_message(db.data_dir(), session_id, &record)?;
    Ok(Some(ActiveRevisionSave {
        root_user_id,
        revision_count: total,
        active_revision: active,
        archived,
        root: root.clone(),
    }))
}

/// Activate a stored revision: replace the live transcript with prefix + branch.
/// `prefix` is every message before the root user turn.
pub fn activate_message_revision(
    db: &Database,
    session_id: &str,
    root_user_id: &str,
    revision_index: i64,
    prefix: &[UiMessage],
) -> Result<Vec<UiMessage>> {
    let session_created = session_created_at(db, session_id)?;
    let conn = db.conn();
    let known: i64 = conn.query_row(
        "SELECT COUNT(*) FROM message_revisions
         WHERE session_id = ?1 AND root_user_id = ?2 AND revision_index = ?3",
        params![session_id, root_user_id, revision_index],
        |row| row.get(0),
    )?;
    if known == 0 {
        return Err(anyhow!("revision not found"));
    }
    let revision =
        transcripts::read_revision(db.data_dir(), session_id, root_user_id, revision_index)?
            .ok_or_else(|| anyhow!("revision payload missing from revisions file"))?;
    let branch: Vec<UiMessage> = revision.messages.into_iter().map(record_to_ui).collect();

    let total: i64 = conn.query_row(
        "SELECT COUNT(*) FROM message_revisions
         WHERE session_id = ?1 AND root_user_id = ?2",
        params![session_id, root_user_id],
        |row| row.get(0),
    )?;
    // rebuild live messages = prefix + branch
    let mut combined = Vec::with_capacity(prefix.len() + branch.len());
    combined.extend_from_slice(prefix);
    combined.extend(branch);
    // Stamp revision meta on the branch's user root. After regenerate the live
    // prompt id may differ from the stable family key, so prefer an exact id
    // match and fall back to the first user message in the restored branch.
    let root_pos = combined
        .iter()
        .position(|m| m.id == root_user_id)
        .or_else(|| {
            combined
                .iter()
                .skip(prefix.len())
                .position(|m| m.role == "user")
                .map(|rel| prefix.len() + rel)
        });
    if let Some(pos) = root_pos {
        if let Some(root) = combined.get_mut(pos) {
            root.revision_root_id = Some(root_user_id.to_string());
            root.revision_count = Some(total);
            root.active_revision = Some(revision_index);
        }
    }

    let (records, texts) = records_and_texts(&combined);
    invalidate_transcript_layout(session_id);
    transcripts::write_transcript(db.data_dir(), session_id, &session_created, &records)?;
    let tx = conn.unchecked_transaction()?;
    tx.prepare_cached(
        "UPDATE message_revisions
         SET is_active = CASE WHEN revision_index = ?3 THEN 1 ELSE 0 END
         WHERE session_id = ?1 AND root_user_id = ?2",
    )?
    .execute(params![session_id, root_user_id, revision_index])?;
    tx.prepare_cached("DELETE FROM messages WHERE session_id = ?1")?
        .execute(params![session_id])?;
    for (seq, record) in records.iter().enumerate() {
        insert_index_row(
            &tx,
            session_id,
            seq as i64,
            None,
            record,
            texts[seq].as_deref(),
        )?;
    }
    tx.prepare_cached("UPDATE sessions SET last_seq = ?1, updated_at = ?2 WHERE id = ?3")?
        .execute(params![records.len() as i64, now_ms(), session_id])?;
    tx.commit()?;
    Ok(combined)
}

/// Insert a session with caller-provided timestamps and messages in one
/// transaction. Idempotent: if a session with the same id already exists the
/// call is a no-op and returns false.
pub fn import_session(
    db: &Database,
    summary: &SessionSummary,
    messages: &[UiMessage],
) -> Result<bool> {
    validate_thinking_level(&summary.thinking_level)?;
    let mode = normalize_mode(Some(&summary.mode));
    let conn = db.conn();
    let exists: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sessions WHERE id = ?1",
        params![summary.id],
        |row| row.get(0),
    )?;
    if exists > 0 {
        return Ok(false);
    }
    let (records, texts) = records_and_texts(messages);
    invalidate_transcript_layout(&summary.id);
    transcripts::write_transcript(db.data_dir(), &summary.id, &summary.created_at, &records)?;
    let indexed = (|| -> Result<()> {
        let tx = conn.unchecked_transaction()?;
        let project_id = match summary
            .project_path
            .as_deref()
            .filter(|path| !path.trim().is_empty())
        {
            Some(path) => Some(db.ensure_project(path, false)?),
            None => None,
        };
        let source = summary.id.strip_prefix("import-").map(|rest| {
            for known in ["claude-code", "opencode", "codex", "pi"] {
                if rest.starts_with(&format!("{known}-")) {
                    return known.to_string();
                }
            }
            "external".to_string()
        });
        tx.prepare_cached(
            "INSERT INTO sessions (
                id, title, project_id, provider_id, model_id, mode, thinking_level, source,
                last_seq, created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        )?
        .execute(params![
            summary.id,
            summary.title,
            project_id,
            summary.provider_id,
            summary.model_id,
            mode,
            summary.thinking_level,
            source,
            records.len() as i64,
            ts_to_ms(&summary.created_at),
            ts_to_ms(&summary.updated_at),
        ])?;
        for (seq, record) in records.iter().enumerate() {
            insert_index_row(
                &tx,
                &summary.id,
                seq as i64,
                None,
                record,
                texts[seq].as_deref(),
            )?;
        }
        tx.commit()?;
        Ok(())
    })();
    if let Err(e) = indexed {
        // Don't leave transcript files behind for a session row that never
        // materialized.
        invalidate_transcript_layout(&summary.id);
        transcripts::remove_session_files(db.data_dir(), &summary.id);
        return Err(e);
    }
    Ok(true)
}

pub fn session_count(db: &Database) -> Result<i64> {
    Ok(db
        .conn()
        .query_row("SELECT COUNT(*) FROM sessions", [], |row| row.get(0))?)
}

// ---- turns ------------------------------------------------------------------

pub fn begin_turn(
    db: &Database,
    session_id: &str,
    provider_id: Option<&str>,
    model_id: Option<&str>,
) -> Result<String> {
    let id = Uuid::new_v4().to_string();
    let inserted = db
        .conn()
        .prepare_cached(
            "INSERT INTO turns (id, session_id, provider_id, model_id, started_at)
             SELECT ?1, ?2, ?3, ?4, ?5
             WHERE EXISTS (SELECT 1 FROM sessions WHERE id = ?2)
               AND NOT EXISTS (
                 SELECT 1 FROM turns WHERE session_id = ?2 AND status = 'running'
               )",
        )?
        .execute(params![id, session_id, provider_id, model_id, now_ms()])
        .map_err(|error| {
            let message = error.to_string();
            if message.contains("turns.session_id")
                || message.contains("idx_turns_one_running_session")
            {
                anyhow!("AGENT_BUSY")
            } else {
                error.into()
            }
        })?;
    if inserted == 0 {
        let session_exists: bool = db.conn().query_row(
            "SELECT EXISTS(SELECT 1 FROM sessions WHERE id = ?1)",
            params![session_id],
            |row| row.get(0),
        )?;
        if !session_exists {
            return Err(anyhow!("session not found: {session_id}"));
        }
        return Err(anyhow!("AGENT_BUSY"));
    }
    Ok(id)
}

pub struct EndTurnResult {
    pub updated: bool,
    pub notification: Option<Notification>,
}

pub fn end_turn(
    db: &Database,
    turn_id: &str,
    status: &str,
    error_code: Option<&str>,
    usage: Option<&Value>,
    create_notification: bool,
) -> Result<EndTurnResult> {
    let status = match status {
        "completed" | "aborted" | "error" => status,
        _ => "completed",
    };
    let input_tokens = usage
        .and_then(|u| u.get("inputTokens"))
        .and_then(|v| v.as_i64());
    let output_tokens = usage
        .and_then(|u| u.get("outputTokens"))
        .and_then(|v| v.as_i64());
    let tx = db.conn().unchecked_transaction()?;
    let n = tx
        .prepare_cached(
            "UPDATE turns SET status = ?1, error_code = ?2, ended_at = ?3,
                input_tokens = COALESCE(?4, input_tokens),
                output_tokens = COALESCE(?5, output_tokens),
                usage_json = COALESCE(?6, usage_json)
             WHERE id = ?7 AND status = 'running'",
        )?
        .execute(params![
            status,
            error_code,
            now_ms(),
            input_tokens,
            output_tokens,
            usage.map(|u| u.to_string()),
            turn_id,
        ])?;
    let notification = if n > 0 && create_notification {
        notifications::insert_for_terminal_turn(&tx, turn_id, status, error_code)?
    } else {
        None
    };
    tx.commit()?;
    Ok(EndTurnResult {
        updated: n > 0,
        notification,
    })
}

// ---- search -----------------------------------------------------------------

pub fn search_messages(db: &Database, query: &str, limit: i64) -> Result<Vec<SearchHit>> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let limit = limit.clamp(1, 100);
    // trigram FTS needs >= 3 chars; shorter queries fall back to LIKE.
    if query.chars().count() >= 3 {
        let quoted = format!("\"{}\"", query.replace('"', "\"\""));
        let mut stmt = db.conn().prepare_cached(
            "SELECT m.id, m.session_id, s.title, m.role, m.created_at,
                    snippet(messages_fts, 0, '', '', '…', 16)
             FROM messages_fts
             JOIN messages m ON m.mid = messages_fts.rowid
             JOIN sessions s ON s.id = m.session_id
             WHERE messages_fts MATCH ?1
             ORDER BY m.created_at DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![quoted, limit], |row| {
            Ok(SearchHit {
                message_id: row.get(0)?,
                session_id: row.get(1)?,
                session_title: row.get(2)?,
                role: row.get(3)?,
                created_at: ms_to_ts(row.get(4)?),
                snippet: row.get(5)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    } else {
        let escaped = query
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_");
        let mut stmt = db.conn().prepare_cached(
            "SELECT m.id, m.session_id, s.title, m.role, m.created_at,
                    substr(m.text, 1, 160)
             FROM messages m
             JOIN sessions s ON s.id = m.session_id
             WHERE m.text LIKE '%' || ?1 || '%' ESCAPE '\\'
             ORDER BY m.created_at DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![escaped, limit], |row| {
            Ok(SearchHit {
                message_id: row.get(0)?,
                session_id: row.get(1)?,
                session_title: row.get(2)?,
                role: row.get(3)?,
                created_at: ms_to_ts(row.get(4)?),
                snippet: row.get(5)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_db() -> Database {
        let dir = std::env::temp_dir().join(format!("pi-desktop-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        Database::open(&dir.join("test.sqlite")).unwrap()
    }

    fn user_msg(id: &str, content: &str, ts: &str) -> UiMessage {
        UiMessage {
            id: id.into(),
            role: "user".into(),
            content: content.into(),
            attachments: None,
            created_at: ts.into(),
            thinking: None,
            status: None,
            model_id: None,
            provider_id: None,
            usage: None,
            response_duration_ms: None,
            response_output_tokens: None,
            error: None,
            revision_root_id: None,
            revision_count: None,
            active_revision: None,
            tool_name: None,
            tool_call_id: None,
            tool_status: None,
            tool_args: None,
            tool_result: None,
            tool_completed_at: None,
            tool_duration_ms: None,
            is_error: None,
            parent_tool_call_id: None,
            agent_name: None,
        }
    }

    fn checkpoint(first: &str, through: &str) -> CompactionRecord {
        CompactionRecord {
            id: Uuid::new_v4().to_string(),
            summary: "durable summary".into(),
            first_kept_message_id: Some(first.into()),
            through_message_id: through.into(),
            tokens_before: 120_000,
            usage: None,
            retained_tail: Some(json!([{
                "role": "user",
                "content": "recent",
                "timestamp": 1
            }])),
            details: None,
            provider_id: Some("provider-1".into()),
            model_id: Some("model-1".into()),
            created_at: "2026-07-28T00:00:03Z".into(),
        }
    }

    #[test]
    fn compaction_survives_restart_and_late_truncation_but_not_early_truncation() {
        let db = test_db();
        let session = create_session(&db, None, None, None, None, None).unwrap();
        let messages = [
            user_msg("u1", "old", "2026-07-28T00:00:00Z"),
            user_msg("u2", "recent", "2026-07-28T00:00:01Z"),
            user_msg("u3", "after", "2026-07-28T00:00:02Z"),
        ];
        for message in &messages {
            append_message(&db, &session.id, message, None).unwrap();
        }
        append_compaction(&db, &session.id, &checkpoint("u2", "u2")).unwrap();

        let restored = get_session(&db, &session.id).unwrap().unwrap();
        assert_eq!(restored.messages.len(), 3);
        assert_eq!(
            restored.compaction.as_ref().unwrap().through_message_id,
            "u2"
        );

        replace_messages(&db, &session.id, &messages[..2]).unwrap();
        assert!(get_session(&db, &session.id)
            .unwrap()
            .unwrap()
            .compaction
            .is_some());

        replace_messages(&db, &session.id, &messages[..1]).unwrap();
        assert!(get_session(&db, &session.id)
            .unwrap()
            .unwrap()
            .compaction
            .is_none());
    }

    #[test]
    fn the_whole_checkpoint_chain_survives_restart_and_partial_truncation() {
        let db = test_db();
        let session = create_session(&db, None, None, None, None, None).unwrap();
        let messages = [
            user_msg("u1", "old", "2026-07-28T00:00:00Z"),
            user_msg("u2", "recent", "2026-07-28T00:00:01Z"),
            user_msg("u3", "after", "2026-07-28T00:00:02Z"),
        ];
        for message in &messages {
            append_message(&db, &session.id, message, None).unwrap();
        }
        append_compaction(&db, &session.id, &checkpoint("u1", "u1")).unwrap();
        append_compaction(&db, &session.id, &checkpoint("u2", "u3")).unwrap();

        let restored = get_session(&db, &session.id).unwrap().unwrap();
        assert_eq!(restored.compactions.len(), 2);
        // `compaction` stays the newest one: it is what the runtime reinstalls.
        assert_eq!(
            restored.compaction.as_ref().unwrap().id,
            restored.compactions[1].id
        );

        // Truncating past the second anchor invalidates that record alone.
        replace_messages(&db, &session.id, &messages[..2]).unwrap();
        let after = get_session(&db, &session.id).unwrap().unwrap();
        assert_eq!(
            after
                .compactions
                .iter()
                .map(|record| record.through_message_id.as_str())
                .collect::<Vec<_>>(),
            vec!["u1"]
        );
    }

    #[test]
    fn fork_remaps_each_checkpoint_in_the_chain_on_its_own() {
        let db = test_db();
        let session = create_session(&db, None, None, None, None, None).unwrap();
        let messages = [
            user_msg("u1", "old", "2026-07-28T00:00:00Z"),
            user_msg("u2", "recent", "2026-07-28T00:00:01Z"),
        ];
        for message in &messages {
            append_message(&db, &session.id, message, None).unwrap();
        }
        append_compaction(&db, &session.id, &checkpoint("u1", "u1")).unwrap();
        append_compaction(&db, &session.id, &checkpoint("u2", "u2")).unwrap();

        let ForkSessionResult::Created(full) =
            fork_session_through(&db, &session.id, None, None).unwrap()
        else {
            panic!("expected fork");
        };
        assert_eq!(
            full.compactions
                .iter()
                .map(|record| record.through_message_id.as_str())
                .collect::<Vec<_>>(),
            vec![full.messages[0].id.as_str(), full.messages[1].id.as_str()]
        );

        // A fork that cuts the later anchor keeps the earlier checkpoint.
        let ForkSessionResult::Created(partial) =
            fork_session_through(&db, &session.id, None, Some("u1")).unwrap()
        else {
            panic!("expected fork");
        };
        assert_eq!(partial.compactions.len(), 1);
        assert_eq!(
            partial.compactions[0].through_message_id,
            partial.messages[0].id
        );
    }

    #[test]
    fn fork_copies_only_a_checkpoint_whose_boundary_is_included() {
        let db = test_db();
        let session = create_session(&db, None, None, None, None, None).unwrap();
        let messages = [
            user_msg("u1", "old", "2026-07-28T00:00:00Z"),
            user_msg("u2", "recent", "2026-07-28T00:00:01Z"),
        ];
        for message in &messages {
            append_message(&db, &session.id, message, None).unwrap();
        }
        append_compaction(&db, &session.id, &checkpoint("u2", "u2")).unwrap();

        let ForkSessionResult::Created(before) =
            fork_session_through(&db, &session.id, None, Some("u1")).unwrap()
        else {
            panic!("expected fork");
        };
        assert!(before.compaction.is_none());

        let ForkSessionResult::Created(including) =
            fork_session_through(&db, &session.id, None, Some("u2")).unwrap()
        else {
            panic!("expected fork");
        };
        let copied = including.compaction.unwrap();
        assert_eq!(
            copied.first_kept_message_id.as_deref(),
            Some(including.messages[1].id.as_str())
        );
        assert_eq!(copied.through_message_id, including.messages[1].id);
        assert_ne!(
            copied.id,
            get_session(&db, &session.id)
                .unwrap()
                .unwrap()
                .compaction
                .unwrap()
                .id
        );
    }

    #[test]
    fn configure_session_persists_pi_runtime_selection() {
        let db = test_db();
        let session = create_session(&db, None, None, None, None, Some("/tmp/x".into())).unwrap();
        db.conn()
            .execute(
                "INSERT INTO providers (
                    id, name, vendor_key, type, protocol, enabled, base_url,
                    auth_kind, secret_ref, api_style, default_model_id,
                    created_at, updated_at
                 ) VALUES (
                    'provider-1', 'Provider', 'custom', 'openai_compatible',
                    'openai_compatible', 1, NULL, 'none', NULL,
                    'chat_completions', 'model-1', 1, 1
                 )",
                [],
            )
            .unwrap();

        let configured = configure_session_with_thinking(
            &db,
            &session.id,
            "chat",
            Some("provider-1"),
            Some("model-1"),
            Some("high"),
            None,
        )
        .unwrap()
        .unwrap();

        assert_eq!(configured.mode, "plan");
        assert_eq!(configured.provider_id.as_deref(), Some("provider-1"));
        assert_eq!(configured.model_id.as_deref(), Some("model-1"));
        assert_eq!(configured.thinking_level, "high");
        // Omitting the new field is backwards-compatible and preserves the
        // configured value rather than resetting it to off.
        let preserved = configure_session(&db, &session.id, "chat", None, None)
            .unwrap()
            .unwrap();
        assert_eq!(preserved.thinking_level, "high");
        assert!(configure_session(&db, &session.id, "invalid", None, None).is_err());
        assert!(configure_session_with_thinking(
            &db,
            &session.id,
            "chat",
            None,
            None,
            Some("turbo"),
            None,
        )
        .is_err());
    }

    #[test]
    fn create_session_returns_canonical_project_path() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("project");
        std::fs::create_dir_all(&project).unwrap();
        let db = Database::open(&dir.path().join("test.sqlite")).unwrap();
        let spelling_with_trailing_slash = format!("{}/", project.display());

        let session = create_session(
            &db,
            None,
            None,
            None,
            None,
            Some(spelling_with_trailing_slash),
        )
        .unwrap();

        let canonical = project
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        assert_eq!(session.project_path.as_deref(), Some(canonical.as_str()));
        assert_eq!(
            get_session(&db, &session.id)
                .unwrap()
                .unwrap()
                .summary
                .project_path
                .as_deref(),
            Some(canonical.as_str())
        );
    }

    #[test]
    fn import_session_is_idempotent_and_preserves_timestamps() {
        let db = test_db();
        let summary = SessionSummary {
            id: "import-claude-code-abc".into(),
            title: "Imported".into(),
            message_count: 1,
            project_path: Some("/tmp/proj".into()),
            model_id: None,
            provider_id: None,
            mode: "agent".into(),
            thinking_level: "off".into(),
            permission_mode: "inherit".into(),
            created_at: "2025-01-01T00:00:00Z".into(),
            updated_at: "2025-01-02T00:00:00Z".into(),
        };
        let messages = vec![user_msg("m1", "hello", "2025-01-01T00:00:01Z")];

        assert!(import_session(&db, &summary, &messages).unwrap());
        // Re-import of the same id is skipped.
        assert!(!import_session(&db, &summary, &messages).unwrap());

        let detail = get_session(&db, &summary.id).unwrap().unwrap();
        // Timestamps are stored as ms and re-emitted as RFC3339: compare instants.
        assert_eq!(
            ts_to_ms(&detail.summary.created_at),
            ts_to_ms("2025-01-01T00:00:00Z")
        );
        assert_eq!(
            ts_to_ms(&detail.summary.updated_at),
            ts_to_ms("2025-01-02T00:00:00Z")
        );
        assert_eq!(detail.summary.project_path.as_deref(), Some("/tmp/proj"));
        assert_eq!(detail.messages.len(), 1);
        assert_eq!(detail.messages[0].content, "hello");
        let projects = db.list_projects().unwrap();
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].path, "/tmp/proj");

        let source: Option<String> = db
            .conn()
            .query_row(
                "SELECT source FROM sessions WHERE id = ?1",
                params![summary.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(source.as_deref(), Some("claude-code"));
    }

    #[test]
    fn import_materializes_unique_projects_but_keeps_pathless_sessions_temporary() {
        let db = test_db();
        let base = SessionSummary {
            id: "import-codex-one".into(),
            title: "Imported".into(),
            message_count: 0,
            project_path: Some("/tmp/project/".into()),
            model_id: None,
            provider_id: None,
            mode: "agent".into(),
            thinking_level: "off".into(),
            permission_mode: "inherit".into(),
            created_at: "2025-01-01T00:00:00Z".into(),
            updated_at: "2025-01-01T00:00:00Z".into(),
        };
        assert!(import_session(&db, &base, &[]).unwrap());

        let mut same_project = base.clone();
        same_project.id = "import-codex-two".into();
        same_project.project_path = Some("/tmp/project".into());
        assert!(import_session(&db, &same_project, &[]).unwrap());

        let mut temporary = base.clone();
        temporary.id = "import-codex-temporary".into();
        temporary.project_path = Some("   ".into());
        assert!(import_session(&db, &temporary, &[]).unwrap());

        let projects = db.list_projects().unwrap();
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].path, "/tmp/project");
        assert_eq!(
            get_session(&db, &temporary.id)
                .unwrap()
                .unwrap()
                .summary
                .project_path,
            None
        );
    }

    #[test]
    fn subagent_attribution_roundtrips() {
        let db = test_db();
        let session = create_session(&db, None, None, None, None, Some("/tmp/x".into())).unwrap();
        let mut assistant = user_msg("m1", "Found it.", "2025-05-01T00:00:00Z");
        assistant.role = "assistant".into();
        assistant.parent_tool_call_id = Some("task-1".into());
        assistant.agent_name = Some("explorer".into());
        append_message(&db, &session.id, &assistant, None).unwrap();

        let mut tool = user_msg("m2", "ok", "2025-05-01T00:00:01Z");
        tool.role = "tool".into();
        tool.tool_name = Some("Read".into());
        tool.tool_call_id = Some("child-read".into());
        tool.tool_status = Some("success".into());
        tool.parent_tool_call_id = Some("task-1".into());
        tool.agent_name = Some("explorer".into());
        append_message(&db, &session.id, &tool, None).unwrap();

        let detail = get_session(&db, &session.id).unwrap().unwrap();
        for message in &detail.messages {
            assert_eq!(message.parent_tool_call_id.as_deref(), Some("task-1"));
            assert_eq!(message.agent_name.as_deref(), Some("explorer"));
        }
        // A row without attribution stays unattributed rather than inheriting one.
        append_message(
            &db,
            &session.id,
            &user_msg("m3", "next", "2025-05-01T00:00:02Z"),
            None,
        )
        .unwrap();
        let detail = get_session(&db, &session.id).unwrap().unwrap();
        assert_eq!(detail.messages[2].parent_tool_call_id, None);
        assert_eq!(detail.messages[2].agent_name, None);
    }

    #[test]
    fn append_and_roundtrip_tool_message() {
        let db = test_db();
        let session = create_session(&db, None, None, None, None, Some("/tmp/x".into())).unwrap();
        assert_eq!(session.message_count, 0);
        append_message(
            &db,
            &session.id,
            &user_msg("m1", "写一个文件", "2025-05-01T00:00:00Z"),
            None,
        )
        .unwrap();
        let tool = UiMessage {
            id: "m2".into(),
            role: "tool".into(),
            content: "ok".into(),
            attachments: None,
            created_at: "2025-05-01T00:00:02Z".into(),
            thinking: None,
            status: Some("complete".into()),
            model_id: None,
            provider_id: None,
            usage: None,
            response_duration_ms: None,
            response_output_tokens: None,
            error: None,
            revision_root_id: None,
            revision_count: None,
            active_revision: None,
            tool_name: Some("Write".into()),
            tool_call_id: Some("c1".into()),
            tool_status: Some("success".into()),
            tool_args: Some(json!({ "path": "a.txt" })),
            tool_result: Some(json!({ "ok": true })),
            tool_completed_at: Some("2025-05-01T00:00:03Z".into()),
            tool_duration_ms: Some(1_000),
            is_error: None,
            parent_tool_call_id: None,
            agent_name: None,
        };
        append_message(&db, &session.id, &tool, None).unwrap();
        // Host recovery may replay the Electron persistence outbox; a message
        // id must make that replay a no-op.
        append_message(&db, &session.id, &tool, None).unwrap();

        let detail = get_session(&db, &session.id).unwrap().unwrap();
        assert_eq!(detail.messages.len(), 2);
        assert_eq!(detail.summary.message_count, 2);
        let m2 = &detail.messages[1];
        assert_eq!(m2.role, "tool");
        assert_eq!(m2.tool_name.as_deref(), Some("Write"));
        assert_eq!(m2.tool_call_id.as_deref(), Some("c1"));
        assert_eq!(m2.tool_status.as_deref(), Some("success"));
        assert_eq!(m2.tool_args, Some(json!({ "path": "a.txt" })));
        assert_eq!(m2.tool_result, Some(json!({ "ok": true })));
        assert_eq!(
            m2.tool_completed_at.as_deref(),
            Some("2025-05-01T00:00:03Z")
        );
        assert_eq!(m2.tool_duration_ms, Some(1_000));
        assert_eq!(m2.content, "ok");
        assert_eq!(m2.status.as_deref(), Some("complete"));

        let mut review_tool = tool.clone();
        review_tool.tool_result = Some(json!({
            "ok": true,
            "details": {
                "root": "workspace",
                "review": {
                    "snapshotId": "snapshot-1",
                    "state": "active"
                }
            }
        }));
        replace_messages(
            &db,
            &session.id,
            &[
                user_msg("m1", "写一个文件", "2025-05-01T00:00:00Z"),
                review_tool,
            ],
        )
        .unwrap();
        assert!(
            update_tool_review_state(&db, &session.id, "m2", "snapshot-1", "rolledBack",).unwrap()
        );
        let updated = get_session(&db, &session.id).unwrap().unwrap();
        assert_eq!(updated.summary.message_count, 2);
        assert_eq!(
            updated.messages[1].tool_result,
            Some(json!({
                "ok": true,
                "details": {
                    "root": "workspace",
                    "review": {
                        "snapshotId": "snapshot-1",
                        "state": "rolledBack"
                    }
                }
            }))
        );

        // seq allocation is monotonic per session.
        let last_seq: i64 = db
            .conn()
            .query_row(
                "SELECT last_seq FROM sessions WHERE id = ?1",
                params![session.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(last_seq, 2);
    }

    #[test]
    fn user_attachments_roundtrip_as_canonical_blocks() {
        let db = test_db();
        let session = create_session(&db, None, None, None, None, None).unwrap();
        let mut user = user_msg("image-1", "这是什么", "2025-05-01T00:00:00Z");
        user.attachments = Some(vec![MessageAttachment {
            kind: "image".into(),
            name: "image.png".into(),
            reference: "attachments/abc123".into(),
            mime_type: Some("image/png".into()),
            size: Some(42),
        }]);

        append_message(&db, &session.id, &user, None).unwrap();

        let detail = get_session(&db, &session.id).unwrap().unwrap();
        assert_eq!(detail.messages[0].attachments, user.attachments);
        assert_eq!(detail.messages[0].content, "这是什么");

        let record = transcripts::read_transcript(db.data_dir(), &session.id)
            .unwrap()
            .into_iter()
            .find(|record| record.id == user.id)
            .expect("attachment message record");
        let blocks = record.blocks;
        assert_eq!(blocks[1]["type"], "attachment");
        assert_eq!(blocks[1]["ref"], "attachments/abc123");
        assert!(blocks[1].get("data").is_none());
    }

    #[test]
    fn bounded_reads_use_physical_line_positions_not_the_dedup_counter() {
        // A retried append leaves the same message id on two file lines. The
        // index counter (`last_seq`) counts it once, so a window clamped
        // against that counter cut one line short and hid the newest message.
        let db = test_db();
        let session = create_session(&db, None, None, None, None, None).unwrap();
        for index in 0..4 {
            append_message(
                &db,
                &session.id,
                &user_msg(
                    &format!("m{index}"),
                    &format!("body {index}"),
                    "2025-05-01T00:00:00Z",
                ),
                None,
            )
            .unwrap();
        }
        // Append one line straight to the file, as a crash between the durable
        // file append and its index commit does. `last_seq` stays at 4 while the
        // file holds 5 message lines, and it never catches up.
        let (record, _) = ui_to_record(&user_msg("m4", "newest", "2025-05-01T00:00:04Z"));
        transcripts::append_message(db.data_dir(), &session.id, "2025-05-01T00:00:00Z", &record)
            .unwrap();
        let last_seq: i64 = db
            .conn()
            .query_row(
                "SELECT last_seq FROM sessions WHERE id = ?1",
                params![session.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(last_seq, 4);

        let page = get_session_with_options(
            &db,
            &session.id,
            SessionReadOptions {
                message_before: None,
                message_limit: Some(2),
                content_limit: None,
            },
        )
        .unwrap()
        .unwrap();
        // Clamping the window to `last_seq` used to cut the newest line off the
        // tail, so the message existed on disk but never reached the renderer.
        let ids: Vec<&str> = page.messages.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, ["m3", "m4"]);
        assert_eq!(page.has_more_before, Some(true));

        // Paging backwards from the reported start reaches the true head
        // without skipping a message.
        let mut seen: Vec<String> = page.messages.iter().map(|m| m.id.clone()).collect();
        let mut start = page.message_start.unwrap();
        while start > 0 {
            let older = get_session_with_options(
                &db,
                &session.id,
                SessionReadOptions {
                    message_before: Some(start),
                    message_limit: Some(2),
                    content_limit: None,
                },
            )
            .unwrap()
            .unwrap();
            let mut ids: Vec<String> = older.messages.iter().map(|m| m.id.clone()).collect();
            ids.append(&mut seen);
            seen = ids;
            start = older.message_start.unwrap();
        }
        assert_eq!(seen, ["m0", "m1", "m2", "m3", "m4"]);
    }

    #[test]
    fn bounded_session_reads_page_history_and_cap_display_content() {
        let db = test_db();
        let session = create_session(&db, None, None, None, None, None).unwrap();
        append_message(
            &db,
            &session.id,
            &user_msg("m1", "old", "2025-05-01T00:00:00Z"),
            None,
        )
        .unwrap();
        append_message(
            &db,
            &session.id,
            &user_msg("m2", &"x".repeat(80_000), "2025-05-01T00:00:01Z"),
            None,
        )
        .unwrap();

        let page = get_session_with_options(
            &db,
            &session.id,
            SessionReadOptions {
                message_before: None,
                message_limit: Some(1),
                content_limit: Some(128),
            },
        )
        .unwrap()
        .unwrap();
        assert_eq!(page.message_start, Some(1));
        assert_eq!(page.has_more_before, Some(true));
        assert_eq!(page.messages.len(), 1);
        assert!(page.messages[0].content.len() < 256);
        assert!(page.messages[0].content.contains("truncated for display"));

        let full = get_session(&db, &session.id).unwrap().unwrap();
        assert_eq!(full.messages[1].content.len(), 80_000);
    }

    #[test]
    fn assistant_thinking_roundtrips_as_canonical_blocks() {
        let db = test_db();
        let session = create_session(&db, None, None, None, None, None).unwrap();
        let assistant = UiMessage {
            id: "assistant-1".into(),
            role: "assistant".into(),
            content: "final answer".into(),
            attachments: None,
            created_at: "2025-05-01T00:00:01Z".into(),
            thinking: Some("first plan\nsecond plan".into()),
            status: Some("complete".into()),
            model_id: Some("model-1".into()),
            provider_id: Some("provider-1".into()),
            usage: Some(MessageUsage {
                input_tokens: 12,
                output_tokens: 34,
                cache_read_tokens: Some(2),
                cache_write_tokens: None,
                reasoning_tokens: Some(5),
                total_tokens: 48,
            }),
            response_duration_ms: Some(2_000),
            response_output_tokens: Some(34),
            error: None,
            revision_root_id: None,
            revision_count: None,
            active_revision: None,
            tool_name: None,
            tool_call_id: None,
            tool_status: None,
            tool_args: None,
            tool_result: None,
            tool_completed_at: None,
            tool_duration_ms: None,
            is_error: None,
            parent_tool_call_id: None,
            agent_name: None,
        };
        append_message(&db, &session.id, &assistant, None).unwrap();

        let records = transcripts::read_transcript(db.data_dir(), &session.id).unwrap();
        assert_eq!(records.len(), 1);
        let blocks = &records[0].blocks;
        assert_eq!(
            blocks[0],
            json!({
                "type": "thinking",
                "text": "first plan\nsecond plan"
            })
        );
        assert_eq!(
            blocks[1],
            json!({
                "type": "text",
                "text": "final answer"
            })
        );

        let detail = get_session(&db, &session.id).unwrap().unwrap();
        assert_eq!(
            detail.messages[0].thinking.as_deref(),
            Some("first plan\nsecond plan")
        );
        assert_eq!(detail.messages[0].content, "final answer");
        assert_eq!(detail.messages[0].model_id.as_deref(), Some("model-1"));
        assert_eq!(
            detail.messages[0].provider_id.as_deref(),
            Some("provider-1")
        );
        let usage = detail.messages[0].usage.as_ref().expect("usage");
        assert_eq!(usage.input_tokens, 12);
        assert_eq!(usage.output_tokens, 34);
        assert_eq!(usage.cache_read_tokens, Some(2));
        assert_eq!(usage.reasoning_tokens, Some(5));
        assert_eq!(usage.total_tokens, 48);
        assert_eq!(detail.messages[0].response_duration_ms, Some(2_000));
        assert_eq!(detail.messages[0].response_output_tokens, Some(34));
    }

    #[test]
    fn assistant_error_roundtrips_in_message_metadata() {
        let db = test_db();
        let session = create_session(&db, None, None, None, None, None).unwrap();
        let mut assistant = user_msg("assistant-error", "", "2025-05-01T00:00:01Z");
        assistant.role = "assistant".into();
        assistant.status = Some("error".into());
        assistant.is_error = Some(true);
        assistant.error = Some(json!({
            "code": "MODEL_NOT_CONFIGURED",
            "message": "404: model not found",
            "retriable": false
        }));

        append_message(&db, &session.id, &assistant, None).unwrap();
        let detail = get_session(&db, &session.id).unwrap().unwrap();
        let restored = &detail.messages[0];

        assert_eq!(restored.status.as_deref(), Some("error"));
        assert_eq!(restored.is_error, Some(true));
        assert_eq!(restored.error, assistant.error);
    }

    #[test]
    fn import_and_replace_preserve_thinking() {
        let db = test_db();
        let summary = SessionSummary {
            id: "thinking-import".into(),
            title: "Thinking".into(),
            message_count: 0,
            project_path: None,
            model_id: None,
            provider_id: None,
            mode: "agent".into(),
            thinking_level: "medium".into(),
            permission_mode: "inherit".into(),
            created_at: "2025-01-01T00:00:00Z".into(),
            updated_at: "2025-01-01T00:00:00Z".into(),
        };
        let mut message = user_msg("m1", "prompt", "2025-01-01T00:00:01Z");
        message.role = "assistant".into();
        message.thinking = Some("persist me".into());
        assert!(import_session(&db, &summary, &[message.clone()]).unwrap());
        let detail = get_session(&db, &summary.id).unwrap().unwrap();
        assert_eq!(detail.summary.thinking_level, "medium");
        assert_eq!(detail.messages[0].thinking.as_deref(), Some("persist me"));

        let session = create_session(&db, None, None, None, None, None).unwrap();
        message.id = "m2".into();
        replace_messages(&db, &session.id, &[message]).unwrap();
        let detail = get_session(&db, &session.id).unwrap().unwrap();
        assert_eq!(detail.messages[0].thinking.as_deref(), Some("persist me"));
    }

    #[test]
    fn transcript_survives_reopen_from_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pi.sqlite");
        let db = Database::open(&path).unwrap();
        let session = create_session(&db, None, None, None, None, None).unwrap();
        append_message(
            &db,
            &session.id,
            &user_msg("m1", "durable", "2025-05-01T00:00:00Z"),
            None,
        )
        .unwrap();
        let transcript = transcripts::transcript_path(db.data_dir(), &session.id).unwrap();
        assert!(transcript.exists());

        drop(db);
        let db = Database::open(&path).unwrap();
        let detail = get_session(&db, &session.id).unwrap().unwrap();
        assert_eq!(detail.messages.len(), 1);
        assert_eq!(detail.messages[0].content, "durable");
    }

    #[test]
    fn delete_session_removes_transcript_files() {
        let db = test_db();
        let session = create_session(&db, None, None, None, None, None).unwrap();
        let root = user_msg("m1", "x", "2025-05-01T00:00:00Z");
        append_message(&db, &session.id, &root, None).unwrap();
        save_message_revision(&db, &session.id, "m1", &[root], true).unwrap();
        let transcript = transcripts::transcript_path(db.data_dir(), &session.id).unwrap();
        let revisions = transcripts::revisions_path(db.data_dir(), &session.id).unwrap();
        assert!(transcript.exists());
        assert!(revisions.exists());

        assert!(delete_session(&db, &session.id).unwrap());
        assert!(!transcript.exists());
        assert!(!revisions.exists());
    }

    #[test]
    fn get_session_dedupes_retried_file_lines_keep_last() {
        let db = test_db();
        let session = create_session(&db, None, None, None, None, None).unwrap();
        append_message(
            &db,
            &session.id,
            &user_msg("m1", "old", "2025-05-01T00:00:00Z"),
            None,
        )
        .unwrap();
        // Simulate a retried append whose first file line lost its index
        // transaction: the same id lands twice and the newest line wins.
        let (record, _) = ui_to_record(&user_msg("m1", "new", "2025-05-01T00:00:01Z"));
        transcripts::append_message(db.data_dir(), &session.id, "2025-05-01T00:00:00Z", &record)
            .unwrap();

        let detail = get_session(&db, &session.id).unwrap().unwrap();
        assert_eq!(detail.messages.len(), 1);
        assert_eq!(detail.messages[0].content, "new");
    }

    #[test]
    fn replace_messages_resets_stream() {
        let db = test_db();
        let session = create_session(&db, None, None, None, None, None).unwrap();
        append_message(
            &db,
            &session.id,
            &user_msg("a", "one", "2025-05-01T00:00:00Z"),
            None,
        )
        .unwrap();
        append_message(
            &db,
            &session.id,
            &user_msg("b", "two", "2025-05-01T00:00:01Z"),
            None,
        )
        .unwrap();
        replace_messages(
            &db,
            &session.id,
            &[user_msg("c", "compacted", "2025-05-01T00:00:02Z")],
        )
        .unwrap();
        let detail = get_session(&db, &session.id).unwrap().unwrap();
        assert_eq!(detail.messages.len(), 1);
        assert_eq!(detail.messages[0].content, "compacted");
        // Appending after replace continues from the new stream head.
        append_message(
            &db,
            &session.id,
            &user_msg("d", "next", "2025-05-01T00:00:03Z"),
            None,
        )
        .unwrap();
        let detail = get_session(&db, &session.id).unwrap().unwrap();
        assert_eq!(detail.messages.len(), 2);
        assert_eq!(detail.messages[1].content, "next");
    }

    #[test]
    fn fork_session_clones_active_transcript_and_configuration() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pi.sqlite");
        let db = Database::open(&path).unwrap();
        let source = create_session_with_thinking(
            &db,
            Some("Source".into()),
            Some("chat".into()),
            Some("provider-1".into()),
            Some("model-1".into()),
            Some("/tmp/project".into()),
            Some("high".into()),
        )
        .unwrap();
        configure_session_with_thinking(
            &db,
            &source.id,
            "chat",
            Some("provider-1"),
            Some("model-1"),
            Some("high"),
            Some("auto"),
        )
        .unwrap();

        let mut user = user_msg("user-1", "fork this", "2025-05-01T00:00:00Z");
        user.revision_root_id = Some("user-1".into());
        user.revision_count = Some(2);
        user.active_revision = Some(2);
        let mut tool = user_msg("tool-1", "ok", "2025-05-01T00:00:01Z");
        tool.role = "tool".into();
        tool.tool_name = Some("Read".into());
        tool.tool_call_id = Some("call-1".into());
        tool.tool_status = Some("success".into());
        append_message(&db, &source.id, &user, None).unwrap();
        append_message(&db, &source.id, &tool, None).unwrap();
        save_message_revision(&db, &source.id, "user-1", &[user.clone()], true).unwrap();

        let ForkSessionResult::Created(fork) =
            fork_session_through(&db, &source.id, Some("Source (branch)"), None).unwrap()
        else {
            panic!("expected forked session");
        };
        let source_after = get_session(&db, &source.id).unwrap().unwrap();

        assert_ne!(fork.summary.id, source.id);
        assert_eq!(fork.summary.title, "Source (branch)");
        assert_eq!(fork.summary.project_path, source.project_path);
        assert_eq!(fork.summary.provider_id.as_deref(), Some("provider-1"));
        assert_eq!(fork.summary.model_id.as_deref(), Some("model-1"));
        assert_eq!(fork.summary.mode, "plan");
        assert_eq!(fork.summary.thinking_level, "high");
        assert_eq!(fork.summary.permission_mode, "auto");
        assert_eq!(fork.messages.len(), 2);
        assert_eq!(source_after.messages[0].id, "user-1");
        assert_eq!(
            source_after.messages[1].tool_call_id.as_deref(),
            Some("call-1")
        );
        assert_ne!(fork.messages[0].id, source_after.messages[0].id);
        assert_ne!(fork.messages[1].id, source_after.messages[1].id);
        assert_ne!(
            fork.messages[1].tool_call_id,
            source_after.messages[1].tool_call_id
        );
        assert_eq!(fork.messages[0].content, "fork this");
        assert_eq!(fork.messages[0].revision_root_id, None);
        assert_eq!(fork.messages[0].revision_count, None);
        assert_eq!(fork.messages[0].active_revision, None);
        assert!(list_message_revisions(&db, &fork.summary.id, "user-1")
            .unwrap()
            .is_empty());
        assert!(
            !transcripts::revisions_path(db.data_dir(), &fork.summary.id)
                .unwrap()
                .exists()
        );
        assert!(search_messages(&db, "fork", 10)
            .unwrap()
            .iter()
            .any(|hit| hit.session_id == fork.summary.id));

        append_message(
            &db,
            &fork.summary.id,
            &user_msg("child-only", "continue here", "2025-05-01T00:00:02Z"),
            None,
        )
        .unwrap();
        configure_session_with_thinking(
            &db,
            &fork.summary.id,
            "agent",
            Some("provider-2"),
            Some("model-2"),
            Some("off"),
            Some("ask"),
        )
        .unwrap();
        let source_final = get_session(&db, &source.id).unwrap().unwrap();
        let fork_final = get_session(&db, &fork.summary.id).unwrap().unwrap();
        assert_eq!(source_final.messages.len(), 2);
        assert_eq!(source_final.summary.mode, "plan");
        assert_eq!(source_final.summary.model_id.as_deref(), Some("model-1"));
        assert_eq!(fork_final.messages.len(), 3);
        assert_eq!(fork_final.summary.mode, "agent");
        assert_eq!(fork_final.summary.model_id.as_deref(), Some("model-2"));
        assert_eq!(fork_final.summary.thinking_level, "off");
        assert_eq!(fork_final.summary.permission_mode, "ask");

        drop(db);
        let db = Database::open(&path).unwrap();
        let source_reopened = get_session(&db, &source.id).unwrap().unwrap();
        let fork_reopened = get_session(&db, &fork.summary.id).unwrap().unwrap();
        assert_eq!(source_reopened.messages.len(), 2);
        assert_eq!(fork_reopened.messages.len(), 3);
        assert_eq!(fork_reopened.messages[2].content, "continue here");

        assert!(matches!(
            fork_session_through(&db, "missing", None, None).unwrap(),
            ForkSessionResult::NotFound
        ));
        let turn = begin_turn(&db, &source.id, None, None).unwrap();
        assert!(matches!(
            fork_session_through(&db, &source.id, None, None).unwrap(),
            ForkSessionResult::Busy
        ));
        end_turn(&db, &turn, "aborted", None, None, false).unwrap();
        delete_session(&db, &source.id).unwrap();
        assert!(get_session(&db, &source.id).unwrap().is_none());
        assert_eq!(
            get_session(&db, &fork.summary.id)
                .unwrap()
                .unwrap()
                .messages
                .len(),
            3
        );
    }

    #[test]
    fn message_scoped_fork_stops_at_selected_assistant_response() {
        let db = test_db();
        let source = create_session(&db, Some("Source".into()), None, None, None, None).unwrap();
        let mut assistant_a = user_msg("assistant-a", "first response", "2025-05-01T00:00:01Z");
        assistant_a.role = "assistant".into();
        let mut assistant_b = user_msg("assistant-b", "second response", "2025-05-01T00:00:03Z");
        assistant_b.role = "assistant".into();
        for message in [
            user_msg("user-a", "first prompt", "2025-05-01T00:00:00Z"),
            assistant_a,
            user_msg("user-b", "second prompt", "2025-05-01T00:00:02Z"),
            assistant_b,
        ] {
            append_message(&db, &source.id, &message, None).unwrap();
        }

        let ForkSessionResult::Created(fork) = fork_session_through(
            &db,
            &source.id,
            Some("Response branch"),
            Some("assistant-a"),
        )
        .unwrap() else {
            panic!("expected message-scoped fork");
        };

        assert_eq!(fork.messages.len(), 2);
        assert_eq!(fork.messages[0].content, "first prompt");
        assert_eq!(fork.messages[1].content, "first response");
        assert_ne!(fork.messages[1].id, "assistant-a");
        assert_eq!(
            get_session(&db, &source.id)
                .unwrap()
                .unwrap()
                .messages
                .len(),
            4
        );
        assert!(matches!(
            fork_session_through(&db, &source.id, None, Some("missing")).unwrap(),
            ForkSessionResult::NotFound
        ));
    }

    #[test]
    fn turns_lifecycle() {
        let db = test_db();
        let session = create_session(&db, None, None, None, None, None).unwrap();
        let turn = begin_turn(&db, &session.id, Some("p1"), Some("m1")).unwrap();
        let ended = end_turn(
            &db,
            &turn,
            "completed",
            None,
            Some(&json!({ "inputTokens": 10, "outputTokens": 20 })),
            true,
        )
        .unwrap();
        assert!(ended.updated);
        assert_eq!(ended.notification.unwrap().kind, "task.completed");
        // Ending twice is a no-op.
        let duplicate = end_turn(&db, &turn, "completed", None, None, true).unwrap();
        assert!(!duplicate.updated);
        assert!(duplicate.notification.is_none());
        let (status, input, output): (String, i64, i64) = db
            .conn()
            .query_row(
                "SELECT status, input_tokens, output_tokens FROM turns WHERE id = ?1",
                params![turn],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(status, "completed");
        assert_eq!((input, output), (10, 20));
    }

    #[test]
    fn begin_turn_rejects_a_second_running_turn_with_agent_busy() {
        let db = test_db();
        let session = create_session(&db, None, None, None, None, None).unwrap();
        let first = begin_turn(&db, &session.id, None, None).unwrap();

        let error = begin_turn(&db, &session.id, None, None).unwrap_err();
        assert_eq!(error.to_string(), "AGENT_BUSY");

        end_turn(&db, &first, "aborted", None, None, false).unwrap();
        assert!(begin_turn(&db, &session.id, None, None).is_ok());
    }

    #[test]
    fn aborted_turn_does_not_create_notification() {
        let db = test_db();
        let session = create_session(&db, None, None, None, None, None).unwrap();
        let turn = begin_turn(&db, &session.id, None, None).unwrap();

        let ended = end_turn(&db, &turn, "aborted", None, None, true).unwrap();

        assert!(ended.updated);
        assert!(ended.notification.is_none());
        let notification_count: i64 = db
            .conn()
            .query_row("SELECT COUNT(*) FROM notifications", [], |row| row.get(0))
            .unwrap();
        assert_eq!(notification_count, 0);
    }

    #[test]
    fn visible_turn_does_not_create_notification() {
        let db = test_db();
        let session = create_session(&db, None, None, None, None, None).unwrap();
        let turn = begin_turn(&db, &session.id, None, None).unwrap();

        let ended = end_turn(&db, &turn, "completed", None, None, false).unwrap();

        assert!(ended.updated);
        assert!(ended.notification.is_none());
        let (status, notification_count): (String, i64) = db
            .conn()
            .query_row(
                "SELECT t.status, COUNT(n.id)
                 FROM turns t
                 LEFT JOIN notifications n ON n.turn_id = t.id
                 WHERE t.id = ?1
                 GROUP BY t.status",
                params![turn],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(status, "completed");
        assert_eq!(notification_count, 0);
    }

    #[test]
    fn search_finds_cjk_and_short_queries() {
        let db = test_db();
        let session = create_session(&db, Some("重构".into()), None, None, None, None).unwrap();
        append_message(
            &db,
            &session.id,
            &user_msg("m1", "帮我重构数据库结构", "2025-05-01T00:00:00Z"),
            None,
        )
        .unwrap();
        let hits = search_messages(&db, "数据库", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].session_id, session.id);
        // 2-char query falls back to LIKE.
        let hits = search_messages(&db, "重构", 10).unwrap();
        assert_eq!(hits.len(), 1);
        // Deleting the session clears the index (cascade + FTS trigger).
        delete_session(&db, &session.id).unwrap();
        assert!(search_messages(&db, "数据库", 10).unwrap().is_empty());
    }

    #[test]
    fn save_and_activate_message_revision() {
        let db = test_db();
        let session = create_session(&db, None, None, None, None, None).unwrap();
        let user = user_msg("u1", "hello", "2025-05-01T00:00:00Z");
        let mut a1 = user_msg("a1", "first", "2025-05-01T00:00:01Z");
        a1.role = "assistant".into();
        let mut a2 = user_msg("a2", "second", "2025-05-01T00:00:02Z");
        a2.role = "assistant".into();
        let branch1 = vec![user.clone(), a1.clone()];
        let branch2 = vec![user.clone(), a2.clone()];
        let r1 = save_message_revision(&db, &session.id, "u1", &branch1, true).unwrap();
        assert_eq!(r1.revision_index, 1);
        let r2 = save_message_revision(&db, &session.id, "u1", &branch2, true).unwrap();
        assert_eq!(r2.revision_index, 2);
        let listed = list_message_revisions(&db, &session.id, "u1").unwrap();
        assert_eq!(listed.len(), 2);
        assert!(listed.iter().any(|r| r.revision_index == 1 && !r.is_active));
        assert!(listed.iter().any(|r| r.revision_index == 2 && r.is_active));
        let activated = activate_message_revision(&db, &session.id, "u1", 1, &[]).unwrap();
        assert_eq!(activated.len(), 2);
        assert_eq!(activated[1].content, "first");
        assert_eq!(activated[0].revision_root_id.as_deref(), Some("u1"));
        assert_eq!(activated[0].active_revision, Some(1));
        assert_eq!(activated[0].revision_count, Some(2));
        let detail = get_session(&db, &session.id).unwrap().unwrap();
        assert_eq!(detail.messages[1].content, "first");
        assert_eq!(detail.messages[0].active_revision, Some(1));
        assert_eq!(detail.messages[0].revision_count, Some(2));

        // Switching forward restores the second branch and keeps the family key.
        let activated2 = activate_message_revision(&db, &session.id, "u1", 2, &[]).unwrap();
        assert_eq!(activated2[1].content, "second");
        assert_eq!(activated2[0].active_revision, Some(2));
        assert_eq!(activated2[0].revision_root_id.as_deref(), Some("u1"));
    }

    #[test]
    fn save_active_branch_revision_keeps_a_message_appended_after_its_read() {
        let db = test_db();
        let session = create_session(&db, None, None, None, None, None).unwrap();
        let turn = begin_turn(&db, &session.id, Some("p1"), Some("m1")).unwrap();
        // Regenerate archived the discarded original branch as revision 1 and
        // stamped the rewritten prompt as revision 2 of the same family.
        let mut discarded = user_msg("u1", "do it", "2025-04-30T00:00:00Z");
        let mut discarded_answer = user_msg("a1", "the discarded answer", "2025-04-30T00:00:01Z");
        discarded_answer.role = "assistant".into();
        discarded.revision_root_id = Some("u1".into());
        save_message_revision(
            &db,
            &session.id,
            "u1",
            &[discarded, discarded_answer],
            false,
        )
        .unwrap();
        let mut root = user_msg("u2", "redo it", "2025-05-01T00:00:00Z");
        root.revision_root_id = Some("u1".into());
        root.revision_count = Some(2);
        root.active_revision = Some(2);
        append_message(&db, &session.id, &root, Some(&turn)).unwrap();
        let mut tool = user_msg("t1", "ran a command", "2025-05-01T00:00:01Z");
        tool.role = "assistant".into();
        append_message(&db, &session.id, &tool, Some(&turn)).unwrap();

        // The turn's final assistant message lands while the archive is already
        // in flight — the case that used to lose it to a stale rewrite.
        let mut answer = user_msg("a9", "the finished answer", "2025-05-01T00:00:02Z");
        answer.role = "assistant".into();
        append_message(&db, &session.id, &answer, Some(&turn)).unwrap();

        let saved = save_active_branch_revision(&db, &session.id)
            .unwrap()
            .expect("a revision-bearing root is archived");
        assert!(saved.archived);
        assert_eq!(saved.root_user_id, "u1");
        assert_eq!(saved.active_revision, 2);

        // Nothing was dropped, and the pager stamp landed on the root.
        let detail = get_session(&db, &session.id).unwrap().unwrap();
        assert_eq!(
            detail
                .messages
                .iter()
                .map(|m| m.id.as_str())
                .collect::<Vec<_>>(),
            vec!["u2", "t1", "a9"],
        );
        assert_eq!(detail.messages[0].revision_count, Some(2));
        assert_eq!(detail.messages[0].active_revision, Some(2));
        assert_eq!(detail.messages[0].revision_root_id.as_deref(), Some("u1"));

        // The archived branch carries the final answer, so switching back to it
        // later restores a complete turn.
        let branch = transcripts::read_revision(db.data_dir(), &session.id, "u1", 2)
            .unwrap()
            .expect("branch payload");
        assert_eq!(branch.messages.last().unwrap().id, "a9");

        // A one-line stamp must not reseat the index: seq order and the owning
        // turn stay intact.
        let rows: Vec<(String, i64, Option<String>)> = {
            let conn = db.conn();
            let mut stmt = conn
                .prepare("SELECT id, seq, turn_id FROM messages WHERE session_id = ?1 ORDER BY seq")
                .unwrap();
            let mapped = stmt
                .query_map(params![session.id], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?))
                })
                .unwrap();
            mapped.map(|row| row.unwrap()).collect()
        };
        assert_eq!(
            rows,
            vec![
                ("u2".to_string(), 0, Some(turn.clone())),
                ("t1".to_string(), 1, Some(turn.clone())),
                ("a9".to_string(), 2, Some(turn.clone())),
            ],
        );
    }

    #[test]
    fn save_active_branch_revision_is_none_without_regenerate_history() {
        let db = test_db();
        let session = create_session(&db, None, None, None, None, None).unwrap();
        append_message(
            &db,
            &session.id,
            &user_msg("u1", "hello", "2025-05-01T00:00:00Z"),
            None,
        )
        .unwrap();
        assert!(save_active_branch_revision(&db, &session.id)
            .unwrap()
            .is_none());
        assert!(list_message_revisions(&db, &session.id, "u1")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn save_active_branch_revision_restamps_an_already_archived_branch() {
        let db = test_db();
        let session = create_session(&db, None, None, None, None, None).unwrap();
        let mut root = user_msg("u1", "hello", "2025-05-01T00:00:00Z");
        root.revision_count = Some(1);
        root.active_revision = Some(1);
        append_message(&db, &session.id, &root, None).unwrap();
        save_message_revision(&db, &session.id, "u1", &[root.clone()], true).unwrap();

        let saved = save_active_branch_revision(&db, &session.id)
            .unwrap()
            .unwrap();
        assert!(!saved.archived, "revision 1 is already on disk");
        assert_eq!(saved.revision_count, 1);
        assert_eq!(
            list_message_revisions(&db, &session.id, "u1")
                .unwrap()
                .len(),
            1,
        );
    }

    #[test]
    fn replace_messages_preserves_owning_turn_ids() {
        let db = test_db();
        let session = create_session(&db, None, None, None, None, None).unwrap();
        let turn = begin_turn(&db, &session.id, Some("p1"), Some("m1")).unwrap();
        let kept = user_msg("a", "one", "2025-05-01T00:00:00Z");
        append_message(&db, &session.id, &kept, Some(&turn)).unwrap();
        append_message(
            &db,
            &session.id,
            &user_msg("b", "two", "2025-05-01T00:00:01Z"),
            Some(&turn),
        )
        .unwrap();

        replace_messages(&db, &session.id, &[kept]).unwrap();
        let owning: Option<String> = db
            .conn()
            .query_row(
                "SELECT turn_id FROM messages WHERE session_id = ?1 AND id = 'a'",
                params![session.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(owning.as_deref(), Some(turn.as_str()));
    }
}
