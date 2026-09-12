use super::*;
use crate::sessions;

fn test_db() -> (tempfile::TempDir, Database) {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    (dir, db)
}

fn plan_session(db: &Database, workspace: &Path) -> sessions::SessionSummary {
    sessions::create_session(
        db,
        Some("Plan".into()),
        Some("plan".into()),
        None,
        None,
        Some(workspace.to_string_lossy().into_owned()),
    )
    .unwrap()
}

fn live_turn(db: &Database, session_id: &str) -> String {
    sessions::begin_turn(db, session_id, None, None).unwrap()
}

fn submit(manager: &PlanManager, db: &Database, root: &Path, call: &str) -> PlanProposal {
    let session = plan_session(db, root);
    let turn = live_turn(db, &session.id);
    manager
        .submit(
            db,
            PlanSubmitParams {
                workspace_root: root,
                session_id: &session.id,
                turn_id: &turn,
                tool_call_id: call,
                kind: KIND_PLAN,
                title: "Build API",
                markdown: "# Plan\n- implement",
                question: "Proceed?",
            },
        )
        .unwrap()
}

#[test]
fn title_slug_and_filename_are_descriptive_and_local_minute_shaped() {
    let now = Local::now();
    let filename = plan_filename(KIND_PLAN, "Build API / v2", now, 1);
    assert!(filename.starts_with("build-api-v2-"));
    assert!(filename.ends_with(".md"));
    assert!(filename.is_ascii());
    assert_eq!(filename.len(), "build-api-v2-YYYYMMDD-HHmm.md".len());
    assert_eq!(title_slug("中文 / ???", KIND_PLAN), "中文");
    assert_eq!(title_slug("中文 / ???", KIND_GOAL), "中文");
    assert!(plan_filename(KIND_PLAN, "中文审批卡片", now, 1).starts_with("中文审批卡片-"));
}

