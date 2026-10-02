use super::{json, plan_rpc_err, rpc_err, AppState, JsonRpcError, Value};
use crate::{scheduled, sessions};

#[cfg(test)]
#[path = "scheduled_project_tests.rs"]
mod project_tests;

pub(super) fn handle(st: &AppState, method: &str, params: Value) -> Result<Value, JsonRpcError> {
    handle_with_workspace_policy(
        st,
        method,
        params,
        st.workspace.get().map(|workspace| workspace.path),
        true,
    )
}

pub(super) fn handle_in_workspace(
    st: &AppState,
    method: &str,
    params: Value,
    workspace: Option<String>,
) -> Result<Value, JsonRpcError> {
    handle_with_workspace_policy(st, method, params, workspace, false)
}

fn handle_with_workspace_policy(
    st: &AppState,
    method: &str,
    params: Value,
    workspace: Option<String>,
    allow_workspace_override: bool,
) -> Result<Value, JsonRpcError> {
    match method {
        "scheduled.list" => {
            let tasks = scheduled::list_tasks(&st.db)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "tasks": tasks }))
        }
        "scheduled.create" => {
            let mut params = params;
            validate_schedule_input(&params)?;
            validate_execution_input(&params)?;
            if !allow_workspace_override {
                if let Some(object) = params.as_object_mut() {
                    object.remove("workspacePath");
                }
            }
            if params.get("schedule").is_some() && params.get("workspacePath").is_none() {
                params["workspacePath"] = json!(workspace);
            }
            let task = scheduled::create_task(&st.db, &params)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "task": task }))
        }
        "scheduled.update" => {
            let mut params = params;
            validate_schedule_input(&params)?;
            validate_execution_input(&params)?;
            if matches!(
                params.get("cadence").and_then(Value::as_str),
                Some("daily" | "weekly")
            ) && params.get("schedule").is_none()
            {
                let id = params.get("id").and_then(Value::as_str).unwrap_or("");
                let existing = scheduled::get_task(&st.db, id)
                    .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
                if existing.is_some_and(|task| task.schedule.is_some() && !task.calendar_configured)
                {
                    return Err(rpc_err(1002,
                        "Confirm a calendar time and provide schedule when changing this task to Daily or Weekly",
                        "INVALID_PARAMS"));
                }
            }
            if params.get("schedule").is_some() {
                let id = params.get("id").and_then(Value::as_str).unwrap_or("");
                let existing = scheduled::get_task(&st.db, id)
                    .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
                if allow_workspace_override && params.get("workspacePath").is_some() {
                    // The desktop form may explicitly move a task to another
                    // saved project. Conversation tools stay project-scoped.
                } else if existing
                    .as_ref()
                    .is_some_and(|task| !task.workspace_bound && task.schedule.is_none())
                {
                    params["workspacePath"] = json!(workspace);
                } else if let Some(object) = params.as_object_mut() {
                    object.remove("workspacePath");
                }
            }
            let task = scheduled::update_task(&st.db, &params)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?
                .ok_or_else(|| rpc_err(1007, "task not found", "NOT_FOUND"))?;
            Ok(json!({ "task": task }))
        }
        "scheduled.delete" => {
            let id = params
                .get("id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "id required", "INVALID_PARAMS"))?;
            let ok = scheduled::delete_task(&st.db, id)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "ok": ok }))
        }
        "scheduled.import" => {
            let tasks = params
                .get("tasks")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            let imported = scheduled::import_tasks(&st.db, &tasks)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "imported": imported }))
        }
        "scheduled.run" => {
            if params
                .get("automatic")
                .is_some_and(|value| !value.is_boolean())
            {
                return Err(rpc_err(
                    1002,
                    "automatic must be a boolean",
                    "INVALID_PARAMS",
                ));
            }
            let id = params
                .get("id")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "id required", "INVALID_PARAMS"))?;
            let task = scheduled::get_task(&st.db, id)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?
                .ok_or_else(|| rpc_err(1007, "task not found", "NOT_FOUND"))?;
            let automatic = params
                .get("automatic")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let now = crate::db::now_ms();
            if scheduled::automation::running(&st.db, id)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?
            {
                return Err(rpc_err(
                    1002,
                    "task is already running",
                    "SCHEDULE_ALREADY_RUNNING",
                ));
            }
            if automatic
                && (!task.enabled
                    || !scheduled::automation::due(&st.db, now)
                        .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?
                        .iter()
                        .any(|due| due == id))
            {
                return Err(rpc_err(1002, "task is no longer due", "SCHEDULE_NOT_DUE"));
            }
            if automatic {
                scheduled::automation::reschedule(&st.db, id, now)
                    .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            }
            // Both contract modes need a human to approve their proposal (D198),
            // so neither can run unattended.
            if sessions::is_contract_mode(&task.mode) {
                return Err(plan_rpc_err("PLAN_REQUIRES_INTERACTIVE_SESSION"));
            }
            let settings = st
                .db
                .get_setting("app")
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?
                .unwrap_or_else(|| json!({}));
            let options = sessions::SessionCreateOptions {
                title: Some(task.title.clone()),
                mode: Some("agent".into()),
                thinking_level: task.thinking_level.clone(),
                provider_id: task.provider_id.clone().or_else(|| {
                    settings
                        .get("defaultProviderId")
                        .and_then(|v| v.as_str())
                        .map(str::to_string)
                }),
                model_id: task.model_id.clone().or_else(|| {
                    settings
                        .get("defaultModelId")
                        .and_then(|v| v.as_str())
                        .map(str::to_string)
                }),
                project_path: if task.workspace_bound || task.schedule.is_some() {
                    task.workspace_path.clone()
                } else {
                    st.workspace.get().map(|w| w.path)
                },
                permission_mode: task
                    .permission_mode
                    .clone()
                    .or_else(|| automatic.then(|| "ask".into())),
            };
            let uses_task_execution_settings = task.permission_mode.is_some()
                || task.thinking_level.is_some()
                || (task.provider_id.is_some() && task.model_id.is_some());
            // A `reuse` task continues its own previous conversation, but only
            // while that conversation still exists and still belongs to the same
            // project; a deleted one, or a re-pointed task, opens a fresh one.
            let target_project = options.project_path.clone();
            let reused = if task.session_mode == "reuse" {
                scheduled::reusable_session(&st.db, id, target_project.as_deref())
                    .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?
            } else {
                None
            };
            let starting_fresh = reused.is_none();
            let session_id = match reused {
                Some(session_id) => session_id,
                None => {
                    let session = if automatic || uses_task_execution_settings {
                        sessions::create_session_with_options(&st.db, options)
                    } else {
                        sessions::create_session(
                            &st.db,
                            options.title,
                            options.mode,
                            options.provider_id,
                            options.model_id,
                            options.project_path,
                        )
                    }
                    .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
                    session.id
                }
            };
            let run_id = match scheduled::begin_run(&st.db, id, Some(&session_id)) {
                Ok(run_id) => run_id,
                Err(error) => {
                    // Only a conversation this dispatch opened is cleaned up.
                    if starting_fresh {
                        let _ = sessions::delete_session(&st.db, &session_id);
                    }
                    return Err(rpc_err(1000, error.to_string(), "INTERNAL"));
                }
            };
            let task = scheduled::get_task(&st.db, id)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?
                .unwrap_or(task);
            Ok(json!({
                "sessionId": session_id,
                "prompt": task.prompt,
                "task": task,
                "runId": run_id
            }))
        }
        "scheduled.due" => {
            let ids = scheduled::automation::due(&st.db, crate::db::now_ms())
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "ids": ids }))
        }
        "scheduled.finishRun" => {
            let run_id = params
                .get("runId")
                .and_then(|v| v.as_str())
                .ok_or_else(|| rpc_err(1002, "runId required", "INVALID_PARAMS"))?;
            let status = params
                .get("status")
                .and_then(|v| v.as_str())
                .unwrap_or("completed");
            let ok = scheduled::finish_run(
                &st.db,
                run_id,
                status,
                params.get("errorCode").and_then(|v| v.as_str()),
            )
            .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "ok": ok }))
        }
        "scheduled.listRuns" => {
            let task_id = params.get("taskId").and_then(|v| v.as_str());
            // The task column needs each task's own newest run: a global window
            // would report an idle task as "never run" once other tasks fill it.
            if params
                .get("latestPerTask")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                if task_id.is_some() {
                    return Err(rpc_err(
                        1002,
                        "latestPerTask cannot be scoped to a single task",
                        "INVALID_PARAMS",
                    ));
                }
                let runs = scheduled::latest_run_per_task(&st.db)
                    .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
                return Ok(json!({ "runs": runs }));
            }
            let limit = params.get("limit").and_then(|v| v.as_i64()).unwrap_or(50);
            let runs = scheduled::list_runs(&st.db, task_id, limit)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "runs": runs }))
        }

        _ => Err(rpc_err(1007, "unknown scheduled method", "NOT_FOUND")),
    }
}

