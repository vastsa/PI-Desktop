//! Bounded 1/3/5-line context, captured once; no complete after-image cache.
use super::*;
use serde_json::json;

const MAX_CONTEXT_BYTES: usize = 2 * MAX_DIFF_BYTES as usize;

pub(super) fn save(pending: &PendingChange, after: Option<&[u8]>) -> Result<Option<String>> {
    let Ok(Some(before)) = read_preview(
        pending
            .before_copied
            .then_some(pending.before_path.as_path()),
        pending.before_exists,
    ) else {
        return Ok(Some("tooLarge".into()));
    };
    let Some(after) = after else {
        return Ok(Some("tooLarge".into()));
    };
    if before.contains(&0) || after.contains(&0) {
        return Ok(Some("binary".into()));
    }
    let (Ok(before), Ok(after)) = (String::from_utf8(before), std::str::from_utf8(after)) else {
        return Ok(Some("binary".into()));
    };
    // Terminators are part of identity, so newline-only edits remain visible.
    let before: Vec<String> = before.split_inclusive('\n').map(str::to_owned).collect();
    let after: Vec<String> = after.split_inclusive('\n').map(str::to_owned).collect();
    if before.len() > MAX_DIFF_LINES || after.len() > MAX_DIFF_LINES {
        return Ok(Some("tooLarge".into()));
    }
    let Some(ops) = diff_ops(&before, &after) else {
        return Ok(Some("tooLarge".into()));
    };
    let mut contexts = serde_json::Map::new();
    for radius in [1, 3, 5] {
        let mut hunks = make_hunks_with_context(&ops, radius);
        for hunk in &mut hunks {
            let mut lines = Vec::new();
            for mut line in std::mem::take(&mut hunk.lines) {
                let terminated = line.text.ends_with('\n');
                if terminated {
                    line.text.pop();
                    if line.text.ends_with('\r') {
                        line.text.pop();
                    }
                }
                lines.push(line);
                if !terminated {
                    lines.push(ReviewDiffLine {
                        line_type: "context".into(),
                        text: "\\ No newline at end of file".into(),
                    });
                }
            }
            hunk.lines = lines;
        }
        contexts.insert(radius.to_string(), serde_json::to_value(hunks)?);
    }
    let encoded = serde_json::to_vec(&json!({"version":1,"contexts":contexts}))?;
    if encoded.len() > MAX_CONTEXT_BYTES {
        return Ok(Some("tooLarge".into()));
    }
    fs::write(pending.snapshot_dir.join("contexts.json"), encoded)?;
    Ok(None)
}

pub(super) fn load(
    data_dir: &Path,
    session_id: &str,
    snapshot_id: &str,
    context: i64,
) -> Result<Value> {
    let meta = read_meta(data_dir, session_id, snapshot_id)?;
    let unavailable = |reason: &str| json!({ "hunks": [], "unavailable": reason });
    if let Some(reason) = &meta.context_unavailable {
        return Ok(unavailable(reason));
    }
    if !meta.context_saved {
        return Ok(unavailable("legacy"));
    }
    let file = snapshot_dir(data_dir, session_id, snapshot_id)?.join("contexts.json");
    let metadata = fs::symlink_metadata(&file)?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(anyhow!("invalid review context file"));
    }
    if metadata.len() > MAX_CONTEXT_BYTES as u64 {
        return Ok(unavailable("tooLarge"));
    }
    let mut encoded = Vec::new();
    fs::File::open(file)?
        .take(MAX_CONTEXT_BYTES as u64 + 1)
        .read_to_end(&mut encoded)?;
    if encoded.len() > MAX_CONTEXT_BYTES {
        return Ok(unavailable("tooLarge"));
    }
    let saved: Value = serde_json::from_slice(&encoded)?;
    let hunks = saved
        .get("contexts")
        .and_then(|v| v.get(context.to_string()));
    if saved.get("version") != Some(&json!(1)) || !hunks.is_some_and(Value::is_array) {
        return Err(anyhow!("invalid review context record"));
    }
    Ok(json!({"hunks":hunks}))
}
