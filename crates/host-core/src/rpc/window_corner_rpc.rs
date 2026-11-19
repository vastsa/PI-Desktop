use serde::Deserialize;
use serde_json::Value;

#[cfg(windows)]
use serde_json::json;

use super::{rpc_err, window_owner, JsonRpcError};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetNativeCornerPreferenceParams {
    native_handle: String,
    owner_pid: u32,
    preference: String,
}

pub(super) fn handle(params: Value) -> Result<Value, JsonRpcError> {
    let request: SetNativeCornerPreferenceParams = serde_json::from_value(params)
        .map_err(|error| rpc_err(1002, error.to_string(), "INVALID_PARAMS"))?;
    let native_handle = window_owner::parse_native_handle(&request.native_handle)?;
    let rounded = match request.preference.as_str() {
        "round" => true,
        "square" => false,
        _ => {
            return Err(rpc_err(
                1002,
                "invalid native window corner preference",
                "INVALID_PARAMS",
            ));
        }
    };
    let electron_pid = window_owner::electron_owner_pid(request.owner_pid)?;

    #[cfg(windows)]
    {
        apply_windows_corner_preference(native_handle, electron_pid, rounded)
            .map_err(|error| rpc_err(1000, error, "INTERNAL"))?;
        Ok(json!({ "rounded": rounded }))
    }
    #[cfg(not(windows))]
    {
        let _ = (native_handle, rounded, electron_pid);
        Err(rpc_err(
            1004,
            "native Windows corner preferences are unsupported on this platform",
            "UNSUPPORTED",
        ))
    }
}

#[cfg(windows)]
fn apply_windows_corner_preference(
    native_handle: usize,
    electron_pid: u32,
    rounded: bool,
) -> Result<(), String> {
    use std::ffi::c_void;
    use std::mem::size_of;
    use windows_sys::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_DONOTROUND, DWMWCP_ROUND,
    };
    let hwnd = window_owner::owned_hwnd(native_handle, electron_pid)?;

    let preference = if rounded {
        DWMWCP_ROUND
    } else {
        DWMWCP_DONOTROUND
    };
    let result = unsafe {
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_WINDOW_CORNER_PREFERENCE as u32,
            (&preference as *const i32).cast::<c_void>(),
            size_of::<i32>() as u32,
        )
    };
    if result < 0 {
        return Err(format!(
            "DwmSetWindowAttribute failed with HRESULT 0x{:08X}",
            result as u32,
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rejects_invalid_handle_and_preference_before_platform_call() {
        let invalid_handle = handle(json!({
            "nativeHandle": "0",
            "ownerPid": 42,
            "preference": "round"
        }))
        .unwrap_err();
        assert_eq!(invalid_handle.data.unwrap()["errorCode"], "INVALID_PARAMS");

        let invalid_preference = handle(json!({
            "nativeHandle": "42",
            "ownerPid": 42,
            "preference": "custom"
        }))
        .unwrap_err();
        assert_eq!(
            invalid_preference.data.unwrap()["errorCode"],
            "INVALID_PARAMS"
        );
    }
}
