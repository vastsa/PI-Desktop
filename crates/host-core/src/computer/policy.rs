//! Every computer-use refusal, and the grant lifecycle that enforces them.
//!
//! The rules here are deliberately mechanical: a request carries no identity
//! the host trusts, so each one is re-checked against the live grant and a
//! fresh measurement of the target. Nothing in this file consults a permission
//! mode — the mode decides whether a grant may be minted and whether an input
//! step needs a card, and both of those happen before a request arrives here.

use std::time::{Duration, Instant};

use super::backend::{Desktop, Measured, RawTarget};
use super::{
    ActResult, Action, ActionKind, Basis, CaptureMode, ComputerResult, Grant, GrantState,
    InputPolicy, Inspection, Node, Rect, Refusal, Target, TargetRefusal, MAX_ACTION_BUDGET,
    MAX_IDLE_EXPIRY, MAX_NODES, MAX_TEXT_CHARS, MIN_IDLE_EXPIRY,
};

/// Application identifiers that may never be targeted, whatever the user
/// configures. These are credential surfaces: driving them with synthetic
/// input is indistinguishable from the user approving a secret release.
pub fn built_in_denylist() -> &'static [&'static str] {
    &[
        // macOS
        "com.apple.keychainaccess",
        "com.apple.SecurityAgent",
        "com.apple.systempreferences.securityagent",
        "com.apple.loginwindow",
        // Windows
        "credentialuibroker.exe",
        "consent.exe",
        "lsass.exe",
        "winlogon.exe",
        // Linux
        "polkit-gnome-authentication-agent-1",
        "gnome-keyring-prompt",
        "kwalletd5",
        "kwalletd6",
        "ksshaskpass",
        // Cross-platform password managers, by the names their windows expose.
        "1password",
        "com.1password.1password",
        "bitwarden",
        "com.bitwarden.desktop",
        "keepassxc",
        "org.keepassxc.keepassxc",
    ]
}

/// The denylist in force: the built-in credential surfaces, which cannot be
/// removed, plus whatever the user added.
#[derive(Debug, Clone, Default)]
pub struct Denylist {
    user: Vec<String>,
}

impl Denylist {
    pub fn new(user_entries: &[String]) -> Self {
        Self {
            user: user_entries
                .iter()
                .map(|entry| entry.trim().to_ascii_lowercase())
                .filter(|entry| !entry.is_empty())
                .collect(),
        }
    }

    pub fn refuses(&self, app_key: &str, app_name: &str) -> bool {
        let key = app_key.trim().to_ascii_lowercase();
        let name = app_name.trim().to_ascii_lowercase();
        let hits = |entry: &str| !entry.is_empty() && (key.contains(entry) || name.contains(entry));
        built_in_denylist().iter().any(|entry| hits(entry))
            || self.user.iter().any(|entry| hits(entry))
    }
}

/// Our own bundle identifiers. `own_pid` is the real check; these catch helper
/// processes that run under a different pid but still draw our windows.
const SELF_APP_KEYS: &[&str] = &[
    "pi-desktop",
    "pi desktop",
    "com.pi-desktop",
    "pi-desktop-host-core",
];

/// Why this window cannot be picked, or `None` when it can.
///
/// The self-target check comes first and is unconditional: a PI-Desktop window
/// is refused even if the user added it to an allowlist, because synthetic
/// input into our own approval cards bypasses the permission broker entirely.
pub fn refusal_for_target(
    raw: &RawTarget,
    self_pids: &[i32],
    denylist: &Denylist,
) -> Option<TargetRefusal> {
    if self_pids.contains(&raw.target.pid) {
        return Some(TargetRefusal::SelfTarget);
    }
    let key = raw.target.app_key.trim().to_ascii_lowercase();
    if SELF_APP_KEYS
        .iter()
        .any(|entry| key == *entry || key.starts_with(entry))
    {
        return Some(TargetRefusal::SelfTarget);
    }
    if denylist.refuses(&raw.target.app_key, &raw.app_name) {
        return Some(TargetRefusal::Denylisted);
    }
    if raw.elevated {
        return Some(TargetRefusal::Elevated);
    }
    None
}

/// Pickable and refused targets, with reasons. Refused entries stay in the
/// list so the picker can explain itself instead of appearing to lose windows.
pub fn list_targets(desktop: &dyn Desktop, denylist: &Denylist) -> ComputerResult<Vec<Target>> {
    let self_pids = desktop.self_pids();
    let raw = desktop.list_targets().map_err(Refusal::from)?;
    Ok(raw
        .into_iter()
        .map(|item| {
            let refused_reason = refusal_for_target(&item, &self_pids, denylist);
            Target {
                target_id: item.target.target_id.clone(),
                app_name: super::truncate_label(&item.app_name),
                title: super::truncate_label(&item.title),
                app_key: item.target.app_key.clone(),
                bounds: item.bounds,
                refused_reason,
            }
        })
        .collect())
}

pub struct GrantRequest {
    pub target_id: String,
    pub session_id: String,
    pub input_policy: InputPolicy,
    pub capture: CaptureMode,
    pub action_budget: u32,
    pub idle_expiry: Duration,
}

