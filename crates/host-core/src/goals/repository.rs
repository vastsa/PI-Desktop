use super::model::*;
use anyhow::{anyhow, Result};
use rusqlite::{params, Connection, OptionalExtension, Row};

fn from_row(row: &Row<'_>) -> rusqlite::Result<SessionGoal> {
    fn json<T: serde::de::DeserializeOwned>(row: &Row<'_>, index: usize) -> rusqlite::Result<T> {
        let raw: String = row.get(index)?;
        serde_json::from_str(&raw).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                index,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })
    }
    let status: String = row.get(3)?;
    let status = match status.as_str() {
        "active" => GoalStatus::Active,
        "paused" => GoalStatus::Paused,
        "blocked" => GoalStatus::Blocked,
        "completed" => GoalStatus::Completed,
        "budget_exhausted" => GoalStatus::BudgetExhausted,
        "cancelled" => GoalStatus::Cancelled,
        _ => return Err(rusqlite::Error::InvalidQuery),
    };
    Ok(SessionGoal {
        id: row.get(0)?,
        session_id: row.get(1)?,
        revision: row.get(2)?,
        status,
        objective: row.get(4)?,
        criteria: json(row, 5)?,
        progress_summary: row.get(6)?,
        rounds_started: row.get(7)?,
        token_usage: row.get(8)?,
        budget: json(row, 9)?,
        active_turn_id: row.get(10)?,
        stop_reason: row.get(11)?,
        outcomes: json(row, 12)?,
        audit: match row.get::<_, Option<String>>(13)? {
            Some(_) => Some(json(row, 13)?),
            None => None,
        },
        elapsed_ms: row.get(14)?,
        active_since_ms: row.get(15)?,
        deleted: row.get(16)?,
        pause_requested: row.get(17)?,
        pending_budget: match row.get::<_, Option<String>>(18)? {
            Some(_) => Some(json(row, 18)?),
            None => None,
        },
        active_scope: match row.get::<_, Option<String>>(19)? {
            Some(_) => Some(json(row, 19)?),
            None => None,
        },
    })
}
const COLUMNS: &str = "id,session_id,revision,status,objective,criteria_json,progress_summary,rounds_started,token_usage,budget_json,active_turn_id,stop_reason,outcomes_json,audit_json,elapsed_ms,active_since_ms,deleted,pause_requested,pending_budget_json,active_scope_json";

pub(super) fn latest(conn: &Connection, session: &str) -> Result<Option<SessionGoal>> {
    // Select newest first, THEN hide removal. Filtering in SQL would revive an older row.
    Ok(conn.query_row(&format!("SELECT {COLUMNS} FROM session_goals WHERE session_id=?1 ORDER BY rowid DESC LIMIT 1"), [session], from_row).optional()?.filter(|goal| !goal.deleted))
}
pub(super) fn owned(conn: &Connection, session: &str, id: &str) -> Result<SessionGoal> {
    let goal = owned_for_settlement(conn, session, id)?;
    anyhow::ensure!(!goal.deleted, "GOAL_NOT_FOUND");
    Ok(goal)
}
pub(super) fn owned_for_settlement(
    conn: &Connection,
    session: &str,
    id: &str,
) -> Result<SessionGoal> {
    conn.query_row(
        &format!("SELECT {COLUMNS} FROM session_goals WHERE session_id=?1 AND id=?2"),
        params![session, id],
        from_row,
    )
    .optional()?
    .ok_or_else(|| anyhow!("GOAL_NOT_FOUND"))
}
pub(super) fn insert(conn: &Connection, goal: &SessionGoal) -> Result<()> {
    conn.execute("INSERT INTO session_goals(id,session_id,revision,status,objective,criteria_json,progress_summary,rounds_started,token_usage,budget_json,active_turn_id,stop_reason,outcomes_json,audit_json,elapsed_ms,active_since_ms,deleted,pause_requested,pending_budget_json)
        VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19)", params![
        goal.id, goal.session_id, goal.revision, goal.status.as_str(), goal.objective,
        serde_json::to_string(&goal.criteria)?, goal.progress_summary, goal.rounds_started,
        goal.token_usage, serde_json::to_string(&goal.budget)?, goal.active_turn_id,
        goal.stop_reason, serde_json::to_string(&goal.outcomes)?,
        goal.audit.as_ref().map(serde_json::to_string).transpose()?,
        goal.elapsed_ms, goal.active_since_ms, goal.deleted, goal.pause_requested,
        goal.pending_budget.as_ref().map(serde_json::to_string).transpose()?
    ])?;
    Ok(())
}
pub(super) fn save(conn: &Connection, goal: &mut SessionGoal) -> Result<()> {
    super::clock::checkpoint(goal, super::clock::now_ms());
    let previous = goal.revision;
    goal.revision = previous
        .checked_add(1)
        .filter(|n| *n <= MAX_SAFE_INTEGER)
        .ok_or_else(|| anyhow!("GOAL_COUNTER_OVERFLOW"))?;
    let changed = conn.execute("UPDATE session_goals SET revision=?3,status=?4,progress_summary=?5,
        rounds_started=?6,token_usage=?7,budget_json=?8,active_turn_id=?9,stop_reason=?10,outcomes_json=?11,audit_json=?12,
        objective=?13,criteria_json=?14,elapsed_ms=?15,active_since_ms=?16,deleted=?17,
        pause_requested=?18,pending_budget_json=?19,active_scope_json=?20
        WHERE id=?1 AND revision=?2", params![goal.id, previous, goal.revision, goal.status.as_str(),
        goal.progress_summary, goal.rounds_started, goal.token_usage, serde_json::to_string(&goal.budget)?,
        goal.active_turn_id, goal.stop_reason, serde_json::to_string(&goal.outcomes)?,
        goal.audit.as_ref().map(serde_json::to_string).transpose()?,
        goal.objective, serde_json::to_string(&goal.criteria)?, goal.elapsed_ms, goal.active_since_ms, goal.deleted,
        goal.pause_requested, goal.pending_budget.as_ref().map(serde_json::to_string).transpose()?,
        goal.active_scope.as_ref().map(serde_json::to_string).transpose()?])?;
    anyhow::ensure!(changed == 1, "GOAL_STALE_REVISION");
    Ok(())
}
