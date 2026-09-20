use super::{json, plan_rpc_err, rpc_err, AppState, JsonRpcError, Value};
use crate::{scheduled, sessions};

pub(super) fn handle(st: &AppState, method: &str, params: Value) -> Result<Value, JsonRpcError> {
    handle_in_workspace(
        st,
        method,
        params,
        st.workspace.get().map(|workspace| workspace.path),
    )
}

pub(super) fn handle_in_workspace(
    st: &AppState,
    method: &str,
    params: Value,
    workspace: Option<String>,
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
            if params.get("schedule").is_some() {
                params["workspacePath"] = json!(workspace);
            }
            let task = scheduled::create_task(&st.db, &params)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
            Ok(json!({ "task": task }))
        }
        "scheduled.update" => {
            let mut params = params;
            validate_schedule_input(&params)?;
            if params.get("schedule").is_some() {
                let id = params.get("id").and_then(Value::as_str).unwrap_or("");
                let existing = scheduled::get_task(&st.db, id)
                    .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
                if existing
                    .as_ref()
                    .is_some_and(|task| task.schedule.is_none())
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
                provider_id: settings
                    .get("defaultProviderId")
                    .and_then(|v| v.as_str())
                    .map(str::to_string),
                model_id: settings
                    .get("defaultModelId")
                    .and_then(|v| v.as_str())
                    .map(str::to_string),
                project_path: if task.schedule.is_some() {
                    task.workspace_path.clone()
                } else {
                    st.workspace.get().map(|w| w.path)
                },
                permission_mode: automatic.then(|| "ask".into()),
                ..Default::default()
            };
            let session = if automatic {
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
            let run_id = match scheduled::begin_run(&st.db, id, Some(&session.id)) {
                Ok(run_id) => run_id,
                Err(error) => {
                    let _ = sessions::delete_session(&st.db, &session.id);
                    return Err(rpc_err(1000, error.to_string(), "INTERNAL"));
                }
            };
            let task = scheduled::get_task(&st.db, id)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?
                .unwrap_or(task);
            Ok(json!({
                "sessionId": session.id,
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

#[cfg(test)]
mod tests {
    use super::*;

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
        let original_path = state.workspace.set(original_project.path()).path;
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
    }
}
