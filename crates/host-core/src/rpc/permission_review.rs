use super::*;
use rusqlite::{params as sql_params, OptionalExtension};

/// Match the tool executor's canonical denylist before any action is sent to
/// the external reviewer. A move's destination is an independent target.
pub(super) fn sensitive_native_target(
    tool_name: &str,
    args: &Value,
    root: Option<&str>,
    scratch: Option<&std::path::Path>,
) -> bool {
    if !matches!(tool_name, "Read" | "Write" | "Edit") {
        return false;
    }
    let Some(root) = root else {
        return false;
    };
    let Some(requested) = args.get("path").and_then(Value::as_str) else {
        return false;
    };
    let is_sensitive = |path: &str| {
        workspace::resolve_tool_path_with_external(std::path::Path::new(root), scratch, path, true)
            .is_ok_and(|(resolved, _)| tools::ignore_rules::is_sensitive_path(&resolved))
    };
    if is_sensitive(requested) {
        return true;
    }
    if tool_name != "Edit" {
        return false;
    }
    args.get("ops")
        .and_then(Value::as_str)
        .and_then(|ops| tools::hashline::parse_ops(ops).ok())
        .is_some_and(|parsed| {
            parsed.ops.into_iter().any(|op| match op {
                tools::hashline::ParsedOp::Mv { dest } => is_sensitive(&dest),
                _ => false,
            })
        })
}

pub(super) fn running_turn(state: &AppState, session_id: &str, turn_id: &str) -> bool {
    match state.db.conn().query_row(
        "SELECT EXISTS(SELECT 1 FROM turns WHERE id = ?1 AND session_id = ?2 AND status = 'running')",
        sql_params![turn_id, session_id], |row| row.get::<_, bool>(0),
    ) {
        Ok(running) => running,
        Err(error) => { tracing::warn!(%error, "permission turn check failed"); false }
    }
}

