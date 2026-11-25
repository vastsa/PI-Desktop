//! `modes.*` through the real RPC entry point: configure with a snapshot,
//! run gates through `tools.execute`, the Host-turn permission cap, the
//! notification stream, legacy Goal activation and startup recovery.

use std::fs;
use std::sync::Arc;

use serde_json::{json, Value};
use tokio::sync::{mpsc, Mutex};

use super::super::handle_request;
use crate::sessions;
use crate::state::AppState;

struct Harness {
    _dir: tempfile::TempDir,
    data_dir: std::path::PathBuf,
    state: Arc<Mutex<AppState>>,
    tx: mpsc::UnboundedSender<String>,
    rx: mpsc::UnboundedReceiver<String>,
    session_id: String,
}

impl Harness {
    fn new(mode: &str) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path().to_path_buf();
        let project = dir.path().join("project");
        fs::create_dir_all(&project).unwrap();
        let mut app_state = AppState::open(dir.path()).unwrap();
        app_state.handshook = true;
        let session = sessions::create_session(
            &app_state.db,
            Some("Modes".into()),
            Some(mode.into()),
            None,
            None,
            Some(project.to_string_lossy().into_owned()),
        )
        .unwrap();
        let (tx, rx) = mpsc::unbounded_channel();
        Self {
            _dir: dir,
            data_dir,
            state: Arc::new(Mutex::new(app_state)),
            tx,
            rx,
            session_id: session.id,
        }
    }

    async fn call(&self, method: &str, params: Value) -> Result<Value, Value> {
        handle_request(self.state.clone(), method, params, self.tx.clone())
            .await
            .map_err(|error| serde_json::to_value(error).unwrap())
    }

    fn mode_events(&mut self) -> Vec<Value> {
        let mut events = Vec::new();
        while let Ok(line) = self.rx.try_recv() {
            let note: Value = serde_json::from_str(line.trim()).unwrap();
            if note["method"] == "modes.changed" {
                events.push(note["params"].clone());
            }
        }
        events
    }

    async fn configure(&self, mode: &str, snapshot: Option<Value>) -> Result<Value, Value> {
        let mut params = json!({
            "id": self.session_id,
            "mode": mode,
            "permissionMode": "auto",
        });
        if let Some(snapshot) = snapshot {
            params["modeSnapshot"] = snapshot;
        }
        self.call("session.configure", params).await
    }

    async fn start(&self, turn: &str) -> Value {
        self.call(
            "modes.start",
            json!({ "sessionId": self.session_id, "input": "go", "turnId": turn }),
        )
        .await
        .unwrap()
    }

    async fn bash(
        &self,
        call_id: &str,
        command: &str,
        gate: Option<Value>,
    ) -> Result<Value, Value> {
        let shell = crate::tools::shell::default_shell_id();
        let mut params = json!({
            "sessionId": self.session_id,
            "toolCallId": call_id,
            "toolName": "Bash",
            "args": { "command": command },
            "expectedCommandShellId": shell,
            "expectedCommandShellDialect": crate::tools::shell::dialect_for_id(shell),
            "mode": "agent"
        });
        if let Some(gate) = gate {
            params["modeGate"] = gate;
        }
        self.call("tools.execute", params).await
    }
}

#[cfg(windows)]
const PASS: &str = "[Console]::Out.Write('gate-ok')";
#[cfg(not(windows))]
const PASS: &str = "printf gate-ok";
const FAIL: &str = "exit 3";

fn run_gate(command: &str, retries: i64) -> Value {
    json!({ "kind": "run", "command": command, "timeoutMinutes": 1, "onFail": { "retries": retries } })
}

fn checks() -> Value {
    json!({
        "version": 1, "id": "checks", "label": "Checks", "description": "", "permission": "agent",
        "prompt": "", "source": "user", "artifacts": [],
        "budget": { "maxTurns": 20, "maxTokens": null }, "returnTo": "agent",
        "stages": [
            { "id": "build", "permission": "agent", "exit": [run_gate(PASS, 0)], "next": "verify" },
            { "id": "verify", "permission": "agent", "exit": [run_gate(FAIL, 0)] }
        ]
    })
}

