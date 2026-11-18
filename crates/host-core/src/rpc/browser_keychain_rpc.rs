use serde_json::{json, Value};

use super::{rpc_err, JsonRpcError};
use crate::browser_keychain::{read_chrome_safe_storage_password, KeychainReadError};

/// Returns Chrome's cookie-encryption secret to Electron Main.
///
/// The Keychain consent prompt blocks until the user answers, so the read runs
/// on the blocking pool; the request budget still bounds the wait. The method
/// is deliberately absent from the sidecar `host.proxy` allowlist.
pub(super) async fn handle() -> Result<Value, JsonRpcError> {
    let outcome = tokio::task::spawn_blocking(read_chrome_safe_storage_password)
        .await
        .map_err(|error| rpc_err(1000, error.to_string(), "INTERNAL"))?;
    match outcome {
        Ok(password) => Ok(json!({ "password": password })),
        Err(error) => {
            let code = match error {
                KeychainReadError::Denied => 1001,
                KeychainReadError::Unsupported => 1004,
                _ => 1000,
            };
            Err(rpc_err(code, error.to_string(), error.error_code()))
        }
    }
}
