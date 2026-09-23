use super::{rpc_err, scheduled_rpc, AppState, JsonRpcError};
use crate::{
    scheduled, sessions,
    tools::{ToolsExecuteParams, ToolsExecuteResult},
};
use serde_json::{json, Value};

#[cfg(test)]
#[path = "scheduled_calendar_tests.rs"]
mod calendar_tests;

pub fn recognizes(name: &str) -> bool {
    matches!(
        name,
        "ScheduledTaskList" | "ScheduledTaskCreate" | "ScheduledTaskUpdate" | "ScheduledTaskDelete"
    )
}

pub fn definitions() -> Vec<Value> {
    let fields = json!({
        "title":{"type":"string","minLength":1,"maxLength":80},
        "prompt":{"type":"string","minLength":1,"maxLength":64000},
        "cadence":{"type":"string","enum":["manual","hourly","daily","weekly"]},
        "enabled":{"type":"boolean"},
        "schedule":{"type":"object","additionalProperties":false,"required":["hour","minute","weekday"],"properties":{
            "hour":{"type":"integer","minimum":0,"maximum":23},
            "minute":{"type":"integer","minimum":0,"maximum":59},
            "weekday":{"type":"integer","minimum":0,"maximum":6},
            "weekdays":{"type":"array","minItems":1,"maxItems":7,"uniqueItems":true,"items":{"type":"integer","minimum":0,"maximum":6}}
        }}
    });
    ["ScheduledTaskList", "ScheduledTaskCreate", "ScheduledTaskUpdate", "ScheduledTaskDelete"].into_iter().map(|name| {
        let mut properties = if matches!(name, "ScheduledTaskCreate" | "ScheduledTaskUpdate") { fields.clone() } else { json!({}) };
        if matches!(name, "ScheduledTaskUpdate" | "ScheduledTaskDelete") { properties["id"] = json!({"type":"string"}); }
        let required = match name { "ScheduledTaskCreate" => json!(["title","prompt","cadence"]), "ScheduledTaskList" => json!([]), _ => json!(["id"]) };
        json!({"name":name,"description":"Manage scheduled tasks in the calling session's project.","risk":if name == "ScheduledTaskList" {"low"} else {"medium"},"parameters":{"type":"object","additionalProperties":false,"properties":properties,"required":required}})
    }).collect()
}

fn invalid(message: &str) -> JsonRpcError {
    rpc_err(1002, message, "INVALID_PARAMS")
}

