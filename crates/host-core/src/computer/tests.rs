//! Refusal coverage for computer use. These are the tests ADR 0342 names as
//! landing gates, and they run on every platform because the fake backend
//! stands in for the native one: the rules being checked are policy's, not the
//! platform's.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use super::backend::{
    Desktop, DesktopError, Dispatched, Measured, RawInspection, RawTarget, TargetRef,
};
use super::policy::{self, Denylist, GrantRequest};
use super::{
    Action, ActionKind, Basis, Capabilities, CaptureMode, Fidelity, Grant, GrantState, InputPolicy,
    Node, PermissionState, Point, Rect, Refusal, Scroll,
};

const OWN_PID: i32 = 4_242;

fn rect(x: f64, y: f64, width: f64, height: f64) -> Rect {
    Rect {
        x,
        y,
        width,
        height,
    }
}

fn node(uid: &str, role: &str, actions: Vec<ActionKind>) -> Node {
    Node {
        uid: uid.into(),
        role: role.into(),
        label: Some("Save".into()),
        has_value: false,
        enabled: true,
        focused: false,
        bounds: Some(rect(10.0, 20.0, 80.0, 24.0)),
        parent: None,
        actions,
    }
}

struct FakeDesktop {
    targets: Mutex<Vec<RawTarget>>,
    measured: Mutex<Option<Measured>>,
    secure_input: Mutex<bool>,
    perform_result: Mutex<Result<Dispatched, DesktopError>>,
    performed: Mutex<Vec<(Option<String>, ActionKind)>>,
    /// Set when the platform can enumerate a window but not read its tree —
    /// the real macOS case when the window is off-stage.
    inspect_error: Mutex<Option<DesktopError>>,
}

impl FakeDesktop {
    fn new(targets: Vec<RawTarget>) -> Self {
        let bounds = targets
            .first()
            .map(|item| item.bounds)
            .unwrap_or(rect(0.0, 0.0, 100.0, 100.0));
        let app_key = targets
            .first()
            .map(|item| item.target.app_key.clone())
            .unwrap_or_else(|| "com.example.app".into());
        Self {
            targets: Mutex::new(targets),
            measured: Mutex::new(Some(Measured {
                bounds,
                app_key,
                title: "Document".into(),
            })),
            secure_input: Mutex::new(false),
            perform_result: Mutex::new(Ok(Dispatched::AccessibilityAction)),
            performed: Mutex::new(Vec::new()),
            inspect_error: Mutex::new(None),
        }
    }

    fn set_inspect_error(&self, error: Option<DesktopError>) {
        *self.inspect_error.lock().unwrap() = error;
    }

    fn set_measured(&self, measured: Option<Measured>) {
        *self.measured.lock().unwrap() = measured;
    }

    fn set_secure_input(&self, value: bool) {
        *self.secure_input.lock().unwrap() = value;
    }

    /// Replace the enumeration, as closing or opening a window would.
    fn set_targets(&self, targets: Vec<RawTarget>) {
        *self.targets.lock().unwrap() = targets;
    }

    fn performed_count(&self) -> usize {
        self.performed.lock().unwrap().len()
    }
}

impl Desktop for FakeDesktop {
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            platform: "test".into(),
            backend: "macos-ax".into(),
            fidelity: Fidelity::Full,
            accessibility: PermissionState::Granted,
            capture: PermissionState::Granted,
            session_type: None,
            input_unsupported_reason: None,
        }
    }

    fn list_targets(&self) -> Result<Vec<RawTarget>, DesktopError> {
        Ok(self.targets.lock().unwrap().clone())
    }

    fn measure(&self, _target: &TargetRef) -> Result<Measured, DesktopError> {
        self.measured
            .lock()
            .unwrap()
            .clone()
            .ok_or(DesktopError::TargetGone)
    }

    fn inspect(
        &self,
        _target: &TargetRef,
        _max_nodes: usize,
    ) -> Result<RawInspection, DesktopError> {
        if let Some(error) = self.inspect_error.lock().unwrap().clone() {
            return Err(error);
        }
        Ok(RawInspection {
            nodes: vec![node("0.1", "AXButton", vec![ActionKind::Click])],
            truncated: false,
            fidelity: Fidelity::Full,
        })
    }

    fn secure_input_active(&self) -> bool {
        *self.secure_input.lock().unwrap()
    }

    fn perform(
        &self,
        _target: &TargetRef,
        uid: Option<&str>,
        action: &Action,
    ) -> Result<Dispatched, DesktopError> {
        let result = self.perform_result.lock().unwrap().clone();
        if result.is_ok() {
            self.performed
                .lock()
                .unwrap()
                .push((uid.map(str::to_string), action.kind.unwrap()));
        }
        result
    }

    fn self_pids(&self) -> Vec<i32> {
        vec![OWN_PID]
    }
}

