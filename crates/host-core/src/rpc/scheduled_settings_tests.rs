use super::*;
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};

type State = Arc<Mutex<AppState>>;

fn open_state(path: &std::path::Path) -> State {
    let mut st = AppState::open(path).unwrap();
    st.handshook = true;
    Arc::new(Mutex::new(st))
}

async fn request(state: &State, method: &str, params: Value) -> Result<Value, JsonRpcError> {
    super::super::handle_request(state.clone(), method, params, mpsc::unbounded_channel().0).await
}

async fn call(state: &State, method: &str, params: Value) -> Value {
    request(state, method, params).await.unwrap()
}

async fn set_enabled(state: &State, enabled: bool) {
    assert_eq!(
        call(
            state,
            "settings.set",
            json!({"scheduledTasksEnabled":enabled}),
        )
        .await["ok"],
        true
    );
}

fn scheduled_names(definitions: &Value) -> Vec<&str> {
    definitions["tools"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|tool| tool["name"].as_str())
        .filter(|name| name.starts_with("ScheduledTask"))
        .collect()
}

fn assert_disabled(error: JsonRpcError) {
    assert_eq!(error.code, 1002);
    assert_eq!(error.data.unwrap()["errorCode"], "INVALID_PARAMS");
    assert_eq!(error.message, "scheduled tasks are disabled");
}

async fn tool(state: &State, session: &str, name: &str, args: Value) -> Value {
    call(
        state,
        "tools.execute",
        json!({"sessionId":session,"toolCallId":name,"toolName":name,"args":args,"mode":"agent"}),
    )
    .await
}

#[tokio::test]
async fn scheduled_settings_defaults_to_enabled_unless_explicitly_false() {
    let dir = tempfile::tempdir().unwrap();
    let state = open_state(dir.path());
    // Legacy/malformed persisted values must not opt a user out; writes through
    // settings.set are validated separately.
    for settings in [
        None,
        Some(json!({"theme":"dark"})),
        Some(json!({"scheduledTasksEnabled":true})),
        Some(json!({"scheduledTasksEnabled":null})),
        Some(json!({"scheduledTasksEnabled":"false"})),
        Some(json!({"scheduledTasksEnabled":0})),
    ] {
        if let Some(settings) = settings {
            state.lock().await.db.set_setting("app", &settings).unwrap();
        }
        let definitions = call(&state, "tools.list", json!({})).await;
        assert_eq!(scheduled_names(&definitions).len(), 4);
        assert!(call(
            &state,
            "scheduled.create",
            json!({"prompt":"Review","cadence":"manual","schedule":null}),
        )
        .await["task"]["id"]
            .is_string());
    }
}

#[tokio::test]
async fn scheduled_settings_set_rejects_non_boolean_without_changing_settings() {
    let dir = tempfile::tempdir().unwrap();
    let state = open_state(dir.path());
    set_enabled(&state, false).await;
    let before = call(&state, "settings.get", json!({})).await;
    for invalid in [
        Value::Null,
        json!(0),
        json!(1),
        json!("false"),
        json!([]),
        json!({}),
    ] {
        let rejected = request(
            &state,
            "settings.set",
            json!({"scheduledTasksEnabled":invalid,"theme":"light"}),
        )
        .await
        .unwrap_err();
        assert_eq!(rejected.code, 1002);
        assert_eq!(rejected.data.unwrap()["errorCode"], "INVALID_PARAMS");
        assert_eq!(call(&state, "settings.get", json!({})).await, before);
    }
}

