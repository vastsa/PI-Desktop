//! Windows descendant termination for a tool runner (issue #1805).
//!
//! `AssignProcessToJobObject` does not reach processes the shell already
//! spawned, so a command launched at shell startup can sit outside the job and
//! survive `TerminateJobObject`. This module terminates the runner's descendant
//! tree through the process snapshot, and it refuses to act on a PID whose
//! identity it cannot tie back to the snapshot: a PID is only meaningful while
//! the process that owned it is still the same process.

use std::collections::{HashMap, HashSet, VecDeque};

use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, ERROR_ACCESS_DENIED, ERROR_INVALID_PARAMETER, ERROR_NO_MORE_FILES,
    FILETIME, HANDLE, INVALID_HANDLE_VALUE, STILL_ACTIVE,
};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::Threading::{
    GetExitCodeProcess, GetProcessTimes, OpenProcess, TerminateProcess,
    PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE,
};

/// Terminate every live descendant of `root_pid`, deepest first, then the root.
///
/// Cleanup continues across the whole tree after a failure so one stuck process
/// never hides the rest; the first failure is reported afterwards. That keeps
/// the caller from recording "stopped" while a descendant is still running.
pub(super) fn terminate_tree(root_pid: u32) -> Result<(), String> {
    if root_pid == 0 {
        return Ok(());
    }
    // A process created after the snapshot cannot be one the snapshot
    // described, so its creation time is the watermark that makes a recycled
    // PID distinguishable from the real descendant.
    let watermark = ProcessTimes::now();
    let snapshot = Snapshot::capture()?;

    let mut errors: Vec<String> = Vec::new();
    for pid in snapshot.descendants_deepest_first(root_pid) {
        if let Err(error) = terminate_member(pid, &watermark) {
            errors.push(error);
        }
    }
    match errors.split_first() {
        None => Ok(()),
        Some((first, [])) => Err(first.clone()),
        Some((first, rest)) => Err(format!("{first} (and {} more)", rest.len())),
    }
}

/// Parent → children edges captured from `TH32CS_SNAPPROCESS`.
struct Snapshot {
    edges: HashMap<u32, Vec<u32>>,
}

impl Snapshot {
    fn capture() -> Result<Self, String> {
        let handle = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
        if handle == INVALID_HANDLE_VALUE {
            return Err(format!(
                "CreateToolhelp32Snapshot failed: {}",
                std::io::Error::last_os_error()
            ));
        }
        let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut edges: HashMap<u32, Vec<u32>> = HashMap::new();
        if unsafe { Process32FirstW(handle, &mut entry) } == 0 {
            let error = std::io::Error::last_os_error();
            unsafe {
                CloseHandle(handle);
            }
            return Err(format!("Process32FirstW failed: {error}"));
        }
        loop {
            if entry.th32ProcessID != 0 && entry.th32ProcessID != entry.th32ParentProcessID {
                edges
                    .entry(entry.th32ParentProcessID)
                    .or_default()
                    .push(entry.th32ProcessID);
            }
            if unsafe { Process32NextW(handle, &mut entry) } == 0 {
                break;
            }
        }
        // A zero result means either "no more files" or a real enumeration
        // failure; only the first is a completed snapshot.
        let error = unsafe { GetLastError() };
        unsafe {
            CloseHandle(handle);
        }
        if error != ERROR_NO_MORE_FILES {
            return Err(format!(
                "Process32NextW failed: {}",
                std::io::Error::from_raw_os_error(error as i32)
            ));
        }
        Ok(Self { edges })
    }

    fn descendants_deepest_first(&self, root: u32) -> Vec<u32> {
        // Breadth-first from the root, then reversed: children are terminated
        // before the parent that could still spawn more of them.
        let mut order = Vec::new();
        let mut seen = HashSet::from([root]);
        let mut queue = VecDeque::from([root]);
        while let Some(current) = queue.pop_front() {
            if let Some(children) = self.edges.get(&current) {
                for &child in children {
                    // A recycled parent PID can make the edge list cyclic;
                    // each PID is terminated at most once.
                    if seen.insert(child) {
                        order.push(child);
                        queue.push_back(child);
                    }
                }
            }
        }
        order.reverse();
        order.push(root);
        order
    }
}

/// Terminate one snapshot entry after proving it is still that process.
fn terminate_member(pid: u32, watermark: &ProcessTimes) -> Result<(), String> {
    let handle = unsafe {
        OpenProcess(
            PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION,
            0,
            pid,
        )
    };
    if handle.is_null() {
        let error = unsafe { GetLastError() };
        if error == ERROR_INVALID_PARAMETER {
            // The PID is gone, which is the outcome stopping wants.
            return Ok(());
        }
        // Access denied here is a live process this runner cannot open; it is
        // not proof of exit, so it must surface rather than pass as stopped.
        return Err(format!(
            "OpenProcess failed for runner process {pid}: {}",
            std::io::Error::from_raw_os_error(error as i32)
        ));
    }
    let result = terminate_handle(pid, handle, watermark);
    unsafe {
        CloseHandle(handle);
    }
    result
}

