use super::*;
use serde_json::json;

fn screenshot() -> MessageRecord {
    let image = json!({"type":"image", "data":"YWJjLw==", "mimeType":"image/png"});
    let result = json!({"content":[image.clone()], "details":{"content":[image]}});
    MessageRecord {
        id: "screenshot-call".into(),
        role: "tool".into(),
        tool_name: Some("Snapshot".into()),
        is_error: false,
        blocks: json!([{"type":"tool_call", "callId":"opaque-id", "result":result,
            "text":serde_json::to_string_pretty(&result).unwrap()}]),
        meta: None,
        created_at: "2026-10-24T19:00:00Z".into(),
    }
}

#[test]
fn screenshot_binary_occurs_once_on_disk_and_round_trips_exactly() {
    let dir = tempfile::tempdir().unwrap();
    let record = screenshot();
    append_message(dir.path(), "s", &record.created_at, &record).unwrap();
    let raw = fs::read_to_string(transcript_path(dir.path(), "s").unwrap()).unwrap();
    assert_eq!(
        raw.matches("YWJjLw==").count(),
        1,
        "fourfold tool-result persistence"
    );
    let restored = read_transcript(dir.path(), "s").unwrap();
    assert_eq!(
        serde_json::to_value(&restored[0]).unwrap(),
        serde_json::to_value(&record).unwrap()
    );
}

#[test]
fn legacy_plain_messages_stay_readable_without_rewriting_on_read() {
    let dir = tempfile::tempdir().unwrap();
    let path = transcript_path(dir.path(), "s").unwrap();
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let record = screenshot();
    let mut value = serde_json::to_value(&record).unwrap();
    value["type"] = json!("message");
    let raw = format!("{{\"type\":\"session\",\"schema\":1,\"sessionId\":\"s\",\"createdAt\":\"old\"}}\n{value}\n");
    fs::write(&path, &raw).unwrap();
    assert_eq!(
        read_transcript(dir.path(), "s").unwrap()[0].blocks,
        record.blocks
    );
    assert_eq!(fs::read_to_string(path).unwrap(), raw);
}

#[test]
fn unknown_binary_storage_is_an_error_instead_of_an_empty_history() {
    let dir = tempfile::tempdir().unwrap();
    let path = transcript_path(dir.path(), "s").unwrap();
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let mut value = serde_json::to_value(screenshot()).unwrap();
    value["type"] = json!("message");
    value["binaryStorage"] = json!({"version":999, "data":[], "refs":[], "texts":[]});
    fs::write(path, format!("{value}\n")).unwrap();
    assert!(read_transcript(dir.path(), "s").is_err());
}

#[test]
fn first_append_converts_legacy_records_without_changing_their_values() {
    let dir = tempfile::tempdir().unwrap();
    let path = transcript_path(dir.path(), "s").unwrap();
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let record = screenshot();
    let mut value = serde_json::to_value(&record).unwrap();
    value["type"] = json!("message");
    fs::write(&path, format!("{{\"type\":\"session\",\"schema\":1,\"sessionId\":\"s\",\"createdAt\":\"old\"}}\n{value}\n")).unwrap();
    let mut next = record.clone();
    next.id = "next".into();
    append_message(dir.path(), "s", "old", &next).unwrap();
    let stored = fs::read_to_string(&path).unwrap();
    assert_eq!(stored.matches("YWJjLw==").count(), 2);
    assert_eq!(
        read_transcript(dir.path(), "s").unwrap()[0].blocks,
        record.blocks
    );
    assert_eq!(
        serde_json::from_str::<Value>(stored.lines().next().unwrap()).unwrap()["schema"],
        2
    );
}

#[test]
fn javascript_golden_and_non_ascii_numeric_mirrors_are_lossless() {
    let golden: Value = serde_json::from_str(include_str!(
        "../../../../packages/host-runtime/src/fixtures/binary-storage.json"
    ))
    .unwrap();
    assert_eq!(
        binary_storage::decode(golden["encoded"].clone()).unwrap(),
        golden["original"]
    );
    assert_eq!(
        binary_storage::decode(binary_storage::encode(golden["original"].clone()).unwrap())
            .unwrap(),
        golden["original"]
    );
    let value = json!({"toolResult":{"content":[{"type":"image","data":"YWJjLw==","mimeType":"image/png"}], "value":1},
        "content":"{\"value\":1.0,\"content\":[{\"data\":\"YWJjLw==\",\"type\":\"image\",\"mimeType\":\"image/png\"}]}"});
    let encoded = binary_storage::encode(value.clone()).unwrap();
    assert!(encoded.get("binaryStorage").is_some());
    assert_eq!(binary_storage::decode(encoded).unwrap(), value);
}

