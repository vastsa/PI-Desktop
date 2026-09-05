//! Rust mirrors of the A2A wire contract in `packages/shared/src/a2a.ts`.
//!
//! Every type here serializes to/deserializes from exactly the JSON shapes the
//! shared TypeScript module defines (camelCase fields, `kind` discriminators,
//! kebab-case task-state and event values). The two files are hand-mirrored;
//! a change in one must be reflected in the other.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

// ---------------------------------------------------------------------------
// Bounds. Mirrors `packages/shared/src/a2a.ts`.
// ---------------------------------------------------------------------------

pub const A2A_MAX_TEXT_CHARS: usize = 16_000;
pub const A2A_MAX_FILE_BYTES: usize = 20 * 1024 * 1024;
pub const A2A_MAX_TASK_HISTORY: usize = 256;
pub const A2A_MAX_TASKS_PER_CONTEXT: usize = 128;
pub const A2A_MAX_SENDS_PER_RUN: usize = 200;

// ---------------------------------------------------------------------------
// Error codes (AppError.code strings).
// ---------------------------------------------------------------------------

pub mod error_codes {
    pub const UNKNOWN_TOKEN: &str = "A2A_UNKNOWN_TOKEN";
    pub const UNKNOWN_AGENT: &str = "A2A_UNKNOWN_AGENT";
    pub const UNKNOWN_TASK: &str = "A2A_UNKNOWN_TASK";
    pub const CROSS_CONTEXT_DENIED: &str = "A2A_CROSS_CONTEXT_DENIED";
    pub const INVALID_TRANSITION: &str = "A2A_INVALID_TRANSITION";
    pub const TASK_TERMINAL: &str = "A2A_TASK_TERMINAL";
    pub const SEND_CAP: &str = "A2A_SEND_CAP";
    pub const NO_PEERS: &str = "A2A_NO_PEERS";
    pub const PAYLOAD_TOO_LARGE: &str = "A2A_PAYLOAD_TOO_LARGE";
}

/// Broker error → (errorCode string, human message). Numeric JSON-RPC codes are
/// assigned by the RPC layer; the string code is the contract discriminator.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum A2aError {
    UnknownToken,
    UnknownAgent,
    UnknownTask,
    /// Reserved (ADR 0147). Cross-session addressing is allowed (ADR 0162);
    /// non-parties fail as `UnknownAgent` instead.
    #[allow(dead_code)]
    CrossContextDenied,
    InvalidTransition,
    TaskTerminal,
    SendCap,
    NoPeers,
    PayloadTooLarge,
    Internal(String),
}

impl A2aError {
    pub fn code(&self) -> &'static str {
        match self {
            A2aError::UnknownToken => error_codes::UNKNOWN_TOKEN,
            A2aError::UnknownAgent => error_codes::UNKNOWN_AGENT,
            A2aError::UnknownTask => error_codes::UNKNOWN_TASK,
            A2aError::CrossContextDenied => error_codes::CROSS_CONTEXT_DENIED,
            A2aError::InvalidTransition => error_codes::INVALID_TRANSITION,
            A2aError::TaskTerminal => error_codes::TASK_TERMINAL,
            A2aError::SendCap => error_codes::SEND_CAP,
            A2aError::NoPeers => error_codes::NO_PEERS,
            A2aError::PayloadTooLarge => error_codes::PAYLOAD_TOO_LARGE,
            A2aError::Internal(_) => "INTERNAL",
        }
    }

    pub fn message(&self) -> String {
        match self {
            A2aError::UnknownToken => "unknown capability token".into(),
            A2aError::UnknownAgent => "unknown recipient agent".into(),
            A2aError::UnknownTask => "unknown task".into(),
            A2aError::CrossContextDenied => "task belongs to another context".into(),
            A2aError::InvalidTransition => "illegal task state transition".into(),
            A2aError::TaskTerminal => "task is already in a terminal state".into(),
            A2aError::SendCap => "send cap exceeded for this run".into(),
            A2aError::NoPeers => "no reachable peers".into(),
            A2aError::PayloadTooLarge => "file part exceeds the byte limit".into(),
            A2aError::Internal(message) => message.clone(),
        }
    }
}

impl std::fmt::Display for A2aError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code(), self.message())
    }
}

impl std::error::Error for A2aError {}

// ---------------------------------------------------------------------------
// Task lifecycle.
// ---------------------------------------------------------------------------

/// A2A `TaskState`. `input-required`/`auth-required` are kebab-case on the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TaskState {
    Submitted,
    Working,
    InputRequired,
    AuthRequired,
    Completed,
    Canceled,
    Failed,
    Rejected,
}