fn target(pid: i32, app_key: &str, app_name: &str, id: &str) -> RawTarget {
    RawTarget {
        target: TargetRef {
            target_id: id.into(),
            pid,
            window: 7,
            app_key: app_key.into(),
        },
        app_name: app_name.into(),
        title: "Document".into(),
        bounds: rect(100.0, 100.0, 800.0, 600.0),
        elevated: false,
    }
}

fn grant_for(desktop: &FakeDesktop, id: &str) -> Grant {
    policy::create_grant(
        desktop,
        None,
        &Denylist::default(),
        GrantRequest {
            target_id: Some(id.into()),
            session_id: "session-1".into(),
            input_policy: InputPolicy::ConfirmEach,
            capture: CaptureMode::A11yOnly,
            action_budget: 3,
            idle_expiry: Duration::from_secs(600),
        },
        Instant::now(),
    )
    .expect("grant")
}

/// The automatic grant of ADR 0344: no target, so the host binds the frontmost
/// usable window itself.
fn desktop_grant(desktop: &FakeDesktop, denylist: &Denylist) -> Grant {
    policy::create_grant(
        desktop,
        None,
        denylist,
        GrantRequest {
            target_id: None,
            session_id: "session-1".into(),
            input_policy: InputPolicy::AutonomousInScope,
            capture: CaptureMode::A11yOnly,
            action_budget: 3,
            idle_expiry: Duration::from_secs(600),
        },
        Instant::now(),
    )
    .expect("desktop grant")
}

fn click_uid(uid: &str) -> Action {
    Action {
        kind: Some(ActionKind::Click),
        uid: Some(uid.into()),
        ..Action::default()
    }
}

#[test]
fn our_own_windows_are_never_targetable() {
    let desktop = FakeDesktop::new(vec![
        target(OWN_PID, "com.pi-desktop", "PI-Desktop", "self-window"),
        target(99, "com.example.app", "Example", "other-window"),
    ]);
    let listed = policy::list_targets(&desktop, &Denylist::default()).expect("targets");
    let own = listed
        .iter()
        .find(|item| item.target_id == "self-window")
        .expect("listed");
    // Listed, not hidden — a caller has to be able to explain the refusal.
    assert_eq!(own.refused_reason, Some(super::TargetRefusal::SelfTarget));

    let error = policy::create_grant(
        &desktop,
        None,
        &Denylist::default(),
        GrantRequest {
            target_id: Some("self-window".into()),
            session_id: "session-1".into(),
            input_policy: InputPolicy::AutonomousInScope,
            capture: CaptureMode::A11yAndPixels,
            action_budget: 10,
            idle_expiry: Duration::from_secs(600),
        },
        Instant::now(),
    )
    .expect_err("self target must refuse");
    assert_eq!(error, Refusal::SelfTargetRefused);
}

