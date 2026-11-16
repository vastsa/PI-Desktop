//! Run state, RPC parameters and wire shapes (`packages/shared/src/types/mode-runs.ts`).

use std::collections::BTreeMap;

use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::db::ms_to_ts;

pub const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
/// Settled turn ids kept for idempotent settlement.
pub const SETTLED_TURNS_KEPT: usize = 32;
/// Upper bound for caller text stored on a run (input, summary, error).
pub const MAX_TEXT_BYTES: usize = 100_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunState {
    Running,
    Waiting,
    Paused,
    BudgetExhausted,
    Finished,
    Stopped,
}

impl RunState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Waiting => "waiting",
            Self::Paused => "paused",
            Self::BudgetExhausted => "budget_exhausted",
            Self::Finished => "finished",
            Self::Stopped => "stopped",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "running" => Self::Running,
            "waiting" => Self::Waiting,
            "paused" => Self::Paused,
            "budget_exhausted" => Self::BudgetExhausted,
            "finished" => Self::Finished,
            "stopped" => Self::Stopped,
            _ => return None,
        })
    }

    pub fn is_open(self) -> bool {
        matches!(
            self,
            Self::Running | Self::Waiting | Self::Paused | Self::BudgetExhausted
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WaitReason {
    Approval,
    Retries,
    TurnEnd,
    Error,
    Blocked,
}

impl WaitReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Approval => "approval",
            Self::Retries => "retries",
            Self::TurnEnd => "turn_end",
            Self::Error => "error",
            Self::Blocked => "blocked",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "approval" => Self::Approval,
            "retries" => Self::Retries,
            "turn_end" => Self::TurnEnd,
            "error" => Self::Error,
            "blocked" => Self::Blocked,
            _ => return None,
        })
    }
}

/// Who started the turn holding the claim. Custom Host-started modes are capped
/// at `accept-edits`; builtin Goal keeps the selected session permission.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Origin {
    User,
    Approval,
    Host,
}

impl Origin {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Approval => "approval",
            Self::Host => "host",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "user" => Self::User,
            "approval" => Self::Approval,
            "host" => Self::Host,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ModeRun {
    pub id: String,
    pub session_id: String,
    pub mode_id: String,
    pub snapshot_hash: String,
    pub input: String,
    pub stage_id: String,
    pub state: RunState,
    pub wait_reason: Option<WaitReason>,
    pub last_error: Option<String>,
    pub revision: i64,
    pub active_turn_id: Option<String>,
    pub active_origin: Option<Origin>,
    pub stage_entered: bool,
    pub advanced_in_turn: bool,
    pub pending_gate: Option<i64>,
    pub retry_counts: BTreeMap<String, i64>,
    pub rounds_completed: i64,
    pub tokens_used: i64,
    pub max_turns: Option<i64>,
    pub max_tokens: Option<i64>,
    pub artifact_paths: BTreeMap<String, String>,
    pub settled_turns: Vec<String>,
    /// Model evidence only; never an independent Host gate verdict.
    pub completion_report: Option<super::completion_report::CompletionReport>,
    /// Checkpointed running time, bounded to a JavaScript-safe integer.
    pub elapsed_ms: i64,
    /// Epoch ms at the latest running checkpoint; absent while frozen.
    pub active_since_ms: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
    pub finished_at: Option<i64>,
}

impl ModeRun {
    /// `ModeRun` wire shape; optional fields are omitted when absent.
    pub fn wire(&self) -> Value {
        let mut out = Map::new();
        out.insert("id".into(), json!(self.id));
        out.insert("sessionId".into(), json!(self.session_id));
        out.insert("modeId".into(), json!(self.mode_id));
        out.insert("snapshotHash".into(), json!(self.snapshot_hash));
        out.insert("input".into(), json!(self.input));
        out.insert("stageId".into(), json!(self.stage_id));
        out.insert("state".into(), json!(self.state.as_str()));
        if let Some(reason) = self.wait_reason {
            out.insert("waitReason".into(), json!(reason.as_str()));
        }
        if let Some(error) = &self.last_error {
            out.insert("lastError".into(), json!(error));
        }
        out.insert("revision".into(), json!(self.revision));
        if let Some(turn) = &self.active_turn_id {
            out.insert("activeTurnId".into(), json!(turn));
        }
        if let Some(origin) = self.active_origin {
            out.insert("activeOrigin".into(), json!(origin.as_str()));
        }
        out.insert("roundsCompleted".into(), json!(self.rounds_completed));
        out.insert("tokensUsed".into(), json!(self.tokens_used));
        out.insert("elapsedMs".into(), json!(self.elapsed_ms));
        if let Some(since) = self.active_since_ms {
            out.insert("activeSinceMs".into(), json!(since));
        }
        out.insert("maxTurns".into(), json!(self.max_turns));
        out.insert("maxTokens".into(), json!(self.max_tokens));
        out.insert("artifactPaths".into(), json!(self.artifact_paths));
        if let Some(report) = &self.completion_report {
            out.insert("completionReport".into(), json!(report));
        }
        out.insert("createdAt".into(), json!(ms_to_ts(self.created_at)));
        out.insert("updatedAt".into(), json!(ms_to_ts(self.updated_at)));
        if let Some(finished) = self.finished_at {
            out.insert("finishedAt".into(), json!(ms_to_ts(finished)));
        }
        Value::Object(out)
    }

