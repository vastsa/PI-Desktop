use super::{CriterionOutcome, GoalAudit};
use anyhow::{ensure, Result};
use std::collections::HashSet;

/// Enforce shape and report consistency, not truth of natural-language claims.
pub(super) fn validate(audit: Option<&GoalAudit>, objective: &str, completed: bool) -> Result<()> {
    let Some(audit) = audit else {
        ensure!(!completed, "GOAL_COMPLETION_UNVERIFIED");
        return Ok(());
    };
    ensure!(
        audit.version == 1 && audit.objective == objective,
        "GOAL_INVALID_AUDIT"
    );
    ensure!(
        audit.items.len() <= 100 && audit.remaining_work.len() <= 100,
        "GOAL_INVALID_AUDIT"
    );
    let mut seen = HashSet::new();
    let mut bytes = 0usize;
    for item in &audit.items {
        ensure!(
            !item.requirement.trim().is_empty() && seen.insert(item.requirement.trim()),
            "GOAL_INVALID_AUDIT"
        );
        bytes += item.requirement.len() + item.evidence.len();
    }
    for work in &audit.remaining_work {
        ensure!(!work.trim().is_empty(), "GOAL_INVALID_AUDIT");
        bytes += work.len();
    }
    ensure!(bytes <= 100_000, "GOAL_INVALID_AUDIT");
    if completed {
        ensure!(
            !audit.items.is_empty()
                && audit.remaining_work.is_empty()
                && audit
                    .items
                    .iter()
                    .all(|item| item.outcome == CriterionOutcome::Met
                        && !item.evidence.trim().is_empty()),
            "GOAL_COMPLETION_UNVERIFIED"
        );
    }
    Ok(())
}