#[test]
fn corrupted_reference_does_not_replace_a_legacy_file_or_hide_history() {
    let dir = tempfile::tempdir().unwrap();
    let path = transcript_path(dir.path(), "s").unwrap();
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let mut encoded = binary_storage::encode(serde_json::to_value(screenshot()).unwrap()).unwrap();
    encoded["type"] = json!("message");
    encoded["binaryStorage"]["refs"][0]["image"] = json!(99);
    let raw = format!("{{\"type\":\"session\",\"schema\":1,\"sessionId\":\"s\",\"createdAt\":\"old\"}}\n{encoded}\n");
    fs::write(&path, &raw).unwrap();
    assert!(append_message(dir.path(), "s", "old", &screenshot()).is_err());
    assert_eq!(fs::read_to_string(&path).unwrap(), raw);
    assert!(read_transcript(dir.path(), "s").is_err());
}

#[test]
fn revisions_checkpoints_compactions_and_indexed_reads_restore_complete_images() {
    let dir = tempfile::tempdir().unwrap();
    let record = screenshot();
    append_message(dir.path(), "s", "old", &record).unwrap();
    let layout = layout::session_layout(dir.path(), "s").unwrap();
    assert_eq!(
        read_transcript_window_with_layout(dir.path(), "s", &layout, 0, Some(1))
            .unwrap()
            .messages[0]
            .blocks,
        record.blocks
    );
    assert_eq!(
        read_tool_call(dir.path(), "s", &layout, "opaque-id")
            .unwrap()
            .unwrap()
            .blocks,
        record.blocks
    );
    let revision = RevisionRecord {
        root_user_id: "root".into(),
        revision_index: 1,
        created_at: record.created_at.clone(),
        messages: vec![record.clone()],
        turns: Default::default(),
    };
    append_revision(dir.path(), "s", &revision).unwrap();
    let branch = read_revision(dir.path(), "s", "root", 1).unwrap().unwrap();
    let RevisionPayload::Stored(branch) = branch else {
        panic!("expected stored revision")
    };
    assert_eq!(branch.messages[0].blocks, record.blocks);
    let checkpoint = InflightRecord {
        schema: INFLIGHT_SCHEMA,
        session_id: "s".into(),
        turn_id: Some("turn".into()),
        saved_at: record.created_at.clone(),
        message: record.clone(),
    };
    write_inflight(dir.path(), "s", &checkpoint).unwrap();
    assert_eq!(
        read_inflight(dir.path(), "s")
            .unwrap()
            .unwrap()
            .message
            .blocks,
        record.blocks
    );
    let compaction = CompactionRecord {
        id: "compact".into(),
        summary: "summary".into(),
        first_kept_message_id: None,
        through_message_id: record.id.clone(),
        tokens_before: 100,
        usage: None,
        retained_tail: Some(json!([record.blocks.clone()])),
        details: None,
        provider_id: None,
        model_id: None,
        created_at: record.created_at.clone(),
    };
    append_compaction(dir.path(), "s", "old", &compaction).unwrap();
    assert_eq!(
        read_compactions(dir.path(), "s").unwrap()[0].retained_tail,
        compaction.retained_tail
    );
    for path in [
        revisions_path(dir.path(), "s").unwrap(),
        inflight_path(dir.path(), "s").unwrap(),
    ] {
        assert_eq!(
            fs::read_to_string(path)
                .unwrap()
                .matches("YWJjLw==")
                .count(),
            1
        );
    }
}

fn nested_mirror(depth: usize) -> Value {
    let mut result = json!({"content":[{"type":"image","data":"YWJjLw==","mimeType":"image/png"}], "details":{"path":"/old/project/file.png"}});
    for level in 0..depth {
        let text = serde_json::to_string_pretty(&result).unwrap();
        result = json!({"source":format!("层{level}😀"), "nested":{"result":result,"text":text}});
    }
    let content = serde_json::to_string_pretty(&result).unwrap();
    json!({"toolResult":result,"content":content})
}

#[test]
fn nested_result_mirrors_store_each_image_once_and_restore_exactly() {
    for depth in 1..=3 {
        let original = nested_mirror(depth);
        let encoded = binary_storage::encode(original.clone()).unwrap();
        assert_eq!(
            serde_json::to_string(&encoded)
                .unwrap()
                .matches("YWJjLw==")
                .count(),
            1,
            "depth {depth}"
        );
        assert_eq!(binary_storage::decode(encoded).unwrap(), original);
    }
}

#[test]
fn relocated_nested_mirrors_follow_the_structured_path_without_losing_text() {
    let original = nested_mirror(3);
    let encoded = binary_storage::encode(original).unwrap();
    let relocated = binary_storage::relocate(encoded, |value| {
        value["toolResult"]["nested"]["result"]["nested"]["result"]["nested"]["result"]
            ["details"]["path"] = json!("/new/project/file.png");
        true
    })
    .unwrap();
    assert_eq!(
        serde_json::to_string(&relocated)
            .unwrap()
            .matches("YWJjLw==")
            .count(),
        1
    );
    let restored = binary_storage::decode(relocated).unwrap();
    assert!(restored["content"]
        .as_str()
        .unwrap()
        .contains("/new/project/file.png"));
    assert!(!restored["content"]
        .as_str()
        .unwrap()
        .contains("/old/project/file.png"));
}