/// Mint the single active grant from a target the user picked.
///
/// The caller supplies a `target_id`, never a window handle, and the handle is
/// re-resolved from a fresh enumeration here — so a stale or invented id cannot
/// become authority over a window that now belongs to something else.
pub fn create_grant(
    desktop: &dyn Desktop,
    existing: Option<&Grant>,
    denylist: &Denylist,
    request: GrantRequest,
    now: Instant,
) -> ComputerResult<Grant> {
    if let Some(active) = existing {
        if active.state == GrantState::Active && !active.expired_at(now) {
            return Err(Refusal::GrantInUse);
        }
    }
    let self_pids = desktop.self_pids();
    let raw = desktop.list_targets().map_err(Refusal::from)?;
    let found = raw
        .into_iter()
        .find(|item| item.target.target_id == request.target_id)
        .ok_or(Refusal::ScopeViolation)?;
    match refusal_for_target(&found, &self_pids, denylist) {
        Some(TargetRefusal::SelfTarget) => return Err(Refusal::SelfTargetRefused),
        Some(TargetRefusal::Denylisted) => return Err(Refusal::TargetDenylisted),
        Some(TargetRefusal::Elevated) => return Err(Refusal::TargetElevated),
        Some(TargetRefusal::NoAccessibility) => return Err(Refusal::OsPermissionMissing),
        None => {}
    }
    let label = if found.title.trim().is_empty() {
        super::truncate_label(&found.app_name)
    } else {
        format!(
            "{} — {}",
            super::truncate_label(&found.app_name),
            super::truncate_label(&found.title)
        )
    };
    Ok(Grant {
        grant_id: format!("cug_{}", uuid::Uuid::new_v4().simple()),
        revision: 1,
        target: found.target,
        target_label: label,
        bounds: found.bounds,
        input_policy: request.input_policy,
        capture: request.capture,
        remaining_budget: request.action_budget.clamp(1, MAX_ACTION_BUDGET),
        session_id: request.session_id,
        created_at: chrono::Utc::now().to_rfc3339(),
        last_activity: now,
        idle_expiry: request.idle_expiry.clamp(MIN_IDLE_EXPIRY, MAX_IDLE_EXPIRY),
        state: GrantState::Active,
    })
}

/// The grant a request may use, or the reason it may not.
pub fn usable_grant<'a>(
    grant: Option<&'a mut Grant>,
    grant_id: &str,
    session_id: Option<&str>,
    now: Instant,
) -> ComputerResult<&'a mut Grant> {
    let grant = grant.ok_or(Refusal::NoGrant)?;
    if grant.grant_id != grant_id {
        return Err(Refusal::NoGrant);
    }
    if grant.state != GrantState::Active {
        return Err(Refusal::GrantExpired);
    }
    if grant.expired_at(now) {
        grant.state = GrantState::Expired;
        return Err(Refusal::GrantExpired);
    }
    if let Some(session) = session_id {
        if grant.session_id != session {
            return Err(Refusal::GrantInUse);
        }
    }
    Ok(grant)
}

/// Re-measure the target and fold the result into the grant.
///
/// A window that moved or changed identity bumps the revision, which
/// invalidates every `uid` and `basis` the caller is holding. A window that is
/// gone is a scope violation: there is nothing left that the grant describes.
fn refresh(desktop: &dyn Desktop, grant: &mut Grant) -> ComputerResult<Measured> {
    let measured = desktop.measure(&grant.target).map_err(Refusal::from)?;
    let moved = !grant.bounds.matches(&measured.bounds);
    let reidentified = measured.app_key != grant.target.app_key;
    if reidentified {
        // The handle now belongs to a different application. Nothing about
        // this grant still describes what the user picked.
        grant.state = GrantState::Revoked;
        return Err(Refusal::ScopeViolation);
    }
    if moved {
        grant.revision = grant.revision.saturating_add(1);
        grant.bounds = measured.bounds;
    }
    Ok(measured)
}

pub fn inspect(
    desktop: &dyn Desktop,
    grant: &mut Grant,
    expected_revision: Option<u32>,
    now: Instant,
) -> ComputerResult<Inspection> {
    if desktop.secure_input_active() {
        return Err(Refusal::SecureInputRefused);
    }
    refresh(desktop, grant)?;
    if let Some(expected) = expected_revision {
        if expected != grant.revision {
            return Err(Refusal::StaleRevision);
        }
    }
    let raw = desktop
        .inspect(&grant.target, MAX_NODES)
        .map_err(Refusal::from)?;
    grant.last_activity = now;
    Ok(Inspection {
        grant_id: grant.grant_id.clone(),
        revision: grant.revision,
        bounds: grant.bounds,
        fidelity: raw.fidelity,
        nodes: bound_nodes(raw.nodes),
        truncated: raw.truncated,
        secure_input: false,
    })
}

/// Labels come from windows the user does not control, so they are bounded
/// here rather than trusted from a backend.
fn bound_nodes(nodes: Vec<Node>) -> Vec<Node> {
    nodes
        .into_iter()
        .take(MAX_NODES)
        .map(|mut node| {
            node.label = node.label.map(|label| super::truncate_label(&label));
            node.role = super::truncate_label(&node.role);
            node
        })
        .collect()
}

