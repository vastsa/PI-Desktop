//! Link-safe removal of a worktree and its branch (ADR 0329 decision 6).
//!
//! Git for Windows follows a directory junction inside the worktree during
//! `git worktree remove --force` and deletes the junction target's files
//! (openai/codex#34702, #49995). host-core therefore empties the worktree
//! itself first, removing every symbolic link or junction as a link, and only
//! then lets git drop the (now link-free) directory and its metadata.

use std::fs;
use std::io;
use std::path::Path;

use super::git::GitRunner;
use super::registry::WorktreeRow;
use super::WorktreeError;

/// Whether `path` is a real directory, never following a link. A symbolic
/// link or a Windows junction is not one (`symlink_metadata` reports both as
/// links; a cloud-file placeholder folder still counts as a directory). A
/// registered worktree folder replaced by a link to somewhere else must never
/// become a tool root, be merged in, or be emptied.
pub fn is_real_dir(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_dir())
}

/// `is_real_dir` for `root` and every directory from it down to
/// `root/<prefix>` (a project that is a repository subdirectory).
pub fn is_real_dir_chain(root: &Path, prefix: &str) -> bool {
    if !is_real_dir(root) {
        return false;
    }
    let mut current = root.to_path_buf();
    Path::new(prefix).components().all(|component| {
        current.push(component);
        is_real_dir(&current)
    })
}

/// Delete everything inside `root` except its `.git` link file. Links are
/// removed as links; their targets are never traversed.
pub fn clear_contents(root: &Path) -> io::Result<()> {
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    for entry in entries {
        let entry = entry?;
        if entry.file_name() == ".git" {
            continue;
        }
        remove_entry(&entry.path())?;
    }
    Ok(())
}

pub(super) fn remove_entry(path: &Path) -> io::Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || is_reparse_point(&metadata) {
        remove_link(path, &metadata)
    } else if metadata.is_dir() {
        // Documented not to follow symbolic links, and protected against
        // symlink TOCTOU races on the supported platforms.
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    }
}

