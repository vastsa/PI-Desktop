use anyhow::{anyhow, Result};
use chrono::{DateTime, Local};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use uuid::Uuid;

use crate::artifacts;
use crate::audit;
use crate::db::{ms_to_ts, now_ms, Database, PLAN_APPROVAL_TIMEOUT_MS};
use crate::sessions;

pub const PLAN_MAX_MARKDOWN_BYTES: usize = 512 * 1024;

pub const STATUS_PENDING: &str = "pending";
pub const STATUS_APPROVED: &str = "approved";
pub const STATUS_REJECTED: &str = "rejected";
pub const STATUS_EXPIRED: &str = "expired";
pub const STATUS_INTERRUPTED: &str = "interrupted";

pub const EXECUTION_QUEUED: &str = "queued";
pub const EXECUTION_RUNNING: &str = "running";
pub const EXECUTION_COMPLETED: &str = "completed";
pub const EXECUTION_INTERRUPTED: &str = "interrupted";

/// Approval kinds (D198). Plan and Goal share this pipeline; the kind decides
/// the operating mode that owns the approval and the artifact directory.
pub const KIND_PLAN: &str = "plan";
pub const KIND_GOAL: &str = "goal";

/// Map a wire kind onto a `'static` literal so SQL and paths can never carry
/// caller-controlled text.
pub fn normalize_kind(value: &str) -> Option<&'static str> {
    match value {
        KIND_PLAN => Some(KIND_PLAN),
        KIND_GOAL => Some(KIND_GOAL),
        _ => None,
    }
}

/// The approval kind a session's durable mode submits, if any.
pub fn kind_for_mode(mode: &str) -> Option<&'static str> {
    normalize_kind(mode)
}

// `kind` is appended last so the historical column indexes stay stable.
const PROPOSAL_COLUMNS: &str = "request_id, session_id, turn_id, tool_call_id,
    plan_json, title, question, status, created_at, updated_at, expires_at,
    resolved_at, action, target_permission_mode, feedback, error_code,
    artifact_relative_path, artifact_sha256, artifact_size_bytes, version,
    execution_id, execution_state, kind";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlanArtifact {
    pub relative_path: String,
    pub sha256: String,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlanProposal {
    pub id: String,
    pub session_id: String,
    pub turn_id: String,
    pub tool_call_id: String,
    /// `plan` or `goal`; legacy rows read back as `plan`.
    pub kind: String,
    pub plan: String,
    pub markdown: String,
    pub title: String,
    pub question: String,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_permission_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artifact: Option<PlanArtifact>,
    pub version: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution_state: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlanExecution {
    pub id: String,
    pub proposal_id: String,
    pub session_id: String,
    /// `plan` or `goal`; selects the execution instruction in the sidecar.
    pub kind: String,
    pub plan: String,
    pub title: String,
    pub question: String,
    pub artifact: PlanArtifact,
    pub target_permission_mode: String,
    pub state: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanResolution {
    pub status: String,
    pub proposal: PlanProposal,
    pub action: Option<String>,
    pub target_permission_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution: Option<PlanExecution>,
}

#[derive(Debug, Default)]
pub struct PlanManager;

pub struct PlanSubmitParams<'a> {
    pub workspace_root: &'a Path,
    pub session_id: &'a str,
    pub turn_id: &'a str,
    pub tool_call_id: &'a str,
    /// Contract kind being submitted; must match the session's durable mode.
    pub kind: &'a str,
    pub title: &'a str,
    pub markdown: &'a str,
    pub question: &'a str,
}

pub struct PlanResolveParams<'a> {
    pub workspace_root: Option<&'a Path>,
    pub proposal_id: &'a str,
    pub session_id: &'a str,
    pub turn_id: &'a str,
    pub tool_call_id: &'a str,
    pub version: Option<i64>,
    pub action: &'a str,
    pub target_permission_mode: Option<&'a str>,
}

fn plan_error(code: &str) -> anyhow::Error {
    anyhow!(code.to_string())
}