impl TaskState {
    /// Legal successor states. Mirrors `A2A_TASK_TRANSITIONS` exactly.
    fn transitions(self) -> &'static [TaskState] {
        use TaskState::*;
        match self {
            Submitted => &[
                Working,
                InputRequired,
                AuthRequired,
                Completed,
                Canceled,
                Failed,
                Rejected,
            ],
            Working => &[
                Working,
                InputRequired,
                AuthRequired,
                Completed,
                Canceled,
                Failed,
                Rejected,
            ],
            InputRequired => &[Working, Canceled, Failed, Rejected],
            AuthRequired => &[Working, Canceled, Failed, Rejected],
            Completed | Canceled | Failed | Rejected => &[],
        }
    }
}

/// Whether `from → to` is a legal transition. Mirrors `canTransitionA2ATask`.
pub fn can_transition(from: TaskState, to: TaskState) -> bool {
    from.transitions().contains(&to)
}

/// Whether a state is terminal. Mirrors `A2A_TERMINAL_TASK_STATES`.
pub fn is_terminal(state: TaskState) -> bool {
    matches!(
        state,
        TaskState::Completed | TaskState::Canceled | TaskState::Failed | TaskState::Rejected
    )
}

// ---------------------------------------------------------------------------
// Message parts.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uri: Option<String>,
    /// Inline base64 bytes; bounded by `A2A_MAX_FILE_BYTES`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes: Option<String>,
}

/// A2A `Part`. `kind` selects the variant: "text" | "file" | "data".
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Part {
    Text { text: String },
    File { file: FileContent },
    Data { data: Map<String, Value> },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    User,
    Agent,
}

/// A2A `Message`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub role: Role,
    pub parts: Vec<Part>,
    pub message_id: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub task_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub context_id: Option<String>,
    /// Sender peer id, stamped by the broker (never a model input).
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub from: Option<String>,
    /// Recipient agent name; omitted means the task's owning agent.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub to: Option<String>,
}

/// A2A `Artifact`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Artifact {
    pub artifact_id: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub description: Option<String>,
    pub parts: Vec<Part>,
}

/// A2A `TaskStatus`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskStatus {
    pub state: TaskState,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub message: Option<Message>,
    /// ISO-8601 UTC timestamp of the last transition.
    pub timestamp: String,
}

/// The `kind: "task"` discriminator for the A2A Task resource.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum TaskKind {
    #[default]
    Task,
}

/// A2A `Task` resource.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    #[serde(default)]
    pub kind: TaskKind,
    pub id: String,
    pub context_id: String,
    pub status: TaskStatus,
    pub history: Vec<Message>,
    pub artifacts: Vec<Artifact>,
    /// Peer id of the agent that owns/serves this task.
    pub agent_name: String,
    /// Peer id of the agent that requested this task (sender of the first
    /// message). Status/terminal events route to the counterpart of whoever
    /// caused them, so the requester receives the worker's completion.
    pub requester_name: String,
}

// ---------------------------------------------------------------------------
// Agent card.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSkill {
    pub id: String,
    pub name: String,
    pub description: String,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCapabilities {
    pub streaming: bool,
    pub push_notifications: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCard {
    pub name: String,
    pub description: String,
    pub version: String,
    pub skills: Vec<AgentSkill>,
    pub capabilities: AgentCapabilities,
    pub default_input_modes: Vec<String>,
    pub default_output_modes: Vec<String>,
    /// Session id this agent registered under. Stamped by the broker.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub context_id: Option<String>,
}

// ---------------------------------------------------------------------------
// Stream events.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskStatusUpdateEvent {
    pub task_id: String,
    pub context_id: String,
    pub status: TaskStatus,
    /// True when this is the last event for the task (terminal state).
    #[serde(rename = "final")]
    pub is_final: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskArtifactUpdateEvent {
    pub task_id: String,
    pub context_id: String,
    pub artifact: Artifact,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub append: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub last_chunk: Option<bool>,
}

/// A2A `StreamEvent`. Internally tagged by `kind` (kebab-case).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum StreamEvent {
    StatusUpdate(TaskStatusUpdateEvent),
    ArtifactUpdate(TaskArtifactUpdateEvent),
}

// ---------------------------------------------------------------------------
// Push config + message-send configuration.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushNotificationConfig {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub token: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MessageSendConfiguration {
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub blocking: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub history_length: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub push_notification_config: Option<PushNotificationConfig>,
}

