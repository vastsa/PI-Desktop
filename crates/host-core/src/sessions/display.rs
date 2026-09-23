use serde_json::{Map, Value};

use super::{record_to_ui, UiMessage};
use crate::transcripts::MessageRecord;

const DISPLAY_TRUNCATION_MARKER: &str =
    "\n\n[truncated for display; the full content remains in the transcript]";
// Shell capture can include the union of 2,000 before and 2,000 after paths.
const MAX_REVIEW_RECORDS: usize = 4_000;
const MAX_REVIEW_METADATA_BYTES: usize = 1024 * 1024;
const MAX_REVIEW_ID_BYTES: usize = 256;
// Covers Windows' maximum extended path in UTF-8, within the aggregate budget.
const MAX_REVIEW_PATH_BYTES: usize = 128 * 1024;
const MAX_HUNK_HEADER_BYTES: usize = 1024;
const MAX_PROJECTED_HUNKS: usize = 1_000;
const MAX_PROJECTED_HUNK_LINES: usize = 4_000;
const DISPLAY_TRUNCATED: &str = "[truncated for display]";

fn truncate_display_text(text: String, limit: usize) -> (String, bool) {
    if text.chars().nth(limit).is_none() {
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
            return Value::String(DISPLAY_TRUNCATED.into());
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
                        output.push(Value::String(DISPLAY_TRUNCATED.into()));
                        break;
                    }
                    output.push(walk(item, budget));
                }
                Value::Array(output)
            }
            Value::Object(object) => {
                let mut output = Map::new();
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

struct ReviewProjectionBudget {
    metadata_bytes: usize,
    hunk_chars: usize,
    hunks: usize,
    hunk_lines: usize,
}

impl ReviewProjectionBudget {
    fn new(display_limit: usize) -> Self {
        Self {
            metadata_bytes: MAX_REVIEW_METADATA_BYTES,
            hunk_chars: display_limit.max(1),
            hunks: MAX_PROJECTED_HUNKS,
            hunk_lines: MAX_PROJECTED_HUNK_LINES,
        }
    }
}
fn truncate_display_str(text: &str, limit: usize) -> (String, bool) {
    if text.chars().nth(limit).is_none() {
        return (text.to_string(), false);
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

fn bounded_non_empty_string(value: Option<&Value>, max_bytes: usize) -> Option<&str> {
    let value = value?.as_str()?;
    (value.len() <= max_bytes && !value.trim().is_empty()).then_some(value)
}

fn known_string<'a>(value: Option<&'a Value>, allowed: &[&str]) -> Option<&'a str> {
    let value = value?.as_str()?;
    allowed.contains(&value).then_some(value)
}

fn project_hunks(value: Option<&Value>, budget: &mut ReviewProjectionBudget) -> (Vec<Value>, bool) {
    let Some(hunks) = value.and_then(Value::as_array) else {
        return (Vec::new(), true);
    };
    let mut output = Vec::new();
    let mut clipped = false;

    for hunk in hunks {
        if budget.hunks == 0 || budget.hunk_chars == 0 {
            clipped = true;
            break;
        }
        let Some(hunk) = hunk.as_object() else {
            clipped = true;
            continue;
        };
        let Some(header) = bounded_non_empty_string(hunk.get("header"), MAX_HUNK_HEADER_BYTES)
        else {
            clipped = true;
            continue;
        };
        let header_chars = header.chars().count();
        if header_chars > budget.hunk_chars {
            clipped = true;
            break;
        }
        let Some(lines) = hunk.get("lines").and_then(Value::as_array) else {
            clipped = true;
            continue;
        };

        budget.hunks -= 1;
        budget.hunk_chars -= header_chars;
        let mut projected_lines = Vec::new();
        for line in lines {
            if budget.hunk_lines == 0 || budget.hunk_chars == 0 {
                clipped = true;
                break;
            }
            let Some(line) = line.as_object() else {
                clipped = true;
                continue;
            };
            let Some(line_type) = known_string(line.get("type"), &["add", "del", "context"]) else {
                clipped = true;
                continue;
            };
            let Some(text) = line.get("text").and_then(Value::as_str) else {
                clipped = true;
                continue;
            };
            let (text, text_clipped) = truncate_display_str(text, budget.hunk_chars);
            budget.hunk_chars = budget.hunk_chars.saturating_sub(text.chars().count());
            budget.hunk_lines -= 1;
            clipped |= text_clipped;
            projected_lines.push(Value::Object(Map::from_iter([
                ("type".into(), Value::String(line_type.into())),
                ("text".into(), Value::String(text)),
            ])));
            if text_clipped {
                break;
            }
        }
        output.push(Value::Object(Map::from_iter([
            ("header".into(), Value::String(header.into())),
            ("lines".into(), Value::Array(projected_lines)),
        ])));
    }

    (output, clipped)
}

fn project_review(value: &Value, budget: &mut ReviewProjectionBudget) -> Option<Value> {
    let review = value.as_object()?;
    if review.get("version").and_then(Value::as_u64) != Some(1) {
        return None;
    }
    let snapshot_id = bounded_non_empty_string(review.get("snapshotId"), MAX_REVIEW_ID_BYTES)?;
    let message_id = bounded_non_empty_string(review.get("messageId"), MAX_REVIEW_ID_BYTES)?;
    let path = bounded_non_empty_string(review.get("path"), MAX_REVIEW_PATH_BYTES)?;
    let operation = known_string(review.get("operation"), &["write", "edit", "delete"])?;
    let status = known_string(review.get("status"), &["added", "modified", "deleted"])?;
    let state = known_string(review.get("state"), &["active", "rolledBack"])?;
    let additions = review.get("additions").and_then(Value::as_u64)?;
    let deletions = review.get("deletions").and_then(Value::as_u64)?;
    let reversible = review.get("reversible").and_then(Value::as_bool)?;
    let metadata_bytes = snapshot_id
        .len()
        .saturating_add(message_id.len())
        .saturating_add(path.len());
    if metadata_bytes > budget.metadata_bytes {
        return None;
    }
    budget.metadata_bytes -= metadata_bytes;

    let (hunks, hunks_clipped) = project_hunks(review.get("hunks"), budget);
    let mut output = Map::from_iter([
        ("version".into(), Value::from(1)),
        ("snapshotId".into(), Value::String(snapshot_id.into())),
        ("messageId".into(), Value::String(message_id.into())),
        ("path".into(), Value::String(path.into())),
        ("operation".into(), Value::String(operation.into())),
        ("status".into(), Value::String(status.into())),
        ("state".into(), Value::String(state.into())),
        ("additions".into(), Value::from(additions)),
        ("deletions".into(), Value::from(deletions)),
        ("hunks".into(), Value::Array(hunks)),
        ("reversible".into(), Value::Bool(reversible)),
    ]);
    if review.get("binary").and_then(Value::as_bool) == Some(true) {
        output.insert("binary".into(), Value::Bool(true));
    }
    if hunks_clipped || review.get("truncated").and_then(Value::as_bool) == Some(true) {
        output.insert("truncated".into(), Value::Bool(true));
    }
    Some(Value::Object(output))
}

fn has_review_metadata(result: &Value) -> bool {
    result
        .get("details")
        .and_then(Value::as_object)
        .is_some_and(|details| {
            details.get("root").and_then(Value::as_str) == Some("workspace")
                && ["reviewCapture", "review", "reviews"]
                    .iter()
                    .any(|key| details.contains_key(*key))
        })
}

fn project_review_details(result: &Value, limit: usize) -> Option<Map<String, Value>> {
    let details = result.get("details")?.as_object()?;
    if !has_review_metadata(result) {
        return None;
    }

    let mut output = Map::new();
    if details.get("root").and_then(Value::as_str) == Some("workspace") {
        output.insert("root".into(), Value::String("workspace".into()));
    }
    if let Some(status) = details
        .get("reviewCapture")
        .and_then(Value::as_object)
        .and_then(|capture| {
            known_string(
                capture.get("status"),
                &["complete", "partial", "unavailable"],
            )
        })
    {
        output.insert(
            "reviewCapture".into(),
            Value::Object(Map::from_iter([(
                "status".into(),
                Value::String(status.into()),
            )])),
        );
    }

    let mut budget = ReviewProjectionBudget::new(limit);
    if let Some(review) = details
        .get("review")
        .and_then(|review| project_review(review, &mut budget))
    {
        output.insert("review".into(), review);
    }
    if let Some(reviews) = details.get("reviews").and_then(Value::as_array) {
        let projected = reviews
            .iter()
            .take(MAX_REVIEW_RECORDS)
            .filter_map(|review| project_review(review, &mut budget))
            .collect();
        output.insert("reviews".into(), Value::Array(projected));
    }
    Some(output)
}

fn preview_tool_result(value: Value, limit: usize) -> Value {
    let review_details = project_review_details(&value, limit);
    let mut output = preview_value(value, limit);
    let (Some(review_details), Some(result)) = (review_details, output.as_object_mut()) else {
        return output;
    };

    let details = result
        .entry("details")
        .or_insert_with(|| Value::Object(Map::new()));
    if !details.is_object() {
        *details = Value::Object(Map::new());
    }
    if let Some(details) = details.as_object_mut() {
        for key in ["root", "reviewCapture", "review", "reviews"] {
            details.remove(key);
        }
        details.extend(review_details);
    }
    output
}
fn finish_tool_result_preview(value: Value, limit: usize) -> Value {
    if has_review_metadata(&value) {
        value
    } else {
        preview_value(value, limit)
    }
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

fn is_native_review_tool(name: Option<&str>) -> bool {
    matches!(name, Some("Write" | "Edit" | "Bash"))
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
                let preserve_reviews =
                    is_native_review_tool(object.get("name").and_then(Value::as_str));
                if let Some(value) = object.get_mut("args") {
                    *value = preview_value(std::mem::take(value), limit);
                }
                if let Some(value) = object.get_mut("result") {
                    let original = std::mem::take(value);
                    *value = if preserve_reviews {
                        preview_tool_result(original, limit)
                    } else {
                        preview_value(original, limit)
                    };
                }
                if let Some(text) = object.get_mut("text") {
                    cap_record_block_value(text, &mut text_budget);
                }
            }
            _ => {}
        }
    }
}

