//! Owner controls are separate from runtime claim/report authority. Budget and
//! scope updates never imply permission to resume; deferred intent is durable.
use super::{
    bounded, budget_valid, expect_revision,
    repository::{owned, save},
    session_mode, stop, ControlAction, ControlParams, GoalStatus, SessionGoal,
};
use crate::db::Database;
use anyhow::{anyhow, ensure, Result};

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
        input.budget.is_none()
            || matches!(input.action, ControlAction::Resume | ControlAction::Budget),
        "GOAL_BUDGET_REQUIRES_BUDGET_OR_RESUME"
    );
    ensure!(
        input.objective.is_none() || matches!(input.action, ControlAction::Edit),
        "GOAL_OBJECTIVE_REQUIRES_EDIT"
    );
    match input.action {
        ControlAction::Pause => {
            if goal.status == GoalStatus::Active && goal.active_turn_id.is_some() {
                // Owner intent fences admission, not the live turn's tools/reports.
                goal.pause_requested = true;
            } else {
                stop(&mut goal, GoalStatus::Paused, "user_paused");
            }
        }
        ControlAction::Stop => stop(&mut goal, GoalStatus::Paused, "user_stopped"),
        ControlAction::Budget => {
            let budget = input.budget.ok_or_else(|| anyhow!("GOAL_INVALID_BUDGET"))?;
            budget_valid(&budget)?;
            if goal.active_turn_id.is_some() {
                goal.pending_budget = Some(budget);
            } else {
                goal.budget = budget;
                goal.pending_budget = None;
            }
        }
        ControlAction::Cancel => stop(&mut goal, GoalStatus::Cancelled, "user_cancelled"),
        ControlAction::Delete => {
            stop(&mut goal, GoalStatus::Cancelled, "user_deleted");
            goal.deleted = true;
            goal.pending_budget = None;
        }
        ControlAction::Edit => {
            let objective = input
                .objective
                .ok_or_else(|| anyhow!("GOAL_INVALID_TEXT"))?;
            bounded(&objective, true)?;
            goal.criteria = vec![objective.clone()];
            goal.objective = objective;
            goal.clear_evidence();
        }
        ControlAction::Resume => {
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
            goal.pause_requested = false;
            goal.status = GoalStatus::Active;
            goal.stop_reason = None;
        }
    }
    save(&tx, &mut goal)?;
    tx.commit()?;
    Ok(goal)
}
/// Only the settling owner may consume the staged budget. Late recovered usage
/// must not apply a newer turn's pending budget or resurrect a deleted goal.
pub(super) fn apply_pending_budget(goal: &mut SessionGoal) {
    if let Some(budget) = goal.pending_budget.take() {
        if !goal.deleted {
            goal.budget = budget;
        }
    }
}
