//! Durable, message-scoped workspace change snapshots.
//!
//! Review evidence is captured at tool execution time instead of being
//! reconstructed from a mutable git working tree. The previous file content
//! lives outside the workspace so a later commit cannot erase the review
//! history, and rollback is guarded by the post-tool content hash.

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use uuid::Uuid;

pub mod shell;

use crate::workspace::{self, ToolRoot};

const REVIEW_DIR: &str = "review-changes";
const MAX_SNAPSHOT_BYTES: u64 = 16 * 1024 * 1024;
const MAX_DIFF_BYTES: u64 = 512 * 1024;
const MAX_DIFF_LINES: usize = 4000;
const MAX_DIFF_CELLS: usize = 2_000_000;
const CONTEXT_LINES: usize = 3;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ReviewChangeOperation {
    Write,
    Edit,
    Delete,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ReviewChangeStatus {
    Added,
    Modified,
    Deleted,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ReviewChangeState {
    Active,
    RolledBack,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewDiffLine {
    #[serde(rename = "type")]
    line_type: String,
    text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewDiffHunk {
    header: String,
    lines: Vec<ReviewDiffLine>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewChange {
    pub version: u8,
    pub snapshot_id: String,
    pub message_id: String,
    pub path: String,
    pub operation: ReviewChangeOperation,
    pub status: ReviewChangeStatus,
    pub state: ReviewChangeState,
    pub additions: usize,
    pub deletions: usize,
    pub hunks: Vec<ReviewDiffHunk>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub binary: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub truncated: bool,
    pub reversible: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RollbackOutcome {
    pub status: &'static str,
    pub snapshot_id: String,
    pub message_id: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotMeta {
    version: u8,
    session_id: String,
    message_id: String,
    path: String,
    operation: ReviewChangeOperation,
    before_exists: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    before_hash: Option<String>,
    after_exists: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    after_hash: Option<String>,
    reversible: bool,
    state: ReviewChangeState,
}

#[derive(Debug)]
pub struct PendingChange {
    snapshot_dir: PathBuf,
    before_path: PathBuf,
    workspace_root: PathBuf,
    resolved: PathBuf,
    session_id: String,
    message_id: String,
    snapshot_id: String,
    path: String,
    operation: ReviewChangeOperation,
    before_exists: bool,
    before_hash: Option<String>,
    before_copied: bool,
}

#[derive(Debug, Clone)]
enum DiffOp {
    Equal(String),
    Add(String),
    Del(String),
}

fn safe_component(value: &str) -> bool {
    !value.is_empty()
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn session_review_dir(data_dir: &Path, session_id: &str) -> Result<PathBuf> {
    if !safe_component(session_id) {
        return Err(anyhow!("invalid session id"));
    }
    Ok(data_dir.join(REVIEW_DIR).join(session_id))
}

fn snapshot_dir(data_dir: &Path, session_id: &str, snapshot_id: &str) -> Result<PathBuf> {
    if !safe_component(snapshot_id) {
        return Err(anyhow!("invalid snapshot id"));
    }
    Ok(session_review_dir(data_dir, session_id)?.join(snapshot_id))
}

fn metadata_path(dir: &Path) -> PathBuf {
    dir.join("meta.json")
}

fn before_path(dir: &Path) -> PathBuf {
    dir.join("before")
}

fn relative_path(root: &Path, path: &Path) -> String {
    let canonical_root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    path.strip_prefix(&canonical_root)
        .or_else(|_| path.strip_prefix(root))
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn hash_file(path: &Path) -> Result<String> {
    let mut file = fs::File::open(path)
        .with_context(|| format!("open file for review hash: {}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

fn write_meta(path: &Path, meta: &SnapshotMeta) -> Result<()> {
    let temp = path.with_extension("json.tmp");
    fs::write(&temp, serde_json::to_vec_pretty(meta)?)?;
    fs::rename(&temp, path)?;
    Ok(())
}

fn read_meta(data_dir: &Path, session_id: &str, snapshot_id: &str) -> Result<SnapshotMeta> {
    let dir = snapshot_dir(data_dir, session_id, snapshot_id)?;
    let bytes = fs::read(metadata_path(&dir))
        .with_context(|| format!("review snapshot not found: {snapshot_id}"))?;
    let meta: SnapshotMeta = serde_json::from_slice(&bytes)?;
    if meta.session_id != session_id || meta.message_id.trim().is_empty() {
        return Err(anyhow!("review snapshot does not belong to this session"));
    }
    Ok(meta)
}

fn tool_operation(tool_name: &str) -> Option<ReviewChangeOperation> {
    match tool_name {
        "Write" => Some(ReviewChangeOperation::Write),
        "Edit" => Some(ReviewChangeOperation::Edit),
        _ => None,
    }
}

/// Capture the pre-tool file without making review a prerequisite for tool
/// success. A missing or unreadable old file simply produces a non-reversible
/// review record after the tool completes.
pub fn prepare_change(
    data_dir: &Path,
    session_id: &str,
    message_id: &str,
    workspace_root: Option<&Path>,
    scratch_root: Option<&Path>,
    tool_name: &str,
    args: &Value,
) -> Result<Option<PendingChange>> {
    let Some(operation) = tool_operation(tool_name) else {
        return Ok(None);
    };
    let Some(root) = workspace_root else {
        return Ok(None);
    };
    let Some(input) = args.get("path").and_then(Value::as_str) else {
        return Ok(None);
    };
    let Ok((resolved, root_kind)) = workspace::resolve_tool_path(root, scratch_root, input) else {
        return Ok(None);
    };
    if root_kind != ToolRoot::Workspace {
        return Ok(None);
    }

    let snapshot_id = Uuid::new_v4().to_string();
    let snapshot_dir = snapshot_dir(data_dir, session_id, &snapshot_id)?;
    fs::create_dir_all(&snapshot_dir)?;
    let before_path = before_path(&snapshot_dir);
    let metadata = fs::metadata(&resolved).ok();
    let before_exists = metadata.as_ref().is_some_and(|value| value.is_file());
    let before_hash = if before_exists {
        hash_file(&resolved).ok()
    } else {
        None
    };
    let before_copied = before_exists
        && metadata
            .as_ref()
            .is_some_and(|value| value.len() <= MAX_SNAPSHOT_BYTES)
        && fs::copy(&resolved, &before_path).is_ok();
    let path = relative_path(root, &resolved);

    Ok(Some(PendingChange {
        snapshot_dir,
        workspace_root: root.to_path_buf(),
        before_path,
        resolved,
        session_id: session_id.to_string(),
        message_id: message_id.to_string(),
        snapshot_id,
        path,
        operation,
        before_exists,
        before_hash,
        before_copied,
    }))
}

pub fn discard_change(pending: PendingChange) {
    let _ = fs::remove_dir_all(pending.snapshot_dir);
}

fn read_preview(path: Option<&Path>, exists: bool) -> Result<Option<Vec<u8>>> {
    if !exists {
        return Ok(Some(Vec::new()));
    }
    let Some(path) = path else {
        return Ok(None);
    };
    let metadata = fs::metadata(path)?;
    if !metadata.is_file() || metadata.len() > MAX_DIFF_BYTES {
        return Ok(None);
    }
    Ok(Some(fs::read(path)?))
}

fn diff_ops(before: &[String], after: &[String]) -> Option<Vec<DiffOp>> {
    if (before.len() + 1).saturating_mul(after.len() + 1) > MAX_DIFF_CELLS {
        return None;
    }
    let mut lcs = vec![vec![0_u32; after.len() + 1]; before.len() + 1];
    for old in (0..before.len()).rev() {
        for new in (0..after.len()).rev() {
            lcs[old][new] = if before[old] == after[new] {
                lcs[old + 1][new + 1] + 1
            } else {
                lcs[old + 1][new].max(lcs[old][new + 1])
            };
        }
    }

    let mut old = 0;
    let mut new = 0;
    let mut ops = Vec::with_capacity(before.len() + after.len());
    while old < before.len() || new < after.len() {
        if old < before.len() && new < after.len() && before[old] == after[new] {
            ops.push(DiffOp::Equal(before[old].clone()));
            old += 1;
            new += 1;
        } else if new == after.len()
            || (old < before.len() && lcs[old + 1][new] >= lcs[old][new + 1])
        {
            ops.push(DiffOp::Del(before[old].clone()));
            old += 1;
        } else {
            ops.push(DiffOp::Add(after[new].clone()));
            new += 1;
        }
    }
    Some(ops)
}

fn line_counts(ops: &[DiffOp]) -> (usize, usize) {
    let mut additions = 0;
    let mut deletions = 0;
    for op in ops {
        match op {
            DiffOp::Add(_) => additions += 1,
            DiffOp::Del(_) => deletions += 1,
            DiffOp::Equal(_) => {}
        }
    }
    (additions, deletions)
}

fn old_line_count(op: &DiffOp) -> usize {
    matches!(op, DiffOp::Equal(_) | DiffOp::Del(_)) as usize
}

fn new_line_count(op: &DiffOp) -> usize {
    matches!(op, DiffOp::Equal(_) | DiffOp::Add(_)) as usize
}

fn make_hunks(ops: &[DiffOp]) -> Vec<ReviewDiffHunk> {
    let changed: Vec<usize> = ops
        .iter()
        .enumerate()
        .filter_map(|(index, op)| (!matches!(op, DiffOp::Equal(_))).then_some(index))
        .collect();
    if changed.is_empty() {
        return Vec::new();
    }

    let mut ranges: Vec<(usize, usize)> = Vec::new();
    for index in changed {
        let start = index.saturating_sub(CONTEXT_LINES);
        let end = (index + CONTEXT_LINES + 1).min(ops.len());
        if let Some((_, previous_end)) = ranges.last_mut() {
            if start <= *previous_end {
                *previous_end = (*previous_end).max(end);
                continue;
            }
        }
        ranges.push((start, end));
    }

    let mut hunks = Vec::with_capacity(ranges.len());
    for (start, end) in ranges {
        let old_before = ops[..start].iter().map(old_line_count).sum::<usize>();
        let new_before = ops[..start].iter().map(new_line_count).sum::<usize>();
        let old_len = ops[start..end].iter().map(old_line_count).sum::<usize>();
        let new_len = ops[start..end].iter().map(new_line_count).sum::<usize>();
        let old_start = old_before + 1;
        let new_start = new_before + 1;
        let lines = ops[start..end]
            .iter()
            .map(|op| match op {
                DiffOp::Equal(text) => ReviewDiffLine {
                    line_type: "context".into(),
                    text: text.clone(),
                },
                DiffOp::Add(text) => ReviewDiffLine {
                    line_type: "add".into(),
                    text: text.clone(),
                },
                DiffOp::Del(text) => ReviewDiffLine {
                    line_type: "del".into(),
                    text: text.clone(),
                },
            })
            .collect();
        hunks.push(ReviewDiffHunk {
            header: format!("@@ -{old_start},{old_len} +{new_start},{new_len} @@"),
            lines,
        });
    }
    hunks
}

fn make_preview_bytes(
    before: Option<&[u8]>,
    before_exists: bool,
    after: Option<&[u8]>,
    after_exists: bool,
) -> (bool, bool, usize, usize, Vec<ReviewDiffHunk>) {
    let before = if before_exists {
        let Some(bytes) = before else {
            return (false, true, 0, 0, Vec::new());
        };
        bytes
    } else {
        &[]
    };
    let after = if after_exists {
        let Some(bytes) = after else {
            return (false, true, 0, 0, Vec::new());
        };
        bytes
    } else {
        &[]
    };
    if before.contains(&0) || after.contains(&0) {
        return (true, false, 0, 0, Vec::new());
    }
    let Ok(before) = std::str::from_utf8(before) else {
        return (true, false, 0, 0, Vec::new());
    };
    let Ok(after) = std::str::from_utf8(after) else {
        return (true, false, 0, 0, Vec::new());
    };
    let before_lines: Vec<String> = before.lines().map(str::to_string).collect();
    let after_lines: Vec<String> = after.lines().map(str::to_string).collect();
    if before_lines.len() > MAX_DIFF_LINES || after_lines.len() > MAX_DIFF_LINES {
        return (false, true, 0, 0, Vec::new());
    }
    let Some(ops) = diff_ops(&before_lines, &after_lines) else {
        return (false, true, 0, 0, Vec::new());
    };
    let (additions, deletions) = line_counts(&ops);
    let hunks = make_hunks(&ops);
    (false, false, additions, deletions, hunks)
}

fn make_preview(
    before_path: Option<&Path>,
    before_exists: bool,
    after_path: Option<&Path>,
    after_exists: bool,
) -> (bool, bool, usize, usize, Vec<ReviewDiffHunk>) {
    let Ok(Some(before)) = read_preview(before_path, before_exists) else {
        return (false, true, 0, 0, Vec::new());
    };
    let Ok(Some(after)) = read_preview(after_path, after_exists) else {
        return (false, true, 0, 0, Vec::new());
    };
    make_preview_bytes(Some(&before), before_exists, Some(&after), after_exists)
}

pub fn finalize_change(pending: &PendingChange) -> Result<ReviewChange> {
    let after_metadata = fs::symlink_metadata(&pending.resolved).ok();
    if after_metadata
        .as_ref()
        .is_some_and(|metadata| metadata.file_type().is_symlink())
    {
        return Err(anyhow!("review target became a symlink"));
    }
    let after_exists = after_metadata
        .as_ref()
        .is_some_and(|metadata| metadata.file_type().is_file());
    if after_exists {
        let guarded = workspace::resolve_in_workspace(&pending.workspace_root, &pending.path)
            .map_err(|error| anyhow!(error))?;
        if guarded != pending.resolved {
            return Err(anyhow!("review target escaped workspace containment"));
        }
    }
    let after_hash = if after_exists {
        Some(hash_file(&pending.resolved)?)
    } else {
        None
    };
    if pending.before_exists == after_exists && pending.before_hash == after_hash {
        return Err(anyhow!("review target did not change"));
    }
    let (binary, truncated, additions, deletions, hunks) = make_preview(
        pending
            .before_copied
            .then_some(pending.before_path.as_path()),
        pending.before_exists,
        Some(pending.resolved.as_path()),
        after_exists,
    );
    let status = match (pending.before_exists, after_exists) {
        (false, true) => ReviewChangeStatus::Added,
        (true, false) => ReviewChangeStatus::Deleted,
        _ => ReviewChangeStatus::Modified,
    };
    let operation = match status {
        ReviewChangeStatus::Added => ReviewChangeOperation::Write,
        ReviewChangeStatus::Deleted => ReviewChangeOperation::Delete,
        ReviewChangeStatus::Modified => pending.operation,
    };
    let reversible = if pending.before_exists {
        pending.before_copied
    } else {
        after_exists
    };
    let meta = SnapshotMeta {
        version: 1,
        session_id: pending.session_id.clone(),
        message_id: pending.message_id.clone(),
        path: pending.path.clone(),
        operation,
        before_exists: pending.before_exists,
        before_hash: pending.before_hash.clone(),
        after_exists,
        after_hash,
        reversible,
        state: ReviewChangeState::Active,
    };
    write_meta(&metadata_path(&pending.snapshot_dir), &meta)?;
    Ok(ReviewChange {
        version: 1,
        snapshot_id: pending.snapshot_id.clone(),
        message_id: pending.message_id.clone(),
        path: pending.path.clone(),
        operation,
        status,
        state: ReviewChangeState::Active,
        additions,
        deletions,
        hunks,
        binary,
        truncated,
        reversible,
    })
}

pub(crate) fn finalize_shell_change(
    data_dir: &Path,
    session_id: &str,
    message_id: &str,
    path: &str,
    before: Option<&[u8]>,
    after: Option<&[u8]>,
) -> Result<ReviewChange> {
    let snapshot_id = Uuid::new_v4().to_string();
    let snapshot_dir = snapshot_dir(data_dir, session_id, &snapshot_id)?;
    fs::create_dir_all(&snapshot_dir)?;
    let before_exists = before.is_some();
    let after_exists = after.is_some();
    let before_hash = before.map(|bytes| hex::encode(Sha256::digest(bytes)));
    let after_hash = after.map(|bytes| hex::encode(Sha256::digest(bytes)));
    if before_exists == after_exists && before_hash == after_hash {
        let _ = fs::remove_dir_all(&snapshot_dir);
        return Err(anyhow!("review target did not change"));
    }
    let before_copied = match before {
        Some(bytes) => fs::write(before_path(&snapshot_dir), bytes).is_ok(),
        None => false,
    };
    let (binary, truncated, additions, deletions, hunks) =
        make_preview_bytes(before, before_exists, after, after_exists);
    let status = match (before_exists, after_exists) {
        (false, true) => ReviewChangeStatus::Added,
        (true, false) => ReviewChangeStatus::Deleted,
        _ => ReviewChangeStatus::Modified,
    };
    let operation = match status {
        ReviewChangeStatus::Added => ReviewChangeOperation::Write,
        ReviewChangeStatus::Deleted => ReviewChangeOperation::Delete,
        ReviewChangeStatus::Modified => ReviewChangeOperation::Edit,
    };
    let reversible = !before_exists || before_copied;
    let meta = SnapshotMeta {
        version: 1,
        session_id: session_id.to_string(),
        message_id: message_id.to_string(),
        path: path.to_string(),
        operation,
        before_exists,
        before_hash,
        after_exists,
        after_hash,
        reversible,
        state: ReviewChangeState::Active,
    };
    if let Err(error) = write_meta(&metadata_path(&snapshot_dir), &meta) {
        let _ = fs::remove_dir_all(&snapshot_dir);
        return Err(error);
    }
    Ok(ReviewChange {
        version: 1,
        snapshot_id,
        message_id: message_id.to_string(),
        path: path.to_string(),
        operation,
        status,
        state: ReviewChangeState::Active,
        additions,
        deletions,
        hunks,
        binary,
        truncated,
        reversible,
    })
}

pub(crate) fn discard_snapshot(data_dir: &Path, session_id: &str, snapshot_id: &str) {
    if let Ok(dir) = snapshot_dir(data_dir, session_id, snapshot_id) {
        let _ = fs::remove_dir_all(dir);
    }
}

fn restore_before(target: &Path, before: &Path) -> Result<()> {
    let bytes = fs::read(before).context("read review rollback snapshot")?;
    if bytes.len() as u64 > MAX_SNAPSHOT_BYTES {
        return Err(anyhow!("review rollback snapshot exceeds the size limit"));
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(target, bytes).context("restore review rollback snapshot")?;
    Ok(())
}

pub fn rollback_change(
    data_dir: &Path,
    session_id: &str,
    snapshot_id: &str,
    workspace_root: Option<&Path>,
) -> Result<RollbackOutcome> {
    let dir = snapshot_dir(data_dir, session_id, snapshot_id)?;
    let mut meta = read_meta(data_dir, session_id, snapshot_id)?;
    let unavailable = || RollbackOutcome {
        status: "unavailable",
        snapshot_id: snapshot_id.to_string(),
        message_id: meta.message_id.clone(),
        path: meta.path.clone(),
    };
    if meta.state == ReviewChangeState::RolledBack {
        return Ok(RollbackOutcome {
            status: "alreadyRolledBack",
            snapshot_id: snapshot_id.to_string(),
            message_id: meta.message_id.clone(),
            path: meta.path.clone(),
        });
    }
    if !meta.reversible {
        return Ok(unavailable());
    }
    let Some(root) = workspace_root else {
        return Ok(unavailable());
    };
    let Ok(target) = workspace::resolve_in_workspace(root, &meta.path) else {
        return Ok(unavailable());
    };
    let current_exists = target.is_file();
    let current_hash = if current_exists {
        hash_file(&target).ok()
    } else {
        None
    };
    let unchanged = match (&meta.after_hash, current_exists) {
        (Some(expected), true) => current_hash.as_deref() == Some(expected.as_str()),
        (None, false) => true,
        _ => false,
    };
    if !unchanged {
        return Ok(RollbackOutcome {
            status: "conflict",
            snapshot_id: snapshot_id.to_string(),
            message_id: meta.message_id,
            path: meta.path,
        });
    }
    if meta.before_exists {
        restore_before(&target, &before_path(&dir))?;
    } else if target.exists() {
        if !target.is_file() {
            return Ok(unavailable());
        }
        fs::remove_file(&target).context("remove created file during rollback")?;
    }
    meta.state = ReviewChangeState::RolledBack;
    write_meta(&metadata_path(&dir), &meta)?;
    Ok(RollbackOutcome {
        status: "rolledBack",
        snapshot_id: snapshot_id.to_string(),
        message_id: meta.message_id,
        path: meta.path,
    })
}

pub fn remove_session(data_dir: &Path, session_id: &str) {
    if let Ok(dir) = session_review_dir(data_dir, session_id) {
        let _ = fs::remove_dir_all(dir);
    }
}

pub fn sweep(data_dir: &Path, live_session_ids: &std::collections::HashSet<String>) {
    let base = data_dir.join(REVIEW_DIR);
    let Ok(entries) = fs::read_dir(base) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let id = entry.file_name().to_string_lossy().to_string();
        if !live_session_ids.contains(&id) {
            let _ = fs::remove_dir_all(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::tempdir;

    fn prepare(
        data: &Path,
        workspace_root: &Path,
        session: &str,
        message: &str,
        path: &str,
    ) -> PendingChange {
        prepare_change(
            data,
            session,
            message,
            Some(workspace_root),
            None,
            "Edit",
            &json!({ "path": path }),
        )
        .unwrap()
        .unwrap()
    }

    #[test]
    fn records_line_changes_and_rolls_back_without_git() {
        let data = tempdir().unwrap();
        let workspace = tempdir().unwrap();
        let target = workspace.path().join("src.txt");
        fs::write(&target, "one\ntwo\n").unwrap();
        let pending = prepare(data.path(), workspace.path(), "s1", "m1", "src.txt");
        fs::write(&target, "one\nthree\n").unwrap();
        let change = finalize_change(&pending).unwrap();
        assert_eq!(change.status, ReviewChangeStatus::Modified);
        assert_eq!(change.additions, 1);
        assert_eq!(change.deletions, 1);
        assert!(change.reversible);
        assert!(!change.hunks.is_empty());

        let result = rollback_change(
            data.path(),
            "s1",
            &change.snapshot_id,
            Some(workspace.path()),
        )
        .unwrap();
        assert_eq!(result.status, "rolledBack");
        assert_eq!(fs::read_to_string(&target).unwrap(), "one\ntwo\n");
        let repeated = rollback_change(
            data.path(),
            "s1",
            &change.snapshot_id,
            Some(workspace.path()),
        )
        .unwrap();
        assert_eq!(repeated.status, "alreadyRolledBack");
    }

    #[test]
    fn refuses_to_overwrite_a_later_edit() {
        let data = tempdir().unwrap();
        let workspace = tempdir().unwrap();
        let target = workspace.path().join("src.txt");
        fs::write(&target, "before\n").unwrap();
        let pending = prepare(data.path(), workspace.path(), "s1", "m1", "src.txt");
        fs::write(&target, "after\n").unwrap();
        let change = finalize_change(&pending).unwrap();
        fs::write(&target, "later\n").unwrap();
        let result = rollback_change(
            data.path(),
            "s1",
            &change.snapshot_id,
            Some(workspace.path()),
        )
        .unwrap();
        assert_eq!(result.status, "conflict");
        assert_eq!(fs::read_to_string(&target).unwrap(), "later\n");
    }

    #[test]
    fn added_file_rollback_removes_the_file() {
        let data = tempdir().unwrap();
        let workspace = tempdir().unwrap();
        let pending = prepare(data.path(), workspace.path(), "s1", "m1", "new.txt");
        fs::write(workspace.path().join("new.txt"), "new\n").unwrap();
        let change = finalize_change(&pending).unwrap();
        assert_eq!(change.status, ReviewChangeStatus::Added);
        let result = rollback_change(
            data.path(),
            "s1",
            &change.snapshot_id,
            Some(workspace.path()),
        )
        .unwrap();
        assert_eq!(result.status, "rolledBack");
        assert!(!workspace.path().join("new.txt").exists());
    }

    #[test]
    fn deleted_file_rollback_restores_previous_bytes() {
        let data = tempdir().unwrap();
        let workspace = tempdir().unwrap();
        let target = workspace.path().join("removed.txt");
        fs::write(&target, "keep me\n").unwrap();
        let pending = prepare(data.path(), workspace.path(), "s1", "m1", "removed.txt");
        fs::remove_file(&target).unwrap();
        let change = finalize_change(&pending).unwrap();
        assert_eq!(change.status, ReviewChangeStatus::Deleted);
        assert_eq!(change.additions, 0);
        assert_eq!(change.deletions, 1);

        let result = rollback_change(
            data.path(),
            "s1",
            &change.snapshot_id,
            Some(workspace.path()),
        )
        .unwrap();
        assert_eq!(result.status, "rolledBack");
        assert_eq!(fs::read_to_string(&target).unwrap(), "keep me\n");
    }
}
