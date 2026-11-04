//! Granted native application control (ADR 0340).
//!
//! This module is the only place that may refuse a computer-use request, so
//! every refusal lives here rather than in the caller: the loop that decides
//! what to do runs in Electron main, and main is not trusted to police itself.
//! The platform backends below it can only *attempt* work — they never see a
//! request that policy has not already admitted.
//!
//! Two refusals are unconditional and have no setting, grant option, or
//! permission mode that reaches them: this application's own windows are never
//! a target (synthetic input into PI-Desktop would bypass the permission
//! broker), and a secure input state refuses both inspection and input.

pub mod backend;
#[cfg(target_os = "macos")]
mod macos;
mod policy;
#[cfg(test)]
mod tests;

use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

pub use backend::{DesktopError, Dispatched, TargetRef};

/// Hard ceiling on the tree one `inspect` returns. Mirrors
/// `COMPUTER_MAX_NODES` in `@pi-desktop/shared`.
pub const MAX_NODES: usize = 400;
/// Hard ceiling on one accessible label, so a hostile window cannot pad a
/// model context through its own titles.
pub const MAX_LABEL_CHARS: usize = 200;
/// Hard ceiling on text one step may type.
pub const MAX_TEXT_CHARS: usize = 2_000;
/// Clamp on any caller-supplied action budget.
pub const MAX_ACTION_BUDGET: u32 = 200;
pub const DEFAULT_ACTION_BUDGET: u32 = 40;
pub const DEFAULT_IDLE_EXPIRY: Duration = Duration::from_secs(15 * 60);
pub const MAX_IDLE_EXPIRY: Duration = Duration::from_secs(60 * 60);
pub const MIN_IDLE_EXPIRY: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    pub fn contains(&self, x: f64, y: f64) -> bool {
        x >= 0.0 && y >= 0.0 && x <= self.width && y <= self.height
    }

    /// Geometry equality with a tolerance, because a window can be reported
    /// with sub-pixel jitter without having actually moved.
    pub fn matches(&self, other: &Rect) -> bool {
        const TOLERANCE: f64 = 1.0;
        (self.x - other.x).abs() <= TOLERANCE
            && (self.y - other.y).abs() <= TOLERANCE
            && (self.width - other.width).abs() <= TOLERANCE
            && (self.height - other.height).abs() <= TOLERANCE
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum InputPolicy {
    ConfirmEach,
    AutonomousInScope,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CaptureMode {
    A11yOnly,
    A11yAndPixels,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Fidelity {
    Full,
    Partial,
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PermissionState {
    Granted,
    Denied,
    NotRequested,
    Unsupported,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TargetRefusal {
    /// A PI-Desktop window. Unconditional.
    #[serde(rename = "self")]
    SelfTarget,
    Denylisted,
    Elevated,
    NoAccessibility,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub target_id: String,
    pub app_name: String,
    pub title: String,
    pub app_key: String,
    pub bounds: Rect,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refused_reason: Option<TargetRefusal>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub platform: String,
    pub backend: String,
    pub fidelity: Fidelity,
    pub accessibility: PermissionState,
    pub capture: PermissionState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_unsupported_reason: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GrantState {
    Active,
    Revoked,
    Expired,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GrantView {
    pub grant_id: String,
    pub revision: u32,
    pub target_id: String,
    pub target_label: String,
    pub app_key: String,
    pub bounds: Rect,
    pub input_policy: InputPolicy,
    pub capture: CaptureMode,
    pub remaining_budget: u32,
    pub session_id: String,
    pub created_at: String,
    pub expires_at: String,
    pub state: GrantState,
}

/// The authoritative grant. It is process-local and never persisted: a restart
/// must not hand a new process authority over the user's screen.
#[derive(Debug, Clone)]
pub struct Grant {
    pub grant_id: String,
    pub revision: u32,
    pub target: TargetRef,
    pub target_label: String,
    pub bounds: Rect,
    pub input_policy: InputPolicy,
    pub capture: CaptureMode,
    pub remaining_budget: u32,
    pub session_id: String,
    pub created_at: String,
    pub last_activity: Instant,
    pub idle_expiry: Duration,
    pub state: GrantState,
}

impl Grant {
    pub fn expired_at(&self, now: Instant) -> bool {
        now.duration_since(self.last_activity) >= self.idle_expiry
    }

    pub fn view(&self, now: Instant) -> GrantView {
        let state = if self.state == GrantState::Active && self.expired_at(now) {
            GrantState::Expired
        } else {
            self.state
        };
        GrantView {
            grant_id: self.grant_id.clone(),
            revision: self.revision,
            target_id: self.target.target_id.clone(),
            target_label: self.target_label.clone(),
            app_key: self.target.app_key.clone(),
            bounds: self.bounds,
            input_policy: self.input_policy,
            capture: self.capture,
            remaining_budget: self.remaining_budget,
            session_id: self.session_id.clone(),
            created_at: self.created_at.clone(),
            expires_at: expiry_iso(&self.created_at, self.last_activity, self.idle_expiry, now),
            state,
        }
    }
}

/// `expiresAt` is derived from the live idle window rather than stored, so a
/// grant that keeps working keeps moving its own deadline.
fn expiry_iso(
    created_at: &str,
    last_activity: Instant,
    idle_expiry: Duration,
    now: Instant,
) -> String {
    let remaining = idle_expiry.saturating_sub(now.duration_since(last_activity));
    let base = chrono::DateTime::parse_from_rfc3339(created_at)
        .map(|value| value.with_timezone(&chrono::Utc))
        .unwrap_or_else(|_| chrono::Utc::now());
    let deadline = chrono::Utc::now() + chrono::Duration::from_std(remaining).unwrap_or_default();
    // A malformed `created_at` must not produce a deadline in the past.
    if deadline < base {
        base.to_rfc3339()
    } else {
        deadline.to_rfc3339()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActionKind {
    Click,
    DoubleClick,
    RightClick,
    SetValue,
    PressKeys,
    Scroll,
    Select,
}

impl ActionKind {
    /// Whether the action changes the target. Inspection-only actions do not
    /// spend the grant's input budget and do not need an input-policy decision.
    pub fn is_input(self) -> bool {
        true
    }

    pub fn as_str(self) -> &'static str {
        match self {
            ActionKind::Click => "click",
            ActionKind::DoubleClick => "double_click",
            ActionKind::RightClick => "right_click",
            ActionKind::SetValue => "set_value",
            ActionKind::PressKeys => "press_keys",
            ActionKind::Scroll => "scroll",
            ActionKind::Select => "select",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Basis {
    pub revision: u32,
    pub bounds: Rect,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Scroll {
    pub dx: f64,
    pub dy: f64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Action {
    pub kind: Option<ActionKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub point: Option<Point>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub basis: Option<Basis>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub keys: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scroll: Option<Scroll>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub option: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Node {
    pub uid: String,
    pub role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub has_value: bool,
    pub enabled: bool,
    pub focused: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bounds: Option<Rect>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent: Option<usize>,
    pub actions: Vec<ActionKind>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Inspection {
    pub grant_id: String,
    pub revision: u32,
    pub bounds: Rect,
    pub fidelity: Fidelity,
    pub nodes: Vec<Node>,
    pub truncated: bool,
    pub secure_input: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActResult {
    pub grant_id: String,
    pub revision: u32,
    pub remaining_budget: u32,
    pub dispatched: Dispatched,
}

/// Every refusal the capability can produce. The variants map one-to-one onto
/// the `COMPUTER_*` codes in `08-error-codes.md` §3.10, so a caller can always
/// tell "there is no backend here" from "that element does not exist".
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refusal {
    Disabled,
    NoGrant,
    GrantInUse,
    GrantExpired,
    BudgetExhausted,
    ScopeViolation,
    SelfTargetRefused,
    TargetDenylisted,
    SecureInputRefused,
    StaleBasis,
    StaleRevision,
    ElementNotFound,
    ElementNotActionable,
    OsPermissionMissing,
    TargetElevated,
    PlatformUnsupported,
    ActionRejected(String),
    Timeout,
    Internal(String),
}

impl Refusal {
    pub fn code(&self) -> &'static str {
        match self {
            Refusal::Disabled => "COMPUTER_DISABLED",
            Refusal::NoGrant => "COMPUTER_NO_GRANT",
            Refusal::GrantInUse => "COMPUTER_GRANT_IN_USE",
            Refusal::GrantExpired => "COMPUTER_GRANT_EXPIRED",
            Refusal::BudgetExhausted => "COMPUTER_BUDGET_EXHAUSTED",
            Refusal::ScopeViolation => "COMPUTER_SCOPE_VIOLATION",
            Refusal::SelfTargetRefused => "COMPUTER_SELF_TARGET_REFUSED",
            Refusal::TargetDenylisted => "COMPUTER_TARGET_DENYLISTED",
            Refusal::SecureInputRefused => "COMPUTER_SECURE_INPUT_REFUSED",
            Refusal::StaleBasis => "COMPUTER_STALE_BASIS",
            Refusal::StaleRevision => "COMPUTER_STALE_REVISION",
            Refusal::ElementNotFound => "COMPUTER_ELEMENT_NOT_FOUND",
            Refusal::ElementNotActionable => "COMPUTER_ELEMENT_NOT_ACTIONABLE",
            Refusal::OsPermissionMissing => "COMPUTER_OS_PERMISSION_MISSING",
            Refusal::TargetElevated => "COMPUTER_TARGET_ELEVATED",
            Refusal::PlatformUnsupported => "COMPUTER_PLATFORM_UNSUPPORTED",
            Refusal::ActionRejected(_) => "COMPUTER_ACTION_REJECTED",
            Refusal::Timeout => "COMPUTER_TIMEOUT",
            Refusal::Internal(_) => "INTERNAL",
        }
    }

    /// Public message. It never carries window text, typed values, or pixels —
    /// a refusal is attributable without leaking what was on screen.
    pub fn message(&self) -> String {
        match self {
            Refusal::Disabled => "computer use is disabled".into(),
            Refusal::NoGrant => "no active computer-use grant".into(),
            Refusal::GrantInUse => "another session holds the active grant".into(),
            Refusal::GrantExpired => "the computer-use grant is no longer active".into(),
            Refusal::BudgetExhausted => "the grant's action budget is exhausted".into(),
            Refusal::ScopeViolation => "the request resolved outside the granted scope".into(),
            Refusal::SelfTargetRefused => "PI-Desktop windows are never a target".into(),
            Refusal::TargetDenylisted => "the target is on the denylist".into(),
            Refusal::SecureInputRefused => "secure input is active".into(),
            Refusal::StaleBasis => "the coordinate basis no longer matches the scope".into(),
            Refusal::StaleRevision => "the grant revision changed; inspect again".into(),
            Refusal::ElementNotFound => "the element is not in the current scope".into(),
            Refusal::ElementNotActionable => "the element offers no action for this request".into(),
            Refusal::OsPermissionMissing => "the operating system permission is not granted".into(),
            Refusal::TargetElevated => {
                "the target window is owned by a higher-integrity process".into()
            }
            Refusal::PlatformUnsupported => "computer use is unsupported on this platform".into(),
            Refusal::ActionRejected(reason) => format!("action rejected: {reason}"),
            Refusal::Timeout => "the computer-use operation timed out".into(),
            Refusal::Internal(reason) => format!("computer use failed: {reason}"),
        }
    }
}

impl From<DesktopError> for Refusal {
    fn from(value: DesktopError) -> Self {
        match value {
            DesktopError::Unsupported => Refusal::PlatformUnsupported,
            DesktopError::PermissionMissing => Refusal::OsPermissionMissing,
            DesktopError::TargetGone => Refusal::ScopeViolation,
            DesktopError::Elevated => Refusal::TargetElevated,
            DesktopError::ElementNotFound => Refusal::ElementNotFound,
            DesktopError::NotActionable => Refusal::ElementNotActionable,
            DesktopError::Timeout => Refusal::Timeout,
            DesktopError::Failed(reason) => Refusal::Internal(reason),
        }
    }
}

pub type ComputerResult<T> = Result<T, Refusal>;

/// Truncate on a character boundary. Window titles are attacker-controlled, so
/// a label is bounded before it can reach a model context or a log line.
pub fn truncate_label(value: &str) -> String {
    if value.chars().count() <= MAX_LABEL_CHARS {
        return value.to_string();
    }
    value.chars().take(MAX_LABEL_CHARS).collect()
}
