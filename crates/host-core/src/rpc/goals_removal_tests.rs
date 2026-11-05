use super::*;

#[tokio::test]
async fn goals_removal_finishes_only_bound_current_conversation_as_agent() {
    for paused in [false, true] {
        let h = Harness::new();
        h.call(
            "session.configure",
            json!({"id":h.session,"mode":"goal","permissionMode":"auto"}),
        )
        .await
        .unwrap();
        let mut goal = start_claim(&h, "claim").await;
        let runtime = bind(&h, &goal, "claim").await;
        if paused {
            goal = h.call("goals.control",json!({"sessionId":h.session,"goalId":goal["id"],"expectedRevision":goal["revision"],"action":"pause"})).await.unwrap()["goal"].clone();
        }
        let deleted = h.call("goals.control",json!({"sessionId":h.session,"goalId":goal["id"],"expectedRevision":goal["revision"],"action":"delete"})).await.unwrap();
        let validation = h
            .call(
                "goals.validateTurn",
                json!({"sessionId":h.session,"goalId":goal["id"],"turnId":"claim"}),
            )
            .await
            .unwrap();
        assert_eq!(validation["detached"], true);
        assert_eq!(validation["goalId"], deleted["goalId"]);
        assert_eq!(validation["revision"], deleted["revision"]);
        assert_ne!(permission(&h, &runtime).await["decision"], "deny");
        let write = h.call("tools.execute",json!({"sessionId":h.session,"turnId":runtime["turnId"],"toolCallId":"finish","toolName":"Write","mode":"goal","args":{"path":"finish.txt","content":"current conversation"}})).await.unwrap();
        assert_eq!(write["ok"], true, "{write}");
        assert!(h._dir.path().join("project/finish.txt").exists());
        assert!(h.call("goals.report",json!({"sessionId":h.session,"goalId":goal["id"],"turnId":"claim","progressSummary":"no revival","status":"active","outcomes":[]})).await.is_err());
        assert!(bind_result(&h, &goal).await.is_err());
        let st = h.state.lock().await;
        assert_eq!(
            sessions::session_mode(&st.db, &h.session)
                .unwrap()
                .as_deref(),
            Some("agent")
        );
        assert_eq!(
            sessions::turn_execution::execution_mode(
                st.db.conn(),
                &h.session,
                runtime["turnId"].as_str()
            )
            .unwrap()
            .as_deref(),
            Some("agent")
        );
        drop(st);
        h.call(
            "goals.settleTurn",
            json!({"sessionId":h.session,"goalId":goal["id"],"turnId":"claim","tokens":7}),
        )
        .await
        .unwrap();
        assert!(h
            .call(
                "goals.validateTurn",
                json!({"sessionId":h.session,"goalId":goal["id"],"turnId":"claim"})
            )
            .await
            .is_err());
    }
}
async fn bind_result(h: &Harness, goal: &Value) -> Result<Value, JsonRpcError> {
    h.call("session.beginTurn",json!({"sessionId":h.session,"goalTurn":{"goalId":goal["id"],"turnId":"claim","provenance":"goal-continuation"}})).await
}

#[tokio::test]
async fn goals_removal_never_restores_revoked_unbound_recovered_or_foreign_claims() {
    for revoke in ["stop", "cancel", "unbound", "recover", "ended"] {
        let h = Harness::new();
        let mut goal = start_claim(&h, "claim").await;
        let runtime = if revoke != "unbound" {
            Some(bind(&h, &goal, "claim").await)
        } else {
            None
        };
        if matches!(revoke, "stop" | "cancel") {
            goal=h.call("goals.control",json!({"sessionId":h.session,"goalId":goal["id"],"expectedRevision":goal["revision"],"action":revoke})).await.unwrap()["goal"].clone();
        } else if revoke == "recover" {
            goals::recover(&h.state.lock().await.db).unwrap();
            goal = h
                .call("goals.get", json!({"sessionId":h.session}))
                .await
                .unwrap()["goal"]
                .clone();
        } else if revoke == "ended" {
            h.call(
                "session.endTurn",
                json!({"turnId":runtime.as_ref().unwrap()["turnId"],"status":"completed"}),
            )
            .await
            .unwrap();
        }
        h.call("goals.control",json!({"sessionId":h.session,"goalId":goal["id"],"expectedRevision":goal["revision"],"action":"delete"})).await.unwrap();
        for (session, claim) in [
            (&*h.session, "claim"),
            ("foreign", "claim"),
            (&*h.session, "foreign"),
        ] {
            assert!(
                h.call(
                    "goals.validateTurn",
                    json!({"sessionId":session,"goalId":goal["id"],"turnId":claim})
                )
                .await
                .is_err(),
                "{revoke}"
            );
        }
        assert!(bind_result(&h, &goal).await.is_err());
    }
}

#[tokio::test]
async fn goals_removal_resets_input_but_preserves_unrelated_running_plan_policy() {
    let h = Harness::new();
    let goal = start_claim(&h, "claim").await;
    let settled = h
        .call(
            "goals.settleTurn",
            json!({"sessionId":h.session,"goalId":goal["id"],"turnId":"claim","tokens":0}),
        )
        .await
        .unwrap();
    let paused=h.call("goals.control",json!({"sessionId":h.session,"goalId":goal["id"],"expectedRevision":settled["goal"]["revision"],"action":"pause"})).await.unwrap();
    configure(&h, "plan").await;
    let runtime = h
        .call("session.beginTurn", json!({"sessionId":h.session}))
        .await
        .unwrap();
    h.call("goals.control",json!({"sessionId":h.session,"goalId":goal["id"],"expectedRevision":paused["goal"]["revision"],"action":"delete"})).await.unwrap();
    assert_eq!(permission(&h, &runtime).await["decision"], "deny");
    let st = h.state.lock().await;
    assert_eq!(
        sessions::session_mode(&st.db, &h.session)
            .unwrap()
            .as_deref(),
        Some("agent")
    );
    assert_eq!(
        sessions::turn_execution::execution_mode(
            st.db.conn(),
            &h.session,
            runtime["turnId"].as_str()
        )
        .unwrap()
        .as_deref(),
        Some("plan")
    );
}
