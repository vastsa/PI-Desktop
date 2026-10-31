//! Preview and "Merge into project" (ADR 0329 decision 4, PRD R4).
//!
//! The project never enters a merge-in-progress state: the owner branch is
//! merged into the session branch inside the worktree, where conflicts stay,
//! and the project branch is only fast-forwarded. git itself refuses a
//! fast-forward that would overwrite uncommitted or untracked project files.

use std::collections::BTreeMap;
use std::path::Path;

use serde::Serialize;

use super::git::GitRunner;
use super::registry::WorktreeRow;
use super::{fnv1a64, WorktreeError};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewCommit {
    pub sha: String,
    pub subject: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewFile {
    /// `A`, `M`, `D`, ... for committed changes; `?` for untracked files.
    pub status: String,
    pub path: String,
    /// Not committed yet; committed on the session branch when merging.
    pub uncommitted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergePreview {
    pub branch: String,
    pub owner_branch: String,
    pub commits: Vec<PreviewCommit>,
    pub files: Vec<PreviewFile>,
    /// True when the worktree holds an unfinished conflict resolution.
    pub conflict: bool,
    /// Opaque; `merge` refuses when the session changed since this preview.
    pub preview_token: String,
}

impl MergePreview {
    pub fn is_empty(&self) -> bool {
        self.commits.is_empty() && self.files.is_empty() && !self.conflict
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "result")]
pub enum MergeOutcome {
    Merged { commits: usize, files: usize },
    NothingToMerge,
}

pub async fn preview(git: &GitRunner, row: &WorktreeRow) -> Result<MergePreview, WorktreeError> {
    let worktree = Path::new(&row.path);
    let range = format!("{}..{}", head_ref(&row.owner_branch), head_ref(&row.branch));
    let log = git
        .run(worktree, &["log", "-z", "--format=%H%x1f%s", &range])
        .await?;
    let commits = log
        .split('\0')
        .filter(|record| !record.trim().is_empty())
        .filter_map(|record| {
            let (sha, subject) = record.trim_start_matches('\n').split_once('\u{1f}')?;
            Some(PreviewCommit {
                sha: sha.to_string(),
                subject: subject.to_string(),
            })
        })
        .collect();

    let symmetric = format!(
        "{}...{}",
        head_ref(&row.owner_branch),
        head_ref(&row.branch)
    );
    let diff = git
        .run(
            worktree,
            &["diff", "-z", "--no-renames", "--name-status", &symmetric],
        )
        .await?;
    let mut files: Vec<PreviewFile> = Vec::new();
    let mut fields = diff.split('\0').filter(|field| !field.is_empty());
    while let (Some(status), Some(path)) = (fields.next(), fields.next()) {
        files.push(PreviewFile {
            status: status.chars().take(1).collect(),
            path: path.to_string(),
            uncommitted: false,
        });
    }

    let status = worktree_status(git, worktree).await?;
    for (code, path) in parse_porcelain(&status) {
        let entry = PreviewFile {
            status: code,
            path,
            uncommitted: true,
        };
        match files.iter_mut().find(|file| file.path == entry.path) {
            Some(existing) => *existing = entry,
            None => files.push(entry),
        }
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));

    let conflict = merge_in_progress(git, worktree).await?;
    let head = git.run(worktree, &["rev-parse", "HEAD"]).await?;
    // The merge brings the owner branch in too, so a project commit made
    // after the preview must invalidate it like a session change does.
    let owner_tip = git
        .run(
            worktree,
            &[
                "rev-parse",
                "--verify",
                "--quiet",
                &head_ref(&row.owner_branch),
            ],
        )
        .await?;
    let content = content_fingerprint(git, worktree, &status).await?;
    let token = format!(
        "{:016x}",
        fnv1a64(
            format!(
                "{}\n{}\n{}\n{}\n{:016x}",
                head.trim(),
                owner_tip.trim(),
                conflict,
                status,
                content
            )
            .as_bytes()
        )
    );
    Ok(MergePreview {
        branch: row.branch.clone(),
        owner_branch: row.owner_branch.clone(),
        commits,
        files,
        conflict,
        preview_token: token,
    })
}

/// Merge the session branch into the project's current branch. `project` is
/// the project directory (any directory of the main checkout).
pub async fn merge(
    git: &GitRunner,
    row: &WorktreeRow,
    project: &Path,
    title: &str,
    preview_token: &str,
) -> Result<MergeOutcome, WorktreeError> {
    let current = preview(git, row).await?;
    if current.preview_token != preview_token {
        return Err(WorktreeError::new(
            "WORKTREE_CHANGED_SINCE_PREVIEW",
            "the session or the project branch changed after the preview; review the changes again",
        ));
    }
    if current.is_empty() {
        return Ok(MergeOutcome::NothingToMerge);
    }
    land(git, row, project, &commit_message(title)).await?;
    Ok(MergeOutcome::Merged {
        commits: current.commits.len(),
        files: current.files.len(),
    })
}

/// Land `row`'s branch on its owner branch, which is checked out in
/// `owner_checkout` (the project for a session, the session worktree for a
/// subagent). Uncommitted work is committed with `message` first; the owner
/// branch is merged into `row`'s branch inside its own worktree, where a
/// conflict stays; the owner checkout is only fast-forwarded, and git refuses
/// to overwrite uncommitted files there. Shared by "Merge into project" and
/// the subagent merge-back (ADR 0329).
pub async fn land(
    git: &GitRunner,
    row: &WorktreeRow,
    owner_checkout: &Path,
    message: &str,
) -> Result<(), WorktreeError> {
    let worktree = Path::new(&row.path);
    // Checked before anything is committed, so a refusal changes nothing.
    ensure_owner_branch(git, owner_checkout, row).await?;
    ensure_own_branch(git, row).await?;

    if merge_in_progress(git, worktree).await? {
        conclude_resolved_merge(git, worktree).await?;
    }
    commit_all(git, worktree, message).await?;

    // One retry covers the owner branch moving between the two steps.
    for attempt in 0..2 {
        ensure_own_branch(git, row).await?;
        sync_owner_into_session(git, worktree, &row.owner_branch).await?;
        // Bound to the exact commit just built and checked again right
        // before the only write to the owner checkout.
        let landing = rev_parse(git, worktree, &head_ref(&row.branch)).await?;
        ensure_owner_branch(git, owner_checkout, row).await?;
        let forwarded = git
            .output(
                owner_checkout,
                &["merge", "--ff-only", "--no-edit", &landing],
            )
            .await?;
        if forwarded.success() {
            return verify_landed(git, owner_checkout, row, &landing).await;
        }
        ensure_owner_branch(git, owner_checkout, row).await?;
        let owner_contained = git
            .output(
                owner_checkout,
                &[
                    "merge-base",
                    "--is-ancestor",
                    &head_ref(&row.owner_branch),
                    &landing,
                ],
            )
            .await?
            .success();
        if owner_contained || attempt == 1 {
            return Err(WorktreeError::new(
                "WORKTREE_PROJECT_DIRTY",
                format!(
                    "uncommitted changes in the target would be overwritten: {}",
                    forwarded.stderr.trim()
                ),
            ));
        }
    }
    unreachable!("the loop returns on its second attempt")
}

/// Refuse unless the owner checkout still has the owner branch checked out.
async fn ensure_owner_branch(
    git: &GitRunner,
    owner_checkout: &Path,
    row: &WorktreeRow,
) -> Result<(), WorktreeError> {
    if checked_out_branch(git, owner_checkout).await? == head_ref(&row.owner_branch) {
        return Ok(());
    }
    Err(WorktreeError::new(
        "WORKTREE_OWNER_BRANCH_CHANGED",
        format!(
            "the target is no longer on `{}`; check that branch out again to merge",
            row.owner_branch
        ),
    ))
}

/// Refuse unless `row`'s worktree still has its own branch checked out, so a
/// branch the agent switched to never receives a checkpoint or a merge.
pub(super) async fn ensure_own_branch(
    git: &GitRunner,
    row: &WorktreeRow,
) -> Result<(), WorktreeError> {
    if checked_out_branch(git, Path::new(&row.path)).await? == head_ref(&row.branch) {
        return Ok(());
    }
    Err(WorktreeError::new(
        "WORKTREE_SESSION_BRANCH_CHANGED",
        format!(
            "the worktree is no longer on `{}`; check that branch out again in it",
            row.branch
        ),
    ))
}

/// The full ref checked out in `checkout`; empty for a detached `HEAD`.
async fn checked_out_branch(git: &GitRunner, checkout: &Path) -> Result<String, WorktreeError> {
    let head = git
        .output(checkout, &["symbolic-ref", "--quiet", "HEAD"])
        .await?;
    Ok(if head.success() {
        head.stdout.trim().to_string()
    } else {
        String::new()
    })
}

async fn rev_parse(git: &GitRunner, dir: &Path, rev: &str) -> Result<String, WorktreeError> {
    Ok(git
        .run(dir, &["rev-parse", "--verify", "--quiet", rev])
        .await?
        .trim()
        .to_string())
}

/// After the fast-forward: the owner branch, still checked out in the owner
/// checkout, must now contain the commit that was checked. A branch switch in
/// the instant between the last check and git's own `HEAD` read would have
/// moved the other branch instead; that is reported, not hidden. A commit
/// made on the owner branch right after the merge still counts as landed.
async fn verify_landed(
    git: &GitRunner,
    owner_checkout: &Path,
    row: &WorktreeRow,
    landing: &str,
) -> Result<(), WorktreeError> {
    ensure_owner_branch(git, owner_checkout, row).await?;
    let contained = git
        .output(
            owner_checkout,
            &[
                "merge-base",
                "--is-ancestor",
                landing,
                &head_ref(&row.owner_branch),
            ],
        )
        .await?
        .success();
    if contained {
        return Ok(());
    }
    Err(WorktreeError::new(
        "WORKTREE_OWNER_BRANCH_CHANGED",
        format!(
            "`{}` did not receive the merge because the target switched branches meanwhile",
            row.owner_branch
        ),
    ))
}

/// Commit every change in `worktree` with `message`; nothing to do when clean.
pub async fn commit_all(
    git: &GitRunner,
    worktree: &Path,
    message: &str,
) -> Result<bool, WorktreeError> {
    if worktree_status(git, worktree).await?.is_empty() {
        return Ok(false);
    }
    git.run(worktree, &["add", "-A"]).await?;
    git.run(worktree, &["commit", "-q", "-m", message])
        .await
        .map_err(|error| WorktreeError::new("WORKTREE_COMMIT_FAILED", error.to_string()))?;
    Ok(true)
}

/// Commits on `row`'s branch that its owner branch does not have yet.
pub async fn commits_ahead(git: &GitRunner, row: &WorktreeRow) -> Result<u64, WorktreeError> {
    let range = format!("{}..{}", head_ref(&row.owner_branch), head_ref(&row.branch));
    let count = git
        .run(Path::new(&row.path), &["rev-list", "--count", &range])
        .await?;
    Ok(count.trim().parse().unwrap_or(0))
}

/// Commits on `row`'s owner branch that its branch does not have yet, that
/// is, what "Sync from project" would bring in.
pub async fn commits_behind(git: &GitRunner, row: &WorktreeRow) -> Result<u64, WorktreeError> {
    let range = format!("{}..{}", head_ref(&row.branch), head_ref(&row.owner_branch));
    let count = git
        .run(Path::new(&row.path), &["rev-list", "--count", &range])
        .await?;
    Ok(count.trim().parse().unwrap_or(0))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "result")]
