use super::*;
use crate::transcripts::{
    append_message, read_transcript_window_with_layout, remove_session_files, transcript_path,
    update_message, write_transcript, MessageRecord,
};
use serde_json::json;
use tempfile::tempdir;

const CREATED_AT: &str = "2026-10-11T00:00:00.000Z";

fn message(id: &str, text: &str) -> MessageRecord {
    MessageRecord {
        id: id.into(),
        role: "user".into(),
        tool_name: None,
        is_error: false,
        blocks: json!([{ "type": "text", "text": text }]),
        meta: None,
        created_at: CREATED_AT.into(),
    }
}

fn task_message(status: &str, result: &str) -> MessageRecord {
    MessageRecord {
        id: "m150".into(),
        role: "tool".into(),
        tool_name: Some("Task".into()),
        is_error: false,
        blocks: json!([{
            "type": "tool_call",
            "callId": "task-150",
            "name": "Task",
            "arguments": {},
            "result": { "details": {
                "delegationId": "delegate-150",
                "status": status,
                "result": result
            }},
            "text": result
        }]),
        meta: None,
        created_at: CREATED_AT.into(),
    }
}

fn cold_read(dir: &Path) -> Vec<MessageRecord> {
    let layout = refresh_layout(dir, "layout-regression", TranscriptLayout::default()).unwrap();
    read_transcript_window_with_layout(dir, "layout-regression", &layout, 0, None)
        .unwrap()
        .messages
}

fn seed_cache(dir: &Path, messages: &[MessageRecord]) {
    write_transcript(dir, "layout-regression", CREATED_AT, messages).unwrap();
    assert_messages(&cold_read(dir), messages);
}

fn assert_messages(actual: &[MessageRecord], expected: &[MessageRecord]) {
    assert_eq!(actual.len(), expected.len());
    for (actual, expected) in actual.iter().zip(expected) {
        assert!(
            serde_json::to_value(actual).unwrap() == serde_json::to_value(expected).unwrap(),
            "message {} must remain unchanged",
            expected.id
        );
    }
}

#[test]
fn cold_layout_preserves_unicode_after_a_growing_rewrite() {
    let dir = tempdir().unwrap();
    let mut messages = vec![
        message("m1", &"x".repeat(LAYOUT_CACHE_MIN_LEN as usize)),
        message("m2", "before"),
        message("m3", "last"),
    ];
    seed_cache(dir.path(), &messages);
    messages[1] = message("m2", &"xx中文".repeat(3000));
    write_transcript(dir.path(), "layout-regression", CREATED_AT, &messages).unwrap();
    for _ in 0..3 {
        assert_messages(&cold_read(dir.path()), &messages);
    }
}

#[test]
fn cold_layout_preserves_all_messages_after_a_same_length_rewrite() {
    let dir = tempdir().unwrap();
    let mut messages = vec![
        message("m1", &"x".repeat(LAYOUT_CACHE_MIN_LEN as usize)),
        message("m2", "a"),
        message("m3", "x中文中文"),
    ];
    seed_cache(dir.path(), &messages);
    let path = transcript_path(dir.path(), "layout-regression").unwrap();
    let previous_len = fs::metadata(&path).unwrap().len();
    messages[1] = message("m2", "a中文");
    messages[2] = message("m3", "x中文");
    write_transcript(dir.path(), "layout-regression", CREATED_AT, &messages).unwrap();
    assert_eq!(fs::metadata(&path).unwrap().len(), previous_len);
    assert_messages(&cold_read(dir.path()), &messages);
}

#[test]
fn cold_layout_ignores_a_previous_zero_identity_cache() {
    let dir = tempdir().unwrap();
    let mut messages = vec![
        message("m1", &"x".repeat(LAYOUT_CACHE_MIN_LEN as usize)),
        message("m2", "a"),
        message("m3", "x中文中文"),
    ];
    seed_cache(dir.path(), &messages);
    let layout =
        refresh_layout(dir.path(), "layout-regression", TranscriptLayout::default()).unwrap();
    let cache = layout_cache_path(dir.path(), "layout-regression").unwrap();
    // Emulate an existing Windows cache, without editing user history.
    let offsets = layout
        .message_offsets
        .iter()
        .map(u64::to_string)
        .collect::<Vec<_>>()
        .join(" ");
    fs::write(
        &cache,
        format!(
            "0 {}\n{} 0\n{}\n",
            layout.file_len,
            layout.message_count(),
            offsets
        ),
    )
    .unwrap();
    messages[1] = message("m2", "a中文");
    messages[2] = message("m3", "x中文");
    write_transcript(dir.path(), "layout-regression", CREATED_AT, &messages).unwrap();
    assert_messages(&cold_read(dir.path()), &messages);
}

#[test]
fn cold_layout_keeps_append_only_history() {
    let dir = tempdir().unwrap();
    let mut messages = vec![message("m1", &"x".repeat(LAYOUT_CACHE_MIN_LEN as usize))];
    seed_cache(dir.path(), &messages);
    messages.push(message("m2", "中文😀 appended"));
    append_message(dir.path(), "layout-regression", CREATED_AT, &messages[1]).unwrap();
    assert_messages(&cold_read(dir.path()), &messages);
}

