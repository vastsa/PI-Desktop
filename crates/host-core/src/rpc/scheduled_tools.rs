use super::{rpc_err, scheduled_rpc, AppState, JsonRpcError};
use crate::{
    scheduled, sessions,
    tools::{ToolsExecuteParams, ToolsExecuteResult},
};
use serde_json::{json, Value};

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
        if cadence == "hourly" && !args.contains_key("schedule") {
            input["schedule"] = json!({"hour":0,"minute":0,"weekday":0});
        } else if cadence == "manual" {
            input["schedule"] = Value::Null;
        }
    }
    if p.tool_name != "ScheduledTaskDelete"
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
        let path = st.workspace.set(project.path()).path;
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

    #[test]
    fn scheduled_mutations_require_approval_outside_auto_mode() {
        use crate::permissions::{PermissionDecision, PermissionManager};
        let permissions = PermissionManager::default();
        let grants = std::collections::HashMap::new();
        for tool in [
            "ScheduledTaskCreate",
            "ScheduledTaskUpdate",
            "ScheduledTaskDelete",
        ] {
            assert!(permissions
                .evaluate_auto_with_permission_mode("session", tool, "agent", "ask", &grants)
                .is_none());
            assert!(permissions
                .evaluate_auto_with_permission_mode(
                    "session",
                    tool,
                    "agent",
                    "accept-edits",
                    &grants
                )
                .is_none());
            assert!(matches!(
                permissions
                    .evaluate_auto_with_permission_mode("session", tool, "plan", "auto", &grants),
                Some(PermissionDecision::Deny)
            ));
        }
        assert!(matches!(
            permissions.evaluate_auto_with_permission_mode(
                "session",
                "ScheduledTaskList",
                "agent",
                "ask",
                &grants
            ),
            Some(PermissionDecision::AllowOnce)
        ));
    }
}
