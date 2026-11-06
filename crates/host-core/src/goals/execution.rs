//! Existing execution conversion is distinct from fresh claim/report authority.
use super::{repository, SessionGoal, TurnParams};
use crate::db::Database;
use anyhow::{ensure, Result};
use rusqlite::{params, Connection};

pub(super) fn bound_running(conn: &Connection, session: &str, claim: &str) -> Result<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM turns t JOIN turn_execution e ON e.turn_id=t.id
         JOIN goal_turns c ON c.turn_id=e.goal_claim_id JOIN session_goals g ON g.id=c.goal_id
         JOIN sessions s ON s.id=g.session_id WHERE g.session_id=?1 AND t.session_id=?1
         AND c.turn_id=?2 AND c.settled=0 AND c.interrupted=0 AND t.status='running'
         AND g.active_turn_id=c.turn_id AND g.active_scope_json IS NOT NULL AND s.deleted_at IS NULL)",
        params![session, claim], |row| row.get(0),
    )?)
}

pub(crate) fn detached_claim(conn: &Connection, session: &str, claim: &str) -> Result<bool> {
    let removed: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM session_goals g JOIN goal_turns c ON c.goal_id=g.id
         WHERE g.session_id=?1 AND c.turn_id=?2 AND g.deleted=1 AND g.stop_reason='user_deleted'
         AND g.active_turn_id=c.turn_id AND g.active_scope_json IS NOT NULL)",
        params![session, claim],
        |row| row.get(0),
    )?;
    Ok(removed && bound_running(conn, session, claim)?)
}

/// Trusted validation only: never use this for new admission or Goal reports.
pub fn validate_execution(db: &Database, input: TurnParams) -> Result<SessionGoal> {
    let goal = repository::owned_for_settlement(db.conn(), &input.session_id, &input.goal_id)?;
    if !goal.deleted {
        super::live_claim(db.conn(), &goal, &input.turn_id)?;
    } else {
        ensure!(
            goal.active_turn_id.as_deref() == Some(&input.turn_id)
                && detached_claim(db.conn(), &input.session_id, &input.turn_id)?,
            "GOAL_NOT_FOUND"
        );
    }
    Ok(goal)
}
