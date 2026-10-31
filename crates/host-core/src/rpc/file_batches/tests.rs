use super::super::handle_request;
use crate::{sessions, state::AppState};
use serde_json::{json, Value};
use std::future::{poll_fn, Future};
use std::sync::Arc;
use std::task::Poll;
use tokio::sync::{mpsc, Mutex};

async fn setup() -> (tempfile::TempDir, Arc<Mutex<AppState>>, String) {
    let dir = tempfile::tempdir().unwrap();
    let project = dir.path().join("project");
    std::fs::create_dir(&project).unwrap();
    std::fs::write(project.join("actual"), "before").unwrap();
    std::fs::hard_link(project.join("actual"), project.join("alias")).unwrap();
    let mut app = AppState::open(dir.path()).unwrap();
    app.handshook = true;
    let session = sessions::create_session(
        &app.db,
        None,
        Some("agent".into()),
        None,
        None,
        Some(project.to_string_lossy().into_owned()),
    )
    .unwrap();
    sessions::configure_session_with_thinking(
        &app.db,
        &session.id,
        "agent",
        None,
        None,
        None,
        Some("auto"),
    )
    .unwrap();
    (dir, Arc::new(Mutex::new(app)), session.id)
}

async fn request(
    state: &Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
) -> Result<Value, super::super::JsonRpcError> {
    handle_request(state.clone(), method, params, mpsc::unbounded_channel().0).await
}

#[tokio::test]
async fn file_batch_rpc_orders_real_hard_link_tools_despite_reversed_arrival() {
    for write_first in [false, true] {
        let (dir, state, session) = setup().await;
        assert_eq!(
            request(
                &state,
                "tools.fileBatchCapabilities",
                json!({"sessionId":session})
            )
            .await
            .unwrap()["supported"],
            true
        );
        let names = if write_first {
            ["Write", "Read"]
        } else {
            ["Read", "Write"]
        };
        let args = [
            json!({"path":"alias","content":"after"}),
            json!({"path":"actual","content":"after"}),
        ];
        let mut tickets = Vec::new();
        for i in 0..2 {
            let response=request(&state,"tools.fileBatchRegister",json!({
                "sessionId":session,"batchId":"batch","ordinal":i,"toolCallId":i.to_string(),"toolName":names[i],"args":args[i]
            })).await.unwrap();
            tickets.push(response["ticket"].as_str().unwrap().to_owned());
        }
        request(
            &state,
            "tools.fileBatchSeal",
            json!({"sessionId":session,"batchId":"batch"}),
        )
        .await
        .unwrap();
        let budget = state.lock().await.tool_budget.clone();
        let later_params = json!({"sessionId":session,"mode":"agent","toolCallId":"1","toolName":names[1],"args":args[1],"fileBatchTicket":tickets[1]});
        let mut later = Box::pin(request(&state, "tools.execute", later_params));
        // Poll through actual permission and blocking-pool identity resolution,
        // stopping exactly when the later call is queued behind its predecessor.
        poll_fn(|cx| {
            assert!(
                later.as_mut().poll(cx).is_pending(),
                "later RPC executed before its registered predecessor"
            );
            if budget.snapshot().queued == 1 {
                Poll::Ready(())
            } else {
                Poll::Pending
            }
        })
        .await;
        assert_eq!(budget.snapshot().active, 0);
        let first=request(&state,"tools.execute",json!({"sessionId":session,"mode":"agent","toolCallId":"0","toolName":names[0],"args":args[0],"fileBatchTicket":tickets[0]})).await.unwrap();
        let second = later.await.unwrap();
        assert_eq!(first["ok"], true, "{first}");
        assert_eq!(second["ok"], true, "{second}");
        let read = if write_first { &second } else { &first };
        assert!(
            read["content"]
                .to_string()
                .contains(if write_first { "after" } else { "before" }),
            "{read}"
        );
        assert_eq!(
            std::fs::read_to_string(dir.path().join("project/actual")).unwrap(),
            "after"
        );
        request(
            &state,
            "tools.fileBatchClose",
            json!({"sessionId":session,"batchId":"batch"}),
        )
        .await
        .unwrap();
        assert_eq!(budget.snapshot().active, 0);
        assert_eq!(budget.snapshot().queued, 0);
    }
}

#[tokio::test]
async fn file_batch_rpc_rejects_changed_arguments_and_replay_without_writing() {
    let (dir, state, session) = setup().await;
    let registration = json!({"sessionId":session,"batchId":"batch","ordinal":0,"toolCallId":"w","toolName":"Write","args":{"path":"actual","content":"allowed"}});
    let ticket = request(&state, "tools.fileBatchRegister", registration)
        .await
        .unwrap()["ticket"]
        .clone();
    request(
        &state,
        "tools.fileBatchSeal",
        json!({"sessionId":session,"batchId":"batch"}),
    )
    .await
    .unwrap();
    let call = json!({"sessionId":session,"mode":"agent","toolCallId":"w","toolName":"Write","args":{"path":"actual","content":"allowed"},"fileBatchTicket":ticket});
    let mut changed = call.clone();
    changed["args"]["content"] = json!("tampered");
    assert!(request(&state, "tools.execute", changed).await.is_err());
    assert_eq!(
        std::fs::read_to_string(dir.path().join("project/actual")).unwrap(),
        "before"
    );
    assert_eq!(
        request(&state, "tools.execute", call.clone())
            .await
            .unwrap()["ok"],
        true
    );
    assert!(request(&state, "tools.execute", call).await.is_err());
    assert_eq!(
        std::fs::read_to_string(dir.path().join("project/actual")).unwrap(),
        "allowed"
    );
    request(
        &state,
        "tools.fileBatchClose",
        json!({"sessionId":session,"batchId":"batch"}),
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn file_batch_registration_does_not_grant_permission_to_write_in_plan_mode() {
    let (dir, state, session) = setup().await;
    sessions::configure_session_with_thinking(
        &state.lock().await.db,
        &session,
        "plan",
        None,
        None,
        None,
        Some("auto"),
    )
    .unwrap();
    let ticket=request(&state,"tools.fileBatchRegister",json!({"sessionId":session,"batchId":"batch","ordinal":0,"toolCallId":"w","toolName":"Write","args":{"path":"actual","content":"forbidden"}})).await.unwrap()["ticket"].clone();
    request(
        &state,
        "tools.fileBatchSeal",
        json!({"sessionId":session,"batchId":"batch"}),
    )
    .await
    .unwrap();
    let result=request(&state,"tools.execute",json!({"sessionId":session,"mode":"agent","toolCallId":"w","toolName":"Write","args":{"path":"actual","content":"forbidden"},"fileBatchTicket":ticket})).await.unwrap();
    assert_eq!(result["ok"], false);
    assert_eq!(result["errorCode"], "WRITE_DISABLED_IN_PLAN");
    assert_eq!(
        std::fs::read_to_string(dir.path().join("project/actual")).unwrap(),
        "before"
    );
    request(
        &state,
        "tools.fileBatchClose",
        json!({"sessionId":session,"batchId":"batch"}),
    )
    .await
    .unwrap();
}