/// Expire approvals at the first read or mutation boundary that observes
/// them. The state transition and audit record share one transaction so a
/// timed-out approval can never remain actionable after its error is visible.
pub fn expire_pending_approvals(db: &Database) -> Result<()> {
    let now = now_ms();
    let tx = db.conn().unchecked_transaction()?;
    let expired: Vec<(String, String, String, String)> = {
        let mut stmt = tx.prepare_cached(
            "SELECT request_id, session_id, turn_id, tool_call_id
             FROM plan_approvals
             WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?1",
        )?;
        let rows = stmt.query_map(params![now], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    tx.execute(
        "UPDATE plan_approvals
         SET status = 'expired', resolved_at = ?1, updated_at = ?1,
             error_code = 'PLAN_APPROVAL_TIMEOUT', version = version + 1
         WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?1",
        params![now],
    )?;
    for (proposal_id, session_id, turn_id, tool_call_id) in expired {
        audit::append_tx(
            &tx,
            "plan_approval_expired",
            Some(&session_id),
            json!({
                "proposalId": proposal_id,
                "sessionId": session_id,
                "turnId": turn_id,
                "toolCallId": tool_call_id,
                "status": STATUS_EXPIRED,
                "errorCode": "PLAN_APPROVAL_TIMEOUT"
            }),
        )?;
    }
    tx.commit()?;
    Ok(())
}

fn valid_permission_mode(value: &str) -> bool {
    matches!(value, "ask" | "accept-edits" | "auto")
}

fn proposal_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<PlanProposal> {
    let artifact_path: Option<String> = row.get(16)?;
    let artifact_sha256: Option<String> = row.get(17)?;
    let artifact_size: Option<i64> = row.get(18)?;
    let artifact = match (artifact_path, artifact_sha256, artifact_size) {
        (Some(relative_path), Some(sha256), Some(size_bytes)) => Some(PlanArtifact {
            relative_path,
            sha256,
            size_bytes: size_bytes.max(0) as u64,
        }),
        _ => None,
    };
    let created_at: i64 = row.get(8)?;
    let updated_at: i64 = row.get(9)?;
    let expires_at = row.get::<_, Option<i64>>(10)?.map(ms_to_ts);
    let resolved_at = row.get::<_, Option<i64>>(11)?.map(ms_to_ts);
    // This legacy column remains in SQLite for migration/read safety but is
    // intentionally absent from the current approval contract.
    let _legacy_feedback: Option<String> = row.get(14)?;
    Ok(PlanProposal {
        id: row.get(0)?,
        session_id: row.get(1)?,
        turn_id: row.get(2)?,
        tool_call_id: row.get(3)?,
        kind: row
            .get::<_, Option<String>>(22)?
            .unwrap_or_else(|| KIND_PLAN.to_string()),
        plan: row.get(4)?,
        markdown: row.get(4)?,
        title: row.get(5)?,
        question: row.get(6)?,
        status: row.get(7)?,
        created_at: ms_to_ts(created_at),
        updated_at: ms_to_ts(updated_at),
        expires_at,
        resolved_at,
        action: row.get(12)?,
        target_permission_mode: row.get(13)?,
        error_code: row.get(15)?,
        artifact,
        version: row.get(19)?,
        execution_id: row.get(20)?,
        execution_state: row.get(21)?,
    })
}

fn get_proposal(db: &Database, id: &str) -> Result<Option<PlanProposal>> {
    let sql = format!("SELECT {PROPOSAL_COLUMNS} FROM plan_approvals WHERE request_id = ?1");
    Ok(db
        .conn()
        .prepare_cached(&sql)?
        .query_row(params![id], proposal_from_row)
        .optional()?)
}

/// The approval kind this session may submit, or `None` while it is executing
/// freely in Agent mode.
fn session_submit_kind(db: &Database, session_id: &str) -> Result<Option<&'static str>> {
    let Some(mode) = sessions::session_mode(db, session_id)? else {
        return Err(plan_error("PLAN_SESSION_NOT_FOUND"));
    };
    Ok(kind_for_mode(&mode))
}

fn live_turn_belongs_to_session(db: &Database, session_id: &str, turn_id: &str) -> Result<bool> {
    Ok(db.conn().query_row(
        "SELECT EXISTS(
             SELECT 1 FROM turns
             WHERE id = ?1 AND session_id = ?2 AND status = 'running'
         )",
        params![turn_id, session_id],
        |row| row.get(0),
    )?)
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

fn title_slug(value: &str, fallback: &str) -> String {
    let mut slug = String::new();
    for ch in value.trim().chars() {
        if ch.is_alphanumeric() {
            slug.push(if ch.is_ascii() {
                ch.to_ascii_lowercase()
            } else {
                ch
            });
        } else if !slug.is_empty() && !slug.ends_with('-') {
            slug.push('-');
        }
        if slug.chars().count() >= 64 {
            break;
        }
    }
    while slug.ends_with('-') {
        slug.pop();
    }
    if slug.is_empty() {
        fallback.into()
    } else {
        slug
    }
}

fn plan_filename(kind: &str, title: &str, now: DateTime<Local>, suffix: u32) -> String {
    let slug = title_slug(title, kind);
    let stamp = now.format("%Y%m%d-%H%M");
    if suffix == 1 {
        format!("{slug}-{stamp}.md")
    } else {
        format!("{slug}-{stamp}-{suffix}.md")
    }
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

fn safe_directory(path: &Path, create: bool) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if is_link_or_reparse(&metadata) || !metadata.is_dir() {
                return Err(plan_error("PLAN_ARTIFACT_PATH_UNSAFE"));
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && create => {
            fs::create_dir(path).map_err(|_| plan_error("PLAN_ARTIFACT_PATH_UNSAFE"))?;
            let metadata =
                fs::symlink_metadata(path).map_err(|_| plan_error("PLAN_ARTIFACT_PATH_UNSAFE"))?;
            if is_link_or_reparse(&metadata) || !metadata.is_dir() {
                return Err(plan_error("PLAN_ARTIFACT_PATH_UNSAFE"));
            }
        }
        Err(_) => return Err(plan_error("PLAN_ARTIFACT_PATH_UNSAFE")),
    }
    Ok(())
}

/// Resolve `<workspace>/.pi/<kind>` with every component checked for links.
/// `kind` is always a `'static` literal, never caller text.
fn plan_directory(
    workspace_root: &Path,
    kind: &'static str,
    create: bool,
) -> Result<(PathBuf, PathBuf)> {
    let root = workspace_root
        .canonicalize()
        .map_err(|_| plan_error("PLAN_WORKSPACE_REQUIRED"))?;
    let root_metadata =
        fs::symlink_metadata(&root).map_err(|_| plan_error("PLAN_WORKSPACE_REQUIRED"))?;
    if is_link_or_reparse(&root_metadata) || !root_metadata.is_dir() {
        return Err(plan_error("PLAN_ARTIFACT_PATH_UNSAFE"));
    }
    let pi = root.join(".pi");
    safe_directory(&pi, create)?;
    let directory = pi.join(kind);
    safe_directory(&directory, create)?;
    Ok((root, directory))
}

fn publish_artifact(
    workspace_root: &Path,
    kind: &'static str,
    title: &str,
    markdown: &str,
) -> Result<(PlanArtifact, PathBuf)> {
    let bytes = markdown.as_bytes();
    if bytes.is_empty() {
        return Err(plan_error("PLAN_INVALID_ARGUMENT"));
    }
    if bytes.len() > PLAN_MAX_MARKDOWN_BYTES {
        return Err(plan_error("PLAN_MARKDOWN_TOO_LARGE"));
    }
    let (_root, directory) = plan_directory(workspace_root, kind, true)?;
    let now = Local::now();
    for suffix in 1..=10_000u32 {
        let filename = plan_filename(kind, title, now, suffix);
        let path = directory.join(&filename);
        let mut file = match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return Err(plan_error("PLAN_ARTIFACT_WRITE_FAILED")),
        };
        let write_result = (|| -> Result<()> {
            file.write_all(bytes)
                .map_err(|_| plan_error("PLAN_ARTIFACT_WRITE_FAILED"))?;
            file.sync_all()
                .map_err(|_| plan_error("PLAN_ARTIFACT_WRITE_FAILED"))?;
            Ok(())
        })();
        drop(file);
        if let Err(error) = write_result {
            let _ = fs::remove_file(&path);
            return Err(error);
        }
        let relative_path = format!(".pi/{kind}/{filename}");
        return Ok((
            PlanArtifact {
                relative_path,
                sha256: sha256_hex(bytes),
                size_bytes: bytes.len() as u64,
            },
            path,
        ));
    }
    Err(plan_error("PLAN_ARTIFACT_COLLISION_LIMIT"))
}

fn safe_artifact_path(
    workspace_root: &Path,
    kind: &'static str,
    relative_path: &str,
) -> Result<PathBuf> {
    let (root, _directory) = plan_directory(workspace_root, kind, false)?;
    let components = Path::new(relative_path).components().collect::<Vec<_>>();
    if components.len() != 3
        || components[0] != Component::Normal(".pi".as_ref())
        || components[1] != Component::Normal(kind.as_ref())
    {
        return Err(plan_error("PLAN_ARTIFACT_PATH_UNSAFE"));
    }
    let Some(Component::Normal(filename)) = components.get(2).copied() else {
        return Err(plan_error("PLAN_ARTIFACT_PATH_UNSAFE"));
    };
    let filename = filename
        .to_str()
        .ok_or_else(|| plan_error("PLAN_ARTIFACT_PATH_UNSAFE"))?;
    if filename.is_empty()
        || !filename.ends_with(".md")
        || filename.contains('/')
        || filename.contains('\\')
    {
        return Err(plan_error("PLAN_ARTIFACT_PATH_UNSAFE"));
    }
    let path = root.join(".pi").join(kind).join(filename);
    let metadata =
        fs::symlink_metadata(&path).map_err(|_| plan_error("PLAN_ARTIFACT_NOT_READY"))?;
    if is_link_or_reparse(&metadata) || !metadata.is_file() || !path.starts_with(&root) {
        return Err(plan_error("PLAN_ARTIFACT_PATH_UNSAFE"));
    }
    Ok(path)
}

fn verify_artifact(
    workspace_root: &Path,
    kind: &'static str,
    artifact: &PlanArtifact,
) -> Result<()> {
    let path = safe_artifact_path(workspace_root, kind, &artifact.relative_path)?;
    let bytes = fs::read(path).map_err(|_| plan_error("PLAN_ARTIFACT_NOT_READY"))?;
    if bytes.len() as u64 != artifact.size_bytes {
        return Err(plan_error("PLAN_ARTIFACT_HASH_MISMATCH"));
    }
    if sha256_hex(&bytes) != artifact.sha256 {
        return Err(plan_error("PLAN_ARTIFACT_HASH_MISMATCH"));
    }
    Ok(())
}

fn execution_from_proposal(proposal: &PlanProposal) -> Result<Option<PlanExecution>> {
    let (Some(id), Some(state), Some(artifact), Some(target_permission_mode)) = (
        proposal.execution_id.clone(),
        proposal.execution_state.clone(),
        proposal.artifact.clone(),
        proposal.target_permission_mode.clone(),
    ) else {
        return Ok(None);
    };
    Ok(Some(PlanExecution {
        id,
        proposal_id: proposal.id.clone(),
        session_id: proposal.session_id.clone(),
        kind: proposal.kind.clone(),
        plan: proposal.plan.clone(),
        title: proposal.title.clone(),
        question: proposal.question.clone(),
        artifact,
        target_permission_mode,
        state,
    }))
}

fn resolution_from_proposal(proposal: PlanProposal) -> Result<PlanResolution> {
    let execution = execution_from_proposal(&proposal)?;
    Ok(PlanResolution {
        status: proposal.status.clone(),
        action: proposal.action.clone(),
        target_permission_mode: proposal.target_permission_mode.clone(),
        execution,
        proposal,
    })
}

