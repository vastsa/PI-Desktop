use super::*;
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};

#[tokio::test]
async fn removal_pauses_only_bound_tasks_and_preserves_definitions_and_history() {
    let dir = tempfile::tempdir().unwrap();
    let a = tempfile::tempdir().unwrap();
    let b = tempfile::tempdir().unwrap();
    let mut st = AppState::open(dir.path()).unwrap();
    st.handshook = true;
    let path = st.workspace.set(a.path()).path;
    let mut ids = Vec::new();
    for cadence in ["manual", "hourly", "daily", "weekly"] {
        let task=handle(&st,"scheduled.create",json!({"title":"Keep title","prompt":"Keep prompt","cadence":cadence,"schedule":if cadence=="manual"{Value::Null}else{json!({"hour":9,"minute":30,"weekday":0})}})).unwrap()["task"].clone();
        ids.push(task["id"].as_str().unwrap().to_string());
    }
    let run = handle(&st, "scheduled.run", json!({"id":ids[0]})).unwrap();
    handle(
        &st,
        "scheduled.finishRun",
        json!({"runId":run["runId"],"status":"completed"}),
    )
    .unwrap();
    st.workspace.set(b.path());
    let unrelated = handle(
        &st,
        "scheduled.create",
        json!({"prompt":"Other","cadence":"hourly","schedule":{"hour":0,"minute":0,"weekday":0}}),
    )
    .unwrap()["task"]
        .clone();
    let state = Arc::new(Mutex::new(st));
    let deleted = super::super::handle_request(
        state.clone(),
        "projects.remove",
        json!({"path":path}),
        mpsc::unbounded_channel().0,
    )
    .await
    .unwrap();
    assert_eq!(deleted["removed"], true);
    drop(state);
    let st = AppState::open(dir.path()).unwrap();
    for id in &ids {
        let task = scheduled::get_task(&st.db, id).unwrap().unwrap();
        assert!(!task.enabled);
        assert_eq!(task.title, "Keep title");
        assert_eq!(task.prompt, "Keep prompt");
        assert_eq!(
            task.workspace_path
                .as_deref()
                .and_then(crate::db::canonical_project_path),
            crate::db::canonical_project_path(&path)
        );
        let rejected = handle(&st, "scheduled.run", json!({"id":id,"automatic":true})).unwrap_err();
        assert_eq!(rejected.data.unwrap()["errorCode"], "SCHEDULE_NOT_DUE");
    }
    assert!(
        scheduled::get_task(&st.db, unrelated["id"].as_str().unwrap())
            .unwrap()
            .unwrap()
            .enabled
    );
    let history = scheduled::list_runs(&st.db, Some(&ids[0]), 100).unwrap();
    assert_eq!(history.len(), 1);
    assert_eq!(history[0].status, "completed");
    assert!(history[0].session_id.is_none());
}

#[tokio::test]
async fn admitted_scheduled_run_blocks_removal_before_a_turn_is_opened() {
    let dir = tempfile::tempdir().unwrap();
    let project = tempfile::tempdir().unwrap();
    let mut st = AppState::open(dir.path()).unwrap();
    st.handshook = true;
    let path = st.workspace.set(project.path()).path;
    let task = handle(
        &st,
        "scheduled.create",
        json!({"prompt":"Review","cadence":"manual","schedule":null}),
    )
    .unwrap()["task"]
        .clone();
    let run = handle(&st, "scheduled.run", json!({"id":task["id"]})).unwrap();
    let state = Arc::new(Mutex::new(st));
    let rejected = super::super::handle_request(
        state.clone(),
        "projects.remove",
        json!({"path":path}),
        mpsc::unbounded_channel().0,
    )
    .await
    .unwrap_err();
    assert_eq!(rejected.data.unwrap()["errorCode"], "CONFLICT");
    let st = state.lock().await;
    assert!(
        sessions::get_session(&st.db, run["sessionId"].as_str().unwrap())
            .unwrap()
            .is_some()
    );
    assert!(
        scheduled::get_task(&st.db, task["id"].as_str().unwrap())
            .unwrap()
            .unwrap()
            .enabled
    );
}