#[test]
fn enter_plan_mode_uses_the_active_turn_and_tool_identity() {
    let (dir, db) = test_db();
    let root = dir.path().join("workspace");
    fs::create_dir_all(&root).unwrap();
    let session = sessions::create_session(
        &db,
        Some("Agent".into()),
        Some("agent".into()),
        None,
        None,
        Some(root.to_string_lossy().into_owned()),
    )
    .unwrap();
    let turn = live_turn(&db, &session.id);

    PlanManager
        .enter(&db, &session.id, &turn, "enter-plan-call", KIND_PLAN)
        .unwrap();

    assert_eq!(
        sessions::session_mode(&db, &session.id).unwrap().as_deref(),
        Some("plan")
    );
    let audit_payload: String = db
            .conn()
            .query_row(
                "SELECT payload_json FROM audit_log WHERE kind = 'plan_entered' ORDER BY id DESC LIMIT 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
    let audit_payload: serde_json::Value = serde_json::from_str(&audit_payload).unwrap();
    assert_eq!(audit_payload["turnId"], turn);
    assert_eq!(audit_payload["toolCallId"], "enter-plan-call");
}

#[test]
fn enter_plan_mode_rejects_a_stale_turn_without_a_mode_write() {
    let (dir, db) = test_db();
    let root = dir.path().join("workspace");
    fs::create_dir_all(&root).unwrap();
    let session = sessions::create_session(
        &db,
        Some("Agent".into()),
        Some("agent".into()),
        None,
        None,
        Some(root.to_string_lossy().into_owned()),
    )
    .unwrap();

    let error = PlanManager
        .enter(&db, &session.id, "stale-turn", "enter-plan-call", KIND_PLAN)
        .unwrap_err();
    assert_eq!(error.to_string(), "PLAN_APPROVAL_STALE");
    assert_eq!(
        sessions::session_mode(&db, &session.id).unwrap().as_deref(),
        Some("agent")
    );
}

#[test]
fn publication_collides_without_overwriting() {
    let (dir, db) = test_db();
    let root = dir.path().join("workspace");
    fs::create_dir_all(&root).unwrap();
    let manager = PlanManager;
    let first = submit(&manager, &db, &root, "call-1");
    let second_session = plan_session(&db, &root);
    let turn2 = live_turn(&db, &second_session.id);
    let second = manager
        .submit(
            &db,
            PlanSubmitParams {
                workspace_root: &root,
                session_id: &second_session.id,
                turn_id: &turn2,
                tool_call_id: "call-2",
                kind: KIND_PLAN,
                title: "Build API",
                markdown: "second",
                question: "Proceed?",
            },
        )
        .unwrap();
    assert_ne!(
        first.artifact.as_ref().unwrap().relative_path,
        second.artifact.as_ref().unwrap().relative_path
    );
    assert_eq!(
        fs::read(root.join(&first.artifact.unwrap().relative_path)).unwrap(),
        b"# Plan\n- implement"
    );
}

#[test]
fn oversized_markdown_is_rejected_before_artifact_creation() {
    let (dir, db) = test_db();
    let root = dir.path().join("workspace");
    fs::create_dir_all(&root).unwrap();
    let session = plan_session(&db, &root);
    let turn = live_turn(&db, &session.id);
    let error = PlanManager
        .submit(
            &db,
            PlanSubmitParams {
                workspace_root: &root,
                session_id: &session.id,
                turn_id: &turn,
                tool_call_id: "call-1",
                kind: KIND_PLAN,
                title: "Too large",
                markdown: &"x".repeat(PLAN_MAX_MARKDOWN_BYTES + 1),
                question: "Proceed?",
            },
        )
        .unwrap_err();
    assert_eq!(error.to_string(), "PLAN_MARKDOWN_TOO_LARGE");
    assert!(!root.join(".pi").exists());
}

#[cfg(unix)]
#[test]
fn existing_plan_symlink_is_rejected() {
    let (dir, db) = test_db();
    let root = dir.path().join("workspace");
    let outside = dir.path().join("outside");
    fs::create_dir_all(&root).unwrap();
    fs::create_dir_all(&outside).unwrap();
    fs::create_dir_all(root.join(".pi")).unwrap();
    std::os::unix::fs::symlink(&outside, root.join(".pi/plan")).unwrap();
    let session = plan_session(&db, &root);
    let turn = live_turn(&db, &session.id);
    let error = PlanManager
        .submit(
            &db,
            PlanSubmitParams {
                workspace_root: &root,
                session_id: &session.id,
                turn_id: &turn,
                tool_call_id: "call-1",
                kind: KIND_PLAN,
                title: "Plan",
                markdown: "body",
                question: "?",
            },
        )
        .unwrap_err();
    assert_eq!(error.to_string(), "PLAN_ARTIFACT_PATH_UNSAFE");
}

#[test]
fn pending_rows_are_interrupted_during_database_restart() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pi.sqlite");
    let (session_id, proposal_id);
    let root = dir.path().join("workspace");
    fs::create_dir_all(&root).unwrap();
    {
        let db = Database::open(&path).unwrap();
        let session = plan_session(&db, &root);
        session_id = session.id;
        let turn = live_turn(&db, &session_id);
        proposal_id = PlanManager
            .submit(
                &db,
                PlanSubmitParams {
                    workspace_root: &root,
                    session_id: &session_id,
                    turn_id: &turn,
                    tool_call_id: "call-1",
                    kind: KIND_PLAN,
                    title: "Plan",
                    markdown: "body",
                    question: "?",
                },
            )
            .unwrap()
            .id;
    }
    let db = Database::open(&path).unwrap();
    let pending = PlanManager
        .pending_for_session(&db, Some(&session_id))
        .unwrap();
    assert!(pending.is_empty());
    let proposal = get_proposal(&db, &proposal_id).unwrap().unwrap();
    assert_eq!(proposal.status, STATUS_INTERRUPTED);
    assert_eq!(
        proposal.error_code.as_deref(),
        Some("PLAN_APPROVAL_INTERRUPTED")
    );
}