fn execute_inner(st: &AppState, p: &ToolsExecuteParams) -> Result<Value, JsonRpcError> {
    let session = sessions::get_session(&st.db, &p.session_id)
        .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?
        .ok_or_else(|| rpc_err(1007, "session not found", "SESSION_NOT_FOUND"))?;
    if sessions::session_mode(&st.db, &p.session_id)
        .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?
        .as_deref()
        != Some("agent")
    {
        return Err(rpc_err(
            1002,
            "scheduled tools require Agent mode",
            "TOOL_DISABLED_IN_PLAN",
        ));
    }
    let workspace = session.summary.project_path;
    let args = p
        .args
        .as_object()
        .ok_or_else(|| invalid("arguments must be an object"))?;
    let allowed: &[&str] = match p.tool_name.as_str() {
        "ScheduledTaskList" => &[],
        "ScheduledTaskCreate" => &["title", "prompt", "cadence", "schedule", "enabled"],
        "ScheduledTaskUpdate" => &["id", "title", "prompt", "cadence", "schedule", "enabled"],
        "ScheduledTaskDelete" => &["id"],
        _ => return Err(invalid("unknown scheduled tool")),
    };
    if args.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(invalid("unsupported scheduled task field"));
    }
    if p.tool_name == "ScheduledTaskList" {
        let tasks =
            scheduled::list_tasks(&st.db).map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
        return Ok(
            json!({"tasks": tasks.into_iter().filter(|task| task.workspace_path == workspace).collect::<Vec<_>>() }),
        );
    }
    let existing = if p.tool_name != "ScheduledTaskCreate" {
        let id = args
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid("id required"))?;
        Some(
            scheduled::get_task(&st.db, id)
                .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?
                .filter(|task| task.workspace_path == workspace)
                .ok_or_else(|| rpc_err(1007, "task not found in this project", "NOT_FOUND"))?,
        )
    } else {
        None
    };
    for (key, limit) in [("title", 80), ("prompt", 64000)] {
        if let Some(value) = args.get(key) {
            let value = value
                .as_str()
                .ok_or_else(|| invalid("title and prompt must be strings"))?;
            if value.trim().is_empty() || value.chars().count() > limit {
                return Err(invalid("invalid title or prompt length"));
            }
        } else if p.tool_name == "ScheduledTaskCreate" {
            return Err(invalid("title and prompt required"));
        }
    }
    if args.get("enabled").is_some_and(|value| !value.is_boolean()) {
        return Err(invalid("enabled must be a boolean"));
    }
    let cadence = match args.get("cadence") {
        Some(value) => value
            .as_str()
            .filter(|v| matches!(*v, "manual" | "hourly" | "daily" | "weekly"))
            .ok_or_else(|| invalid("invalid cadence"))?,
        None => existing
            .as_ref()
            .map(|task| task.cadence.as_str())
            .unwrap_or("manual"),
    };
    let mut input = p.args.clone();
    if let Some(schedule) = args.get("schedule") {
        let parsed: scheduled::timing::Schedule =
            serde_json::from_value(schedule.clone()).map_err(|e| invalid(&e.to_string()))?;
        parsed.validate().map_err(|e| invalid(&e.to_string()))?;
    }
    if p.tool_name == "ScheduledTaskCreate" {
        if !args.contains_key("cadence") {
            return Err(invalid("cadence required"));
        }
        if cadence == "manual" {
            input["schedule"] = Value::Null;
        }
    }
    // An echoed cadence during legacy maintenance is not an arming request.
    if args.get("cadence").and_then(Value::as_str) == Some("hourly")
        && (p.tool_name == "ScheduledTaskCreate"
            || existing
                .as_ref()
                .is_some_and(|task| task.cadence != "hourly")
            || args.get("enabled").and_then(Value::as_bool) == Some(true))
        && !args.contains_key("schedule")
        && existing
            .as_ref()
            .and_then(|task| task.schedule.as_ref())
            .is_none()
    {
        input["schedule"] = json!({"hour":0,"minute":0,"weekday":0});
    }
    if p.tool_name != "ScheduledTaskDelete"
        && (p.tool_name == "ScheduledTaskCreate"
            || (args.contains_key("cadence")
                && existing
                    .as_ref()
                    .is_some_and(|task| task.cadence != cadence))
            || args.contains_key("schedule")
            || args.get("enabled").and_then(Value::as_bool) == Some(true))
        && cadence != "manual"
        && input.get("schedule").is_none()
        && existing
            .as_ref()
            .and_then(|task| task.schedule.as_ref())
            .is_none()
    {
        return Err(invalid("a schedule is required for automatic execution"));
    }
    let method = match p.tool_name.as_str() {
        "ScheduledTaskCreate" => "scheduled.create",
        "ScheduledTaskUpdate" => "scheduled.update",
        _ => "scheduled.delete",
    };
    scheduled_rpc::handle_in_workspace(st, method, input, workspace)
}