fn error_code(error: &Value) -> &str {
    error["data"]["errorCode"].as_str().unwrap_or_default()
}

#[tokio::test]
async fn run_gates_use_the_exit_code_tools_execute_recorded() {
    let mut h = Harness::new("agent");
    h.configure("checks", Some(checks())).await.unwrap();
    let started = h.start("t1").await;
    assert_eq!(started["claimed"], true);
    assert_eq!(started["enteredStage"], true);
    assert_eq!(started["definition"]["id"], "checks");
    let run_id = started["run"]["id"].as_str().unwrap().to_string();
    let events = h.mode_events();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["sessionId"], h.session_id);
    assert_eq!(events[0]["run"]["id"], run_id.as_str());

    let gate = json!({ "runId": run_id, "gateIndex": 0 });
    // Nothing is pending yet: the gate call is refused without running.
    let early = h.bash("early", PASS, Some(gate.clone())).await.unwrap_err();
    assert_eq!(error_code(&early), "MODE_GATE_MISMATCH");

    let outcome = h
        .call(
            "modes.completeStage",
            json!({ "sessionId": h.session_id, "runId": run_id, "turnId": "t1", "summary": "built" }),
        )
        .await
        .unwrap();
    assert_eq!(outcome["status"], "run");
    assert_eq!(outcome["command"], PASS);
    assert_eq!(outcome["timeoutMinutes"], 1);

    let altered = h
        .bash("altered", "echo different", Some(gate.clone()))
        .await
        .unwrap_err();
    assert_eq!(error_code(&altered), "MODE_GATE_MISMATCH");
    let missing = h
        .call(
            "modes.gateResult",
            json!({ "sessionId": h.session_id, "runId": run_id, "turnId": "t1", "gateIndex": 0, "toolCallId": "altered" }),
        )
        .await
        .unwrap_err();
    assert_eq!(error_code(&missing), "MODE_GATE_RESULT_MISSING");

    let ran = h.bash("gate-0", PASS, Some(gate)).await.unwrap();
    assert_eq!(ran["ok"], true);
    let advanced = h
        .call(
            "modes.gateResult",
            json!({ "sessionId": h.session_id, "runId": run_id, "turnId": "t1", "gateIndex": 0, "toolCallId": "gate-0" }),
        )
        .await
        .unwrap();
    assert_eq!(advanced["status"], "advanced");
    assert_eq!(advanced["nextStageId"], "verify");
    // Consumed once.
    let replay = h
        .call(
            "modes.gateResult",
            json!({ "sessionId": h.session_id, "runId": run_id, "turnId": "t1", "gateIndex": 0, "toolCallId": "gate-0" }),
        )
        .await
        .unwrap_err();
    assert_eq!(error_code(&replay), "MODE_GATE_MISMATCH");

    let settled = h
        .call(
            "modes.settleTurn",
            json!({ "sessionId": h.session_id, "runId": run_id, "turnId": "t1", "tokens": 10, "outcome": "completed" }),
        )
        .await
        .unwrap();
    assert_eq!(settled["continue"], true);
    let revision = settled["run"]["revision"].as_i64().unwrap();
    let claimed = h
        .call(
            "modes.claimTurn",
            json!({ "sessionId": h.session_id, "runId": run_id, "expectedRevision": revision, "turnId": "t2", "origin": "host" }),
        )
        .await
        .unwrap();
    assert_eq!(claimed["claimed"], true);
    assert_eq!(claimed["enteredStage"], true);
    let verify = h
        .call(
            "modes.completeStage",
            json!({ "sessionId": h.session_id, "runId": run_id, "turnId": "t2", "summary": "verify" }),
        )
        .await
        .unwrap();
    assert_eq!(verify["status"], "run");
    // Host-origin continuations use accept-edits even in an Auto session.
    // Resolve the real permission request instead of leaving this test waiting.
    let state = h.state.clone();
    let tx = h.tx.clone();
    let shell = crate::tools::shell::default_shell_id();
    let execute = tokio::spawn(handle_request(
        state,
        "tools.execute",
        json!({
            "sessionId": h.session_id, "turnId": "t2", "toolCallId": "gate-1",
            "toolName": "Bash", "args": { "command": FAIL }, "mode": "agent",
            "expectedCommandShellId": shell,
            "expectedCommandShellDialect": crate::tools::shell::dialect_for_id(shell),
            "modeGate": { "runId": run_id, "gateIndex": 0 }
        }),
        tx,
    ));
    let mut observed_mode_events = Vec::new();
    let approval = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let line = h.rx.recv().await.expect("permission stream remains open");
            let event: Value = serde_json::from_str(&line).unwrap();
            if event["method"] == "modes.changed" {
                observed_mode_events.push(event["params"].clone());
            }
            if event["method"] == "permissions.request" {
                break event;
            }
        }
    })
    .await
    .expect("host continuation must request approval");
    h.call(
        "permissions.resolve",
        json!({
            "requestId": approval["params"]["requestId"], "decision": "allow-once"
        }),
    )
    .await
    .unwrap();
    let failed = tokio::time::timeout(std::time::Duration::from_secs(10), execute)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(failed["ok"], false);
    let blocked = h
        .call(
            "modes.gateResult",
            json!({ "sessionId": h.session_id, "runId": run_id, "turnId": "t2", "gateIndex": 0, "toolCallId": "gate-1" }),
        )
        .await
        .unwrap();
    assert_eq!(blocked["status"], "blocked");
    assert!(blocked["message"]
        .as_str()
        .unwrap()
        .contains("exited with code 3"));
    assert_eq!(blocked["run"]["state"], "waiting");
    assert_eq!(blocked["run"]["waitReason"], "retries");
    observed_mode_events.extend(h.mode_events());
    assert!(observed_mode_events.len() >= 6);

    let got = h
        .call("modes.get", json!({ "sessionId": h.session_id }))
        .await
        .unwrap();
    assert_eq!(got["run"]["id"], run_id.as_str());
}