#[test]
fn reject_has_no_side_effects_and_allows_new_turn_submission() {
    let (dir, db) = test_db();
    let root = dir.path().join("workspace");
    fs::create_dir_all(&root).unwrap();
    let manager = PlanManager;
    let proposal = submit(&manager, &db, &root, "call-1");
    let first_artifact_path = proposal.artifact.as_ref().unwrap().relative_path.clone();
    let first_artifact_bytes = fs::read(root.join(&first_artifact_path)).unwrap();
    let before = sessions::get_session(&db, &proposal.session_id)
        .unwrap()
        .unwrap()
        .summary;
    let result = manager
        .resolve(
            &db,
            PlanResolveParams {
                workspace_root: Some(&root),
                proposal_id: &proposal.id,
                session_id: &proposal.session_id,
                turn_id: &proposal.turn_id,
                tool_call_id: &proposal.tool_call_id,
                version: Some(proposal.version),
                action: "reject",
                target_permission_mode: None,
            },
        )
        .unwrap();
    let after = sessions::get_session(&db, &proposal.session_id)
        .unwrap()
        .unwrap()
        .summary;
    assert_eq!(result.status, STATUS_REJECTED);
    assert_eq!(before.mode, after.mode);
    assert_eq!(before.permission_mode, after.permission_mode);
    assert!(result.execution.is_none());
    assert!(manager
        .pending_for_session(&db, Some(&proposal.session_id))
        .unwrap()
        .is_empty());
    let ended = sessions::end_turn(&db, &proposal.turn_id, "completed", None, None, false).unwrap();
    assert!(ended.updated);
    let next_turn = live_turn(&db, &proposal.session_id);
    let revised = manager
        .submit(
            &db,
            PlanSubmitParams {
                workspace_root: &root,
                session_id: &proposal.session_id,
                turn_id: &next_turn,
                tool_call_id: "call-2",
                kind: KIND_PLAN,
                title: "Build API revised",
                markdown: "# Plan\n- revise",
                question: "Proceed with the revision?",
            },
        )
        .unwrap();
    assert_ne!(revised.id, proposal.id);
    assert_eq!(revised.status, STATUS_PENDING);
    assert_eq!(revised.turn_id, next_turn);
    assert_ne!(
        revised.artifact.as_ref().unwrap().relative_path,
        first_artifact_path
    );
    assert_eq!(
        fs::read(root.join(&first_artifact_path)).unwrap(),
        first_artifact_bytes
    );
    assert_eq!(
        manager
            .pending_for_session(&db, Some(&proposal.session_id))
            .unwrap()
            .iter()
            .map(|pending| pending.id.as_str())
            .collect::<Vec<_>>(),
        vec![revised.id.as_str()]
    );
    let rejected = get_proposal(&db, &proposal.id).unwrap().unwrap();
    assert_eq!(rejected.status, STATUS_REJECTED);
    assert_eq!(
        rejected.artifact.unwrap().relative_path,
        first_artifact_path
    );
    let execution_count: i64 = db
        .conn()
        .query_row(
            "SELECT COUNT(*) FROM plan_approvals WHERE execution_id IS NOT NULL",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(execution_count, 0);
}

#[test]
fn approval_switches_session_and_creates_outbox_atomically() {
    let (dir, db) = test_db();
    let root = dir.path().join("workspace");
    fs::create_dir_all(&root).unwrap();
    let manager = PlanManager;
    let proposal = submit(&manager, &db, &root, "call-1");
    let result = manager
        .resolve(
            &db,
            PlanResolveParams {
                workspace_root: Some(&root),
                proposal_id: &proposal.id,
                session_id: &proposal.session_id,
                turn_id: &proposal.turn_id,
                tool_call_id: &proposal.tool_call_id,
                version: Some(proposal.version),
                action: "approve",
                target_permission_mode: Some("accept-edits"),
            },
        )
        .unwrap();
    let execution = result.execution.unwrap();
    assert_eq!(result.status, STATUS_APPROVED);
    assert_eq!(execution.state, EXECUTION_QUEUED);
    let session = sessions::get_session(&db, &proposal.session_id)
        .unwrap()
        .unwrap()
        .summary;
    assert_eq!(session.mode, "agent");
    assert_eq!(session.permission_mode, "accept-edits");
    assert!(db.get_setting("app").unwrap().is_none());
    assert_eq!(manager.queued_executions(&db, None).unwrap().len(), 1);
}

#[test]
fn duplicate_resolution_returns_committed_result_and_conflict_is_stale() {
    let (dir, db) = test_db();
    let root = dir.path().join("workspace");
    fs::create_dir_all(&root).unwrap();
    let manager = PlanManager;
    let proposal = submit(&manager, &db, &root, "call-1");
    let first = manager
        .resolve(
            &db,
            PlanResolveParams {
                workspace_root: Some(&root),
                proposal_id: &proposal.id,
                session_id: &proposal.session_id,
                turn_id: &proposal.turn_id,
                tool_call_id: &proposal.tool_call_id,
                version: Some(proposal.version),
                action: "approve",
                target_permission_mode: Some("auto"),
            },
        )
        .unwrap();
    let duplicate = manager
        .resolve(
            &db,
            PlanResolveParams {
                workspace_root: Some(&root),
                proposal_id: &proposal.id,
                session_id: &proposal.session_id,
                turn_id: &proposal.turn_id,
                tool_call_id: &proposal.tool_call_id,
                version: Some(proposal.version),
                action: "approve",
                target_permission_mode: Some("auto"),
            },
        )
        .unwrap();
    assert_eq!(duplicate.proposal.version, first.proposal.version);
    assert_eq!(duplicate.execution.unwrap().id, first.execution.unwrap().id);
    assert_eq!(
        manager
            .resolve(
                &db,
                PlanResolveParams {
                    workspace_root: Some(&root),
                    proposal_id: &proposal.id,
                    session_id: &proposal.session_id,
                    turn_id: &proposal.turn_id,
                    tool_call_id: &proposal.tool_call_id,
                    version: Some(proposal.version),
                    action: "reject",
                    target_permission_mode: None,
                },
            )
            .unwrap_err()
            .to_string(),
        "PLAN_APPROVAL_CONFLICT"
    );
}

#[test]
fn approval_deadline_expires_lazily_and_rejects_late_resolution() {
    let (dir, db) = test_db();
    let root = dir.path().join("workspace");
    fs::create_dir_all(&root).unwrap();
    let manager = PlanManager;
    let proposal = submit(&manager, &db, &root, "call-1");
    let expires_at = proposal
        .expires_at
        .as_deref()
        .map(crate::db::ts_to_ms)
        .unwrap();
    assert!(expires_at >= now_ms() + PLAN_APPROVAL_TIMEOUT_MS - 1_000);
    db.conn()
        .execute(
            "UPDATE plan_approvals SET expires_at = ?1 WHERE request_id = ?2",
            params![now_ms() - 1, proposal.id],
        )
        .unwrap();

    assert!(manager
        .pending_for_session(&db, Some(&proposal.session_id))
        .unwrap()
        .is_empty());
    let stored = get_proposal(&db, &proposal.id).unwrap().unwrap();
    assert_eq!(stored.status, STATUS_EXPIRED);
    assert_eq!(stored.error_code.as_deref(), Some("PLAN_APPROVAL_TIMEOUT"));
    assert_eq!(
        manager
            .state_for_session(&db, &proposal.session_id)
            .unwrap(),
        "planning"
    );
    assert_eq!(
        manager
            .resolution_for(&db, &proposal.id)
            .unwrap()
            .unwrap()
            .status,
        STATUS_EXPIRED
    );

    sessions::end_turn(&db, &proposal.turn_id, "aborted", None, None, false).unwrap();
    assert!(gate_session_configure(
        &db,
        &proposal.session_id,
        "agent",
        None,
        None,
        None,
        Some("auto"),
    )
    .is_ok());
    assert_eq!(
        manager
            .resolve(
                &db,
                PlanResolveParams {
                    workspace_root: Some(&root),
                    proposal_id: &proposal.id,
                    session_id: &proposal.session_id,
                    turn_id: &proposal.turn_id,
                    tool_call_id: &proposal.tool_call_id,
                    version: Some(proposal.version),
                    action: "reject",
                    target_permission_mode: None,
                },
            )
            .unwrap_err()
            .to_string(),
        "PLAN_APPROVAL_TIMEOUT"
    );
}

#[test]
fn claim_and_finish_are_durable_cas_transitions() {
    let (dir, db) = test_db();
    let root = dir.path().join("workspace");
    fs::create_dir_all(&root).unwrap();
    let manager = PlanManager;
    let proposal = submit(&manager, &db, &root, "call-1");
    let approved = manager
        .resolve(
            &db,
            PlanResolveParams {
                workspace_root: Some(&root),
                proposal_id: &proposal.id,
                session_id: &proposal.session_id,
                turn_id: &proposal.turn_id,
                tool_call_id: &proposal.tool_call_id,
                version: Some(proposal.version),
                action: "approve",
                target_permission_mode: Some("auto"),
            },
        )
        .unwrap();
    let id = approved.execution.as_ref().unwrap().id.clone();
    let running = manager.claim_execution(&db, &id).unwrap();
    assert_eq!(running.state, EXECUTION_RUNNING);
    assert!(manager.claim_execution(&db, &id).is_err());
    let completed = manager
        .finish_execution(&db, &id, EXECUTION_COMPLETED, None)
        .unwrap();
    assert_eq!(completed.state, EXECUTION_COMPLETED);
    assert!(manager
        .finish_execution(&db, &id, EXECUTION_INTERRUPTED, Some("late"))
        .is_err());
}

#[test]
fn configure_gate_blocks_pending_and_active_execution_changes() {
    let (dir, db) = test_db();
    let root = dir.path().join("workspace");
    fs::create_dir_all(&root).unwrap();
    let manager = PlanManager;
    let proposal = submit(&manager, &db, &root, "call-1");
    assert_eq!(
        gate_session_configure(
            &db,
            &proposal.session_id,
            "agent",
            None,
            None,
            None,
            Some("auto"),
        )
        .unwrap_err()
        .to_string(),
        "PLAN_CONFIGURATION_BLOCKED"
    );
    for blocked in [
        gate_session_configure(
            &db,
            &proposal.session_id,
            "plan",
            Some("other-provider"),
            None,
            None,
            None,
        ),
        gate_session_configure(
            &db,
            &proposal.session_id,
            "plan",
            None,
            Some("other-model"),
            None,
            None,
        ),
        gate_session_configure(
            &db,
            &proposal.session_id,
            "plan",
            None,
            None,
            Some("high"),
            None,
        ),
    ] {
        assert_eq!(
            blocked.unwrap_err().to_string(),
            "PLAN_CONFIGURATION_BLOCKED"
        );
    }
    manager
        .resolve(
            &db,
            PlanResolveParams {
                workspace_root: Some(&root),
                proposal_id: &proposal.id,
                session_id: &proposal.session_id,
                turn_id: &proposal.turn_id,
                tool_call_id: &proposal.tool_call_id,
                version: Some(proposal.version),
                action: "approve",
                target_permission_mode: Some("auto"),
            },
        )
        .unwrap();
    assert_eq!(
        gate_session_configure(&db, &proposal.session_id, "plan", None, None, None, None,)
            .unwrap_err()
            .to_string(),
        "PLAN_CONFIGURATION_BLOCKED"
    );
}

#[test]
fn configure_gate_blocks_changes_while_a_turn_is_running() {
    let (dir, db) = test_db();
    let root = dir.path().join("workspace");
    fs::create_dir_all(&root).unwrap();
    let session = sessions::create_session(
        &db,
        Some("Agent".into()),
        Some("agent".into()),
        None,
        None,
        Some(root.to_string_lossy().into_owned()),
    )
    .unwrap();
    let turn = sessions::begin_turn(&db, &session.id, None, None).unwrap();
    assert_eq!(
        gate_session_configure(
            &db,
            &session.id,
            "agent",
            Some("provider-2"),
            None,
            None,
            None,
        )
        .unwrap_err()
        .to_string(),
        "PLAN_CONFIGURATION_BLOCKED"
    );
    sessions::end_turn(&db, &turn, "aborted", None, None, false).unwrap();
    assert!(gate_session_configure(
        &db,
        &session.id,
        "agent",
        Some("provider-2"),
        None,
        None,
        None,
    )
    .is_ok());
}

fn goal_session(db: &Database, workspace: &Path) -> sessions::SessionSummary {
    sessions::create_session(
        db,
        Some("Goal".into()),
        Some("goal".into()),
        None,
        None,
        Some(workspace.to_string_lossy().into_owned()),
    )
    .unwrap()
}

#[test]
fn every_kind_publishes_into_its_own_artifact_directory() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("workspace");
    fs::create_dir_all(&root).unwrap();
    for kind in [KIND_PLAN, KIND_GOAL] {
        let kind = normalize_kind(kind).unwrap();
        let (artifact, path) =
            publish_artifact(&root, kind, "Ship checkout", "# Contract\n- done").unwrap();
        assert!(
            artifact.relative_path.starts_with(&format!(".pi/{kind}/")),
            "{} should live under .pi/{kind}/",
            artifact.relative_path
        );
        assert!(path.is_file());
        // A path claiming the other kind's directory must not resolve.
        let other = if kind == KIND_PLAN {
            KIND_GOAL
        } else {
            KIND_PLAN
        };
        assert_eq!(
            safe_artifact_path(&root, other, &artifact.relative_path)
                .unwrap_err()
                .to_string(),
            "PLAN_ARTIFACT_PATH_UNSAFE"
        );
    }
}

