//! Durable execution authority is independent of the Composer preference.
use crate::{db::Database, goals};
use anyhow::{anyhow, ensure, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum GoalProvenance {
    UserGoal,
    GoalContinuation,
}
impl GoalProvenance {
    fn as_str(&self) -> &'static str {
        match self {
            Self::UserGoal => "user-goal",
            Self::GoalContinuation => "goal-continuation",
        }
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GoalTurn {
    pub goal_id: String,
    pub turn_id: String,
    pub provenance: GoalProvenance,
}

/// Trusted ingress only. A failed validation/binding rolls back the runtime turn.
pub fn begin_goal_turn(
    db: &Database,
    session: &str,
    provider: Option<&str>,
    model: Option<&str>,
    binding: GoalTurn,
) -> Result<String> {
    let tx = db.conn().unchecked_transaction()?;
    goals::validate_turn(
        db,
        goals::TurnParams {
            session_id: session.into(),
            goal_id: binding.goal_id,
            turn_id: binding.turn_id.clone(),
        },
    )?;
    let bound: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM turn_execution WHERE goal_claim_id=?1)",
        [&binding.turn_id],
        |row| row.get(0),
    )?;
    ensure!(!bound, "GOAL_TURN_STALE");
    let turn = super::begin_turn(db, session, provider, model)?;
    let changed = tx.execute(
        "UPDATE turn_execution SET mode='goal',goal_claim_id=?2,provenance=?3 WHERE turn_id=?1 AND goal_claim_id IS NULL",
        params![turn, binding.turn_id, binding.provenance.as_str()],
    )?;
    ensure!(changed == 1, "GOAL_TURN_STALE");
    tx.commit()?;
    Ok(turn)
}

/// Read the immutable mode; absent legacy records retain the durable session
/// fallback. A foreign turn is never a credential for the requesting session.
pub fn turn_mode(conn: &Connection, session: &str, turn: Option<&str>) -> Result<Option<String>> {
    let fallback: Option<String> = conn
        .query_row(
            "SELECT mode FROM sessions WHERE id=?1 AND deleted_at IS NULL",
            [session],
            |row| row.get(0),
        )
        .optional()?;
    if fallback.is_none() {
        return Ok(None);
    }
    if let Some(turn) = turn {
        let record: Option<(String, Option<String>)> = conn.query_row(
            "SELECT t.session_id,e.mode FROM turns t LEFT JOIN turn_execution e ON e.turn_id=t.id WHERE t.id=?1",
            [turn], |row| Ok((row.get(0)?,row.get(1)?)),
        ).optional()?;
        if let Some((owner, mode)) = record {
            ensure!(owner == session, "GOAL_TURN_STALE");
            return Ok(mode.or(fallback));
        }
    }
    Ok(fallback)
}

/// Every tool/permission/native/plugin call uses this check, never caller mode.
/// Stopped, replaced, deleted, settled or recovered Goal bindings grant nothing.
pub fn execution_mode(
    conn: &Connection,
    session: &str,
    turn: Option<&str>,
) -> Result<Option<String>> {
    let mode = turn_mode(conn, session, turn)?;
    if let Some(turn) = turn {
        let binding: Option<String> = conn
            .query_row(
                "SELECT goal_claim_id FROM turn_execution WHERE turn_id=?1",
                [turn],
                |row| row.get(0),
            )
            .optional()?
            .flatten();
        if let Some(claim) = binding {
            let live: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM turns t JOIN turn_execution e ON e.turn_id=t.id
                 JOIN goal_turns c ON c.turn_id=e.goal_claim_id JOIN session_goals g ON g.id=c.goal_id
                 JOIN sessions s ON s.id=g.session_id
                 WHERE t.id=?1 AND t.session_id=?2 AND g.session_id=?2 AND c.turn_id=?3
                 AND t.status='running' AND c.settled=0 AND g.status='active' AND g.deleted=0
                 AND g.active_turn_id=c.turn_id AND g.active_scope_json IS NOT NULL AND s.deleted_at IS NULL)",
                params![turn,session,claim], |row| row.get(0),
            )?;
            if !live {
                return Err(anyhow!("GOAL_TURN_STALE"));
            }
        }
    }
    Ok(mode)
}