/// Prevent renderer configuration calls from bypassing durable Plan work.
/// Every persisted configuration change is blocked while its session has
/// active work that must retain the current runtime configuration.
pub fn gate_session_configure(
    db: &Database,
    session_id: &str,
    requested_mode: &str,
    requested_provider_id: Option<&str>,
    requested_model_id: Option<&str>,
    requested_thinking_level: Option<&str>,
    requested_permission_mode: Option<&str>,
) -> Result<()> {
    expire_pending_approvals(db)?;
    let Some((
        current_mode,
        current_provider_id,
        current_model_id,
        current_thinking_level,
        current_permission_mode,
    )) = db
        .conn()
        .query_row(
            "SELECT mode, provider_id, model_id, thinking_level, permission_mode
             FROM sessions WHERE id = ?1",
            params![session_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            },
        )
        .optional()?
    else {
        return Ok(());
    };
    let requested_mode = sessions::normalize_mode(Some(requested_mode));
    let mode_changes = current_mode != requested_mode;
    let provider_changes = requested_provider_id
        .is_some_and(|provider| current_provider_id.as_deref() != Some(provider));
    let model_changes =
        requested_model_id.is_some_and(|model| current_model_id.as_deref() != Some(model));
    let thinking_changes =
        requested_thinking_level.is_some_and(|level| level != current_thinking_level);
    let permission_changes =
        requested_permission_mode.is_some_and(|permission| permission != current_permission_mode);
    if !mode_changes
        && !provider_changes
        && !model_changes
        && !thinking_changes
        && !permission_changes
    {
        return Ok(());
    }
    let blocked: bool = db.conn().query_row(
        "SELECT EXISTS(
             SELECT 1 FROM plan_approvals
             WHERE session_id = ?1 AND status = 'pending'
          ) OR EXISTS(
              SELECT 1 FROM plan_approvals
              WHERE session_id = ?1 AND execution_state IN ('queued', 'running')
          ) OR EXISTS(
              SELECT 1 FROM turns
              WHERE session_id = ?1 AND status = 'running'
          )",
        params![session_id],
        |row| row.get(0),
    )?;
    if blocked {
        return Err(plan_error("PLAN_CONFIGURATION_BLOCKED"));
    }
    Ok(())
}

impl PlanManager {
    pub fn enter(
        &self,
        db: &Database,
        session_id: &str,
        turn_id: &str,
        tool_call_id: &str,
        kind: &str,
    ) -> Result<()> {
        if session_id.trim().is_empty()
            || turn_id.trim().is_empty()
            || tool_call_id.trim().is_empty()
        {
            return Err(plan_error("PLAN_INVALID_ARGUMENT"));
        }
        let Some(kind) = normalize_kind(kind) else {
            return Err(plan_error("PLAN_INVALID_ARGUMENT"));
        };
        let Some(mode) = sessions::session_mode(db, session_id)? else {
            return Err(plan_error("PLAN_SESSION_NOT_FOUND"));
        };
        if mode != "agent" {
            return Err(plan_error("PLAN_ALREADY_ACTIVE"));
        }
        let now = now_ms();
        let tx = db.conn().unchecked_transaction()?;
        let changed = tx
            .prepare_cached(
                "UPDATE sessions SET mode = ?4, updated_at = ?1
                 WHERE id = ?2 AND mode = 'agent'
                   AND EXISTS (
                     SELECT 1 FROM turns
                     WHERE id = ?3 AND session_id = ?2 AND status = 'running'
                   )
                   AND NOT EXISTS (
                     SELECT 1 FROM plan_approvals
                     WHERE session_id = ?2 AND execution_state IN ('queued', 'running')
                   )",
            )?
            .execute(params![now, session_id, turn_id, kind])?;
        if changed == 0 {
            return Err(plan_error("PLAN_APPROVAL_STALE"));
        }
        audit::append_tx(
            &tx,
            "plan_entered",
            Some(session_id),
            json!({
                "sessionId": session_id,
                "turnId": turn_id,
                "toolCallId": tool_call_id,
                "kind": kind,
                "mode": kind
            }),
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn submit(&self, db: &Database, params: PlanSubmitParams<'_>) -> Result<PlanProposal> {
        let PlanSubmitParams {
            workspace_root,
            session_id,
            turn_id,
            tool_call_id,
            kind,
            title,
            markdown,
            question,
        } = params;
        if session_id.trim().is_empty()
            || turn_id.trim().is_empty()
            || tool_call_id.trim().is_empty()
            || title.trim().is_empty()
            || markdown.trim().is_empty()
            || question.trim().is_empty()
        {
            return Err(plan_error("PLAN_INVALID_ARGUMENT"));
        }
        let Some(kind) = normalize_kind(kind) else {
            return Err(plan_error("PLAN_INVALID_ARGUMENT"));
        };
        if markdown.len() > PLAN_MAX_MARKDOWN_BYTES {
            return Err(plan_error("PLAN_MARKDOWN_TOO_LARGE"));
        }
        expire_pending_approvals(db)?;
        // Agent mode has no contract to submit; the other contract mode does,
        // but not this one — those are different failures for the model.
        match session_submit_kind(db, session_id)? {
            None => return Err(plan_error("PLAN_NOT_ACTIVE")),
            Some(active) if active != kind => return Err(plan_error("PLAN_KIND_MISMATCH")),
            Some(_) => {}
        }
        if !live_turn_belongs_to_session(db, session_id, turn_id)? {
            return Err(plan_error("PLAN_APPROVAL_STALE"));
        }
        let has_pending: bool = db.conn().query_row(
            "SELECT EXISTS(
                 SELECT 1 FROM plan_approvals
                 WHERE session_id = ?1 AND status = 'pending'
             )",
            params![session_id],
            |row| row.get(0),
        )?;
        if has_pending {
            return Err(plan_error("PLAN_ALREADY_PENDING"));
        }

        let (artifact, path) = publish_artifact(workspace_root, kind, title, markdown)?;
        let id = Uuid::new_v4().to_string();
        let now = now_ms();
        let insert_result = (|| -> Result<()> {
            let tx = db.conn().unchecked_transaction()?;
            tx.prepare_cached(
                "INSERT INTO plan_approvals (
                     request_id, session_id, turn_id, tool_call_id, kind, plan_json,
                     title, question, status, created_at, updated_at, expires_at,
                     artifact_relative_path, artifact_sha256, artifact_size_bytes,
                     version
                 ) VALUES (?1, ?2, ?3, ?4, ?13, ?5, ?6, ?7, 'pending', ?8, ?8,
                           ?9, ?10, ?11, ?12, 1)",
            )?
            .execute(params![
                id,
                session_id,
                turn_id,
                tool_call_id,
                markdown,
                title.trim(),
                question.trim(),
                now,
                now + PLAN_APPROVAL_TIMEOUT_MS,
                artifact.relative_path,
                artifact.sha256,
                artifact.size_bytes as i64,
                kind,
            ])?;
            artifacts::record_tx(
                &tx,
                session_id,
                &artifact.relative_path,
                "write",
                Some(turn_id),
            )?;
            audit::append_tx(
                &tx,
                "plan_submitted",
                Some(session_id),
                json!({
                    "proposalId": id,
                    "sessionId": session_id,
                    "turnId": turn_id,
                    "toolCallId": tool_call_id,
                    "kind": kind,
                    "title": title.trim(),
                    "question": question.trim(),
                    "artifact": artifact,
                }),
            )?;
            tx.commit()?;
            Ok(())
        })();
        if let Err(error) = insert_result {
            let _ = fs::remove_file(path);
            return Err(error);
        }
        get_proposal(db, &id)?.ok_or_else(|| plan_error("PLAN_NOT_FOUND"))
    }

