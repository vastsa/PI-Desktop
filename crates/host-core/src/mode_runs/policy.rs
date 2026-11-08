//! Tool policy: which hard deny governs a session's tool calls. The Host
//! derives it from persisted state only — the run, the session snapshot and
//! the builtin mode names — never from the mode a runtime reports.

use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};

use super::repository;
use super::snapshot::{self, ModePermission};
use crate::db::Database;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolPolicy {
    /// Agent: the session permission mode decides.
    Agent,
    /// Plan's allowlist and hard deny.
    Contract,
}

impl ToolPolicy {
    fn from_permission(permission: ModePermission) -> Self {
        match permission {
            ModePermission::Agent => Self::Agent,
            ModePermission::Contract => Self::Contract,
        }
    }

    /// The builtin mode name `PermissionManager` evaluates for this policy,
    /// so the manager itself keeps its builtin-only vocabulary.
    pub fn permission_mode(self) -> &'static str {
        match self {
            Self::Agent => "agent",
            Self::Contract => "plan",
        }
    }
}

/// Everything `tools.execute` needs to authorize one call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Authorization {
    /// The persisted session mode (audit only).
    pub mode: String,
    pub policy: ToolPolicy,
    /// A Host-started continuation turn holds the session's run claim.
    pub host_turn: bool,
}

impl Authorization {
    pub fn permission_mode(&self) -> &'static str {
        self.policy.permission_mode()
    }

    /// Mode handed to the plugin runtime's plan-safe gate: builtin contract
    /// names keep their own spelling, custom contract modes read as `plan`.
    pub fn plugin_mode(&self) -> &str {
        match self.policy {
            ToolPolicy::Agent => "agent",
            ToolPolicy::Contract if matches!(self.mode.as_str(), "plan" | "goal") => &self.mode,
            ToolPolicy::Contract => "plan",
        }
    }

    /// Host-started turns run at most `accept-edits`: nobody is watching a
    /// continuation the user did not send.
    pub fn cap_permission_mode(&self, effective: String) -> String {
        if self.host_turn && effective == "auto" {
            "accept-edits".into()
        } else {
            effective
        }
    }
}

fn session_row(conn: &Connection, session_id: &str) -> Result<Option<(String, Option<String>)>> {
    Ok(conn
        .prepare_cached("SELECT mode, mode_snapshot_hash FROM sessions WHERE id = ?1")?
        .query_row(params![session_id], |row| Ok((row.get(0)?, row.get(1)?)))
        .optional()?)
}

/// Resolution order: the open run of the session's mode (its stage's
/// permission), then the session snapshot of that mode, then the builtin
/// names. Any other id fails closed to `Contract`.
fn resolve(conn: &Connection, session_id: &str, mode: &str, hash: Option<&str>) -> Result<ToolPolicy> {
    if let Some(run) = repository::open_run(conn, session_id)? {
        if run.mode_id == mode {
            let snapshot = snapshot::require(conn, &run.snapshot_hash)?;
            return Ok(snapshot
                .definition
                .stage(&run.stage_id)
                .map(|stage| ToolPolicy::from_permission(stage.permission))
                .unwrap_or(ToolPolicy::Contract));
        }
    }
    if let Some(hash) = hash {
        if let Some(snapshot) = snapshot::load(conn, hash)? {
            if snapshot.definition.id == mode {
                return Ok(ToolPolicy::from_permission(snapshot.definition.permission));
            }
        }
    }
    Ok(if mode == "agent" {
        ToolPolicy::Agent
    } else {
        ToolPolicy::Contract
    })
}

/// Tool policy of a session, or `None` for an unknown session.
pub fn tool_policy(db: &Database, session_id: &str) -> Result<Option<ToolPolicy>> {
    tool_policy_conn(db.conn(), session_id)
}

/// `tool_policy` on a connection or open transaction.
pub fn tool_policy_conn(conn: &Connection, session_id: &str) -> Result<Option<ToolPolicy>> {
    let Some((mode, hash)) = session_row(conn, session_id)? else {
        return Ok(None);
    };
    let mode = crate::sessions::normalize_mode(Some(&mode));
    resolve(conn, session_id, &mode, hash.as_deref()).map(Some)
}

/// Authorization inputs for one tool call, or `None` for an unknown session.
pub fn authorization(db: &Database, session_id: &str) -> Result<Option<Authorization>> {
    let conn = db.conn();
    let Some((mode, hash)) = session_row(conn, session_id)? else {
        return Ok(None);
    };
    let mode = crate::sessions::normalize_mode(Some(&mode));
    let policy = resolve(conn, session_id, &mode, hash.as_deref())?;
    let host_turn = repository::host_turn_active(conn, session_id)?;
    Ok(Some(Authorization {
        mode,
        policy,
        host_turn,
    }))
}
