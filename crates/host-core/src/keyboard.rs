//! Windows-only global keyboard fallback for shortcuts reserved by the shell.
//!
//! Electron's `globalShortcut` uses `RegisterHotKey` on Windows. The shell
//! reserves Alt+Space for the active window system menu, so that API can
//! reject the launcher's default binding. The low-level hook below is kept
//! deliberately narrow: it only consumes Alt+Space while enabled and emits
//! an ordinary host notification for Electron to handle.

#[cfg(windows)]
mod windows {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::OnceLock;
    use std::thread;

    use serde_json::json;
    use tokio::sync::mpsc;
    use windows_sys::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, DispatchMessageW, GetMessageW, SetWindowsHookExW, TranslateMessage,
        UnhookWindowsHookEx, KBDLLHOOKSTRUCT, MSG, WH_KEYBOARD_LL, WM_KEYDOWN, WM_KEYUP,
        WM_SYSKEYDOWN, WM_SYSKEYUP,
    };

    const VK_SPACE: u32 = 0x20;
    const LLKHF_ALTDOWN: u32 = 0x20;

    static ENABLED: AtomicBool = AtomicBool::new(false);
    static NOTIFY_TX: OnceLock<mpsc::UnboundedSender<String>> = OnceLock::new();
    static STARTED: AtomicBool = AtomicBool::new(false);
    static SPACE_DOWN: AtomicBool = AtomicBool::new(false);

    unsafe extern "system" fn keyboard_hook(
        code: i32,
        w_param: WPARAM,
        l_param: LPARAM,
    ) -> LRESULT {
        if code >= 0 {
            let message = w_param as u32;
            let key = &*(l_param as *const KBDLLHOOKSTRUCT);
            let is_space = key.vkCode == VK_SPACE;
            let is_key_down = message == WM_KEYDOWN || message == WM_SYSKEYDOWN;
            let is_key_up = message == WM_KEYUP || message == WM_SYSKEYUP;

            if is_space && is_key_up {
                SPACE_DOWN.store(false, Ordering::Release);
            }

            if ENABLED.load(Ordering::Acquire)
                && is_space
                && is_key_down
                && key.flags & LLKHF_ALTDOWN != 0
                && !SPACE_DOWN.swap(true, Ordering::AcqRel)
            {
                if let Some(tx) = NOTIFY_TX.get() {
                    let notification = json!({
                        "jsonrpc": "2.0",
                        "method": "keyboard.shortcut",
                        "params": { "binding": "Alt+Space" },
                    });
                    if let Ok(raw) = serde_json::to_string(&notification) {
                        let _ = tx.send(format!("{raw}\n"));
                    }
                }
                // Prevent Windows from opening the active window's system
                // menu. Electron will show the launcher in response to the
                // host notification instead.
                return 1;
            }
        }

        CallNextHookEx(std::ptr::null_mut(), code, w_param, l_param)
    }

    pub fn start(tx: mpsc::UnboundedSender<String>) {
        if NOTIFY_TX.set(tx).is_err() {
            return;
        }
        if STARTED.swap(true, Ordering::AcqRel) {
            return;
        }

        let result = thread::Builder::new()
            .name("pi-host-global-shortcut".into())
            .spawn(|| unsafe {
                let module = GetModuleHandleW(std::ptr::null());
                let hook = SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_hook), module, 0);
                if hook.is_null() {
                    tracing::warn!("Windows Alt+Space keyboard hook could not be installed");
                    return;
                }

                let mut message: MSG = std::mem::zeroed();
                while GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) > 0 {
                    TranslateMessage(&message);
                    DispatchMessageW(&message);
                }
                UnhookWindowsHookEx(hook);
            });

        if let Err(error) = result {
            STARTED.store(false, Ordering::Release);
            tracing::warn!(error = %error, "Windows Alt+Space keyboard hook thread could not start");
        }
    }

    pub fn set_enabled(enabled: bool) {
        ENABLED.store(enabled, Ordering::Release);
        if !enabled {
            SPACE_DOWN.store(false, Ordering::Release);
        }
    }
}

#[cfg(windows)]
pub fn start(tx: tokio::sync::mpsc::UnboundedSender<String>) {
    windows::start(tx);
}

#[cfg(not(windows))]
pub fn start(_tx: tokio::sync::mpsc::UnboundedSender<String>) {}

#[cfg(windows)]
pub fn set_enabled(enabled: bool) {
    windows::set_enabled(enabled);
}

#[cfg(not(windows))]
pub fn set_enabled(_enabled: bool) {}

/// Enable the native hook only for the Windows-reserved default binding.
pub fn uses_windows_fallback(binding: &str) -> bool {
    cfg!(windows) && binding == "Alt+Space"
}