fn terminate_handle(pid: u32, handle: HANDLE, watermark: &ProcessTimes) -> Result<(), String> {
    let mut exit_code = 0u32;
    if unsafe { GetExitCodeProcess(handle, &mut exit_code) } == 0 {
        return Err(format!(
            "GetExitCodeProcess failed for runner process {pid}: {}",
            std::io::Error::last_os_error()
        ));
    }
    if exit_code != STILL_ACTIVE as u32 {
        return Ok(());
    }
    // The handle is bound to one process, so a recycled PID cannot be hit
    // through it. The creation time is still checked because a snapshot entry
    // may name a process that exited while a new one took its PID.
    let created = ProcessTimes::of(handle)
        .map_err(|error| format!("GetProcessTimes failed for runner process {pid}: {error}"))?;
    if created.created_after(watermark) {
        return Ok(());
    }
    if unsafe { TerminateProcess(handle, 1) } == 0 {
        let error = unsafe { GetLastError() };
        if error == ERROR_INVALID_PARAMETER {
            return Ok(());
        }
        let mut after = 0u32;
        let queried = unsafe { GetExitCodeProcess(handle, &mut after) };
        if queried != 0 && after != STILL_ACTIVE as u32 {
            // It exited while the call was in flight.
            return Ok(());
        }
        if error == ERROR_ACCESS_DENIED {
            return Err(format!(
                "TerminateProcess denied for live runner process {pid}; it may still be running"
            ));
        }
        return Err(format!(
            "TerminateProcess failed for runner process {pid}: {}",
            std::io::Error::from_raw_os_error(error as i32)
        ));
    }
    Ok(())
}

/// Process creation times in 100ns intervals since 1601.
///
/// Comparable without converting either side to `SystemTime`, and every value
/// comes from the same clock the snapshot entries are created under.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(super) struct ProcessTimes {
    created: u64,
}

impl ProcessTimes {
    fn of(handle: HANDLE) -> std::io::Result<Self> {
        let mut created = FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        };
        let mut exited = created;
        let mut kernel = created;
        let mut user = created;
        if unsafe { GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user) }
            == 0
        {
            return Err(std::io::Error::last_os_error());
        }
        Ok(Self {
            created: (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime),
        })
    }

    /// Current wall clock in the same FILETIME units as process creation times.
    fn now() -> Self {
        let mut now = FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        };
        unsafe {
            windows_sys::Win32::System::SystemInformation::GetSystemTimeAsFileTime(&mut now);
        }
        Self {
            created: (u64::from(now.dwHighDateTime) << 32) | u64::from(now.dwLowDateTime),
        }
    }

    fn created_after(&self, watermark: &Self) -> bool {
        self.created > watermark.created
    }

    #[cfg(test)]
    pub(super) fn from_raw(created: u64) -> Self {
        Self { created }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn children_are_terminated_before_their_parents() {
        let edges = HashMap::from([(10, vec![11]), (11, vec![12, 14]), (12, vec![13])]);
        let order = Snapshot { edges }.descendants_deepest_first(10);
        let position = |pid: u32| order.iter().position(|entry| *entry == pid).unwrap();
        assert!(position(13) < position(12));
        assert!(position(12) < position(11));
        assert!(position(14) < position(11));
        assert!(
            position(10) > position(11),
            "the runner itself is terminated last"
        );
        assert_eq!(order.len(), 5, "root plus four descendants");
    }

    #[test]
    fn unrelated_processes_are_not_in_the_tree() {
        let edges = HashMap::from([(1, vec![2]), (2, vec![3]), (7, vec![8])]);
        let order = Snapshot { edges }.descendants_deepest_first(1);
        assert_eq!(order, vec![3, 2, 1]);
    }

    #[test]
    fn a_cyclic_snapshot_lists_each_pid_once() {
        // A recycled parent PID can make the edge list point back at the root.
        let edges = HashMap::from([(5, vec![6]), (6, vec![7]), (7, vec![5])]);
        let order = Snapshot { edges }.descendants_deepest_first(5);
        let mut unique = order.clone();
        unique.sort_unstable();
        unique.dedup();
        assert_eq!(unique.len(), order.len());
        assert_eq!(order.iter().filter(|pid| **pid == 5).count(), 1);
    }

    #[test]
    fn a_process_created_after_the_snapshot_is_a_recycled_pid() {
        let watermark = ProcessTimes::from_raw(1_000);
        assert!(ProcessTimes::from_raw(1_001).created_after(&watermark));
        assert!(!ProcessTimes::from_raw(1_000).created_after(&watermark));
        assert!(!ProcessTimes::from_raw(999).created_after(&watermark));
    }

    #[cfg(windows)]
    #[test]
    fn snapshot_watermark_includes_processes_started_after_the_host() {
        use std::os::windows::{io::AsRawHandle, process::CommandExt};

        let mut child = std::process::Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Start-Sleep -Seconds 120",
            ])
            .creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW)
            .spawn()
            .unwrap();
        let created = ProcessTimes::of(child.as_raw_handle() as HANDLE);
        let watermark = ProcessTimes::now();
        child.kill().unwrap();
        child.wait().unwrap();

        assert!(
            !created.unwrap().created_after(&watermark),
            "a process spawned after the Host must remain eligible for cleanup"
        );
    }
}