    pub fn budget_exhausted(&self) -> bool {
        self.max_turns
            .is_some_and(|limit| self.rounds_completed >= limit)
            || self
                .max_tokens
                .is_some_and(|limit| self.tokens_used >= limit)
    }

    pub fn claimed_by(&self, turn_id: &str) -> bool {
        self.active_turn_id.as_deref() == Some(turn_id)
    }

    pub fn clear_claim(&mut self) {
        self.active_turn_id = None;
        self.active_origin = None;
        self.pending_gate = None;
    }

    pub fn set_waiting(&mut self, reason: WaitReason) {
        self.state = RunState::Waiting;
        self.wait_reason = Some(reason);
    }

    pub fn set_state(&mut self, state: RunState) {
        self.state = state;
        self.wait_reason = None;
    }

    /// Move to `stage`; the next claim reports `enteredStage` and the turn
    /// that moved it may continue.
    pub fn enter_stage(&mut self, stage: &str) {
        self.stage_id = stage.to_string();
        self.stage_entered = true;
        self.advanced_in_turn = true;
        self.pending_gate = None;
    }

    pub fn clear_retries(&mut self, stage: &str) {
        let prefix = format!("{stage}:");
        self.retry_counts.retain(|key, _| !key.starts_with(&prefix));
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionParams {
    pub session_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartParams {
    pub session_id: String,
    pub input: String,
    pub turn_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimParams {
    pub session_id: String,
    pub run_id: String,
    pub expected_revision: i64,
    pub turn_id: String,
    pub origin: Origin,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompleteStageParams {
    pub session_id: String,
    pub run_id: String,
    pub turn_id: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub artifacts: Option<BTreeMap<String, String>>,
    /// The run input the calling turn was claimed with. A mismatch means the
    /// user edited the objective during the turn (`MODE_INPUT_CHANGED`).
    #[serde(default)]
    pub input: Option<String>,
    /// Kept raw until independent Host validation, including explicit null.
    #[serde(
        default,
        deserialize_with = "super::completion_report::deserialize_report"
    )]
    pub report: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GateResultParams {
    pub session_id: String,
    pub run_id: String,
    pub turn_id: String,
    pub gate_index: i64,
    pub tool_call_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ResolveAction {
    Approve,
    Reject,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveParams {
    pub session_id: String,
    pub run_id: String,
    pub expected_revision: i64,
    pub action: ResolveAction,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TurnOutcome {
    Completed,
    Error,
    Aborted,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettleParams {
    pub session_id: String,
    pub run_id: String,
    pub turn_id: String,
    #[serde(default)]
    pub tokens: i64,
    pub outcome: TurnOutcome,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ControlAction {
    Pause,
    Resume,
    /// End the run and interrupt its active turn.
    Stop,
    /// End the run without interrupting its active turn, which finishes as
    /// an ordinary turn of the mode the session returns to.
    Remove,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlParams {
    pub session_id: String,
    pub run_id: String,
    pub expected_revision: i64,
    pub action: ControlAction,
}

/// `modes.update`: the user edits an open run. The input (the objective) and
/// the budget apply from the next claim; the turn holding the claim keeps the
/// input it started with and cannot complete the stage for the new one.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateParams {
    pub session_id: String,
    pub run_id: String,
    pub expected_revision: i64,
    #[serde(default)]
    pub input: Option<String>,
    #[serde(default)]
    pub budget: Option<super::budget::RunBudget>,
}

/// `ModeClaimResult`. `changed` is Host-internal: a committed state change
/// that must be announced with `modes.changed`.
#[derive(Debug, Clone)]
pub struct ClaimResult {
    pub claimed: bool,
    pub run: ModeRun,
    pub entered_stage: bool,
    pub definition: Option<Value>,
    pub changed: bool,
}

impl ClaimResult {
    pub fn wire(&self) -> Value {
        let mut out = json!({
            "claimed": self.claimed,
            "run": self.run.wire(),
            "enteredStage": self.entered_stage,
        });
        if let Some(definition) = &self.definition {
            out["definition"] = definition.clone();
        }
        out
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum StageStatus {
    Failed {
        gate_index: i64,
        message: String,
        retries_left: i64,
    },
    Run {
        gate_index: i64,
        command: String,
        timeout_minutes: i64,
    },
    AwaitingApproval,
    Advanced {
        next_stage_id: String,
    },
    Goto {
        next_stage_id: String,
        message: String,
    },
    Blocked {
        message: String,
    },
    Finished,
}

/// `ModeStageOutcome`.
#[derive(Debug, Clone)]
pub struct StageOutcome {
    pub status: StageStatus,
    pub run: ModeRun,
}

impl StageOutcome {
    pub fn wire(&self) -> Value {
        let mut out = match &self.status {
            StageStatus::Failed {
                gate_index,
                message,
                retries_left,
            } => json!({
                "status": "failed",
                "gateIndex": gate_index,
                "message": message,
                "retriesLeft": retries_left,
            }),
            StageStatus::Run {
                gate_index,
                command,
                timeout_minutes,
            } => json!({
                "status": "run",
                "gateIndex": gate_index,
                "command": command,
                "timeoutMinutes": timeout_minutes,
            }),
            StageStatus::AwaitingApproval => json!({ "status": "awaiting_approval" }),
            StageStatus::Advanced { next_stage_id } => {
                json!({ "status": "advanced", "nextStageId": next_stage_id })
            }
            StageStatus::Goto {
                next_stage_id,
                message,
            } => json!({ "status": "goto", "nextStageId": next_stage_id, "message": message }),
            StageStatus::Blocked { message } => json!({ "status": "blocked", "message": message }),
            StageStatus::Finished => json!({ "status": "finished" }),
        };
        out["run"] = self.run.wire();
        out
    }
}

/// `{ run, continue }` for settle / resolve / control.
#[derive(Debug, Clone)]
pub struct ContinueResult {
    pub run: ModeRun,
    pub continue_run: bool,
    pub changed: bool,
}

impl ContinueResult {
    pub fn wire(&self) -> Value {
        json!({ "run": self.run.wire(), "continue": self.continue_run })
    }
}

/// Keep the last `max` bytes of `text` on a character boundary.
pub fn tail(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_string();
    }
    let mut start = text.len() - max;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    text[start..].to_string()
}
