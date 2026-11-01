#[path = "goals_independent_tests.rs"]
mod independent;

use super::*;
use crate::{rpc::handle_request, sessions};

#[tokio::test]
async fn goals_approved_settings_validate_and_persist_without_touching_other_fields() {
    let h = Harness::new();
    h.call("settings.set", json!({"theme":"light","enterToSend":false}))
        .await
        .unwrap();
    for budget in [
        json!({"maxTurns":7}),
        json!({"maxTurns":null}),
        json!({"maxTurns":null,"maxTokens":9007199254740991i64}),
    ] {
        h.call("settings.set", json!({"defaultGoalBudget":budget}))
            .await
            .unwrap();
        let read = h.call("settings.get", json!({})).await.unwrap();
        assert_eq!(read["defaultGoalBudget"], budget);
        assert_eq!(read["theme"], "light");
        assert_eq!(read["enterToSend"], false);
    }
    let before = h.call("settings.get", json!({})).await.unwrap();
    for budget in [
        json!({}),
        json!({"maxTokens":3}),
        Value::Null,
        json!({"maxTurns":0}),
        json!({"maxTurns":10001}),
        json!({"maxTurns":1.5}),
        json!({"maxTurns":null,"maxTokens":null}),
        json!({"maxTurns":null,"maxTokens":0}),
    ] {
        let error = h
            .call(
                "settings.set",
                json!({"defaultGoalBudget":budget,"theme":"dark"}),
            )
            .await
            .unwrap_err();
        assert_eq!(error.data.unwrap()["errorCode"], "GOAL_INVALID_BUDGET");
        assert_eq!(h.call("settings.get", json!({})).await.unwrap(), before);
    }
    let state = h.state.lock().await;
    let persisted = state.db.get_setting("app").unwrap().unwrap();
    assert_eq!(persisted["defaultGoalBudget"], before["defaultGoalBudget"]);
}

