//! SQL for `mode_runs` and `mode_gate_results`. Every update is a revision
//! compare-and-swap so a stale writer can never overwrite a newer state.

use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension, Row};

use super::model::{tail, ModeRun, Origin, RunState, WaitReason, MAX_SAFE_INTEGER};
use super::{mode_error, mode_error_detail};
use crate::db::now_ms;

pub const MAX_EVIDENCE_BYTES: usize = 8 * 1024;

const COLUMNS: &str = "id, session_id, mode_id, snapshot_hash, input, stage_id, state, \
    wait_reason, last_error, revision, active_turn_id, active_origin, stage_entered, \
    advanced_in_turn, pending_gate, retry_counts, rounds_completed, tokens_used, max_turns, \
    max_tokens, artifact_paths, settled_turns, created_at, updated_at, finished_at";

const OPEN_STATES: &str = "('running', 'waiting', 'paused', 'budget_exhausted')";

fn conversion(index: usize, error: impl std::error::Error + Send + Sync + 'static) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(index, rusqlite::types::Type::Text, Box::new(error))
}

fn json_column<T: serde::de::DeserializeOwned>(row: &Row<'_>, index: usize) -> rusqlite::Result<T> {
    let raw: String = row.get(index)?;
    serde_json::from_str(&raw).map_err(|error| conversion(index, error))
}

#[derive(Debug)]
struct UnknownValue(String);

impl std::fmt::Display for UnknownValue {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "unknown stored value `{}`", self.0)
    }
}

impl std::error::Error for UnknownValue {}

fn parsed<T>(index: usize, raw: String, parse: impl Fn(&str) -> Option<T>) -> rusqlite::Result<T> {
    parse(&raw).ok_or_else(|| conversion(index, UnknownValue(raw)))
}

fn from_row(row: &Row<'_>) -> rusqlite::Result<ModeRun> {
    let wait_reason: Option<String> = row.get(7)?;
    let active_origin: Option<String> = row.get(11)?;
    Ok(ModeRun {
        id: row.get(0)?,
        session_id: row.get(1)?,
        mode_id: row.get(2)?,
        snapshot_hash: row.get(3)?,
        input: row.get(4)?,
        stage_id: row.get(5)?,
        state: parsed(6, row.get(6)?, RunState::parse)?,
        wait_reason: wait_reason
            .map(|raw| parsed(7, raw, WaitReason::parse))
            .transpose()?,
        last_error: row.get(8)?,
        revision: row.get(9)?,
        active_turn_id: row.get(10)?,
        active_origin: active_origin
            .map(|raw| parsed(11, raw, Origin::parse))
            .transpose()?,
        stage_entered: row.get(12)?,
        advanced_in_turn: row.get(13)?,
        pending_gate: row.get(14)?,
        retry_counts: json_column(row, 15)?,
        rounds_completed: row.get(16)?,
        tokens_used: row.get(17)?,
        max_turns: row.get(18)?,
        max_tokens: row.get(19)?,
        artifact_paths: json_column(row, 20)?,
        settled_turns: json_column(row, 21)?,
        created_at: row.get(22)?,
        updated_at: row.get(23)?,
        finished_at: row.get(24)?,
    })
}

/// The session's open run, if any.
pub fn open_run(conn: &Connection, session_id: &str) -> Result<Option<ModeRun>> {
    Ok(conn
        .prepare_cached(&format!(
            "SELECT {COLUMNS} FROM mode_runs WHERE session_id = ?1 AND state IN {OPEN_STATES}"
        ))?
        .query_row(params![session_id], from_row)
        .optional()?)
}

/// A run that belongs to `session_id`, in any state.
pub fn owned(conn: &Connection, session_id: &str, run_id: &str) -> Result<ModeRun> {
    conn.prepare_cached(&format!(
        "SELECT {COLUMNS} FROM mode_runs WHERE id = ?1 AND session_id = ?2"
    ))?
    .query_row(params![run_id, session_id], from_row)
    .optional()?
    .ok_or_else(|| mode_error("MODE_RUN_NOT_FOUND"))
}

pub fn insert(conn: &Connection, run: &ModeRun) -> Result<()> {
    let inserted = conn
        .prepare_cached(&format!(
            "INSERT INTO mode_runs ({COLUMNS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
             ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25)"
        ))?
        .execute(params![
            run.id,
            run.session_id,
            run.mode_id,
            run.snapshot_hash,
            run.input,
            run.stage_id,
            run.state.as_str(),
            run.wait_reason.map(WaitReason::as_str),
            run.last_error,
            run.revision,
            run.active_turn_id,
            run.active_origin.map(Origin::as_str),
            run.stage_entered,
            run.advanced_in_turn,
            run.pending_gate,
            serde_json::to_string(&run.retry_counts)?,
            run.rounds_completed,
            run.tokens_used,
            run.max_turns,
            run.max_tokens,
            serde_json::to_string(&run.artifact_paths)?,
            serde_json::to_string(&run.settled_turns)?,
            run.created_at,
            run.updated_at,
            run.finished_at,
        ]);
    match inserted {
        Ok(_) => Ok(()),
        // The partial unique index is the last line against a second open run.
        Err(rusqlite::Error::SqliteFailure(error, _))
            if error.code == rusqlite::ErrorCode::ConstraintViolation =>
        {
            Err(mode_error("MODE_RUN_ACTIVE"))
        }
        Err(error) => Err(error.into()),
    }
}

