use super::{rpc_err, AppState, JsonRpcError, Value};

pub(super) fn enabled(st: &AppState) -> Result<bool, JsonRpcError> {
    let settings = st
        .db
        .get_setting("app")
        .map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))?;
    Ok(settings
        .as_ref()
        .and_then(|settings| settings.get("scheduledTasksEnabled"))
        .and_then(Value::as_bool)
        .unwrap_or(true))
}

pub(super) fn require_enabled(st: &AppState) -> Result<(), JsonRpcError> {
    if !enabled(st)? {
        return Err(rpc_err(
            1002,
            "scheduled tasks are disabled",
            "INVALID_PARAMS",
        ));
    }
    Ok(())
}