#[tokio::test]
async fn host_started_turns_are_capped_at_accept_edits() {
    let h = Harness::new("agent");
    let def = json!({
        "version": 1, "id": "grind", "label": "Grind", "description": "", "permission": "agent",
        "prompt": "", "source": "user", "artifacts": [],
        "budget": { "maxTurns": 20, "maxTokens": null }, "returnTo": "agent",
        "stages": [{ "id": "work", "permission": "agent", "loop": true, "exit": [] }]
    });
    h.configure("grind", Some(def)).await.unwrap();
    let evaluate = || {
        h.call(
            "permissions.evaluate",
            json!({ "sessionId": h.session_id, "toolName": "Bash", "args": { "command": "ls" } }),
        )
    };
    let started = h.start("t1").await;
    // A user turn keeps the session's `auto`.
    assert!(!evaluate().await.unwrap()["decision"].is_null());
    let run_id = started["run"]["id"].as_str().unwrap().to_string();
    let settled = h
        .call(
            "modes.settleTurn",
            json!({ "sessionId": h.session_id, "runId": run_id, "turnId": "t1", "tokens": 0, "outcome": "completed" }),
        )
        .await
        .unwrap();
    assert_eq!(settled["continue"], true);
    let claimed = h
        .call(
            "modes.claimTurn",
            json!({
                "sessionId": h.session_id, "runId": run_id,
                "expectedRevision": settled["run"]["revision"], "turnId": "t2", "origin": "host"
            }),
        )
        .await
        .unwrap();
    assert_eq!(claimed["claimed"], true);
    assert_eq!(claimed["run"]["activeOrigin"], "host");
    // Nobody watches a continuation: Bash prompts again under accept-edits.
    assert!(evaluate().await.unwrap()["decision"].is_null());
}