#[test]
fn a_renamed_self_process_is_still_refused() {
    // A helper process with a different pid but one of our app keys.
    let desktop = FakeDesktop::new(vec![target(
        1234,
        "pi-desktop-host-core",
        "Helper",
        "helper",
    )]);
    let error = policy::create_grant(
        &desktop,
        None,
        &Denylist::default(),
        GrantRequest {
            target_id: Some("helper".into()),
            session_id: "s".into(),
            input_policy: InputPolicy::ConfirmEach,
            capture: CaptureMode::A11yOnly,
            action_budget: 1,
            idle_expiry: Duration::from_secs(60),
        },
        Instant::now(),
    )
    .expect_err("self app key must refuse");
    assert_eq!(error, Refusal::SelfTargetRefused);
}

#[test]
fn built_in_credential_surfaces_cannot_be_allowlisted() {
    let desktop = FakeDesktop::new(vec![target(
        31,
        "com.apple.keychainaccess",
        "Keychain Access",
        "kc",
    )]);
    // An empty user list is the most permissive configuration there is.
    let error = policy::create_grant(
        &desktop,
        None,
        &Denylist::new(&[]),
        GrantRequest {
            target_id: Some("kc".into()),
            session_id: "s".into(),
            input_policy: InputPolicy::ConfirmEach,
            capture: CaptureMode::A11yOnly,
            action_budget: 1,
            idle_expiry: Duration::from_secs(60),
        },
        Instant::now(),
    )
    .expect_err("credential surface must refuse");
    assert_eq!(error, Refusal::TargetDenylisted);
}

#[test]
fn a_user_denylist_entry_matches_key_or_name() {
    let list = Denylist::new(&["Secret Notes".to_string()]);
    assert!(list.refuses("com.example.notes", "Secret Notes"));
    assert!(!list.refuses("com.example.notes", "Public Notes"));
}

#[test]
fn secure_input_refuses_both_inspection_and_action() {
    let desktop = FakeDesktop::new(vec![target(5, "com.example.app", "Example", "w1")]);
    let mut grant = grant_for(&desktop, "w1");
    desktop.set_secure_input(true);

    let inspect = policy::inspect(
        &desktop,
        &mut grant,
        &Denylist::default(),
        None,
        Instant::now(),
    )
    .expect_err("inspect");
    assert_eq!(inspect, Refusal::SecureInputRefused);

    let act = policy::act(
        &desktop,
        &mut grant,
        &Denylist::default(),
        None,
        &click_uid("0.1"),
        Instant::now(),
    )
    .expect_err("act");
    assert_eq!(act, Refusal::SecureInputRefused);
    assert_eq!(desktop.performed_count(), 0, "nothing may be dispatched");
}

#[test]
fn a_moved_window_bumps_the_revision_and_invalidates_a_basis() {
    let desktop = FakeDesktop::new(vec![target(5, "com.example.app", "Example", "w1")]);
    let mut grant = grant_for(&desktop, "w1");
    let captured = Basis {
        revision: grant.revision,
        bounds: grant.bounds,
    };

    desktop.set_measured(Some(Measured {
        bounds: rect(400.0, 100.0, 800.0, 600.0),
        app_key: "com.example.app".into(),
        title: "Document".into(),
    }));

    let action = Action {
        kind: Some(ActionKind::Click),
        point: Some(Point { x: 10.0, y: 10.0 }),
        basis: Some(captured),
        ..Action::default()
    };
    let error = policy::act(
        &desktop,
        &mut grant,
        &Denylist::default(),
        None,
        &action,
        Instant::now(),
    )
    .expect_err("stale basis");
    assert_eq!(error, Refusal::StaleRevision);
    assert_eq!(grant.revision, 2, "the move is recorded");
    assert_eq!(desktop.performed_count(), 0);
}

#[test]
fn a_resized_window_with_the_same_revision_still_refuses_a_stale_basis() {
    let desktop = FakeDesktop::new(vec![target(5, "com.example.app", "Example", "w1")]);
    let grant = grant_for(&desktop, "w1");
    // A basis whose geometry disagrees with the live measurement, carrying the
    // revision the caller currently holds.
    let action = Action {
        kind: Some(ActionKind::Click),
        point: Some(Point { x: 10.0, y: 10.0 }),
        basis: Some(Basis {
            revision: grant.revision,
            bounds: rect(0.0, 0.0, 10.0, 10.0),
        }),
        ..Action::default()
    };
    let error = policy::validate_action(&grant, &action, &grant.bounds).expect_err("basis");
    assert_eq!(error, Refusal::StaleBasis);
}

