use serde::Deserialize;
use serde_json::Value;

#[cfg(windows)]
use serde_json::json;

use super::{rpc_err, JsonRpcError};

const ELECTRON_PID_ENV: &str = "PI_DESKTOP_ELECTRON_PID";

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
    let native_handle = request
        .native_handle
        .parse::<usize>()
        .ok()
        .filter(|handle| *handle != 0)
        .ok_or_else(|| rpc_err(1002, "invalid native window handle", "INVALID_PARAMS"))?;
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
    let electron_pid = std::env::var(ELECTRON_PID_ENV)
        .ok()
        .and_then(|value| value.parse::<u32>().ok())
        .filter(|pid| *pid != 0)
        .ok_or_else(|| {
            rpc_err(
                1001,
                "Electron owner process is unavailable",
                "UNAUTHORIZED",
            )
        })?;
    validate_owner_pid(request.owner_pid, electron_pid)?;

    #[cfg(windows)]
    {
        apply_windows_corner_preference(native_handle, electron_pid, rounded)
            .map_err(|error| rpc_err(1000, error, "INTERNAL"))?;
        Ok(json!({ "rounded": rounded }))
    }
    #[cfg(not(windows))]
    {
        let _ = (native_handle, rounded);
        Err(rpc_err(
            1004,
            "native Windows corner preferences are unsupported on this platform",
            "UNSUPPORTED",
        ))
    }
}

fn validate_owner_pid(request_pid: u32, electron_pid: u32) -> Result<(), JsonRpcError> {
    if request_pid == electron_pid {
        return Ok(());
    }
    Err(rpc_err(
        1001,
        "native window owner does not match Electron",
        "UNAUTHORIZED",
    ))
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
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetWindowThreadProcessId, IsWindow};

    let hwnd = native_handle as windows_sys::Win32::Foundation::HWND;
    if unsafe { IsWindow(hwnd) } == 0 {
        return Err("native window handle is not a live window".to_string());
    }

    let mut actual_owner_pid = 0_u32;
    if unsafe { GetWindowThreadProcessId(hwnd, &mut actual_owner_pid) } == 0 {
        return Err("native window owner could not be read".to_string());
    }
    if actual_owner_pid != electron_pid {
        return Err("native window is not owned by the Electron process".to_string());
    }

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
    fn native_window_owner_must_match_electron() {
        assert!(validate_owner_pid(42, 42).is_ok());
        let error = validate_owner_pid(41, 42).unwrap_err();
        assert_eq!(error.data.unwrap()["errorCode"], "UNAUTHORIZED");
    }

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