    pub fn pending_for_session(
        &self,
        db: &Database,
        session_id: Option<&str>,
    ) -> Result<Vec<PlanProposal>> {
        expire_pending_approvals(db)?;
        let sql = format!(
            "SELECT {PROPOSAL_COLUMNS}
             FROM plan_approvals
             WHERE status = 'pending'
               AND (?1 IS NULL OR session_id = ?1)
             ORDER BY created_at DESC"
        );
        let mut stmt = db.conn().prepare_cached(&sql)?;
        let rows = stmt.query_map(params![session_id], proposal_from_row)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn state_for_session(&self, db: &Database, session_id: &str) -> Result<String> {
        expire_pending_approvals(db)?;
        let Some(mode) = sessions::session_mode(db, session_id)? else {
            return Err(plan_error("PLAN_SESSION_NOT_FOUND"));
        };
        if mode == "agent" {
            return Ok("inactive".into());
        }
        if !self.pending_for_session(db, Some(session_id))?.is_empty() {
            return Ok("awaiting_approval".into());
        }
        Ok("planning".into())
    }

    /// The contract kind the session is currently authoring (`plan`/`goal`), or
    /// `None` in Agent mode. Renderers need this to label a planning state.
    pub fn active_kind(&self, db: &Database, session_id: &str) -> Result<Option<&'static str>> {
        session_submit_kind(db, session_id)
    }

    #[cfg(test)]
    pub fn resolution_for(
        &self,
        db: &Database,
        proposal_id: &str,
    ) -> Result<Option<PlanResolution>> {
        expire_pending_approvals(db)?;
        let Some(proposal) = get_proposal(db, proposal_id)? else {
            return Ok(None);
        };
        if proposal.status == STATUS_PENDING {
            return Ok(None);
        }
        Ok(Some(resolution_from_proposal(proposal)?))
    }

