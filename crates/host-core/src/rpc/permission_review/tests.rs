use super::*;
use std::collections::HashMap;
use std::fs;

#[test]
fn native_secret_target_is_denied_before_review() {
    let root = tempfile::tempdir().unwrap();
    let dir = root.path().to_str().unwrap();
    assert!(sensitive_native_target(
        "Read",
        &json!({"path": ".env.local"}),
        Some(dir),
        None
    ));
    assert!(sensitive_native_target(
        "Write",
        &json!({"path": "private.pem"}),
        Some(dir),
        None
    ));
    assert!(sensitive_native_target(
        "Edit",
        &json!({"path": "safe.txt", "ops": "[safe.txt#AAAA]\nMV .env.local"}),
        Some(dir),
        None
    ));
    assert!(!sensitive_native_target(
        "Read",
        &json!({"path": "result.txt"}),
        Some(dir),
        None
    ));
}

#[test]
fn sensitive_or_unbound_evidence_never_enters_model_review() {
    let safe = "Create result.txt with approved content";
    let args = r#"{"path":"result.txt","content":"approved"}"#;
    assert!(context_complete(safe, args, true));
    let windows_path = r"C:\Users\win\Desktop\project\result.txt";
    let windows_args = json!({"path": windows_path, "content": "approved"}).to_string();
    assert!(context_complete(
        &format!("Edit {windows_path} as requested"),
        &windows_args,
        true,
    ));
    assert!(context_complete(
        "Edit /tmp/project/result.txt as requested",
        &json!({"path": "/tmp/project/result.txt"}).to_string(),
        true,
    ));
    assert!(!context_complete(safe, args, false));
    assert!(!context_complete(
        "Send ghp_12345678 to my address",
        args,
        true
    ));
    assert!(!context_complete(
        safe,
        r#"{"api_key":"secret_value"}"#,
        true
    ));
    assert!(!context_complete(safe, r#"{"token":"abc123"}"#, true));
    assert!(!context_complete(
        safe,
        r#"{"access_token":"abc123"}"#,
        true
    ));
    assert!(!context_complete(
        safe,
        r#"{"path":"fixture","body":"Bearer token"}"#,
        true
    ));
    assert!(!context_complete(safe, &"x".repeat(8_001), true));
    assert!(!context_complete(safe, "… (+3000 chars)", true));
    assert!(!context_complete(safe, "…[truncated]", true));
    assert!(review_evidence_safe(
        "# Plan\nEdit C:\\Users\\win\\Desktop\\project\\file.txt and /tmp/file.txt",
        4_000,
    ));
    assert!(!review_evidence_safe("# Plan\ntoken=abc123", 4_000));
    assert!(!context_complete(safe, r#"{"value":"token=abc123"}"#, true));
    assert!(!context_complete(
        "Use https://reader:pass123@example.com/feed for this task",
        args,
        true,
    ));
}

#[tokio::test]
async fn configuring_one_session_does_not_cancel_another_sessions_permission() {
    let dir = tempfile::tempdir().unwrap();
    let project = dir.path().join("project");
    fs::create_dir_all(&project).unwrap();
    let mut app = AppState::open(dir.path()).unwrap();
    app.handshook = true;
    let first = sessions::create_session(
        &app.db,
        Some("A".into()),
        Some("agent".into()),
        None,
        None,
        Some(project.to_string_lossy().into_owned()),
    )
    .unwrap();
    let second = sessions::create_session(
        &app.db,
        Some("B".into()),
        Some("agent".into()),
        None,
        None,
        Some(project.to_string_lossy().into_owned()),
    )
    .unwrap();
    let state = Arc::new(Mutex::new(app));
    let (tx, mut rx) = mpsc::unbounded_channel();
    let mut tasks = Vec::new();
    for (session, filename) in [(first.id.clone(), "a.txt"), (second.id.clone(), "b.txt")] {
        let state = state.clone();
        let tx = tx.clone();
        tasks.push(tokio::spawn(async move {
            handle_request(state, "tools.execute", json!({
            "sessionId": session, "toolCallId": filename, "toolName": "Write", "mode": "agent",
            "args": {"path": filename, "content": "authorized"}
        }), tx).await
        }));
    }
    let mut request_ids = HashMap::new();
    while request_ids.len() < 2 {
        let note = tokio::time::timeout(Duration::from_secs(3), rx.recv())
            .await
            .unwrap()
            .unwrap();
        let frame: Value = serde_json::from_str(&note).unwrap();
        if frame["method"] == "permissions.request" {
            request_ids.insert(
                frame["params"]["sessionId"].as_str().unwrap().to_owned(),
                frame["params"]["requestId"].as_str().unwrap().to_owned(),
            );
        }
    }
    handle_request(
        state.clone(),
        "session.configure",
        json!({
            "id": first.id, "mode": "agent", "approvalReviewer": "user", "permissionMode": "auto",
        }),
        tx.clone(),
    )
    .await
    .unwrap();
    assert!(handle_request(
        state.clone(),
        "permissions.pending",
        json!({
            "sessionId": second.id,
        }),
        tx.clone()
    )
    .await
    .unwrap()["requests"]
        .as_array()
        .is_some_and(|requests| requests.len() == 1));
    handle_request(
        state.clone(),
        "permissions.resolve",
        json!({
            "requestId": request_ids[&second.id], "decision": "allow-once"
        }),
        tx,
    )
    .await
    .unwrap();
    let a = tasks.remove(0).await.unwrap().unwrap();
    let b = tasks.remove(0).await.unwrap().unwrap();
    assert_eq!(a["ok"], false);
    assert_eq!(b["ok"], true);
    assert!(!project.join("a.txt").exists());
    assert_eq!(
        fs::read_to_string(project.join("b.txt")).unwrap(),
        "authorized"
    );
}

#[tokio::test]
async fn reviewer_disconnect_notifies_manual_fallback_and_rejects_stale_result() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = AppState::open(dir.path()).unwrap();
    app.handshook = true;
    app.review_executor_available = true;
    let (request, _receiver) = app.permissions.create_request_with_risk_and_shell(
        crate::permissions::PermissionRequestParams {
            session_id: "test",
            tool_call_id: "call",
            tool_name: "Write",
            args_preview: json!({"path": "out.txt"}),
            reason: "writes a file",
            declared_risk: None,
            command_shell_id: None,
            review_state: "awaiting_review",
            scope_label: None,
            turn_id: None,
            user_message_id: None,
            permission_mode: "ask",
            workspace_path: None,
        },
    );
    app.permissions
        .bind_action(&request.request_id, "fingerprint");
    let (token, _, fingerprint, _, _, _) =
        app.permissions.claim_review(&request.request_id).unwrap();
    let state = Arc::new(Mutex::new(app));
    let (tx, mut rx) = mpsc::unbounded_channel();
    handle_request(
        state.clone(),
        "permissions.setReviewCapability",
        json!({"available": false}),
        tx,
    )
    .await
    .unwrap();
    let notification: Value = serde_json::from_str(&rx.recv().await.unwrap()).unwrap();
    assert_eq!(notification["method"], "permissions.reviewUpdated");
    assert_eq!(notification["params"]["requestId"], request.request_id);
    assert_eq!(notification["params"]["reviewState"], "user");
    assert_eq!(
        state
            .lock()
            .await
            .permissions
            .review_state(&request.request_id),
        Some("user")
    );
    assert!(state
        .lock()
        .await
        .permissions
        .resolve_review(&request.request_id, &token, &fingerprint, "allow_once")
        .is_err());
}

#[tokio::test]
async fn desktop_permit_admission_has_a_finite_quota() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = AppState::open(dir.path()).unwrap();
    let generation = app.permissions.generation("session");
    for index in 0..crate::permissions::permits::MAX_OUTSTANDING_PERMITS {
        app.plugin_execution_permits.insert(
            index.to_string(),
            ExecutionPermit::new(
                "session",
                None,
                "call",
                "plugin_test_run",
                &json!({}),
                generation,
                "scope",
                "agent",
                false,
            ),
        );
    }
    let state = Arc::new(Mutex::new(app));
    let (tx, mut notifications) = mpsc::unbounded_channel();
    let params: ToolsExecuteParams = serde_json::from_value(json!({
        "sessionId": "session", "toolCallId": "new", "toolName": "plugin_test_run",
        "mode": "agent", "args": {}, "timeoutMs": 1000,
    }))
    .unwrap();
    let outcome = execute_plugin_tool(
        &state, &tx, &params, 1000, "agent", generation, None, "agent", false,
    )
    .await;
    assert_eq!(outcome.error_code.as_deref(), Some("AGENT_BUSY"));
    assert!(notifications.try_recv().is_err());
}

#[tokio::test]
async fn execution_permit_rpc_is_single_use_and_rechecks_scope() {
    let dir = tempfile::tempdir().unwrap();
    let project = dir.path().join("project");
    fs::create_dir_all(&project).unwrap();
    let mut app = AppState::open(dir.path()).unwrap();
    app.handshook = true;
    let session = sessions::create_session(
        &app.db,
        Some("permit".into()),
        Some("agent".into()),
        None,
        None,
        Some(project.to_string_lossy().into_owned()),
    )
    .unwrap();
    let session_id = session.id;
    let args = json!({"path": "out.txt", "content": "write"});
    let (_, scope, _) =
        grants::action_scope("Write", &args, Some(&project), None, None, None).unwrap();
    let generation = app.permissions.generation(&session_id);
    let permit = ExecutionPermit::new(
        &session_id,
        None,
        "call",
        "Write",
        &args,
        generation,
        &scope,
        "agent",
        false,
    );
    let token = permit.token.clone();
    let (sender, _receiver) = oneshot::channel();
    app.plugin_execs.insert("exec".into(), sender);
    app.plugin_execution_permits.insert("exec".into(), permit);
    let state = Arc::new(Mutex::new(app));
    let (tx, _) = mpsc::unbounded_channel();
    let input = json!({"executionId": "exec", "permitToken": token,
        "sessionId": session_id, "toolCallId": "call", "toolName": "Write", "args": args});
    let mut changed = input.clone();
    changed["args"]["path"] = json!("other.txt");
    assert!(handle_request(
        state.clone(),
        "permissions.consumeExecutionPermit",
        changed,
        tx.clone()
    )
    .await
    .is_err());
    // An invalid consume burns the permit rather than allowing a later replay.
    assert!(handle_request(
        state.clone(),
        "permissions.consumeExecutionPermit",
        input.clone(),
        tx.clone()
    )
    .await
    .is_err());
    let (_, scope, _) =
        grants::action_scope("Write", &input["args"], Some(&project), None, None, None).unwrap();
    state.lock().await.plugin_execution_permits.insert(
        "exec".into(),
        ExecutionPermit::new(
            &session_id,
            None,
            "call",
            "Write",
            &input["args"],
            generation,
            &scope,
            "agent",
            false,
        ),
    );
    let token = state.lock().await.plugin_execution_permits["exec"]
        .token
        .clone();
    let mut valid = input;
    valid["permitToken"] = json!(token);
    assert_eq!(
        handle_request(
            state.clone(),
            "permissions.consumeExecutionPermit",
            valid.clone(),
            tx.clone()
        )
        .await
        .unwrap()["ok"],
        true
    );
    assert!(
        handle_request(state, "permissions.consumeExecutionPermit", valid, tx)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn pathless_session_review_snapshot_uses_authoritative_scratch_root() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = AppState::open(dir.path()).unwrap();
    let session = sessions::create_session(
        &app.db,
        Some("temporary".into()),
        Some("agent".into()),
        None,
        None,
        None,
    )
    .unwrap();
    let workspace = resolve_tool_workspace_for_call(&app, &session.id, &json!({"path": "out.txt"}))
        .unwrap()
        .unwrap();
    assert!(workspace.contains("scratch"));
    let (request, _receiver) = app.permissions.create_request_with_risk_and_shell(
        crate::permissions::PermissionRequestParams {
            session_id: &session.id,
            tool_call_id: "call",
            tool_name: "Write",
            args_preview: json!({"path": "out.txt"}),
            reason: "writes a file",
            declared_risk: None,
            command_shell_id: None,
            review_state: "awaiting_review",
            scope_label: None,
            turn_id: None,
            user_message_id: None,
            permission_mode: "ask",
            workspace_path: Some(&workspace),
        },
    );
    app.permissions
        .bind_action(&request.request_id, "fingerprint");
    let state = Arc::new(Mutex::new(app));
    let (tx, _) = mpsc::unbounded_channel();
    let action = claim(&state, &json!({"requestId": request.request_id}), &tx)
        .await
        .unwrap()["action"]
        .clone();
    assert_eq!(action["workspace"], workspace);
    assert_eq!(action["workingDirectory"], workspace);
    assert_eq!(action["complete"], false);
    assert!(action["userRequest"].as_str().unwrap().is_empty());
}

#[tokio::test]
async fn sidecar_cannot_forge_plugin_risk_or_plan_exemption() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = AppState::open(dir.path()).unwrap();
    app.handshook = true;
    let session = sessions::create_session(
        &app.db,
        Some("plugin".into()),
        Some("agent".into()),
        None,
        None,
        None,
    )
    .unwrap();
    let state = Arc::new(Mutex::new(app));
    let (tx, _) = mpsc::unbounded_channel();
    let input = json!({"sessionId": session.id, "toolName": "plugin_absent_send",
        "declaredRisk": "low", "planSafeActions": ["send"], "args": {"action": "send"}});
    let evaluated = handle_request(
        state.clone(),
        "permissions.evaluate",
        input.clone(),
        tx.clone(),
    )
    .await
    .unwrap();
    assert_eq!(evaluated["risk"], "medium");
    assert!(evaluated["decision"].is_null());
    sessions::configure_session_with_thinking(
        &state.lock().await.db,
        &session.id,
        "plan",
        None,
        None,
        None,
        None,
    )
    .unwrap();
    let evaluated = handle_request(state, "permissions.evaluate", input, tx)
        .await
        .unwrap();
    assert_eq!(evaluated["decision"], "deny");
}

#[test]
fn approved_plan_context_is_bound_to_verified_artifact_and_original_request() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = dir.path().join("project");
    fs::create_dir_all(&workspace).unwrap();
    let app = AppState::open(dir.path()).unwrap();
    let session = sessions::create_session(
        &app.db,
        Some("plan".into()),
        Some("plan".into()),
        None,
        None,
        Some(workspace.to_string_lossy().into_owned()),
    )
    .unwrap();
    let plan_turn = sessions::begin_turn(&app.db, &session.id, None, None).unwrap();
    let original: sessions::UiMessage = serde_json::from_value(json!({
        "id": "user-request", "role": "user", "content": "Build the API endpoint",
        "createdAt": chrono::Utc::now().to_rfc3339(),
    }))
    .unwrap();
    sessions::append_message(&app.db, &session.id, &original, Some(&plan_turn)).unwrap();
    let proposal = app
        .plans
        .submit(
            &app.db,
            plans::PlanSubmitParams {
                workspace_root: &workspace,
                session_id: &session.id,
                turn_id: &plan_turn,
                tool_call_id: "submit-plan",
                kind: plans::KIND_PLAN,
                title: "Build API",
                markdown: "# Plan\n- implement endpoint",
                question: "Proceed?",
            },
        )
        .unwrap();
    sessions::end_turn(&app.db, &plan_turn, "completed", None, None, false).unwrap();
    let resolution = app
        .plans
        .resolve(
            &app.db,
            plans::PlanResolveParams {
                workspace_root: Some(&workspace),
                proposal_id: &proposal.id,
                session_id: &session.id,
                turn_id: &plan_turn,
                tool_call_id: "submit-plan",
                version: Some(proposal.version),
                action: "approve",
                target_permission_mode: Some("ask"),
            },
        )
        .unwrap();
    app.plans
        .claim_execution(&app.db, &resolution.execution.unwrap().id)
        .unwrap();
    let execution_turn = sessions::begin_turn(&app.db, &session.id, None, None).unwrap();
    let unrelated: sessions::UiMessage = serde_json::from_value(json!({
        "id": "unrelated", "role": "user", "content": "Delete unrelated files",
        "createdAt": chrono::Utc::now().to_rfc3339(),
    }))
    .unwrap();
    sessions::append_message(&app.db, &session.id, &unrelated, Some(&execution_turn)).unwrap();
    let context = approved_execution_context(&app, &session.id, Some(&execution_turn))
        .unwrap()
        .unwrap();
    assert_eq!(context.0, "Build the API endpoint");
    assert_eq!(context.1, "# Plan\n- implement endpoint");
    let artifact = proposal.artifact.unwrap();
    fs::write(workspace.join(artifact.relative_path), "tampered").unwrap();
    assert!(approved_execution_context(&app, &session.id, Some(&execution_turn)).is_err());
}

#[tokio::test]
async fn invalid_stored_policy_cannot_be_claimed_or_approved_as_default() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = AppState::open(dir.path()).unwrap();
    app.handshook = true;
    let session = sessions::create_session(
        &app.db,
        Some("review".into()),
        Some("agent".into()),
        None,
        None,
        None,
    )
    .unwrap();
    let turn = sessions::begin_turn(&app.db, &session.id, None, None).unwrap();
    let make_request = |st: &mut AppState, tool_call_id: &str| {
        let (request, _receiver) = st.permissions.create_request_with_risk_and_shell(
            crate::permissions::PermissionRequestParams {
                session_id: &session.id,
                tool_call_id,
                tool_name: "Write",
                args_preview: json!({"path":"out.txt"}),
                reason: "writes a file",
                declared_risk: None,
                command_shell_id: None,
                review_state: "awaiting_review",
                scope_label: None,
                turn_id: Some(&turn),
                user_message_id: None,
                permission_mode: "ask",
                workspace_path: None,
            },
        );
        st.permissions
            .bind_action(&request.request_id, "fingerprint");
        request.request_id
    };
    app.db
        .set_setting("app", &json!({"autoReview":{"policyPrompt":false}}))
        .unwrap();
    let first_id = make_request(&mut app, "claim-invalid");
    let state = Arc::new(Mutex::new(app));
    let (tx, mut rx) = mpsc::unbounded_channel();
    let error = claim(&state, &json!({"requestId":first_id}), &tx)
        .await
        .unwrap_err();
    assert_eq!(error.data.unwrap()["errorCode"], "REVIEW_NOT_AVAILABLE");
    assert_eq!(
        state.lock().await.permissions.review_state(&first_id),
        Some("user")
    );
    let notified: Value = serde_json::from_str(&rx.recv().await.unwrap()).unwrap();
    assert_eq!(notified["params"]["reviewState"], "user");

    let second_id = {
        let mut st = state.lock().await;
        st.db
            .set_setting(
                "app",
                &json!({"autoReview":{"policyPrompt":"Ask for edits"}}),
            )
            .unwrap();
        make_request(&mut st, "resolve-invalid")
    };
    let claimed = claim(&state, &json!({"requestId":second_id}), &tx)
        .await
        .unwrap();
    assert_eq!(claimed["action"]["policyPrompt"], "Ask for edits");
    state
        .lock()
        .await
        .db
        .set_setting("app", &json!({"autoReview":{"policyPrompt":" \n "}}))
        .unwrap();
    let error = resolve(
        &state,
        &json!({
            "requestId":second_id,
            "token":claimed["token"],
            "fingerprint":claimed["fingerprint"],
            "result":{"decision":"allow_once", "risk":"low", "authorization":"explicit",
                "reason":"Requested", "policyVersion":"1"},
        }),
        &tx,
    )
    .await
    .unwrap_err();
    assert_eq!(error.data.unwrap()["errorCode"], "REVIEW_NOT_AVAILABLE");
    assert_eq!(
        state.lock().await.permissions.review_state(&second_id),
        Some("user")
    );
}