pub fn execute(st: &AppState, p: &ToolsExecuteParams) -> ToolsExecuteResult {
    let started = std::time::Instant::now();
    let result = execute_inner(st, p);
    let (ok, content, error_code) = match result {
        Ok(content) => (true, content, None),
        Err(error) => {
            let code = error
                .data
                .as_ref()
                .and_then(|data| data["errorCode"].as_str())
                .unwrap_or("INTERNAL")
                .to_string();
            (
                false,
                json!({"error":error.message,"code":code}),
                Some(code),
            )
        }
    };
    ToolsExecuteResult {
        tool_call_id: p.tool_call_id.clone(),
        ok,
        is_error: (!ok).then_some(true),
        content,
        duration_ms: started.elapsed().as_millis() as u64,
        denied: None,
        error_code,
        command_shell_id: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use tokio::sync::{mpsc, Mutex};

    #[cfg(windows)]
    #[tokio::test]
    async fn review_ui_task_is_visible_to_same_project_conversation() {
        let dir = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        let mut st = AppState::open(dir.path()).unwrap();
        st.handshook = true;
        st.db
            .set_setting("app", &json!({"defaultPermissionMode":"auto"}))
            .unwrap();
        let path = st.workspace.set(project.path()).path;
        let task = scheduled_rpc::handle(
            &st,
            "scheduled.create",
            json!({
                "title":"UI task", "prompt":"Review", "cadence":"hourly",
                "schedule":{"hour":0,"minute":0,"weekday":0}
            }),
        )
        .unwrap()["task"]
            .clone();
        let session =
            sessions::create_session(&st.db, None, Some("agent".into()), None, None, Some(path))
                .unwrap();
        let state = Arc::new(Mutex::new(st));
        let listed = call(&state, &session.id, "ScheduledTaskList", json!({})).await;
        assert_eq!(listed["ok"], true, "{listed}");
        let edited = call(
            &state,
            &session.id,
            "ScheduledTaskUpdate",
            json!({"id":task["id"],"title":"Renamed"}),
        )
        .await;
        assert!(listed["content"]["tasks"].as_array().unwrap().iter().any(|item| item["id"] == task["id"]),
            "UI-created task must be visible in the same project: task={task}, list={listed}, update={edited}");
        assert_eq!(edited["ok"], true, "{edited}");
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn stored_windows_aliases_remain_visible_after_restart_and_isolated() {
        let dir = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let st = AppState::open(dir.path()).unwrap();
        let path = crate::workspace::simple_canonicalize(project.path())
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let same = sessions::create_session(
            &st.db,
            None,
            Some("agent".into()),
            None,
            None,
            Some(path.clone()),
        )
        .unwrap()
        .id;
        let foreign = sessions::create_session(
            &st.db,
            None,
            Some("agent".into()),
            None,
            None,
            Some(other.path().to_string_lossy().into_owned()),
        )
        .unwrap()
        .id;
        for (i, alias) in [
            path.clone(),
            path.replace('\\', "/"),
            path.to_lowercase(),
            format!("{path}\\"),
            format!("\\\\?\\{path}"),
        ]
        .iter()
        .enumerate()
        {
            assert_eq!(
                std::fs::canonicalize(alias).unwrap(),
                std::fs::canonicalize(&path).unwrap()
            );
            scheduled::import_tasks(&st.db,&[json!({"id":format!("alias-{i}"),"title":"Legacy","prompt":"Review","cadence":"manual","configJson":{"workspacePath":alias}})]).unwrap();
        }
        drop(st);
        let mut st = AppState::open(dir.path()).unwrap();
        st.handshook = true;
        st.db
            .set_setting("app", &json!({"defaultPermissionMode":"auto"}))
            .unwrap();
        let state = Arc::new(Mutex::new(st));
        let own = call(&state, &same, "ScheduledTaskList", json!({})).await;
        assert_eq!(own["content"]["tasks"].as_array().unwrap().len(), 5);
        assert!(
            call(&state, &foreign, "ScheduledTaskList", json!({})).await["content"]["tasks"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            call(
                &state,
                &foreign,
                "ScheduledTaskUpdate",
                json!({"id":"alias-0","title":"Wrong"})
            )
            .await["errorCode"],
            "NOT_FOUND"
        );
        assert_eq!(
            call(
                &state,
                &foreign,
                "ScheduledTaskDelete",
                json!({"id":"alias-0"})
            )
            .await["errorCode"],
            "NOT_FOUND"
        );
        assert_eq!(
            call(
                &state,
                &same,
                "ScheduledTaskDelete",
                json!({"id":"alias-0"})
            )
            .await["ok"],
            true
        );
    }

    async fn call(state: &Arc<Mutex<AppState>>, session: &str, name: &str, args: Value) -> Value {
        super::super::handle_request(
            state.clone(),
            "tools.execute",
            json!({
                "sessionId":session,"toolCallId":uuid::Uuid::new_v4().to_string(),
                "toolName":name,"args":args,"mode":"agent"
            }),
            mpsc::unbounded_channel().0,
        )
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn scheduled_tools_crud_preserves_exact_time_and_session_project() {
        let dir = tempfile::tempdir().unwrap();
        let project = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let mut st = AppState::open(dir.path()).unwrap();
        st.handshook = true;
        st.db
            .set_setting("app", &json!({"defaultPermissionMode":"auto"}))
            .unwrap();
        let path =
            crate::db::canonical_project_path(&st.workspace.set(project.path()).path).unwrap();
        let session = sessions::create_session(
            &st.db,
            None,
            Some("agent".into()),
            None,
            None,
            Some(path.clone()),
        )
        .unwrap();
        let other_path = st.workspace.set(other.path()).path;
        let other_session = sessions::create_session(
            &st.db,
            None,
            Some("agent".into()),
            None,
            None,
            Some(other_path),
        )
        .unwrap();
        let plan = sessions::create_session(
            &st.db,
            None,
            Some("plan".into()),
            None,
            None,
            Some(path.clone()),
        )
        .unwrap();
        let state = Arc::new(Mutex::new(st));
        let created = call(
            &state,
            &session.id,
            "ScheduledTaskCreate",
            json!({
                "title":"Review", "prompt":"Review project", "cadence":"daily", "enabled":false,
                "schedule":{"hour":14,"minute":0,"weekday":0}
            }),
        )
        .await;
        assert_eq!(created["ok"], true, "{created}");
        assert_eq!(created["content"]["task"]["enabled"], false);
        let id = created["content"]["task"]["id"].as_str().unwrap();
        assert_eq!(created["content"]["task"]["workspacePath"], path);
        let listed = call(&state, &session.id, "ScheduledTaskList", json!({})).await;
        assert_eq!(listed["content"]["tasks"][0]["id"], id);
        let hidden = call(&state, &other_session.id, "ScheduledTaskList", json!({})).await;
        assert_eq!(hidden["content"]["tasks"], json!([]));
        let forbidden = call(
            &state,
            &other_session.id,
            "ScheduledTaskUpdate",
            json!({"id":id,"title":"Wrong project"}),
        )
        .await;
        assert_eq!(forbidden["errorCode"], "NOT_FOUND");
        let denied = call(&state, &plan.id, "ScheduledTaskDelete", json!({"id":id})).await;
        assert_eq!(denied["errorCode"], "TOOL_DISABLED_IN_PLAN");
        let update = call(
            &state,
            &session.id,
            "ScheduledTaskUpdate",
            json!({"id":id,"schedule":{"hour":15,"minute":30,"weekday":0},"enabled":false}),
        )
        .await;
        assert_eq!(update["ok"], true, "{update}");
        assert_eq!(update["content"]["task"]["schedule"]["minute"], 30);
        assert_eq!(update["content"]["task"]["enabled"], false);
        let invalid = call(
            &state,
            &session.id,
            "ScheduledTaskUpdate",
            json!({"id":id,"schedule":{"hour":25,"minute":0,"weekday":0}}),
        )
        .await;
        assert_eq!(invalid["errorCode"], "INVALID_PARAMS");
        let injected = call(
            &state,
            &session.id,
            "ScheduledTaskUpdate",
            json!({"id":id,"workspacePath":"elsewhere"}),
        )
        .await;
        assert_eq!(injected["errorCode"], "INVALID_PARAMS");
        let title = call(
            &state,
            &session.id,
            "ScheduledTaskUpdate",
            json!({"id":id,"title":"Updated"}),
        )
        .await;
        assert_eq!(title["content"]["task"]["schedule"]["hour"], 15);
        assert_eq!(title["content"]["task"]["schedule"]["minute"], 30);
        let deleted = call(&state, &session.id, "ScheduledTaskDelete", json!({"id":id})).await;
        assert_eq!(deleted["ok"], true, "{deleted}");
        assert_eq!(
            call(&state, &session.id, "ScheduledTaskList", json!({})).await["content"]["tasks"],
            json!([])
        );
    }

    #[tokio::test]
    async fn manual_to_hourly_update_needs_no_calendar_schedule() {
        let dir = tempfile::tempdir().unwrap();
        let mut st = AppState::open(dir.path()).unwrap();
        st.handshook = true;
        st.db
            .set_setting("app", &json!({"defaultPermissionMode":"auto"}))
            .unwrap();
        let session =
            sessions::create_session(&st.db, None, Some("agent".into()), None, None, None).unwrap();
        let state = Arc::new(Mutex::new(st));
        let created = call(
            &state,
            &session.id,
            "ScheduledTaskCreate",
            json!({
                "title":"Review", "prompt":"Review project", "cadence":"manual", "enabled":false
            }),
        )
        .await;
        assert_eq!(created["ok"], true, "{created}");
        let id = created["content"]["task"]["id"].as_str().unwrap();
        for cadence in ["daily", "weekly"] {
            let rejected = call(
                &state,
                &session.id,
                "ScheduledTaskUpdate",
                json!({"id":id,"cadence":cadence}),
            )
            .await;
            assert_eq!(rejected["errorCode"], "INVALID_PARAMS");
        }
        let before = crate::db::now_ms();
        let updated = call(
            &state,
            &session.id,
            "ScheduledTaskUpdate",
            json!({"id":id,"cadence":"hourly"}),
        )
        .await;
        let after = crate::db::now_ms();
        assert_eq!(updated["ok"], true, "{updated}");
        let task = &updated["content"]["task"];
        assert_eq!(task["cadence"], "hourly");
        assert_eq!(task["enabled"], false);
        assert_eq!(task["prompt"], "Review project");
        let next = crate::db::ts_to_ms(task["nextRunAt"].as_str().unwrap());
        assert!((before + 3_600_000..=after + 3_600_000).contains(&next));
        let renamed = call(
            &state,
            &session.id,
            "ScheduledTaskUpdate",
            json!({"id":id,"title":"Renamed"}),
        )
        .await;
        assert_eq!(renamed["content"]["task"]["nextRunAt"], task["nextRunAt"]);
        let custom = json!({"hour":15,"minute":30,"weekday":2,"weekdays":[2,4]});
        let configured = call(
            &state,
            &session.id,
            "ScheduledTaskUpdate",
            json!({"id":id,"cadence":"weekly","schedule":custom}),
        )
        .await;
        assert_eq!(configured["ok"], true, "{configured}");
        let hourly = call(
            &state,
            &session.id,
            "ScheduledTaskUpdate",
            json!({"id":id,"cadence":"hourly"}),
        )
        .await;
        assert_eq!(hourly["content"]["task"]["schedule"], custom);
    }

    #[test]
    fn scheduled_mutations_require_approval_outside_auto_mode() {
        use crate::permissions::{PermissionDecision, PermissionManager};
        let permissions = PermissionManager::default();
        for tool in [
            "ScheduledTaskCreate",
            "ScheduledTaskUpdate",
            "ScheduledTaskDelete",
        ] {
            assert!(permissions
                .evaluate_auto_with_permission_mode("session", tool, "agent", "ask")
                .is_none());
            assert!(permissions
                .evaluate_auto_with_permission_mode("session", tool, "agent", "accept-edits")
                .is_none());
            assert!(matches!(
                permissions.evaluate_auto_with_permission_mode("session", tool, "plan", "auto"),
                Some(PermissionDecision::Deny)
            ));
        }
        assert!(matches!(
            permissions.evaluate_auto_with_permission_mode(
                "session",
                "ScheduledTaskList",
                "agent",
                "ask"
            ),
            Some(PermissionDecision::AllowOnce)
        ));
    }

    #[tokio::test]
    async fn review_legacy_task_can_be_paused_without_arming_it() {
        let dir = tempfile::tempdir().unwrap();
        let mut st = AppState::open(dir.path()).unwrap();
        st.handshook = true;
        st.db
            .set_setting("app", &json!({"defaultPermissionMode":"auto"}))
            .unwrap();
        scheduled::import_tasks(
            &st.db,
            &[json!({"id":"legacy", "prompt":"Review", "cadence":"daily"})],
        )
        .unwrap();
        let session =
            sessions::create_session(&st.db, None, Some("agent".into()), None, None, None).unwrap();
        let state = Arc::new(Mutex::new(st));
        let listed = call(&state, &session.id, "ScheduledTaskList", json!({})).await;
        assert_eq!(listed["content"]["tasks"][0]["id"], "legacy");
        let paused = call(
            &state,
            &session.id,
            "ScheduledTaskUpdate",
            json!({"id":"legacy","enabled":false}),
        )
        .await;
        assert_eq!(
            paused["ok"], true,
            "Pausing must not require an automatic schedule: {paused}"
        );
        assert_eq!(paused["content"]["task"]["enabled"], false);
        assert!(paused["content"]["task"].get("nextRunAt").is_none());
    }

    #[tokio::test]
    async fn legacy_maintenance_preserves_data_but_does_not_silently_enable() {
        for cadence in ["hourly", "daily", "weekly"] {
            for enabled in [false, true] {
                let dir = tempfile::tempdir().unwrap();
                let mut st = AppState::open(dir.path()).unwrap();
                st.handshook = true;
                st.db
                    .set_setting("app", &json!({"defaultPermissionMode":"auto"}))
                    .unwrap();
                scheduled::import_tasks(&st.db,&[json!({"id":"old","title":"Old","prompt":"Review","cadence":cadence,"enabled":enabled})]).unwrap();
                let sid =
                    sessions::create_session(&st.db, None, Some("agent".into()), None, None, None)
                        .unwrap()
                        .id;
                let state = Arc::new(Mutex::new(st));
                for args in [
                    json!({"id":"old","title":"Renamed"}),
                    json!({"id":"old","prompt":"Updated"}),
                    json!({"id":"old","enabled":false}),
                    json!({"id":"old","cadence":cadence,"enabled":false}),
                ] {
                    let result = call(&state, &sid, "ScheduledTaskUpdate", args).await;
                    assert_eq!(result["ok"], true, "{result}");
                    assert!(result["content"]["task"].get("schedule").is_none());
                    assert!(result["content"]["task"].get("nextRunAt").is_none());
                }
                let refused = call(
                    &state,
                    &sid,
                    "ScheduledTaskUpdate",
                    json!({"id":"old","enabled":true}),
                )
                .await;
                assert_eq!(refused["errorCode"], "INVALID_PARAMS");
                drop(state);
                let mut st = AppState::open(dir.path()).unwrap();
                st.handshook = true;
                let saved = scheduled::get_task(&st.db, "old").unwrap().unwrap();
                assert_eq!(saved.title, "Renamed");
                assert_eq!(saved.prompt, "Updated");
                assert!(!saved.enabled);
                assert!(saved.schedule.is_none());
                assert!(!saved.workspace_bound);
                let state = Arc::new(Mutex::new(st));
                let configured=call(&state,&sid,"ScheduledTaskUpdate",json!({"id":"old","cadence":cadence,"schedule":{"hour":9,"minute":30,"weekday":0},"enabled":true})).await;
                assert_eq!(configured["ok"], true, "{configured}");
                assert_eq!(
                    call(&state, &sid, "ScheduledTaskDelete", json!({"id":"old"})).await["ok"],
                    true
                );
            }
        }
    }
}
