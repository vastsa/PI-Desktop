//! Session-scoped model access. Desktop's existing global RPCs stay outside
//! the model-side proxy allowlist.
use super::*;
use crate::background_tasks::jobs;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    session_id: String,
    id: Option<String>,
    #[serde(default)]
    timeout_ms: u64,
}

fn authorize(st: &AppState, session_id: &str) -> Result<(), JsonRpcError> {
    let mode = sessions::session_mode(&st.db, session_id)
        .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?
        .ok_or_else(|| rpc_err(1007, "task not found", "NOT_FOUND"))?;
    if mode != "agent" {
        return Err(rpc_err(
            1001,
            "background job controls require Agent mode",
            "PERMISSION_DENIED",
        ));
    }
    if remote_tools::session_remote_workspace(st, session_id)?.is_some() {
        return Err(rpc_err(
            1002,
            "background job controls require a local workspace",
            "INVALID_PARAMS",
        ));
    }
    Ok(())
}

pub(super) async fn handle(
    state: Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    let request: Request = serde_json::from_value(params)
        .map_err(|e| rpc_err(1002, e.to_string(), "INVALID_PARAMS"))?;
    if request.timeout_ms > 1000 {
        return Err(rpc_err(
            1002,
            "timeoutMs must be at most 1000",
            "INVALID_PARAMS",
        ));
    }
    let st = state.lock().await;
    authorize(&st, &request.session_id)?;
    match method {
        "backgroundJobs.capabilities" => Ok(json!({"version": 1, "supported": true})),
        "backgroundJobs.list" => {
            let tasks: Vec<_> = st
                .background_tasks
                .tasks
                .values()
                .filter(|task| task.session_id == request.session_id)
                .cloned()
                .collect();
            drop(st);
            let mut tasks = tasks;
            tasks.sort_by_key(|task| task.started_at);
            let mut summaries = Vec::with_capacity(tasks.len());
            for task in tasks {
                summaries.push(jobs::snapshot(&task, false).await);
            }
            Ok(json!({"tasks": summaries}))
        }
        "backgroundJobs.wait" | "backgroundJobs.stop" => {
            let id = request
                .id
                .as_deref()
                .filter(|id| !id.is_empty())
                .ok_or_else(|| rpc_err(1002, "id required", "INVALID_PARAMS"))?;
            let task = jobs::find(&st.background_tasks, &request.session_id, id)
                .ok_or_else(|| rpc_err(1007, "task not found", "NOT_FOUND"))?;
            // Only a short signal operation may hold the state lock. Waiting
            // for output/exit must leave other sessions and Stop responsive.
            if method == "backgroundJobs.stop" {
                jobs::stop(&task)
                    .await
                    .map_err(|e| rpc_err(1000, e, "INTERNAL"))?;
            }
            drop(st);
            jobs::wait(&task, request.timeout_ms).await;
            let st = state.lock().await;
            authorize(&st, &request.session_id)?;
            drop(st);
            Ok(jobs::snapshot(&task, true).await)
        }
        _ => Err(rpc_err(-32601, "method not found", "METHOD_NOT_FOUND")),
    }
}