#[test]
fn goal_contract_round_trips_through_its_own_kind() {
    let (dir, db) = test_db();
    let root = dir.path().join("workspace");
    fs::create_dir_all(&root).unwrap();
    let manager = PlanManager;
    let session = goal_session(&db, &root);
    let turn = live_turn(&db, &session.id);
    let proposal = manager
        .submit(
            &db,
            PlanSubmitParams {
                workspace_root: &root,
                session_id: &session.id,
                turn_id: &turn,
                tool_call_id: "goal-call-1",
                kind: KIND_GOAL,
                title: "Ship checkout",
                markdown: "# Goal\n## Acceptance criteria\n- tests pass",
                question: "Approve this goal?",
            },
        )
        .unwrap();
    assert_eq!(proposal.kind, KIND_GOAL);
    assert!(proposal
        .artifact
        .as_ref()
        .unwrap()
        .relative_path
        .starts_with(".pi/goal/"));
    assert_eq!(
        manager.active_kind(&db, &session.id).unwrap(),
        Some(KIND_GOAL)
    );
    assert_eq!(
        manager.state_for_session(&db, &session.id).unwrap(),
        "awaiting_approval"
    );

    let resolution = manager
        .resolve(
            &db,
            PlanResolveParams {
                workspace_root: Some(&root),
                proposal_id: &proposal.id,
                session_id: &proposal.session_id,
                turn_id: &proposal.turn_id,
                tool_call_id: &proposal.tool_call_id,
                version: Some(proposal.version),
                action: "approve",
                target_permission_mode: Some("accept-edits"),
            },
        )
        .unwrap();
    let execution = resolution.execution.unwrap();
    assert_eq!(execution.kind, KIND_GOAL);
    assert_eq!(execution.state, EXECUTION_QUEUED);
    // Approval hands the session back to Agent so execution can act.
    let session = sessions::get_session(&db, &session.id).unwrap().unwrap();
    assert_eq!(session.summary.mode, "agent");
    assert_eq!(
        manager.active_kind(&db, &proposal.session_id).unwrap(),
        None
    );
    assert_eq!(
        manager.queued_executions(&db, None).unwrap()[0].kind,
        KIND_GOAL
    );
}