#[test]
fn a_damaged_disk_cache_is_rebuilt_without_skipping_messages() {
    let dir = tempdir().unwrap();
    let messages: Vec<MessageRecord> = (0..300)
        .map(|index| message(&format!("m{index}"), &format!("内容🙂{index}")))
        .chain(std::iter::once(message("large", &"大🙂".repeat(400_000))))
        .collect();
    seed_cache(dir.path(), &messages);
    let cache = layout_cache_path(dir.path(), "layout-regression").unwrap();
    let mut tokens: Vec<String> = fs::read_to_string(&cache)
        .unwrap()
        .split_ascii_whitespace()
        .map(str::to_owned)
        .collect();
    assert_eq!(tokens[0], LAYOUT_CACHE_MAGIC);
    tokens[8] = u64::MAX.to_string();
    fs::write(&cache, tokens.join("\n")).unwrap();

    let rebuilt =
        refresh_layout(dir.path(), "layout-regression", TranscriptLayout::default()).unwrap();
    assert_eq!(rebuilt.message_count(), messages.len());
    let actual = read_transcript_window_with_layout(
        dir.path(),
        "layout-regression",
        &rebuilt,
        rebuilt.message_count().saturating_sub(100),
        Some(100),
    )
    .unwrap()
    .messages;
    assert_messages(&actual, &messages[messages.len() - 100..]);
    assert!(fs::read_to_string(cache).unwrap().contains("checksum "));
}

#[test]
fn cold_layout_after_updating_an_earlier_message_preserves_the_tail() {
    let dir = tempdir().unwrap();
    let mut messages = vec![
        message("m1", &"x".repeat(LAYOUT_CACHE_MIN_LEN as usize)),
        message("m2", "before"),
        message("m3", "last"),
    ];
    seed_cache(dir.path(), &messages);
    messages[1] = message("m2", &"xx中文".repeat(3000));
    assert!(update_message(dir.path(), "layout-regression", &messages[1]).unwrap());
    assert_messages(&cold_read(dir.path()), &messages);
}

#[test]
fn a_growing_middle_rewrite_does_not_reuse_stale_in_memory_offsets() {
    let dir = tempdir().unwrap();
    let body = "中文🙂".repeat(800);
    let mut messages: Vec<MessageRecord> = (0..300)
        .map(|index| {
            if index == 150 {
                task_message("running", "partial")
            } else {
                message(&format!("m{index}"), &body)
            }
        })
        .collect();
    seed_cache(dir.path(), &messages);

    let path = transcript_path(dir.path(), "layout-regression").unwrap();
    let old_len = fs::metadata(&path).unwrap().len();
    assert!(old_len > LAYOUT_CACHE_MIN_LEN);
    let cached =
        refresh_layout(dir.path(), "layout-regression", TranscriptLayout::default()).unwrap();
    assert_eq!(cached.file_len, old_len);

    for index in 300..343 {
        let appended = message(&format!("m{index}"), &body);
        append_message(dir.path(), "layout-regression", CREATED_AT, &appended).unwrap();
        messages.push(appended);
    }

    // Grow a row in the middle. The resulting file remains longer than the
    // cache's scanned prefix, which used to make refresh_layout scan only the
    // new tail while keeping every offset after this row stale.
    messages[150] = task_message("completed", &format!("{}{}", body, "状态🙂".repeat(80)));
    assert!(update_message(dir.path(), "layout-regression", &messages[150]).unwrap());
    assert!(fs::metadata(&path).unwrap().len() > cached.file_len);

    let refreshed = refresh_layout(dir.path(), "layout-regression", cached).unwrap();
    let total = refreshed.message_count();
    let actual = read_transcript_window_with_layout(
        dir.path(),
        "layout-regression",
        &refreshed,
        total.saturating_sub(100),
        Some(100),
    )
    .unwrap()
    .messages;
    assert_messages(&actual, &messages[messages.len() - 100..]);
}

#[test]
fn layout_recovery_rebuilds_once_and_recomputes_the_window() {
    let dir = tempdir().unwrap();
    let body = "中文🙂".repeat(800);
    let messages: Vec<MessageRecord> = (0..300)
        .map(|index| message(&format!("m{index}"), &body))
        .collect();
    seed_cache(dir.path(), &messages);
    let mut stale =
        refresh_layout(dir.path(), "layout-regression", TranscriptLayout::default()).unwrap();
    let path = transcript_path(dir.path(), "layout-regression").unwrap();
    let bytes = fs::read(&path).unwrap();
    let line_start = stale.message_offsets[250] as usize;
    let line_end = bytes[line_start..]
        .iter()
        .position(|byte| *byte == b'\n')
        .map(|offset| line_start + offset)
        .unwrap();
    let line = &bytes[line_start..line_end];
    let text_prefix = b"\"text\":\"";
    let text_start = line
        .windows(text_prefix.len())
        .position(|window| window == text_prefix)
        .unwrap()
        + text_prefix.len();
    // Point into the second byte of a Chinese character so read_line sees
    // invalid UTF-8 at a cached boundary and activates the common retry.
    stale.message_offsets[250] += (text_start + 1) as u64;
    layout_cache()
        .lock()
        .unwrap()
        .insert(layout_key(dir.path(), "layout-regression"), stale);

    let (total, actual) = with_layout_recovery(dir.path(), "layout-regression", |layout| {
        let total = layout.message_count();
        let start = total.saturating_sub(100);
        let read = read_transcript_window_with_layout(
            dir.path(),
            "layout-regression",
            layout,
            start,
            Some(100),
        )?;
        Ok((total, read.messages))
    })
    .unwrap();
    assert_eq!(total, messages.len());
    assert_messages(&actual, &messages[messages.len() - 100..]);
}