pub enum SyncOutcome {
    /// The owner branch's new commits are now on the session branch.
    Synced {
        commits: u64,
    },
    UpToDate,
}

/// "Sync from project": bring the owner branch's new commits into `row`'s
/// branch without touching the owner checkout. Uncommitted session work is
/// committed with `message` first; a conflict stays in the worktree, and an
/// unfinished resolution is concluded first (the same rules as `land`).
pub async fn sync_from_owner(
    git: &GitRunner,
    row: &WorktreeRow,
    message: &str,
) -> Result<SyncOutcome, WorktreeError> {
    let worktree = Path::new(&row.path);
    ensure_own_branch(git, row).await?;
    if merge_in_progress(git, worktree).await? {
        conclude_resolved_merge(git, worktree).await?;
    }
    let behind = commits_behind(git, row).await?;
    if behind == 0 {
        return Ok(SyncOutcome::UpToDate);
    }
    commit_all(git, worktree, message).await?;
    ensure_own_branch(git, row).await?;
    sync_owner_into_session(git, worktree, &row.owner_branch).await?;
    Ok(SyncOutcome::Synced { commits: behind })
}

/// Merge the owner branch into the session branch inside the worktree. A
/// conflict stays in the worktree and is reported with its files.
async fn sync_owner_into_session(
    git: &GitRunner,
    worktree: &Path,
    owner_branch: &str,
) -> Result<(), WorktreeError> {
    let merged = git
        .output(worktree, &["merge", "--no-edit", &head_ref(owner_branch)])
        .await?;
    if merged.success() {
        return Ok(());
    }
    let files = unmerged_files(git, worktree).await?;
    if !files.is_empty() {
        return Err(WorktreeError::conflict(files));
    }
    // Not a content conflict (for example an untracked file in the way):
    // leave the worktree as it was.
    let _ = git.output(worktree, &["merge", "--abort"]).await;
    Err(WorktreeError::new(
        "WORKTREE_MERGE_FAILED",
        merged.stderr.trim().to_string(),
    ))
}

