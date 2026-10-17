//! Worktrees for the Write/Edit subagents of an isolated session (ADR 0329,
//! PRD R7/R7a).
//!
//! A delegate worktree branches from the session branch; the session worktree
//! is its owner. When the subagent ends its work is merged back with the same
//! algorithm as "Merge into project" (`merge::land`): conflicts stay in the
//! delegate worktree and the session worktree is only fast-forwarded. The
//! session is held while its worktree changes (`SessionHold`), so the parent's
//! tools do not interleave with the merge; anything git
//! still refuses keeps the subagent branch for a later retry, never forced.
//!
//! The runtime names a delegate by its chain id, so a resumed subagent keeps
//! its worktree (and any conflict it has to resolve).

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;

use super::git::GitRunner;
use super::include::copy_included;
use super::lifecycle::{
    discard_failed_creation, ensure_branch_free, env_for, missing_error, port_is_free, run_setup,
    setup_command, short_id, unmerged_commits, SharedState, WorktreeSummary,
};
use super::merge::{self, commit_all, commits_ahead, ensure_own_branch, land, merge_in_progress};
use super::probe::BRANCH_NAMESPACE;
use super::registry::{self, NewWorktree, SetupStatus, WorktreeRow, WorktreeStatus};
use super::remove::{
    drop_admin_entry, is_real_dir, is_real_dir_chain, remove_entry, remove_worktree,
};
use super::{repo_lock, WorktreeError};
use crate::db::Database;
use crate::sessions;
use crate::tool_budget::{SessionExclusivePermit, ToolPermit};

/// What happened to a subagent's worktree when it ended; reported to the
/// parent agent in the delegate report.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "result")]
pub enum DelegateSettlement {
    /// The subagent had no worktree (read-only, or not an isolated session).
    None,
    /// Nothing changed; the worktree and branch were removed.
    NoChanges,
    /// Its commits are now on the session branch; worktree and branch removed.
    Merged { commits: u64 },
    /// A conflict with the session branch stays in the subagent's worktree.
    Conflict { files: Vec<String> },
    /// git refused the fast-forward (or the session was busy); kept for retry.
    NotMerged { reason: String },
    /// The run did not complete; its changes are kept for a resume.
    Kept,
}

/// Tool root of a delegate that has its own worktree; `None` for every other
/// call (no delegation id, or a delegate without a worktree).
pub fn tool_root(
    db: &Database,
    session_id: &str,
    delegation_id: Option<&str>,
) -> Result<Option<PathBuf>, WorktreeError> {
    let Some(delegation_id) = delegation_id else {
        return Ok(None);
    };
    let Some(row) = registry::for_owner(db, session_id, Some(delegation_id))? else {
        return Ok(None);
    };
    let root = row.workspace_root();
    if row.status == WorktreeStatus::Missing
        || !is_real_dir_chain(Path::new(&row.path), &row.prefix)
    {
        return Err(missing_error());
    }
    Ok(Some(root))
}

/// Shell environment of a delegate's own worktree, else the session's.
pub fn tool_env(
    db: &Database,
    session_id: &str,
    delegation_id: Option<&str>,
) -> Vec<(String, String)> {
    let row =
        delegation_id.and_then(|id| registry::for_owner(db, session_id, Some(id)).ok().flatten());
    match row {
        Some(row) => {
            let project = sessions::session_summary(db, session_id)
                .ok()
                .flatten()
                .and_then(|summary| summary.project_path);
            env_for(&row, project.as_deref())
        }
        None => super::lifecycle::tool_env(db, session_id),
    }
}

async fn session_row(state: &SharedState, session_id: &str) -> Result<WorktreeRow, WorktreeError> {
    let st = state.lock().await;
    let row = registry::for_owner(&st.db, session_id, None)?.ok_or_else(|| {
        WorktreeError::new(
            "WORKTREE_NOT_ISOLATED",
            "the session has no isolated worktree",
        )
    })?;
    if row.status == WorktreeStatus::Missing || !is_real_dir(Path::new(&row.path)) {
        return Err(missing_error());
    }
    Ok(row)
}

/// How long a merge, sync, or subagent create/merge waits for the session's
/// in-flight tools before it gives up (or, for a subagent, falls back to
/// holding only the write permit).
pub(super) const SESSION_QUIET_WAIT: Duration = Duration::from_secs(5);

/// Keeps the session's own tools away from its worktree while held.
enum SessionHold {
    /// No tool of the session runs; new ones wait.
    Exclusive { _permit: SessionExclusivePermit },
    /// A long tool (for example a test run in Bash) kept running: only the
    /// parent's Write/Edit are held back. git refuses what still collides,
    /// which keeps the subagent branch instead of forcing it.
    Writes { _permit: ToolPermit },
}

