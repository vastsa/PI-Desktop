use super::*;
use serde_json::json;
use tempfile::tempdir;

const CREATED_AT: &str = "2026-11-14T00:00:00Z";

fn message(id: &str, text: &str) -> MessageRecord {
    MessageRecord {
        id: id.into(),
        role: "assistant".into(),
        tool_name: None,
        is_error: false,
        blocks: json!([{ "type": "text", "text": text }]),
        meta: None,
        created_at: CREATED_AT.into(),
    }
}

fn write_lines(dir: &std::path::Path, records: &[MessageRecord]) {
    write_transcript(dir, "s1", CREATED_AT, records).unwrap();
}

#[test]
fn the_suffix_widens_until_no_id_in_it_also_appears_before_it() {
    let dir = tempdir().unwrap();
    let mut records = (0..300)
        .map(|index| message(&format!("m{index}"), "first"))
        .collect::<Vec<_>>();
    // A later line restates m5: the full read keeps it at position 5 with the
    // newer content, so a suffix starting after line 5 would misplace it.
    records.push(message("m5", "restated"));
    write_lines(dir.path(), &records);

    let suffix = read_closed_message_suffix(dir.path(), "s1", |_| true)
        .unwrap()
        .unwrap();
    assert_eq!(suffix.len(), records.len() - 5);
    assert_eq!(suffix.first().unwrap().id, "m5");
    assert_eq!(suffix.last().unwrap().blocks[0]["text"], "restated");

    // Chained restatements are followed to the earliest first line.
    let mut chained = (0..300)
        .map(|index| message(&format!("m{index}"), "first"))
        .collect::<Vec<_>>();
    chained.push(message("m200", "again"));
    chained[250] = message("m3", "restated early");
    write_lines(dir.path(), &chained);
    let suffix = read_closed_message_suffix(dir.path(), "s1", |records| {
        records.iter().any(|record| record.id == "m200")
    })
    .unwrap()
    .unwrap();
    assert_eq!(suffix.first().unwrap().id, "m3");
    assert_eq!(suffix.len(), chained.len() - 3);
}

#[test]
fn a_line_without_a_readable_identity_leaves_the_decision_to_the_full_read() {
    let dir = tempdir().unwrap();
    let records = (0..10)
        .map(|index| message(&format!("m{index}"), "body"))
        .collect::<Vec<_>>();
    write_lines(dir.path(), &records);
    let path = transcript_path(dir.path(), "s1").unwrap();
    let text = std::fs::read_to_string(&path).unwrap();
    std::fs::write(&path, text.replacen("\"id\":\"m3\"", "\"id\":3", 1)).unwrap();

    assert!(read_closed_message_suffix(dir.path(), "s1", |_| true)
        .unwrap()
        .is_none());
}
