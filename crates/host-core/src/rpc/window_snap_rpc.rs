use serde::Deserialize;
use serde_json::Value;

use super::{rpc_err, window_owner, JsonRpcError};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EnableNativeSnapParams {
    native_handle: String,
    owner_pid: u32,
}

pub(super) fn handle(params: Value) -> Result<Value, JsonRpcError> {
    let request: EnableNativeSnapParams = serde_json::from_value(params)
        .map_err(|error| rpc_err(1002, error.to_string(), "INVALID_PARAMS"))?;
    let native_handle = window_owner::parse_native_handle(&request.native_handle)?;
    let electron_pid = window_owner::electron_owner_pid(request.owner_pid)?;
    #[cfg(windows)]
    {
        let border_suppressed = enable_native_snap(native_handle, electron_pid)
            .map_err(|error| rpc_err(1000, error, "INTERNAL"))?;
        Ok(serde_json::json!({ "enabled": true, "borderSuppressed": border_suppressed }))
    }
    #[cfg(not(windows))]
    {
        let _ = (native_handle, electron_pid);
        Err(rpc_err(
            1004,
            "native Windows snapping is unsupported on this platform",
            "UNSUPPORTED",
        ))
    }
}

#[cfg(windows)]
fn enable_native_snap(native_handle: usize, electron_pid: u32) -> Result<bool, String> {
    use windows_sys::Win32::Foundation::{GetLastError, SetLastError, E_INVALIDARG};
    use windows_sys::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_BORDER_COLOR, DWMWA_COLOR_NONE,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetWindowLongW, SetWindowLongW, SetWindowPos, GWL_STYLE, SWP_FRAMECHANGED, SWP_NOACTIVATE,
        SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, WS_CAPTION, WS_THICKFRAME,
    };
    let hwnd = window_owner::owned_hwnd(native_handle, electron_pid)?;
    unsafe { SetLastError(0) };
    let style = unsafe { GetWindowLongW(hwnd, GWL_STYLE) } as u32;
    if style == 0 && unsafe { GetLastError() } != 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    // Keep Electron's thickFrame:false client layout; restore only the shell's
    // snap/animation styles. WS_CAPTION also prevents a maximized DWM rim.
    let next = style | WS_THICKFRAME | WS_CAPTION;
    if next != style {
        unsafe { SetLastError(0) };
        if unsafe { SetWindowLongW(hwnd, GWL_STYLE, next as i32) } == 0
            && unsafe { GetLastError() } != 0
        {
            return Err(std::io::Error::last_os_error().to_string());
        }
        if unsafe {
            SetWindowPos(
                hwnd,
                std::ptr::null_mut(),
                0,
                0,
                0,
                0,
                SWP_FRAMECHANGED | SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER,
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error().to_string());
        }
    }
    // Windows 11 otherwise draws a one-pixel DWM outline over the client edge.
    let color = DWMWA_COLOR_NONE;
    let result = unsafe {
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_BORDER_COLOR as u32,
            (&color as *const u32).cast(),
            std::mem::size_of::<u32>() as u32,
        )
    };
    if result == E_INVALIDARG {
        return Ok(false); // Windows 10 has no configurable DWM border color.
    }
    if result < 0 {
        return Err(format!(
            "native window border suppression failed: 0x{:08X}",
            result as u32
        ));
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_invalid_native_snap_requests_before_platform_calls() {
        for params in [
            serde_json::json!({}),
            serde_json::json!({"nativeHandle":"0","ownerPid":42}),
        ] {
            assert_eq!(
                handle(params).unwrap_err().data.unwrap()["errorCode"],
                "INVALID_PARAMS"
            );
        }
    }
}