#[test]
fn an_expected_revision_mismatch_refuses_before_dispatch() {
    let desktop = FakeDesktop::new(vec![target(5, "com.example.app", "Example", "w1")]);
    let mut grant = grant_for(&desktop, "w1");
    let error = policy::act(
        &desktop,
        &mut grant,
        &Denylist::default(),
        Some(99),
        &click_uid("0.1"),
        Instant::now(),
    )
    .expect_err("revision");
    assert_eq!(error, Refusal::StaleRevision);
    assert_eq!(desktop.performed_count(), 0);
}

#[test]
fn coordinates_outside_the_measured_window_are_refused_not_clamped() {
    let desktop = FakeDesktop::new(vec![target(5, "com.example.app", "Example", "w1")]);
    let grant = grant_for(&desktop, "w1");
    let action = Action {
        kind: Some(ActionKind::Click),
        point: Some(Point {
            x: 5_000.0,
            y: 10.0,
        }),
        basis: Some(Basis {
            revision: grant.revision,
            bounds: grant.bounds,
        }),
        ..Action::default()
    };
    let error = policy::validate_action(&grant, &action, &grant.bounds).expect_err("bounds");
    assert_eq!(error, Refusal::ScopeViolation);
}

#[test]
fn a_coordinate_action_without_a_basis_is_refused() {
    let desktop = FakeDesktop::new(vec![target(5, "com.example.app", "Example", "w1")]);
    let grant = grant_for(&desktop, "w1");
    let action = Action {
        kind: Some(ActionKind::Click),
        point: Some(Point { x: 10.0, y: 10.0 }),
        ..Action::default()
    };
    match policy::validate_action(&grant, &action, &grant.bounds) {
        Err(Refusal::ActionRejected(reason)) => assert!(reason.contains("basis")),
        other => panic!("expected a rejection, got {other:?}"),
    }
}

#[test]
fn the_budget_closes_the_grant_and_refuses_the_next_action() {
    let desktop = FakeDesktop::new(vec![target(5, "com.example.app", "Example", "w1")]);
    let mut grant = grant_for(&desktop, "w1");
    grant.remaining_budget = 1;

    let first = policy::act(
        &desktop,
        &mut grant,
        &Denylist::default(),
        None,
        &click_uid("0.1"),
        Instant::now(),
    )
    .expect("first");
    assert_eq!(first.remaining_budget, 0);
    assert_eq!(
        grant.state,
        GrantState::Expired,
        "a spent grant closes itself"
    );

    let error = policy::act(
        &desktop,
        &mut grant,
        &Denylist::default(),
        None,
        &click_uid("0.1"),
        Instant::now(),
    )
    .expect_err("budget");
    assert_eq!(error, Refusal::BudgetExhausted);
    assert_eq!(desktop.performed_count(), 1);
}

#[test]
fn a_refused_dispatch_does_not_spend_the_budget() {
    let desktop = FakeDesktop::new(vec![target(5, "com.example.app", "Example", "w1")]);
    let mut grant = grant_for(&desktop, "w1");
    *desktop.perform_result.lock().unwrap() = Err(DesktopError::NotActionable);
    let before = grant.remaining_budget;
    let error = policy::act(
        &desktop,
        &mut grant,
        &Denylist::default(),
        None,
        &click_uid("0.1"),
        Instant::now(),
    )
    .expect_err("not actionable");
    assert_eq!(error, Refusal::ElementNotActionable);
    assert_eq!(grant.remaining_budget, before);
}

