use serde::{Deserialize, Serialize};

pub const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GoalStatus {
    Active,
    Paused,
    Blocked,
    Completed,
    BudgetExhausted,
    Cancelled,
}
impl GoalStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Paused => "paused",
            Self::Blocked => "blocked",
            Self::Completed => "completed",
            Self::BudgetExhausted => "budget_exhausted",
            Self::Cancelled => "cancelled",
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GoalBudget {
    // deserialize_with deliberately makes this nullable field REQUIRED.
    #[serde(deserialize_with = "required_turn_limit")]
    pub max_turns: Option<i64>,
    #[serde(
        default,
        deserialize_with = "present_value",
        skip_serializing_if = "Option::is_none"
    )]
    pub max_tokens: Option<i64>,
}
impl Default for GoalBudget {
    fn default() -> Self {
        Self {
            max_turns: Some(20),
            max_tokens: None,
        }
    }
}
fn audit_version<'de, D: serde::Deserializer<'de>>(d: D) -> Result<u8, D::Error> {
    let version = u8::deserialize(d)?;
    if version != 1 {
        return Err(serde::de::Error::custom("unsupported Goal audit version"));
    }
    Ok(version)
}
fn required_turn_limit<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<i64>, D::Error> {
    Option::<i64>::deserialize(d)
}
// Missing optional fields use serde(default); an explicitly supplied null is
// not a valid object/number and must not become an unlimited authorization.
fn present_value<'de, D, T>(d: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(d).map(Some)
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GoalAuditItem {
    pub requirement: String,
    pub outcome: CriterionOutcome,
    pub evidence: String,
}
/// Current-model claims only, never independent host verification.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GoalAudit {
    #[serde(deserialize_with = "audit_version")]
    pub version: u8,
    pub objective: String,
    pub items: Vec<GoalAuditItem>,
    pub remaining_work: Vec<String>,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CriterionOutcome {
    Met,
    Unmet,
    Unverified,
}
/// Model-supplied evidence claims, not independently verified host proof.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GoalOutcome {
    pub criterion: String,
    pub outcome: CriterionOutcome,
    pub evidence: String,
}
/// Host-owned immutable scope for one admitted execution turn.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GoalScope {
    pub objective: String,
    pub criteria: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionGoal {
    pub id: String,
    pub session_id: String,
    pub revision: i64,
    pub status: GoalStatus,
    pub objective: String,
    pub criteria: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_scope: Option<GoalScope>,
    pub progress_summary: String,
    pub rounds_started: i64,
    pub token_usage: i64,
    #[serde(
        default,
        rename = "elapsedSeconds",
        serialize_with = "serialize_seconds",
        deserialize_with = "deserialize_seconds"
    )]
    pub elapsed_ms: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_since_ms: Option<i64>,
    // Logical removal is internal: public RPC results expose a tombstone.
    #[serde(skip)]
    pub(crate) deleted: bool,
    pub budget: GoalBudget,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_budget: Option<GoalBudget>,
    #[serde(default)]
    pub pause_requested: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_turn_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_reason: Option<String>,
    pub outcomes: Vec<GoalOutcome>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audit: Option<GoalAudit>,
}
impl SessionGoal {
    pub fn exhausted(&self) -> bool {
        self.budget
            .max_turns
            .is_some_and(|limit| self.rounds_started >= limit)
            || self
                .budget
                .max_tokens
                .is_some_and(|limit| self.token_usage >= limit)
    }
    pub(super) fn scope_changed(&self) -> bool {
        self.active_scope.as_ref().is_some_and(|scope| {
            scope.objective != self.objective || scope.criteria != self.criteria
        })
    }
    pub(super) fn clear_evidence(&mut self) {
        self.progress_summary.clear();
        self.outcomes.clear();
        self.audit = None;
    }
}
fn serialize_seconds<S: serde::Serializer>(ms: &i64, serializer: S) -> Result<S::Ok, S::Error> {
    serializer.serialize_f64(*ms as f64 / 1000.0)
}
fn deserialize_seconds<'de, D: serde::Deserializer<'de>>(d: D) -> Result<i64, D::Error> {
    let seconds = f64::deserialize(d)?;
    if !seconds.is_finite() || seconds < 0.0 || seconds * 1000.0 > MAX_SAFE_INTEGER as f64 {
        return Err(serde::de::Error::custom("invalid elapsedSeconds"));
    }
    Ok((seconds * 1000.0).round() as i64)
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GetParams {
    pub session_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartParams {
    pub session_id: String,
    pub objective: String,
    pub criteria: Option<Vec<String>>,
    #[serde(default, deserialize_with = "present_value")]
    pub budget: Option<GoalBudget>,
}
#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ControlAction {
    Pause,
    Stop,
    Budget,
    Resume,
    Cancel,
    Edit,
    Delete,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ControlParams {
    pub session_id: String,
    pub goal_id: String,
    pub expected_revision: i64,
    pub action: ControlAction,
    #[serde(default, deserialize_with = "present_value")]
    pub budget: Option<GoalBudget>,
    #[serde(default, deserialize_with = "present_value")]
    pub objective: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClaimParams {
    pub session_id: String,
    pub goal_id: String,
    pub expected_revision: i64,
    pub turn_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TurnParams {
    pub session_id: String,
    pub goal_id: String,
    pub turn_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReportStatus {
    Active,
    Blocked,
    Completed,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReportParams {
    pub session_id: String,
    pub goal_id: String,
    pub turn_id: String,
    pub progress_summary: String,
    pub status: ReportStatus,
    pub outcomes: Vec<GoalOutcome>,
    #[serde(default, deserialize_with = "present_value")]
    pub audit: Option<GoalAudit>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettleParams {
    pub session_id: String,
    pub goal_id: String,
    pub turn_id: String,
    pub tokens: i64,
    pub error: Option<String>,
    #[serde(default)]
    pub aborted: bool,
}
