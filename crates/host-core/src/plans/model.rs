use super::*;

pub const PLAN_MAX_MARKDOWN_BYTES: usize = 512 * 1024;

pub const STATUS_PENDING: &str = "pending";
pub const STATUS_APPROVED: &str = "approved";
pub const STATUS_REJECTED: &str = "rejected";
pub const STATUS_EXPIRED: &str = "expired";
pub const STATUS_INTERRUPTED: &str = "interrupted";

pub const EXECUTION_QUEUED: &str = "queued";
pub const EXECUTION_RUNNING: &str = "running";
pub const EXECUTION_COMPLETED: &str = "completed";
pub const EXECUTION_INTERRUPTED: &str = "interrupted";

/// Approval kinds (D198). Plan and Goal share this pipeline; the kind decides
/// the operating mode that owns the approval and the artifact directory.
pub const KIND_PLAN: &str = "plan";
pub const KIND_GOAL: &str = "goal";

/// Map a wire kind onto a `'static` literal so SQL and paths can never carry
/// caller-controlled text.
pub fn normalize_kind(value: &str) -> Option<&'static str> {
    match value {
        KIND_PLAN => Some(KIND_PLAN),
        KIND_GOAL => Some(KIND_GOAL),
        _ => None,
    }
}

/// The approval kind a session's durable mode submits, if any.
pub fn kind_for_mode(mode: &str) -> Option<&'static str> {
    normalize_kind(mode)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlanArtifact {
    pub relative_path: String,
    pub sha256: String,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlanProposal {
    pub id: String,
    pub session_id: String,
    pub turn_id: String,
    pub tool_call_id: String,
    /// `plan` or `goal`; legacy rows read back as `plan`.
    pub kind: String,
    pub plan: String,
    pub markdown: String,
    pub title: String,
    pub question: String,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_permission_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub artifact: Option<PlanArtifact>,
    pub version: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution_state: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlanExecution {
    pub id: String,
    pub proposal_id: String,
    pub session_id: String,
    /// `plan` or `goal`; selects the execution instruction in the sidecar.
    pub kind: String,
    pub plan: String,
    pub title: String,
    pub question: String,
    pub artifact: PlanArtifact,
    pub target_permission_mode: String,
    pub state: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanResolution {
    pub status: String,
    pub proposal: PlanProposal,
    pub action: Option<String>,
    pub target_permission_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution: Option<PlanExecution>,
}

#[derive(Debug, Default)]
pub struct PlanManager;

pub struct PlanSubmitParams<'a> {
    pub workspace_root: &'a Path,
    pub session_id: &'a str,
    pub turn_id: &'a str,
    pub tool_call_id: &'a str,
    /// Contract kind being submitted; must match the session's durable mode.
    pub kind: &'a str,
    pub title: &'a str,
    pub markdown: &'a str,
    pub question: &'a str,
}

pub struct PlanResolveParams<'a> {
    pub workspace_root: Option<&'a Path>,
    pub proposal_id: &'a str,
    pub session_id: &'a str,
    pub turn_id: &'a str,
    pub tool_call_id: &'a str,
    pub version: Option<i64>,
    pub action: &'a str,
    pub target_permission_mode: Option<&'a str>,
}
