use super::{discard_snapshot, finalize_shell_change, ReviewChange};
use anyhow::{anyhow, Context, Result};
use ignore::WalkBuilder;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, Instant};

use crate::tools::ignore_rules;
use crate::workspace;

const MAX_WALK_ENTRIES: usize = 10_000;
const MAX_REGULAR_FILES: usize = 2_000;
const MAX_FILE_BYTES: u64 = 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 32 * 1024 * 1024;
const MAX_TOTAL_HASH_BYTES: u64 = 64 * 1024 * 1024;
const MAX_CAPTURE_TIME: Duration = Duration::from_secs(3);
const MAX_EMITTED_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Copy, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CaptureStatus {
    Complete,
    Partial,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureResult {
    pub status: CaptureStatus,
    pub reviews: Vec<ReviewChange>,
}

#[derive(Debug, Clone)]
enum FileState {
    Readable {
        hash: String,
        bytes: Option<Vec<u8>>,
    },
    Unreadable,
}

#[derive(Debug)]
pub struct ShellCapture {
    data_dir: PathBuf,
    root: PathBuf,
    session_id: String,
    message_id: String,
    before: BTreeMap<String, FileState>,
    pre_manifest_complete: bool,
    pre_content_complete: bool,
    policy: PolicySnapshot,
    excluded_roots: Vec<PathBuf>,
}

#[derive(Debug)]
struct ScanResult {
    files: BTreeMap<String, FileState>,
    manifest_complete: bool,
    content_complete: bool,
    #[cfg(test)]
    hashed_bytes: u64,
    #[cfg(test)]
    retained_bytes: u64,
}

#[derive(Debug)]
struct PolicySnapshot {
    files: BTreeMap<String, String>,
    complete: bool,
}

#[derive(Debug)]
struct Candidate {
    path: String,
    before: Option<Vec<u8>>,
    after: Option<Vec<u8>>,
    after_hash: Option<String>,
}

fn relative_path(root: &Path, path: &Path) -> Option<String> {
    path.strip_prefix(root)
        .ok()
        .map(|value| value.to_string_lossy().replace('\\', "/"))
}

fn canonical_excluded(root: &Path, candidates: impl IntoIterator<Item = PathBuf>) -> Vec<PathBuf> {
    candidates
        .into_iter()
        .filter_map(|path| {
            let canonical = workspace::simple_canonicalize(&path).ok()?;
            canonical.starts_with(root).then_some(canonical)
        })
        .collect()
}

#[cfg(windows)]
fn is_link_or_reparse(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_type().is_symlink() || metadata.file_attributes() & 0x400 != 0
}

#[cfg(not(windows))]
fn is_link_or_reparse(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

fn read_hash_bounded(path: &Path, max_bytes: u64) -> Result<(String, Vec<u8>)> {
    let before = fs::symlink_metadata(path)?;
    if is_link_or_reparse(&before) || !before.file_type().is_file() || before.len() > max_bytes {
        return Err(anyhow!("file is not a bounded ordinary file"));
    }
    let file = File::open(path)?;
    let mut bytes = Vec::with_capacity(before.len() as usize);
    file.take(max_bytes + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > max_bytes {
        return Err(anyhow!("file grew beyond capture limit"));
    }
    let after = fs::symlink_metadata(path)?;
    if is_link_or_reparse(&after)
        || !after.file_type().is_file()
        || after.len() != bytes.len() as u64
    {
        return Err(anyhow!("file changed during bounded capture"));
    }
    let hash = hex::encode(Sha256::digest(&bytes));
    Ok((hash, bytes))
}

fn validate_components(root: &Path, relative: &str) -> Result<PathBuf> {
    if workspace::simple_canonicalize(root).ok().as_deref() != Some(root) {
        return Err(anyhow!("workspace root changed during shell capture"));
    }
    let relative_path = Path::new(relative);
    if relative_path.is_absolute()
        || relative_path
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
        || ignore_rules::is_sensitive_path(relative_path)
    {
        return Err(anyhow!("unsafe shell review path"));
    }
    let target = root.join(relative_path);
    let mut current = root.to_path_buf();
    let count = relative_path.components().count();
    for (index, component) in relative_path.components().enumerate() {
        let Component::Normal(name) = component else {
            return Err(anyhow!("unsafe shell review path component"));
        };
        current.push(name);
        match fs::symlink_metadata(&current) {
            Ok(metadata) => {
                if is_link_or_reparse(&metadata) {
                    return Err(anyhow!(
                        "shell review path contains a link or reparse point"
                    ));
                }
                if index + 1 < count && !metadata.file_type().is_dir() {
                    return Err(anyhow!("shell review parent is not a directory"));
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && index + 1 == count => {
                return Ok(target);
            }
            Err(error) => return Err(error.into()),
        }
    }
    Ok(target)
}

fn sample_path(root: &Path, relative: &str) -> Result<Option<(String, Vec<u8>)>> {
    let target = validate_components(root, relative)?;
    match fs::symlink_metadata(&target) {
        Ok(metadata) => {
            if is_link_or_reparse(&metadata) || !metadata.file_type().is_file() {
                return Err(anyhow!("shell review target is not an ordinary file"));
            }
            read_hash_bounded(&target, MAX_FILE_BYTES).map(Some)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn scan_workspace(
    root: &Path,
    excluded_roots: &[PathBuf],
    capture_bytes: bool,
    before_files: Option<&BTreeMap<String, FileState>>,
) -> ScanResult {
    let started = Instant::now();
    let mut walker = WalkBuilder::new(root);
    walker.hidden(false).follow_links(false);
    ignore_rules::configure_shell_review_walker(&mut walker, root, excluded_roots.to_vec());
    let mut entries = 0;
    let mut files_seen = 0;
    let mut total_bytes = 0_u64;
    let mut files = BTreeMap::new();
    let mut manifest_complete = true;
    let mut content_complete = true;
    #[cfg(test)]
    let mut retained_bytes = 0_u64;
    for entry in walker.build() {
        entries += 1;
        if entries > MAX_WALK_ENTRIES || started.elapsed() > MAX_CAPTURE_TIME {
            manifest_complete = false;
            content_complete = false;
            break;
        }
        let Ok(entry) = entry else {
            manifest_complete = false;
            content_complete = false;
            continue;
        };
        let Some(file_type) = entry.file_type() else {
            manifest_complete = false;
            content_complete = false;
            continue;
        };
        if !file_type.is_file() || file_type.is_symlink() {
            continue;
        }
        files_seen += 1;
        if files_seen > MAX_REGULAR_FILES {
            manifest_complete = false;
            content_complete = false;
            break;
        }
        let Some(relative) = relative_path(root, entry.path()) else {
            manifest_complete = false;
            content_complete = false;
            continue;
        };
        let Ok(metadata) = entry.metadata() else {
            files.insert(relative, FileState::Unreadable);
            content_complete = false;
            continue;
        };
        let total_limit = if capture_bytes {
            MAX_TOTAL_BYTES
        } else {
            MAX_TOTAL_HASH_BYTES
        };
        if metadata.len() > MAX_FILE_BYTES
            || total_bytes.saturating_add(metadata.len()) > total_limit
        {
            files.insert(relative, FileState::Unreadable);
            content_complete = false;
            continue;
        }
        match sample_path(root, &relative) {
            Ok(Some((hash, bytes))) => {
                total_bytes += bytes.len() as u64;
                let retain_bytes = capture_bytes
                    || match before_files.and_then(|files| files.get(&relative)) {
                        Some(FileState::Readable {
                            hash: before_hash, ..
                        }) => before_hash != &hash,
                        Some(FileState::Unreadable) => false,
                        None => true,
                    };
                let bytes = retain_bytes.then_some(bytes);
                #[cfg(test)]
                if let Some(bytes) = bytes.as_ref() {
                    retained_bytes += bytes.len() as u64;
                }
                files.insert(relative, FileState::Readable { hash, bytes });
            }
            Ok(None) | Err(_) => {
                files.insert(relative, FileState::Unreadable);
                content_complete = false;
            }
        }
    }
    ScanResult {
        files,
        manifest_complete,
        content_complete,
        #[cfg(test)]
        hashed_bytes: total_bytes,
        #[cfg(test)]
        retained_bytes,
    }
}

fn add_policy_file(root: &Path, path: &Path, files: &mut BTreeMap<String, String>) -> bool {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return true;
    };
    if is_link_or_reparse(&metadata)
        || !metadata.file_type().is_file()
        || metadata.len() > MAX_FILE_BYTES
    {
        return false;
    }
    let Ok((hash, _)) = read_hash_bounded(path, MAX_FILE_BYTES) else {
        return false;
    };
    let Some(relative) = relative_path(root, path) else {
        return false;
    };
    files.insert(relative, hash);
    true
}

fn snapshot_policy(root: &Path, excluded_roots: &[PathBuf]) -> PolicySnapshot {
    let started = Instant::now();
    let mut walker = WalkBuilder::new(root);
    let excluded = excluded_roots.to_vec();
    walker
        .hidden(false)
        .parents(false)
        .ignore(false)
        .git_ignore(false)
        .git_global(false)
        .git_exclude(false)
        .follow_links(false)
        .filter_entry(move |entry| {
            if excluded
                .iter()
                .any(|path| entry.path() == path || entry.path().starts_with(path))
            {
                return false;
            }
            let name = entry.file_name().to_string_lossy();
            if entry.file_type().is_some_and(|kind| kind.is_dir()) {
                return !ignore_rules::DEFAULT_IGNORE_DIRS.contains(&name.as_ref())
                    && !ignore_rules::SHELL_REVIEW_IGNORE_DIRS.contains(&name.as_ref());
            }
            !ignore_rules::is_sensitive_file_name(&name)
        });
    let mut files = BTreeMap::new();
    let mut complete = true;
    let mut entries = 0;
    for entry in walker.build() {
        entries += 1;
        if entries > MAX_WALK_ENTRIES || started.elapsed() > MAX_CAPTURE_TIME {
            complete = false;
            break;
        }
        let Ok(entry) = entry else {
            complete = false;
            continue;
        };
        if entry.file_type().is_some_and(|kind| kind.is_dir()) {
            complete &= add_policy_file(root, &entry.path().join(".git/info/exclude"), &mut files);
            continue;
        }
        let name = entry.file_name().to_string_lossy();
        if name == ".gitignore" || name == ".ignore" || name == ".pi-desktopignore" {
            complete &= add_policy_file(root, entry.path(), &mut files);
        }
    }
    PolicySnapshot { files, complete }
}

pub fn prepare(
    data_dir: &Path,
    session_id: &str,
    message_id: &str,
    workspace_root: Option<&Path>,
    scratch_root: Option<&Path>,
) -> Result<Option<ShellCapture>> {
    let Some(workspace_root) = workspace_root else {
        return Ok(None);
    };
    let root = workspace::simple_canonicalize(workspace_root)
        .context("canonicalize workspace for shell review")?;
    let excluded_roots = canonical_excluded(
        &root,
        [
            scratch_root.map(Path::to_path_buf),
            Some(data_dir.to_path_buf()),
        ]
        .into_iter()
        .flatten(),
    );
    let before = scan_workspace(&root, &excluded_roots, true, None);
    let policy = snapshot_policy(&root, &excluded_roots);
    Ok(Some(ShellCapture {
        data_dir: data_dir.to_path_buf(),
        root,
        session_id: session_id.to_string(),
        message_id: message_id.to_string(),
        before: before.files,
        pre_manifest_complete: before.manifest_complete,
        pre_content_complete: before.content_complete,
        policy,
        excluded_roots,
    }))
}

fn persist_candidate(capture: &ShellCapture, candidate: Candidate) -> Result<ReviewChange> {
    match (
        &candidate.after_hash,
        sample_path(&capture.root, &candidate.path)?,
    ) {
        (Some(expected), Some((actual, _))) if expected == &actual => {}
        (None, None) => {}
        _ => {
            return Err(anyhow!(
                "shell review target changed after post-command capture"
            ))
        }
    }
    finalize_shell_change(
        &capture.data_dir,
        &capture.session_id,
        &capture.message_id,
        &candidate.path,
        candidate.before.as_deref(),
        candidate.after.as_deref(),
    )
}

impl ShellCapture {
    pub fn finish(mut self, process_complete: bool) -> CaptureResult {
        let policy_after = snapshot_policy(&self.root, &self.excluded_roots);
        let policy_drift = !self.policy.complete
            || !policy_after.complete
            || self.policy.files != policy_after.files;
        let after = scan_workspace(&self.root, &self.excluded_roots, false, Some(&self.before));
        let mut paths = BTreeSet::new();
        paths.extend(self.before.keys().cloned());
        paths.extend(after.files.keys().cloned());
        let mut partial = !self.pre_manifest_complete
            || !self.pre_content_complete
            || !after.manifest_complete
            || !after.content_complete
            || policy_drift
            || !process_complete;
        let mut after_files = after.files;
        let mut candidates = Vec::new();
        for path in paths {
            let before = self.before.remove(&path);
            let after_state = after_files.remove(&path);
            let candidate = match (before, after_state) {
                (
                    Some(FileState::Readable {
                        hash: before_hash,
                        bytes: Some(before_bytes),
                    }),
                    Some(FileState::Readable {
                        hash: after_hash,
                        bytes: Some(after_bytes),
                    }),
                ) if before_hash != after_hash => Some(Candidate {
                    path,
                    before: Some(before_bytes),
                    after: Some(after_bytes),
                    after_hash: Some(after_hash),
                }),
                (
                    Some(FileState::Readable {
                        hash: before_hash, ..
                    }),
                    Some(FileState::Readable {
                        hash: after_hash, ..
                    }),
                ) if before_hash == after_hash => None,
                (
                    Some(FileState::Readable {
                        bytes: Some(bytes), ..
                    }),
                    None,
                ) => match sample_path(&self.root, &path) {
                    Ok(None) => Some(Candidate {
                        path,
                        before: Some(bytes),
                        after: None,
                        after_hash: None,
                    }),
                    Ok(Some(_)) | Err(_) => {
                        partial = true;
                        None
                    }
                },
                (
                    None,
                    Some(FileState::Readable {
                        hash: after_hash,
                        bytes: Some(after_bytes),
                    }),
                ) if self.pre_manifest_complete && !policy_drift => Some(Candidate {
                    path,
                    before: None,
                    after: Some(after_bytes),
                    after_hash: Some(after_hash),
                }),
                (Some(FileState::Unreadable), _) | (_, Some(FileState::Unreadable)) => {
                    partial = true;
                    None
                }
                (None, Some(FileState::Readable { .. }))
                | (Some(FileState::Readable { .. }), Some(FileState::Readable { .. }))
                | (Some(FileState::Readable { bytes: None, .. }), None) => {
                    partial = true;
                    None
                }
                _ => None,
            };
            if let Some(candidate) = candidate {
                candidates.push(candidate);
            }
        }

        let mut reviews = Vec::new();
        let mut emitted = 0_usize;
        for candidate in candidates {
            match persist_candidate(&self, candidate) {
                Ok(change) => {
                    let size = serde_json::to_vec(&change)
                        .map(|value| value.len())
                        .unwrap_or(0);
                    if emitted.saturating_add(size) > MAX_EMITTED_BYTES {
                        partial = true;
                        discard_snapshot(&self.data_dir, &self.session_id, &change.snapshot_id);
                        continue;
                    }
                    emitted += size;
                    reviews.push(change);
                }
                Err(error) => {
                    partial = true;
                    tracing::warn!(%error, "shell review snapshot finalization failed");
                }
            }
        }
        CaptureResult {
            status: if partial {
                CaptureStatus::Partial
            } else {
                CaptureStatus::Complete
            },
            reviews,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::review::{rollback_change, ReviewChangeStatus};
    use tempfile::tempdir;

    fn start(data: &Path, workspace: &Path) -> ShellCapture {
        prepare(data, "session", "message", Some(workspace), None)
            .unwrap()
            .unwrap()
    }

    #[test]
    fn captures_add_edit_delete_and_excludes_preexisting_dirty_files() {
        let data = tempdir().unwrap();
        let workspace = tempdir().unwrap();
        fs::write(workspace.path().join("edit.txt"), "before\n").unwrap();
        fs::write(workspace.path().join("delete.txt"), "remove\n").unwrap();
        fs::write(workspace.path().join("dirty.txt"), "already dirty\n").unwrap();
        let capture = start(data.path(), workspace.path());
        fs::write(workspace.path().join("edit.txt"), "after\n").unwrap();
        fs::remove_file(workspace.path().join("delete.txt")).unwrap();
        fs::write(workspace.path().join("add.txt"), "new\n").unwrap();
        let result = capture.finish(true);
        assert_eq!(result.status, CaptureStatus::Complete);
        assert_eq!(result.reviews.len(), 3);
        for (path, status) in [
            ("add.txt", ReviewChangeStatus::Added),
            ("edit.txt", ReviewChangeStatus::Modified),
            ("delete.txt", ReviewChangeStatus::Deleted),
        ] {
            assert_eq!(
                result
                    .reviews
                    .iter()
                    .find(|item| item.path == path)
                    .map(|item| item.status),
                Some(status)
            );
        }
        assert!(!result.reviews.iter().any(|item| item.path == "dirty.txt"));
    }

    #[test]
    fn gradle_caches_do_not_consume_capture_budget_or_hide_source_changes() {
        let data = tempdir().unwrap();
        let workspace = tempdir().unwrap();
        let cache = workspace.path().join(".gradle/8.4/fileHashes");
        let nested_cache = workspace.path().join("module/.gradle");
        fs::create_dir_all(&cache).unwrap();
        fs::create_dir_all(&nested_cache).unwrap();
        fs::create_dir_all(workspace.path().join("src")).unwrap();
        for index in 0..=MAX_WALK_ENTRIES {
            fs::write(cache.join(format!("{index}.bin")), [0, 1]).unwrap();
        }
        fs::write(nested_cache.join("state.lock"), [0, 1]).unwrap();
        fs::write(workspace.path().join("src/Main.java"), "before\n").unwrap();
        let capture = start(data.path(), workspace.path());
        fs::write(cache.join("0.bin"), [0, 2]).unwrap();
        fs::write(nested_cache.join("state.lock"), [0, 2]).unwrap();
        fs::write(workspace.path().join("src/Main.java"), "after\n").unwrap();
        let result = capture.finish(true);
        assert_eq!(result.status, CaptureStatus::Complete);
        assert_eq!(result.reviews.len(), 1);
        let change = &result.reviews[0];
        assert_eq!(change.path, "src/Main.java");
        assert_eq!(change.additions, 1);
        assert_eq!(change.deletions, 1);
        assert_eq!(
            rollback_change(
                data.path(),
                "session",
                &change.snapshot_id,
                Some(workspace.path())
            )
            .unwrap()
            .status,
            "rolledBack"
        );
        assert_eq!(
            fs::read_to_string(workspace.path().join("src/Main.java")).unwrap(),
            "before\n"
        );
        assert_eq!(fs::read(cache.join("0.bin")).unwrap(), [0, 2]);
    }

    #[test]
    fn no_op_is_complete_and_empty() {
        let data = tempdir().unwrap();
        let workspace = tempdir().unwrap();
        fs::write(workspace.path().join("same.txt"), "same\n").unwrap();
        let result = start(data.path(), workspace.path()).finish(true);
        assert_eq!(result.status, CaptureStatus::Complete);
        assert!(result.reviews.is_empty());
    }

    #[test]
    fn nonzero_or_aborted_process_still_captures_and_marks_partial() {
        let data = tempdir().unwrap();
        let workspace = tempdir().unwrap();
        let capture = start(data.path(), workspace.path());
        fs::write(workspace.path().join("failed.txt"), "written\n").unwrap();
        let result = capture.finish(false);
        assert_eq!(result.status, CaptureStatus::Partial);
        assert_eq!(result.reviews.len(), 1);
    }

    #[test]
    fn snapshots_roll_back_independently_and_conflicts_are_guarded() {
        let data = tempdir().unwrap();
        let workspace = tempdir().unwrap();
        fs::write(workspace.path().join("a.txt"), "a0\n").unwrap();
        fs::write(workspace.path().join("b.txt"), "b0\n").unwrap();
        let capture = start(data.path(), workspace.path());
        fs::write(workspace.path().join("a.txt"), "a1\n").unwrap();
        fs::write(workspace.path().join("b.txt"), "b1\n").unwrap();
        let result = capture.finish(true);
        let a = result
            .reviews
            .iter()
            .find(|item| item.path == "a.txt")
            .unwrap();
        let b = result
            .reviews
            .iter()
            .find(|item| item.path == "b.txt")
            .unwrap();
        assert_eq!(
            rollback_change(
                data.path(),
                "session",
                &a.snapshot_id,
                Some(workspace.path())
            )
            .unwrap()
            .status,
            "rolledBack"
        );
        fs::write(workspace.path().join("b.txt"), "later\n").unwrap();
        assert_eq!(
            rollback_change(
                data.path(),
                "session",
                &b.snapshot_id,
                Some(workspace.path())
            )
            .unwrap()
            .status,
            "conflict"
        );
    }

    #[test]
    fn oversized_existing_file_does_not_hide_new_small_files() {
        let data = tempdir().unwrap();
        let workspace = tempdir().unwrap();
        fs::write(
            workspace.path().join("large.bin"),
            vec![0_u8; MAX_FILE_BYTES as usize + 1],
        )
        .unwrap();
        let capture = start(data.path(), workspace.path());
        for name in ["index.html", "style.css", "app.js"] {
            fs::write(workspace.path().join(name), format!("{name}\n")).unwrap();
        }
        let result = capture.finish(true);
        assert_eq!(result.status, CaptureStatus::Partial);
        assert_eq!(result.reviews.len(), 3);
    }

    #[test]
    fn ignore_policy_drift_never_reports_an_exposed_old_file_as_added() {
        let data = tempdir().unwrap();
        let workspace = tempdir().unwrap();
        fs::write(workspace.path().join(".gitignore"), "old.txt\n").unwrap();
        fs::write(workspace.path().join("old.txt"), "preexisting\n").unwrap();
        let capture = start(data.path(), workspace.path());
        fs::write(workspace.path().join(".gitignore"), "").unwrap();
        let result = capture.finish(true);
        assert_eq!(result.status, CaptureStatus::Partial);
        assert!(!result.reviews.iter().any(|item| item.path == "old.txt"));
    }

    #[test]
    fn post_sample_growth_is_rejected_without_unbounded_read() {
        let data = tempdir().unwrap();
        let workspace = tempdir().unwrap();
        let capture = start(data.path(), workspace.path());
        let path = workspace.path().join("grow.txt");
        fs::write(&path, "small\n").unwrap();
        let (hash, bytes) = sample_path(workspace.path(), "grow.txt").unwrap().unwrap();
        fs::write(&path, vec![b'x'; MAX_FILE_BYTES as usize + 1]).unwrap();
        let error = persist_candidate(
            &capture,
            Candidate {
                path: "grow.txt".into(),
                before: None,
                after: Some(bytes),
                after_hash: Some(hash),
            },
        )
        .unwrap_err();
        assert!(error.to_string().contains("bounded ordinary file"));
    }

    #[test]
    fn post_sample_mutation_is_rejected() {
        let data = tempdir().unwrap();
        let workspace = tempdir().unwrap();
        let capture = start(data.path(), workspace.path());
        let path = workspace.path().join("mutate.txt");
        fs::write(&path, "first\n").unwrap();
        let (hash, bytes) = sample_path(workspace.path(), "mutate.txt")
            .unwrap()
            .unwrap();
        fs::write(&path, "later\n").unwrap();
        let error = persist_candidate(
            &capture,
            Candidate {
                path: "mutate.txt".into(),
                before: None,
                after: Some(bytes),
                after_hash: Some(hash),
            },
        )
        .unwrap_err();
        assert!(error.to_string().contains("changed after post-command"));
    }

    #[test]
    fn sensitive_and_ignored_files_are_never_captured() {
        let data = tempdir().unwrap();
        let workspace = tempdir().unwrap();
        let capture = start(data.path(), workspace.path());
        fs::write(workspace.path().join(".env"), "secret").unwrap();
        fs::create_dir(workspace.path().join("node_modules")).unwrap();
        fs::write(workspace.path().join("node_modules/a.js"), "ignored").unwrap();
        let result = capture.finish(true);
        assert_eq!(result.status, CaptureStatus::Complete);
        assert!(result.reviews.is_empty());
    }

    #[test]
    fn post_scan_retains_only_changed_or_added_bytes_within_hash_bound() {
        let workspace = tempdir().unwrap();
        let unchanged = vec![b'u'; 32 * 1024];
        let changed_before = vec![b'b'; 24 * 1024];
        let changed_after = vec![b'a'; 20 * 1024];
        let added = vec![b'n'; 12 * 1024];
        fs::write(workspace.path().join("unchanged.bin"), &unchanged).unwrap();
        fs::write(workspace.path().join("changed.bin"), &changed_before).unwrap();
        let before = scan_workspace(workspace.path(), &[], true, None);
        fs::write(workspace.path().join("changed.bin"), &changed_after).unwrap();
        fs::write(workspace.path().join("added.bin"), &added).unwrap();

        let after = scan_workspace(workspace.path(), &[], false, Some(&before.files));

        assert_eq!(
            after.hashed_bytes,
            (unchanged.len() + changed_after.len() + added.len()) as u64
        );
        assert_eq!(
            after.retained_bytes,
            (changed_after.len() + added.len()) as u64
        );
        assert!(after.hashed_bytes <= MAX_TOTAL_HASH_BYTES);
        assert!(matches!(
            after.files.get("unchanged.bin"),
            Some(FileState::Readable { bytes: None, .. })
        ));
        assert!(matches!(
            after.files.get("changed.bin"),
            Some(FileState::Readable {
                bytes: Some(bytes), ..
            }) if bytes == &changed_after
        ));
        assert!(matches!(
            after.files.get("added.bin"),
            Some(FileState::Readable {
                bytes: Some(bytes), ..
            }) if bytes == &added
        ));
    }

    #[cfg(unix)]
    fn replace_with_symlink(target: &Path, destination: &Path) {
        fs::remove_file(target).unwrap();
        std::os::unix::fs::symlink(destination, target).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn live_inside_symlink_replacement_is_skipped_as_partial() {
        let data = tempdir().unwrap();
        let workspace = tempdir().unwrap();
        fs::write(workspace.path().join("file.txt"), "before\n").unwrap();
        fs::write(workspace.path().join("other.txt"), "inside\n").unwrap();
        let capture = start(data.path(), workspace.path());
        replace_with_symlink(
            &workspace.path().join("file.txt"),
            &workspace.path().join("other.txt"),
        );
        let result = capture.finish(true);
        assert_eq!(result.status, CaptureStatus::Partial);
        assert!(result.reviews.iter().all(|item| item.path != "file.txt"));
    }

    #[cfg(unix)]
    #[test]
    fn live_outside_symlink_replacement_is_skipped_as_partial() {
        let data = tempdir().unwrap();
        let workspace = tempdir().unwrap();
        let outside = tempdir().unwrap();
        fs::write(workspace.path().join("file.txt"), "before\n").unwrap();
        fs::write(outside.path().join("outside.txt"), "outside\n").unwrap();
        let capture = start(data.path(), workspace.path());
        replace_with_symlink(
            &workspace.path().join("file.txt"),
            &outside.path().join("outside.txt"),
        );
        let result = capture.finish(true);
        assert_eq!(result.status, CaptureStatus::Partial);
        assert!(result.reviews.is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn broken_symlink_replacement_is_skipped_as_partial() {
        let data = tempdir().unwrap();
        let workspace = tempdir().unwrap();
        fs::write(workspace.path().join("file.txt"), "before\n").unwrap();
        let capture = start(data.path(), workspace.path());
        replace_with_symlink(
            &workspace.path().join("file.txt"),
            &workspace.path().join("missing.txt"),
        );
        let result = capture.finish(true);
        assert_eq!(result.status, CaptureStatus::Partial);
        assert!(result.reviews.is_empty());
    }
}
