use super::{preview_value, truncate_display_text};
use serde_json::{Map, Value};

// A report must not consume the identity/status budget. These caps apply only
// to the additional display metadata, never to the canonical transcript.
const MAX_METADATA_BYTES: usize = 64 * 1024;
const MAX_METADATA_VALUE_CHARS: usize = 256;
const MAX_ID_BYTES: usize = 256;
const MAX_ROSTER_ENTRIES: usize = 256;

fn is_delegation_tool(name: Option<&str>) -> bool {
    let bare = name
        .unwrap_or_default()
        .rsplit('.')
        .next()
        .unwrap_or_default();
    ["Task", "Subagent", "TaskWait", "TaskList", "TaskStop"]
        .iter()
        .any(|expected| bare.eq_ignore_ascii_case(expected))
}

fn identity(value: &Value) -> Value {
    match value.as_str() {
        Some(id) if !id.is_empty() && id.len() <= MAX_ID_BYTES => Value::String(id.into()),
        // A clipped handle must never become an actionable, different id.
        _ => Value::Null,
    }
}

fn label(value: &Value) -> Value {
    match value.as_str() {
        Some(text) => {
            // Copy only a bounded prefix, not a potentially huge source string.
            let prefix = text.chars().take(MAX_METADATA_VALUE_CHARS + 1).collect();
            Value::String(truncate_display_text(prefix, MAX_METADATA_VALUE_CHARS).0)
        }
        _ => Value::Null,
    }
}

fn summary_metadata(source: &Value) -> Map<String, Value> {
    let mut metadata = Map::new();
    for key in ["delegationId", "resumedFrom"] {
        if let Some(value) = source.get(key) {
            metadata.insert(key.into(), identity(value));
        }
    }
    for key in [
        "agent",
        "modelId",
        "thinkingLevel",
        "modelChangedFrom",
        "lastToolName",
    ] {
        if let Some(value) = source.get(key) {
            metadata.insert(key.into(), label(value));
        }
    }
    if let Some(value) = source.get("status") {
        let status = value.as_str().filter(|text| text.len() <= 32);
        metadata.insert(
            "status".into(),
            status.map_or(Value::Null, |text| Value::String(text.into())),
        );
    }
    for key in [
        "startedAt",
        "completedAt",
        "turns",
        "toolCalls",
        "contextCompactions",
        "contextDegraded",
    ] {
        if let Some(value) = source
            .get(key)
            .filter(|value| value.is_number() || value.is_boolean())
        {
            metadata.insert(key.into(), value.clone());
        }
    }
    metadata
}

fn metadata_budget(metadata: &Map<String, Value>) -> usize {
    // Reserve the fixed wrapper, array keys, and explicit truncation flag.
    MAX_METADATA_BYTES.saturating_sub(256 + Value::Object(metadata.clone()).to_string().len())
}

fn bounded_items(
    items: &[Value],
    budget: &mut usize,
    project: impl Fn(&Value) -> Value,
) -> (Value, bool) {
    let mut output = Vec::with_capacity(items.len().min(MAX_ROSTER_ENTRIES));
    for item in items.iter().take(MAX_ROSTER_ENTRIES) {
        let projected = project(item);
        let bytes = projected.to_string().len() + 1;
        if bytes > *budget {
            break;
        }
        *budget -= bytes;
        output.push(projected);
    }
    let truncated = output.len() < items.len();
    (Value::Array(output), truncated)
}

fn args_metadata(args: &Value) -> Value {
    let mut metadata = Map::new();
    for key in ["agent", "model"] {
        if let Some(value) = args.get(key) {
            metadata.insert(key.into(), label(value));
        }
    }
    if let Some(value) = args.get("resume") {
        metadata.insert("resume".into(), identity(value));
    }
    if let Some(ids) = args.get("delegationIds").and_then(Value::as_array) {
        let (ids, truncated) = bounded_items(ids, &mut metadata_budget(&metadata), identity);
        metadata.insert("delegationIds".into(), ids);
        if truncated {
            metadata.insert("_truncated".into(), Value::Bool(true));
        }
    }
    Value::Object(metadata)
}

