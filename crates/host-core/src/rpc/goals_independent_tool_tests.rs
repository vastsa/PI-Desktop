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