/// Validate one action against the live grant, without dispatching it.
///
/// Split out from `act` so the refusals can be tested without a platform and
/// so a caller that wants to pre-flight a step gets exactly the same verdict.
pub fn validate_action(
    grant: &Grant,
    action: &Action,
    measured_bounds: &Rect,
) -> ComputerResult<ActionKind> {
    let kind = action
        .kind
        .ok_or_else(|| Refusal::ActionRejected("missing action kind".into()))?;
    if kind.is_input() && grant.remaining_budget == 0 {
        return Err(Refusal::BudgetExhausted);
    }
    if action.uid.is_none() && action.point.is_none() {
        return Err(Refusal::ActionRejected(
            "action names neither an element nor a point".into(),
        ));
    }
    if let Some(uid) = &action.uid {
        if uid.trim().is_empty() || uid.len() > 256 {
            return Err(Refusal::ActionRejected("malformed element id".into()));
        }
    }
    if let Some(point) = action.point {
        let basis = action
            .basis
            .ok_or_else(|| Refusal::ActionRejected("coordinate action without a basis".into()))?;
        validate_basis(grant, &basis, measured_bounds)?;
        if !measured_bounds.contains(point.x, point.y) {
            return Err(Refusal::ScopeViolation);
        }
    }
    match kind {
        ActionKind::SetValue => {
            let text = action
                .text
                .as_deref()
                .ok_or_else(|| Refusal::ActionRejected("set_value without text".into()))?;
            if text.chars().count() > MAX_TEXT_CHARS {
                return Err(Refusal::ActionRejected(
                    "text exceeds the step limit".into(),
                ));
            }
        }
        ActionKind::PressKeys => {
            let keys = action
                .keys
                .as_ref()
                .ok_or_else(|| Refusal::ActionRejected("press_keys without keys".into()))?;
            if keys.is_empty() || keys.len() > 16 {
                return Err(Refusal::ActionRejected(
                    "press_keys expects 1 to 16 chords".into(),
                ));
            }
            if keys
                .iter()
                .any(|chord| chord.trim().is_empty() || chord.len() > 64)
            {
                return Err(Refusal::ActionRejected("malformed key chord".into()));
            }
        }
        ActionKind::Select => {
            let option = action
                .option
                .as_deref()
                .ok_or_else(|| Refusal::ActionRejected("select without an option".into()))?;
            if option.trim().is_empty() || option.chars().count() > super::MAX_LABEL_CHARS {
                return Err(Refusal::ActionRejected("malformed select option".into()));
            }
        }
        ActionKind::Scroll => {
            let scroll = action
                .scroll
                .ok_or_else(|| Refusal::ActionRejected("scroll without a delta".into()))?;
            if !scroll.dx.is_finite() || !scroll.dy.is_finite() {
                return Err(Refusal::ActionRejected("non-finite scroll delta".into()));
            }
        }
        ActionKind::Click | ActionKind::DoubleClick | ActionKind::RightClick => {}
    }
    Ok(kind)
}

/// A basis is only as good as the geometry it was taken against: if the window
/// has moved since the capture, the coordinates in it now point somewhere else.
fn validate_basis(grant: &Grant, basis: &Basis, measured_bounds: &Rect) -> ComputerResult<()> {
    if basis.revision != grant.revision {
        return Err(Refusal::StaleRevision);
    }
    if !basis.bounds.matches(measured_bounds) {
        return Err(Refusal::StaleBasis);
    }
    Ok(())
}

pub fn act(
    desktop: &dyn Desktop,
    grant: &mut Grant,
    expected_revision: Option<u32>,
    action: &Action,
    now: Instant,
) -> ComputerResult<ActResult> {
    if desktop.secure_input_active() {
        return Err(Refusal::SecureInputRefused);
    }
    let measured = refresh(desktop, grant)?;
    if let Some(expected) = expected_revision {
        if expected != grant.revision {
            return Err(Refusal::StaleRevision);
        }
    }
    let kind = validate_action(grant, action, &measured.bounds)?;
    let dispatched = desktop
        .perform(&grant.target, action.uid.as_deref(), action)
        .map_err(Refusal::from)?;
    // The budget is spent on a dispatch that happened, not on an attempt that
    // was refused: a window that rejects every action must not silently burn
    // the grant, but a dispatched action always costs one.
    if kind.is_input() {
        grant.remaining_budget = grant.remaining_budget.saturating_sub(1);
    }
    grant.last_activity = now;
    if grant.remaining_budget == 0 {
        grant.state = GrantState::Expired;
    }
    Ok(ActResult {
        grant_id: grant.grant_id.clone(),
        revision: grant.revision,
        remaining_budget: grant.remaining_budget,
        dispatched,
    })
}

pub fn revoke(grant: &mut Grant, expired: bool) {
    grant.state = if expired {
        GrantState::Expired
    } else {
        GrantState::Revoked
    };
    grant.remaining_budget = 0;
}