fn result_metadata(result: &Value) -> Value {
    let wrapped = result.get("details").is_some_and(Value::is_object);
    let source = if wrapped { &result["details"] } else { result };
    let mut metadata = summary_metadata(source);
    let mut budget = metadata_budget(&metadata);
    let mut truncated = false;
    for key in [
        "delegations",
        "stopped",
        "stopPending",
        "settled",
        "resumable",
    ] {
        if let Some(items) = source.get(key).and_then(Value::as_array) {
            let (items, clipped) = bounded_items(items, &mut budget, |item| {
                Value::Object(summary_metadata(item))
            });
            metadata.insert(key.into(), items);
            truncated |= clipped;
        }
    }
    if truncated {
        metadata.insert("_truncated".into(), Value::Bool(true));
    }
    if wrapped {
        let mut wrapper = Map::new();
        wrapper.insert("details".into(), Value::Object(metadata));
        Value::Object(wrapper)
    } else {
        Value::Object(metadata)
    }
}

fn overlay_metadata(preview: &mut Value, metadata: Value) {
    match metadata {
        Value::Object(fields) => {
            if fields.is_empty() {
                return;
            }
            if !preview.is_object() {
                *preview = Value::Object(Map::new());
            }
            if let Some(target) = preview.as_object_mut() {
                for (key, value) in fields {
                    overlay_metadata(target.entry(key).or_insert(Value::Null), value);
                }
            }
        }
        Value::Array(items) => {
            if !preview.is_array() {
                *preview = Value::Array(Vec::new());
            }
            if let Some(target) = preview.as_array_mut() {
                for (index, item) in items.into_iter().enumerate() {
                    if index == target.len() {
                        target.push(Value::Null);
                    }
                    overlay_metadata(&mut target[index], item);
                }
            }
        }
        value => *preview = value,
    }
}

pub(super) fn preview_args(name: Option<&str>, args: Value, limit: usize) -> Value {
    if !is_delegation_tool(name) {
        return preview_value(args, limit);
    }
    let metadata = args_metadata(&args);
    let mut preview = preview_value(args, limit);
    overlay_metadata(&mut preview, metadata);
    preview
}

pub(super) fn preview_result(name: Option<&str>, result: Value, limit: usize) -> Value {
    if !is_delegation_tool(name) {
        return preview_value(result, limit);
    }
    let metadata = result_metadata(&result);
    let mut preview = preview_value(result, limit);
    overlay_metadata(&mut preview, metadata);
    preview
}

#[cfg(test)]
mod tests {
    use crate::sessions::{
        append_message, create_session, get_session, get_session_with_options, record_to_ui,
        record_to_ui_for_display, SessionReadOptions,
    };
    use crate::transcripts::MessageRecord;
    use serde_json::{json, Value};

    fn tool(name: &str, args: Value, result: Value) -> MessageRecord {
        MessageRecord {
            id: format!("fixture-{name}"),
            role: "tool".into(),
            tool_name: Some(name.into()),
            is_error: false,
            blocks: json!([{
                "type": "tool_call", "name": name, "callId": format!("call-{name}"),
                "status": "success", "args": args, "result": result,
            }]),
            meta: None,
            created_at: "2026-11-02T00:00:00Z".into(),
        }
    }

    fn task() -> MessageRecord {
        tool(
            "Task",
            json!({
                "agent": "explorer", "description": "long description ".repeat(200),
                "resume": "a35c0440-7d46-45ac-964e-faa8a9b2680c", "task": "long brief ".repeat(200),
            }),
            json!({
                "content": [{"type": "text", "text": "Delegation report ".repeat(1000)}],
                "details": {
                    "agent": "explorer", "delegationId": "c5e4e081-dd49-45e5-a5fd-45cb73e5c22e",
                    "error": {"message": "Provider error ".repeat(1000)},
                    "modelId": "fixture/model", "modelFailures": [{"error": "failure ".repeat(1000)}],
                    "status": "failed",
                },
            }),
        )
    }