/// Finish a merge whose conflicts were resolved in the worktree. Text files
/// the agent edited but did not `git add` count as resolved once they no
/// longer contain conflict markers (see `resolved_by_edit`).
async fn conclude_resolved_merge(git: &GitRunner, worktree: &Path) -> Result<(), WorktreeError> {
    let stages = conflict_stages(git, worktree).await?;
    let mut unresolved = Vec::new();
    for file in unmerged_files(git, worktree).await? {
        let file_stages = stages.get(&file).map(Vec::as_slice).unwrap_or(&[]);
        if resolved_by_edit(git, worktree, &file, file_stages).await? {
            git.run(worktree, &["add", "--", &file]).await?;
        } else {
            unresolved.push(file);
        }
    }
    if !unresolved.is_empty() {
        return Err(WorktreeError::conflict(unresolved));
    }
    git.run(worktree, &["add", "-A"]).await?;
    git.run(worktree, &["commit", "-q", "--no-edit"])
        .await
        .map_err(|error| WorktreeError::new("WORKTREE_COMMIT_FAILED", error.to_string()))?;
    Ok(())
}

/// Whether every conflict of an unfinished merge in `worktree` is resolved,
/// by the same rule `land` uses to conclude it (`resolved_by_edit`).
pub async fn conflicts_resolved(git: &GitRunner, worktree: &Path) -> Result<bool, WorktreeError> {
    let stages = conflict_stages(git, worktree).await?;
    for file in unmerged_files(git, worktree).await? {
        let file_stages = stages.get(&file).map(Vec::as_slice).unwrap_or(&[]);
        if !resolved_by_edit(git, worktree, &file, file_stages).await? {
            return Ok(false);
        }
    }
    Ok(true)
}