struct Harness {
    _dir: tempfile::TempDir,
    state: Arc<Mutex<AppState>>,
    session: String,
    tx: mpsc::UnboundedSender<String>,
    rx: mpsc::UnboundedReceiver<String>,
}
impl Harness {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("project")).unwrap();
        let mut st = AppState::open(dir.path()).unwrap();
        st.handshook = true;
        let session = sessions::create_session(
            &st.db,
            None,
            Some("goal".into()),
            None,
            None,
            Some(dir.path().join("project").to_string_lossy().into_owned()),
        )
        .unwrap()
        .id;
        sessions::configure_session_with_thinking(
            &st.db,
            &session,
            "goal",
            None,
            None,
            None,
            Some("ask"),
        )
        .unwrap();
        let (tx, rx) = mpsc::unbounded_channel();
        Self {
            _dir: dir,
            state: Arc::new(Mutex::new(st)),
            session,
            tx,
            rx,
        }
    }
    async fn call(&self, method: &str, params: Value) -> Result<Value, JsonRpcError> {
        handle_request(self.state.clone(), method, params, self.tx.clone()).await
    }
    fn events(&mut self) -> Vec<Value> {
        let mut result = vec![];
        while let Ok(line) = self.rx.try_recv() {
            result.push(serde_json::from_str(&line).unwrap());
        }
        result
    }
}
#[tokio::test]
async fn goals_rpc_user_path_and_committed_notifications() {
    let mut h = Harness::new();
    assert_eq!(
        h.call("goals.get", json!({"sessionId":h.session}))
            .await
            .unwrap(),
        json!({"goal":null})
    );
    assert!(h.events().is_empty());
    let started = h
        .call(
            "goals.start",
            json!({"sessionId":h.session,"objective":"ship"}),
        )
        .await
        .unwrap();
    let id = started["goal"]["id"].clone();
    assert_eq!(started["goal"]["budget"], json!({"maxTurns":20}));
    assert_eq!(started["goal"]["roundsStarted"], 0);
    let events = h.events();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["method"], "goals.changed");
    assert_eq!(events[0]["params"]["goal"], started["goal"]);
    assert_eq!(events[0]["params"]["sessionId"], h.session);
    let claimed = h
        .call(
            "goals.claimTurn",
            json!({"sessionId":h.session,"goalId":id,"expectedRevision":1,"turnId":"execution-1"}),
        )
        .await
        .unwrap();
    assert_eq!(claimed["claimed"], true);
    assert_eq!(h.events().len(), 1);
    h.call(
        "goals.validateTurn",
        json!({"sessionId":h.session,"goalId":id,"turnId":"execution-1"}),
    )
    .await
    .unwrap();
    let duplicate = h
        .call(
            "goals.claimTurn",
            json!({"sessionId":h.session,"goalId":id,"expectedRevision":1,"turnId":"execution-1"}),
        )
        .await
        .unwrap();
    assert_eq!(duplicate["claimed"], false);
    assert!(h.events().is_empty());
    assert!(h.call("goals.report",json!({"sessionId":h.session,"goalId":id,"turnId":"execution-1","progressSummary":"x","status":"active","outcomes":[],"budget":{"maxTurns":999}})).await.is_err());
    assert!(h.events().is_empty());
    let reported=h.call("goals.report",json!({"sessionId":h.session,"goalId":id,"turnId":"execution-1","progressSummary":"first round","status":"active","outcomes":[]})).await.unwrap();
    assert_eq!(h.events().len(), 1);
    let paused=h.call("goals.control",json!({"sessionId":h.session,"goalId":id,"expectedRevision":reported["goal"]["revision"],"action":"pause"})).await.unwrap();
    assert_eq!(paused["goal"]["activeTurnId"], "execution-1");
    assert_eq!(h.events().len(), 1);
    assert_eq!(paused["goal"]["status"], "active");
    assert_eq!(paused["goal"]["pauseRequested"], true);
    h.call(
        "goals.validateTurn",
        json!({"sessionId":h.session,"goalId":id,"turnId":"execution-1"}),
    )
    .await
    .unwrap();
    let settled = h
        .call(
            "goals.settleTurn",
            json!({"sessionId":h.session,"goalId":id,"turnId":"execution-1","tokens":45}),
        )
        .await
        .unwrap();
    assert_eq!(settled["goal"]["status"], "paused");
    assert_eq!(settled["goal"]["tokenUsage"], 45);
    assert!(settled["goal"].get("activeTurnId").is_none());
    assert_eq!(h.events().len(), 1);
    let duplicate = h
        .call(
            "goals.settleTurn",
            json!({"sessionId":h.session,"goalId":id,"turnId":"execution-1","tokens":45}),
        )
        .await
        .unwrap();
    assert_eq!(duplicate, settled);
    assert!(h.events().is_empty());
    h.call("goals.control",json!({"sessionId":h.session,"goalId":id,"expectedRevision":settled["goal"]["revision"],"action":"resume"})).await.unwrap();
    assert_eq!(h.events().len(), 1);
    h.call("session.configure", json!({"id":h.session,"mode":"agent"}))
        .await
        .unwrap();
    let events = h.events();
    assert!(events.is_empty());
    assert_eq!(
        h.call("goals.get", json!({"sessionId":h.session}))
            .await
            .unwrap()["goal"]["status"],
        "active"
    );
}
#[tokio::test]
async fn goals_ask_write_denial_and_scheduled_creation_remain_enforced() {
    let mut h = Harness::new();
    let state = h.state.clone();
    let tx = h.tx.clone();
    let session = h.session.clone();
    let pending = tokio::spawn(async move {
        handle_request(
            state,
            "tools.execute",
            json!({
                "sessionId":session,"toolCallId":"goal-write","toolName":"Write","mode":"goal",
                "args":{"path":"denied.txt","content":"must not write"}
            }),
            tx,
        )
        .await
    });
    let notice: Value = serde_json::from_str(&h.rx.recv().await.unwrap()).unwrap();
    assert_eq!(notice["method"], "permissions.request");
    h.call(
        "permissions.resolve",
        json!({"requestId":notice["params"]["requestId"],"decision":"deny"}),
    )
    .await
    .unwrap();
    let denied = pending.await.unwrap().unwrap();
    assert_eq!(denied["errorCode"], "TOOL_DENIED");
    assert_eq!(denied["ok"], false);
    assert!(!h._dir.path().join("project/denied.txt").exists());
    {
        let st = h.state.lock().await;
        sessions::configure_session_with_thinking(
            &st.db,
            &h.session,
            "goal",
            None,
            None,
            None,
            Some("auto"),
        )
        .unwrap();
    }
    let refused=h.call("tools.execute",json!({"sessionId":h.session,"toolCallId":"schedule","toolName":"ScheduledTaskCreate","mode":"goal",
        "args":{"title":"forbidden","prompt":"run","cadence":"hourly"}})).await.unwrap();
    assert_eq!(refused["ok"], false);
    let st = h.state.lock().await;
    assert!(crate::scheduled::list_tasks(&st.db).unwrap().is_empty());
}