#[cfg(windows)]
fn is_reparse_point(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_reparse_point(_metadata: &fs::Metadata) -> bool {
    false
}

#[cfg(windows)]
fn remove_link(path: &Path, metadata: &fs::Metadata) -> io::Result<()> {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x10;
    // Directory symlinks and junctions are directory entries; removing the
    // entry removes the link, not the target.
    if metadata.file_attributes() & FILE_ATTRIBUTE_DIRECTORY != 0 {
        fs::remove_dir(path)
    } else {
        fs::remove_file(path)
    }
}

#[cfg(not(windows))]
fn remove_link(path: &Path, _metadata: &fs::Metadata) -> io::Result<()> {
    fs::remove_file(path)
}

/// Remove a registered worktree directory, git's metadata for it, and its
/// branch. The registry row is left to the caller.
pub async fn remove_worktree(git: &GitRunner, row: &WorktreeRow) -> Result<(), WorktreeError> {
    let root = Path::new(&row.path);
    let common_dir = Path::new(&row.common_dir);
    let repository_exists = common_dir.is_dir();
    match fs::symlink_metadata(root) {
        // The registered folder was replaced by a link (or a file): remove
        // that entry alone; its target is never read or emptied.
        Ok(metadata) if !metadata.is_dir() => remove_entry(root)?,
        Ok(_) => {
            if repository_exists {
                // Not locked when creation failed half-way; that is fine.
                let _ = git.output(root, &["worktree", "unlock", &row.path]).await;
            }
            clear_contents(root)?;
            if repository_exists {
                git.run_git_dir(common_dir, &["worktree", "remove", "--force", &row.path])
                    .await?;
            }
            if is_real_dir(root) {
                fs::remove_dir_all(root)?;
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    if repository_exists {
        drop_admin_entry(common_dir, root)?;
        let ref_name = format!("refs/heads/{}", row.branch);
        let exists = git
            .run_git_dir(common_dir, &["show-ref", "--verify", "--quiet", &ref_name])
            .await
            .is_ok();
        if exists {
            git.run_git_dir(common_dir, &["branch", "-D", &row.branch])
                .await?;
        }
    }
    Ok(())
}

/// When the worktree directory vanished on its own, git still lists it and
/// keeps its branch "checked out". Drop only the metadata entry whose
/// `gitdir` names this worktree, which is what `git worktree prune` would do
/// for it, without pruning any other worktree.
pub(super) fn drop_admin_entry(common_dir: &Path, root: &Path) -> io::Result<()> {
    let admin = common_dir.join("worktrees");
    let entries = match fs::read_dir(&admin) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    // git records the resolved path (for example `/private/var/...` for
    // `/var/...` on macOS); the root itself may be gone, so resolve its parent.
    let mut expected = vec![root.join(".git")];
    if let (Some(parent), Some(name)) = (root.parent(), root.file_name()) {
        if let Ok(parent) = crate::workspace::simple_canonicalize(parent) {
            expected.push(parent.join(name).join(".git"));
        }
    }
    for entry in entries {
        let entry = entry?;
        let Ok(gitdir) = fs::read_to_string(entry.path().join("gitdir")) else {
            continue;
        };
        if expected.iter().any(|path| Path::new(gitdir.trim()) == path) {
            fs::remove_dir_all(entry.path())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session_worktrees::registry::{WorktreeRow, WorktreeStatus};
    use crate::session_worktrees::test_support::{git_cmd, init_repo, link_dir, try_link_file};

    fn row_for(repo: &Path, worktree: &Path, branch: &str) -> WorktreeRow {
        WorktreeRow {
            id: "w".into(),
            session_id: Some("s".into()),
            delegation_id: None,
            path: worktree.to_string_lossy().into_owned(),
            common_dir: repo.join(".git").to_string_lossy().into_owned(),
            prefix: String::new(),
            branch: branch.into(),
            owner_branch: "main".into(),
            status: WorktreeStatus::Active,
            setup_status: None,
            setup_log: None,
            port_base: None,
            created_at: 0,
            updated_at: 0,
        }
    }

    /// AC14: a link to a directory outside the worktree survives removal. On
    /// Windows the directory links are junctions, which Git for Windows
    /// follows during `git worktree remove --force`.
    #[tokio::test]
    async fn removal_deletes_links_without_touching_their_targets() {
        let dir = tempfile::tempdir().unwrap();
        let repo = init_repo(&dir.path().join("repo"));
        let outside = dir.path().join("outside");
        fs::create_dir_all(outside.join("nested")).unwrap();
        fs::write(outside.join("KEEP_ME.txt"), "keep").unwrap();
        fs::write(outside.join("nested/KEEP_TOO.txt"), "keep").unwrap();
        let worktree = dir.path().join("wt");
        git_cmd(
            &repo,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "pi-desktop/t",
                worktree.to_str().unwrap(),
                "main",
            ],
        );
        link_dir(&outside, &worktree.join("linked"));
        fs::create_dir_all(worktree.join("deep")).unwrap();
        link_dir(&outside, &worktree.join("deep/linked"));
        try_link_file(&outside.join("KEEP_ME.txt"), &worktree.join("file-link"));

        remove_worktree(
            &GitRunner::default(),
            &row_for(&repo, &worktree, "pi-desktop/t"),
        )
        .await
        .unwrap();

        assert!(!worktree.exists());
        assert!(outside.join("KEEP_ME.txt").is_file());
        assert!(outside.join("nested/KEEP_TOO.txt").is_file());
        assert!(!git_cmd(&repo, &["branch", "--list", "pi-desktop/t"]).contains("pi-desktop/t"));
        assert_eq!(git_cmd(&repo, &["worktree", "list"]).lines().count(), 1);
    }

    #[tokio::test]
    async fn a_worktree_whose_directory_vanished_is_unregistered_and_its_branch_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let repo = init_repo(&dir.path().join("repo"));
        let worktree = dir.path().join("wt");
        git_cmd(
            &repo,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "pi-desktop/gone",
                worktree.to_str().unwrap(),
                "main",
            ],
        );
        fs::remove_dir_all(&worktree).unwrap();

        remove_worktree(
            &GitRunner::default(),
            &row_for(&repo, &worktree, "pi-desktop/gone"),
        )
        .await
        .unwrap();

        assert_eq!(git_cmd(&repo, &["worktree", "list"]).lines().count(), 1);
        assert!(!git_cmd(&repo, &["branch", "--list"]).contains("pi-desktop/gone"));
    }
}
