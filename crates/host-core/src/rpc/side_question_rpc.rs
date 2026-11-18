use super::{json, remote_tools, rpc_err, AppState, JsonRpcError, Value};
use crate::sessions;

pub(super) fn handle(
    st: &mut AppState,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    match method {
        "session.sideQuestion.create" => {
            let id = params
                .get("parentSessionId")
                .and_then(Value::as_str)
                .ok_or_else(|| rpc_err(1002, "parentSessionId required", "INVALID_PARAMS"))?;
            if remote_tools::session_remote_workspace_optional(st, id)?.is_some() {
                return Err(rpc_err(
                    1002,
                    "Side questions require a local desktop session",
                    "INVALID_PARAMS",
                ));
            }
            let child = match sessions::side_questions::create(
                &st.db,
                id,
                params.get("title").and_then(Value::as_str),
                params
                    .get("referenceOnly")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            )
            .map_err(|error| rpc_err(1000, error.to_string(), "INTERNAL"))?
            {
                sessions::ForkSessionResult::Created(child) => child,
                sessions::ForkSessionResult::NotFound => {
                    return Err(rpc_err(1007, "session not found", "NOT_FOUND"))
                }
                sessions::ForkSessionResult::Busy => {
                    return Err(rpc_err(1008, "session is running", "CONFLICT"))
                }
            };
            if let Some(grants) = st.session_grants.get(id) {
                let inherited: Vec<_> = grants
                    .iter()
                    .filter(|name| matches!(name.as_str(), "Read" | "Glob" | "Grep"))
                    .cloned()
                    .collect();
                if !inherited.is_empty() {
                    st.session_grants
                        .insert(child.summary.id.clone(), inherited);
                }
            }
            Ok(
                json!({ "session": remote_tools::decorate_session(&st.db, serde_json::to_value(child).map_err(|error| rpc_err(1000, error.to_string(), "INTERNAL"))?)? }),
            )
        }
        "session.sideQuestion.list" => {
            let id = params
                .get("parentSessionId")
                .and_then(Value::as_str)
                .ok_or_else(|| rpc_err(1002, "parentSessionId required", "INVALID_PARAMS"))?;
            let result = sessions::side_questions::list(
                &st.db,
                id,
                params.get("query").and_then(Value::as_str).unwrap_or(""),
                params
                    .get("archived")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                params.get("limit").and_then(Value::as_i64).unwrap_or(20),
                params.get("offset").and_then(Value::as_i64).unwrap_or(0),
            )
            .map_err(|error| rpc_err(1000, error.to_string(), "INTERNAL"))?;
            serde_json::to_value(result)
                .map_err(|error| rpc_err(1000, error.to_string(), "INTERNAL"))
        }
        "session.sideQuestion.archive" => {
            let id = params
                .get("id")
                .and_then(Value::as_str)
                .ok_or_else(|| rpc_err(1002, "id required", "INVALID_PARAMS"))?;
            let ok = sessions::side_questions::archive(
                &st.db,
                id,
                params
                    .get("archived")
                    .and_then(Value::as_bool)
                    .unwrap_or(true),
            )
            .map_err(|error| rpc_err(1000, error.to_string(), "INTERNAL"))?;
            Ok(json!({ "ok": ok }))
        }
        _ => Err(rpc_err(
            1002,
            "Unknown side-question operation",
            "INVALID_PARAMS",
        )),
    }
}