#[tokio::test]
async fn configure_validates_the_mode_snapshot() {
    let h = Harness::new("agent");
    let required = h.configure("custom", None).await.unwrap_err();
    assert_eq!(error_code(&required), "MODE_SNAPSHOT_REQUIRED");
    assert_eq!(required["code"], 1002);
    let mut bad = checks();
    bad["stages"][0]["exit"][0]["timeoutMinutes"] = json!(600);
    let invalid = h.configure("checks", Some(bad)).await.unwrap_err();
    assert_eq!(error_code(&invalid), "MODE_SNAPSHOT_INVALID");
    assert_eq!(invalid["code"], 1002);
    let mismatched = h.configure("other", Some(checks())).await.unwrap_err();
    assert_eq!(error_code(&mismatched), "MODE_SNAPSHOT_INVALID");

    let configured = h.configure("checks", Some(checks())).await.unwrap();
    assert_eq!(configured["session"]["mode"], "checks");
    let st = h.state.lock().await;
    assert_eq!(
        sessions::session_mode(&st.db, &h.session_id)
            .unwrap()
            .as_deref(),
        Some("checks")
    );
}

#[tokio::test]
async fn legacy_goal_activation_is_disabled() {
    let h = Harness::new("agent");
    let turn_id = {
        let st = h.state.lock().await;
        sessions::begin_turn(&st.db, &h.session_id, None, None).unwrap()
    };
    let entered = h
        .call(
            "plans.enter",
            json!({ "sessionId": h.session_id, "turnId": turn_id, "toolCallId": "enter", "kind": "goal" }),
        )
        .await
        .unwrap_err();
    assert_eq!(error_code(&entered), "PLAN_GOAL_ACTIVATION_DISABLED");
    let submitted = h
        .call(
            "plans.submit",
            json!({
                "sessionId": h.session_id, "turnId": turn_id, "toolCallId": "submit", "kind": "goal",
                "title": "Goal", "markdown": "# Goal", "question": "Approve?"
            }),
        )
        .await
        .unwrap_err();
    assert_eq!(error_code(&submitted), "PLAN_GOAL_ACTIVATION_DISABLED");
    let st = h.state.lock().await;
    assert_eq!(
        sessions::session_mode(&st.db, &h.session_id)
            .unwrap()
            .as_deref(),
        Some("agent")
    );
}

#[tokio::test]
async fn reopening_the_host_pauses_claimed_runs() {
    let h = Harness::new("agent");
    h.configure("checks", Some(checks())).await.unwrap();
    let started = h.start("t1").await;
    assert_eq!(started["run"]["state"], "running");
    let data_dir = h.data_dir.clone();
    let session_id = h.session_id.clone();
    drop(h.state);
    let reopened = AppState::open(&data_dir).unwrap();
    let run = crate::mode_runs::open_run(&reopened.db, &session_id)
        .unwrap()
        .unwrap();
    let wire = run.wire();
    assert_eq!(wire["state"], "paused");
    assert!(wire.get("activeTurnId").is_none() && wire.get("activeOrigin").is_none());
}