#[test]
fn submitting_the_other_contract_kind_is_rejected() {
    let (dir, db) = test_db();
    let root = dir.path().join("workspace");
    fs::create_dir_all(&root).unwrap();
    let manager = PlanManager;
    let goal = goal_session(&db, &root);
    let goal_turn = live_turn(&db, &goal.id);
    assert_eq!(
        manager
            .submit(
                &db,
                PlanSubmitParams {
                    workspace_root: &root,
                    session_id: &goal.id,
                    turn_id: &goal_turn,
                    tool_call_id: "wrong-kind-1",
                    kind: KIND_PLAN,
                    title: "Plan in a goal session",
                    markdown: "# Plan",
                    question: "Proceed?",
                },
            )
            .unwrap_err()
            .to_string(),
        "PLAN_KIND_MISMATCH"
    );

    let plan = plan_session(&db, &root);
    let plan_turn = live_turn(&db, &plan.id);
    assert_eq!(
        manager
            .submit(
                &db,
                PlanSubmitParams {
                    workspace_root: &root,
                    session_id: &plan.id,
                    turn_id: &plan_turn,
                    tool_call_id: "wrong-kind-2",
                    kind: KIND_GOAL,
                    title: "Goal in a plan session",
                    markdown: "# Goal",
                    question: "Approve?",
                },
            )
            .unwrap_err()
            .to_string(),
        "PLAN_KIND_MISMATCH"
    );
    // Neither rejected submission may leave an artifact behind.
    assert!(!root.join(".pi").join("goal").exists());
    assert!(!root.join(".pi").join("plan").exists());
}