/// Persist `run` if nobody changed it since it was read, then bump its
/// revision. A lost race surfaces as `MODE_REVISION_CONFLICT`.
pub fn save(conn: &Connection, run: &mut ModeRun) -> Result<()> {
    let previous = run.revision;
    let next = previous
        .checked_add(1)
        .filter(|next| *next <= MAX_SAFE_INTEGER)
        .ok_or_else(|| mode_error("MODE_REVISION_CONFLICT"))?;
    let now = now_ms();
    let changed = conn
        .prepare_cached(
            "UPDATE mode_runs SET stage_id = ?3, state = ?4, wait_reason = ?5, last_error = ?6,
                 revision = ?7, active_turn_id = ?8, active_origin = ?9, stage_entered = ?10,
                 advanced_in_turn = ?11, pending_gate = ?12, retry_counts = ?13,
                 rounds_completed = ?14, tokens_used = ?15, settled_turns = ?16,
                 updated_at = ?17, finished_at = ?18
             WHERE id = ?1 AND revision = ?2",
        )?
        .execute(params![
            run.id,
            previous,
            run.stage_id,
            run.state.as_str(),
            run.wait_reason.map(WaitReason::as_str),
            run.last_error,
            next,
            run.active_turn_id,
            run.active_origin.map(Origin::as_str),
            run.stage_entered,
            run.advanced_in_turn,
            run.pending_gate,
            serde_json::to_string(&run.retry_counts)?,
            run.rounds_completed,
            run.tokens_used,
            serde_json::to_string(&run.settled_turns)?,
            now,
            run.finished_at,
        ])?;
    if changed != 1 {
        return Err(mode_error("MODE_REVISION_CONFLICT"));
    }
    run.revision = next;
    run.updated_at = now;
    Ok(())
}

pub struct GateRecord<'a> {
    pub stage_id: &'a str,
    pub gate_index: usize,
    pub action: &'static str,
    pub passed: Option<bool>,
    pub evidence: Option<&'a str>,
    pub tool_call_id: Option<&'a str>,
}

pub fn record_gate(conn: &Connection, run_id: &str, record: GateRecord<'_>) -> Result<()> {
    let evidence = record
        .evidence
        .map(|text| tail(text, MAX_EVIDENCE_BYTES));
    conn.prepare_cached(
        "INSERT INTO mode_gate_results
           (run_id, stage_id, gate_index, action, passed, evidence, tool_call_id, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
    )?
    .execute(params![
        run_id,
        record.stage_id,
        record.gate_index as i64,
        record.action,
        record.passed,
        evidence,
        record.tool_call_id,
        now_ms(),
    ])?;
    Ok(())
}

/// Leave the run's mode: the session returns to `return_to` unless the user
/// already switched it elsewhere. The snapshot hash goes with the mode.
pub fn return_session_mode(
    conn: &Connection,
    session_id: &str,
    run_mode: &str,
    return_to: &str,
) -> Result<()> {
    conn.prepare_cached(
        "UPDATE sessions SET mode = ?3, mode_snapshot_hash = NULL, updated_at = ?4
         WHERE id = ?1 AND mode = ?2",
    )?
    .execute(params![session_id, run_mode, return_to, now_ms()])?;
    Ok(())
}

/// `(mode, mode_snapshot_hash)` of a live session.
pub fn session_mode_row(
    conn: &Connection,
    session_id: &str,
) -> Result<Option<(String, Option<String>)>> {
    Ok(conn
        .prepare_cached(
            "SELECT mode, mode_snapshot_hash FROM sessions WHERE id = ?1 AND deleted_at IS NULL",
        )?
        .query_row(params![session_id], |row| Ok((row.get(0)?, row.get(1)?)))
        .optional()?)
}

/// Whether a Host-started turn currently holds an open run's claim.
pub fn host_turn_active(conn: &Connection, session_id: &str) -> Result<bool> {
    Ok(conn
        .prepare_cached(&format!(
            "SELECT EXISTS(SELECT 1 FROM mode_runs WHERE session_id = ?1
               AND state IN {OPEN_STATES} AND active_origin = 'host')"
        ))?
        .query_row(params![session_id], |row| row.get(0))?)
}

/// Startup recovery: a claim cannot survive the process that dispatched its
/// turn. The run pauses and nothing is replayed.
pub fn release_stale_claims(conn: &Connection) -> Result<Vec<String>> {
    let now = now_ms();
    let ids = conn
        .prepare(&format!(
            "SELECT id FROM mode_runs WHERE active_turn_id IS NOT NULL AND state IN {OPEN_STATES}"
        ))?
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for id in &ids {
        conn.execute(
            "UPDATE mode_runs SET active_turn_id = NULL, active_origin = NULL,
                 pending_gate = NULL, state = 'paused', wait_reason = NULL,
                 advanced_in_turn = 0, revision = revision + 1, updated_at = ?2
             WHERE id = ?1",
            params![id, now],
        )
        .map_err(|error| mode_error_detail("MODE_RECOVERY_FAILED", error))?;
    }
    Ok(ids)
}