#[tokio::test]
async fn goals_approved_rpc_settings_to_completion_and_rejection_notifications() {
    let mut h = Harness::new();
    h.call(
        "settings.set",
        json!({"defaultGoalBudget":{"maxTurns":null,"maxTokens":200}}),
    )
    .await
    .unwrap();
    let invalid = h
        .call(
            "goals.start",
            json!({"sessionId":h.session,"objective":"ship","budget":{"maxTokens":3}}),
        )
        .await
        .unwrap_err();
    assert_eq!(invalid.data.unwrap()["errorCode"], "INVALID_PARAMS");
    assert!(h.events().is_empty());
    let started = h
        .call(
            "goals.start",
            json!({"sessionId":h.session,"objective":"ship"}),
        )
        .await
        .unwrap();
    assert_eq!(
        started["goal"]["budget"],
        json!({"maxTurns":null,"maxTokens":200})
    );
    assert_eq!(h.events().len(), 1);
    h.call("settings.set", json!({"defaultGoalBudget":{"maxTurns":2}}))
        .await
        .unwrap();
    assert_eq!(
        h.call("goals.get", json!({"sessionId":h.session}))
            .await
            .unwrap(),
        started
    );
    assert!(h.events().is_empty());
    let id = started["goal"]["id"].clone();
    let claimed = h
        .call(
            "goals.claimTurn",
            json!({"sessionId":h.session,"goalId":id,"turnId":"audit","expectedRevision":1}),
        )
        .await
        .unwrap();
    assert_eq!(h.events().len(), 1);
    let mut input = json!({"sessionId":h.session,"goalId":id,"turnId":"audit","progressSummary":"done","status":"completed","outcomes":[{"criterion":"ship","outcome":"met","evidence":"tests passed"}]});
    let missing = h.call("goals.report", input.clone()).await.unwrap_err();
    assert_eq!(
        missing.data.unwrap()["errorCode"],
        "GOAL_COMPLETION_UNVERIFIED"
    );
    assert!(h.events().is_empty());
    assert_eq!(
        h.call("goals.get", json!({"sessionId":h.session}))
            .await
            .unwrap()["goal"],
        claimed["goal"]
    );
    let audit = json!({"version":1,"objective":"ship","items":[{"requirement":"delivery verified","outcome":"met","evidence":"current test result and inspected output"}],"remainingWork":[]});
    input["audit"] = audit.clone();
    input["audit"]["objective"] = json!("ship other work");
    let mismatch = h.call("goals.report", input.clone()).await.unwrap_err();
    assert_eq!(mismatch.data.unwrap()["errorCode"], "GOAL_INVALID_AUDIT");
    assert!(h.events().is_empty());
    input["audit"] = audit.clone();
    input["audit"]
        .as_object_mut()
        .unwrap()
        .remove("remainingWork");
    let malformed = h.call("goals.report", input.clone()).await.unwrap_err();
    assert_eq!(malformed.data.unwrap()["errorCode"], "INVALID_PARAMS");
    assert!(h.events().is_empty());
    input["audit"] = audit.clone();
    let completed = h.call("goals.report", input).await.unwrap();
    assert_eq!(completed["goal"]["status"], "completed");
    assert_eq!(completed["goal"]["audit"], audit);
    assert_eq!(h.events()[0]["params"]["goal"], completed["goal"]);
    assert_eq!(
        h.call("goals.get", json!({"sessionId":h.session}))
            .await
            .unwrap(),
        completed
    );
    let settled = h
        .call(
            "goals.settleTurn",
            json!({"sessionId":h.session,"goalId":id,"turnId":"audit","tokens":12}),
        )
        .await
        .unwrap();
    assert_eq!(settled["goal"]["status"], "completed");
    assert_eq!(settled["goal"]["tokenUsage"], 12);
    assert_eq!(settled["goal"]["audit"], audit);
}

