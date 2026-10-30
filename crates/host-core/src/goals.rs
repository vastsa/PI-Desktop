//! Durable autonomous goals. Runtime execution is external; every claim and
//! transition is committed before its caller may act. No legacy plan migration.
mod audit;
mod clock;
pub(crate) use clock::register as register_clock;
mod model;
mod repository;
use crate::db::Database;
use anyhow::{anyhow, ensure, Result};
pub use model::*;
use repository::{latest, owned, save};
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::HashSet;

fn bounded(value: &str, nonempty: bool) -> Result<()> {
    ensure!(
        value.len() <= 100_000 && (!nonempty || !value.trim().is_empty()),
        "GOAL_INVALID_TEXT"
    );
    Ok(())
}
fn budget_valid(budget: &GoalBudget) -> Result<()> {
    ensure!(
        budget.max_turns.is_none_or(|v| (1..=10_000).contains(&v)),
        "GOAL_INVALID_BUDGET"
    );
    ensure!(
        budget
            .max_tokens
            .is_none_or(|v| (1..=MAX_SAFE_INTEGER).contains(&v)),
        "GOAL_INVALID_BUDGET"
    );
    Ok(())
}
/// Validate both local settings and imported defaults at the same boundary.
pub fn validate_default_budget(settings: &serde_json::Value) -> Result<Option<GoalBudget>> {
    let Some(value) = settings.get("defaultGoalBudget") else {
        return Ok(None);
    };
    let budget: GoalBudget =
        serde_json::from_value(value.clone()).map_err(|_| anyhow!("GOAL_INVALID_BUDGET"))?;
    budget_valid(&budget)?;
    Ok(Some(budget))
}
fn session_mode(conn: &Connection, session: &str) -> Result<String> {
    bounded(session, true)?;
    conn.query_row(
        "SELECT mode FROM sessions WHERE id=?1 AND deleted_at IS NULL",
        [session],
        |r| r.get(0),
    )
    .optional()?
    .ok_or_else(|| anyhow!("GOAL_SESSION_NOT_FOUND"))
}
fn require_goal_mode(conn: &Connection, session: &str) -> Result<()> {
    ensure!(session_mode(conn, session)? == "goal", "GOAL_MODE_REQUIRED");
    Ok(())
}
fn expect_revision(goal: &SessionGoal, revision: i64) -> Result<()> {
    ensure!(
        revision <= MAX_SAFE_INTEGER && revision == goal.revision,
        "GOAL_STALE_REVISION"
    );
    Ok(())
}
fn live_claim(conn: &Connection, goal: &SessionGoal, turn: &str) -> Result<()> {
    require_goal_mode(conn, &goal.session_id)?;
    ensure!(
        goal.status == GoalStatus::Active && goal.active_turn_id.as_deref() == Some(turn),
        "GOAL_TURN_STALE"
    );
    let live: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM goal_turns WHERE turn_id=?1 AND goal_id=?2 AND settled=0)",
        params![turn, goal.id],
        |r| r.get(0),
    )?;
    ensure!(live, "GOAL_TURN_STALE");
    Ok(())
}
fn stop(goal: &mut SessionGoal, status: GoalStatus, reason: &str) {
    goal.status = status;
    goal.stop_reason = Some(reason.into());
}
pub fn get(db: &Database, session: &str) -> Result<Option<SessionGoal>> {
    session_mode(db.conn(), session)?;
    latest(db.conn(), session)
}
pub fn start(db: &Database, input: StartParams) -> Result<SessionGoal> {
    bounded(&input.objective, true)?;
    let budget = match input.budget {
        Some(budget) => budget,
        None => {
            validate_default_budget(&db.get_setting("app")?.unwrap_or(serde_json::Value::Null))?
                .unwrap_or_default()
        }
    };
    budget_valid(&budget)?;
    let criteria = input
        .criteria
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| vec![input.objective.clone()]);
    ensure!(criteria.len() <= 100, "GOAL_INVALID_CRITERIA");
    let mut seen = HashSet::new();
    for criterion in &criteria {
        bounded(criterion, true)?;
        ensure!(seen.insert(criterion), "GOAL_INVALID_CRITERIA");
    }
    ensure!(
        criteria.iter().map(String::len).sum::<usize>() <= 100_000,
        "GOAL_INVALID_CRITERIA"
    );
    let tx = db.conn().unchecked_transaction()?;
    require_goal_mode(&tx, &input.session_id)?;
    let busy: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM session_goals WHERE session_id=?1 AND
        (status IN ('active','paused','blocked','budget_exhausted') OR active_turn_id IS NOT NULL))
        OR EXISTS(SELECT 1 FROM plan_approvals WHERE session_id=?1 AND (status='pending' OR execution_state IN ('queued','running')))
        OR EXISTS(SELECT 1 FROM turns WHERE session_id=?1 AND status='running')", [&input.session_id], |r| r.get(0))?;
    ensure!(!busy, "GOAL_SESSION_BUSY");
    let goal = SessionGoal {
        id: uuid::Uuid::new_v4().to_string(),
        session_id: input.session_id,
        revision: 1,
        status: GoalStatus::Active,
        objective: input.objective,
        criteria,
        progress_summary: String::new(),
        rounds_started: 0,
        token_usage: 0,
        budget,
        active_turn_id: None,
        stop_reason: None,
        outcomes: vec![],
        audit: None,
        elapsed_ms: 0,
        active_since_ms: Some(clock::now_ms()),
        deleted: false,
    };
    repository::insert(&tx, &goal)?;
    tx.commit()?;
    Ok(goal)
}
pub fn control(db: &Database, input: ControlParams) -> Result<SessionGoal> {
    let tx = db.conn().unchecked_transaction()?;
    session_mode(&tx, &input.session_id)?;
    let mut goal = owned(&tx, &input.session_id, &input.goal_id)?;
    expect_revision(&goal, input.expected_revision)?;
    ensure!(
        matches!(input.action, ControlAction::Delete)
            || !matches!(goal.status, GoalStatus::Completed | GoalStatus::Cancelled),
        "GOAL_TERMINAL"
    );
    ensure!(
        input.budget.is_none() || matches!(input.action, ControlAction::Resume),
        "GOAL_BUDGET_REQUIRES_RESUME"
    );
    ensure!(
        input.objective.is_none() || matches!(input.action, ControlAction::Edit),
        "GOAL_OBJECTIVE_REQUIRES_EDIT"
    );
    match input.action {
        ControlAction::Pause => stop(&mut goal, GoalStatus::Paused, "user_paused"),
        ControlAction::Cancel => stop(&mut goal, GoalStatus::Cancelled, "user_cancelled"),
        ControlAction::Delete => {
            stop(&mut goal, GoalStatus::Cancelled, "user_deleted");
            goal.deleted = true;
        }
        ControlAction::Edit => {
            ensure!(goal.active_turn_id.is_none(), "GOAL_TURN_IN_FLIGHT");
            ensure!(
                matches!(
                    goal.status,
                    GoalStatus::Paused | GoalStatus::Blocked | GoalStatus::BudgetExhausted
                ),
                "GOAL_NOT_EDITABLE"
            );
            let objective = input
                .objective
                .ok_or_else(|| anyhow!("GOAL_INVALID_TEXT"))?;
            bounded(&objective, true)?;
            goal.criteria = vec![objective.clone()];
            goal.objective = objective;
            goal.progress_summary.clear();
            goal.outcomes.clear();
            goal.audit = None;
            stop(&mut goal, GoalStatus::Paused, "user_edited");
        }
        ControlAction::Resume => {
            require_goal_mode(&tx, &input.session_id)?;
            ensure!(
                matches!(
                    goal.status,
                    GoalStatus::Paused | GoalStatus::Blocked | GoalStatus::BudgetExhausted
                ),
                "GOAL_NOT_RESUMABLE"
            );
            ensure!(goal.active_turn_id.is_none(), "GOAL_TURN_IN_FLIGHT");
            if let Some(budget) = input.budget {
                budget_valid(&budget)?;
                goal.budget = budget;
            }
            ensure!(!goal.exhausted(), "GOAL_BUDGET_EXHAUSTED");
            goal.status = GoalStatus::Active;
            goal.stop_reason = None;
        }
    }
    save(&tx, &mut goal)?;
    tx.commit()?;
    Ok(goal)
}
pub fn claim_turn(db: &Database, input: ClaimParams) -> Result<(SessionGoal, bool)> {
    bounded(&input.turn_id, true)?;
    let tx = db.conn().unchecked_transaction()?;
    require_goal_mode(&tx, &input.session_id)?;
    let mut goal = owned(&tx, &input.session_id, &input.goal_id)?;
    let used: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM goal_turns WHERE turn_id=?1)",
        [&input.turn_id],
        |r| r.get(0),
    )?;
    if input.expected_revision != goal.revision
        || goal.status != GoalStatus::Active
        || goal.active_turn_id.is_some()
        || used
    {
        return Ok((goal, false));
    }
    if goal.exhausted() {
        stop(&mut goal, GoalStatus::BudgetExhausted, "budget_exhausted");
        save(&tx, &mut goal)?;
        tx.commit()?;
        return Ok((goal, false));
    }
    tx.execute(
        "INSERT INTO goal_turns(turn_id,goal_id) VALUES (?1,?2)",
        params![input.turn_id, goal.id],
    )?;
    goal.rounds_started = goal
        .rounds_started
        .checked_add(1)
        .filter(|n| *n <= MAX_SAFE_INTEGER)
        .ok_or_else(|| anyhow!("GOAL_COUNTER_OVERFLOW"))?;
    goal.active_turn_id = Some(input.turn_id);
    save(&tx, &mut goal)?;
    tx.commit()?;
    Ok((goal, true))
}
pub fn validate_turn(db: &Database, input: TurnParams) -> Result<SessionGoal> {
    let goal = owned(db.conn(), &input.session_id, &input.goal_id)?;
    live_claim(db.conn(), &goal, &input.turn_id)?;
    Ok(goal)
}
pub fn report(db: &Database, input: ReportParams) -> Result<SessionGoal> {
    bounded(&input.progress_summary, false)?;
    ensure!(input.outcomes.len() <= 100, "GOAL_INVALID_OUTCOMES");
    let tx = db.conn().unchecked_transaction()?;
    let mut goal = owned(&tx, &input.session_id, &input.goal_id)?;
    live_claim(&tx, &goal, &input.turn_id)?;
    let mut seen = HashSet::new();
    for outcome in &input.outcomes {
        bounded(&outcome.evidence, false)?;
        ensure!(
            goal.criteria.contains(&outcome.criterion) && seen.insert(&outcome.criterion),
            "GOAL_INVALID_OUTCOMES"
        );
    }
    ensure!(
        input
            .outcomes
            .iter()
            .map(|o| o.evidence.len())
            .sum::<usize>()
            <= 100_000,
        "GOAL_INVALID_OUTCOMES"
    );
    if matches!(input.status, ReportStatus::Completed) {
        ensure!(
            seen.len() == goal.criteria.len()
                && input
                    .outcomes
                    .iter()
                    .all(|o| o.outcome == CriterionOutcome::Met && !o.evidence.trim().is_empty()),
            "GOAL_COMPLETION_UNVERIFIED"
        );
    }
    audit::validate(
        input.audit.as_ref(),
        &goal.objective,
        matches!(input.status, ReportStatus::Completed),
    )?;
    goal.audit = input.audit;
    goal.progress_summary = input.progress_summary;
    goal.outcomes = input.outcomes;
    match input.status {
        ReportStatus::Active => {
            goal.status = GoalStatus::Active;
            goal.stop_reason = None;
        }
        ReportStatus::Blocked => stop(&mut goal, GoalStatus::Blocked, "model_reported_blocked"),
        ReportStatus::Completed => stop(&mut goal, GoalStatus::Completed, "criteria_reported_met"),
    }
    save(&tx, &mut goal)?;
    tx.commit()?;
    Ok(goal)
}