#[tokio::test]
async fn unicode_reason_limit_counts_characters_not_utf8_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let mut app = AppState::open(dir.path()).unwrap();
    app.handshook = true;
    let saved_policy = "Ask before changing files. 🔒";
    app.db
        .set_setting("app", &json!({"autoReview":{"policyPrompt":saved_policy}}))
        .unwrap();
    let session = sessions::create_session(
        &app.db,
        Some("review".into()),
        Some("agent".into()),
        None,
        None,
        None,
    )
    .unwrap();
    let turn = sessions::begin_turn(&app.db, &session.id, None, None).unwrap();
    let (request, _receiver) = app.permissions.create_request_with_risk_and_shell(
        crate::permissions::PermissionRequestParams {
            session_id: &session.id,
            tool_call_id: "call",
            tool_name: "Write",
            args_preview: json!({"path":"file"}),
            reason: "write",
            declared_risk: None,
            command_shell_id: None,
            review_state: "awaiting_review",
            scope_label: None,
            turn_id: Some(&turn),
            user_message_id: None,
            permission_mode: "ask",
            workspace_path: None,
        },
    );
    app.permissions
        .bind_action(&request.request_id, "fingerprint");
    let (token, _, fingerprint, _, _, _) =
        app.permissions.claim_review(&request.request_id).unwrap();
    app.permissions
        .set_review_context_complete(&request.request_id, &token, true);
    let state = Arc::new(Mutex::new(app));
    let (tx, _) = mpsc::unbounded_channel();
    let outcome = resolve(
        &state,
        &json!({"requestId": request.request_id,
        "token": token, "fingerprint": fingerprint,
        "result": {"decision":"allow_once", "risk":"low", "authorization":"explicit",
            "policyVersion":"1", "reason": "已".repeat(150)}}),
        &tx,
    )
    .await
    .unwrap();
    assert_eq!(outcome["decision"], "allow_once");
    let audit_payload: String = state.lock().await.db.conn().query_row(
        "SELECT payload_json FROM audit_log WHERE kind = 'permission_review' ORDER BY id DESC LIMIT 1",
        [], |row| row.get(0)).unwrap();
    assert!(!audit_payload.contains(saved_policy));
    let expected_identity = format!(
        "custom-sha256:{}",
        grants::fingerprint(&json!(saved_policy))
    );
    let audit_value: Value = serde_json::from_str(&audit_payload).unwrap();
    assert_eq!(audit_value["policyIdentity"], expected_identity);
}
