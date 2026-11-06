use super::{goals_rpc, rpc_err, session_collaboration_rpc_err, AppState, JsonRpcError};
use crate::sessions::{self, turn_execution};
use serde_json::{json, Value};

fn required<'a>(params: &'a Value, key: &str) -> Result<&'a str, JsonRpcError> {
    params
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| rpc_err(1002, format!("{key} required"), "INVALID_PARAMS"))
}
pub fn begin(st: &AppState, params: &Value) -> Result<Value, JsonRpcError> {
    let session = required(params, "sessionId")?;
    let provider = params.get("providerId").and_then(Value::as_str);
    let model = params.get("modelId").and_then(Value::as_str);
    let turn = if let Some(binding) = params.get("goalTurn") {
        if params.get("sessionMessageId").is_some() || params.get("voiceOrigin").is_some() {
            return Err(rpc_err(
                1002,
                "Goal, collaboration and voice bindings are exclusive",
                "INVALID_PARAMS",
            ));
        }
        let binding = serde_json::from_value(binding.clone())
            .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?;
        turn_execution::begin_goal_turn(&st.db, session, provider, model, binding)
    } else if let Some(message) = params.get("sessionMessageId").and_then(Value::as_str) {
        crate::session_collaboration::begin_turn(&st.db, session, message, provider, model)
    } else {
        sessions::begin_turn(&st.db, session, provider, model)
    }
    .map_err(|e| {
        if e.to_string().starts_with("GOAL_") {
            goals_rpc::error(e)
        } else {
            session_collaboration_rpc_err(e)
        }
    })?;
    Ok(json!({"turnId":turn}))
}
pub fn get(st: &AppState, params: &Value) -> Result<Value, JsonRpcError> {
    let mode = turn_execution::turn_mode(
        st.db.conn(),
        required(params, "sessionId")?,
        Some(required(params, "turnId")?),
    )
    .map_err(goals_rpc::error)?
    .ok_or_else(|| rpc_err(1007, "session not found", "SESSION_NOT_FOUND"))?;
    Ok(json!({"mode":mode}))
}
pub fn mode(st: &AppState, session: &str, turn: Option<&str>) -> Result<String, JsonRpcError> {
    turn_execution::execution_mode(st.db.conn(), session, turn)
        .map_err(goals_rpc::error)?
        .ok_or_else(|| rpc_err(1007, "session not found", "SESSION_NOT_FOUND"))
}