#[test]
fn an_idle_grant_expires_and_stays_expired() {
    let desktop = FakeDesktop::new(vec![target(5, "com.example.app", "Example", "w1")]);
    let mut grant = grant_for(&desktop, "w1");
    grant.idle_expiry = Duration::from_secs(30);
    grant.last_activity = Instant::now() - Duration::from_secs(31);

    let id = grant.grant_id.clone();
    let mut slot = Some(grant);
    let error =
        policy::usable_grant(slot.as_mut(), &id, None, Instant::now()).expect_err("expired");
    assert_eq!(error, Refusal::GrantExpired);
    assert_eq!(slot.unwrap().state, GrantState::Expired);
}

#[test]
fn only_one_grant_is_active_per_instance() {
    let desktop = FakeDesktop::new(vec![
        target(5, "com.example.app", "Example", "w1"),
        target(6, "com.other.app", "Other", "w2"),
    ]);
    let active = grant_for(&desktop, "w1");
    let error = policy::create_grant(
        &desktop,
        Some(&active),
        &Denylist::default(),
        GrantRequest {
            target_id: Some("w2".into()),
            session_id: "session-2".into(),
            input_policy: InputPolicy::ConfirmEach,
            capture: CaptureMode::A11yOnly,
            action_budget: 5,
            idle_expiry: Duration::from_secs(600),
        },
        Instant::now(),
    )
    .expect_err("second grant");
    assert_eq!(error, Refusal::GrantInUse);
}

#[test]
fn another_session_cannot_use_the_active_grant() {
    let desktop = FakeDesktop::new(vec![target(5, "com.example.app", "Example", "w1")]);
    let grant = grant_for(&desktop, "w1");
    let id = grant.grant_id.clone();
    let mut slot = Some(grant);
    let error = policy::usable_grant(slot.as_mut(), &id, Some("session-2"), Instant::now())
        .expect_err("wrong session");
    assert_eq!(error, Refusal::GrantInUse);
    assert!(policy::usable_grant(slot.as_mut(), &id, Some("session-1"), Instant::now()).is_ok());
}

#[test]
fn a_target_that_became_another_application_revokes_the_grant() {
    let desktop = FakeDesktop::new(vec![target(5, "com.example.app", "Example", "w1")]);
    let mut grant = grant_for(&desktop, "w1");
    desktop.set_measured(Some(Measured {
        bounds: grant.bounds,
        app_key: "com.attacker.app".into(),
        title: "Document".into(),
    }));
    let error = policy::act(
        &desktop,
        &mut grant,
        &Denylist::default(),
        None,
        &click_uid("0.1"),
        Instant::now(),
    )
    .expect_err("reidentified");
    assert_eq!(error, Refusal::ScopeViolation);
    assert_eq!(grant.state, GrantState::Revoked);
    assert_eq!(desktop.performed_count(), 0);
}

#[test]
fn a_closed_window_is_a_scope_violation() {
    let desktop = FakeDesktop::new(vec![target(5, "com.example.app", "Example", "w1")]);
    let mut grant = grant_for(&desktop, "w1");
    desktop.set_measured(None);
    let error = policy::act(
        &desktop,
        &mut grant,
        &Denylist::default(),
        None,
        &click_uid("0.1"),
        Instant::now(),
    )
    .expect_err("gone");
    assert_eq!(error, Refusal::ScopeViolation);
}

#[test]
fn malformed_actions_are_rejected_before_the_platform_sees_them() {
    let desktop = FakeDesktop::new(vec![target(5, "com.example.app", "Example", "w1")]);
    let grant = grant_for(&desktop, "w1");
    let cases: Vec<Action> = vec![
        Action::default(),
        Action {
            kind: Some(ActionKind::Click),
            ..Action::default()
        },
        Action {
            kind: Some(ActionKind::SetValue),
            uid: Some("0.1".into()),
            ..Action::default()
        },
        Action {
            kind: Some(ActionKind::SetValue),
            uid: Some("0.1".into()),
            text: Some("x".repeat(super::MAX_TEXT_CHARS + 1)),
            ..Action::default()
        },
        Action {
            kind: Some(ActionKind::PressKeys),
            uid: Some("0.1".into()),
            keys: Some(vec![]),
            ..Action::default()
        },
        Action {
            kind: Some(ActionKind::PressKeys),
            uid: Some("0.1".into()),
            keys: Some(vec!["  ".into()]),
            ..Action::default()
        },
        Action {
            kind: Some(ActionKind::Select),
            uid: Some("0.1".into()),
            ..Action::default()
        },
        Action {
            kind: Some(ActionKind::Scroll),
            uid: Some("0.1".into()),
            ..Action::default()
        },
        Action {
            kind: Some(ActionKind::Scroll),
            uid: Some("0.1".into()),
            scroll: Some(Scroll {
                dx: f64::NAN,
                dy: 0.0,
            }),
            ..Action::default()
        },
        Action {
            kind: Some(ActionKind::Click),
            uid: Some(" ".into()),
            ..Action::default()
        },
    ];
    for action in cases {
        let result = policy::validate_action(&grant, &action, &grant.bounds);
        assert!(result.is_err(), "accepted {action:?}");
    }
}

