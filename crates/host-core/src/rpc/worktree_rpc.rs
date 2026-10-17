//! `worktree.*` methods and the isolated-session hooks of `session.create` and
//! `session.delete` (ADR 0329). Callers name a session or a project; no
//! method accepts a worktree path.

use std::path::Path;
use std::sync::Arc;

use serde_json::{json, Value};
use tokio::sync::Mutex;

use super::{rpc_err, JsonRpcError};
use crate::session_worktrees::git::GitRunner;
use crate::session_worktrees::{delegate, lifecycle, merge, probe, registry, WorktreeError};
use crate::sessions;
use crate::state::AppState;

/// Numeric JSON-RPC code shared by every `WORKTREE_*` error; `errorCode`
/// carries the specific reason.
const WORKTREE_RPC_CODE: i64 = 1025;

pub(super) fn to_rpc(error: WorktreeError) -> JsonRpcError {
    let mut data = json!({ "errorCode": error.code });
    if !error.files.is_empty() {
        data["files"] = json!(error.files);
    }
    JsonRpcError {
        code: WORKTREE_RPC_CODE,
        message: error.message,
        data: Some(data),
    }
}

/// Code of a refusal to isolate a remote-host project: its path names a
/// workspace on another machine, not a local git checkout.
const REMOTE_UNSUPPORTED: &str = "WORKTREE_REMOTE_UNSUPPORTED";

/// Isolated sessions need a local checkout; remote-host projects run their
/// tools on the remote machine and are refused before anything is created.
pub(super) fn ensure_local_project(
    db: &crate::db::Database,
    project_path: &str,
) -> Result<(), JsonRpcError> {
    let remote = db
        .remote_workspace_for_path(project_path)
        .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?;
    match remote {
        Some(_) => Err(to_rpc(WorktreeError::new(
            REMOTE_UNSUPPORTED,
            "isolated sessions are not available for remote projects",
        ))),
        None => Ok(()),
    }
}

fn str_param<'a>(params: &'a Value, name: &str) -> Result<&'a str, JsonRpcError> {
    params
        .get(name)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| rpc_err(1002, format!("{name} required"), "INVALID_PARAMS"))
}

