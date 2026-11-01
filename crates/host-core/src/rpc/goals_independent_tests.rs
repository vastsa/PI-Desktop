use super::*;

async fn start_claim(h: &Harness, turn: &str) -> Value {
    let started = h
        .call(
            "goals.start",
            json!({"sessionId":h.session,"objective":"ship"}),
        )
        .await
        .unwrap();
    h.call(
        "goals.claimTurn",
        json!({"sessionId":h.session,"goalId":started["goal"]["id"],
        "expectedRevision":started["goal"]["revision"],"turnId":turn}),
    )
    .await
    .unwrap()["goal"]
        .clone()
}
async fn configure(h: &Harness, mode: &str) {
    h.call("session.configure", json!({"id":h.session,"mode":mode}))
        .await
        .unwrap();
}
async fn bind(h: &Harness, goal: &Value, turn: &str) -> Value {
    h.call(
        "session.beginTurn",
        json!({"sessionId":h.session,"goalTurn":{
        "goalId":goal["id"],"turnId":turn,"provenance":"user-goal"}}),
    )
    .await
    .unwrap()
}
async fn permission(h: &Harness, turn: &Value) -> Value {
    h.call(
        "permissions.evaluate",
        json!({"sessionId":h.session,"turnId":turn["turnId"],
        "toolName":"TodoWrite","mode":"agent"}),
    )
    .await
    .unwrap()
}

#[tokio::test]
async fn goals_independent_composer_selection_preserves_claim_revision_and_time() {
    let h = Harness::new();
    let goal = start_claim(&h, "claim").await;
    for mode in ["plan", "agent", "goal"] {
        configure(&h, mode).await;
        let read = h
            .call(
                "goals.validateTurn",
                json!({"sessionId":h.session,"goalId":goal["id"],"turnId":"claim"}),
            )
            .await
            .unwrap();
        assert_eq!(read["goal"], goal);
    }
}

#[tokio::test]
async fn goals_independent_edit_uses_claim_scope_until_next_execution_turn() {
    let h = Harness::new();
    let goal = start_claim(&h, "claim").await;
    assert_eq!(
        goal["activeScope"],
        json!({"objective":"ship","criteria":["ship"]})
    );
    let edited = h
        .call(
            "goals.control",
            json!({"sessionId":h.session,"goalId":goal["id"],
        "expectedRevision":goal["revision"],"action":"edit","objective":"replacement scope"}),
        )
        .await
        .unwrap();
    assert_eq!(edited["goal"]["objective"], "replacement scope");
    assert_eq!(edited["goal"]["activeScope"], goal["activeScope"]);
    let report = json!({"sessionId":h.session,"goalId":goal["id"],"turnId":"claim",
        "status":"completed","progressSummary":"old scope done",
        "outcomes":[{"criterion":"ship","outcome":"met","evidence":"tests"}],
        "audit":{"version":1,"objective":"ship","remainingWork":[],
        "items":[{"requirement":"ship","outcome":"met","evidence":"tests"}]}});
    let err = h.call("goals.report", report.clone()).await.unwrap_err();
    assert_eq!(err.data.unwrap()["errorCode"], "GOAL_COMPLETION_UNVERIFIED");
    let mut active = report;
    active["status"] = json!("active");
    h.call("goals.report", active).await.unwrap();
    let settled = h
        .call(
            "goals.settleTurn",
            json!({"sessionId":h.session,"goalId":goal["id"],"turnId":"claim","tokens":4}),
        )
        .await
        .unwrap();
    assert!(settled["goal"].get("activeScope").is_none());
    assert_eq!(settled["goal"]["outcomes"], json!([]));
    assert!(settled["goal"].get("audit").is_none());
    let next = h
        .call(
            "goals.claimTurn",
            json!({"sessionId":h.session,"goalId":goal["id"],
        "expectedRevision":settled["goal"]["revision"],"turnId":"next"}),
        )
        .await
        .unwrap();
    assert_eq!(
        next["goal"]["activeScope"],
        json!({"objective":"replacement scope","criteria":["replacement scope"]})
    );
}