#[test]
fn labels_from_a_window_are_bounded() {
    let long = "x".repeat(super::MAX_LABEL_CHARS * 3);
    assert_eq!(
        super::truncate_label(&long).chars().count(),
        super::MAX_LABEL_CHARS
    );
    // A multi-byte label must not be cut mid-character.
    let wide = "字".repeat(super::MAX_LABEL_CHARS + 10);
    assert_eq!(
        super::truncate_label(&wide).chars().count(),
        super::MAX_LABEL_CHARS
    );
}

#[test]
fn an_unsupported_platform_refuses_every_operation() {
    let desktop = super::backend::UnsupportedDesktop::new("test", "no backend");
    assert!(
        desktop.secure_input_active(),
        "refusing is the safe default"
    );
    assert_eq!(desktop.capabilities().fidelity, Fidelity::None);
    assert_eq!(desktop.request_permission(), Err(DesktopError::Unsupported));
    assert_eq!(
        policy::list_targets(&desktop, &Denylist::default()).expect_err("targets"),
        Refusal::PlatformUnsupported
    );
}

#[test]
fn a_desktop_grant_binds_the_frontmost_usable_window() {
    // Our own window is in front, which is exactly the case the automatic
    // grant must not take: "the whole desktop" never includes us.
    let desktop = FakeDesktop::new(vec![
        target(OWN_PID, "com.pi-desktop", "PI-Desktop", "self-window"),
        target(99, "com.example.app", "Example", "front"),
        target(98, "com.other.app", "Other", "back"),
    ]);
    let grant = desktop_grant(&desktop, &Denylist::default());
    assert_eq!(grant.scope, super::GrantScope::Desktop);
    assert_eq!(grant.target.target_id, "front");
    assert_eq!(grant.view(Instant::now()).scope, super::GrantScope::Desktop);
}

#[test]
fn an_automatic_grant_skips_a_window_whose_tree_cannot_be_opened() {
    // The device case: the window server lists Stage Manager's own surfaces in
    // front of the user's windows, and nothing can read them.
    struct OnlySecondOpens(FakeDesktop);
    impl Desktop for OnlySecondOpens {
        fn capabilities(&self) -> Capabilities {
            self.0.capabilities()
        }
        fn list_targets(&self) -> Result<Vec<RawTarget>, DesktopError> {
            self.0.list_targets()
        }
        fn measure(&self, target: &TargetRef) -> Result<Measured, DesktopError> {
            self.0.measure(target)
        }
        fn inspect(
            &self,
            target: &TargetRef,
            max_nodes: usize,
        ) -> Result<RawInspection, DesktopError> {
            if target.target_id == "overlay" {
                return Err(DesktopError::TargetGone);
            }
            self.0.inspect(target, max_nodes)
        }
        fn secure_input_active(&self) -> bool {
            self.0.secure_input_active()
        }
        fn perform(
            &self,
            target: &TargetRef,
            uid: Option<&str>,
            action: &Action,
        ) -> Result<Dispatched, DesktopError> {
            self.0.perform(target, uid, action)
        }
        fn self_pids(&self) -> Vec<i32> {
            self.0.self_pids()
        }
    }

    let desktop = OnlySecondOpens(FakeDesktop::new(vec![
        target(404, "windowmanager", "WindowManager", "overlay"),
        target(5, "com.example.app", "Example", "w1"),
    ]));
    let grant = policy::create_grant(
        &desktop,
        None,
        &Denylist::default(),
        GrantRequest {
            target_id: None,
            session_id: "s".into(),
            input_policy: InputPolicy::AutonomousInScope,
            capture: CaptureMode::A11yOnly,
            action_budget: 3,
            idle_expiry: Duration::from_secs(600),
        },
        Instant::now(),
    )
    .expect("grant");
    assert_eq!(
        grant.target.target_id, "w1",
        "the unreadable surface is skipped"
    );
}