#[tokio::test]
async fn builtin_goal_continuations_inherit_the_session_permission() {
    for permission in ["auto", "ask", "accept-edits"] {
        let h = Harness::new("agent");
        let definition = goal_definition();
        h.call("session.configure", json!({
            "id": h.session_id, "mode": "goal", "modeSnapshot": definition, "permissionMode": permission
        })).await.unwrap();
        let first = h.start("first-goal-turn").await;
        let run_id = first["run"]["id"].as_str().unwrap();
        let evaluate = || {
            h.call("permissions.evaluate", json!({
            "sessionId": h.session_id, "toolName": "Bash", "args": { "command": "echo goal" }
        }))
        };
        let expected = if permission == "auto" {
            json!("allow-once")
        } else {
            Value::Null
        };
        assert_eq!(evaluate().await.unwrap()["decision"], expected);
        h.call("modes.resetGoalInput", json!({ "sessionId": h.session_id }))
            .await
            .unwrap();
        assert_eq!(
            h.call(
                "session.get",
                json!({ "id": h.session_id, "messageLimit": 1 })
            )
            .await
            .unwrap()["session"]["mode"],
            "agent"
        );
        let settled = h.call("modes.settleTurn", json!({
            "sessionId": h.session_id, "runId": run_id, "turnId": "first-goal-turn", "tokens": 0, "outcome": "completed"
        })).await.unwrap();
        assert_eq!(settled["continue"], true);
        let second = h
            .call(
                "modes.claimTurn",
                json!({
                    "sessionId": h.session_id, "runId": run_id, "turnId": "second-goal-turn",
                    "expectedRevision": settled["run"]["revision"], "origin": "host"
                }),
            )
            .await
            .unwrap();
        assert_eq!(second["claimed"], true);
        assert_eq!(
            evaluate().await.unwrap()["decision"],
            expected,
            "Goal + {permission}"
        );
        assert_eq!(
            h.call(
                "session.get",
                json!({"id": h.session_id, "messageLimit": 1})
            )
            .await
            .unwrap()["session"]["permissionMode"],
            permission
        );
    }
}

fn goal_definition() -> Value {
    json!({
        "version": 1, "id": "goal", "label": "Goal", "description": "", "permission": "agent",
        "prompt": "", "source": "builtin", "artifacts": [],
        "budget": { "maxTurns": 20, "maxTokens": null }, "returnTo": "agent",
        "stages": [{ "id": "work", "permission": "agent", "loop": true, "exit": [] }]
    })
}

#[tokio::test]
async fn goal_input_reset_and_replacement_keep_claims_accounting_and_plan_policy_separate() {
    let h = Harness::new("agent");
    h.configure("goal", Some(goal_definition())).await.unwrap();
    let first = h.start("old-turn").await;
    let old = first["run"]["id"].as_str().unwrap();
    h.call("modes.resetGoalInput", json!({ "sessionId": h.session_id }))
        .await
        .unwrap();
    h.configure("agent", None).await.unwrap();
    assert_eq!(
        h.call("modes.get", json!({"sessionId": h.session_id}))
            .await
            .unwrap()["run"]["state"],
        "running"
    );
    h.configure("plan", None).await.unwrap();
    let paused = h
        .call("modes.get", json!({"sessionId": h.session_id}))
        .await
        .unwrap();
    assert_eq!(paused["run"]["state"], "paused");
    {
        let st = h.state.lock().await;
        assert_eq!(
            crate::mode_runs::tool_policy(&st.db, &h.session_id).unwrap(),
            Some(crate::mode_runs::ToolPolicy::Contract)
        );
    }
    h.call("modes.control", json!({"sessionId": h.session_id, "runId": old, "expectedRevision": paused["run"]["revision"], "action": "stop"})).await.unwrap();
    let second = h.call("modes.startGoal", json!({"sessionId": h.session_id, "turnId": "new-turn", "input": "replacement", "modeSnapshot": goal_definition()})).await.unwrap();
    let new = second["run"]["id"].as_str().unwrap();
    assert_ne!(new, old);
    h.call("modes.resetGoalInput", json!({"sessionId": h.session_id}))
        .await
        .unwrap();
    assert_eq!(
        h.call(
            "session.get",
            json!({"id": h.session_id, "messageLimit": 1})
        )
        .await
        .unwrap()["session"]["mode"],
        "plan",
        "newer Plan selection wins"
    );
    let settlement = json!({"sessionId": h.session_id, "runId": old, "turnId": "old-turn", "tokens": 7, "outcome": "aborted"});
    let ended = h
        .call("modes.settleTurn", settlement.clone())
        .await
        .unwrap();
    assert_eq!(ended["run"]["state"], "stopped");
    assert_eq!(ended["run"]["tokensUsed"], 7);
    assert_eq!(ended["continue"], false);
    assert_eq!(
        h.call("modes.settleTurn", settlement).await.unwrap()["run"]["tokensUsed"],
        7
    );
    let current = h
        .call("modes.get", json!({"sessionId": h.session_id}))
        .await
        .unwrap();
    assert_eq!(current["run"]["id"], new);
    assert_eq!(current["run"]["input"], "replacement");
    assert_eq!(current["run"]["tokensUsed"], 0);
    assert_eq!(current["run"]["roundsCompleted"], 0);
}

