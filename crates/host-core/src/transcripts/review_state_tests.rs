use super::*;
use serde_json::json;
use tempfile::tempdir;

const CREATED_AT: &str = "2026-10-28T00:00:00Z";

fn tool(id: &str, snapshot: &str) -> MessageRecord {
    MessageRecord {
        id: id.into(),
        role: "tool".into(),
        tool_name: Some("Write".into()),
        is_error: false,
        blocks: json!([{
            "type": "tool_call", "callId": id,
            "result": { "details": { "review": {
                "snapshotId": snapshot, "state": "active"
            }}}
        }]),
        meta: None,
        created_at: CREATED_AT.into(),
    }
}

fn state(record: &MessageRecord) -> &str {
    record.blocks[0]["result"]["details"]["review"]["state"]
        .as_str()
        .unwrap()
}

#[test]
fn review_target_lookup_reads_only_its_own_line_after_layout_is_cached() {
    let dir = tempdir().unwrap();
    let records = (0..100)
        .map(|index| tool(&format!("tool-{index}"), "snapshot"))
        .collect::<Vec<_>>();
    write_transcript(dir.path(), "s1", CREATED_AT, &records).unwrap();
    let layout = refresh_layout(dir.path(), "s1", TranscriptLayout::default()).unwrap();
    LAYOUT_LINE_READS.with(|reads| reads.set(0));
    assert_eq!(
        find_message_position(dir.path(), "s1", &layout, "tool-0").unwrap(),
        Some(0)
    );
    LAYOUT_LINE_READS.with(|reads| {
        assert_eq!(
            reads.get(),
            1,
            "cached identity lookup must not read historical bodies"
        )
    });
}

#[test]
fn owned_appends_extend_the_cached_identity_prefix_without_rescanning_history() {
    let dir = tempdir().unwrap();
    let records = (0..100)
        .map(|index| tool(&format!("tool-{index}"), "snapshot"))
        .collect::<Vec<_>>();
    write_transcript(dir.path(), "s1", CREATED_AT, &records).unwrap();
    layout::session_layout(dir.path(), "s1").unwrap();
    layout::SCANNED_LINES.with(|lines| lines.set(0));
    append_message(dir.path(), "s1", CREATED_AT, &tool("next", "snapshot")).unwrap();
    let layout = layout::session_layout(dir.path(), "s1").unwrap();
    assert_eq!(layout.message_count(), 101);
    layout::SCANNED_LINES.with(|lines| assert_eq!(lines.get(), 1));
    assert_eq!(
        find_message_position(dir.path(), "s1", &layout, "tool-0").unwrap(),
        Some(0)
    );
}

#[test]
fn cached_message_identities_rebuild_after_an_in_place_same_length_edit() {
    let dir = tempdir().unwrap();
    let mut record = tool("before-id", "snapshot");
    record.blocks[0]["padding"] = json!("x".repeat(3 * 1024 * 1024));
    write_transcript(dir.path(), "s1", CREATED_AT, &[record]).unwrap();
    let warm = refresh_layout(dir.path(), "s1", TranscriptLayout::default()).unwrap();
    let path = transcript_path(dir.path(), "s1").unwrap();
    let edited = fs::read_to_string(&path)
        .unwrap()
        .replace("before-id", "edited-id");
    fs::write(&path, edited).unwrap();
    for base in [warm, TranscriptLayout::default()] {
        let refreshed = refresh_layout(dir.path(), "s1", base).unwrap();
        assert_eq!(
            find_message_position(dir.path(), "s1", &refreshed, "edited-id").unwrap(),
            Some(0)
        );
        assert_eq!(
            find_message_position(dir.path(), "s1", &refreshed, "before-id").unwrap(),
            None
        );
    }
}