pub(super) fn originating_user_message_id(
    state: &AppState,
    session_id: &str,
    turn_id: Option<&str>,
) -> Option<String> {
    let turn_id = turn_id?;
    if !running_turn(state, session_id, turn_id) {
        return None;
    }
    match state
        .db
        .conn()
        .query_row(
            "SELECT m.id FROM messages m JOIN turns t ON t.id = ?2
         WHERE m.session_id = ?1 AND m.role = 'user' AND t.session_id = ?1
           AND (m.turn_id = t.id OR (
             m.turn_id IS NULL AND m.created_at <= t.started_at
             AND m.created_at > COALESCE((SELECT MAX(p.started_at) FROM turns p
               WHERE p.session_id = t.session_id AND p.started_at < t.started_at), 0)
           )) ORDER BY m.seq DESC LIMIT 1",
            sql_params![session_id, turn_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
    {
        Ok(id) => id,
        Err(error) => {
            tracing::warn!(%error, "permission user-message lookup failed");
            None
        }
    }
}

fn unsafe_context(text: &str) -> bool {
    let lower = text.to_ascii_lowercase().replace('_', "");
    [
        "password",
        "secret",
        "privatekey",
        "apikey",
        "authorization",
        "cookie",
        "credential",
        "bearer ",
        "-----begin",
        "sk-",
        "ghp",
    ]
    .iter()
    .any(|term| lower.contains(term))
}

fn review_evidence_safe(text: &str, max_chars: usize) -> bool {
    text.chars().count() <= max_chars
        && !text.contains("… (+")
        && !text.contains("…[truncated]")
        && !unsafe_context(text)
        && audit::redact_credentials(text) == text
}

fn context_complete(user_request: &str, argument_text: &str, turn_running: bool) -> bool {
    turn_running
        && !user_request.is_empty()
        && review_evidence_safe(user_request, 4_000)
        && review_evidence_safe(argument_text, 8_000)
}

/// The approved artifact, not a model's account of it, is authoritative for
/// a currently running Plan/Goal execution. An invalid artifact fails closed.
fn approved_execution_context(
    st: &AppState,
    session_id: &str,
    turn_id: Option<&str>,
) -> Result<Option<(String, String)>, ()> {
    let Some(turn_id) = turn_id else {
        return Ok(None);
    };
    let mut statement = st
        .db
        .conn()
        .prepare_cached(
            "SELECT request_id FROM plan_approvals WHERE session_id = ?1
         AND status = 'approved' AND execution_state = 'running'",
        )
        .map_err(|_| ())?;
    let mut rows = statement.query(sql_params![session_id]).map_err(|_| ())?;
    let Some(row) = rows.next().map_err(|_| ())? else {
        return Ok(None);
    };
    let proposal_id: String = row.get(0).map_err(|_| ())?;
    if rows.next().map_err(|_| ())?.is_some() {
        return Err(());
    }
    drop(rows);
    drop(statement);
    let proposal = plans::get_proposal(&st.db, &proposal_id)
        .map_err(|_| ())?
        .ok_or(())?;
    let artifact = proposal.artifact.as_ref().ok_or(())?;
    let kind = plans::normalize_kind(&proposal.kind).ok_or(())?;
    let root = resolve_tool_workspace(st, session_id)
        .map_err(|_| ())?
        .ok_or(())?;
    let root = Path::new(&root);
    plans::verify_artifact(root, kind, artifact).map_err(|_| ())?;
    let artifact_path =
        plans::safe_artifact_path(root, kind, &artifact.relative_path).map_err(|_| ())?;
    let approved_plan = std::fs::read_to_string(artifact_path).map_err(|_| ())?;
    if approved_plan != proposal.markdown
        || approved_plan.is_empty()
        || !review_evidence_safe(&approved_plan, 4_000)
    {
        return Err(());
    }
    // An active plan does not authorize an unrelated subsequent user request:
    // the originating user text must belong to the approved proposal's turn.
    let origin_id: String = st
        .db
        .conn()
        .query_row(
            "SELECT m.id FROM messages m JOIN turns t ON t.id = ?2
         WHERE m.session_id = ?1 AND m.role = 'user' AND t.session_id = ?1
           AND (m.turn_id = t.id OR (m.turn_id IS NULL AND m.created_at <= t.started_at
             AND m.created_at > COALESCE((SELECT MAX(p.started_at) FROM turns p
                 WHERE p.session_id = t.session_id AND p.started_at < t.started_at), 0)))
         ORDER BY m.seq DESC LIMIT 1",
            sql_params![session_id, proposal.turn_id],
            |row| row.get(0),
        )
        .map_err(|_| ())?;
    let session = sessions::get_session_with_options(
        &st.db,
        session_id,
        sessions::SessionReadOptions {
            message_around: Some(origin_id.clone()),
            message_limit: Some(1),
            ..Default::default()
        },
    )
    .map_err(|_| ())?
    .ok_or(())?;
    let user_request = session
        .messages
        .first()
        .filter(|message| message.id == origin_id && message.role == "user")
        .map(|message| message.content.clone())
        .ok_or(())?;
    if !running_turn(st, session_id, turn_id) {
        return Err(());
    }
    Ok(Some((user_request, approved_plan)))
}

pub(super) async fn claim(
    state: &Arc<Mutex<AppState>>,
    params: &Value,
    tx: &mpsc::UnboundedSender<String>,
) -> Result<Value, JsonRpcError> {
    let request_id = params
        .get("requestId")
        .and_then(Value::as_str)
        .ok_or_else(|| rpc_err(1002, "requestId required", "INVALID_PARAMS"))?;
    let mut st = state.lock().await;
    let configured_policy = st
        .db
        .get_setting("app")
        .map_err(|error| rpc_err(1000, error.to_string(), "INTERNAL"))?
        .and_then(|settings| {
            settings
                .get("autoReview")
                .and_then(|binding| binding.get("policyPrompt"))
                .cloned()
        });
    if configured_policy
        .as_ref()
        .is_some_and(|policy| !valid_review_policy(policy))
    {
        st.permissions
            .takeover_review(request_id)
            .map_err(|error| rpc_err(1008, error.clone(), &error))?;
        emit_notification(
            tx,
            "permissions.reviewUpdated",
            json!({
                "requestId": request_id, "reviewState": "user",
                "reason": "Review policy is invalid; human approval is required",
            }),
        )
        .await;
        return Err(rpc_err(
            1008,
            "review policy is invalid",
            "REVIEW_NOT_AVAILABLE",
        ));
    }
    let (token, request, fingerprint, turn_id, user_message_id, workspace_path) = st
        .permissions
        .claim_review(request_id)
        .map_err(|error| rpc_err(1008, error.clone(), &error))?;
    let session =
        user_message_id.as_deref().and_then(|id| {
            match sessions::get_session_with_options(
                &st.db,
                &request.session_id,
                sessions::SessionReadOptions {
                    message_around: Some(id.to_string()),
                    message_limit: Some(1),
                    ..Default::default()
                },
            ) {
                Ok(session) => session,
                Err(error) => {
                    tracing::warn!(%error, "permission review context lookup failed");
                    None
                }
            }
        });
    let ordinary_user_request = session
        .as_ref()
        .and_then(|session| session.messages.first())
        .filter(|message| {
            user_message_id.as_deref() == Some(message.id.as_str()) && message.role == "user"
        })
        .map(|message| message.content.as_str())
        .unwrap_or("");
    let approved_context = approved_execution_context(&st, &request.session_id, turn_id.as_deref());
    let (user_request, approved_plan, plan_context_complete) = match approved_context {
        Ok(Some((origin, plan))) => (origin, Some(plan), true),
        Ok(None) => (ordinary_user_request.to_string(), None, true),
        Err(()) => (String::new(), None, false),
    };
    let arg_text = serde_json::to_string(&request.args_preview).unwrap_or_default();
    let content_complete = plan_context_complete
        && approved_plan
            .as_deref()
            .is_none_or(|plan| review_evidence_safe(plan, 4_000))
        && context_complete(
            &user_request,
            &arg_text,
            turn_id
                .as_deref()
                .is_some_and(|id| running_turn(&st, &request.session_id, id))
                && workspace_path
                    .as_deref()
                    .is_some_and(|path| !path.is_empty()),
        );
    let permission_mode = &request.permission_mode;
    let workspace = workspace_path.as_deref().unwrap_or("");
    let mut action = json!({
        "userRequest": if content_complete { user_request.as_str() } else { "" },
        "toolName": request.tool_name,
        "arguments": if content_complete { request.args_preview } else { Value::Null },
        "workspace": workspace,
        "workingDirectory": workspace,
        "permissionMode": permission_mode,
        "isolation": "No OS shell or plugin capability sandbox",
        "complete": content_complete,
    });
    if let Some(policy) = configured_policy {
        action["policyPrompt"] = policy;
    }
    if content_complete {
        if let Some(approved_plan) = approved_plan.as_deref() {
            action["approvedPlan"] = json!(approved_plan);
        }
    }
    st.permissions
        .set_review_context_complete(request_id, &token, content_complete);
    Ok(json!({ "token": token, "fingerprint": fingerprint, "action": action }))
}

#[cfg(test)]
mod tests;

pub(super) async fn resolve(
    state: &Arc<Mutex<AppState>>,
    params: &Value,
    tx: &mpsc::UnboundedSender<String>,
) -> Result<Value, JsonRpcError> {
    let request_id = params
        .get("requestId")
        .and_then(Value::as_str)
        .ok_or_else(|| rpc_err(1002, "requestId required", "INVALID_PARAMS"))?;
    let token = params
        .get("token")
        .and_then(Value::as_str)
        .ok_or_else(|| rpc_err(1002, "token required", "INVALID_PARAMS"))?;
    let fingerprint = params
        .get("fingerprint")
        .and_then(Value::as_str)
        .ok_or_else(|| rpc_err(1002, "fingerprint required", "INVALID_PARAMS"))?;
    let result = params
        .get("result")
        .ok_or_else(|| rpc_err(1002, "result required", "INVALID_PARAMS"))?;
    let proposed = result.get("decision").and_then(Value::as_str);
    let risk = result.get("risk").and_then(Value::as_str);
    let authorization = result.get("authorization").and_then(Value::as_str);
    let policy = result.get("policyVersion").and_then(Value::as_str);
    let reason = result
        .get("reason")
        .and_then(Value::as_str)
        .filter(|reason| !reason.trim().is_empty() && reason.chars().count() <= 300)
        .unwrap_or("Automated review returned an invalid decision.");
    let valid = matches!(proposed, Some("allow_once" | "deny" | "needs_user"))
        && matches!(risk, Some("low" | "medium" | "high"))
        && matches!(authorization, Some("explicit" | "absent" | "uncertain"))
        && policy == Some("1")
        && result.get("reason").and_then(Value::as_str) == Some(reason);
    let candidate = if valid
        && !(proposed == Some("allow_once")
            && (risk == Some("high") || authorization != Some("explicit")))
    {
        proposed.unwrap_or("needs_user")
    } else {
        "needs_user"
    };
    let mut st = state.lock().await;
    let stored_settings = st
        .db
        .get_setting("app")
        .map_err(|error| rpc_err(1000, error.to_string(), "INTERNAL"))?;
    let configured_policy = stored_settings
        .as_ref()
        .and_then(|settings| settings.get("autoReview"))
        .and_then(|binding| binding.get("policyPrompt"));
    if configured_policy.is_some_and(|policy| !valid_review_policy(policy)) {
        st.permissions
            .takeover_review(request_id)
            .map_err(|error| rpc_err(1008, error.clone(), &error))?;
        emit_notification(
            tx,
            "permissions.reviewUpdated",
            json!({
                "requestId": request_id, "reviewState": "user",
                "reason": "Review policy is invalid; human approval is required",
            }),
        )
        .await;
        return Err(rpc_err(
            1008,
            "review policy is invalid",
            "REVIEW_NOT_AVAILABLE",
        ));
    }
    let policy_identity = configured_policy.map_or_else(
        || "default-v1".to_string(),
        |prompt| format!("custom-sha256:{}", grants::fingerprint(prompt)),
    );
    let session_id = st
        .permissions
        .review_session_id(request_id)
        .map(str::to_string);
    let turn_id = st
        .permissions
        .review_turn_id(request_id)
        .map(str::to_string);
    let still_running = turn_id.as_deref().is_some_and(|id| {
        session_id
            .as_deref()
            .is_some_and(|session| running_turn(&st, session, id))
    });
    let candidate = if still_running {
        candidate
    } else {
        "needs_user"
    };
    let details = st.permissions.review_details(request_id);
    let decision = st
        .permissions
        .resolve_review(request_id, token, fingerprint, candidate)
        .map_err(|error| rpc_err(1008, error.clone(), &error))?;
    if decision != "needs_user" {
        st.clear_pending_permission(request_id);
    }
    let safe_model = |key: &str| {
        result
            .get(key)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty() && value.chars().count() <= 200)
    };
    let usage = permission_review_history::safe_usage(result);
    if let Err(error) = audit::append(
        &st.db,
        "permission_review",
        session_id.as_deref(),
        json!({
            "requestId": request_id, "decision": decision, "risk": risk,
            "authorization": authorization, "reason": reason, "policyVersion": policy,
            "policyIdentity": policy_identity,
            "fingerprint": fingerprint, "usage": usage,
            "toolCallId": details.as_ref().map(|(request, _, _)| request.tool_call_id.as_str()),
            "toolName": details.as_ref().map(|(request, _, _)| request.tool_name.as_str()),
            "latencyMs": details.as_ref().map(|(_, latency, _)| latency),
            "actorId": details.as_ref().and_then(|(_, _, actor)| actor.as_deref()),
            "decisionSource": "auto_review",
            "reviewerProviderId": safe_model("reviewerProviderId"),
            "reviewerModelId": safe_model("reviewerModelId"),
        }),
    ) {
        tracing::warn!(%error, "permission review audit failed");
    }
    if decision == "needs_user" {
        emit_notification(
            tx,
            "permissions.reviewUpdated",
            json!({
                "requestId": request_id, "reviewState": "user", "reason": reason,
            }),
        )
        .await;
    }
    Ok(json!({ "ok": true, "decision": decision }))
}

pub(super) async fn takeover(
    state: &Arc<Mutex<AppState>>,
    params: &Value,
    tx: &mpsc::UnboundedSender<String>,
) -> Result<Value, JsonRpcError> {
    let request_id = params
        .get("requestId")
        .and_then(Value::as_str)
        .ok_or_else(|| rpc_err(1002, "requestId required", "INVALID_PARAMS"))?;
    let mut st = state.lock().await;
    st.permissions
        .takeover_review(request_id)
        .map_err(|error| rpc_err(1008, error.clone(), &error))?;
    emit_notification(
        tx,
        "permissions.reviewUpdated",
        json!({
            "requestId": request_id, "reviewState": "user", "reason": "Reviewer taken over by user",
        }),
    )
    .await;
    Ok(json!({ "ok": true }))
}