pub async fn unmerged_files(
    git: &GitRunner,
    worktree: &Path,
) -> Result<Vec<String>, WorktreeError> {
    let output = git
        .run(worktree, &["diff", "-z", "--name-only", "--diff-filter=U"])
        .await?;
    let mut files: Vec<String> = output
        .split('\0')
        .filter(|file| !file.is_empty())
        .map(str::to_string)
        .collect();
    files.dedup();
    Ok(files)
}

pub async fn merge_in_progress(git: &GitRunner, worktree: &Path) -> Result<bool, WorktreeError> {
    Ok(git
        .output(worktree, &["rev-parse", "-q", "--verify", "MERGE_HEAD"])
        .await?
        .success())
}

pub async fn worktree_status(git: &GitRunner, worktree: &Path) -> Result<String, WorktreeError> {
    Ok(git
        .run(
            worktree,
            &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
        )
        .await?)
}

/// `XY path\0` entries; renames and copies carry the source as an extra field.
fn parse_porcelain(status: &str) -> Vec<(String, String)> {
    let mut entries = Vec::new();
    let mut fields = status.split('\0').filter(|field| !field.is_empty());
    while let Some(field) = fields.next() {
        if field.len() < 4 {
            continue;
        }
        let (code, path) = field.split_at(3);
        let code = code.trim();
        if code.contains('R') || code.contains('C') {
            fields.next();
        }
        let short = if code == "??" {
            "?".to_string()
        } else {
            code.chars().find(|c| *c != ' ').unwrap_or('M').to_string()
        };
        entries.push((short, path.to_string()));
    }
    entries
}