    pub fn resolve(&self, db: &Database, params: PlanResolveParams<'_>) -> Result<PlanResolution> {
        let PlanResolveParams {
            workspace_root,
            proposal_id,
            session_id,
            turn_id,
            tool_call_id,
            version,
            action,
            target_permission_mode,
        } = params;
        expire_pending_approvals(db)?;
        let Some(current) = get_proposal(db, proposal_id)? else {
            return Err(plan_error("PLAN_NOT_FOUND"));
        };
        // The stored kind is authoritative: it decides both the artifact
        // directory to verify and the mode the approval must leave behind.
        let kind = normalize_kind(&current.kind).unwrap_or(KIND_PLAN);
        if current.session_id != session_id
            || current.turn_id != turn_id
            || current.tool_call_id != tool_call_id
        {
            return Err(plan_error("PLAN_APPROVAL_STALE"));
        }
        if !matches!(action, "approve" | "reject") {
            return Err(plan_error("PLAN_INVALID_ACTION"));
        }
        if current.status == STATUS_EXPIRED {
            return Err(plan_error("PLAN_APPROVAL_TIMEOUT"));
        }
        let selected = if action == "approve" {
            let Some(selected) = target_permission_mode else {
                return Err(plan_error("PLAN_PERMISSION_MODE_REQUIRED"));
            };
            if !valid_permission_mode(selected) {
                return Err(plan_error("PLAN_PERMISSION_MODE_INVALID"));
            }
            Some(selected)
        } else {
            None
        };
        if current.status != STATUS_PENDING {
            let same_resolution = current.action.as_deref() == Some(action)
                && (action != "approve" || current.target_permission_mode.as_deref() == selected);
            if same_resolution {
                return resolution_from_proposal(current);
            }
            return Err(plan_error("PLAN_APPROVAL_CONFLICT"));
        }
        if version.is_some_and(|version| version != current.version) {
            return Err(plan_error("PLAN_APPROVAL_STALE"));
        }

        if action == "approve" {
            let workspace_root =
                workspace_root.ok_or_else(|| plan_error("PLAN_WORKSPACE_REQUIRED"))?;
            let artifact = current
                .artifact
                .clone()
                .ok_or_else(|| plan_error("PLAN_ARTIFACT_NOT_READY"))?;
            verify_artifact(workspace_root, kind, &artifact)?;
        }
        let now = now_ms();
        let status = match action {
            "approve" => STATUS_APPROVED,
            _ => STATUS_REJECTED,
        };
        let execution_id = (action == "approve").then(|| Uuid::new_v4().to_string());
        let tx = db.conn().unchecked_transaction()?;
        if action == "approve" {
            let active_execution: bool = tx.query_row(
                "SELECT EXISTS(
                     SELECT 1 FROM plan_approvals
                     WHERE session_id = ?1 AND execution_state IN ('queued', 'running')
                 )",
                params![session_id],
                |row| row.get(0),
            )?;
            if active_execution {
                return Err(plan_error("PLAN_EXECUTION_ACTIVE"));
            }
            let changed = tx
                .prepare_cached(
                    "UPDATE sessions
                     SET mode = 'agent', permission_mode = ?1, updated_at = ?2
                     WHERE id = ?3 AND mode = ?4",
                )?
                .execute(params![selected, now, session_id, kind])?;
            if changed == 0 {
                return Err(plan_error("PLAN_NOT_ACTIVE"));
            }
        }
        let changed = tx
            .prepare_cached(
                "UPDATE plan_approvals
                  SET status = ?1, action = ?2, target_permission_mode = ?3,
                      resolved_at = ?4, updated_at = ?4,
                      error_code = NULL, version = version + 1,
                      execution_id = ?5, execution_state = ?6
                  WHERE request_id = ?7 AND session_id = ?8 AND turn_id = ?9
                    AND tool_call_id = ?10 AND status = 'pending' AND version = ?11
                     AND expires_at > ?12",
            )?
            .execute(params![
                status,
                action,
                selected,
                now,
                execution_id,
                (action == "approve").then_some(EXECUTION_QUEUED),
                proposal_id,
                session_id,
                turn_id,
                tool_call_id,
                current.version,
                now,
            ])?;
        if changed != 1 {
            return Err(plan_error("PLAN_APPROVAL_STALE"));
        }
        audit::append_tx(
            &tx,
            "plan_approval_resolved",
            Some(session_id),
            json!({
                "proposalId": proposal_id,
                "sessionId": session_id,
                "turnId": turn_id,
                "toolCallId": tool_call_id,
                "kind": kind,
                "action": action,
                "status": status,
                "targetPermissionMode": selected,
                "executionId": execution_id,
                "executionState": (action == "approve").then_some(EXECUTION_QUEUED),
            }),
        )?;
        tx.commit()?;
        let proposal =
            get_proposal(db, proposal_id)?.ok_or_else(|| plan_error("PLAN_NOT_FOUND"))?;
        resolution_from_proposal(proposal)
    }

    pub fn abort_session(&self, db: &Database, session_id: &str) -> Result<bool> {
        expire_pending_approvals(db)?;
        let ids: Vec<String> = {
            let mut stmt = db.conn().prepare_cached(
                "SELECT request_id FROM plan_approvals
                 WHERE session_id = ?1 AND status = 'pending'",
            )?;
            let rows = stmt.query_map(params![session_id], |row| row.get(0))?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        if ids.is_empty() {
            return Ok(false);
        }
        let now = now_ms();
        let tx = db.conn().unchecked_transaction()?;
        for id in &ids {
            let changed = tx
                .prepare_cached(
                    "UPDATE plan_approvals
                     SET status = 'interrupted', resolved_at = ?1, updated_at = ?1,
                         error_code = 'PLAN_APPROVAL_INTERRUPTED', version = version + 1
                     WHERE request_id = ?2 AND status = 'pending'",
                )?
                .execute(params![now, id])?;
            if changed == 1 {
                let session_id_for_audit: String = tx.query_row(
                    "SELECT session_id FROM plan_approvals WHERE request_id = ?1",
                    params![id],
                    |row| row.get(0),
                )?;
                audit::append_tx(
                    &tx,
                    "plan_approval_terminal",
                    Some(&session_id_for_audit),
                    json!({
                        "proposalId": id,
                        "status": STATUS_INTERRUPTED,
                        "errorCode": "PLAN_APPROVAL_INTERRUPTED"
                    }),
                )?;
            }
        }
        tx.commit()?;
        Ok(true)
    }

    pub fn queued_executions(
        &self,
        db: &Database,
        session_id: Option<&str>,
    ) -> Result<Vec<PlanExecution>> {
        let sql = format!(
            "SELECT {PROPOSAL_COLUMNS}
             FROM plan_approvals
             WHERE execution_state = 'queued'
               AND (?1 IS NULL OR session_id = ?1)
             ORDER BY created_at ASC"
        );
        let mut stmt = db.conn().prepare_cached(&sql)?;
        let rows = stmt.query_map(params![session_id], proposal_from_row)?;
        let mut executions = Vec::new();
        for row in rows {
            let proposal = row?;
            if let Some(execution) = execution_from_proposal(&proposal)? {
                executions.push(execution);
            }
        }
        Ok(executions)
    }

    pub fn claim_execution(&self, db: &Database, execution_id: &str) -> Result<PlanExecution> {
        let Some(current) = self.proposal_for_execution(db, execution_id)? else {
            return Err(plan_error("PLAN_EXECUTION_NOT_FOUND"));
        };
        if current.execution_state.as_deref() != Some(EXECUTION_QUEUED) {
            return Err(plan_error("PLAN_EXECUTION_STALE"));
        }
        let now = now_ms();
        let tx = db.conn().unchecked_transaction()?;
        let changed = tx
            .prepare_cached(
                "UPDATE plan_approvals
                 SET execution_state = 'running', updated_at = ?1, version = version + 1
                 WHERE execution_id = ?2 AND execution_state = 'queued' AND version = ?3",
            )?
            .execute(params![now, execution_id, current.version])?;
        if changed != 1 {
            return Err(plan_error("PLAN_EXECUTION_STALE"));
        }
        audit::append_tx(
            &tx,
            "plan_execution_claimed",
            Some(&current.session_id),
            json!({
                "proposalId": current.id,
                "sessionId": current.session_id,
                "executionId": execution_id,
                "state": EXECUTION_RUNNING,
            }),
        )?;
        tx.commit()?;
        let proposal =
            get_proposal(db, &current.id)?.ok_or_else(|| plan_error("PLAN_NOT_FOUND"))?;
        execution_from_proposal(&proposal)?.ok_or_else(|| plan_error("PLAN_EXECUTION_NOT_FOUND"))
    }

    pub fn finish_execution(
        &self,
        db: &Database,
        execution_id: &str,
        status: &str,
        error_code: Option<&str>,
    ) -> Result<PlanExecution> {
        if !matches!(status, EXECUTION_COMPLETED | EXECUTION_INTERRUPTED) {
            return Err(plan_error("PLAN_EXECUTION_STATUS_INVALID"));
        }
        let Some(current) = self.proposal_for_execution(db, execution_id)? else {
            return Err(plan_error("PLAN_EXECUTION_NOT_FOUND"));
        };
        if matches!(
            current.execution_state.as_deref(),
            Some(EXECUTION_COMPLETED) | Some(EXECUTION_INTERRUPTED)
        ) {
            if current.execution_state.as_deref() == Some(status) {
                return execution_from_proposal(&current)?
                    .ok_or_else(|| plan_error("PLAN_EXECUTION_NOT_FOUND"));
            }
            return Err(plan_error("PLAN_EXECUTION_CONFLICT"));
        }
        if !matches!(
            current.execution_state.as_deref(),
            Some(EXECUTION_QUEUED) | Some(EXECUTION_RUNNING)
        ) {
            return Err(plan_error("PLAN_EXECUTION_STALE"));
        }
        let now = now_ms();
        let stored_error = (status == EXECUTION_INTERRUPTED)
            .then(|| error_code.unwrap_or("PLAN_EXECUTION_INTERRUPTED"));
        let tx = db.conn().unchecked_transaction()?;
        let changed = tx
            .prepare_cached(
                "UPDATE plan_approvals
                 SET execution_state = ?1, updated_at = ?2, version = version + 1,
                     error_code = ?3
                 WHERE execution_id = ?4
                   AND execution_state IN ('queued', 'running') AND version = ?5",
            )?
            .execute(params![
                status,
                now,
                stored_error,
                execution_id,
                current.version
            ])?;
        if changed != 1 {
            return Err(plan_error("PLAN_EXECUTION_STALE"));
        }
        audit::append_tx(
            &tx,
            "plan_execution_finished",
            Some(&current.session_id),
            json!({
                "proposalId": current.id,
                "sessionId": current.session_id,
                "executionId": execution_id,
                "state": status,
                "errorCode": stored_error,
            }),
        )?;
        tx.commit()?;
        let proposal =
            get_proposal(db, &current.id)?.ok_or_else(|| plan_error("PLAN_NOT_FOUND"))?;
        execution_from_proposal(&proposal)?.ok_or_else(|| plan_error("PLAN_EXECUTION_NOT_FOUND"))
    }

    fn proposal_for_execution(
        &self,
        db: &Database,
        execution_id: &str,
    ) -> Result<Option<PlanProposal>> {
        let sql = format!("SELECT {PROPOSAL_COLUMNS} FROM plan_approvals WHERE execution_id = ?1");
        Ok(db
            .conn()
            .prepare_cached(&sql)?
            .query_row(params![execution_id], proposal_from_row)
            .optional()?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sessions;

    fn test_db() -> (tempfile::TempDir, Database) {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
        (dir, db)
    }

    fn plan_session(db: &Database, workspace: &Path) -> sessions::SessionSummary {
        sessions::create_session(
            db,
            Some("Plan".into()),
            Some("plan".into()),
            None,
            None,
            Some(workspace.to_string_lossy().into_owned()),
        )
        .unwrap()
    }

    fn live_turn(db: &Database, session_id: &str) -> String {
        sessions::begin_turn(db, session_id, None, None).unwrap()
    }

    fn submit(manager: &PlanManager, db: &Database, root: &Path, call: &str) -> PlanProposal {
        let session = plan_session(db, root);
        let turn = live_turn(db, &session.id);
        manager
            .submit(
                db,
                PlanSubmitParams {
                    workspace_root: root,
                    session_id: &session.id,
                    turn_id: &turn,
                    tool_call_id: call,
                    kind: KIND_PLAN,
                    title: "Build API",
                    markdown: "# Plan\n- implement",
                    question: "Proceed?",
                },
            )
            .unwrap()
    }

    #[test]
    fn title_slug_and_filename_are_descriptive_and_local_minute_shaped() {
        let now = Local::now();
        let filename = plan_filename(KIND_PLAN, "Build API / v2", now, 1);
        assert!(filename.starts_with("build-api-v2-"));
        assert!(filename.ends_with(".md"));
        assert!(filename.is_ascii());
        assert_eq!(filename.len(), "build-api-v2-YYYYMMDD-HHmm.md".len());
        assert_eq!(title_slug("中文 / ???", KIND_PLAN), "中文");
        assert_eq!(title_slug("中文 / ???", KIND_GOAL), "中文");
        assert!(plan_filename(KIND_PLAN, "中文审批卡片", now, 1).starts_with("中文审批卡片-"));
    }

    #[test]
    fn enter_plan_mode_uses_the_active_turn_and_tool_identity() {
        let (dir, db) = test_db();
        let root = dir.path().join("workspace");
        fs::create_dir_all(&root).unwrap();
        let session = sessions::create_session(
            &db,
            Some("Agent".into()),
            Some("agent".into()),
            None,
            None,
            Some(root.to_string_lossy().into_owned()),
        )
        .unwrap();
        let turn = live_turn(&db, &session.id);

        PlanManager
            .enter(&db, &session.id, &turn, "enter-plan-call", KIND_PLAN)
            .unwrap();

        assert_eq!(
            sessions::session_mode(&db, &session.id).unwrap().as_deref(),
            Some("plan")
        );
        let audit_payload: String = db
            .conn()
            .query_row(
                "SELECT payload_json FROM audit_log WHERE kind = 'plan_entered' ORDER BY id DESC LIMIT 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let audit_payload: serde_json::Value = serde_json::from_str(&audit_payload).unwrap();
        assert_eq!(audit_payload["turnId"], turn);
        assert_eq!(audit_payload["toolCallId"], "enter-plan-call");
    }

    #[test]
    fn enter_plan_mode_rejects_a_stale_turn_without_a_mode_write() {
        let (dir, db) = test_db();
        let root = dir.path().join("workspace");
        fs::create_dir_all(&root).unwrap();
        let session = sessions::create_session(
            &db,
            Some("Agent".into()),
            Some("agent".into()),
            None,
            None,
            Some(root.to_string_lossy().into_owned()),
        )
        .unwrap();

        let error = PlanManager
            .enter(&db, &session.id, "stale-turn", "enter-plan-call", KIND_PLAN)
            .unwrap_err();
        assert_eq!(error.to_string(), "PLAN_APPROVAL_STALE");
        assert_eq!(
            sessions::session_mode(&db, &session.id).unwrap().as_deref(),
            Some("agent")
        );
    }

    #[test]
    fn publication_collides_without_overwriting() {
        let (dir, db) = test_db();
        let root = dir.path().join("workspace");
        fs::create_dir_all(&root).unwrap();
        let manager = PlanManager;
        let first = submit(&manager, &db, &root, "call-1");
        let second_session = plan_session(&db, &root);
        let turn2 = live_turn(&db, &second_session.id);
        let second = manager
            .submit(
                &db,
                PlanSubmitParams {
                    workspace_root: &root,
                    session_id: &second_session.id,
                    turn_id: &turn2,
                    tool_call_id: "call-2",
                    kind: KIND_PLAN,
                    title: "Build API",
                    markdown: "second",
                    question: "Proceed?",
                },
            )
            .unwrap();
        assert_ne!(
            first.artifact.as_ref().unwrap().relative_path,
            second.artifact.as_ref().unwrap().relative_path
        );
        assert_eq!(
            fs::read(root.join(&first.artifact.unwrap().relative_path)).unwrap(),
            b"# Plan\n- implement"
        );
    }

    #[test]
    fn oversized_markdown_is_rejected_before_artifact_creation() {
        let (dir, db) = test_db();
        let root = dir.path().join("workspace");
        fs::create_dir_all(&root).unwrap();
        let session = plan_session(&db, &root);
        let turn = live_turn(&db, &session.id);
        let error = PlanManager
            .submit(
                &db,
                PlanSubmitParams {
                    workspace_root: &root,
                    session_id: &session.id,
                    turn_id: &turn,
                    tool_call_id: "call-1",
                    kind: KIND_PLAN,
                    title: "Too large",
                    markdown: &"x".repeat(PLAN_MAX_MARKDOWN_BYTES + 1),
                    question: "Proceed?",
                },
            )
            .unwrap_err();
        assert_eq!(error.to_string(), "PLAN_MARKDOWN_TOO_LARGE");
        assert!(!root.join(".pi").exists());
    }

    #[cfg(unix)]
    #[test]
    fn existing_plan_symlink_is_rejected() {
        let (dir, db) = test_db();
        let root = dir.path().join("workspace");
        let outside = dir.path().join("outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::create_dir_all(root.join(".pi")).unwrap();
        std::os::unix::fs::symlink(&outside, root.join(".pi/plan")).unwrap();
        let session = plan_session(&db, &root);
        let turn = live_turn(&db, &session.id);
        let error = PlanManager
            .submit(
                &db,
                PlanSubmitParams {
                    workspace_root: &root,
                    session_id: &session.id,
                    turn_id: &turn,
                    tool_call_id: "call-1",
                    kind: KIND_PLAN,
                    title: "Plan",
                    markdown: "body",
                    question: "?",
                },
            )
            .unwrap_err();
        assert_eq!(error.to_string(), "PLAN_ARTIFACT_PATH_UNSAFE");
    }

    #[test]
    fn pending_rows_are_interrupted_during_database_restart() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pi.sqlite");
        let (session_id, proposal_id);
        let root = dir.path().join("workspace");
        fs::create_dir_all(&root).unwrap();
        {
            let db = Database::open(&path).unwrap();
            let session = plan_session(&db, &root);
            session_id = session.id;
            let turn = live_turn(&db, &session_id);
            proposal_id = PlanManager
                .submit(
                    &db,
                    PlanSubmitParams {
                        workspace_root: &root,
                        session_id: &session_id,
                        turn_id: &turn,
                        tool_call_id: "call-1",
                        kind: KIND_PLAN,
                        title: "Plan",
                        markdown: "body",
                        question: "?",
                    },
                )
                .unwrap()
                .id;
        }
        let db = Database::open(&path).unwrap();
        let pending = PlanManager
            .pending_for_session(&db, Some(&session_id))
            .unwrap();
        assert!(pending.is_empty());
        let proposal = get_proposal(&db, &proposal_id).unwrap().unwrap();
        assert_eq!(proposal.status, STATUS_INTERRUPTED);
        assert_eq!(
            proposal.error_code.as_deref(),
            Some("PLAN_APPROVAL_INTERRUPTED")
        );
    }

    #[test]
    fn reject_has_no_side_effects_and_allows_new_turn_submission() {
        let (dir, db) = test_db();
        let root = dir.path().join("workspace");
        fs::create_dir_all(&root).unwrap();
        let manager = PlanManager;
        let proposal = submit(&manager, &db, &root, "call-1");
        let first_artifact_path = proposal.artifact.as_ref().unwrap().relative_path.clone();
        let first_artifact_bytes = fs::read(root.join(&first_artifact_path)).unwrap();
        let before = sessions::get_session(&db, &proposal.session_id)
            .unwrap()
            .unwrap()
            .summary;
        let result = manager
            .resolve(
                &db,
                PlanResolveParams {
                    workspace_root: Some(&root),
                    proposal_id: &proposal.id,
                    session_id: &proposal.session_id,
                    turn_id: &proposal.turn_id,
                    tool_call_id: &proposal.tool_call_id,
                    version: Some(proposal.version),
                    action: "reject",
                    target_permission_mode: None,
                },
            )
            .unwrap();
        let after = sessions::get_session(&db, &proposal.session_id)
            .unwrap()
            .unwrap()
            .summary;
        assert_eq!(result.status, STATUS_REJECTED);
        assert_eq!(before.mode, after.mode);
        assert_eq!(before.permission_mode, after.permission_mode);
        assert!(result.execution.is_none());
        assert!(manager
            .pending_for_session(&db, Some(&proposal.session_id))
            .unwrap()
            .is_empty());
        let ended =
            sessions::end_turn(&db, &proposal.turn_id, "completed", None, None, false).unwrap();
        assert!(ended.updated);
        let next_turn = live_turn(&db, &proposal.session_id);
        let revised = manager
            .submit(
                &db,
                PlanSubmitParams {
                    workspace_root: &root,
                    session_id: &proposal.session_id,
                    turn_id: &next_turn,
                    tool_call_id: "call-2",
                    kind: KIND_PLAN,
                    title: "Build API revised",
                    markdown: "# Plan\n- revise",
                    question: "Proceed with the revision?",
                },
            )
            .unwrap();
        assert_ne!(revised.id, proposal.id);
        assert_eq!(revised.status, STATUS_PENDING);
        assert_eq!(revised.turn_id, next_turn);
        assert_ne!(
            revised.artifact.as_ref().unwrap().relative_path,
            first_artifact_path
        );
        assert_eq!(
            fs::read(root.join(&first_artifact_path)).unwrap(),
            first_artifact_bytes
        );
        assert_eq!(
            manager
                .pending_for_session(&db, Some(&proposal.session_id))
                .unwrap()
                .iter()
                .map(|pending| pending.id.as_str())
                .collect::<Vec<_>>(),
            vec![revised.id.as_str()]
        );
        let rejected = get_proposal(&db, &proposal.id).unwrap().unwrap();
        assert_eq!(rejected.status, STATUS_REJECTED);
        assert_eq!(
            rejected.artifact.unwrap().relative_path,
            first_artifact_path
        );
        let execution_count: i64 = db
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM plan_approvals WHERE execution_id IS NOT NULL",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(execution_count, 0);
    }

    #[test]
    fn approval_switches_session_and_creates_outbox_atomically() {
        let (dir, db) = test_db();
        let root = dir.path().join("workspace");
        fs::create_dir_all(&root).unwrap();
        let manager = PlanManager;
        let proposal = submit(&manager, &db, &root, "call-1");
        let result = manager
            .resolve(
                &db,
                PlanResolveParams {
                    workspace_root: Some(&root),
                    proposal_id: &proposal.id,
                    session_id: &proposal.session_id,
                    turn_id: &proposal.turn_id,
                    tool_call_id: &proposal.tool_call_id,
                    version: Some(proposal.version),
                    action: "approve",
                    target_permission_mode: Some("accept-edits"),
                },
            )
            .unwrap();
        let execution = result.execution.unwrap();
        assert_eq!(result.status, STATUS_APPROVED);
        assert_eq!(execution.state, EXECUTION_QUEUED);
        let session = sessions::get_session(&db, &proposal.session_id)
            .unwrap()
            .unwrap()
            .summary;
        assert_eq!(session.mode, "agent");
        assert_eq!(session.permission_mode, "accept-edits");
        assert!(db.get_setting("app").unwrap().is_none());
        assert_eq!(manager.queued_executions(&db, None).unwrap().len(), 1);
    }

    #[test]
    fn duplicate_resolution_returns_committed_result_and_conflict_is_stale() {
        let (dir, db) = test_db();
        let root = dir.path().join("workspace");
        fs::create_dir_all(&root).unwrap();
        let manager = PlanManager;
        let proposal = submit(&manager, &db, &root, "call-1");
        let first = manager
            .resolve(
                &db,
                PlanResolveParams {
                    workspace_root: Some(&root),
                    proposal_id: &proposal.id,
                    session_id: &proposal.session_id,
                    turn_id: &proposal.turn_id,
                    tool_call_id: &proposal.tool_call_id,
                    version: Some(proposal.version),
                    action: "approve",
                    target_permission_mode: Some("auto"),
                },
            )
            .unwrap();
        let duplicate = manager
            .resolve(
                &db,
                PlanResolveParams {
                    workspace_root: Some(&root),
                    proposal_id: &proposal.id,
                    session_id: &proposal.session_id,
                    turn_id: &proposal.turn_id,
                    tool_call_id: &proposal.tool_call_id,
                    version: Some(proposal.version),
                    action: "approve",
                    target_permission_mode: Some("auto"),
                },
            )
            .unwrap();
        assert_eq!(duplicate.proposal.version, first.proposal.version);
        assert_eq!(duplicate.execution.unwrap().id, first.execution.unwrap().id);
        assert_eq!(
            manager
                .resolve(
                    &db,
                    PlanResolveParams {
                        workspace_root: Some(&root),
                        proposal_id: &proposal.id,
                        session_id: &proposal.session_id,
                        turn_id: &proposal.turn_id,
                        tool_call_id: &proposal.tool_call_id,
                        version: Some(proposal.version),
                        action: "reject",
                        target_permission_mode: None,
                    },
                )
                .unwrap_err()
                .to_string(),
            "PLAN_APPROVAL_CONFLICT"
        );
    }

    #[test]
    fn approval_deadline_expires_lazily_and_rejects_late_resolution() {
        let (dir, db) = test_db();
        let root = dir.path().join("workspace");
        fs::create_dir_all(&root).unwrap();
        let manager = PlanManager;
        let proposal = submit(&manager, &db, &root, "call-1");
        let expires_at = proposal
            .expires_at
            .as_deref()
            .map(crate::db::ts_to_ms)
            .unwrap();
        assert!(expires_at >= now_ms() + PLAN_APPROVAL_TIMEOUT_MS - 1_000);
        db.conn()
            .execute(
                "UPDATE plan_approvals SET expires_at = ?1 WHERE request_id = ?2",
                params![now_ms() - 1, proposal.id],
            )
            .unwrap();

        assert!(manager
            .pending_for_session(&db, Some(&proposal.session_id))
            .unwrap()
            .is_empty());
        let stored = get_proposal(&db, &proposal.id).unwrap().unwrap();
        assert_eq!(stored.status, STATUS_EXPIRED);
        assert_eq!(stored.error_code.as_deref(), Some("PLAN_APPROVAL_TIMEOUT"));
        assert_eq!(
            manager
                .state_for_session(&db, &proposal.session_id)
                .unwrap(),
            "planning"
        );
        assert_eq!(
            manager
                .resolution_for(&db, &proposal.id)
                .unwrap()
                .unwrap()
                .status,
            STATUS_EXPIRED
        );

        sessions::end_turn(&db, &proposal.turn_id, "aborted", None, None, false).unwrap();
        assert!(gate_session_configure(
            &db,
            &proposal.session_id,
            "agent",
            None,
            None,
            None,
            Some("auto"),
        )
        .is_ok());
        assert_eq!(
            manager
                .resolve(
                    &db,
                    PlanResolveParams {
                        workspace_root: Some(&root),
                        proposal_id: &proposal.id,
                        session_id: &proposal.session_id,
                        turn_id: &proposal.turn_id,
                        tool_call_id: &proposal.tool_call_id,
                        version: Some(proposal.version),
                        action: "reject",
                        target_permission_mode: None,
                    },
                )
                .unwrap_err()
                .to_string(),
            "PLAN_APPROVAL_TIMEOUT"
        );
    }

    #[test]
    fn claim_and_finish_are_durable_cas_transitions() {
        let (dir, db) = test_db();
        let root = dir.path().join("workspace");
        fs::create_dir_all(&root).unwrap();
        let manager = PlanManager;
        let proposal = submit(&manager, &db, &root, "call-1");
        let approved = manager
            .resolve(
                &db,
                PlanResolveParams {
                    workspace_root: Some(&root),
                    proposal_id: &proposal.id,
                    session_id: &proposal.session_id,
                    turn_id: &proposal.turn_id,
                    tool_call_id: &proposal.tool_call_id,
                    version: Some(proposal.version),
                    action: "approve",
                    target_permission_mode: Some("auto"),
                },
            )
            .unwrap();
        let id = approved.execution.as_ref().unwrap().id.clone();
        let running = manager.claim_execution(&db, &id).unwrap();
        assert_eq!(running.state, EXECUTION_RUNNING);
        assert!(manager.claim_execution(&db, &id).is_err());
        let completed = manager
            .finish_execution(&db, &id, EXECUTION_COMPLETED, None)
            .unwrap();
        assert_eq!(completed.state, EXECUTION_COMPLETED);
        assert!(manager
            .finish_execution(&db, &id, EXECUTION_INTERRUPTED, Some("late"))
            .is_err());
    }

    #[test]
    fn configure_gate_blocks_pending_and_active_execution_changes() {
        let (dir, db) = test_db();
        let root = dir.path().join("workspace");
        fs::create_dir_all(&root).unwrap();
        let manager = PlanManager;
        let proposal = submit(&manager, &db, &root, "call-1");
        assert_eq!(
            gate_session_configure(
                &db,
                &proposal.session_id,
                "agent",
                None,
                None,
                None,
                Some("auto"),
            )
            .unwrap_err()
            .to_string(),
            "PLAN_CONFIGURATION_BLOCKED"
        );
        for blocked in [
            gate_session_configure(
                &db,
                &proposal.session_id,
                "plan",
                Some("other-provider"),
                None,
                None,
                None,
            ),
            gate_session_configure(
                &db,
                &proposal.session_id,
                "plan",
                None,
                Some("other-model"),
                None,
                None,
            ),
            gate_session_configure(
                &db,
                &proposal.session_id,
                "plan",
                None,
                None,
                Some("high"),
                None,
            ),
        ] {
            assert_eq!(
                blocked.unwrap_err().to_string(),
                "PLAN_CONFIGURATION_BLOCKED"
            );
        }
        manager
            .resolve(
                &db,
                PlanResolveParams {
                    workspace_root: Some(&root),
                    proposal_id: &proposal.id,
                    session_id: &proposal.session_id,
                    turn_id: &proposal.turn_id,
                    tool_call_id: &proposal.tool_call_id,
                    version: Some(proposal.version),
                    action: "approve",
                    target_permission_mode: Some("auto"),
                },
            )
            .unwrap();
        assert_eq!(
            gate_session_configure(&db, &proposal.session_id, "plan", None, None, None, None,)
                .unwrap_err()
                .to_string(),
            "PLAN_CONFIGURATION_BLOCKED"
        );
    }

    #[test]
    fn configure_gate_blocks_changes_while_a_turn_is_running() {
        let (dir, db) = test_db();
        let root = dir.path().join("workspace");
        fs::create_dir_all(&root).unwrap();
        let session = sessions::create_session(
            &db,
            Some("Agent".into()),
            Some("agent".into()),
            None,
            None,
            Some(root.to_string_lossy().into_owned()),
        )
        .unwrap();
        let turn = sessions::begin_turn(&db, &session.id, None, None).unwrap();
        assert_eq!(
            gate_session_configure(
                &db,
                &session.id,
                "agent",
                Some("provider-2"),
                None,
                None,
                None,
            )
            .unwrap_err()
            .to_string(),
            "PLAN_CONFIGURATION_BLOCKED"
        );
        sessions::end_turn(&db, &turn, "aborted", None, None, false).unwrap();
        assert!(gate_session_configure(
            &db,
            &session.id,
            "agent",
            Some("provider-2"),
            None,
            None,
            None,
        )
        .is_ok());
    }

    fn goal_session(db: &Database, workspace: &Path) -> sessions::SessionSummary {
        sessions::create_session(
            db,
            Some("Goal".into()),
            Some("goal".into()),
            None,
            None,
            Some(workspace.to_string_lossy().into_owned()),
        )
        .unwrap()
    }

    #[test]
    fn every_kind_publishes_into_its_own_artifact_directory() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("workspace");
        fs::create_dir_all(&root).unwrap();
        for kind in [KIND_PLAN, KIND_GOAL] {
            let kind = normalize_kind(kind).unwrap();
            let (artifact, path) =
                publish_artifact(&root, kind, "Ship checkout", "# Contract\n- done").unwrap();
            assert!(
                artifact.relative_path.starts_with(&format!(".pi/{kind}/")),
                "{} should live under .pi/{kind}/",
                artifact.relative_path
            );
            assert!(path.is_file());
            // A path claiming the other kind's directory must not resolve.
            let other = if kind == KIND_PLAN { KIND_GOAL } else { KIND_PLAN };
            assert_eq!(
                safe_artifact_path(&root, other, &artifact.relative_path)
                    .unwrap_err()
                    .to_string(),
                "PLAN_ARTIFACT_PATH_UNSAFE"
            );
        }
    }

    #[test]
    fn goal_contract_round_trips_through_its_own_kind() {
        let (dir, db) = test_db();
        let root = dir.path().join("workspace");
        fs::create_dir_all(&root).unwrap();
        let manager = PlanManager;
        let session = goal_session(&db, &root);
        let turn = live_turn(&db, &session.id);
        let proposal = manager
            .submit(
                &db,
                PlanSubmitParams {
                    workspace_root: &root,
                    session_id: &session.id,
                    turn_id: &turn,
                    tool_call_id: "goal-call-1",
                    kind: KIND_GOAL,
                    title: "Ship checkout",
                    markdown: "# Goal\n## Acceptance criteria\n- tests pass",
                    question: "Approve this goal?",
                },
            )
            .unwrap();
        assert_eq!(proposal.kind, KIND_GOAL);
        assert!(proposal
            .artifact
            .as_ref()
            .unwrap()
            .relative_path
            .starts_with(".pi/goal/"));
        assert_eq!(
            manager.active_kind(&db, &session.id).unwrap(),
            Some(KIND_GOAL)
        );
        assert_eq!(
            manager.state_for_session(&db, &session.id).unwrap(),
            "awaiting_approval"
        );

        let resolution = manager
            .resolve(
                &db,
                PlanResolveParams {
                    workspace_root: Some(&root),
                    proposal_id: &proposal.id,
                    session_id: &proposal.session_id,
                    turn_id: &proposal.turn_id,
                    tool_call_id: &proposal.tool_call_id,
                    version: Some(proposal.version),
                    action: "approve",
                    target_permission_mode: Some("accept-edits"),
                },
            )
            .unwrap();
        let execution = resolution.execution.unwrap();
        assert_eq!(execution.kind, KIND_GOAL);
        assert_eq!(execution.state, EXECUTION_QUEUED);
        // Approval hands the session back to Agent so execution can act.
        let session = sessions::get_session(&db, &session.id).unwrap().unwrap();
        assert_eq!(session.summary.mode, "agent");
        assert_eq!(manager.active_kind(&db, &proposal.session_id).unwrap(), None);
        assert_eq!(
            manager.queued_executions(&db, None).unwrap()[0].kind,
            KIND_GOAL
        );
    }

    #[test]
    fn submitting_the_other_contract_kind_is_rejected() {
        let (dir, db) = test_db();
        let root = dir.path().join("workspace");
        fs::create_dir_all(&root).unwrap();
        let manager = PlanManager;
        let goal = goal_session(&db, &root);
        let goal_turn = live_turn(&db, &goal.id);
        assert_eq!(
            manager
                .submit(
                    &db,
                    PlanSubmitParams {
                        workspace_root: &root,
                        session_id: &goal.id,
                        turn_id: &goal_turn,
                        tool_call_id: "wrong-kind-1",
                        kind: KIND_PLAN,
                        title: "Plan in a goal session",
                        markdown: "# Plan",
                        question: "Proceed?",
                    },
                )
                .unwrap_err()
                .to_string(),
            "PLAN_KIND_MISMATCH"
        );

        let plan = plan_session(&db, &root);
        let plan_turn = live_turn(&db, &plan.id);
        assert_eq!(
            manager
                .submit(
                    &db,
                    PlanSubmitParams {
                        workspace_root: &root,
                        session_id: &plan.id,
                        turn_id: &plan_turn,
                        tool_call_id: "wrong-kind-2",
                        kind: KIND_GOAL,
                        title: "Goal in a plan session",
                        markdown: "# Goal",
                        question: "Approve?",
                    },
                )
                .unwrap_err()
                .to_string(),
            "PLAN_KIND_MISMATCH"
        );
        // Neither rejected submission may leave an artifact behind.
        assert!(!root.join(".pi").join("goal").exists());
        assert!(!root.join(".pi").join("plan").exists());
    }

    #[test]
    fn entering_goal_mode_writes_the_goal_mode_and_kind() {
        let (dir, db) = test_db();
        let root = dir.path().join("workspace");
        fs::create_dir_all(&root).unwrap();
        let session = sessions::create_session(
            &db,
            Some("Agent".into()),
            Some("agent".into()),
            None,
            None,
            Some(root.to_string_lossy().into_owned()),
        )
        .unwrap();
        let turn = live_turn(&db, &session.id);

        PlanManager
            .enter(&db, &session.id, &turn, "enter-goal-call", KIND_GOAL)
            .unwrap();

        assert_eq!(
            sessions::session_mode(&db, &session.id).unwrap().as_deref(),
            Some("goal")
        );
        let audit_payload: String = db
            .conn()
            .query_row(
                "SELECT payload_json FROM audit_log WHERE kind = 'plan_entered' ORDER BY id DESC LIMIT 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let audit_payload: serde_json::Value = serde_json::from_str(&audit_payload).unwrap();
        assert_eq!(audit_payload["kind"], "goal");

        // A second entry is refused whatever kind it asks for.
        assert_eq!(
            PlanManager
                .enter(&db, &session.id, &turn, "enter-plan-call", KIND_PLAN)
                .unwrap_err()
                .to_string(),
            "PLAN_ALREADY_ACTIVE"
        );
        assert_eq!(
            PlanManager
                .enter(&db, &session.id, &turn, "enter-bogus-call", "sprint")
                .unwrap_err()
                .to_string(),
            "PLAN_INVALID_ARGUMENT"
        );
    }
}