#[test]
fn a_desktop_grant_refuses_when_every_window_is_refused() {
    let desktop = FakeDesktop::new(vec![
        target(OWN_PID, "com.pi-desktop", "PI-Desktop", "self-window"),
        target(31, "com.apple.keychainaccess", "Keychain Access", "kc"),
    ]);
    let error = policy::create_grant(
        &desktop,
        None,
        &Denylist::default(),
        GrantRequest {
            target_id: None,
            session_id: "s".into(),
            input_policy: InputPolicy::AutonomousInScope,
            capture: CaptureMode::A11yOnly,
            action_budget: 1,
            idle_expiry: Duration::from_secs(60),
        },
        Instant::now(),
    )
    .expect_err("nothing usable");
    assert_eq!(error, Refusal::ScopeViolation);
}

#[test]
fn binding_another_window_moves_the_revision() {
    let desktop = FakeDesktop::new(vec![
        target(5, "com.example.app", "Example", "w1"),
        target(6, "com.other.app", "Other", "w2"),
    ]);
    let mut grant = desktop_grant(&desktop, &Denylist::default());
    let before = grant.revision;
    policy::bind_target(&desktop, &mut grant, &Denylist::default(), "w2").expect("rebind");
    assert_eq!(grant.target.target_id, "w2");
    assert_eq!(grant.target_label, "Other — Document");
    assert!(
        grant.revision > before,
        "every uid from w1 must stop validating"
    );

    // An action still holding the previous revision is refused, so a uid read
    // from the old window cannot land in the new one.
    let error = policy::act(
        &desktop,
        &mut grant,
        &Denylist::default(),
        Some(before),
        &click_uid("0.1"),
        Instant::now(),
    )
    .expect_err("stale revision");
    assert_eq!(error, Refusal::StaleRevision);
    assert_eq!(desktop.performed_count(), 0);
}

#[test]
fn a_window_that_cannot_be_read_does_not_become_the_bound_one() {
    // The macOS case this came from: `CGWindowList` enumerates an off-stage
    // window that the accessibility client cannot open. The bind is allowed,
    // the read fails, and the grant must stay where the caller last saw it.
    let desktop = FakeDesktop::new(vec![
        target(5, "com.example.app", "Example", "w1"),
        target(6, "com.other.app", "Other", "w2"),
    ]);
    let mut grant = desktop_grant(&desktop, &Denylist::default());
    assert_eq!(grant.target.target_id, "w1");
    let revision_before = grant.revision;
    desktop.set_inspect_error(Some(DesktopError::TargetGone));

    let error = policy::inspect_bound(
        &desktop,
        &mut grant,
        &Denylist::default(),
        Some("w2"),
        None,
        Instant::now(),
    )
    .expect_err("the unreadable window must refuse");
    assert_eq!(error, Refusal::ScopeViolation);
    assert_eq!(grant.target.target_id, "w1", "the grant stays where it was");
    assert_eq!(grant.target_label, "Example — Document");
    assert!(
        grant.revision > revision_before,
        "the attempted move still invalidates held ids"
    );

    // And the window it stayed on is still readable.
    desktop.set_inspect_error(None);
    let inspection = policy::inspect_bound(
        &desktop,
        &mut grant,
        &Denylist::default(),
        None,
        None,
        Instant::now(),
    )
    .expect("the original window still inspects");
    assert_eq!(inspection.nodes.len(), 1);
}