#[test]
fn entering_goal_mode_writes_the_goal_mode_and_kind() {
    let (dir, db) = test_db();
    let root = dir.path().join("workspace");
    fs::create_dir_all(&root).unwrap();
    let session = sessions::create_session(
        &db,
        Some("Agent".into()),
        Some("agent".into()),
        None,
        None,
        Some(root.to_string_lossy().into_owned()),
    )
    .unwrap();
    let turn = live_turn(&db, &session.id);

    PlanManager
        .enter(&db, &session.id, &turn, "enter-goal-call", KIND_GOAL)
        .unwrap();

    assert_eq!(
        sessions::session_mode(&db, &session.id).unwrap().as_deref(),
        Some("goal")
    );
    let audit_payload: String = db
            .conn()
            .query_row(
                "SELECT payload_json FROM audit_log WHERE kind = 'plan_entered' ORDER BY id DESC LIMIT 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
    let audit_payload: serde_json::Value = serde_json::from_str(&audit_payload).unwrap();
    assert_eq!(audit_payload["kind"], "goal");

    // A second entry is refused whatever kind it asks for.
    assert_eq!(
        PlanManager
            .enter(&db, &session.id, &turn, "enter-plan-call", KIND_PLAN)
            .unwrap_err()
            .to_string(),
        "PLAN_ALREADY_ACTIVE"
    );
    assert_eq!(
        PlanManager
            .enter(&db, &session.id, &turn, "enter-bogus-call", "sprint")
            .unwrap_err()
            .to_string(),
        "PLAN_INVALID_ARGUMENT"
    );
}
