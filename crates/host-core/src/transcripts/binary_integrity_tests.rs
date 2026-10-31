use super::*;
use serde_json::json;

fn image_record() -> MessageRecord {
    let image = json!({"type":"image", "data":"YWJjLw==", "mimeType":"image/png"});
    MessageRecord {
        id: "image-row".into(),
        role: "tool".into(),
        tool_name: None,
        is_error: false,
        blocks: json!([image.clone(), image]),
        meta: None,
        created_at: "2026-10-27T00:00:00Z".into(),
    }
}

fn corrupt_line(fault: &str) -> String {
    let mut value: Value =
        serde_json::from_str(&tagged("message", &image_record()).unwrap()).unwrap();
    assert!(value.get("binaryStorage").is_some());
    match fault {
        "malformed" => return "{\"type\":\"message\",\"binaryStorage\":{\"version\":1".into(),
        "typed" => {
            value.as_object_mut().unwrap().remove("id");
        }
        "reference" => value["binaryStorage"]["refs"][0]["image"] = json!(9),
        _ => panic!("unknown corruption fixture"),
    }
    value.to_string()
}

fn seed_transcript(data_dir: &Path) -> PathBuf {
    append_message(data_dir, "s", "old", &image_record()).unwrap();
    transcript_path(data_dir, "s").unwrap()
}

fn replace_message_line(path: &Path, fault: &str) {
    let header = fs::read_to_string(path)
        .unwrap()
        .lines()
        .next()
        .unwrap()
        .to_owned();
    fs::write(path, format!("{header}\n{}\n", corrupt_line(fault))).unwrap();
}

#[test]
fn malformed_and_structurally_invalid_encoded_rows_block_mutations() {
    for fault in ["malformed", "typed"] {
        for update in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let path = seed_transcript(dir.path());
            replace_message_line(&path, fault);
            let before = fs::read(&path).unwrap();
            let result = if update {
                update_message(dir.path(), "s", &image_record()).map(|_| ())
            } else {
                append_message(dir.path(), "s", "old", &image_record())
            };
            let error = result.expect_err(&format!("fault={fault}, update={update}"));
            assert!(binary_storage::is_error(&error), "{error:#}");
            assert_eq!(fs::read(&path).unwrap(), before);
        }
    }
}

#[test]
fn replacement_file_cannot_reuse_a_verified_generation() {
    let dir = tempfile::tempdir().unwrap();
    let path = seed_transcript(dir.path());
    let metadata = fs::metadata(&path).unwrap();
    let replacement = path.with_extension("replacement");
    fs::copy(&path, &replacement).unwrap();
    replace_message_line(&replacement, "reference");
    File::options()
        .write(true)
        .open(&replacement)
        .unwrap()
        .set_times(std::fs::FileTimes::new().set_modified(metadata.modified().unwrap()))
        .unwrap();
    fs::rename(replacement, &path).unwrap();
    assert_eq!(fs::metadata(&path).unwrap().len(), metadata.len());
    let before = fs::read(&path).unwrap();
    let error = append_message(dir.path(), "s", "old", &image_record()).unwrap_err();
    assert!(binary_storage::is_error(&error), "{error:#}");
    assert_eq!(fs::read(path).unwrap(), before);
}

#[test]
fn same_size_rewrite_restoring_mtime_cannot_reuse_a_verified_generation() {
    let dir = tempfile::tempdir().unwrap();
    let path = seed_transcript(dir.path());
    let metadata = fs::metadata(&path).unwrap();
    // Preserve every byte except one index so length and modification time
    // cannot distinguish the corruption from the previously verified file.
    let raw = fs::read_to_string(&path).unwrap();
    let corrupt = raw.replacen("\"image\":0", "\"image\":9", 1);
    assert_ne!(raw, corrupt);
    fs::write(&path, &corrupt).unwrap();
    File::options()
        .write(true)
        .open(&path)
        .unwrap()
        .set_times(std::fs::FileTimes::new().set_modified(metadata.modified().unwrap()))
        .unwrap();
    assert_eq!(fs::metadata(&path).unwrap().len(), metadata.len());
    assert_eq!(
        fs::metadata(&path).unwrap().modified().unwrap(),
        metadata.modified().unwrap()
    );
    let error = append_message(dir.path(), "s", "old", &image_record()).unwrap_err();
    assert!(binary_storage::is_error(&error), "{error:#}");
    assert_eq!(fs::read_to_string(path).unwrap(), corrupt);
}

#[test]
fn invalid_encoded_revision_blocks_stored_and_live_revision_appends() {
    for live in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let revision = RevisionRecord {
            root_user_id: "root".into(),
            revision_index: 0,
            created_at: "old".into(),
            messages: vec![image_record()],
            turns: Default::default(),
        };
        append_revision(dir.path(), "s", &revision).unwrap();
        let path = revisions_path(dir.path(), "s").unwrap();
        let raw = fs::read_to_string(&path).unwrap();
        let corrupt = raw.replacen("\"image\":0", "\"image\":9", 1);
        assert_ne!(raw, corrupt);
        fs::write(&path, &corrupt).unwrap();
        let result = if live {
            append_live_revision(
                dir.path(),
                "s",
                &LiveRevisionRecord {
                    root_user_id: "root".into(),
                    revision_index: 1,
                    created_at: "old".into(),
                },
            )
        } else {
            append_revision(dir.path(), "s", &revision)
        };
        let error = result.unwrap_err();
        assert!(binary_storage::is_error(&error), "{error:#}");
        assert_eq!(fs::read_to_string(path).unwrap(), corrupt);
    }
}