#[tokio::test]
async fn goals_extension_edit_delete_tombstones_and_late_settlement() {
    let mut h = Harness::new();
    // Retain an older terminal row: deleting the latest must never reveal it.
    let old = h
        .call(
            "goals.start",
            json!({"sessionId":h.session,"objective":"old"}),
        )
        .await
        .unwrap();
    h.call("goals.control", json!({"sessionId":h.session,"goalId":old["goal"]["id"],"expectedRevision":1,"action":"cancel"})).await.unwrap();
    let g = h
        .call(
            "goals.start",
            json!({"sessionId":h.session,"objective":"ship"}),
        )
        .await
        .unwrap();
    let id = g["goal"]["id"].clone();
    let claimed = h
        .call(
            "goals.claimTurn",
            json!({"sessionId":h.session,"goalId":id,"expectedRevision":1,"turnId":"removed-turn"}),
        )
        .await
        .unwrap();
    h.events();
    let active_edit = h.call("goals.control", json!({"sessionId":h.session,"goalId":id,"expectedRevision":claimed["goal"]["revision"],"action":"edit","objective":"new"})).await.unwrap();
    assert_eq!(active_edit["goal"]["status"], "active");
    assert_eq!(active_edit["goal"]["activeTurnId"], "removed-turn");
    assert_eq!(h.events()[0]["params"]["goal"], active_edit["goal"]);
    let deleted = h.call("goals.control", json!({"sessionId":h.session,"goalId":id,"expectedRevision":active_edit["goal"]["revision"],"action":"delete"})).await.unwrap();
    assert_eq!(deleted, json!({"goal":null,"goalId":id,"revision":4}));
    assert_eq!(
        h.events()[0]["params"],
        json!({"sessionId":h.session,"goal":null,"goalId":id,"revision":4})
    );
    assert!(h
        .call("goals.get", json!({"sessionId":h.session}))
        .await
        .unwrap()["goal"]
        .is_null());
    for method in ["goals.validateTurn", "goals.claimTurn", "goals.report"] {
        let input = match method {
            "goals.claimTurn" => {
                json!({"sessionId":h.session,"goalId":id,"expectedRevision":4,"turnId":"no-replay"})
            }
            "goals.report" => {
                json!({"sessionId":h.session,"goalId":id,"turnId":"removed-turn","progressSummary":"stale","status":"active","outcomes":[]})
            }
            _ => json!({"sessionId":h.session,"goalId":id,"turnId":"removed-turn"}),
        };
        assert_eq!(
            h.call(method, input).await.unwrap_err().data.unwrap()["errorCode"],
            "GOAL_NOT_FOUND"
        );
    }
    let waiting = h
        .call(
            "goals.start",
            json!({"sessionId":h.session,"objective":"waiting"}),
        )
        .await
        .unwrap();
    assert_eq!(h.call("goals.claimTurn", json!({"sessionId":h.session,"goalId":waiting["goal"]["id"],"expectedRevision":1,"turnId":"too-soon"})).await.unwrap()["claimed"], false);
    h.events();
    let settled = h
        .call(
            "goals.settleTurn",
            json!({"sessionId":h.session,"goalId":id,"turnId":"removed-turn","tokens":17}),
        )
        .await
        .unwrap();
    assert_eq!(settled, json!({"goal":null,"goalId":id,"revision":5}));
    assert_eq!(h.events()[0]["params"]["goal"], Value::Null);
    let replacement = h
        .call(
            "goals.start",
            json!({"sessionId":h.session,"objective":"replacement"}),
        )
        .await
        .unwrap();
    h.events();
    let duplicate = h
        .call(
            "goals.settleTurn",
            json!({"sessionId":h.session,"goalId":id,"turnId":"removed-turn","tokens":99}),
        )
        .await
        .unwrap();
    assert_eq!(duplicate, settled);
    assert!(h.events().is_empty());
    assert_eq!(
        h.call("goals.get", json!({"sessionId":h.session}))
            .await
            .unwrap(),
        replacement
    );
}

#[tokio::test]
async fn goals_extension_timer_is_emitted_and_frozen_on_pause() {
    let h = Harness::new();
    let g = h
        .call(
            "goals.start",
            json!({"sessionId":h.session,"objective":"timer"}),
        )
        .await
        .unwrap();
    assert_eq!(g["goal"]["elapsedSeconds"].as_f64(), Some(0.0));
    assert!(g["goal"]["activeSinceMs"].as_i64().is_some_and(|n| n > 0));
    let paused = h.call("goals.control", json!({"sessionId":h.session,"goalId":g["goal"]["id"],"expectedRevision":1,"action":"pause"})).await.unwrap();
    assert!(paused["goal"]["elapsedSeconds"]
        .as_f64()
        .is_some_and(|n| n >= 0.0));
    assert!(paused["goal"].get("activeSinceMs").is_none());
}

