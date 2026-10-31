//! Private Host-to-Main bridge for sandboxed visualization documents.

use std::sync::Arc;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::Mutex;

use super::{rpc_err, JsonRpcError};
use crate::state::AppState;
use crate::visualizations::files::{self, FragmentReadError};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReadFragmentParams {
    session_id: String,
    file_name: String,
}

pub(super) async fn read_fragment(
    state: Arc<Mutex<AppState>>,
    params: Value,
) -> Result<Value, JsonRpcError> {
    let params: ReadFragmentParams = serde_json::from_value(params).map_err(|_| {
        rpc_err(
            1002,
            "invalid visualization read parameters",
            "INVALID_PARAMS",
        )
    })?;
    let data_dir = { state.lock().await.data_dir.clone() };
    // Filesystem work never holds the authoritative state/database lock.
    let result = tokio::task::spawn_blocking(move || {
        files::read_fragment(&data_dir, &params.session_id, &params.file_name)
    })
    .await
    .map_err(|_| rpc_err(1000, "visualization read worker failed", "INTERNAL"))?;
    Ok(match result {
        Ok(bytes) => json!({ "ok": true, "base64": STANDARD.encode(bytes) }),
        Err(FragmentReadError::NotFound) => json!({ "ok": false, "code": "not-found" }),
        Err(FragmentReadError::TooLarge) => json!({ "ok": false, "code": "too-large" }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rpc::handle_request;
    use std::fs;
    use tokio::sync::mpsc;

    fn fixture() -> (tempfile::TempDir, Arc<Mutex<AppState>>) {
        let directory = tempfile::tempdir().unwrap();
        let mut state = AppState::open(directory.path()).unwrap();
        state.handshook = true;
        (directory, Arc::new(Mutex::new(state)))
    }

    async fn call(state: Arc<Mutex<AppState>>, params: Value) -> Result<Value, JsonRpcError> {
        handle_request(
            state,
            "visualizations.readFragment",
            params,
            mpsc::unbounded_channel().0,
        )
        .await
    }

    #[tokio::test]
    async fn visualization_native_rpc_returns_bounded_bytes_without_a_workspace() {
        let (directory, state) = fixture();
        let session = directory.path().join("visualizations").join("s1");
        fs::create_dir_all(&session).unwrap();
        let file = session.join("chart.html");
        let params = json!({ "sessionId": "s1", "fileName": "chart.html" });
        fs::write(&file, "<p>native chart</p>").unwrap();
        let result = call(state.clone(), params.clone()).await.unwrap();
        assert_eq!(result["ok"], true);
        assert_eq!(
            STANDARD.decode(result["base64"].as_str().unwrap()).unwrap(),
            b"<p>native chart</p>"
        );
        fs::write(&file, vec![0; files::MAX_FRAGMENT_BYTES]).unwrap();
        let result = call(state.clone(), params.clone()).await.unwrap();
        assert_eq!(
            STANDARD
                .decode(result["base64"].as_str().unwrap())
                .unwrap()
                .len(),
            files::MAX_FRAGMENT_BYTES
        );
        fs::write(&file, vec![0; files::MAX_FRAGMENT_BYTES + 1]).unwrap();
        assert_eq!(
            call(state.clone(), params).await.unwrap(),
            json!({ "ok": false, "code": "too-large" })
        );
        assert_eq!(
            call(
                state,
                json!({ "sessionId": "s1", "fileName": "../outside.html" })
            )
            .await
            .unwrap(),
            json!({ "ok": false, "code": "not-found" })
        );
    }

    #[tokio::test]
    async fn visualization_native_rpc_rejects_caller_roots_and_malformed_parameters() {
        let (_directory, state) = fixture();
        for params in [
            json!({ "sessionId": "s1", "fileName": "chart.html", "dataDir": "/private" }),
            json!({ "sessionId": "s1", "fileName": 1 }),
            json!({ "fileName": "chart.html" }),
        ] {
            let error = call(state.clone(), params).await.unwrap_err();
            assert_eq!(error.data.unwrap()["errorCode"], "INVALID_PARAMS");
            assert!(!error.message.contains("/private"));
        }
    }
}