#[test]
fn a_rebind_re_applies_every_refusal() {
    let desktop = FakeDesktop::new(vec![
        target(5, "com.example.app", "Example", "w1"),
        target(OWN_PID, "com.pi-desktop", "PI-Desktop", "self-window"),
        target(31, "com.apple.keychainaccess", "Keychain Access", "kc"),
        target(7, "com.secret.notes", "Secret Notes", "notes"),
    ]);
    let denylist = Denylist::new(&["Secret Notes".to_string()]);
    let mut grant = desktop_grant(&desktop, &denylist);
    for (target_id, expected) in [
        ("self-window", Refusal::SelfTargetRefused),
        ("kc", Refusal::TargetDenylisted),
        ("notes", Refusal::TargetDenylisted),
        ("no-such-window", Refusal::ScopeViolation),
    ] {
        let error = policy::bind_target(&desktop, &mut grant, &denylist, target_id)
            .expect_err("refused rebind");
        assert_eq!(error, expected, "{target_id}");
        assert_eq!(
            grant.target.target_id, "w1",
            "a refused rebind changes nothing"
        );
    }
}

#[test]
fn a_window_grant_refuses_a_rebind() {
    let desktop = FakeDesktop::new(vec![
        target(5, "com.example.app", "Example", "w1"),
        target(6, "com.other.app", "Other", "w2"),
    ]);
    let mut grant = grant_for(&desktop, "w1");
    let error = policy::bind_target(&desktop, &mut grant, &Denylist::default(), "w2")
        .expect_err("window scope cannot move");
    assert_eq!(error, Refusal::ScopeViolation);
    assert_eq!(grant.target.target_id, "w1");
}

#[test]
fn a_desktop_grant_whose_window_closes_rebinds_and_refuses_the_action() {
    let desktop = FakeDesktop::new(vec![
        target(5, "com.example.app", "Example", "w1"),
        target(6, "com.other.app", "Other", "w2"),
    ]);
    let mut grant = desktop_grant(&desktop, &Denylist::default());
    assert_eq!(grant.target.target_id, "w1");
    // w1 is gone; only w2 is left on screen.
    desktop.set_measured(None);
    desktop.set_targets(vec![target(6, "com.other.app", "Other", "w2")]);

    let error = policy::act(
        &desktop,
        &mut grant,
        &Denylist::default(),
        None,
        &click_uid("0.1"),
        Instant::now(),
    )
    .expect_err("the action was aimed at the window that closed");
    assert_eq!(error, Refusal::StaleRevision);
    assert_eq!(desktop.performed_count(), 0, "nothing may be dispatched");
    // The grant survives, bound to what is actually there now.
    assert_eq!(grant.state, GrantState::Active);
    assert_eq!(grant.target.target_id, "w2");
}

#[test]
fn a_user_stop_blocks_the_agents_next_mint_but_not_the_users() {
    let now = Instant::now();
    assert!(policy::agent_mint_allowed(None, now).is_ok());
    assert_eq!(
        policy::agent_mint_allowed(Some(now), now).expect_err("cooldown"),
        Refusal::StoppedByUser
    );
    let elapsed = now + super::AGENT_REGRANT_COOLDOWN + Duration::from_secs(1);
    assert!(
        policy::agent_mint_allowed(Some(now), elapsed).is_ok(),
        "the cooldown ends on its own"
    );
}

#[test]
fn a_grant_view_reports_expiry_without_persisting_it() {
    let desktop = FakeDesktop::new(vec![target(5, "com.example.app", "Example", "w1")]);
    let grant = grant_for(&desktop, "w1");
    let view = grant.view(Instant::now());
    assert_eq!(view.state, GrantState::Active);
    assert_eq!(view.remaining_budget, 3);
    assert!(
        view.expires_at > view.created_at,
        "the deadline is ahead of creation"
    );
    assert_eq!(view.target_label, "Example — Document");
}