#[test]
fn cached_message_identities_rebuild_after_an_edit_followed_by_append() {
    let dir = tempdir().unwrap();
    let mut record = tool("before-id", "snapshot");
    record.blocks[0]["padding"] = json!("x".repeat(3 * 1024 * 1024));
    write_transcript(dir.path(), "s1", CREATED_AT, &[record]).unwrap();
    let warm = refresh_layout(dir.path(), "s1", TranscriptLayout::default()).unwrap();
    let path = transcript_path(dir.path(), "s1").unwrap();
    let edited = fs::read_to_string(&path)
        .unwrap()
        .replace("before-id", "edited-id");
    fs::write(&path, edited).unwrap();
    append_message(dir.path(), "s1", CREATED_AT, &tool("next", "snapshot")).unwrap();
    for base in [warm, TranscriptLayout::default()] {
        let refreshed = refresh_layout(dir.path(), "s1", base).unwrap();
        assert_eq!(
            find_message_position(dir.path(), "s1", &refreshed, "edited-id").unwrap(),
            Some(0)
        );
        assert_eq!(
            find_message_position(dir.path(), "s1", &refreshed, "before-id").unwrap(),
            None
        );
    }
}

#[test]
fn review_updates_preserve_positions_and_replay_through_warm_and_cold_layouts() {
    let dir = tempdir().unwrap();
    let mut large = tool("image", "unrelated");
    large.blocks[0]["result"]["body"] = json!("x".repeat(3 * 1024 * 1024));
    let records = [
        tool("first", "snapshot-1"),
        large,
        tool("last", "snapshot-2"),
    ];
    write_transcript(dir.path(), "s1", CREATED_AT, &records).unwrap();
    let path = transcript_path(dir.path(), "s1").unwrap();
    let before = fs::read(&path).unwrap();
    let warm = refresh_layout(dir.path(), "s1", TranscriptLayout::default()).unwrap();
    append_tool_review_state(dir.path(), "s1", "first", "snapshot-1", "rolledBack").unwrap();
    let after = fs::read(&path).unwrap();
    assert!(after.starts_with(&before));
    assert!(after.len() - before.len() < 256);

    let grown = refresh_layout(dir.path(), "s1", warm).unwrap();
    assert_eq!(grown.message_count(), 3);
    assert_eq!(grown.tool_review_state_offsets.len(), 1);
    assert_eq!(
        find_message_position(dir.path(), "s1", &grown, "first").unwrap(),
        Some(0)
    );
    let page = read_transcript_window_with_layout(dir.path(), "s1", &grown, 0, Some(1)).unwrap();
    assert_eq!(page.messages.len(), 1);
    assert_eq!(state(&page.messages[0]), "rolledBack");
    assert_eq!(
        state(
            &read_tool_call(dir.path(), "s1", &grown, "first")
                .unwrap()
                .unwrap()
        ),
        "rolledBack"
    );

    // A fresh layout rebuilds a lagging disk cache from the current generation.
    let cold = refresh_layout(dir.path(), "s1", TranscriptLayout::default()).unwrap();
    assert_eq!(cold.message_count(), 3);
    assert_eq!(
        cold.tool_review_state_offsets,
        grown.tool_review_state_offsets
    );
    let full = read_transcript(dir.path(), "s1").unwrap();
    assert_eq!(state(&full[0]), "rolledBack");
    assert_eq!(state(&full[2]), "active");
    let sequential = read_transcript_window(dir.path(), "s1", 0, Some(1)).unwrap();
    assert_eq!(state(&sequential.messages[0]), "rolledBack");

    // A deliberate whole-history rewrite folds the effective state into the
    // canonical message and removes obsolete mutation lines.
    write_transcript(dir.path(), "s1", CREATED_AT, &full).unwrap();
    let rewritten = refresh_layout(dir.path(), "s1", cold).unwrap();
    assert!(rewritten.tool_review_state_offsets.is_empty());
    assert_eq!(
        state(&read_transcript(dir.path(), "s1").unwrap()[0]),
        "rolledBack"
    );
}