#[tokio::test]
async fn goals_extension_rpc_pause_settle_edit_and_explicit_resume_user_path() {
    let mut h = Harness::new();
    let g = h
        .call(
            "goals.start",
            json!({"sessionId":h.session,"objective":"before"}),
        )
        .await
        .unwrap();
    let id = g["goal"]["id"].clone();
    h.call(
        "goals.claimTurn",
        json!({"sessionId":h.session,"goalId":id,"expectedRevision":1,"turnId":"edit"}),
    )
    .await
    .unwrap();
    h.call("goals.report", json!({"sessionId":h.session,"goalId":id,"turnId":"edit","progressSummary":"old progress","status":"active","outcomes":[]})).await.unwrap();
    h.call(
        "goals.control",
        json!({"sessionId":h.session,"goalId":id,"expectedRevision":3,"action":"pause"}),
    )
    .await
    .unwrap();
    let edited = h.call("goals.control", json!({"sessionId":h.session,"goalId":id,"expectedRevision":4,"action":"edit","objective":"after"})).await.unwrap();
    assert_eq!(edited["goal"]["status"], "active");
    assert_eq!(edited["goal"]["pauseRequested"], true);
    assert_eq!(edited["goal"]["criteria"], json!(["after"]));
    assert_eq!(edited["goal"]["progressSummary"], "");
    let current = h
        .call(
            "goals.validateTurn",
            json!({"sessionId":h.session,"goalId":id,"turnId":"edit"}),
        )
        .await
        .unwrap();
    assert_eq!(current["goal"]["objective"], "after");
    h.events();
    let settled = h
        .call(
            "goals.settleTurn",
            json!({"sessionId":h.session,"goalId":id,"turnId":"edit","tokens":15}),
        )
        .await
        .unwrap();
    assert_eq!(settled["goal"]["status"], "paused");
    assert_eq!(settled["goal"]["pauseRequested"], false);
    assert_eq!(settled["goal"]["criteria"], json!(["after"]));
    assert_eq!(settled["goal"]["progressSummary"], "");
    assert_eq!(settled["goal"]["roundsStarted"], 1);
    assert_eq!(settled["goal"]["tokenUsage"], 15);
    assert_eq!(h.events()[0]["params"]["goal"], settled["goal"]);
    assert_eq!(
        h.call("goals.get", json!({"sessionId":h.session}))
            .await
            .unwrap(),
        settled
    );
    let resumed = h
        .call(
            "goals.control",
            json!({"sessionId":h.session,"goalId":id,"expectedRevision":6,"action":"resume"}),
        )
        .await
        .unwrap();
    assert_eq!(resumed["goal"]["status"], "active");
}

#[tokio::test]
async fn goals_extension_removed_recovered_claim_only_emits_tombstones_after_replacement() {
    let mut h = Harness::new();
    let g = h
        .call(
            "goals.start",
            json!({"sessionId":h.session,"objective":"remove"}),
        )
        .await
        .unwrap();
    let id = g["goal"]["id"].clone();
    h.call(
        "goals.claimTurn",
        json!({"sessionId":h.session,"goalId":id,"expectedRevision":1,"turnId":"lost"}),
    )
    .await
    .unwrap();
    h.call(
        "goals.control",
        json!({"sessionId":h.session,"goalId":id,"expectedRevision":2,"action":"delete"}),
    )
    .await
    .unwrap();
    {
        let st = h.state.lock().await;
        goals::recover(&st.db).unwrap();
    }
    assert!(h
        .call("goals.get", json!({"sessionId":h.session}))
        .await
        .unwrap()["goal"]
        .is_null());
    let replacement = h
        .call(
            "goals.start",
            json!({"sessionId":h.session,"objective":"new"}),
        )
        .await
        .unwrap();
    h.events();
    let late = h
        .call(
            "goals.settleTurn",
            json!({"sessionId":h.session,"goalId":id,"turnId":"lost","tokens":7,"aborted":true}),
        )
        .await
        .unwrap();
    assert_eq!(late, json!({"goal":null,"goalId":id,"revision":5}));
    assert_eq!(
        h.events()[0]["params"],
        json!({"sessionId":h.session,"goal":null,"goalId":id,"revision":5})
    );
    assert_eq!(
        h.call("goals.get", json!({"sessionId":h.session}))
            .await
            .unwrap(),
        replacement
    );
}

#[path = "goals_refinement_rpc_tests.rs"]
mod refinement;