pub fn settle_turn(db: &Database, input: SettleParams) -> Result<(SessionGoal, bool)> {
    ensure!(
        (0..=MAX_SAFE_INTEGER).contains(&input.tokens),
        "GOAL_INVALID_TOKENS"
    );
    if let Some(error) = &input.error {
        bounded(error, false)?;
    }
    let tx = db.conn().unchecked_transaction()?;
    let mut goal = repository::owned_for_settlement(&tx, &input.session_id, &input.goal_id)?;
    let turn: Option<(bool, bool, Option<i64>)> = tx
        .query_row(
            "SELECT settled,interrupted,tokens FROM goal_turns WHERE turn_id=?1 AND goal_id=?2",
            params![input.turn_id, goal.id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    let interrupted = match turn {
        // Recovery settles execution immediately, but cannot invent usage.
        // Its one late usage report fills NULL exactly once, even for zero.
        Some((true, true, None)) => true,
        Some((true, _, _)) => return Ok((goal, false)),
        None => return Err(anyhow!("GOAL_TURN_STALE")),
        Some((false, interrupted, _)) => interrupted,
    };
    let owns_claim = goal.active_turn_id.as_deref() == Some(input.turn_id.as_str());
    ensure!(owns_claim || interrupted, "GOAL_TURN_STALE");
    goal.token_usage = goal
        .token_usage
        .checked_add(input.tokens)
        .filter(|n| *n <= MAX_SAFE_INTEGER)
        .ok_or_else(|| anyhow!("GOAL_COUNTER_OVERFLOW"))?;
    // Late accounting for a recovered turn must not clear a newer claim or
    // apply its old error/abort to a subsequently resumed execution.
    if owns_claim {
        goal.active_turn_id = None;
    }
    if owns_claim && goal.status == GoalStatus::Active {
        if input.error.is_some() {
            stop(&mut goal, GoalStatus::Blocked, "turn_error");
        } else if input.aborted {
            stop(&mut goal, GoalStatus::Paused, "turn_aborted");
        } else if goal.exhausted() {
            stop(&mut goal, GoalStatus::BudgetExhausted, "budget_exhausted");
        }
    }
    tx.execute(
        "UPDATE goal_turns SET settled=1,tokens=?2 WHERE turn_id=?1 AND tokens IS NULL",
        params![input.turn_id, input.tokens],
    )?;
    save(&tx, &mut goal)?;
    tx.commit()?;
    Ok((goal, true))
}
/// Fence crashed executions without replay. Retain their identities so a late
/// runtime settlement can account usage exactly once without touching a new
/// claim or replacement goal. Unknown usage is never invented on recovery.
pub fn recover(db: &Database) -> Result<()> {
    let tx = db.conn().unchecked_transaction()?;
    tx.execute(
        "UPDATE goal_turns SET settled=1,interrupted=1 WHERE settled=0",
        [],
    )?;
    tx.execute(
        "UPDATE session_goals SET
        status=CASE WHEN status='active' THEN 'paused' ELSE status END,
        stop_reason=CASE WHEN status='active' THEN 'host_restarted' ELSE stop_reason END,
        active_turn_id=NULL, active_since_ms=NULL, revision=revision+1
        WHERE status='active' OR active_turn_id IS NOT NULL OR active_since_ms IS NOT NULL",
        [],
    )?;
    tx.commit()?;
    Ok(())
}
#[cfg(test)]
mod tests;