    #[test]
    fn bounded_task_display_retains_identity_resume_and_status() {
        let message = record_to_ui_for_display(task(), 512);
        let result = message.tool_result.unwrap();
        assert_eq!(
            result["details"]["delegationId"],
            "c5e4e081-dd49-45e5-a5fd-45cb73e5c22e"
        );
        assert_eq!(result["details"]["status"], "failed");
        assert_eq!(result["details"]["modelId"], "fixture/model");
        let args = message.tool_args.unwrap();
        assert_eq!(args["resume"], "a35c0440-7d46-45ac-964e-faa8a9b2680c");
        assert_eq!(args["agent"], "explorer");
        assert!(args["description"].as_str().unwrap().chars().count() <= 512);
        assert!(serde_json::to_string(&result).unwrap().len() < 8_000);
    }

    #[test]
    fn bounded_lifecycle_display_keeps_status_roster_after_large_reports() {
        for (name, roster) in [
            ("TaskWait", "delegations"),
            ("functions.TaskList", "delegations"),
            ("TaskStop", "stopped"),
        ] {
            let message = record_to_ui_for_display(
                tool(
                    name,
                    json!({}),
                    json!({
                        "content": [{"type": "text", "text": "report ".repeat(1000)}],
                        "details": {roster: [{
                            "agent": "tester", "delegationId": "owned-delegate",
                            "error": {"message": "error ".repeat(1000)}, "status": "stopped",
                        }]},
                    }),
                ),
                512,
            );
            let result = message.tool_result.unwrap();
            assert_eq!(
                result["details"][roster][0]["delegationId"],
                "owned-delegate"
            );
            assert_eq!(result["details"][roster][0]["status"], "stopped");
            assert!(serde_json::to_string(&result).unwrap().len() < 8_000);
        }
    }

    #[test]
    fn bounded_session_read_keeps_metadata_without_rewriting_canonical_history() {
        let root = std::env::var_os("PI_SCRATCH_DIR")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        let dir = tempfile::tempdir_in(root).unwrap();
        let db = crate::db::Database::open(&dir.path().join("fixture.sqlite")).unwrap();
        let session = create_session(&db, None, None, None, None, None).unwrap();
        let original = record_to_ui(task());
        append_message(&db, &session.id, &original, None).unwrap();
        let page = get_session_with_options(
            &db,
            &session.id,
            SessionReadOptions {
                message_limit: Some(256),
                content_limit: Some(512),
                ..Default::default()
            },
        )
        .unwrap()
        .unwrap();
        assert_eq!(page.message_start, Some(0));
        assert_eq!(page.message_end, Some(1));
        assert_eq!(
            page.messages[0].tool_result.as_ref().unwrap()["details"]["status"],
            "failed"
        );
        assert_eq!(
            page.messages[0].tool_args.as_ref().unwrap()["resume"],
            "a35c0440-7d46-45ac-964e-faa8a9b2680c"
        );
        let full = get_session(&db, &session.id).unwrap().unwrap();
        assert_eq!(full.messages[0].tool_args, original.tool_args);
        assert_eq!(full.messages[0].tool_result, original.tool_result);
    }

    #[test]
    fn non_delegation_tools_keep_the_generic_preview_contract() {
        let value = json!({"content": "body ".repeat(1000), "details": {
            "delegationId": "not-a-subagent", "status": "failed",
        }});
        for name in [None, Some("Read"), Some("CreateTask"), Some("TaskRead")] {
            assert_eq!(
                super::preview_args(name, value.clone(), 512),
                super::preview_value(value.clone(), 512)
            );
            assert_eq!(
                super::preview_result(name, value.clone(), 512),
                super::preview_value(value.clone(), 512)
            );
        }
    }

