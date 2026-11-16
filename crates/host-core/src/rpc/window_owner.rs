use super::{rpc_err, JsonRpcError};

pub(super) fn parse_native_handle(value: &str) -> Result<usize, JsonRpcError> {
    value
        .parse::<usize>()
        .ok()
        .filter(|handle| *handle != 0)
        .ok_or_else(|| rpc_err(1002, "invalid native window handle", "INVALID_PARAMS"))
}

pub(super) fn electron_owner_pid(request_pid: u32) -> Result<u32, JsonRpcError> {
    let pid = std::env::var("PI_DESKTOP_ELECTRON_PID")
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
    validate_owner_pid(request_pid, pid)?;
    Ok(pid)
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
pub(super) fn owned_hwnd(
    native_handle: usize,
    electron_pid: u32,
) -> Result<windows_sys::Win32::Foundation::HWND, String> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetWindowThreadProcessId, IsWindow};
    let hwnd = native_handle as windows_sys::Win32::Foundation::HWND;
    if unsafe { IsWindow(hwnd) } == 0 {
        return Err("native window handle is not a live window".to_string());
    }
    let mut actual_owner_pid = 0;
    if unsafe { GetWindowThreadProcessId(hwnd, &mut actual_owner_pid) } == 0 {
        return Err("native window owner could not be read".to_string());
    }
    if actual_owner_pid != electron_pid {
        return Err("native window is not owned by the Electron process".to_string());
    }
    Ok(hwnd)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_window_owner_must_match_electron() {
        assert!(validate_owner_pid(42, 42).is_ok());
        let error = validate_owner_pid(41, 42).unwrap_err();
        assert_eq!(error.data.unwrap()["errorCode"], "UNAUTHORIZED");
    }

    #[test]
    fn native_handles_must_be_nonzero_decimal_integers() {
        assert_eq!(parse_native_handle("42").unwrap(), 42);
        for value in ["0", "-1", "0x42", "not-a-handle", "18446744073709551616"] {
            assert_eq!(
                parse_native_handle(value).unwrap_err().data.unwrap()["errorCode"],
                "INVALID_PARAMS"
            );
        }
    }
}