#[tokio::test]
async fn goals_independent_replacement_drains_claim_and_ordinary_turn_without_losing_usage() {
    let mut h = Harness::new();
    let old = start_claim(&h, "old").await;
    let runtime = bind(&h, &old, "old").await;
    configure(&h, "plan").await;
    h.events();
    let new = h
        .call(
            "goals.start",
            json!({"sessionId":h.session,"objective":"new"}),
        )
        .await
        .unwrap()["goal"]
        .clone();
    let events = h.events();
    assert_eq!(events[0]["params"]["goalId"], old["id"]);
    assert_eq!(events[0]["params"]["goal"], Value::Null);
    assert_eq!(events[1]["params"]["goal"]["id"], new["id"]);
    assert_eq!(new["roundsStarted"], 0);
    let claim = json!({"sessionId":h.session,"goalId":new["id"],"expectedRevision":new["revision"],"turnId":"new"});
    assert_eq!(
        h.call("goals.claimTurn", claim.clone()).await.unwrap()["claimed"],
        false
    );
    let late = h
        .call(
            "goals.settleTurn",
            json!({"sessionId":h.session,"goalId":old["id"],"turnId":"old","tokens":17}),
        )
        .await
        .unwrap();
    assert_eq!(late["goal"], Value::Null);
    assert_eq!(
        h.call("goals.claimTurn", claim.clone()).await.unwrap()["claimed"],
        false
    );
    h.call(
        "session.endTurn",
        json!({"turnId":runtime["turnId"],"status":"aborted"}),
    )
    .await
    .unwrap();
    assert_eq!(
        h.call("goals.claimTurn", claim).await.unwrap()["claimed"],
        true
    );
    let st = h.state.lock().await;
    assert_eq!(
        st.db
            .conn()
            .query_row(
                "SELECT token_usage FROM session_goals WHERE id=?1",
                [old["id"].as_str().unwrap()],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        17
    );
    assert_eq!(
        sessions::session_mode(&st.db, &h.session)
            .unwrap()
            .as_deref(),
        Some("plan")
    );
}

#[tokio::test]
async fn goals_independent_bound_turn_mode_is_authoritative_and_stop_revokes_tools() {
    let h = Harness::new();
    let goal = start_claim(&h, "claim").await;
    configure(&h, "plan").await;
    let runtime = bind(&h, &goal, "claim").await;
    let read = h
        .call(
            "session.getTurnMode",
            json!({"sessionId":h.session,"turnId":runtime["turnId"]}),
        )
        .await
        .unwrap();
    assert_eq!(read, json!({"mode":"goal"}));
    assert_ne!(permission(&h, &runtime).await["decision"], "deny");
    let result = h.call("tools.execute", json!({"sessionId":h.session,"turnId":runtime["turnId"],"toolCallId":"todo","toolName":"TodoWrite","mode":"plan",
        "args":{"todos":[{"content":"work","status":"in_progress","activeForm":"working"}]}})).await.unwrap();
    assert_eq!(result["ok"], true, "{result}");
    let current = h
        .call("goals.get", json!({"sessionId":h.session}))
        .await
        .unwrap();
    h.call("goals.control", json!({"sessionId":h.session,"goalId":goal["id"],"expectedRevision":current["goal"]["revision"],"action":"stop"})).await.unwrap();
    assert!(h.call("permissions.evaluate", json!({"sessionId":h.session,"turnId":runtime["turnId"],"toolName":"TodoWrite","mode":"agent"})).await.is_err());
}

#[tokio::test]
async fn goals_independent_plan_turn_snapshot_survives_composer_agent_and_forgery() {
    let h = Harness::new();
    configure(&h, "plan").await;
    let runtime = h
        .call("session.beginTurn", json!({"sessionId":h.session}))
        .await
        .unwrap();
    // Preserve Plan's configuration gate while testing a changed durable preference.
    h.state
        .lock()
        .await
        .db
        .conn()
        .execute("UPDATE sessions SET mode='agent' WHERE id=?1", [&h.session])
        .unwrap();
    assert_eq!(permission(&h, &runtime).await["decision"], "deny");
    h.call(
        "session.endTurn",
        json!({"turnId":runtime["turnId"],"status":"completed"}),
    )
    .await
    .unwrap();
    configure(&h, "plan").await;
    assert_eq!(
        permission(&h, &json!({"turnId":"forged"})).await["decision"],
        "deny"
    );
}

#[tokio::test]
async fn goals_independent_invalid_binding_rolls_back_and_resume_after_agent_work() {
    let h = Harness::new();
    let goal = start_claim(&h, "claim").await;
    for binding in [
        json!({"goalId":goal["id"],"turnId":"wrong","provenance":"user-goal"}),
        json!({"goalId":goal["id"],"turnId":"claim","provenance":"scheduled"}),
    ] {
        assert!(h
            .call(
                "session.beginTurn",
                json!({"sessionId":h.session,"goalTurn":binding})
            )
            .await
            .is_err());
        assert_eq!(
            h.state
                .lock()
                .await
                .db
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
    h.call("goals.control", json!({"sessionId":h.session,"goalId":goal["id"],"expectedRevision":goal["revision"],"action":"stop"})).await.unwrap();
    let settled = h
        .call(
            "goals.settleTurn",
            json!({"sessionId":h.session,"goalId":goal["id"],"turnId":"claim","tokens":0}),
        )
        .await
        .unwrap();
    configure(&h, "agent").await;
    let ordinary = h
        .call("session.beginTurn", json!({"sessionId":h.session}))
        .await
        .unwrap();
    h.call(
        "session.endTurn",
        json!({"turnId":ordinary["turnId"],"status":"completed"}),
    )
    .await
    .unwrap();
    let resumed = h.call("goals.control", json!({"sessionId":h.session,"goalId":goal["id"],"expectedRevision":settled["goal"]["revision"],"action":"resume"})).await.unwrap();
    assert_eq!(resumed["goal"]["status"], "active");
}

#[test]
fn goals_independent_schema32_upgrade_backs_up_and_preserves_claims() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("upgrade.sqlite");
    let db = crate::db::Database::open(&path).unwrap();
    let session =
        sessions::create_session(&db, None, Some("goal".into()), None, None, None).unwrap();
    let goal = goals::start(
        &db,
        serde_json::from_value(json!({"sessionId":session.id,"objective":"keep"})).unwrap(),
    )
    .unwrap();
    goals::claim_turn(&db, serde_json::from_value(json!({"sessionId":session.id,"goalId":goal.id,"expectedRevision":goal.revision,"turnId":"old"})).unwrap()).unwrap();
    // Restore the v31 execution/queue shape before testing the v32 migration.
    db.conn()
        .execute_batch(
            "DROP TRIGGER turn_execution_snapshot;
        DROP TABLE turn_execution;
        ALTER TABLE session_goals DROP COLUMN active_scope_json;
        ALTER TABLE turn_queue DROP COLUMN goal_start_id;
        CREATE TRIGGER session_goals_mode_fence AFTER UPDATE OF mode ON sessions
        WHEN NEW.mode != 'goal'
        BEGIN
          UPDATE session_goals SET status='paused', revision=revision+1,
            stop_reason='session_mode_changed',
            elapsed_ms=min(9007199254740991,elapsed_ms+CASE WHEN active_since_ms IS NULL THEN 0
              ELSE max(0,goal_now_ms()-active_since_ms) END),active_since_ms=NULL
            WHERE session_id=NEW.id AND status='active';
        END;
        PRAGMA user_version=31;",
        )
        .unwrap();
    drop(db);
    let db = crate::db::Database::open(&path).unwrap();
    assert_eq!(
        db.conn()
            .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        32
    );
    let backup = crate::db::migration_backup_path(&path, 31);
    assert!(backup.exists());
    let backup = rusqlite::Connection::open(backup).unwrap();
    assert_eq!(
        backup
            .query_row(
                "SELECT active_turn_id FROM session_goals WHERE id=?1",
                [&goal.id],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
        "old"
    );
    assert_eq!(
        db.conn()
            .query_row(
                "SELECT count(*) FROM goal_turns WHERE turn_id='old' AND interrupted=1",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
    assert_eq!(
        db.conn()
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE name='session_goals_mode_fence'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
}

#[tokio::test]
async fn goals_independent_native_plan_calls_cannot_use_composer_instead_of_goal_binding() {
    let h = Harness::new();
    let goal = start_claim(&h, "claim").await;
    let runtime = bind(&h, &goal, "claim").await;
    assert!(h.call("plans.enter", json!({"sessionId":h.session,"turnId":runtime["turnId"],"toolCallId":"enter","kind":"plan"})).await.is_err());
    configure(&h, "plan").await;
    assert!(h.call("plans.submit", json!({"sessionId":h.session,"turnId":runtime["turnId"],"toolCallId":"submit","kind":"plan",
        "title":"wrong authority","markdown":"not a Plan turn","question":"approve?"})).await.is_err());
}

#[tokio::test]
async fn goals_independent_stop_during_permission_wait_prevents_late_write() {
    let mut h = Harness::new();
    let goal = start_claim(&h, "claim").await;
    let runtime = bind(&h, &goal, "claim").await;
    h.events();
    let state = h.state.clone();
    let tx = h.tx.clone();
    let session = h.session.clone();
    let task = tokio::spawn(async move {
        handle_request(state,"tools.execute",json!({"sessionId":session,"turnId":runtime["turnId"],"toolCallId":"waiting-write","toolName":"Write","mode":"agent",
            "args":{"path":"must-not-exist.txt","content":"forbidden after Stop"}}),tx).await
    });
    let request: Value = serde_json::from_str(
        &tokio::time::timeout(std::time::Duration::from_secs(10), h.rx.recv())
            .await
            .unwrap()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(request["method"], "permissions.request");
    tokio::time::timeout(std::time::Duration::from_secs(5), h.call("goals.control",json!({"sessionId":h.session,"goalId":goal["id"],"expectedRevision":goal["revision"],"action":"stop"}))).await.expect("Stop must not wait for permission").unwrap();
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        h.call(
            "permissions.resolve",
            json!({"requestId":request["params"]["requestId"],"decision":"allow-once"}),
        ),
    )
    .await
    .expect("permission resolution must finish")
    .unwrap();
    let result = tokio::time::timeout(std::time::Duration::from_secs(5), task)
        .await
        .expect("tool must finish after permission resolution")
        .unwrap();
    assert!(result.is_err() || result.unwrap()["ok"] == false);
    assert!(!h._dir.path().join("project/must-not-exist.txt").exists());
}

#[tokio::test]
async fn goals_independent_queue_start_identity_roundtrips_without_granting_authority() {
    let h = Harness::new();
    let goal = h
        .call(
            "goals.start",
            json!({"sessionId":h.session,"objective":"queued startup"}),
        )
        .await
        .unwrap()["goal"]
        .clone();
    let input = json!({"sessionId":h.session,"principal":"desktop","inputHash":"startup",
        "content":"queued startup","permissionMode":"ask","goalStartId":goal["id"]});
    let entry = h.call("session.queuePush", input).await.unwrap()["entry"].clone();
    assert_eq!(entry["goalStartId"], goal["id"]);
    let listed = h
        .call("session.queueList", json!({"sessionId":h.session}))
        .await
        .unwrap();
    assert_eq!(listed["entries"][0], entry);
    let current = h
        .call("goals.get", json!({"sessionId":h.session}))
        .await
        .unwrap();
    assert_eq!(
        current["goal"], goal,
        "queue identity must not claim or start a turn"
    );
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

#[tokio::test]
async fn goals_independent_queue_start_rejects_cross_session_and_mixed_origins() {
    let h = Harness::new();
    let goal = h
        .call(
            "goals.start",
            json!({"sessionId":h.session,"objective":"startup"}),
        )
        .await
        .unwrap()["goal"]
        .clone();
    let foreign = {
        let st = h.state.lock().await;
        sessions::create_session(&st.db, None, None, None, None, None)
            .unwrap()
            .id
    };
    for extra in [
        json!({"sessionId":foreign}),
        json!({"goalStartId":"missing"}),
        json!({"sessionMessageId":"collaboration"}),
        json!({"voiceOrigin":{"callId":"call","operationId":"operation"},"userMessageId":"voice-user"}),
    ] {
        let mut input = json!({"sessionId":h.session,"principal":"desktop","inputHash":"startup",
            "content":"startup","permissionMode":"ask","goalStartId":goal["id"]});
        input
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let error = h.call("session.queuePush", input).await.unwrap_err();
        assert_eq!(error.data.unwrap()["errorCode"], "INVALID_PARAMS");
    }
    assert_eq!(
        h.call("session.queueList", json!({"sessionId":h.session}))
            .await
            .unwrap()["entries"],
        json!([])
    );
}

#[tokio::test]
async fn goals_independent_binding_is_unique_session_owned_and_not_voice_or_collaboration() {
    let h = Harness::new();
    let goal = start_claim(&h, "claim").await;
    let foreign = {
        let st = h.state.lock().await;
        sessions::create_session(&st.db, None, None, None, None, None)
            .unwrap()
            .id
    };
    let base = json!({"sessionId":h.session,"goalTurn":{"goalId":goal["id"],"turnId":"claim","provenance":"goal-continuation"}});
    for extra in [
        json!({"sessionId":foreign}),
        json!({"sessionMessageId":"collaboration"}),
        json!({"voiceOrigin":{"callId":"call","operationId":"operation"}}),
    ] {
        let mut request = base.clone();
        request
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        assert!(h.call("session.beginTurn", request).await.is_err());
    }
    let runtime = h.call("session.beginTurn", base.clone()).await.unwrap();
    assert!(h.call("session.beginTurn", base).await.is_err());
    assert_eq!(
        h.call(
            "session.getTurnMode",
            json!({"sessionId":h.session,"turnId":runtime["turnId"]})
        )
        .await
        .unwrap(),
        json!({"mode":"goal"})
    );
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
        1
    );
}

#[path = "goals_independent_tool_tests.rs"]
mod tools;