#[test]
fn nested_mirror_dependencies_reject_missing_indexes_and_cycles() {
    for kind in ["missing", "self", "mutual"] {
        let mut encoded = binary_storage::encode(nested_mirror(2)).unwrap();
        let texts = encoded["binaryStorage"]["texts"].as_array_mut().unwrap();
        let (owner, part) = texts
            .iter()
            .enumerate()
            .find_map(|(index, text)| {
                text["parts"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .position(|part| part.get("text").is_some())
                    .map(|part| (index, part))
            })
            .unwrap();
        let target = texts[owner]["parts"][part]["text"].as_u64().unwrap() as usize;
        texts[owner]["parts"][part]["text"] = json!(match kind {
            "missing" => texts.len(),
            "self" => owner,
            _ => target,
        });
        if kind == "mutual" {
            texts[target]["parts"] = json!(["", {"text":owner}]);
        }
        let error = binary_storage::decode(encoded).unwrap_err();
        assert!(binary_storage::is_error(&error), "{kind}: {error}");
        assert!(
            error
                .to_string()
                .contains(if kind == "missing" { "index" } else { "cycle" }),
            "{error}"
        );
    }
}

#[test]
fn javascript_nested_golden_preserves_escape_spelling_and_dependency_links() {
    let golden: Value = serde_json::from_str(include_str!(
        "../../../../packages/host-runtime/src/fixtures/binary-storage-nested.json"
    ))
    .unwrap();
    assert_eq!(
        binary_storage::decode(golden["encoded"].clone()).unwrap(),
        golden["original"]
    );
    let encoded = binary_storage::encode(golden["original"].clone()).unwrap();
    assert_eq!(
        binary_storage::decode(encoded.clone()).unwrap(),
        golden["original"]
    );
    let data = encoded["binaryStorage"]["data"][0].as_str().unwrap();
    assert_eq!(
        serde_json::to_string(&encoded)
            .unwrap()
            .matches(data)
            .count(),
        1
    );
}

#[test]
fn headerless_and_empty_legacy_files_receive_a_current_header_once() {
    for empty in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let path = transcript_path(dir.path(), "s").unwrap();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let record = screenshot();
        let mut value = serde_json::to_value(&record).unwrap();
        value["type"] = json!("message");
        fs::write(
            &path,
            if empty {
                String::new()
            } else {
                format!("{value}\n")
            },
        )
        .unwrap();
        let mut next = record.clone();
        next.id = "next".into();
        append_message(dir.path(), "s", "old", &next).unwrap();
        let raw = fs::read_to_string(&path).unwrap();
        let header: Value = serde_json::from_str(raw.lines().next().unwrap()).unwrap();
        assert_eq!(header["type"], "session", "empty={empty}");
        assert_eq!(header["schema"], TRANSCRIPT_SCHEMA);
        assert!(
            !binary_migration::prepare(&path, Some(&header_line("s", "old").unwrap())).unwrap(),
            "already converted files must not be scanned/replaced again"
        );
        assert_eq!(
            read_transcript(dir.path(), "s").unwrap().len(),
            if empty { 1 } else { 2 }
        );
    }
}

#[test]
fn current_format_corruption_blocks_appends_and_updates_without_changing_files() {
    for fault in ["image", "version"] {
        for update in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let path = transcript_path(dir.path(), "s").unwrap();
            let record = screenshot();
            append_message(dir.path(), "s", "old", &record).unwrap();
            let raw = fs::read_to_string(&path).unwrap();
            let mut lines: Vec<Value> = raw
                .lines()
                .map(|line| serde_json::from_str(line).unwrap())
                .collect();
            if fault == "image" {
                lines[1]["binaryStorage"]["refs"][0]["image"] = json!(999);
            } else {
                lines[1]["binaryStorage"]["version"] = json!(999);
            }
            let corrupt = lines
                .iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("\n")
                + "\n";
            fs::write(&path, &corrupt).unwrap();
            let mut next = record.clone();
            next.id = "next".into();
            let result = if update {
                update_message(dir.path(), "s", &record).map(|_| ())
            } else {
                append_message(dir.path(), "s", "old", &next)
            };
            assert!(
                result.is_err(),
                "{fault}, update={update} must refuse corrupted existing storage"
            );
            assert_eq!(fs::read_to_string(&path).unwrap(), corrupt);
        }
    }
}

#[test]
fn rust_rejects_unknown_nested_mirror_part_fields_like_typescript() {
    let mut encoded = binary_storage::encode(nested_mirror(1)).unwrap();
    let part = encoded["binaryStorage"]["texts"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .flat_map(|text| text["parts"].as_array_mut().unwrap())
        .find(|part| part.get("text").is_some())
        .unwrap();
    part["unknown"] = json!(true);
    let error = binary_storage::decode(encoded).unwrap_err();
    assert!(binary_storage::is_error(&error), "{error}");
}
