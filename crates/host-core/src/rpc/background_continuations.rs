//! Main-only control plane. Never add these methods to the model proxy allowlist.
use super::*;
use crate::background_tasks::{
    continuations::{self, ContinuationState},
    jobs,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    session_id: Option<String>,
    id: Option<String>,
    turn_id: Option<String>,
}

pub(super) async fn handle(
    state: Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    let request: Request = serde_json::from_value(params)
        .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?;
    let mut st = state.lock().await;
    if method == "backgroundContinuations.cancel" {
        if request.id.is_none() && request.session_id.is_none() {
            return Err(rpc_err(1002, "id or sessionId required", "INVALID_PARAMS"));
        }
        st.background_tasks.cancel_continuations(
            request.session_id.as_deref(),
            request.turn_id.as_deref(),
            request.id.as_deref(),
        );
        return Ok(json!({"ok": true}));
    }
    if !continuations::enabled(&st).map_err(|e| rpc_err(1000, e, "INTERNAL"))? {
        st.background_tasks.cancel_continuations(None, None, None);
    }
    // Source cancellation is durable and wins even if Main missed its event.
    let mut pending: Vec<_> = st
        .background_tasks
        .continuations
        .iter()
        .filter(|(_, entry)| entry.state == ContinuationState::Pending)
        .map(|(id, entry)| (id.clone(), entry.source_turn_id.clone()))
        .collect();
    pending.sort_by_key(|(id, _)| {
        st.background_tasks
            .tasks
            .get(id)
            .map(|task| task.started_at)
    });
    let mut ready = Vec::new();
    for (id, source_turn) in pending {
        let Some(task) = st.background_tasks.tasks.get(&id).cloned() else {
            continue;
        };
        let source_status = continuations::turn_status(&st, &task.session_id, &source_turn)
            .map_err(|e| rpc_err(1000, e, "INTERNAL"))?;
        let policy = sessions::tool_policy(&st.db, &task.session_id)
            .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
        if policy != Some(sessions::ToolPolicy::Agent)
            || !continuations::agent_session(&st, &task.session_id)
                .map_err(|e| rpc_err(1000, e, "INTERNAL"))?
            || source_status
                .as_deref()
                .is_none_or(|status| status == "aborted" || status == "error")
            || *task.stop.borrow()
        {
            st.background_tasks
                .cancel_continuations(None, None, Some(&id));
            continue;
        }
        if source_status.as_deref() == Some("completed") && task.settled.borrow().is_some() {
            ready.push(json!({"id": id, "sessionId": task.session_id}));
        }
    }
    if method == "backgroundContinuations.list" {
        return Ok(json!({"tasks": ready}));
    }
    let session_id = request
        .session_id
        .as_deref()
        .ok_or_else(|| rpc_err(1002, "sessionId required", "INVALID_PARAMS"))?;
    let id = request
        .id
        .as_deref()
        .ok_or_else(|| rpc_err(1002, "id required", "INVALID_PARAMS"))?;
    let task = jobs::find(&st.background_tasks, session_id, id)
        .ok_or_else(|| rpc_err(1007, "task not found", "NOT_FOUND"))?;
    let current = st
        .background_tasks
        .continuations
        .get(id)
        .map(|entry| entry.state);
    match method {
        "backgroundContinuations.consume" => {
            if task.settled.borrow().is_some() && current == Some(ContinuationState::Pending) {
                st.background_tasks.continuations.get_mut(id).unwrap().state =
                    ContinuationState::Consumed;
                background_tasks::bump_change_counter();
            }
            Ok(json!({"ok": true}))
        }
        "backgroundContinuations.claim" => {
            let turn_id = request
                .turn_id
                .as_deref()
                .ok_or_else(|| rpc_err(1002, "turnId required", "INVALID_PARAMS"))?;
            if !ready.iter().any(|entry| entry["id"] == id)
                || current != Some(ContinuationState::Pending)
                || continuations::turn_status(&st, session_id, turn_id)
                    .map_err(|e| rpc_err(1000, e, "INTERNAL"))?
                    .as_deref()
                    != Some("running")
            {
                return Err(rpc_err(
                    1001,
                    "continuation no longer available",
                    "PERMISSION_DENIED",
                ));
            }
            // One-shot claim immediately before sidecar dispatch. Ambiguous
            // failures are never automatically retried into duplicate turns.
            st.background_tasks.continuations.get_mut(id).unwrap().state =
                ContinuationState::Started;
            background_tasks::bump_change_counter();
            Ok(jobs::snapshot(&task, true).await)
        }
        "backgroundContinuations.fail" => {
            if matches!(
                current,
                Some(ContinuationState::Pending | ContinuationState::Started)
            ) {
                st.background_tasks.continuations.get_mut(id).unwrap().state =
                    ContinuationState::Failed;
                background_tasks::bump_change_counter();
            }
            Ok(json!({"ok": true}))
        }
        _ => Err(rpc_err(-32601, "method not found", "METHOD_NOT_FOUND")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    async fn fixture(enabled: bool) -> (tempfile::TempDir, Arc<Mutex<AppState>>, String, String) {
        let dir = tempfile::tempdir().unwrap();
        let st = AppState::open(dir.path()).unwrap();
        st.db
            .set_setting("app", &json!({"backgroundJobContinuationEnabled": enabled}))
            .unwrap();
        let session =
            sessions::create_session(&st.db, Some("continuation".into()), None, None, None, None)
                .unwrap()
                .id;
        let turn = sessions::begin_turn(&st.db, &session, None, None).unwrap();
        (dir, Arc::new(Mutex::new(st)), session, turn)
    }
    async fn spawn(
        state: &Mutex<AppState>,
        dir: &Path,
        session: &str,
        turn: &str,
    ) -> Result<String, (String, String)> {
        let command = if cfg!(windows) {
            "[Console]::Out.Write('final-output'); [Console]::Error.Write('final-error'); exit 7"
        } else {
            "printf final-output; printf final-error >&2; exit 7"
        };
        background_tasks::spawn_background_task_with_continuation(
            state,
            session,
            command,
            tools::shell::default_shell_id(),
            dir,
            None,
            Some(turn),
        )
        .await
    }
    async fn settle(state: &Mutex<AppState>, session: &str, id: &str) {
        let task = jobs::find(&state.lock().await.background_tasks, session, id).unwrap();
        tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                jobs::wait(&task, 1000).await;
                if jobs::snapshot(&task, false).await["state"] != "running" {
                    break;
                }
            }
        })
        .await
        .unwrap();
    }
    async fn end(state: &Mutex<AppState>, turn: &str, reason: &str) {
        sessions::end_turn(&state.lock().await.db, turn, reason, None, None, false).unwrap();
    }
    #[tokio::test]
    async fn disabled_registration_is_rejected() {
        let (dir, state, session, turn) = fixture(false).await;
        assert_eq!(
            spawn(&state, dir.path(), &session, &turn)
                .await
                .unwrap_err()
                .0,
            "PERMISSION_DENIED"
        );
        assert!(state.lock().await.background_tasks.tasks.is_empty());
    }
    #[tokio::test]
    async fn completion_waits_for_source_turn_and_claims_original_output_once() {
        let (dir, state, session, turn) = fixture(true).await;
        let id = spawn(&state, dir.path(), &session, &turn).await.unwrap();
        settle(&state, &session, &id).await;
        assert_eq!(
            handle(state.clone(), "backgroundContinuations.list", json!({}))
                .await
                .unwrap()["tasks"],
            json!([])
        );
        end(&state, &turn, "completed").await;
        assert_eq!(
            handle(state.clone(), "backgroundContinuations.list", json!({}))
                .await
                .unwrap()["tasks"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        let next = sessions::begin_turn(&state.lock().await.db, &session, None, None).unwrap();
        let args = json!({"sessionId":session,"id":id,"turnId":next});
        let result = handle(state.clone(), "backgroundContinuations.claim", args.clone())
            .await
            .unwrap();
        assert_eq!(result["stdout"], "final-output");
        assert_eq!(result["stderr"], "final-error");
        assert_eq!(result["exitCode"], 7);
        assert!(handle(state.clone(), "backgroundContinuations.claim", args)
            .await
            .is_err());
    }
    #[tokio::test]
    async fn consumed_cancelled_disabled_and_aborted_jobs_never_resume() {
        for scenario in ["consumed", "cancelled", "disabled", "aborted"] {
            let (dir, state, session, turn) = fixture(true).await;
            let id = spawn(&state, dir.path(), &session, &turn).await.unwrap();
            settle(&state, &session, &id).await;
            if scenario == "consumed" {
                handle(
                    state.clone(),
                    "backgroundContinuations.consume",
                    json!({"sessionId":session,"id":id}),
                )
                .await
                .unwrap();
            } else if scenario == "cancelled" {
                handle(
                    state.clone(),
                    "backgroundContinuations.cancel",
                    json!({"sessionId":session,"id":id}),
                )
                .await
                .unwrap();
            } else if scenario == "disabled" {
                state
                    .lock()
                    .await
                    .db
                    .set_setting("app", &json!({"backgroundJobContinuationEnabled":false}))
                    .unwrap();
            }
            end(
                &state,
                &turn,
                if scenario == "aborted" {
                    "aborted"
                } else {
                    "completed"
                },
            )
            .await;
            assert_eq!(
                handle(state.clone(), "backgroundContinuations.list", json!({}))
                    .await
                    .unwrap()["tasks"],
                json!([]),
                "{scenario}"
            );
            // Revocation never discards the original result.
            let task = jobs::find(&state.lock().await.background_tasks, &session, &id).unwrap();
            assert_eq!(jobs::snapshot(&task, true).await["exitCode"], 7);
        }
    }
    #[tokio::test]
    async fn another_session_cannot_claim_or_consume_the_result() {
        let (dir, state, session, turn) = fixture(true).await;
        let id = spawn(&state, dir.path(), &session, &turn).await.unwrap();
        settle(&state, &session, &id).await;
        for method in [
            "backgroundContinuations.claim",
            "backgroundContinuations.consume",
        ] {
            assert!(handle(
                state.clone(),
                method,
                json!({"sessionId":"other","id":id,"turnId":turn})
            )
            .await
            .is_err());
        }
        assert_eq!(
            state.lock().await.background_tasks.continuations[&id].state,
            ContinuationState::Pending
        );
    }
}
