use super::*;
use serde_json::json;
use tempfile::tempdir;

fn capture(data: &Path, root: &Path, before: Option<&[u8]>, after: Option<&[u8]>) -> ReviewChange {
    let target = root.join("file.txt");
    if let Some(bytes) = before {
        fs::write(&target, bytes).unwrap();
    } else if target.exists() {
        fs::remove_file(&target).unwrap();
    }
    let pending = prepare_change(
        data,
        "session",
        "message",
        Some(root),
        &ContainedRoots::new(),
        "Write",
        &json!({"path":"file.txt"}),
        false,
    )
    .unwrap()
    .unwrap();
    if let Some(bytes) = after {
        fs::write(&target, bytes).unwrap();
    } else {
        fs::remove_file(&target).unwrap();
    }
    finalize_change(&pending).unwrap()
}

fn load(data: &Path, snapshot: &str, radius: i64) -> Value {
    // Exercise the public domain request interface, including validation.
    let params = json!({"sessionId":"session", "snapshotId":snapshot, "context":radius});
    let request = query::Request::parse("review.context", params).unwrap();
    let db = crate::db::Database::open_in_dir(data).unwrap();
    query::execute(&db, "review.context", request, None).unwrap()
}

#[test]
fn finite_context_radii_survive_workspace_removal_without_full_after_cache() {
    let data = tempdir().unwrap();
    let root = tempdir().unwrap();
    let before: String = (0..80).map(|i| format!("line {i}\n")).collect();
    let after = before.replace("line 40\n", "replacement\n");
    let change = capture(
        data.path(),
        root.path(),
        Some(before.as_bytes()),
        Some(after.as_bytes()),
    );
    let default_preview = serde_json::to_value(&change.hunks).unwrap();
    let dir = snapshot_dir(data.path(), "session", &change.snapshot_id).unwrap();
    assert!(!dir.join("after").exists(), "No full after-image cache");
    let saved = fs::read_to_string(dir.join("contexts.json")).unwrap();
    assert!(
        !saved.contains("\"line 0\""),
        "Far-away unchanged text is not cached"
    );
    for removed in [-1, 20] {
        assert!(query::Request::parse(
            "review.context",
            json!({"sessionId":"session", "snapshotId":change.snapshot_id,"context":removed})
        )
        .is_err());
    }

    fs::remove_dir_all(root.path()).unwrap();
    let mut sizes = Vec::new();
    for radius in [1, 3, 5] {
        let result = load(data.path(), &change.snapshot_id, radius);
        assert!(result.get("unavailable").is_none());
        assert!(result.to_string().contains("replacement"));
        sizes.push(result["hunks"][0]["lines"].as_array().unwrap().len());
        if radius == 3 {
            assert_eq!(result["hunks"], default_preview);
        }
    }
    assert_eq!(sizes, vec![4, 8, 12]);
}

#[test]
fn context_added_deleted_and_newline_only_edits() {
    let data = tempdir().unwrap();
    let root = tempdir().unwrap();
    for (before, after, kind) in [
        (None, Some(&b"new\n"[..]), "add"),
        (Some(&b"old\n"[..]), None, "del"),
        (Some(&b"same"[..]), Some(&b"same\n"[..]), "add"),
        (Some(&b"same\n"[..]), Some(&b"same"[..]), "del"),
    ] {
        let change = capture(data.path(), root.path(), before, after);
        let result = load(data.path(), &change.snapshot_id, 5);
        assert!(result["hunks"][0]["lines"]
            .as_array()
            .unwrap()
            .iter()
            .any(|line| line["type"] == kind));
        if before.is_some() && after.is_some() {
            assert!(result.to_string().contains("No newline"));
        }
    }
}

#[test]
fn context_legacy_binary_and_each_resource_budget_are_explicit() {
    let data = tempdir().unwrap();
    let root = tempdir().unwrap();
    let change = capture(data.path(), root.path(), Some(b"old\n"), Some(b"new\n"));
    let dir = snapshot_dir(data.path(), "session", &change.snapshot_id).unwrap();
    let mut meta: Value = serde_json::from_slice(&fs::read(metadata_path(&dir)).unwrap()).unwrap();
    for key in ["root", "contextSaved", "contextUnavailable"] {
        meta.as_object_mut().unwrap().remove(key);
    }
    fs::write(metadata_path(&dir), serde_json::to_vec(&meta).unwrap()).unwrap();
    fs::remove_file(dir.join("contexts.json")).unwrap();
    assert_eq!(
        load(data.path(), &change.snapshot_id, 3),
        json!({"hunks":[],"unavailable":"legacy"})
    );
    // Legacy metadata also remains readable by the existing rollback path.
    assert_eq!(
        rollback_change(
            data.path(),
            "session",
            &change.snapshot_id,
            Some(root.path())
        )
        .unwrap()
        .status,
        "rolledBack"
    );
    let cases = [
        (b"binary\0".to_vec(), "binary"),
        (vec![b'x'; MAX_DIFF_BYTES as usize + 1], "tooLarge"),
        ("line\n".repeat(MAX_DIFF_LINES + 1).into_bytes(), "tooLarge"),
        (
            (0..1600)
                .map(|i| format!("line {i}\n"))
                .collect::<String>()
                .into_bytes(),
            "tooLarge",
        ),
    ];
    for (bytes, reason) in cases {
        // The final case exceeds the LCS cell budget while staying under the
        // individual byte and line limits on both sides.
        let before = if bytes.starts_with(b"line 0") {
            (0..1600)
                .map(|i| format!("other {i}\n"))
                .collect::<String>()
                .into_bytes()
        } else {
            b"before\n".to_vec()
        };
        let change = capture(data.path(), root.path(), Some(&before), Some(&bytes));
        assert_eq!(
            load(data.path(), &change.snapshot_id, 5),
            json!({"hunks":[],"unavailable":reason})
        );
    }
}

#[test]
fn snapshot_root_never_authorizes_rollback_into_another_checkout() {
    let data = tempdir().unwrap();
    let first = tempdir().unwrap();
    let second = tempdir().unwrap();
    let change = capture(
        data.path(),
        first.path(),
        Some(b"before\n"),
        Some(b"after\n"),
    );
    fs::write(second.path().join("file.txt"), b"after\n").unwrap();
    let outcome = rollback_change(
        data.path(),
        "session",
        &change.snapshot_id,
        Some(second.path()),
    )
    .unwrap();
    assert_eq!(outcome.status, "unavailable");
    assert_eq!(
        fs::read(second.path().join("file.txt")).unwrap(),
        b"after\n"
    );
    assert_eq!(
        rollback_change(
            data.path(),
            "session",
            &change.snapshot_id,
            Some(first.path())
        )
        .unwrap()
        .status,
        "rolledBack"
    );
}