/// Commit the session worktree's uncommitted work while holding the session
/// (see `SessionHold`), so no tool of the parent lands mid-commit.
async fn checkpoint_session(
    state: &SharedState,
    git: &GitRunner,
    session_id: &str,
    session: &WorktreeRow,
    message: &str,
) -> Result<SessionHold, WorktreeError> {
    let budget = state.lock().await.tool_budget.clone();
    let hold = match budget
        .acquire_session_exclusive(session_id, SESSION_QUIET_WAIT)
        .await
    {
        Some(permit) => SessionHold::Exclusive { _permit: permit },
        None => {
            let permit = budget.acquire(session_id, "Write").await.map_err(|_| {
                WorktreeError::new(
                    "WORKTREE_BUSY",
                    "the session is busy writing files; try again",
                )
            })?;
            SessionHold::Writes { _permit: permit }
        }
    };
    let root = Path::new(&session.path);
    if merge_in_progress(git, root).await? {
        return Err(WorktreeError::new(
            "WORKTREE_BUSY",
            "the session has an unfinished merge conflict; resolve it first",
        ));
    }
    // A branch the parent switched to never receives the checkpoint.
    ensure_own_branch(git, session).await?;
    commit_all(git, root, message).await?;
    Ok(hold)
}

/// Re-create a vanished delegate worktree on its existing branch so the
/// subagent's committed work survives a resume; `None` when the branch is
/// gone too. The caller holds the repo lock.
async fn reattach(
    state: &SharedState,
    git: &GitRunner,
    session: &WorktreeRow,
    row: WorktreeRow,
) -> Result<Option<WorktreeRow>, WorktreeError> {
    let common_dir = Path::new(&row.common_dir);
    let branch_exists = git
        .run_git_dir(
            common_dir,
            &[
                "show-ref",
                "--verify",
                "--quiet",
                &merge::head_ref(&row.branch),
            ],
        )
        .await
        .is_ok();
    if !branch_exists {
        return Ok(None);
    }
    drop_admin_entry(common_dir, Path::new(&row.path))?;
    git.run(
        Path::new(&session.path),
        &["worktree", "add", "-q", &row.path, &row.branch],
    )
    .await?;
    git.run(
        Path::new(&row.path),
        &[
            "worktree",
            "lock",
            "--reason",
            "PI-Desktop subagent",
            &row.path,
        ],
    )
    .await?;
    let st = state.lock().await;
    registry::set_status(&st.db, &row.id, WorktreeStatus::Active)?;
    Ok(Some(registry::get(&st.db, &row.id)?.unwrap_or(row)))
}
/// Create (or, for a resumed subagent, reuse) a delegate worktree branched from
/// the session's current state.
pub async fn create_delegate_worktree(
    state: &SharedState,
    git: &GitRunner,
    session_id: &str,
    delegation_id: &str,
) -> Result<WorktreeSummary, WorktreeError> {
    let session = session_row(state, session_id).await?;
    let existing = registry::for_owner(&state.lock().await.db, session_id, Some(delegation_id))?;
    if let Some(row) = existing {
        let _guard = repo_lock::lock(Path::new(&row.common_dir)).await;
        if row.status != WorktreeStatus::Creating {
            if is_real_dir(Path::new(&row.path)) {
                // A re-attach that failed after `worktree add` left the
                // folder back but the row `missing`; the folder decides.
                if row.status == WorktreeStatus::Missing {
                    let st = state.lock().await;
                    registry::set_status(&st.db, &row.id, WorktreeStatus::Active)?;
                    return Ok(summary(&registry::get(&st.db, &row.id)?.unwrap_or(row)));
                }
                return Ok(summary(&row));
            }
            // The registered folder was replaced by a link: drop that entry
            // (never its target) so the branch can be re-attached there.
            if std::fs::symlink_metadata(&row.path).is_ok() {
                remove_entry(Path::new(&row.path))?;
            }
            if let Some(row) = reattach(state, git, &session, row.clone()).await? {
                return Ok(summary(&row));
            }
        }
        remove_worktree(git, &row).await?;
        registry::remove(&state.lock().await.db, &row.id)?;
    }

    let _guard = repo_lock::lock(Path::new(&session.common_dir)).await;
    {
        // The subagent starts from what the parent has written so far.
        let _permit = checkpoint_session(
            state,
            git,
            session_id,
            &session,
            "pi: checkpoint before subagent",
        )
        .await?;
    }

    let name = format!("{}-{}", short_id(session_id), short_id(delegation_id));
    let parent = Path::new(&session.path)
        .parent()
        .ok_or_else(|| WorktreeError::new("WORKTREE_INTERNAL", "session worktree has no parent"))?;
    let root = parent.join(&name);
    if root.exists() {
        return Err(WorktreeError::new(
            "WORKTREE_PATH_EXISTS",
            format!("{} already exists", root.display()),
        ));
    }
    let branch = format!("{BRANCH_NAMESPACE}/{name}");
    ensure_branch_free(git, Path::new(&session.path), &branch).await?;
    let root_text = root.to_string_lossy().into_owned();
    let project_path = sessions::session_summary(&state.lock().await.db, session_id)?
        .and_then(|summary| summary.project_path);

    let row = {
        let st = state.lock().await;
        let port = registry::next_port_base(&st.db, port_is_free)?;
        registry::insert(
            &st.db,
            &NewWorktree {
                session_id,
                delegation_id: Some(delegation_id),
                path: &root_text,
                common_dir: &session.common_dir,
                prefix: &session.prefix,
                branch: &branch,
                owner_branch: &session.branch,
                port_base: port,
            },
        )?
    };

    let session_root = Path::new(&session.path);
    let created: Result<(), WorktreeError> = async {
        git.run(
            session_root,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                &branch,
                &root_text,
                &merge::head_ref(&session.branch),
            ],
        )
        .await?;
        git.run(
            &root,
            &[
                "worktree",
                "lock",
                "--reason",
                &format!("PI-Desktop subagent {delegation_id}"),
                &root_text,
            ],
        )
        .await?;
        if let Some(project) = project_path.as_deref() {
            let toplevel = git
                .run(Path::new(project), &["rev-parse", "--show-toplevel"])
                .await?;
            copy_included(git, Path::new(toplevel.trim()), &root).await?;
        }
        Ok(())
    }
    .await;
    if let Err(error) = created {
        discard_failed_creation(state, git, &row).await;
        return Err(error);
    }

    let (row, command) = {
        let st = state.lock().await;
        registry::set_status(&st.db, &row.id, WorktreeStatus::Active)?;
        let command = match project_path.as_deref() {
            Some(project) => setup_command(&st.db, project)?,
            None => None,
        };
        let status = if command.is_some() {
            SetupStatus::Running
        } else {
            SetupStatus::None
        };
        registry::set_setup_status(&st.db, &row.id, status, None)?;
        (registry::get(&st.db, &row.id)?.unwrap_or(row), command)
    };
    if let (Some(command), Some(project)) = (command, project_path) {
        tokio::spawn(run_setup(state.clone(), row.clone(), project, command));
    }
    Ok(summary(&row))
}