/// Default length of git's conflict markers (`conflict-marker-size`).
const MARKER_SIZE: usize = 7;

fn has_conflict_markers(content: &[u8], size: usize) -> bool {
    let text = String::from_utf8_lossy(content);
    let is_marker = |line: &str, mark: char| {
        let run = line.chars().take_while(|c| *c == mark).count();
        run == size && matches!(line[run..].chars().next(), None | Some(' ') | Some('\r'))
    };
    text.lines()
        .any(|line| is_marker(line, '<') || is_marker(line, '>'))
}

/// How git merged `path`: whether it writes conflict markers (the default
/// text driver) and with which marker length. `merge=binary`, `-merge`, and
/// custom drivers leave one side in the file without markers.
async fn marker_rules(
    git: &GitRunner,
    worktree: &Path,
    path: &str,
) -> Result<Option<usize>, WorktreeError> {
    let output = git
        .run(
            worktree,
            &[
                "check-attr",
                "-z",
                "merge",
                "conflict-marker-size",
                "--",
                path,
            ],
        )
        .await?;
    let fields: Vec<&str> = output.split('\0').collect();
    let mut merge = "unspecified";
    let mut size = MARKER_SIZE;
    for entry in fields.chunks(3) {
        if let [_, attribute, value] = entry {
            match *attribute {
                "merge" => merge = value,
                "conflict-marker-size" => {
                    if let Ok(parsed) = value.parse::<usize>() {
                        if parsed > 0 {
                            size = parsed;
                        }
                    }
                }
                _ => {}
            }
        }
    }
    Ok(matches!(merge, "unspecified" | "set" | "text").then_some(size))
}

/// Full ref of a local branch, so a tag with the same short name is never
/// picked instead (git resolves `refs/tags/<name>` before `refs/heads/`).
pub fn head_ref(branch: &str) -> String {
    format!("refs/heads/{branch}")
}

/// Conflict stages (1 base, 2 ours, 3 theirs) of each unmerged path.
async fn conflict_stages(
    git: &GitRunner,
    worktree: &Path,
) -> Result<BTreeMap<String, Vec<char>>, WorktreeError> {
    let output = git.run(worktree, &["ls-files", "-u", "-z"]).await?;
    let mut stages: BTreeMap<String, Vec<char>> = BTreeMap::new();
    for record in output.split('\0').filter(|record| !record.is_empty()) {
        // `<mode> <object> <stage>\t<path>`
        let Some((meta, path)) = record.split_once('\t') else {
            continue;
        };
        if let Some(stage) = meta.rsplit(' ').next().and_then(|s| s.chars().next()) {
            stages.entry(path.to_string()).or_default().push(stage);
        }
    }
    Ok(stages)
}