fn validate_schedule_input(params: &Value) -> Result<(), JsonRpcError> {
    if let Some(schedule) = params.get("schedule").filter(|value| !value.is_null()) {
        let parsed: scheduled::timing::Schedule = serde_json::from_value(schedule.clone())
            .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?;
        parsed
            .validate()
            .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?;
        if params
            .get("prompt")
            .and_then(Value::as_str)
            .is_some_and(|prompt| prompt.trim().is_empty())
        {
            return Err(rpc_err(1002, "prompt required", "INVALID_PARAMS"));
        }
    }
    Ok(())
}

fn validate_execution_input(params: &Value) -> Result<(), JsonRpcError> {
    scheduled::automation::validate_execution_input(params)
        .map_err(|error| rpc_err(1002, error.to_string(), "INVALID_PARAMS"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A run's transcript reports its automation ownership, the reader the
    /// Scheduled page uses sees the same flag, search carries it through the
    /// query that builds its own column list, and deleting the task releases the
    /// transcript back into the ordinary lists (issue #1291).
    #[tokio::test]
    async fn automation_sessions_are_marked_and_released_with_their_task() {
        let dir = tempfile::tempdir().unwrap();
        let mut st = AppState::open(dir.path()).unwrap();
        st.handshook = true;
        let id = handle(
            &st,
            "scheduled.create",
            json!({"title":"Nightly","prompt":"Summarize the dependencies",
                   "cadence":"manual","schedule":null}),
        )
        .unwrap()["task"]["id"]
            .as_str()
            .unwrap()
            .to_string();
        let run = handle(&st, "scheduled.run", json!({"id":id})).unwrap();
        let run_session = run["sessionId"].as_str().unwrap().to_string();
        let ordinary = sessions::create_session(
            &st.db,
            Some("Hand written".into()),
            Some("agent".into()),
            None,
            None,
            None,
        )
        .unwrap();

        let flag = |session_id: &str| {
            sessions::list_sessions(&st.db)
                .unwrap()
                .into_iter()
                .find(|session| session.id == session_id)
                .map(|session| session.scheduled_run)
        };
        assert_eq!(
            flag(&run_session),
            Some(true),
            "a run's transcript is marked as automation output"
        );
        assert_eq!(
            flag(&ordinary.id),
            Some(false),
            "an ordinary conversation is never marked"
        );
        let detail = sessions::get_session(&st.db, &run_session)
            .unwrap()
            .expect("the run's session exists");
        assert!(detail.summary.scheduled_run);

        let page = crate::session_search::search(&st.db, "Nightly", 0).unwrap();
        let hit = page
            .hits
            .iter()
            .find(|hit| hit.session.id == run_session)
            .expect("search finds the run's transcript");
        assert!(
            hit.session.scheduled_run,
            "search reports the same ownership as the list"
        );

        // A task with a run still in flight cannot be deleted yet.
        let settled = handle(
            &st,
            "scheduled.finishRun",
            json!({"runId": run["runId"].as_str().unwrap(), "status": "completed"}),
        )
        .unwrap();
        assert_eq!(settled["ok"], json!(true));
        handle(&st, "scheduled.delete", json!({"id":id})).unwrap();
        assert_eq!(
            flag(&run_session),
            Some(false),
            "deleting the task releases its transcripts"
        );
        assert!(
            flag(&ordinary.id).is_some(),
            "the conversation itself survives the task deletion"
        );
    }

    /// A `reuse` task keeps one conversation; the default keeps one per run.
    #[tokio::test]
    async fn reuse_tasks_continue_one_conversation_and_per_run_tasks_do_not() {
        let dir = tempfile::tempdir().unwrap();
        let mut st = AppState::open(dir.path()).unwrap();
        st.handshook = true;
        let create = |mode: Option<&str>| {
            let mut params =
                json!({"title":"Nightly","prompt":"Summarize","cadence":"manual","schedule":null});
            if let Some(mode) = mode {
                params["sessionMode"] = json!(mode);
            }
            handle(&st, "scheduled.create", params).unwrap()["task"].clone()
        };
        let dispatch = |id: &str| handle(&st, "scheduled.run", json!({"id":id})).unwrap();
        let settle = |launch: &Value| {
            handle(
                &st,
                "scheduled.finishRun",
                json!({"runId":launch["runId"].as_str().unwrap(),"status":"completed"}),
            )
            .unwrap();
        };

        let per_run = create(None);
        assert_eq!(
            per_run["sessionMode"],
            json!("perRun"),
            "a task without the setting keeps the historical shape"
        );
        let per_run_id = per_run["id"].as_str().unwrap();
        let first = dispatch(per_run_id);
        settle(&first);
        let second = dispatch(per_run_id);
        settle(&second);
        assert_ne!(
            first["sessionId"], second["sessionId"],
            "a per-run task opens a conversation per run"
        );

        let reuse = create(Some("reuse"));
        assert_eq!(reuse["sessionMode"], json!("reuse"));
        let reuse_id = reuse["id"].as_str().unwrap();
        let first = dispatch(reuse_id);
        settle(&first);
        let second = dispatch(reuse_id);
        settle(&second);
        assert_eq!(
            first["sessionId"], second["sessionId"],
            "a reuse task continues the conversation its previous run used"
        );

        // Deleting that conversation starts a fresh one instead of failing.
        sessions::delete_session(&st.db, first["sessionId"].as_str().unwrap()).unwrap();
        let third = dispatch(reuse_id);
        settle(&third);
        assert_ne!(third["sessionId"], first["sessionId"]);

        let invalid = handle(
            &st,
            "scheduled.create",
            json!({"title":"Bad","prompt":"Summarize","cadence":"manual",
                   "schedule":null,"sessionMode":"sometimes"}),
        );
        assert!(invalid.is_err(), "an unknown conversation mode is refused");
    }

    #[tokio::test]
    async fn review_deleted_project_is_not_recreated_by_automatic_task() {
        use std::sync::Arc;
        use tokio::sync::{mpsc, Mutex};
        let dir = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        let mut st = AppState::open(dir.path()).unwrap();
        st.handshook = true;
        let path = st.workspace.set(project.path()).path;
        sessions::create_session(
            &st.db,
            None,
            Some("agent".into()),
            None,
            None,
            Some(path.clone()),
        )
        .unwrap();
        let task = handle(
            &st,
            "scheduled.create",
            json!({
                "title":"Review", "prompt":"Review project", "cadence":"hourly",
                "schedule":{"hour":0,"minute":0,"weekday":0}
            }),
        )
        .unwrap()["task"]
            .clone();
        let state = Arc::new(Mutex::new(st));
        let removed = super::super::handle_request(
            state.clone(),
            "projects.remove",
            json!({"path":path}),
            mpsc::unbounded_channel().0,
        )
        .await
        .unwrap();
        assert_eq!(removed["removed"], true);
        let st = state.lock().await;
        let count = || {
            st.db
                .conn()
                .query_row("SELECT COUNT(*) FROM projects", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap()
        };
        assert_eq!(count(), 0);
        st.db.conn().execute(
            "UPDATE scheduled_tasks SET config_json = json_set(config_json, '$.nextRunAt', ?1) WHERE id = ?2",
            rusqlite::params![crate::db::now_ms(), task["id"].as_str().unwrap()],
        ).unwrap();
        let launched = handle(
            &st,
            "scheduled.run",
            json!({"id":task["id"],"automatic":true}),
        );
        assert_eq!(
            count(),
            0,
            "Automatic admission resurrected the deleted project: {launched:?}"
        );
    }

    #[test]
    fn manual_task_keeps_saved_workspace_across_run_edit_and_restart() {
        for project_bound in [true, false] {
            let dir = tempfile::tempdir().unwrap();
            let project_a = tempfile::tempdir().unwrap();
            let project_b = tempfile::tempdir().unwrap();
            let saved_path = project_bound.then(|| {
                crate::db::canonical_project_path(&project_a.path().to_string_lossy()).unwrap()
            });
            let state = AppState::open(dir.path()).unwrap();
            let task = handle_in_workspace(
                &state,
                "scheduled.create",
                json!({
                    "title":"A task", "prompt":"Reply OK", "cadence":"manual", "schedule":null
                }),
                saved_path.clone(),
            )
            .unwrap()["task"]
                .clone();
            let id = task["id"].as_str().unwrap();
            drop(state);
            let mut state = AppState::open(dir.path()).unwrap();
            state.workspace.set(project_b.path());
            let run = handle(&state, "scheduled.run", json!({"id":id})).unwrap();
            let session = sessions::get_session(&state.db, run["sessionId"].as_str().unwrap())
                .unwrap()
                .unwrap();
            assert_eq!(session.summary.project_path, saved_path);
            handle(
                &state,
                "scheduled.finishRun",
                json!({"runId":run["runId"],"status":"completed"}),
            )
            .unwrap();
            let edited = handle(
                &state,
                "scheduled.update",
                json!({
                    "id":id, "title":"Renamed", "cadence":"manual", "schedule":null
                }),
            )
            .unwrap();
            assert_eq!(edited["task"]["workspacePath"], json!(saved_path));
            let recurring = handle(
                &state,
                "scheduled.update",
                json!({
                    "id":id, "cadence":"hourly", "schedule":{"hour":9,"minute":0,"weekday":0}
                }),
            )
            .unwrap();
            assert_eq!(recurring["task"]["workspacePath"], json!(saved_path));
        }
    }

    #[test]
    fn legacy_task_uses_current_workspace_until_explicitly_configured() {
        let dir = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        let mut state = AppState::open(dir.path()).unwrap();
        let task = handle(
            &state,
            "scheduled.create",
            json!({"prompt":"Reply OK","cadence":"manual"}),
        )
        .unwrap()["task"]
            .clone();
        let id = task["id"].as_str().unwrap();
        let path =
            crate::db::canonical_project_path(&state.workspace.set(project.path()).path).unwrap();
        let run = handle(&state, "scheduled.run", json!({"id":id})).unwrap();
        let session = sessions::get_session(&state.db, run["sessionId"].as_str().unwrap())
            .unwrap()
            .unwrap();
        assert_eq!(session.summary.project_path, Some(path.clone()));
        let edited = handle(&state, "scheduled.update", json!({"id":id,"schedule":null})).unwrap();
        assert_eq!(edited["task"]["workspacePath"], path);
    }

    #[test]
    fn selected_weekdays_round_trip_and_invalid_edits_preserve_saved_schedule() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::open(dir.path()).unwrap();
        let task = handle(
            &state,
            "scheduled.create",
            json!({
                "title":"Weekend review", "prompt":"Review", "cadence":"weekly",
                "schedule":{"hour":9,"minute":15,"weekday":5,"weekdays":[5,6]}
            }),
        )
        .unwrap()["task"]
            .clone();
        let id = task["id"].as_str().unwrap();
        assert_eq!(task["schedule"]["weekdays"], json!([5, 6]));
        for days in [
            json!([]),
            json!([1, 1]),
            json!([7]),
            json!([-1]),
            json!("Monday"),
        ] {
            let error = handle(
                &state,
                "scheduled.update",
                json!({
                    "id":id, "schedule":{"hour":9,"minute":15,"weekday":5,"weekdays":days}
                }),
            )
            .unwrap_err();
            assert_eq!(error.data.unwrap()["errorCode"], "INVALID_PARAMS");
        }
        drop(state);
        let state = AppState::open(dir.path()).unwrap();
        let saved = handle(&state, "scheduled.list", json!({})).unwrap();
        assert_eq!(saved["tasks"][0]["schedule"], task["schedule"]);
    }

    #[test]
    fn automatic_admission_is_durable_single_flight_and_uses_ask() {
        let dir = tempfile::tempdir().unwrap();
        let mut state = AppState::open(dir.path()).unwrap();
        let original_project = tempfile::tempdir().unwrap();
        let different_project = tempfile::tempdir().unwrap();
        let original_path =
            crate::db::canonical_project_path(&state.workspace.set(original_project.path()).path)
                .unwrap();
        let task = handle(
            &state,
            "scheduled.create",
            json!({
                "prompt":"Review project", "cadence":"hourly",
                "schedule":{"hour":9,"minute":15,"weekday":0}
            }),
        )
        .unwrap()["task"]
            .clone();
        let id = task["id"].as_str().unwrap();
        state.workspace.set(different_project.path());
        assert!(handle(&state, "scheduled.run", json!({"id":id,"automatic":true})).is_err());
        state.db.conn().execute(
            "UPDATE scheduled_tasks SET config_json = json_set(config_json, '$.nextRunAt', ?1) WHERE id = ?2",
            rusqlite::params![crate::db::now_ms(), id],
        ).unwrap();
        let run = handle(&state, "scheduled.run", json!({"id":id,"automatic":true})).unwrap();
        let session = sessions::get_session(&state.db, run["sessionId"].as_str().unwrap())
            .unwrap()
            .unwrap();
        assert_eq!(session.summary.permission_mode, "ask");
        assert_eq!(
            session.summary.project_path.as_deref(),
            Some(original_path.as_str())
        );
        assert!(handle(&state, "scheduled.run", json!({"id":id})).is_err());
        assert!(handle(&state, "scheduled.delete", json!({"id":id})).is_err());
        handle(
            &state,
            "scheduled.finishRun",
            json!({"runId":run["runId"],"status":"completed"}),
        )
        .unwrap();
        assert!(handle(&state, "scheduled.run", json!({"id":id,"automatic":true})).is_err());
        let history = handle(&state, "scheduled.listRuns", json!({"taskId":id})).unwrap();
        assert_eq!(history["runs"][0]["status"], "completed");
    }

    #[test]
    fn task_execution_settings_are_persisted_per_task_and_used_for_runs() {
        let dir = tempfile::tempdir().unwrap();
        let current_project = tempfile::tempdir().unwrap();
        let selected_project = tempfile::tempdir().unwrap();
        let mut state = AppState::open(dir.path()).unwrap();
        state.workspace.set(current_project.path());
        let selected_path =
            crate::db::canonical_project_path(&selected_project.path().to_string_lossy()).unwrap();

        let first = handle(
            &state,
            "scheduled.create",
            json!({
                "title":"Pinned task",
                "prompt":"Review",
                "cadence":"daily",
                "schedule":{"hour":9,"minute":0,"weekday":0},
                "workspacePath":selected_path,
                "permissionMode":"accept-edits",
                "providerId":"provider-pinned",
                "modelId":"model-pinned",
                "thinkingLevel":"high"
            }),
        )
        .unwrap()["task"]
            .clone();
        let second = handle(
            &state,
            "scheduled.create",
            json!({
                "title":"Separate task",
                "prompt":"Review separately",
                "cadence":"manual",
                "workspacePath":state.workspace.get().unwrap().path,
                "permissionMode":"auto",
                "providerId":"provider-other",
                "modelId":"model-other",
                "thinkingLevel":"omit"
            }),
        )
        .unwrap()["task"]
            .clone();

        assert_eq!(first["workspacePath"], selected_path);
        assert_eq!(first["permissionMode"], "accept-edits");
        assert_eq!(first["providerId"], "provider-pinned");
        assert_eq!(first["modelId"], "model-pinned");
        assert_eq!(second["permissionMode"], "auto");
        assert_eq!(second["providerId"], "provider-other");
        assert_eq!(second["modelId"], "model-other");

        state.db.conn().execute(
            "UPDATE scheduled_tasks SET config_json = json_set(config_json, '$.nextRunAt', ?1) WHERE id = ?2",
            rusqlite::params![crate::db::now_ms(), first["id"].as_str().unwrap()],
        ).unwrap();
        let run = handle(
            &state,
            "scheduled.run",
            json!({"id":first["id"],"automatic":true}),
        )
        .unwrap();
        let session = sessions::get_session(&state.db, run["sessionId"].as_str().unwrap())
            .unwrap()
            .unwrap();
        assert_eq!(
            session.summary.project_path.as_deref(),
            Some(selected_path.as_str())
        );
        assert_eq!(session.summary.permission_mode, "accept-edits");
        assert_eq!(
            session.summary.provider_id.as_deref(),
            Some("provider-pinned")
        );
        assert_eq!(session.summary.model_id.as_deref(), Some("model-pinned"));
        assert_eq!(session.summary.thinking_level, "high");
        handle(
            &state,
            "scheduled.finishRun",
            json!({"runId":run["runId"],"status":"completed"}),
        )
        .unwrap();

        let separate_run = handle(&state, "scheduled.run", json!({"id":second["id"]})).unwrap();
        let separate_session =
            sessions::get_session(&state.db, separate_run["sessionId"].as_str().unwrap())
                .unwrap()
                .unwrap();
        assert_eq!(separate_session.summary.permission_mode, "auto");
        assert_eq!(separate_session.summary.thinking_level, "omit");
        assert_eq!(
            separate_session.summary.provider_id.as_deref(),
            Some("provider-other")
        );
        assert_eq!(
            separate_session.summary.model_id.as_deref(),
            Some("model-other")
        );

        handle(
            &state,
            "scheduled.update",
            json!({"id":first["id"],"permissionMode":"ask"}),
        )
        .unwrap();
        let saved = handle(&state, "scheduled.list", json!({})).unwrap();
        let untouched = saved["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .find(|task| task["id"] == second["id"])
            .unwrap();
        assert_eq!(untouched["permissionMode"], "auto");
        assert_eq!(untouched["providerId"], "provider-other");
        assert_eq!(untouched["modelId"], "model-other");
        assert_eq!(untouched["thinkingLevel"], "omit");
        handle(
            &state,
            "scheduled.update",
            json!({"id":first["id"], "thinkingLevel":null}),
        )
        .unwrap();
        assert!(
            handle(&state, "scheduled.list", json!({})).unwrap()["tasks"]
                .as_array()
                .unwrap()
                .iter()
                .find(|task| task["id"] == first["id"])
                .unwrap()
                .get("thinkingLevel")
                .is_none()
        );
    }

    #[test]
    fn legacy_tasks_keep_their_previous_execution_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        let mut state = AppState::open(dir.path()).unwrap();
        state.workspace.set(project.path());
        state
            .db
            .set_setting(
                "app",
                &json!({
                    "defaultProviderId":"provider-default",
                    "defaultModelId":"model-default",
                    "defaultPermissionMode":"auto"
                }),
            )
            .unwrap();
        let task = scheduled::create_task(
            &state.db,
            &json!({"title":"Legacy", "prompt":"Review", "cadence":"manual"}),
        )
        .unwrap();
        let projected = handle(&state, "scheduled.list", json!({})).unwrap();
        assert!(projected["tasks"][0].get("permissionMode").is_none());
        assert!(projected["tasks"][0].get("providerId").is_none());
        assert!(projected["tasks"][0].get("modelId").is_none());

        let run = handle(&state, "scheduled.run", json!({"id":task.id})).unwrap();
        let session = sessions::get_session(&state.db, run["sessionId"].as_str().unwrap())
            .unwrap()
            .unwrap();
        assert_eq!(session.summary.permission_mode, "inherit");
        assert_eq!(session.summary.thinking_level, "off");
        assert_eq!(
            session.summary.provider_id.as_deref(),
            Some("provider-default")
        );
        assert_eq!(session.summary.model_id.as_deref(), Some("model-default"));
    }

    #[test]
    fn invalid_schedule_does_not_mutate_task() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::open(dir.path()).unwrap();
        let error = handle(
            &state,
            "scheduled.run",
            json!({"id":"absent", "automatic":"true"}),
        )
        .unwrap_err();
        assert_eq!(error.data.unwrap()["errorCode"], "INVALID_PARAMS");
        assert!(handle(
            &state,
            "scheduled.create",
            json!({
                "prompt":"Review", "schedule":{"hour":25,"minute":0,"weekday":0}
            })
        )
        .is_err());
        assert!(scheduled::list_tasks(&state.db).unwrap().is_empty());
        for invalid in [
            json!({"prompt":"Review", "thinkingLevel":"invalid"}),
            json!({
                "prompt":"Review", "cadence":"manual", "permissionMode":"unrestricted"
            }),
            json!({
                "prompt":"Review", "cadence":"manual", "providerId":"provider-only"
            }),
            json!({
                "prompt":"Review", "cadence":"manual", "providerId":"", "modelId":"model"
            }),
        ] {
            let error = handle(&state, "scheduled.create", invalid).unwrap_err();
            assert_eq!(error.data.unwrap()["errorCode"], "INVALID_PARAMS");
        }
        assert!(scheduled::list_tasks(&state.db).unwrap().is_empty());
    }

    #[test]
    fn the_task_column_asks_for_one_newest_run_per_task() {
        let dir = tempfile::tempdir().unwrap();
        let mut st = AppState::open(dir.path()).unwrap();
        st.handshook = true;
        let create = |title: &str| {
            handle(
                &st,
                "scheduled.create",
                json!({ "title": title, "prompt": "Review", "cadence": "manual", "schedule": null }),
            )
            .unwrap()["task"]["id"]
                .as_str()
                .unwrap()
                .to_string()
        };
        let idle = create("Idle");
        let busy = create("Busy");
        // The idle task ran first; afterwards the busy one produced two runs.
        for (index, task) in [(0i64, &idle), (1, &idle), (2, &busy), (3, &busy)] {
            let started = 1_000 + index * 100;
            st.db
                .conn()
                .execute(
                    &format!(
                        "INSERT INTO task_runs
                           (id, task_id, session_id, status, error_code, started_at, ended_at)
                         VALUES ('run-{index}', '{task}', NULL, 'completed', NULL, {started}, {})",
                        started + 500
                    ),
                    [],
                )
                .unwrap();
        }

        let scoped = handle(&st, "scheduled.listRuns", json!({ "latestPerTask": true })).unwrap();
        let runs = scoped["runs"].as_array().unwrap();
        assert_eq!(runs.len(), 2, "one run per task");
        assert_eq!(runs[0]["id"], "run-3");
        assert_eq!(
            runs[1]["id"], "run-1",
            "the idle task reports its own newest run"
        );

        let rejected = handle(
            &st,
            "scheduled.listRuns",
            json!({ "latestPerTask": true, "taskId": idle }),
        )
        .unwrap_err();
        assert_eq!(rejected.data.unwrap()["errorCode"], "INVALID_PARAMS");
    }
}