    #[test]
    fn short_payloads_keep_their_existing_body_and_error_details() {
        let args = json!({"agent": "tester", "description": "Inspect", "resume": "prior", "task": "Continue"});
        let result = json!({"content": [{"type": "text", "text": "Report"}], "details": {
            "delegations": [{"delegationId": "owned", "agent": "tester", "status": "failed",
                "error": {"code": "FIXTURE_ERROR", "message": "fixture failure"}, "report": "Summary"}],
        }});
        let message = record_to_ui_for_display(tool("TaskWait", args.clone(), result.clone()), 512);
        assert_eq!(message.tool_args, Some(args));
        assert_eq!(message.tool_result, Some(result));
    }

    #[test]
    fn legacy_and_namespaced_task_results_keep_terminal_states() {
        for name in ["Task", "functions.Task", "Subagent", "functions.task"] {
            for status in ["failed", "stopped", "timed_out"] {
                let message = record_to_ui_for_display(
                    tool(
                        name,
                        json!({"agent": "tester"}),
                        json!({
                            "content": "report ".repeat(1000), "delegationId": "owned",
                            "error": {"message": "error ".repeat(1000)}, "status": status,
                        }),
                    ),
                    512,
                );
                let result = message.tool_result.unwrap();
                assert_eq!(result["delegationId"], "owned");
                assert_eq!(result["status"], status);
            }
        }
    }

    #[test]
    fn oversized_handles_are_not_clipped_into_actionable_ids() {
        let message = record_to_ui_for_display(
            tool(
                "Task",
                json!({
                    "resume": "x".repeat(super::MAX_ID_BYTES + 1),
                }),
                json!({"details": {
                    "delegationId": "x".repeat(super::MAX_ID_BYTES + 1), "status": "running",
                }}),
            ),
            512,
        );
        assert!(message.tool_args.unwrap()["resume"].is_null());
        assert!(message.tool_result.unwrap()["details"]["delegationId"].is_null());
    }

    #[test]
    fn metadata_rosters_and_labels_have_independent_finite_budgets() {
        let entries: Vec<Value> = (0..300).map(|index| json!({
            "delegationId": format!("owned-{index}"), "status": "failed",
            "agent": "large label ".repeat(1000), "modelId": "large model ".repeat(1000),
            "error": {"message": "large error ".repeat(1000)}, "report": "report ".repeat(1000),
        })).collect();
        let value = json!({"content": "body ".repeat(1000), "details": {
            "delegations": entries, "stopped": entries, "settled": entries,
        }});
        let metadata = super::result_metadata(&value);
        assert!(metadata.to_string().len() <= super::MAX_METADATA_BYTES);
        assert_eq!(metadata["details"]["_truncated"], true);
        for key in ["delegations", "stopped", "settled"] {
            let entries = metadata["details"][key].as_array().unwrap();
            assert!(entries.len() <= super::MAX_ROSTER_ENTRIES);
            for (index, entry) in entries.iter().enumerate() {
                assert_eq!(entry["delegationId"], format!("owned-{index}"));
                assert_eq!(entry["status"], "failed");
                assert!(
                    entry["agent"].as_str().unwrap().chars().count()
                        <= super::MAX_METADATA_VALUE_CHARS
                );
            }
        }
        let projected = super::preview_result(Some("TaskList"), value, 512);
        assert!(projected.to_string().len() < super::MAX_METADATA_BYTES + 8_000);
    }

    #[test]
    fn both_display_conversion_stages_keep_the_same_metadata() {
        let original = record_to_ui(task());
        let args = super::preview_args(Some("Task"), original.tool_args.unwrap(), 512);
        let result = super::preview_result(Some("Task"), original.tool_result.unwrap(), 512);
        assert_eq!(super::preview_args(Some("Task"), args.clone(), 512), args);
        assert_eq!(
            super::preview_result(Some("Task"), result.clone(), 512),
            result
        );
    }
}