pub(super) async fn handle(
    state: &Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    let git = GitRunner::default();
    match method {
        // Whether a project can host isolated sessions, for the create switch
        // (PRD R6) and the "uncommitted changes are not included" notice (R2b).
        "worktree.probe" => {
            let project = str_param(&params, "projectPath")?;
            if let Err(error) = ensure_local_project(&state.lock().await.db, project) {
                let data = error.data.unwrap_or_default();
                return Ok(json!({
                    "available": false,
                    "errorCode": data["errorCode"],
                    "message": error.message,
                }));
            }
            match probe::probe(&git, Path::new(project)).await {
                Ok(_) => {
                    let dirty = !merge::worktree_status(&git, Path::new(project))
                        .await
                        .map_err(to_rpc)?
                        .is_empty();
                    Ok(json!({ "available": true, "uncommittedChanges": dirty }))
                }
                Err(error) => Ok(json!({
                    "available": false,
                    "errorCode": error.code(),
                    "message": error.to_string(),
                })),
            }
        }
        "worktree.preview" => {
            let session_id = str_param(&params, "sessionId")?;
            let preview = lifecycle::preview_session(state, &git, session_id)
                .await
                .map_err(to_rpc)?;
            Ok(json!({ "preview": preview }))
        }
        "worktree.merge" => {
            let session_id = str_param(&params, "sessionId")?;
            let token = str_param(&params, "previewToken")?;
            let outcome = lifecycle::merge_session(state, &git, session_id, token)
                .await
                .map_err(to_rpc)?;
            Ok(json!({ "outcome": outcome }))
        }
        // "Sync from project": `behind` sizes the menu item, `sync` merges
        // the project's branch into the session worktree.
        "worktree.behind" => {
            let session_id = str_param(&params, "sessionId")?;
            let commits = lifecycle::behind_session(state, &git, session_id)
                .await
                .map_err(to_rpc)?;
            Ok(json!({ "commits": commits }))
        }
        "worktree.behindAll" => {
            let behind = lifecycle::behind_all(state, &git).await.map_err(to_rpc)?;
            Ok(json!(behind))
        }
        "worktree.sync" => {
            let session_id = str_param(&params, "sessionId")?;
            let outcome = lifecycle::sync_session(state, &git, session_id)
                .await
                .map_err(to_rpc)?;
            Ok(json!({ "outcome": outcome }))
        }
        "worktree.pendingWork" => {
            let session_id = str_param(&params, "sessionId")?;
            let pending = lifecycle::pending_work(state, &git, session_id)
                .await
                .map_err(to_rpc)?;
            Ok(json!({ "pending": pending }))
        }
        "worktree.setupLog" => {
            let session_id = str_param(&params, "sessionId")?;
            let st = state.lock().await;
            let row = registry::for_owner(&st.db, session_id, None)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({
                "setupStatus": row.as_ref().and_then(|row| row.setup_status),
                "log": row.and_then(|row| row.setup_log),
            }))
        }
        // For Electron Main's "Reveal in folder" only; never forwarded to
        // the renderer.
        "worktree.location" => {
            let session_id = str_param(&params, "sessionId")?;
            let st = state.lock().await;
            let root = lifecycle::tool_root(&st.db, session_id)
                .map_err(to_rpc)?
                .ok_or_else(|| {
                    to_rpc(WorktreeError::new(
                        "WORKTREE_NOT_ISOLATED",
                        "the session has no isolated worktree",
                    ))
                })?;
            Ok(json!({ "path": root }))
        }
        // Called by the agent runtime for Write/Edit subagents of an
        // isolated session; `delegationId` is the subagent's chain id.
        "worktree.delegate.create" => {
            let session_id = str_param(&params, "sessionId")?;
            let delegation_id = str_param(&params, "delegationId")?;
            let worktree =
                delegate::create_delegate_worktree(state, &git, session_id, delegation_id)
                    .await
                    .map_err(to_rpc)?;
            Ok(json!({ "worktree": worktree }))
        }
        "worktree.delegate.settle" => {
            let session_id = str_param(&params, "sessionId")?;
            let delegation_id = str_param(&params, "delegationId")?;
            let merge = params
                .get("merge")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let settlement =
                delegate::settle_delegate_worktree(state, &git, session_id, delegation_id, merge)
                    .await
                    .map_err(to_rpc)?;
            Ok(json!({ "settlement": settlement }))
        }
        "worktree.setupCommand.get" => {
            let project = str_param(&params, "projectPath")?;
            let st = state.lock().await;
            let command = lifecycle::setup_command(&st.db, project)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "command": command }))
        }
        "worktree.setupCommand.set" => {
            let project = str_param(&params, "projectPath")?;
            let command = params.get("command").and_then(Value::as_str);
            let st = state.lock().await;
            let updated = lifecycle::set_setup_command(&st.db, project, command)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            if !updated {
                return Err(rpc_err(1007, "project not found", "NOT_FOUND"));
            }
            Ok(json!({ "ok": true }))
        }
        _ => Err(rpc_err(
            -32601,
            format!("method not found: {method}"),
            "NOT_FOUND",
        )),
    }
}

/// Give a just-created session its worktree. On failure the session is
/// deleted again, so no half-created isolated session remains (design §5.1).
pub(super) async fn isolate_new_session(
    state: &Arc<Mutex<AppState>>,
    session_id: &str,
    project_path: &str,
) -> Result<lifecycle::CreatedWorktree, JsonRpcError> {
    match lifecycle::create_session_worktree(state, &GitRunner::default(), session_id, project_path)
        .await
    {
        Ok(created) => Ok(created),
        Err(error) => {
            let st = state.lock().await;
            if let Err(cleanup) = sessions::delete_session(&st.db, session_id) {
                tracing::warn!(%cleanup, "could not delete a session whose worktree failed");
            }
            Err(to_rpc(error))
        }
    }
}

/// Remove an isolated session's worktrees and branches before the session row
/// is deleted. A failure keeps the session (nothing is half-removed silently).
pub(super) async fn remove_before_delete(
    state: &Arc<Mutex<AppState>>,
    session_id: &str,
) -> Result<(), JsonRpcError> {
    let has_worktrees = {
        let st = state.lock().await;
        !registry::for_session(&st.db, session_id)
            .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?
            .is_empty()
    };
    if !has_worktrees {
        return Ok(());
    }
    lifecycle::remove_session_worktrees(state, &GitRunner::default(), session_id)
        .await
        .map_err(to_rpc)
}

/// After any deletion, remove worktrees orphaned by other deletion paths.
pub(super) fn spawn_orphan_cleanup(state: &Arc<Mutex<AppState>>) {
    let state = state.clone();
    tokio::spawn(async move {
        lifecycle::cleanup_orphans(&state, &GitRunner::default()).await;
    });
}

#[cfg(test)]
mod tests;