#[test]
fn plain_bad_rows_and_torn_utf8_remain_tolerated_before_append() {
    let dir = tempfile::tempdir().unwrap();
    let path = seed_transcript(dir.path());
    let mut raw = fs::read(&path).unwrap();
    raw.extend_from_slice(b"{bad plain row}\n{\"type\":\"message\",\"id\":\"torn\xff");
    fs::write(&path, &raw).unwrap();
    append_message(dir.path(), "s", "old", &image_record()).unwrap();
    assert!(fs::read(&path).unwrap().starts_with(&raw));
    assert_eq!(read_transcript(dir.path(), "s").unwrap().len(), 2);
}

#[test]
fn owned_appends_and_tail_updates_reuse_a_single_full_scan() {
    let dir = tempfile::tempdir().unwrap();
    let path = seed_transcript(dir.path());
    // Simulate the first mutation in a new Host process.
    binary_integrity::invalidate(&path);
    append_message(dir.path(), "s", "old", &image_record()).unwrap();
    assert_eq!(binary_integrity::scan_count(&path), 1);
    for index in 0..4 {
        let mut record = image_record();
        record.id = format!("next-{index}");
        append_message(dir.path(), "s", "old", &record).unwrap();
        record.meta = Some(json!({"settled":true}));
        assert!(update_message(dir.path(), "s", &record).unwrap());
    }
    assert_eq!(
        binary_integrity::scan_count(&path),
        1,
        "normal mutations must not decode the growing history again"
    );
}

#[test]
fn an_open_file_from_an_old_generation_cannot_certify_its_replacement() {
    let dir = tempfile::tempdir().unwrap();
    let path = seed_transcript(dir.path());
    let opened = File::open(&path).unwrap();
    let replacement = path.with_extension("replacement");
    fs::copy(&path, &replacement).unwrap();
    replace_message_line(&replacement, "reference");
    fs::rename(replacement, &path).unwrap();
    let error = binary_integrity::verify(&path, &mut BufReader::new(opened)).unwrap_err();
    assert!(
        error.to_string().contains("transcript changed"),
        "{error:#}"
    );
    let error = append_message(dir.path(), "s", "old", &image_record()).unwrap_err();
    assert!(binary_storage::is_error(&error), "{error:#}");
}

#[test]
fn rewritten_transcripts_are_checked_before_the_next_append() {
    let dir = tempfile::tempdir().unwrap();
    let path = seed_transcript(dir.path());
    write_transcript(dir.path(), "s", "old", &[image_record()]).unwrap();
    append_message(dir.path(), "s", "old", &image_record()).unwrap();
    assert_eq!(binary_integrity::scan_count(&path), 1);
    let mut next = image_record();
    next.id = "next".into();
    append_message(dir.path(), "s", "old", &next).unwrap();
    let mut first = image_record();
    first.meta = Some(json!({"settled":true}));
    assert!(update_message(dir.path(), "s", &first).unwrap());
    append_message(dir.path(), "s", "old", &next).unwrap();
    assert_eq!(binary_integrity::scan_count(&path), 2);
}

#[test]
fn encoded_compaction_and_revision_record_shapes_are_validated() {
    for tag in ["compaction", "revision", "revision_live"] {
        let dir = tempfile::tempdir().unwrap();
        let path = if tag == "compaction" {
            seed_transcript(dir.path())
        } else {
            let path = revisions_path(dir.path(), "s").unwrap();
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, "{\"type\":\"storage\",\"schema\":2}\n").unwrap();
            path
        };
        let mut value = serde_json::to_value(image_record()).unwrap();
        value["type"] = json!(tag);
        // This valid envelope reconstructs the binary fields, but the known
        // record's required typed fields are missing or mistyped.
        let encoded = binary_storage::encode(value).unwrap();
        let mut file = OpenOptions::new().append(true).open(&path).unwrap();
        writeln!(file, "{encoded}").unwrap();
        drop(file);
        let before = fs::read(&path).unwrap();
        let error =
            append_line(&path, None, tagged("message", &image_record()).unwrap()).unwrap_err();
        assert!(binary_storage::is_error(&error), "tag={tag}: {error:#}");
        assert_eq!(fs::read(path).unwrap(), before);
    }
}

#[test]
fn legacy_conversion_keeps_invalid_plain_image_rows_plain_and_skippable() {
    let dir = tempfile::tempdir().unwrap();
    let path = transcript_path(dir.path(), "s").unwrap();
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let mut value = serde_json::to_value(image_record()).unwrap();
    value["type"] = json!("message");
    value.as_object_mut().unwrap().remove("role");
    let bad_row = value.to_string();
    fs::write(&path, format!("{{\"type\":\"session\",\"schema\":1,\"sessionId\":\"s\",\"createdAt\":\"old\"}}\n{bad_row}\n")).unwrap();
    assert!(read_transcript(dir.path(), "s").unwrap().is_empty());
    append_message(dir.path(), "s", "old", &image_record()).unwrap();
    assert_eq!(
        fs::read_to_string(&path).unwrap().lines().nth(1),
        Some(bad_row.as_str())
    );
    assert_eq!(read_transcript(dir.path(), "s").unwrap().len(), 1);
}