pub(super) fn record_to_ui_for_display(mut record: MessageRecord, limit: usize) -> UiMessage {
    // Bound canonical values before record_to_ui clones the selected tool block.
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
        message.tool_result = Some(if is_native_review_tool(message.tool_name.as_deref()) {
            finish_tool_result_preview(result, limit)
        } else {
            preview_value(result, limit)
        });
    }
    if let Some(error) = message.error.take() {
        message.error = Some(preview_value(error, limit));
    }
    message
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn valid_review(index: usize, hunk_text: &str) -> Value {
        json!({
            "version": 1,
            "snapshotId": format!("snapshot-{index}"),
            "messageId": "tool-message",
            "path": format!("src/file-{index}.txt"),
            "operation": "edit",
            "status": "modified",
            "state": if index.is_multiple_of(2) { "active" } else { "rolledBack" },
            "additions": index + 1,
            "deletions": index,
            "hunks": [{
                "header": "@@ -1,1 +1,1 @@",
                "lines": [{ "type": "add", "text": hunk_text }]
            }],
            "binary": index == 7,
            "reversible": index.is_multiple_of(2),
        })
    }

    #[test]
    fn review_projection_preserves_legacy_record_and_clips_hunks() {
        let result = preview_tool_result(
            json!({
                "content": [{ "type": "text", "text": "x".repeat(10_000) }],
                "details": {
                    "root": "workspace",
                    "review": valid_review(7, &"line".repeat(1_000)),
                    "reviewCapture": { "status": "complete", "unknown": "ignored" }
                }
            }),
            256,
        );
        let details = &result["details"];
        assert_eq!(details["root"], "workspace");
        assert_eq!(details["reviewCapture"], json!({ "status": "complete" }));
        assert_eq!(details["review"]["snapshotId"], "snapshot-7");
        assert_eq!(details["review"]["state"], "rolledBack");
        assert_eq!(details["review"]["binary"], true);
        assert_eq!(details["review"]["truncated"], true);
        assert!(details["review"].get("unknown").is_none());
        let lines = details["review"]["hunks"][0]["lines"].as_array().unwrap();
        assert_eq!(lines[0]["type"], "add");
        assert!(lines[0]["text"]
            .as_str()
            .unwrap()
            .contains("truncated for display"));
    }

    #[test]
    fn review_projection_keeps_native_union_plural_identities() {
        let reviews = (0..MAX_REVIEW_RECORDS)
            .map(|index| valid_review(index, ""))
            .collect::<Vec<_>>();
        let result = preview_tool_result(
            json!({
                "content": [{ "type": "text", "text": "x".repeat(80_000) }],
                "details": {
                    "root": "workspace",
                    "reviewCapture": { "status": "partial" },
                    "reviews": reviews
                }
            }),
            64 * 1024,
        );
        let reviews = result["details"]["reviews"].as_array().unwrap();
        assert_eq!(reviews.len(), MAX_REVIEW_RECORDS);
        assert_eq!(reviews[0]["snapshotId"], "snapshot-0");
        let last = MAX_REVIEW_RECORDS - 1;
        assert_eq!(reviews[last]["snapshotId"], format!("snapshot-{last}"));
        assert_eq!(reviews[last]["state"], "rolledBack");
        assert_eq!(reviews[last]["path"], format!("src/file-{last}.txt"));
    }

    #[test]
    fn review_projection_drops_malformed_and_oversized_records() {
        let oversized_id = "x".repeat(MAX_REVIEW_ID_BYTES + 1);
        let mut missing_reversible = valid_review(2, "ok");
        missing_reversible
            .as_object_mut()
            .unwrap()
            .remove("reversible");
        let mut valid = valid_review(3, "ok");
        valid["unknown"] = Value::String("z".repeat(100_000));
        let result = preview_tool_result(
            json!({
                "details": {
                    "root": "workspace",
                    "reviews": [
                        { "version": 1, "snapshotId": oversized_id },
                        { "version": 2, "snapshotId": "future" },
                        missing_reversible,
                        "not-an-object",
                        valid
                    ],
                    "unknown": "u".repeat(100_000)
                }
            }),
            128,
        );
        let reviews = result["details"]["reviews"].as_array().unwrap();
        assert_eq!(reviews.len(), 1);
        assert_eq!(reviews[0]["snapshotId"], "snapshot-3");
        assert!(serde_json::to_vec(&result).unwrap().len() < 8 * 1024);
    }

    #[test]
    fn unrelated_values_keep_original_double_preview_semantics() {
        let value = json!({ "alpha": "x".repeat(1_000), "omega": "kept only with budget" });
        let first = preview_tool_result(value.clone(), 64);
        assert_eq!(
            finish_tool_result_preview(first, 64),
            preview_value(preview_value(value, 64), 64)
        );
    }

    #[test]
    fn non_workspace_results_keep_original_preview_semantics() {
        for root in ["scratch", "external"] {
            let value = json!({ "details": {
                "root": root,
                "review": valid_review(0, "small"),
                "reviewCapture": { "status": "unavailable" }
            }});
            let first = preview_tool_result(value.clone(), 4096);
            assert_eq!(first["details"]["root"], root);
            assert_eq!(
                finish_tool_result_preview(first, 4096),
                preview_value(preview_value(value, 4096), 4096)
            );
        }
    }

    #[test]
    fn malformed_hunks_are_explicitly_truncated() {
        for hunks in [None, Some(json!("damaged"))] {
            let mut review = valid_review(0, "small");
            match hunks {
                Some(value) => {
                    review["hunks"] = value;
                }
                None => {
                    review.as_object_mut().unwrap().remove("hunks");
                }
            }
            let result = preview_tool_result(
                json!({ "details": {
                    "root": "workspace", "review": review
                }}),
                1024,
            );
            assert_eq!(result["details"]["review"]["hunks"], json!([]));
            assert_eq!(result["details"]["review"]["truncated"], true);
        }
    }

    #[test]
    fn long_native_paths_keep_their_review_identity() {
        let path = format!("{}file.txt", "long-directory/".repeat(600));
        let mut review = valid_review(0, "small");
        review["path"] = Value::String(path.clone());
        let result = preview_tool_result(
            json!({ "details": {
                "root": "workspace", "review": review
            }}),
            256,
        );
        assert_eq!(result["details"]["review"]["path"], path);
        assert_eq!(result["details"]["review"]["snapshotId"], "snapshot-0");
    }

    #[test]
    fn unrelated_tool_review_fields_keep_generic_projection() {
        for tool_name in ["Read", "mcp_example", "plugin_example"] {
            let result = json!({ "content": "x".repeat(10_000), "details": {
                "root": "workspace", "review": valid_review(0, "small")
            }});
            let message: UiMessage = serde_json::from_value(json!({
                "id": "unrelated-tool", "role": "tool", "content": "",
                "createdAt": "2026-09-20T00:00:00Z", "toolName": tool_name,
                "toolResult": result.clone()
            }))
            .unwrap();
            let (record, _) = crate::sessions::ui_to_record(&message);
            let projected = record_to_ui_for_display(record, 256);
            assert_eq!(
                projected.tool_result,
                Some(preview_value(preview_value(result, 256), 256))
            );
        }
    }
}
