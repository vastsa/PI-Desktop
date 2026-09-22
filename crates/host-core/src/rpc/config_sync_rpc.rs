use crate::config_sync::engine;
use crate::state::AppState;
use anyhow::Result;
use serde_json::Value;
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};

pub(crate) async fn handle(
    state: Arc<Mutex<AppState>>,
    method: &str,
    params: Value,
    tx: mpsc::UnboundedSender<String>,
) -> Result<Value> {
    match method {
        "configSync.getState" => engine::get_state(state).await,
        "configSync.test" => engine::test(state, params).await,
        "configSync.configure" => engine::configure(state, params).await,
        "configSync.syncNow" => engine::sync_now(state, tx).await,
        "configSync.pause" => {
            let paused = params
                .get("paused")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            engine::pause(state, paused).await
        }
        "configSync.unlock" => engine::unlock(state, params).await,
        "configSync.approve" => engine::approve(state, params, tx).await,
        "configSync.reject" => engine::reject(state, params, tx).await,
        "configSync.mapProject" => engine::map_project(state, params).await,
        "configSync.listHistory" => engine::list_history(state).await,
        "configSync.restore" => engine::restore(state, params, tx).await,
        "configSync.changePassword" => engine::change_password(state, params).await,
        "configSync.disconnect" => engine::disconnect(state).await,
        _ => anyhow::bail!("CONFIG_SYNC_INVALID: unknown config sync method"),
    }
}
