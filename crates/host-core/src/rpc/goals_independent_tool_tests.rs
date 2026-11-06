use super::*;
use std::time::Duration;

#[tokio::test]
async fn goals_independent_plugin_dispatch_uses_binding_and_stopped_goal_never_dispatches() {
    let mut h = Harness::new();
    h.call(
        "session.configure",
        json!({"id":h.session,"mode":"agent","permissionMode":"auto"}),
    )
    .await
    .unwrap();
    let goal = start_claim(&h, "claim").await;
    let runtime = bind(&h, &goal, "claim").await;
    configure(&h, "plan").await;
    h.events();
    let request = json!({"sessionId":h.session,"turnId":runtime["turnId"],"toolCallId":"plugin-active",
        "toolName":"plugin_test_write","mode":"plan","args":{}});
    let state = h.state.clone();
    let tx = h.tx.clone();
    let pending =
        tokio::spawn(async move { handle_request(state, "tools.execute", request, tx).await });
    let notice: Value = serde_json::from_str(
        &tokio::time::timeout(Duration::from_secs(5), h.rx.recv())
            .await
            .unwrap()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(notice["method"], "plugins.execute");
    assert_eq!(notice["params"]["mode"], "goal");
    h.call(
        "plugins.resolveExecution",
        json!({"executionId":notice["params"]["executionId"],"ok":true,"content":{"text":"done"}}),
    )
    .await
    .unwrap();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(5), pending)
            .await
            .unwrap()
            .unwrap()
            .unwrap()["ok"],
        true
    );
    h.call("goals.control",json!({"sessionId":h.session,"goalId":goal["id"],"expectedRevision":goal["revision"],"action":"stop"})).await.unwrap();
    h.events();
    let error = h
        .call(
            "tools.execute",
            json!({"sessionId":h.session,"turnId":runtime["turnId"],"toolCallId":"plugin-stopped",
        "toolName":"plugin_test_write","mode":"agent","args":{}}),
        )
        .await
        .unwrap_err();
    assert_eq!(error.data.unwrap()["errorCode"], "GOAL_TURN_STALE");
    assert!(
        h.events().is_empty(),
        "revoked bindings cannot reach the plugin runner"
    );
}

#[tokio::test]
async fn goals_immediate_pause_narrow_closeout_never_authorizes_native_permission_or_plugin_work() {
    let mut h = Harness::new();
    let goal = start_claim(&h, "claim").await;
    let runtime = bind(&h, &goal, "claim").await;
    let paused = h
        .call(
            "goals.control",
            json!({"sessionId":h.session,"goalId":goal["id"],
        "expectedRevision":goal["revision"],"action":"pause"}),
        )
        .await
        .unwrap();
    h.events();
    // Validation is closeout authority only, never the shared native execution gate.
    assert_eq!(
        h.call(
            "goals.validateTurn",
            json!({"sessionId":h.session,"goalId":goal["id"],
        "turnId":"claim"})
        )
        .await
        .unwrap(),
        paused
    );
    let error = h
        .call(
            "permissions.evaluate",
            json!({"sessionId":h.session,"turnId":runtime["turnId"],
        "toolName":"TodoWrite","mode":"agent"}),
        )
        .await
        .unwrap_err();
    assert_eq!(error.data.unwrap()["errorCode"], "GOAL_TURN_STALE");
    for tool in ["TodoWrite", "Write", "plugin_test_write"] {
        let error = tokio::time::timeout(Duration::from_secs(5), h.call("tools.execute",
            json!({"sessionId":h.session,"turnId":runtime["turnId"],"toolCallId":tool,
            "toolName":tool,"mode":"agent","args":{"path":"paused-write.txt","content":"forbidden"}})))
            .await.unwrap().unwrap_err();
        assert_eq!(error.data.unwrap()["errorCode"], "GOAL_TURN_STALE");
    }
    let error = h
        .call(
            "plans.enter",
            json!({"sessionId":h.session,"turnId":runtime["turnId"],
        "toolCallId":"native","kind":"plan"}),
        )
        .await
        .unwrap_err();
    assert_eq!(error.message, "GOAL_TURN_STALE");
    assert!(
        h.events().is_empty(),
        "paused native calls cannot request permission or dispatch plugins"
    );
    assert!(!h._dir.path().join("project/paused-write.txt").exists());
}

#[tokio::test]
async fn goals_immediate_pause_unbound_closing_claim_cannot_start_new_runtime_execution() {
    let h = Harness::new();
    let goal = start_claim(&h, "claim").await;
    h.call(
        "goals.control",
        json!({"sessionId":h.session,"goalId":goal["id"],
        "expectedRevision":goal["revision"],"action":"pause"}),
    )
    .await
    .unwrap();
    h.call(
        "goals.validateTurn",
        json!({"sessionId":h.session,"goalId":goal["id"],"turnId":"claim"}),
    )
    .await
    .unwrap();
    let error = h
        .call(
            "session.beginTurn",
            json!({"sessionId":h.session,"goalTurn":{
        "goalId":goal["id"],"turnId":"claim","provenance":"goal-continuation"}}),
        )
        .await
        .unwrap_err();
    assert_eq!(error.data.unwrap()["errorCode"], "GOAL_TURN_STALE");
    let st = h.state.lock().await;
    assert_eq!(
        st.db
            .conn()
            .query_row(
                "SELECT count(*) FROM turns WHERE status='running'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
}
