use super::*;

/// Local tools are dispatched by the desktop/sidecar, outside tools.execute.
/// Only these host-owned names may enter this permission path. Any new local
/// tool must explicitly choose its policy here before gaining execution.
fn is_local_tool(name: &str) -> bool {
    matches!(
        name,
        "BrowserPreview"
            | "Skill"
            | "GenerateImages"
            | "PluginScaffold"
            | "PluginCheck"
            | "PluginPack"
    )
}

fn local_scope(
    name: &str,
    args: &Value,
    workspace_path: &str,
    scratch: Option<&Path>,
) -> Option<String> {
    if !is_local_tool(name) {
        return None;
    }
    let canonical_target = if name == "BrowserPreview" {
        let path = args.get("path").and_then(Value::as_str)?;
        let (target, _) = workspace::resolve_tool_path_with_external(
            Path::new(workspace_path),
            scratch,
            path,
            false,
        )
        .ok()?;
        if tools::ignore_rules::is_sensitive_path(&target) {
            return None;
        }
        Some(target)
    } else {
        None
    };
    Some(grants::fingerprint(&json!({
        "name": name, "workspace": workspace_path, "target": canonical_target, "args": args,
    })))
}

pub(super) async fn authorize(
    state: &Arc<Mutex<AppState>>,
    params: &Value,
    tx: &mpsc::UnboundedSender<String>,
) -> Result<Value, JsonRpcError> {
    let p: ToolsExecuteParams = serde_json::from_value(params.clone())
        .map_err(|error| rpc_err(1002, error.to_string(), "INVALID_PARAMS"))?;
    if !is_local_tool(&p.tool_name) {
        return Err(rpc_err(1002, "unregistered local tool", "INVALID_PARAMS"));
    }
    let (receiver, request, auto, generation, scope, workspace_path, actor_id, grant_reused) = {
        let mut st = state.lock().await;
        if st.shutting_down {
            return Err(rpc_err(1001, "host is shutting down", "HOST_SHUTTING_DOWN"));
        }
        let mode = sessions::session_mode(&st.db, &p.session_id)
            .map_err(|error| rpc_err(1000, error.to_string(), "INTERNAL"))?
            .ok_or_else(|| rpc_err(1007, "session not found", "SESSION_NOT_FOUND"))?;
        let workspace_path = resolve_tool_workspace_for_call(&st, &p.session_id, &p.args)?
            .ok_or_else(|| rpc_err(1008, "workspace unavailable", "AUTHORIZATION_STALE"))?;
        let scratch = scratch::session_dir(&st.data_dir, &p.session_id);
        let scope = local_scope(&p.tool_name, &p.args, &workspace_path, scratch.as_deref())
            .ok_or_else(|| {
                rpc_err(
                    1008,
                    "local tool target is not permitted",
                    "WORKSPACE_PATH_DENIED",
                )
            })?;
        let permission_mode = permission_policy::effective_permission_mode(
            &st,
            &p.session_id,
            p.permission_scope.as_deref(),
        )?;
        let actor_id = p
            .actor_id
            .as_deref()
            .filter(|id| !id.trim().is_empty())
            .unwrap_or("agent")
            .to_string();
        st.local_execution_permits.retain(|_, permit| {
            permit.created_at.elapsed()
                < Duration::from_millis(crate::permissions::PERMISSION_TIMEOUT_MS)
        });
        st.local_permission_calls.retain(|_, created| {
            created.elapsed() < Duration::from_millis(crate::permissions::PERMISSION_TIMEOUT_MS)
        });
        let key = (p.session_id.clone(), p.tool_call_id.clone());
        if st.local_permission_calls.contains_key(&key) {
            return Err(rpc_err(
                1008,
                "local tool call already authorized or pending",
                "AUTHORIZATION_STALE",
            ));
        }
        if st.local_permission_calls.len() >= crate::permissions::permits::MAX_OUTSTANDING_PERMITS {
            return Err(rpc_err(
                1008,
                "too many outstanding local tools",
                "AGENT_BUSY",
            ));
        }
        st.local_permission_calls
            .insert(key, std::time::Instant::now());
        let generation = st.permissions.generation(&p.session_id);
        let mut auto = st
            .permissions
            .evaluate_auto_with_permission_mode_and_risk_and_path(PermissionEvaluationParams {
                tool_name: &p.tool_name,
                mode: &mode,
                permission_mode: &permission_mode,
                declared_risk: None,
                requires_external_path_permission: false,
                plan_safe_actions: None,
            });
        let grant_reused = auto.is_none()
            && st
                .session_grants
                .allows(&p.session_id, &actor_id, &p.tool_name, &scope);
        if grant_reused {
            auto = Some(PermissionDecision::AllowOnce);
        }
        let mut request = None;
        let mut receiver = None;
        if auto.is_none() {
            let reviewer = permission_policy::effective_reviewer(&st, &p.session_id)?;
            let user_message_id = permission_review::originating_user_message_id(
                &st,
                &p.session_id,
                p.turn_id.as_deref(),
            );
            let review_enabled = reviewer == "auto_review" && st.review_executor_available;
            let (created, rx) = st.permissions.create_request_with_risk_and_shell(
                crate::permissions::PermissionRequestParams {
                    session_id: &p.session_id,
                    tool_call_id: &p.tool_call_id,
                    tool_name: &p.tool_name,
                    args_preview: p.args.clone(),
                    reason: "Host-local tool requires approval",
                    declared_risk: None,
                    command_shell_id: None,
                    scope_label: Some(&p.tool_name),
                    review_state: if review_enabled {
                        "awaiting_review"
                    } else {
                        "user"
                    },
                    turn_id: p.turn_id.as_deref(),
                    user_message_id: user_message_id.as_deref(),
                    permission_mode: &permission_mode,
                    workspace_path: Some(&workspace_path),
                },
            );
            st.permissions.bind_action(
                &created.request_id,
                &grants::fingerprint(&json!({
                    "sessionId": p.session_id, "turnId": p.turn_id,
                    "actorId": actor_id, "toolCallId": p.tool_call_id,
                    "toolName": p.tool_name, "args": p.args, "scope": scope,
                })),
            );
            st.permissions.bind_actor(&created.request_id, &actor_id);
            st.register_pending_permission(&created.request_id, &p.session_id, &p.tool_call_id);
            request = Some(created);
            receiver = Some(rx);
        }
        (
            receiver,
            request,
            auto,
            generation,
            scope,
            workspace_path,
            actor_id,
            grant_reused,
        )
    };
    if let Some(req) = request.as_ref() {
        let timestamps = {
            let st = state.lock().await;
            st.permissions
                .pending_requests(Some(&req.session_id))
                .into_iter()
                .find(|pending| pending.request.request_id == req.request_id)
        };
        let mut fields = serde_json::to_value(req)
            .map_err(|error| rpc_err(1000, error.to_string(), "INTERNAL"))?;
        if let Some(pending) = timestamps {
            fields["createdAt"] = json!(pending.created_at);
            fields["expiresAt"] = json!(pending.expires_at);
        }
        emit_notification(tx, "permissions.request", fields).await;
    }
    let decision = if let Some(auto) = auto {
        auto
    } else if let Some(rx) = receiver {
        match tokio::time::timeout(
            Duration::from_millis(crate::permissions::PERMISSION_TIMEOUT_MS),
            rx,
        )
        .await
        {
            Ok(Ok(decision)) => decision,
            _ => PermissionDecision::Deny,
        }
    } else {
        PermissionDecision::Deny
    };
    if let Some(req) = request {
        let mut st = state.lock().await;
        st.permissions.cancel(&req.request_id);
        st.clear_pending_permission(&req.request_id);
    }
    if matches!(decision, PermissionDecision::Deny) {
        let mut st = state.lock().await;
        st.local_permission_calls
            .remove(&(p.session_id.clone(), p.tool_call_id.clone()));
        return Ok(json!({"ok": false, "denied": true, "errorCode": "TOOL_DENIED"}));
    }
    let mut st = state.lock().await;
    let current_workspace = resolve_tool_workspace_for_call(&st, &p.session_id, &p.args)
        .ok()
        .flatten();
    let current_scratch = scratch::session_dir(&st.data_dir, &p.session_id);
    let current_scope = current_workspace.as_deref().and_then(|workspace| {
        local_scope(&p.tool_name, &p.args, workspace, current_scratch.as_deref())
    });
    if st.shutting_down
        || st.permissions.generation(&p.session_id) != generation
        || current_workspace.as_deref() != Some(workspace_path.as_str())
        || current_scope.as_deref() != Some(scope.as_str())
        || p.turn_id
            .as_deref()
            .is_some_and(|turn| !permission_review::running_turn(&st, &p.session_id, turn))
        || (grant_reused
            && !st
                .session_grants
                .allows(&p.session_id, &actor_id, &p.tool_name, &scope))
    {
        st.local_permission_calls
            .remove(&(p.session_id.clone(), p.tool_call_id.clone()));
        return Ok(json!({"ok": false, "denied": true, "errorCode": "AUTHORIZATION_STALE"}));
    }
    if matches!(decision, PermissionDecision::AllowSession) {
        st.session_grants.grant(
            &p.session_id,
            &actor_id,
            &p.tool_name,
            "external",
            &scope,
            &format!("{}: exact arguments", p.tool_name),
        );
    }
    let permit = ExecutionPermit::new(
        &p.session_id,
        p.turn_id.as_deref(),
        &p.tool_call_id,
        &p.tool_name,
        &p.args,
        generation,
        &scope,
        &actor_id,
        grant_reused || matches!(decision, PermissionDecision::AllowSession),
    );
    let token = permit.token.clone();
    st.local_execution_permits.insert(token.clone(), permit);
    Ok(json!({"ok": true, "executionPermit": token}))
}