/// Whether an unstaged conflicted file may be treated as resolved: only a
/// text file changed on both sides and merged by git's text driver, which
/// fills it with conflict markers, once those markers are gone. Binary,
/// delete/modify, add/delete, and `merge=binary` / `-merge` / custom-driver
/// conflicts leave no markers, so they need an explicit `git add`/`git rm`.
async fn resolved_by_edit(
    git: &GitRunner,
    worktree: &Path,
    path: &str,
    stages: &[char],
) -> Result<bool, WorktreeError> {
    if !(stages.contains(&'2') && stages.contains(&'3')) {
        return Ok(false);
    }
    let file = worktree.join(path);
    match std::fs::symlink_metadata(&file) {
        Ok(metadata) if metadata.is_file() => {}
        _ => return Ok(false),
    }
    let Some(size) = marker_rules(git, worktree, path).await? else {
        return Ok(false);
    };
    Ok(match std::fs::read(&file) {
        Ok(content) => !content.contains(&0) && !has_conflict_markers(&content, size),
        Err(_) => false,
    })
}

/// Hash of the worktree's uncommitted content: the tracked diff against
/// `HEAD` plus every untracked file, so a re-edit that leaves `git status`
/// unchanged still invalidates a preview.
async fn content_fingerprint(
    git: &GitRunner,
    worktree: &Path,
    status: &str,
) -> Result<u64, WorktreeError> {
    let diff = git
        .run(
            worktree,
            &["diff", "HEAD", "--binary", "--no-ext-diff", "--no-textconv"],
        )
        .await?;
    let untracked: Vec<String> = parse_porcelain(status)
        .into_iter()
        .filter(|(code, _)| code == "?")
        .map(|(_, path)| path)
        .collect();
    let worktree = worktree.to_path_buf();
    // File reads block, so they run off the async workers.
    tokio::task::spawn_blocking(move || {
        let mut hash = fnv1a64(diff.as_bytes());
        for path in untracked {
            hash = fnv_extend(hash, path.as_bytes());
            hash = fnv_extend(hash, &[0]);
            hash = untracked_entry_hash(hash, &worktree.join(&path));
        }
        hash
    })
    .await
    .map_err(|error| WorktreeError::new("WORKTREE_INTERNAL", error.to_string()))
}

fn fnv_extend(mut hash: u64, bytes: &[u8]) -> u64 {
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// Never follows a link and never opens anything but a regular file, so a
/// link to `/dev/zero` or a FIFO cannot hang or exhaust the host. The whole
/// file is hashed in fixed-size chunks, so a same-length rewrite that
/// restores the modification time still changes the token, and a large file
/// never sits in memory. Callers run this off the async workers.
fn untracked_entry_hash(hash: u64, path: &Path) -> u64 {
    use std::io::Read;
    let Ok(metadata) = std::fs::symlink_metadata(path) else {
        return fnv_extend(hash, b"missing");
    };
    if metadata.file_type().is_symlink() {
        let target = std::fs::read_link(path).unwrap_or_default();
        return fnv_extend(
            fnv_extend(hash, b"link:"),
            target.to_string_lossy().as_bytes(),
        );
    }
    if !metadata.is_file() {
        return fnv_extend(hash, b"special");
    }
    let hash = fnv_extend(hash, &metadata.len().to_le_bytes());
    let Ok(mut file) = std::fs::File::open(path) else {
        return fnv_extend(hash, b"unreadable");
    };
    let mut buffer = vec![0u8; 64 * 1024];
    let mut hash = hash;
    loop {
        match file.read(&mut buffer) {
            Ok(0) => break hash,
            Ok(read) => hash = fnv_extend(hash, &buffer[..read]),
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            // A read that fails part-way still yields a stable, distinct token.
            Err(_) => break fnv_extend(hash, b"read-error"),
        }
    }
}

pub fn commit_message(title: &str) -> String {
    let title = title.trim();
    if title.is_empty() {
        "pi: session changes".to_string()
    } else {
        format!("pi: {}", title.chars().take(72).collect::<String>())
    }
}

#[cfg(test)]
mod tests;