/// Settle a subagent's worktree when it ends. `merge` is true for a completed
/// run; a failed or stopped run keeps changes for a resume.
pub async fn settle_delegate_worktree(
    state: &SharedState,
    git: &GitRunner,
    session_id: &str,
    delegation_id: &str,
    merge: bool,
) -> Result<DelegateSettlement, WorktreeError> {
    let Some(row) = registry::for_owner(&state.lock().await.db, session_id, Some(delegation_id))?
    else {
        return Ok(DelegateSettlement::None);
    };
    let _guard = repo_lock::lock(Path::new(&row.common_dir)).await;
    let worktree = Path::new(&row.path);
    if !is_real_dir(worktree) {
        // The folder vanished; its branch may still hold committed work,
        // which a resume re-attaches instead of deleting.
        if unmerged_commits(git, &row).await? > 0 {
            registry::set_status(&state.lock().await.db, &row.id, WorktreeStatus::Missing)?;
            return Ok(DelegateSettlement::Kept);
        }
        drop_row(state, git, &row).await?;
        return Ok(DelegateSettlement::NoChanges);
    }

    let resolving = merge_in_progress(git, worktree).await?;
    if !merge {
        let changed = resolving
            || commits_ahead(git, &row).await? > 0
            || !merge::worktree_status(git, worktree).await?.is_empty();
        if changed {
            return Ok(DelegateSettlement::Kept);
        }
        drop_row(state, git, &row).await?;
        return Ok(DelegateSettlement::NoChanges);
    }

    // An unfinished merge is concluded by `land` once its markers are gone;
    // committing it here could seal unresolved conflict markers.
    if !resolving {
        ensure_own_branch(git, &row).await?;
        commit_all(git, worktree, "pi: subagent changes").await?;
    }
    let commits = commits_ahead(git, &row).await?;
    if commits == 0 && !resolving {
        drop_row(state, git, &row).await?;
        return Ok(DelegateSettlement::NoChanges);
    }

    let session = session_row(state, session_id).await?;
    let permit = match checkpoint_session(
        state,
        git,
        session_id,
        &session,
        "pi: checkpoint before merging subagent",
    )
    .await
    {
        Ok(permit) => permit,
        Err(error) => {
            return Ok(DelegateSettlement::NotMerged {
                reason: error.message,
            })
        }
    };
    let landed = land(git, &row, Path::new(&session.path), "pi: subagent changes").await;
    drop(permit);
    match landed {
        Ok(()) => {
            drop_row(state, git, &row).await?;
            Ok(DelegateSettlement::Merged { commits })
        }
        Err(error) if error.code == "WORKTREE_CONFLICT" => {
            registry::set_status(&state.lock().await.db, &row.id, WorktreeStatus::Conflict)?;
            Ok(DelegateSettlement::Conflict { files: error.files })
        }
        Err(error) => Ok(DelegateSettlement::NotMerged {
            reason: error.message,
        }),
    }
}

/// Remove a delegate worktree, branch, and row; the caller holds the repo lock.
async fn drop_row(
    state: &SharedState,
    git: &GitRunner,
    row: &WorktreeRow,
) -> Result<(), WorktreeError> {
    remove_worktree(git, row).await?;
    registry::remove(&state.lock().await.db, &row.id)?;
    Ok(())
}

fn summary(row: &WorktreeRow) -> WorktreeSummary {
    WorktreeSummary {
        branch: row.branch.clone(),
        status: row.status,
        setup_status: row.setup_status,
    }
}

#[cfg(test)]
mod tests;
