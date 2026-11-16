//! Settling the session's mode after a run closed (ADR mode-definitions § 8).
//!
//! A closed run hands the session to its `returnTo` without a snapshot,
//! because only Electron main knows the current catalog. Without a snapshot
//! a custom mode resolves to the `Contract` policy, and a mode deleted during
//! the run leaves the session on an id the catalog no longer has. Main asks
//! which mode is pending and answers with that mode's current definition, or
//! with nothing when it no longer exists; the session then takes the
//! snapshot or falls back to `agent`.

use anyhow::Result;
use rusqlite::params;
use serde::Deserialize;
use serde_json::{json, Value};

use super::repository;
use super::snapshot;
use crate::db::{now_ms, Database};

/// `modes.settleReturn`. Without `mode` it only reports the pending return
/// mode. With `mode` (the reported id) it applies `modeSnapshot`, or the
/// `agent` fallback when the snapshot is absent.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettleReturnParams {
    pub session_id: String,
    pub run_id: String,
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub mode_snapshot: Option<Value>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum SettleReturnResult {
    /// Nothing to settle: the run is open, the session moved on, or its mode
    /// needs no snapshot.
    Settled,
    /// The session waits on this return mode.
    Pending(String),
    /// The session now uses this mode.
    Applied(String),
}

impl SettleReturnResult {
    pub fn wire(&self) -> Value {
        match self {
            Self::Settled => json!({ "pending": null, "applied": null }),
            Self::Pending(mode) => json!({ "pending": mode, "applied": null }),
            Self::Applied(mode) => json!({ "pending": null, "applied": mode }),
        }
    }
}

/// The return mode the session still waits on, if any. The session must sit
/// on the run's `returnTo` with no snapshot, outside any open run.
fn pending(db: &Database, session_id: &str, run_id: &str) -> Result<Option<String>> {
    let conn = db.conn();
    let run = repository::owned(conn, session_id, run_id)?;
    if run.state.is_open() || repository::open_run(conn, session_id)?.is_some() {
        return Ok(None);
    }
    let return_to = snapshot::require(conn, &run.snapshot_hash)?
        .definition
        .return_to;
    if matches!(return_to.as_str(), "agent" | "plan") {
        return Ok(None);
    }
    let Some((mode, hash)) = repository::session_mode_row(conn, session_id)? else {
        return Ok(None);
    };
    Ok((mode == return_to && hash.is_none()).then_some(return_to))
}

pub fn settle_return(db: &Database, params: SettleReturnParams) -> Result<SettleReturnResult> {
    let Some(return_to) = pending(db, &params.session_id, &params.run_id)? else {
        return Ok(SettleReturnResult::Settled);
    };
    let Some(mode) = params.mode else {
        return Ok(SettleReturnResult::Pending(return_to));
    };
    if mode != return_to {
        return Ok(SettleReturnResult::Settled);
    }
    let conn = db.conn();
    let (next, hash) = match params.mode_snapshot.filter(|value| !value.is_null()) {
        Some(value) => {
            let snapshot = snapshot::validate(&value, &return_to)?;
            snapshot::store(conn, &snapshot)?;
            (return_to.clone(), Some(snapshot.hash))
        }
        None => ("agent".to_string(), None),
    };
    let changed = conn
        .prepare_cached(
            "UPDATE sessions SET mode = ?3, mode_snapshot_hash = ?4, updated_at = ?5
             WHERE id = ?1 AND mode = ?2 AND mode_snapshot_hash IS NULL",
        )?
        .execute(params![params.session_id, return_to, next, hash, now_ms()])?;
    Ok(if changed == 0 {
        SettleReturnResult::Settled
    } else {
        SettleReturnResult::Applied(next)
    })
}
