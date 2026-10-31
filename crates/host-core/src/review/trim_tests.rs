use super::*;
use serde_json::json;
use tempfile::tempdir;

#[test]
fn trimmed_large_file_local_edit_preserves_context_coordinates_and_snapshot() {
    let data = tempdir().unwrap();
    let root = tempdir().unwrap();
    let target = root.path().join("large.ts");
    let before: String = (0..3100)
        .map(|i| format!("const line_{i} = {i};\n"))
        .collect();
    let after = before.replace("const line_2200 = 2200;\n", "const line_2200 = 9999;\n");
    fs::write(&target, &before).unwrap();
    let pending = prepare_change(
        data.path(),
        "session",
        "message",
        Some(root.path()),
        &ContainedRoots::new(),
        "Edit",
        &json!({"path":"large.ts"}),
        false,
    )
    .unwrap()
    .unwrap();
    fs::write(&target, &after).unwrap();
    let change = finalize_change(&pending).unwrap();
    assert!(
        !change.truncated,
        "unchanged file head/tail must not consume quadratic budget"
    );
    assert_eq!((change.additions, change.deletions), (1, 1));
    assert_eq!(change.hunks[0].header, "@@ -2198,7 +2198,7 @@");
    fs::remove_file(&target).unwrap();
    for radius in [1, 3, 5] {
        let saved = context::load(data.path(), "session", &change.snapshot_id, radius).unwrap();
        assert!(saved.get("unavailable").is_none());
        assert_eq!(
            saved["hunks"][0]["header"],
            format!(
                "@@ -{},{} +{},{} @@",
                2201 - radius,
                2 * radius + 1,
                2201 - radius,
                2 * radius + 1
            )
        );
        assert!(saved.to_string().contains("9999"));
        assert!(!saved.to_string().contains("line_0 ="));
    }
    assert!(!pending.snapshot_dir.join("after").exists());
}

#[test]
fn trimmed_edges_empty_and_repeated_lines_reconstruct_exact_inputs() {
    let base = vec!["same".to_owned(); 3000];
    let mut cases = vec![
        (base.clone(), base.clone()),
        (Vec::new(), base.clone()),
        (base.clone(), Vec::new()),
    ];
    for position in [0, 1500, 3000] {
        let mut added = base.clone();
        added.insert(position, "inserted".into());
        cases.push((base.clone(), added.clone()));
        cases.push((added, base.clone()));
    }
    for (before, after) in cases {
        let ops =
            diff_ops(&before, &after).expect("small changed middle fits the unchanged budget");
        let restored_before: Vec<_> = ops
            .iter()
            .filter_map(|op| match op {
                DiffOp::Equal(text) | DiffOp::Del(text) => Some(text.clone()),
                _ => None,
            })
            .collect();
        let restored_after: Vec<_> = ops
            .iter()
            .filter_map(|op| match op {
                DiffOp::Equal(text) | DiffOp::Add(text) => Some(text.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(restored_before, before);
        assert_eq!(restored_after, after);
        let (adds, dels) = line_counts(&ops);
        assert_eq!(adds, after.len().saturating_sub(before.len()));
        assert_eq!(dels, before.len().saturating_sub(after.len()));
    }
}

#[test]
fn trimmed_small_sequences_preserve_minimal_change_counts() {
    let sequences: Vec<Vec<String>> = (0..5)
        .flat_map(|len| {
            (0..1_usize << len).map(move |bits| {
                (0..len)
                    .map(|index| {
                        if bits & (1 << index) == 0 {
                            "a".into()
                        } else {
                            "b".into()
                        }
                    })
                    .collect()
            })
        })
        .collect();
    for before in &sequences {
        for after in &sequences {
            let trimmed = diff_ops(before, after).unwrap();
            assert_eq!(
                line_counts(&trimmed),
                line_counts(&diff_middle(before, after).unwrap())
            );
        }
    }
}

#[test]
fn trimmed_middle_still_obeys_original_cell_budget() {
    let before: Vec<_> = (0..1600).map(|i| format!("before {i}")).collect();
    let after: Vec<_> = (0..1600).map(|i| format!("after {i}")).collect();
    assert!(diff_ops(&before, &after).is_none());
    let mut padded_before = vec!["common head".into(); 1000];
    padded_before.extend(before);
    padded_before.extend(vec!["common tail".into(); 1000]);
    let mut padded_after = vec!["common head".into(); 1000];
    padded_after.extend(after);
    padded_after.extend(vec!["common tail".into(); 1000]);
    assert!(diff_ops(&padded_before, &padded_after).is_none());
}
