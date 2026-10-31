//! Windows-only regression coverage for issue #1805: stopping a background task
//! must terminate the command the runner launched, not only the runner itself.

use super::tests::new_session;
use super::*;
use std::time::Duration;

/// The reported symptom: a stop took the runner shell but left the command
/// it launched — and that command's own child — running (#1805).
///
/// The production chain is exercised end to end: the host binary starts in
/// hidden runner mode, reads its config frame, then starts the shell. A test
/// that spawns the shell directly would not cover the ordering the race
/// depends on.
#[cfg(windows)]
#[tokio::test]
async fn stop_terminates_the_command_the_runner_launched() {
    let dir = tempfile::tempdir().unwrap();
    let command_pid_file = dir.path().join("command-pid.txt");
    let nested_pid_file = dir.path().join("nested-pid.txt");
    let ps_path = |path: &std::path::Path| path.display().to_string().replace('\\', "/");

    let nested_script = dir.path().join("nested.ps1");
    std::fs::write(
        &nested_script,
        format!(
            "[System.IO.File]::WriteAllText('{}', $PID); Start-Sleep -Seconds 120",
            ps_path(&nested_pid_file)
        ),
    )
    .unwrap();

    let command_script = dir.path().join("command.ps1");
    std::fs::write(
        &command_script,
        format!(
            "[System.IO.File]::WriteAllText('{own}', $PID); \
             Start-Process powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','{nested}'; \
             Start-Sleep -Seconds 120",
            own = ps_path(&command_pid_file),
            nested = ps_path(&nested_script),
        ),
    )
    .unwrap();

    let state = tokio::sync::Mutex::new(crate::state::AppState::open(dir.path()).unwrap());
    let session_id = {
        let st = state.lock().await;
        new_session(&st)
    };
    let command = format!(
        "powershell -NoProfile -ExecutionPolicy Bypass -File '{}'",
        command_script.display()
    );
    let id = spawn_background_task_detached(
        &state,
        &session_id,
        &command,
        crate::tools::shell::default_shell_id(),
        dir.path(),
        None,
    )
    .await
    .unwrap();

    // Both levels have to be running first, otherwise the assertions below
    // would pass on a fixture that never launched anything.
    let mut command_pid = None;
    let mut nested_pid = None;
    for _ in 0..200 {
        tokio::time::sleep(Duration::from_millis(50)).await;
        command_pid = command_pid.or_else(|| read_pid(&command_pid_file));
        nested_pid = nested_pid.or_else(|| read_pid(&nested_pid_file));
        if command_pid.is_some() && nested_pid.is_some() {
            break;
        }
    }
    let command_pid = command_pid.expect("the shell must launch the command");
    let nested_pid = nested_pid.expect("the command must launch its own child");
    assert!(process_running(command_pid), "command runs before the stop");
    assert!(
        process_running(nested_pid),
        "nested child runs before the stop"
    );

    {
        let st = state.lock().await;
        assert!(stop_task(&st.background_tasks, &id).await.unwrap());
    }

    assert!(
        wait_for_exit(nested_pid),
        "the command's own child must not survive stopping the task (#1805)"
    );
    assert!(
        wait_for_exit(command_pid),
        "the launched command must not survive stopping the task (#1805)"
    );

    let mut st = state.lock().await;
    st.shutdown();
}

#[cfg(windows)]
fn read_pid(path: &std::path::Path) -> Option<u32> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| text.trim().parse().ok())
}

/// A process the test cannot query is a fixture failure, not "exited": the
/// assertions above would otherwise pass for the wrong reason.
#[cfg(windows)]
fn process_running(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        return false;
    }
    let mut exit_code = 0u32;
    let queried = unsafe { GetExitCodeProcess(handle, &mut exit_code) };
    unsafe {
        CloseHandle(handle);
    }
    queried != 0 && exit_code == STILL_ACTIVE as u32
}

#[cfg(windows)]
fn wait_for_exit(pid: u32) -> bool {
    for _ in 0..120 {
        if !process_running(pid) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    false
}