// ---------------------------------------------------------------------------
// RPC params / results.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentsRegisterParams {
    pub context_id: String,
    pub card: AgentCard,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentsRegisterResult {
    pub agent_id: String,
    pub token: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentsDeregisterParams {
    pub token: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentsDeregisterResult {
    pub ok: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentsListParams {
    pub token: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentsListResult {
    pub agents: Vec<AgentCard>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageSendParams {
    pub token: String,
    pub message: Message,
    #[serde(default)]
    pub configuration: Option<MessageSendConfiguration>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageSendResult {
    pub task: Task,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageStreamParams {
    pub token: String,
    pub message: Message,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TasksGetParams {
    pub token: String,
    pub id: String,
    #[serde(default)]
    pub history_length: Option<usize>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TasksCancelParams {
    pub token: String,
    pub id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TasksStatusParams {
    pub token: String,
    pub id: String,
    /// Target state (`working`, `input-required`, `auth-required`,
    /// `completed`, `failed`, `rejected`). The broker validates the transition.
    pub state: TaskState,
    /// Optional final/status message; stamped with the caller's `from` and
    /// appended to history like any other message.
    #[serde(default)]
    pub message: Option<Message>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TasksResubscribeParams {
    pub token: String,
    pub id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskResult {
    pub task: Task,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushConfigSetParams {
    pub token: String,
    pub task_id: String,
    pub config: PushNotificationConfig,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushConfigSetResult {
    pub config: PushNotificationConfig,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushConfigGetParams {
    pub token: String,
    pub task_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushConfigGetResult {
    pub config: Option<PushNotificationConfig>,
}

// ---------------------------------------------------------------------------
// Notification envelopes (host→client).
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskEventNotification {
    /// Peer id of the client that should receive this event.
    pub recipient: String,
    /// Session id of `recipient`. Session runtimes drop events not addressed to them.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub recipient_context_id: Option<String>,
    pub context_id: String,
    pub event: StreamEvent,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushNotification {
    pub recipient: String,
    /// Session id of `recipient`. Session runtimes drop events not addressed to them.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub recipient_context_id: Option<String>,
    pub context_id: String,
    pub task_id: String,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub token: Option<String>,
    pub status: TaskStatus,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legal_and_illegal_transitions_match_the_contract() {
        // Legal: submitted → working; working → completed; input-required → working.
        assert!(can_transition(TaskState::Submitted, TaskState::Working));
        assert!(can_transition(TaskState::Working, TaskState::Completed));
        assert!(can_transition(TaskState::InputRequired, TaskState::Working));
        assert!(can_transition(TaskState::AuthRequired, TaskState::Canceled));
        assert!(can_transition(TaskState::Working, TaskState::Working));

        // Illegal: out of terminal, or a jump the contract forbids.
        assert!(!can_transition(TaskState::Completed, TaskState::Working));
        assert!(!can_transition(TaskState::Canceled, TaskState::Working));
        assert!(!can_transition(
            TaskState::InputRequired,
            TaskState::AuthRequired
        ));
        assert!(!can_transition(
            TaskState::InputRequired,
            TaskState::Completed
        ));
        assert!(!can_transition(TaskState::Submitted, TaskState::Submitted));
    }

    #[test]
    fn terminal_states_match_the_contract() {
        for state in [
            TaskState::Completed,
            TaskState::Canceled,
            TaskState::Failed,
            TaskState::Rejected,
        ] {
            assert!(is_terminal(state));
            assert!(state.transitions().is_empty());
        }
        for state in [
            TaskState::Submitted,
            TaskState::Working,
            TaskState::InputRequired,
            TaskState::AuthRequired,
        ] {
            assert!(!is_terminal(state));
        }
    }

    #[test]
    fn task_state_serializes_kebab_case() {
        assert_eq!(
            serde_json::to_value(TaskState::InputRequired).unwrap(),
            serde_json::json!("input-required")
        );
        assert_eq!(
            serde_json::to_value(TaskState::AuthRequired).unwrap(),
            serde_json::json!("auth-required")
        );
        assert_eq!(
            serde_json::to_value(TaskState::Working).unwrap(),
            serde_json::json!("working")
        );
    }

    #[test]
    fn part_kinds_round_trip() {
        let text = Part::Text { text: "hi".into() };
        assert_eq!(
            serde_json::to_value(&text).unwrap(),
            serde_json::json!({ "kind": "text", "text": "hi" })
        );
        let file = Part::File {
            file: FileContent {
                name: Some("a.txt".into()),
                mime_type: Some("text/plain".into()),
                uri: None,
                bytes: None,
            },
        };
        assert_eq!(
            serde_json::to_value(&file).unwrap(),
            serde_json::json!({
                "kind": "file",
                "file": { "name": "a.txt", "mimeType": "text/plain" }
            })
        );
    }

    #[test]
    fn status_update_event_serializes_with_final_and_kebab_kind() {
        let event = StreamEvent::StatusUpdate(TaskStatusUpdateEvent {
            task_id: "t1".into(),
            context_id: "c1".into(),
            status: TaskStatus {
                state: TaskState::Completed,
                message: None,
                timestamp: "2024-01-01T00:00:00.000Z".into(),
            },
            is_final: true,
        });
        assert_eq!(
            serde_json::to_value(&event).unwrap(),
            serde_json::json!({
                "kind": "status-update",
                "taskId": "t1",
                "contextId": "c1",
                "status": {
                    "state": "completed",
                    "timestamp": "2024-01-01T00:00:00.000Z"
                },
                "final": true
            })
        );
    }
}