#[tokio::test]
async fn scheduled_settings_false_survives_restart_and_true_restores_the_saved_task() {
    let dir = tempfile::tempdir().unwrap();
    let state = open_state(dir.path());
    let task = call(
        &state,
        "scheduled.create",
        json!({"title":"Keep","prompt":"Review","cadence":"manual","schedule":null}),
    )
    .await["task"]
        .clone();
    call(
        &state,
        "scheduled.create",
        json!({"prompt":"Paused","cadence":"manual","schedule":null,"enabled":false}),
    )
    .await;
    let before = call(&state, "scheduled.list", json!({})).await;
    set_enabled(&state, false).await;
    call(&state, "settings.set", json!({"theme":"light"})).await;
    drop(state);

    let state = open_state(dir.path());
    assert_eq!(
        call(&state, "settings.get", json!({})).await["scheduledTasksEnabled"],
        false
    );
    assert_eq!(call(&state, "scheduled.list", json!({})).await, before);
    assert!(scheduled_names(&call(&state, "tools.list", json!({})).await).is_empty());
    assert_disabled(
        request(&state, "scheduled.run", json!({"id":task["id"]}))
            .await
            .unwrap_err(),
    );
    set_enabled(&state, true).await;
    assert_eq!(
        scheduled_names(&call(&state, "tools.list", json!({})).await).len(),
        4
    );
    let run = call(&state, "scheduled.run", json!({"id":task["id"]})).await;
    assert_eq!(run["task"]["id"], task["id"]);
    assert_eq!(run["task"]["enabled"], true);
    assert!(call(&state, "scheduled.list", json!({})).await["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .any(|task| task["prompt"] == "Paused" && task["enabled"] == false));
}

#[tokio::test]
async fn scheduled_settings_disabled_due_manual_auto_and_crud_do_not_mutate() {
    let dir = tempfile::tempdir().unwrap();
    let state = open_state(dir.path());
    let mut tasks = Vec::new();
    for (title, enabled, age) in [
        ("Due", true, 1_000),
        ("Missed", true, 120_000),
        ("Paused", false, 1_000),
    ] {
        let task = call(
            &state,
            "scheduled.create",
            json!({"title":title,"prompt":"Review","cadence":"hourly","enabled":enabled,
                   "schedule":{"hour":0,"minute":0,"weekday":0}}),
        )
        .await["task"]
            .clone();
        state.lock().await.db.conn().execute(
            "UPDATE scheduled_tasks SET config_json = json_set(config_json, '$.nextRunAt', ?1) WHERE id = ?2",
            rusqlite::params![crate::db::now_ms() - age, task["id"].as_str().unwrap()],
        ).unwrap();
        tasks.push(task);
    }
    let before = call(&state, "scheduled.list", json!({})).await;
    let sessions_before = call(&state, "session.list", json!({})).await;
    let runs_before = call(&state, "scheduled.listRuns", json!({})).await;
    set_enabled(&state, false).await;
    assert_eq!(call(&state, "scheduled.list", json!({})).await, before);
    assert_eq!(
        call(&state, "scheduled.due", json!({})).await,
        json!({"ids":[]})
    );
    for task in &tasks {
        for automatic in [false, true] {
            assert_disabled(
                request(
                    &state,
                    "scheduled.run",
                    json!({"id":task["id"],"automatic":automatic}),
                )
                .await
                .unwrap_err(),
            );
        }
    }
    for (method, params) in [
        (
            "scheduled.create",
            json!({"prompt":"New","cadence":"manual"}),
        ),
        (
            "scheduled.update",
            json!({"id":tasks[0]["id"],"enabled":false}),
        ),
        ("scheduled.delete", json!({"id":tasks[0]["id"]})),
    ] {
        assert_disabled(request(&state, method, params).await.unwrap_err());
    }
    assert_eq!(call(&state, "scheduled.list", json!({})).await, before);
    assert_eq!(
        call(&state, "session.list", json!({})).await,
        sessions_before
    );
    assert_eq!(
        call(&state, "scheduled.listRuns", json!({})).await,
        runs_before
    );
    assert_eq!(
        call(&state, "scheduled.listRuns", json!({"latestPerTask":true})).await,
        runs_before
    );

    set_enabled(&state, true).await;
    let run = call(
        &state,
        "scheduled.run",
        json!({"id":tasks[0]["id"],"automatic":true}),
    )
    .await;
    assert!(run["sessionId"].is_string());
    assert_ne!(
        run["task"]["nextRunAt"],
        before["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .find(|task| task["id"] == tasks[0]["id"])
            .unwrap()["nextRunAt"]
    );
    assert_eq!(run["task"]["enabled"], true);
}

#[tokio::test]
async fn scheduled_settings_tools_hide_and_reject_stale_calls_including_list() {
    let dir = tempfile::tempdir().unwrap();
    let state = open_state(dir.path());
    call(
        &state,
        "settings.set",
        json!({"defaultPermissionMode":"auto"}),
    )
    .await;
    let session = {
        let st = state.lock().await;
        sessions::create_session(&st.db, None, Some("agent".into()), None, None, None)
            .unwrap()
            .id
    };
    let definitions_before = call(&state, "tools.list", json!({})).await;
    let created = tool(
        &state,
        &session,
        "ScheduledTaskCreate",
        json!({"title":"Keep","prompt":"Review","cadence":"manual"}),
    )
    .await;
    assert_eq!(created["ok"], true, "{created}");
    let id = &created["content"]["task"]["id"];
    assert_eq!(
        tool(&state, &session, "ScheduledTaskList", json!({})).await["ok"],
        true
    );
    let before = call(&state, "scheduled.list", json!({})).await;
    set_enabled(&state, false).await;
    let definitions = call(&state, "tools.list", json!({})).await;
    assert!(scheduled_names(&definitions).is_empty());
    let expected: Vec<_> = definitions_before["tools"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|item| !item["name"].as_str().unwrap().starts_with("ScheduledTask"))
        .cloned()
        .collect();
    assert_eq!(definitions["tools"], json!(expected));
    for (name, args) in [
        ("ScheduledTaskList", json!({})),
        (
            "ScheduledTaskCreate",
            json!({"title":"New","prompt":"Review","cadence":"manual"}),
        ),
        ("ScheduledTaskUpdate", json!({"id":id,"title":"Changed"})),
        ("ScheduledTaskDelete", json!({"id":id})),
    ] {
        let rejected = tool(&state, &session, name, args).await;
        assert_eq!(rejected["ok"], false, "{rejected}");
        assert_eq!(rejected["isError"], true);
        assert_eq!(rejected["errorCode"], "INVALID_PARAMS");
        assert_eq!(rejected["content"]["error"], "scheduled tasks are disabled");
    }
    // The adapter's guard precedes session lookup and argument validation, not
    // only the mutation RPCs (List bypasses those RPCs).
    let params = serde_json::from_value(json!({"sessionId":"missing","toolCallId":"stale","toolName":"ScheduledTaskList","args":null,"mode":"agent"})).unwrap();
    let rejected = {
        let st = state.lock().await;
        super::super::scheduled_tools::execute(&st, &params)
    };
    assert_eq!(rejected.error_code.as_deref(), Some("INVALID_PARAMS"));
    assert_eq!(call(&state, "scheduled.list", json!({})).await, before);
    set_enabled(&state, true).await;
    assert_eq!(
        tool(&state, &session, "ScheduledTaskList", json!({})).await["content"],
        before
    );
    assert_eq!(
        tool(&state, &session, "ScheduledTaskDelete", json!({"id":id})).await["ok"],
        true
    );
}

#[tokio::test]
async fn scheduled_settings_disabled_keeps_import_history_and_in_flight_completion_available() {
    let dir = tempfile::tempdir().unwrap();
    let state = open_state(dir.path());
    let task = call(
        &state,
        "scheduled.create",
        json!({"prompt":"Review","cadence":"manual","schedule":null}),
    )
    .await["task"]
        .clone();
    let run = call(&state, "scheduled.run", json!({"id":task["id"]})).await;
    let task_before = call(&state, "scheduled.list", json!({})).await;
    set_enabled(&state, false).await;
    assert_eq!(
        call(
            &state,
            "scheduled.finishRun",
            json!({"runId":run["runId"],"status":"completed"})
        )
        .await["ok"],
        true
    );
    let history = call(&state, "scheduled.listRuns", json!({"taskId":task["id"]})).await;
    assert_eq!(history["runs"][0]["status"], "completed");
    assert_eq!(history["runs"][0]["sessionId"], run["sessionId"]);
    assert_eq!(call(&state, "scheduled.list", json!({})).await, task_before);
    assert_eq!(call(&state, "scheduled.import", json!({"tasks":[{"id":"legacy","prompt":"Keep imported","cadence":"manual","enabled":false}]})).await["imported"], 1);
    assert_eq!(
        call(&state, "scheduled.list", json!({})).await["tasks"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_disabled(
        request(&state, "scheduled.run", json!({"id":"legacy"}))
            .await
            .unwrap_err(),
    );
    drop(state);
    let state = open_state(dir.path());
    assert_eq!(
        call(&state, "scheduled.listRuns", json!({"taskId":task["id"]})).await,
        history
    );
    assert_eq!(
        call(&state, "settings.get", json!({})).await["scheduledTasksEnabled"],
        false
    );
}

#[tokio::test]
async fn scheduled_settings_read_errors_propagate_instead_of_enabling_execution() {
    let dir = tempfile::tempdir().unwrap();
    let state = open_state(dir.path());
    set_enabled(&state, false).await;
    state
        .lock()
        .await
        .db
        .conn()
        .execute(
            "UPDATE kv SET value_json = '{' WHERE ns = 'app' AND key = 'app'",
            [],
        )
        .unwrap();
    for method in [
        "tools.list",
        "scheduled.due",
        "scheduled.run",
        "scheduled.create",
        "scheduled.update",
        "scheduled.delete",
    ] {
        let error = request(&state, method, json!({})).await.unwrap_err();
        assert_eq!(error.code, 1000, "{method}");
        assert_eq!(error.data.unwrap()["errorCode"], "INTERNAL", "{method}");
    }
    let params = serde_json::from_value(json!({"sessionId":"missing","toolCallId":"stale","toolName":"ScheduledTaskList","args":{},"mode":"agent"})).unwrap();
    let st = state.lock().await;
    let result = super::super::scheduled_tools::execute(&st, &params);
    assert!(!result.ok);
    assert_eq!(result.error_code.as_deref(), Some("INTERNAL"));
}