#[test]
fn review_state_is_last_write_wins_and_scoped_to_message_and_snapshot() {
    let dir = tempdir().unwrap();
    let mut user = tool("user", "snapshot-1");
    user.role = "user".into();
    let records = [
        tool("target", "snapshot-1"),
        tool("other", "snapshot-1"),
        user,
        tool("target", "snapshot-1"),
    ];
    write_transcript(dir.path(), "s1", CREATED_AT, &records).unwrap();
    for (id, snapshot, state) in [
        ("target", "snapshot-1", "active"),
        ("target", "snapshot-1", "rolledBack"),
        ("target", "other-snapshot", "ignored"),
        ("user", "snapshot-1", "ignored"),
    ] {
        append_tool_review_state(dir.path(), "s1", id, snapshot, state).unwrap();
    }
    let loaded = read_transcript(dir.path(), "s1").unwrap();
    assert_eq!(state(&loaded[0]), "rolledBack");
    assert_eq!(state(&loaded[1]), "active");
    assert_eq!(state(&loaded[2]), "active");
    assert_eq!(state(&loaded[3]), "rolledBack");
    let layout = refresh_layout(dir.path(), "s1", TranscriptLayout::default()).unwrap();
    let page = read_transcript_window_with_layout(dir.path(), "s1", &layout, 3, Some(1)).unwrap();
    assert_eq!(state(&page.messages[0]), "rolledBack");
}

#[test]
fn equal_length_state_appends_replay_in_file_order_across_cached_reads() {
    let dir = tempdir().unwrap();
    let mut record = tool("target", "snapshot");
    record.blocks[0]["padding"] = json!("x".repeat(3 * 1024 * 1024));
    write_transcript(dir.path(), "s1", CREATED_AT, &[record]).unwrap();
    layout::session_layout(dir.path(), "s1").unwrap();
    let path = transcript_path(dir.path(), "s1").unwrap();
    let update = |state: &str| ToolReviewStateRecord {
        message_id: "target".into(),
        snapshot_id: "snapshot".into(),
        state: state.into(),
    };
    let mut first = tagged("tool_review_state", &update("active")).unwrap();
    let second = tagged("tool_review_state", &update("rolledBack")).unwrap();
    // Equal-sized valid JSON, using actual review states and no timestamp or
    // sleeps: only the physical append order can select the effective state.
    first.push_str(&" ".repeat(second.len() - first.len()));
    assert_eq!(first.len(), second.len());
    let line_bytes = second.len() as u64 + 1;
    let mut previous_len = fs::metadata(&path).unwrap().len();
    for (index, (line, expected)) in [(first, "active"), (second, "rolledBack")]
        .into_iter()
        .enumerate()
    {
        append_line(&path, None, line).unwrap();
        let length = fs::metadata(&path).unwrap().len();
        assert_eq!(length - previous_len, line_bytes);
        previous_len = length;
        let warm = layout::session_layout(dir.path(), "s1").unwrap();
        assert_eq!(warm.message_count(), 1);
        assert_eq!(warm.tool_review_state_offsets.len(), index + 1);
        let cold = refresh_layout(dir.path(), "s1", TranscriptLayout::default()).unwrap();
        for cached in [&warm, &cold] {
            let read =
                read_transcript_window_with_layout(dir.path(), "s1", cached, 0, Some(1)).unwrap();
            assert_eq!(state(&read.messages[0]), expected);
        }
        assert_eq!(
            state(&read_transcript(dir.path(), "s1").unwrap()[0]),
            expected
        );
    }
}

#[test]
fn review_append_repairs_a_torn_tail_and_exposes_write_errors() {
    let dir = tempdir().unwrap();
    write_transcript(dir.path(), "s1", CREATED_AT, &[tool("target", "snapshot")]).unwrap();
    let path = transcript_path(dir.path(), "s1").unwrap();
    OpenOptions::new()
        .append(true)
        .open(&path)
        .unwrap()
        .write_all(b"{\"type\":\"tool_review_state\"")
        .unwrap();
    append_tool_review_state(dir.path(), "s1", "target", "snapshot", "rolledBack").unwrap();
    assert_eq!(
        state(&read_transcript(dir.path(), "s1").unwrap()[0]),
        "rolledBack"
    );
    let layout = refresh_layout(dir.path(), "s1", TranscriptLayout::default()).unwrap();
    let loaded = read_transcript_window_with_layout(dir.path(), "s1", &layout, 0, None).unwrap();
    assert_eq!(state(&loaded.messages[0]), "rolledBack");

    let invalid = transcript_path(dir.path(), "unwritable").unwrap();
    fs::create_dir(&invalid).unwrap();
    assert!(append_tool_review_state(dir.path(), "unwritable", "m", "s", "rolledBack").is_err());
}
