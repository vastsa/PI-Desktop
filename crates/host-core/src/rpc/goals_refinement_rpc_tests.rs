use super::*;

#[tokio::test]
async fn goals_refinement_rpc_owner_controls_refresh_and_commit_before_notifications() {
    let mut h = Harness::new();
    let started = h
        .call(
            "goals.start",
            json!({"sessionId":h.session,"objective":"before"}),
        )
        .await
        .unwrap();
    let id = started["goal"]["id"].clone();
    let claimed = h
        .call(
            "goals.claimTurn",
            json!({"sessionId":h.session,"goalId":id,
        "expectedRevision":1,"turnId":"live"}),
        )
        .await
        .unwrap();
    h.events();
    let staged = h
        .call(
            "goals.control",
            json!({"sessionId":h.session,"goalId":id,
        "expectedRevision":claimed["goal"]["revision"],"action":"budget",
        "budget":{"maxTurns":1,"maxTokens":5}}),
        )
        .await
        .unwrap();
    assert_eq!(staged["goal"]["budget"], json!({"maxTurns":20}));
    assert_eq!(
        staged["goal"]["pendingBudget"],
        json!({"maxTurns":1,"maxTokens":5})
    );
    assert_eq!(h.events()[0]["params"]["goal"], staged["goal"]);
    let paused = h
        .call(
            "goals.control",
            json!({"sessionId":h.session,"goalId":id,
        "expectedRevision":staged["goal"]["revision"],"action":"pause"}),
        )
        .await
        .unwrap();
    let edited = h
        .call(
            "goals.control",
            json!({"sessionId":h.session,"goalId":id,
        "expectedRevision":paused["goal"]["revision"],"action":"edit","objective":"after"}),
        )
        .await
        .unwrap();
    assert_eq!(edited["goal"]["status"], "active");
    assert_eq!(edited["goal"]["pauseRequested"], true);
    h.events();
    let refreshed = h
        .call(
            "goals.validateTurn",
            json!({"sessionId":h.session,"goalId":id,"turnId":"live"}),
        )
        .await
        .unwrap();
    assert_eq!(refreshed["goal"], edited["goal"]);
    let mut completion = json!({"sessionId":h.session,"goalId":id,"turnId":"live",
        "progressSummary":"done","status":"completed",
        "outcomes":[{"criterion":"after","outcome":"met","evidence":"new tests"}],
        "audit":{"version":1,"objective":"before","remainingWork":[],
        "items":[{"requirement":"after","outcome":"met","evidence":"new tests"}]}});
    let error = h
        .call("goals.report", completion.clone())
        .await
        .unwrap_err();
    assert_eq!(
        error.data.unwrap()["errorCode"],
        "GOAL_COMPLETION_UNVERIFIED"
    );
    assert!(h.events().is_empty());
    completion["status"] = json!("active");
    completion["outcomes"][0]["criterion"] = json!("before");
    completion["audit"]["items"][0]["requirement"] = json!("before");
    h.call("goals.report", completion).await.unwrap();
    h.events();
    let settled = h
        .call(
            "goals.settleTurn",
            json!({"sessionId":h.session,"goalId":id,
        "turnId":"live","tokens":7}),
        )
        .await
        .unwrap();
    assert_eq!(settled["goal"]["status"], "paused");
    assert_eq!(settled["goal"]["pauseRequested"], false);
    assert_eq!(settled["goal"]["tokenUsage"], 7);
    assert_eq!(
        settled["goal"]["budget"],
        json!({"maxTurns":1,"maxTokens":5})
    );
    assert!(settled["goal"].get("pendingBudget").is_none());
    assert!(settled["goal"].get("activeScope").is_none());
    assert_eq!(settled["goal"]["outcomes"], json!([]));
    assert_eq!(h.events()[0]["params"]["goal"], settled["goal"]);
    let updated = h.call("goals.control", json!({"sessionId":h.session,"goalId":id,
        "expectedRevision":settled["goal"]["revision"],"action":"budget","budget":{"maxTurns":null}})).await.unwrap();
    assert_eq!(updated["goal"]["status"], "paused");
    let denied = h
        .call(
            "goals.claimTurn",
            json!({"sessionId":h.session,"goalId":id,
        "expectedRevision":updated["goal"]["revision"],"turnId":"not-authorized"}),
        )
        .await
        .unwrap();
    assert_eq!(denied["claimed"], false);
    let resumed = h
        .call(
            "goals.control",
            json!({"sessionId":h.session,"goalId":id,
        "expectedRevision":updated["goal"]["revision"],"action":"resume"}),
        )
        .await
        .unwrap();
    let next = h
        .call(
            "goals.claimTurn",
            json!({"sessionId":h.session,"goalId":id,
        "expectedRevision":resumed["goal"]["revision"],"turnId":"next"}),
        )
        .await
        .unwrap();
    h.events();
    let stopped = h
        .call(
            "goals.control",
            json!({"sessionId":h.session,"goalId":id,
        "expectedRevision":next["goal"]["revision"],"action":"stop"}),
        )
        .await
        .unwrap();
    assert_eq!(stopped["goal"]["status"], "paused");
    assert_eq!(stopped["goal"]["activeTurnId"], "next");
    assert_eq!(h.events()[0]["params"]["goal"], stopped["goal"]);
    let error = h
        .call(
            "goals.report",
            json!({"sessionId":h.session,"goalId":id,
        "turnId":"next","progressSummary":"too late","status":"active","outcomes":[]}),
        )
        .await
        .unwrap_err();
    assert_eq!(error.data.unwrap()["errorCode"], "GOAL_TURN_STALE");
    assert!(h.events().is_empty());
    let done = h
        .call(
            "goals.settleTurn",
            json!({"sessionId":h.session,"goalId":id,
        "turnId":"next","tokens":3,"aborted":true}),
        )
        .await
        .unwrap();
    assert_eq!(done["goal"]["status"], "paused");
    assert_eq!(done["goal"]["tokenUsage"], 10);
    assert_eq!(
        h.call("goals.get", json!({"sessionId":h.session}))
            .await
            .unwrap(),
        done
    );
}
