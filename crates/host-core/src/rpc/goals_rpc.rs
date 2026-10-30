//! Thin trusted-host RPC adapter. User authority belongs to the TS ingress;
//! model reports have their own strict shape and cannot edit control fields.
use super::{emit_notification, rpc_err, AppState, JsonRpcError};
use crate::goals;
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};

fn parse<T: DeserializeOwned>(value: Value) -> Result<T, JsonRpcError> {
    serde_json::from_value(value)
        .map_err(|error| rpc_err(1002, error.to_string(), "INVALID_PARAMS"))
}
fn error(error: anyhow::Error) -> JsonRpcError {
    let message = error.to_string();
    if message.starts_with("GOAL_") {
        rpc_err(1002, &message, &message)
    } else {
        rpc_err(1000, message, "INTERNAL")
    }
}
fn result(goal: &goals::SessionGoal) -> Value {
    if goal.deleted {
        json!({"goal":null,"goalId":goal.id,"revision":goal.revision})
    } else {
        json!({"goal":goal})
    }
}
pub async fn notify(tx: &mpsc::UnboundedSender<String>, goal: &goals::SessionGoal) {
    let mut payload = result(goal);
    payload["sessionId"] = json!(goal.session_id);
    emit_notification(tx, "goals.changed", payload).await;
}
/// Capture only for notification wiring; the existing configure path owns its
/// session-not-found response and its Plan approval/configuration gate.
pub fn before_configure(
    st: &AppState,
    session: &str,
) -> Result<Option<goals::SessionGoal>, JsonRpcError> {
    match goals::get(&st.db, session) {
        Ok(goal) => Ok(goal),
        Err(e) if e.to_string() == "GOAL_SESSION_NOT_FOUND" => Ok(None),
        Err(e) => Err(error(e)),
    }
}
pub fn after_configure(
    st: &AppState,
    before: Option<goals::SessionGoal>,
) -> Result<Option<goals::SessionGoal>, JsonRpcError> {
    let Some(before) = before else {
        return Ok(None);
    };
    Ok(goals::get(&st.db, &before.session_id)
        .map_err(error)?
        .filter(|goal| goal.id == before.id && goal.revision != before.revision))
}

pub async fn handle(
    state: &Arc<Mutex<AppState>>,
    tx: &mpsc::UnboundedSender<String>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    let st = state.lock().await;
    if st.shutting_down {
        return Err(rpc_err(1001, "host is shutting down", "HOST_SHUTTING_DOWN"));
    }
    let (goal, changed, claimed) = match method {
        "goals.get" => {
            let p: goals::GetParams = parse(params)?;
            return Ok(json!({"goal":goals::get(&st.db, &p.session_id).map_err(error)?}));
        }
        "goals.validateTurn" => {
            return Ok(json!({"goal":goals::validate_turn(&st.db, parse(params)?).map_err(error)?}))
        }
        "goals.start" => (
            goals::start(&st.db, parse(params)?).map_err(error)?,
            true,
            None,
        ),
        "goals.control" => (
            goals::control(&st.db, parse(params)?).map_err(error)?,
            true,
            None,
        ),
        "goals.report" => (
            goals::report(&st.db, parse(params)?).map_err(error)?,
            true,
            None,
        ),
        "goals.claimTurn" => {
            let p: goals::ClaimParams = parse(params)?;
            let before = goals::get(&st.db, &p.session_id).map_err(error)?;
            let (goal, claimed) = goals::claim_turn(&st.db, p).map_err(error)?;
            let changed = before
                .as_ref()
                .is_some_and(|g| g.id == goal.id && g.revision != goal.revision);
            (goal, changed, Some(claimed))
        }
        "goals.settleTurn" => {
            let (goal, changed) = goals::settle_turn(&st.db, parse(params)?).map_err(error)?;
            (goal, changed, None)
        }
        _ => return Err(rpc_err(-32601, "unknown goal method", "NOT_FOUND")),
    };
    if changed {
        notify(tx, &goal).await;
    }
    let mut result = result(&goal);
    if let Some(claimed) = claimed {
        result["claimed"] = json!(claimed);
    }
    Ok(result)
}

#[cfg(test)]
#[path = "goals_rpc_tests.rs"]
mod tests;