pub(super) async fn consume(
    state: &Arc<Mutex<AppState>>,
    params: &Value,
) -> Result<Value, JsonRpcError> {
    let token = params
        .get("executionPermit")
        .and_then(Value::as_str)
        .ok_or_else(|| rpc_err(1002, "executionPermit required", "INVALID_PARAMS"))?;
    let mut st = state.lock().await;
    let permit = st.local_execution_permits.remove(token).ok_or_else(|| {
        rpc_err(
            1008,
            "local execution permit unavailable",
            "AUTHORIZATION_STALE",
        )
    })?;
    st.local_permission_calls
        .remove(&(permit.session_id.clone(), permit.tool_call_id.clone()));
    let current_workspace =
        resolve_tool_workspace_for_call(&st, &permit.session_id, &params["args"])
            .ok()
            .flatten();
    let current_scratch = scratch::session_dir(&st.data_dir, &permit.session_id);
    let current_scope = current_workspace.as_deref().and_then(|workspace| {
        local_scope(
            &permit.tool_name,
            &params["args"],
            workspace,
            current_scratch.as_deref(),
        )
    });
    let grant_active = st.session_grants.allows(
        &permit.session_id,
        &permit.actor_id,
        &permit.tool_name,
        &permit.scope_fingerprint,
    );
    let turn_running = permit
        .turn_id
        .as_deref()
        .is_some_and(|turn| permission_review::running_turn(&st, &permit.session_id, turn));
    let matches = !st.shutting_down
        && permit.actor_id
            == params
                .get("actorId")
                .and_then(Value::as_str)
                .filter(|id| !id.trim().is_empty())
                .unwrap_or("agent")
        && permit.matches(
            token,
            params
                .get("sessionId")
                .and_then(Value::as_str)
                .unwrap_or(""),
            params.get("turnId").and_then(Value::as_str),
            params
                .get("toolCallId")
                .and_then(Value::as_str)
                .unwrap_or(""),
            params.get("toolName").and_then(Value::as_str).unwrap_or(""),
            &params["args"],
            st.permissions.generation(&permit.session_id),
            current_scope.as_deref(),
            grant_active,
            turn_running,
        );
    if !matches {
        return Err(rpc_err(
            1008,
            "local authorization changed",
            "AUTHORIZATION_STALE",
        ));
    }
    Ok(json!({"ok": true}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn local_approval_dispatches_once_and_rejects_changed_arguments() {
        let dir = tempfile::tempdir().unwrap();
        let mut app = AppState::open(dir.path()).unwrap();
        app.handshook = true;
        let session = sessions::create_session(
            &app.db,
            Some("local".into()),
            Some("agent".into()),
            None,
            None,
            None,
        )
        .unwrap();
        let state = Arc::new(Mutex::new(app));
        let (tx, mut rx) = mpsc::unbounded_channel();
        let args = json!({"prompt": "sample"});
        let input = json!({"sessionId": session.id, "toolCallId": "call", "toolName": "GenerateImages",
            "mode": "agent", "args": args});
        let join = tokio::spawn({
            let state = state.clone();
            let tx = tx.clone();
            let input = input.clone();
            async move { authorize(&state, &input, &tx).await }
        });
        let notification: Value = serde_json::from_str(
            &tokio::time::timeout(Duration::from_secs(3), rx.recv())
                .await
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(notification["method"], "permissions.request");
        assert!(notification["params"]["createdAt"].as_str().is_some());
        assert!(notification["params"]["expiresAt"].as_str().is_some());
        handle_request(
            state.clone(),
            "permissions.resolve",
            json!({
                "requestId": notification["params"]["requestId"], "decision": "allow-once"
            }),
            tx,
        )
        .await
        .unwrap();
        let response = join.await.unwrap().unwrap();
        assert_eq!(response["ok"], true);
        let mut consume_params = json!({"executionPermit": response["executionPermit"],
            "sessionId": session.id, "toolCallId": "call", "toolName": "GenerateImages", "args": args});
        let mut changed = consume_params.clone();
        changed["args"]["prompt"] = json!("other");
        assert!(consume(&state, &changed).await.is_err());
        assert!(consume(&state, &consume_params).await.is_err());
        // A new authorization has its own single-use permit.
        sessions::configure_session_with_thinking(
            &state.lock().await.db,
            &session.id,
            "agent",
            None,
            None,
            None,
            Some("auto"),
        )
        .unwrap();
        let (tx, _) = mpsc::unbounded_channel();
        let second = authorize(&state, &input, &tx).await.unwrap();
        assert_eq!(second["ok"], true);
        consume_params["executionPermit"] = second["executionPermit"].clone();
        assert_eq!(consume(&state, &consume_params).await.unwrap()["ok"], true);
        assert!(consume(&state, &consume_params).await.is_err());
    }

    #[tokio::test]
    async fn plan_and_unknown_local_tools_never_receive_permits() {
        let dir = tempfile::tempdir().unwrap();
        let mut app = AppState::open(dir.path()).unwrap();
        app.handshook = true;
        let session = sessions::create_session(
            &app.db,
            Some("local".into()),
            Some("plan".into()),
            None,
            None,
            None,
        )
        .unwrap();
        let state = Arc::new(Mutex::new(app));
        let (tx, _) = mpsc::unbounded_channel();
        let input = json!({"sessionId": session.id, "toolCallId": "call", "toolName": "GenerateImages",
            "mode": "agent", "args": {"prompt": "sample"}});
        assert_eq!(authorize(&state, &input, &tx).await.unwrap()["ok"], false);
        let mut unknown = input;
        unknown["toolName"] = json!("CustomLocalShell");
        assert!(authorize(&state, &unknown, &tx).await.is_err());
    }

    #[tokio::test]
    async fn ending_turn_cancels_pending_review_and_clears_local_ownership() {
        let dir = tempfile::tempdir().unwrap();
        let mut app = AppState::open(dir.path()).unwrap();
        app.handshook = true;
        let session = sessions::create_session(
            &app.db,
            Some("turn".into()),
            Some("agent".into()),
            None,
            None,
            None,
        )
        .unwrap();
        let turn = sessions::begin_turn(&app.db, &session.id, None, None).unwrap();
        let state = Arc::new(Mutex::new(app));
        let (tx, mut rx) = mpsc::unbounded_channel();
        let input = json!({"sessionId": session.id, "turnId": turn, "toolCallId": "call",
            "toolName": "GenerateImages", "mode": "agent", "args": {"prompt": "sample"}});
        let join = tokio::spawn({
            let state = state.clone();
            let tx = tx.clone();
            async move { authorize(&state, &input, &tx).await }
        });
        let notification = tokio::time::timeout(Duration::from_secs(3), rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&notification).unwrap()["method"],
            "permissions.request"
        );
        handle_request(
            state.clone(),
            "session.endTurn",
            json!({"turnId": turn,
            "status": "aborted", "createNotification": false}),
            tx,
        )
        .await
        .unwrap();
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(3), join)
                .await
                .unwrap()
                .unwrap()
                .unwrap()["errorCode"],
            "TOOL_DENIED"
        );
        let st = state.lock().await;
        assert!(st
            .permissions
            .pending_requests(Some(&session.id))
            .is_empty());
        assert!(st.local_permission_calls.is_empty());
        assert!(st.local_execution_permits.is_empty());
    }

    #[tokio::test]
    async fn local_delegate_scope_overrides_inherited_auto_just_like_host_tools() {
        let dir = tempfile::tempdir().unwrap();
        let mut app = AppState::open(dir.path()).unwrap();
        app.handshook = true;
        app.db
            .set_setting("app", &json!({"defaultPermissionMode": "auto"}))
            .unwrap();
        let session = sessions::create_session(
            &app.db,
            Some("delegate".into()),
            Some("agent".into()),
            None,
            None,
            None,
        )
        .unwrap();
        let state = Arc::new(Mutex::new(app));
        let (tx, mut rx) = mpsc::unbounded_channel();
        let input = json!({"sessionId": session.id, "toolCallId": "delegate-call",
            "toolName": "GenerateImages", "mode": "agent", "permissionScope": "ask",
            "args": {"prompt": "sample"}});
        assert_eq!(
            permission_policy::effective_permission_mode(&*state.lock().await, &session.id, None)
                .unwrap(),
            "auto"
        );
        assert_eq!(
            permission_policy::effective_permission_mode(
                &*state.lock().await,
                &session.id,
                Some("ask")
            )
            .unwrap(),
            "ask"
        );
        let join = tokio::spawn({
            let state = state.clone();
            let tx = tx.clone();
            async move { authorize(&state, &input, &tx).await }
        });
        let notification: Value = serde_json::from_str(
            &tokio::time::timeout(Duration::from_secs(3), rx.recv())
                .await
                .unwrap()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(notification["method"], "permissions.request");
        assert_eq!(notification["params"]["permissionMode"], "ask");
        handle_request(
            state,
            "permissions.resolve",
            json!({"requestId":
            notification["params"]["requestId"], "decision": "deny"}),
            tx,
        )
        .await
        .unwrap();
        assert_eq!(join.await.unwrap().unwrap()["ok"], false);
    }

    #[tokio::test]
    async fn deleting_session_invalidates_outstanding_local_permit() {
        let dir = tempfile::tempdir().unwrap();
        let mut app = AppState::open(dir.path()).unwrap();
        app.handshook = true;
        let session = sessions::create_session(
            &app.db,
            Some("delete".into()),
            Some("agent".into()),
            None,
            None,
            None,
        )
        .unwrap();
        sessions::configure_session_with_thinking(
            &app.db,
            &session.id,
            "agent",
            None,
            None,
            None,
            Some("auto"),
        )
        .unwrap();
        let state = Arc::new(Mutex::new(app));
        let (tx, _) = mpsc::unbounded_channel();
        let input = json!({"sessionId": session.id, "toolCallId": "call", "toolName": "GenerateImages",
            "mode": "agent", "args": {"prompt": "sample"}});
        let permit = authorize(&state, &input, &tx).await.unwrap();
        assert_eq!(permit["ok"], true);
        handle_request(
            state.clone(),
            "session.delete",
            json!({"id": session.id}),
            tx,
        )
        .await
        .unwrap();
        let mut consume_params = input;
        consume_params["executionPermit"] = permit["executionPermit"].clone();
        assert!(consume(&state, &consume_params).await.is_err());
        assert!(state.lock().await.local_permission_calls.is_empty());
    }
}