#[test]
fn real_invalid_utf8_is_reported_without_changing_transcript_bytes() {
    let dir = tempdir().unwrap();
    let path = transcript_path(dir.path(), "layout-regression").unwrap();
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let bytes =
        b"{\"type\":\"session\"}\n{\"type\":\"message\",\"id\":\"broken\",\"content\":\"\xff\"}\n";
    fs::write(&path, bytes).unwrap();

    let error =
        refresh_layout(dir.path(), "layout-regression", TranscriptLayout::default()).unwrap_err();
    assert!(format!("{error:#}").contains("valid UTF-8"));
    assert_eq!(fs::read(path).unwrap(), bytes);
}

#[test]
fn a_reliable_identity_persists_a_layout() {
    let dir = tempdir().unwrap();
    let messages = vec![message("m1", &"x".repeat(LAYOUT_CACHE_MIN_LEN as usize))];
    seed_cache(dir.path(), &messages);
    let path = transcript_path(dir.path(), "layout-regression").unwrap();
    let metadata = fs::metadata(&path).unwrap();
    let identity = file_identity(&path, &metadata);
    assert_eq!(
        layout_cache_path(dir.path(), "layout-regression")
            .unwrap()
            .exists(),
        identity.is_available()
    );
}

#[test]
fn unavailable_file_identity_disables_disk_cache_but_keeps_reads_available() {
    let dir = tempdir().unwrap();
    let first = message("m1", &"可读🙂".repeat(LAYOUT_CACHE_MIN_LEN as usize / 6));
    write_transcript(
        dir.path(),
        "layout-regression",
        CREATED_AT,
        std::slice::from_ref(&first),
    )
    .unwrap();
    let length = fs::metadata(transcript_path(dir.path(), "layout-regression").unwrap())
        .unwrap()
        .len();
    let layout = refresh_with_identity(
        dir.path(),
        "layout-regression",
        TranscriptLayout::default(),
        length,
        FileIdentity::Unavailable,
    )
    .unwrap();
    assert_eq!(layout.message_count(), 1);
    assert!(!layout_cache_path(dir.path(), "layout-regression")
        .unwrap()
        .exists());

    let second = message("m2", "仍可读取🙂");
    append_message(dir.path(), "layout-regression", CREATED_AT, &second).unwrap();
    let next_length = fs::metadata(transcript_path(dir.path(), "layout-regression").unwrap())
        .unwrap()
        .len();
    let refreshed = refresh_with_identity(
        dir.path(),
        "layout-regression",
        layout,
        next_length,
        FileIdentity::Unavailable,
    )
    .unwrap();
    assert_eq!(refreshed.message_count(), 2);
}

#[test]
fn an_unwritable_layout_cache_does_not_block_transcript_reads() {
    let dir = tempdir().unwrap();
    let messages = vec![message(
        "large",
        &"可读🙂".repeat(LAYOUT_CACHE_MIN_LEN as usize / 6),
    )];
    write_transcript(dir.path(), "layout-regression", CREATED_AT, &messages).unwrap();
    let cache = layout_cache_path(dir.path(), "layout-regression").unwrap();
    fs::create_dir_all(cache.with_extension("layout.tmp")).unwrap();

    let layout =
        refresh_layout(dir.path(), "layout-regression", TranscriptLayout::default()).unwrap();
    assert_eq!(layout.message_count(), 1);
    let read =
        read_transcript_window_with_layout(dir.path(), "layout-regression", &layout, 0, None)
            .unwrap();
    assert_messages(&read.messages, &messages);
    assert!(!cache.exists());
}

#[test]
fn remove_session_files_cleans_up_layout_cache_and_tmp() {
    let dir = tempdir().unwrap();
    let transcript = transcript_path(dir.path(), "s1").unwrap();
    let layout = transcript.with_extension("jsonl.layout");
    let layout_tmp = transcript.with_extension("jsonl.layout.tmp");
    let legacy_tmp = transcript.with_extension("layout.tmp");
    fs::create_dir_all(transcript.parent().unwrap()).unwrap();
    fs::write(&transcript, "content").unwrap();
    fs::write(&layout, "layout").unwrap();
    fs::write(&layout_tmp, "tmp").unwrap();
    fs::write(&legacy_tmp, "tmp").unwrap();
    remove_session_files(dir.path(), "s1");
    assert!(!transcript.exists());
    assert!(!layout.exists());
    assert!(!layout_tmp.exists());
    assert!(!legacy_tmp.exists());
}
