//! Bounded model-supplied completion evidence. This never proves a Host gate.

use std::collections::HashSet;

use anyhow::Result;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

use super::mode_error_detail;

const MAX_REPORT_BYTES: usize = 262_144;
const MAX_ITEMS: usize = 64;
const MAX_CRITERION_BYTES: usize = 4_096;
const MAX_EVIDENCE_BYTES: usize = 16_384;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CompletionStatus {
    Completed,
    Blocked,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CriterionOutcome {
    Met,
    Unmet,
    Unverified,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CompletionOutcome {
    pub criterion: String,
    pub outcome: CriterionOutcome,
    pub evidence: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompletionReport {
    pub status: CompletionStatus,
    pub outcomes: Vec<CompletionOutcome>,
    pub remaining_work: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocker_reason: Option<String>,
}

fn invalid(detail: impl std::fmt::Display) -> anyhow::Error {
    mode_error_detail("MODE_INVALID_ARGUMENT", detail)
}

fn text(value: &str, limit: usize, field: &str) -> Result<()> {
    if value.trim().is_empty() || value.len() > limit {
        return Err(invalid(format!(
            "report {field} must be nonblank and at most {limit} UTF-8 bytes"
        )));
    }
    Ok(())
}

impl CompletionReport {
    /// Validate again at the Host boundary, independently of the runtime schema.
    pub(super) fn parse(value: Value) -> Result<Self> {
        if serde_json::to_vec(&value)?.len() > MAX_REPORT_BYTES {
            return Err(invalid("report exceeds 262144 serialized bytes"));
        }
        // Optional means absent, not an explicitly null blocker reason.
        if value.get("blockerReason").is_some_and(Value::is_null) {
            return Err(invalid(
                "report blockerReason must be a string when provided",
            ));
        }
        let report: Self = serde_json::from_value(value).map_err(invalid)?;
        if report.outcomes.is_empty() || report.outcomes.len() > MAX_ITEMS {
            return Err(invalid("report outcomes must contain 1..64 items"));
        }
        if report.remaining_work.len() > MAX_ITEMS {
            return Err(invalid(
                "report remainingWork must contain at most 64 items",
            ));
        }
        let mut criteria = HashSet::new();
        for outcome in &report.outcomes {
            text(&outcome.criterion, MAX_CRITERION_BYTES, "criterion")?;
            text(&outcome.evidence, MAX_EVIDENCE_BYTES, "evidence")?;
            if !criteria.insert(outcome.criterion.trim()) {
                return Err(invalid("report criteria must be unique after trimming"));
            }
        }
        for remaining in &report.remaining_work {
            text(remaining, MAX_CRITERION_BYTES, "remainingWork item")?;
        }
        if let Some(reason) = &report.blocker_reason {
            text(reason, MAX_EVIDENCE_BYTES, "blockerReason")?;
        }
        let all_met = report
            .outcomes
            .iter()
            .all(|item| item.outcome == CriterionOutcome::Met);
        match report.status {
            CompletionStatus::Completed
                if !all_met
                    || !report.remaining_work.is_empty()
                    || report.blocker_reason.is_some() =>
            {
                return Err(invalid("completed report requires all outcomes met, no remaining work and no blockerReason"));
            }
            CompletionStatus::Blocked
                if report.blocker_reason.is_none()
                    || (all_met && report.remaining_work.is_empty()) =>
            {
                return Err(invalid("blocked report requires blockerReason and unmet/unverified outcomes or remaining work"));
            }
            _ => {}
        }
        Ok(report)
    }
}

/// Preserve explicit null so invalid reports receive MODE_INVALID_ARGUMENT in
/// the engine instead of being silently treated as a legacy absent report.
pub(super) fn deserialize_report<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Option<Value>, D::Error> {
    Value::deserialize(deserializer).map(Some)
}