#[tokio::test]
async fn completion_report_rpc_rejects_invalid_content_without_state_or_notifications() {
    let mut h = Harness::new("agent");
    h.configure("checks", Some(checks())).await.unwrap();
    let started = h.start("report-invalid").await;
    h.mode_events();
    for report in [
        json!({}),
        Value::Null,
        json!({
            "status":"completed", "outcomes":[{"criterion":"works", "outcome":"met", "evidence":"ok", "unknown":true}], "remainingWork":[]
        }),
    ] {
        let error = h.call("modes.completeStage", json!({
            "sessionId":h.session_id, "runId":started["run"]["id"], "turnId":"report-invalid", "input":"go", "report":report
        })).await.unwrap_err();
        assert_eq!(error_code(&error), "MODE_INVALID_ARGUMENT");
        assert!(h.mode_events().is_empty());
        let current = h
            .call("modes.get", json!({"sessionId":h.session_id}))
            .await
            .unwrap();
        assert_eq!(current["run"], started["run"]);
    }
}

#[tokio::test]
async fn completion_report_rpc_completed_keeps_command_gate_and_blocked_settles_without_continue() {
    let mut h = Harness::new("agent");
    h.configure("checks", Some(checks())).await.unwrap();
    let started = h.start("report-turn").await;
    let run_id = started["run"]["id"].clone();
    let report = json!({"status":"completed", "outcomes":[{"criterion":"build", "outcome":"met", "evidence":"model claim"}], "remainingWork":[]});
    let completed = h.call("modes.completeStage", json!({
        "sessionId":h.session_id, "runId":run_id, "turnId":"report-turn", "input":"go", "report":report
    })).await.unwrap();
    assert_eq!(completed["status"], "run");
    assert_eq!(completed["command"], PASS);
    assert_eq!(completed["run"]["completionReport"], report);
    let report = json!({"status":"blocked", "outcomes":[{"criterion":"build", "outcome":"unmet", "evidence":"missing service"}], "remainingWork":[], "blockerReason":"missing service"});
    let blocked = h.call("modes.completeStage", json!({
        "sessionId":h.session_id, "runId":run_id, "turnId":"report-turn", "input":"go", "report":report
    })).await.unwrap();
    assert_eq!(blocked["status"], "blocked");
    assert_eq!(blocked["message"], "missing service");
    assert_eq!(blocked["run"]["waitReason"], "blocked");
    assert_eq!(blocked["run"]["completionReport"], report);
    let events = h.mode_events();
    assert_eq!(events.last().unwrap()["run"], blocked["run"]);
    let settled = h.call("modes.settleTurn", json!({
        "sessionId":h.session_id, "runId":run_id, "turnId":"report-turn", "tokens":42, "outcome":"completed"
    })).await.unwrap();
    assert_eq!(settled["continue"], false);
    assert_eq!(settled["run"]["tokensUsed"], 42);
    assert_eq!(settled["run"]["roundsCompleted"], 1);
    assert!(settled["run"].get("activeTurnId").is_none());
    let reopened = AppState::open(&h.data_dir).unwrap();
    let run = crate::mode_runs::open_run(&reopened.db, &h.session_id)
        .unwrap()
        .unwrap();
    assert_eq!(run.wire(), settled["run"]);
}
