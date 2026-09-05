use anyhow::{anyhow, Result};
use ignore::WalkBuilder;
use regex::RegexBuilder;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs::File;
use std::future::pending;
use std::io::{self, BufRead, BufReader, ErrorKind};
use std::path::{Path, PathBuf};
use std::process::{ExitStatus, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
#[cfg(not(test))]
use tokio::io::AsyncWriteExt;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::{ChildStderr, ChildStdin, ChildStdout, Command};
use tokio::sync::{mpsc, watch};

use crate::workspace::{resolve_tool_path_with_external, ToolRoot};

mod grep_rg;
pub mod shell;

/// Ceiling on what the streaming capture retains per stream.
///
/// This is the *capture* bound, and it is deliberately larger than the
/// per-result budgets (`BUDGET_SHELL` and friends). The retained copy is what
/// spills to scratch, so capping capture at the result budget would leave the
/// spill file no fuller than the excerpt it exists to back. Bytes do the real
/// bounding here; the line ceiling is only a backstop against pathological
/// line counts, which is why it sits well above `BUDGET_SHELL.max_lines`.
pub const CAPTURE_MAX_BYTES: usize = SPILL_MAX_BYTES;
pub const CAPTURE_MAX_LINES: usize = 200_000;
pub const MAX_TIMEOUT_MS: u64 = 2_147_483_647;
pub const MIN_BASH_TIMEOUT_MS: u64 = 1_000;
pub const MAX_BASH_TIMEOUT_MS: u64 = 300_000;
pub const DEFAULT_BASH_TIMEOUT_MS: u64 = 60_000;
pub const INTERNAL_TOOL_RUNNER_FLAG: &str = "--internal-tool-runner";
const PIPE_DRAIN_TIMEOUT: Duration = Duration::from_millis(750);
const PROCESS_TERMINATION_TIMEOUT: Duration = Duration::from_millis(2_000);
const OUTPUT_CHANNEL_CAPACITY: usize = 64;
const OUTPUT_NOTIFICATION_INTERVAL: Duration = Duration::from_millis(100);
const OUTPUT_NOTIFICATION_MAX_CHUNK_BYTES: usize = 16 * 1024;
const MAX_OUTPUT_NOTIFICATIONS: usize = 1024;
const RUNNER_CONFIG_MAX_BYTES: usize = 64 * 1024;
const RUNNER_SPAWN_BACKOFFS_MS: [u64; 3] = [50, 100, 250];
const INTERNAL_RUNNER_ERROR_PREFIX: &str = "PI_DESKTOP_RUNNER_ERROR\t";

#[cfg(windows)]
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
#[cfg(windows)]
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};

#[cfg(windows)]
#[derive(Debug, Default)]
struct ProcessOwnership {
    job: Option<HANDLE>,
}

#[cfg(not(windows))]
#[derive(Debug, Default)]
struct ProcessOwnership;

impl ProcessOwnership {
    #[cfg(windows)]
    fn assign(child: &tokio::process::Child) -> Result<Self, String> {
        let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if job.is_null() {
            return Err("CreateJobObjectW failed for the shell runner".into());
        }

        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = unsafe {
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) != 0
        };
        if !configured {
            unsafe {
                CloseHandle(job);
            }
            return Err("SetInformationJobObject failed for the shell runner".into());
        }
        let Some(handle) = child.raw_handle() else {
            unsafe {
                CloseHandle(job);
            }
            return Err("shell runner has no process handle".into());
        };
        if unsafe { AssignProcessToJobObject(job, handle) == 0 } {
            unsafe {
                CloseHandle(job);
            }
            return Err("AssignProcessToJobObject failed for the shell runner".into());
        }
        Ok(Self { job: Some(job) })
    }

    #[cfg(unix)]
    fn assign(child: &tokio::process::Child) -> Result<Self, String> {
        let Some(pid) = child.id() else {
            return Err("shell runner has no process ID".into());
        };
        let process_group = unsafe { libc::getpgid(pid as libc::pid_t) };
        if process_group < 0 {
            return Err(format!(
                "getpgid failed for the shell runner: {}",
                io::Error::last_os_error()
            ));
        }
        if process_group != pid as libc::pid_t {
            return Err("shell runner was not placed in its own process group".into());
        }
        Ok(Self)
    }

    #[cfg(all(not(windows), not(unix)))]
    fn assign(_child: &tokio::process::Child) -> Result<Self, String> {
        Err("shell runner process-group ownership is unsupported on this platform".into())
    }

    #[cfg(windows)]
    fn terminate(&self, _pid: u32) -> Result<(), String> {
        let Some(job) = self.job else {
            return Err("shell runner process ownership is unavailable".into());
        };
        if unsafe { TerminateJobObject(job, 1) == 0 } {
            Err("TerminateJobObject failed for the shell runner".into())
        } else {
            Ok(())
        }
    }

    #[cfg(unix)]
    fn terminate(&self, pid: u32) -> Result<(), String> {
        if pid == 0 {
            return Err("shell runner has no process group".into());
        }
        let result = unsafe { libc::killpg(pid as libc::pid_t, libc::SIGKILL) };
        if result == 0 {
            return Ok(());
        }
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ESRCH) {
            Ok(())
        } else {
            Err(format!("killpg failed for the shell runner: {error}"))
        }
    }

    #[cfg(all(not(windows), not(unix)))]
    fn terminate(&self, _pid: u32) -> Result<(), String> {
        Err("shell runner process-tree ownership is unsupported on this platform".into())
    }

    #[cfg(windows)]
    fn close_now(&mut self) {
        if let Some(job) = self.job.take() {
            unsafe {
                CloseHandle(job);
            }
        }
    }

    #[cfg(not(windows))]
    fn close_now(&mut self) {}

    fn terminate_fail_closed(&mut self, pid: u32) -> Result<(), String> {
        match self.terminate(pid) {
            Ok(()) => Ok(()),
            Err(error) => {
                // On Windows closing a configured kill-on-close job is the
                // final containment mechanism if an explicit termination call
                // fails. Unix has no ownership handle to close.
                self.close_now();
                Err(error)
            }
        }
    }
}

#[cfg(windows)]
// Windows kernel handles are process-wide and safe to move between Tokio
// worker threads; the ownership wrapper closes exactly one job handle.
unsafe impl Send for ProcessOwnership {}

#[cfg(windows)]
unsafe impl Sync for ProcessOwnership {}

#[cfg(windows)]
impl Drop for ProcessOwnership {
    fn drop(&mut self) {
        self.close_now();
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ToolRunnerStartConfig {
    program: PathBuf,
    args: Vec<String>,
    workspace: PathBuf,
    #[serde(default)]
    scratch_dir: Option<PathBuf>,
    #[serde(default)]
    env_path: Option<String>,
}

fn path_has_nul(path: &Path) -> bool {
    path.to_string_lossy().contains('\0')
}

fn validate_runner_config(config: &ToolRunnerStartConfig) -> Result<(), String> {
    if config.program.as_os_str().is_empty() || path_has_nul(&config.program) {
        return Err("runner config has an invalid shell program".into());
    }
    if config.workspace.as_os_str().is_empty() || path_has_nul(&config.workspace) {
        return Err("runner config has an invalid workspace path".into());
    }
    if config.args.iter().any(|argument| argument.contains('\0')) {
        return Err("runner config contains an argument with an embedded NUL".into());
    }
    if config
        .scratch_dir
        .as_deref()
        .is_some_and(|path| path.as_os_str().is_empty() || path_has_nul(path))
    {
        return Err("runner config has an invalid scratch directory".into());
    }
    if config
        .env_path
        .as_deref()
        .is_some_and(|path| path.contains('\0'))
    {
        return Err("runner config contains an environment PATH with an embedded NUL".into());
    }
    Ok(())
}

fn is_transient_spawn_error(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::WouldBlock || matches!(error.raw_os_error(), Some(11) | Some(35))
}

async fn spawn_with_retries(
    command: &mut Command,
) -> Result<tokio::process::Child, (String, String)> {
    let mut last_error = None;
    for (attempt, delay_ms) in RUNNER_SPAWN_BACKOFFS_MS.iter().copied().enumerate() {
        match command.spawn() {
            Ok(child) => return Ok(child),
            Err(error)
                if is_transient_spawn_error(&error)
                    && attempt + 1 < RUNNER_SPAWN_BACKOFFS_MS.len() =>
            {
                last_error = Some(error);
                tokio::time::sleep(Duration::from_millis(delay_ms)).await;
            }
            Err(error) => {
                last_error = Some(error);
                break;
            }
        }
    }

    let error = last_error.expect("runner spawn always records an error");
    let code = if is_transient_spawn_error(&error) {
        "PROCESS_RESOURCE_EXHAUSTED"
    } else {
        "TOOL_FAILED"
    };
    Err((code.into(), format!("shell runner spawn failed: {error}")))
}

fn encode_runner_config(config: &ToolRunnerStartConfig) -> Result<Vec<u8>, String> {
    validate_runner_config(config)?;
    let json = serde_json::to_vec(config)
        .map_err(|error| format!("failed to encode shell runner config: {error}"))?;
    if json.is_empty() || json.len() > RUNNER_CONFIG_MAX_BYTES || json.len() > u32::MAX as usize {
        return Err("shell runner config is too large".into());
    }
    let mut frame = Vec::with_capacity(4 + json.len());
    frame.extend_from_slice(&(json.len() as u32).to_le_bytes());
    frame.extend_from_slice(&json);
    Ok(frame)
}

fn decode_runner_config(frame: &[u8]) -> Result<ToolRunnerStartConfig, String> {
    if frame.len() < 4 {
        return Err("shell runner config frame is truncated".into());
    }
    let length = u32::from_le_bytes([frame[0], frame[1], frame[2], frame[3]]) as usize;
    if length == 0 || length > RUNNER_CONFIG_MAX_BYTES {
        return Err("shell runner config length is invalid".into());
    }
    let expected = 4usize
        .checked_add(length)
        .ok_or_else(|| "shell runner config length overflowed".to_string())?;
    if frame.len() != expected {
        return Err("shell runner config frame length does not match its payload".into());
    }
    let config: ToolRunnerStartConfig = serde_json::from_slice(&frame[4..])
        .map_err(|error| format!("invalid shell runner config JSON: {error}"))?;
    validate_runner_config(&config)?;
    Ok(config)
}

async fn read_runner_config<R>(reader: &mut R) -> Result<ToolRunnerStartConfig, String>
where
    R: AsyncRead + Unpin,
{
    let mut length_bytes = [0u8; 4];
    reader
        .read_exact(&mut length_bytes)
        .await
        .map_err(|error| format!("failed to read shell runner config length: {error}"))?;
    let length = u32::from_le_bytes(length_bytes) as usize;
    if length == 0 || length > RUNNER_CONFIG_MAX_BYTES {
        return Err("shell runner config length is invalid".into());
    }
    let mut payload = vec![0u8; length];
    reader
        .read_exact(&mut payload)
        .await
        .map_err(|error| format!("failed to read shell runner config payload: {error}"))?;
    let mut frame = Vec::with_capacity(4 + payload.len());
    frame.extend_from_slice(&length_bytes);
    frame.extend_from_slice(&payload);
    decode_runner_config(&frame)
}

#[cfg(unix)]
async fn monitor_runner_control_pipe(mut control: tokio::io::Stdin) -> io::Result<()> {
    let mut buffer = [0u8; 1024];
    loop {
        match control.read(&mut buffer).await? {
            0 => return Ok(()),
            _ => {}
        }
    }
}

#[cfg(unix)]
fn kill_runner_process_group() -> io::Result<()> {
    let result = unsafe { libc::killpg(0, libc::SIGKILL) };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

fn runner_exit_code(status: ExitStatus) -> i32 {
    if let Some(code) = status.code() {
        return code;
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;

        status.signal().map(|signal| 128 + signal).unwrap_or(1)
    }
    #[cfg(not(unix))]
    {
        1
    }
}

/// Entry point for the hidden child mode. It deliberately reads the config
/// before starting the shell, so the host can assign process ownership before
/// any command descendant exists.
pub async fn run_internal_tool_runner() -> Result<i32> {
    let mut control = tokio::io::stdin();
    let config = read_runner_config(&mut control)
        .await
        .map_err(|error| anyhow!(error))?;

    let mut command = Command::new(&config.program);
    command
        .args(&config.args)
        .current_dir(&config.workspace)
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .kill_on_drop(true);
    if let Some(scratch_dir) = config.scratch_dir.as_deref() {
        command.env("PI_SCRATCH_DIR", scratch_dir);
    }
    if let Some(path) = config.env_path.as_deref() {
        command.env("PATH", path);
    }
    #[cfg(windows)]
    {
        command.creation_flags(0x0800_0000);
    }

    let mut child = match spawn_with_retries(&mut command).await {
        Ok(child) => child,
        Err((code, message)) if code == "PROCESS_RESOURCE_EXHAUSTED" => {
            eprintln!("{INTERNAL_RUNNER_ERROR_PREFIX}{code}\t{message}");
            return Ok(1);
        }
        Err((code, message)) => return Err(anyhow!("{code}: {message}")),
    };

    #[cfg(unix)]
    {
        let mut monitor = tokio::spawn(monitor_runner_control_pipe(control));
        let status = tokio::select! {
            status = child.wait() => {
                monitor.abort();
                let _ = monitor.await;
                status.map_err(|error| anyhow!("shell runner failed while waiting for shell: {error}"))?
            }
            control_result = &mut monitor => {
                let control_error = match control_result {
                    Ok(Ok(())) => None,
                    Ok(Err(error)) => Some(error),
                    Err(error) => Some(io::Error::new(io::ErrorKind::Other, error)),
                };
                let kill_result = kill_runner_process_group();
                if let Some(error) = control_error {
                    if let Err(kill_error) = kill_result {
                        let _ = child.kill().await;
                        let _ = child.wait().await;
                        return Err(anyhow!(
                            "shell runner control pipe failed: {error}; process-group kill failed: {kill_error}"
                        ));
                    }
                    let _ = child.wait().await;
                    return Err(anyhow!("shell runner control pipe failed: {error}"));
                }
                if let Err(error) = kill_result {
                    let _ = child.kill().await;
                    let _ = child.wait().await;
                    return Err(anyhow!("shell runner failed to kill its process group: {error}"));
                }
                let _ = child.wait().await;
                return Ok(1);
            }
        };
        Ok(runner_exit_code(status))
    }

    #[cfg(not(unix))]
    {
        let status = child
            .wait()
            .await
            .map_err(|error| anyhow!("shell runner failed while waiting for shell: {error}"))?;
        Ok(runner_exit_code(status))
    }
}
/// Which end of an over-budget payload survives.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    Head,
    Tail,
}

/// Per-tool output budget (spec 03-runtime/16).
///
/// One shared 256KB cap used to govern every tool, which in practice meant no
/// cap at all: measured sessions averaged 154KB per `Read` and spent 56% of
/// their whole context on read/search results, which then forced compaction
/// and re-searching. Search and read results still get a tighter budget than
/// shell because they are re-fetchable on demand. 48KB was too tight: a 500-line
/// window of ordinary source or a spec table row already overflowed, so almost
/// every Read reported `truncated` and the agent re-searched what it had.
#[derive(Debug, Clone, Copy)]
pub struct OutputBudget {
    pub max_bytes: usize,
    pub max_lines: usize,
    pub direction: Direction,
}

/// Read / Glob / Grep. 128KB fits a 2000-line window of typical source; 4000
/// lines is the explicit ceiling so a default window is not also the max.
pub const BUDGET_SEARCH: OutputBudget = OutputBudget {
    max_bytes: 128 * 1024,
    max_lines: 4000,
    direction: Direction::Head,
};

/// Bash stdout: a command's output is usually the whole point of the call and
/// cannot be re-derived by narrowing a pattern, so it keeps a larger share.
pub const BUDGET_SHELL: OutputBudget = OutputBudget {
    max_bytes: 96 * 1024,
    max_lines: 4000,
    direction: Direction::Head,
};

/// Bash stderr keeps the tail: when a command fails, the actionable message is
/// the last thing it printed. Dropping it to retain 96KB of progress noise is
/// exactly what makes the model retry blindly.
pub const BUDGET_SHELL_ERR: OutputBudget = OutputBudget {
    max_bytes: 96 * 1024,
    max_lines: 4000,
    direction: Direction::Tail,
};

/// Upper bound on a spilled full-output copy. Bounded for two reasons: the
/// buffer is held in host memory before it lands on disk, and a runaway
/// command must not fill the user's disk. 512KB covers the realistic "grep the
/// full log" follow-up.
pub const SPILL_MAX_BYTES: usize = 512 * 1024;

/// Longest single line any tool hands to the model. Minified bundles and
/// sourcemaps are routinely one multi-megabyte line; 2000 chars also clipped
/// ordinary spec tables and JSONL, which then marked the whole Read truncated.
/// 16,384 still clips a minified one-liner while leaving a decision-log row
/// intact. The byte budget still bounds how many such lines a result can hold.
pub const MAX_LINE_CHARS: usize = 16_384;

/// Read window when the caller does not ask for one.
const DEFAULT_READ_LINES: usize = 2000;

/// Grep hits returned when the caller does not ask for a limit.
const GREP_DEFAULT_HEAD_LIMIT: usize = 200;

/// Bound on the file list Grep sorts before scanning, so a pathological tree
/// cannot make the candidate pass itself unbounded.
const GREP_MAX_CANDIDATE_FILES: usize = 20_000;

/// Glob entries returned when the caller does not ask for a limit, and the
/// ceiling it may ask for.
const GLOB_DEFAULT_LIMIT: usize = 100;
const GLOB_MAX_LIMIT: usize = 1000;

/// Internal-only classifier used to enrich a public INVALID_ARGUMENT result
/// with a machine-actionable Glob recovery. It never crosses the RPC boundary.
const READ_PATH_IS_DIRECTORY: &str = "READ_PATH_IS_DIRECTORY";

/// Extensions we refuse to read as text even when the byte sniff is
/// inconclusive (a short archive header can look printable).
const BINARY_EXTENSIONS: &[&str] = &[
    "7z", "a", "bin", "class", "dat", "dll", "doc", "docx", "dylib", "exe", "gz", "ico", "jar",
    "lib", "o", "obj", "odp", "ods", "odt", "pdf", "png", "ppt", "pptx", "pyc", "pyo", "so", "tar",
    "wasm", "war", "webp", "xls", "xlsx", "zip",
];

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolsExecuteParams {
    pub session_id: String,
    pub turn_id: Option<String>,
    pub tool_call_id: String,
    pub tool_name: String,
    pub args: Value,
    #[serde(rename = "mode")]
    pub _mode: String,
    #[serde(default)]
    pub declared_risk: Option<String>,
    /// Permission scope of a subagent's tool call (ADR 0089): when present,
    /// the call resolves under this mode instead of the session's effective
    /// permission mode. `inherit` and absent behave identically.
    #[serde(default)]
    pub permission_scope: Option<String>,
    #[serde(default)]
    pub expected_command_shell_id: Option<String>,
    #[serde(default)]
    pub expected_command_shell_dialect: Option<String>,
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolsExecuteResult {
    pub tool_call_id: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_error: Option<bool>,
    pub content: Value,
    pub duration_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub denied: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command_shell_id: Option<String>,
}

fn fits(text: &str, budget: OutputBudget) -> bool {
    text.len() <= budget.max_bytes && text.lines().count() <= budget.max_lines
}

/// Truncate to `budget`, first spilling the fuller copy under `scratch` so the
/// marker can point the model at something it can Grep instead of re-running
/// the command. Best-effort: a failed spill costs the hint, never the result.
fn truncate_with_spill(
    text: &str,
    budget: OutputBudget,
    scratch: Option<&Path>,
    label: &str,
) -> (String, bool) {
    if fits(text, budget) {
        return (text.to_string(), false);
    }
    let spilled = spill_output(scratch, label, text);
    (truncate_to(text, budget, spilled.as_deref()), true)
}

fn truncate_to(text: &str, budget: OutputBudget, spilled: Option<&Path>) -> String {
    let lines: Vec<&str> = text.lines().collect();
    let window: &[&str] = match budget.direction {
        Direction::Head => &lines[..lines.len().min(budget.max_lines)],
        Direction::Tail => &lines[lines.len().saturating_sub(budget.max_lines)..],
    };

    let mut kept: Vec<&str> = Vec::new();
    let mut bytes = 0_usize;
    let mut single_line_clip = None;
    match budget.direction {
        Direction::Head => {
            for line in window {
                let size = line.len() + usize::from(!kept.is_empty());
                if bytes + size > budget.max_bytes {
                    break;
                }
                kept.push(line);
                bytes += size;
            }
        }
        Direction::Tail => {
            for line in window.iter().rev() {
                let size = line.len() + usize::from(!kept.is_empty());
                if bytes + size > budget.max_bytes {
                    break;
                }
                kept.push(line);
                bytes += size;
            }
            kept.reverse();
        }
    }

    // A single line longer than the entire budget (minified bundle, `tr`-style
    // one-shot output) fits no complete line, and returning nothing at all
    // would be worse than returning a prefix of it.
    if kept.is_empty() {
        if let Some(line) = match budget.direction {
            Direction::Head => window.first(),
            Direction::Tail => window.last(),
        } {
            let clipped = match budget.direction {
                Direction::Head => clip_head(line, budget.max_bytes),
                Direction::Tail => clip_tail(line, budget.max_bytes),
            };
            single_line_clip = Some(clipped.len());
            kept.push(clipped);
        }
    }

    let hint = match spilled {
        Some(path) => format!(
            " Full output saved to {} — Grep it, or Read it with offset/limit.",
            path.display()
        ),
        None => " Narrow the request to see more.".to_string(),
    };
    let marker = match single_line_clip {
        Some(bytes) => format!(
            "[truncated: no complete line fits the {}KB limit; kept {} bytes of a single {}-byte line.{}]",
            budget.max_bytes / 1024,
            bytes,
            match budget.direction {
                Direction::Head => window.first(),
                Direction::Tail => window.last(),
            }
            .map(|line| line.len())
            .unwrap_or(0),
            hint
        ),
        None => format!(
            "[truncated: kept the {} {} of {} lines; limit {} lines / {}KB.{}]",
            match budget.direction {
                Direction::Head => "first",
                Direction::Tail => "last",
            },
            kept.len(),
            lines.len(),
            budget.max_lines,
            budget.max_bytes / 1024,
            hint
        ),
    };

    let body = kept.join("\n");
    match budget.direction {
        Direction::Head => format!("{body}\n\n{marker}"),
        Direction::Tail => format!("{marker}\n\n{body}"),
    }
}

fn clip_head(text: &str, max_bytes: usize) -> &str {
    if text.len() <= max_bytes {
        return text;
    }
    let mut end = max_bytes;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

fn clip_tail(text: &str, max_bytes: usize) -> &str {
    if text.len() <= max_bytes {
        return text;
    }
    let mut start = text.len() - max_bytes;
    while start < text.len() && !text.is_char_boundary(start) {
        start += 1;
    }
    &text[start..]
}

/// Monotonic within the process; the timestamp covers restarts, and the path is
/// already namespaced per session by the scratch dir.
static SPILL_SEQ: AtomicU64 = AtomicU64::new(0);

fn spill_output(scratch: Option<&Path>, label: &str, text: &str) -> Option<PathBuf> {
    // Created here rather than up front in execute_tool: a session whose
    // commands all stayed under budget should not get an empty directory.
    let dir = scratch?.join("tool-output");
    std::fs::create_dir_all(&dir).ok()?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|since| since.as_millis())
        .unwrap_or(0);
    let seq = SPILL_SEQ.fetch_add(1, Ordering::Relaxed);
    let path = dir.join(format!("{label}-{stamp}-{seq}.log"));
    match std::fs::write(&path, text) {
        Ok(()) => Some(path),
        Err(error) => {
            tracing::warn!(path = %path.display(), %error, "tool output spill failed");
            None
        }
    }
}

#[derive(Debug)]
pub struct BashExecutionOptions {
    pub session_id: String,
    pub tool_call_id: String,
    pub command_shell_id: String,
    pub timeout_ms: Option<u64>,
    pub cancellation: Option<watch::Receiver<bool>>,
    pub output_tx: Option<mpsc::UnboundedSender<String>>,
}

impl BashExecutionOptions {
    fn local(command_shell_id: String, timeout_ms: Option<u64>) -> Self {
        Self {
            session_id: "local".into(),
            tool_call_id: "local".into(),
            command_shell_id,
            timeout_ms,
            cancellation: None,
            output_tx: None,
        }
    }
}

pub fn validate_timeout_ms(timeout_ms: Option<u64>) -> Result<(), (String, String)> {
    if let Some(timeout_ms) = timeout_ms {
        if timeout_ms == 0 || timeout_ms > MAX_TIMEOUT_MS {
            return Err((
                "INVALID_ARGUMENT".into(),
                format!("timeoutMs must be positive and no greater than {MAX_TIMEOUT_MS}"),
            ));
        }
    }
    Ok(())
}

fn validate_bash_timeout_ms(timeout_ms: u64) -> Result<(), (String, String)> {
    validate_timeout_ms(Some(timeout_ms))?;
    if !(MIN_BASH_TIMEOUT_MS..=MAX_BASH_TIMEOUT_MS).contains(&timeout_ms) {
        return Err((
            "INVALID_ARGUMENT".into(),
            format!("timeoutMs must be between {MIN_BASH_TIMEOUT_MS} and {MAX_BASH_TIMEOUT_MS}"),
        ));
    }
    Ok(())
}

pub fn effective_timeout_ms(tool_name: &str, timeout_ms: Option<u64>) -> Option<u64> {
    if tool_name == "Bash" {
        Some(timeout_ms.unwrap_or(DEFAULT_BASH_TIMEOUT_MS))
    } else {
        timeout_ms
    }
}

struct ScannedLine {
    text: String,
    /// The line was longer than the cap and got cut.
    clipped: bool,
}

/// Line reader that never materializes more than the per-line cap.
///
/// `read_to_string` (and `BufRead::read_until`) would pull a whole minified
/// bundle or sourcemap into memory just to throw almost all of it away, and
/// that is precisely the file shape the agent hits most often.
struct LineReader<R: BufRead> {
    reader: R,
}

impl LineReader<BufReader<File>> {
    fn open(path: &Path) -> std::io::Result<Self> {
        Ok(Self {
            reader: BufReader::with_capacity(64 * 1024, File::open(path)?),
        })
    }
}

impl<R: BufRead> LineReader<R> {
    /// Peek the buffered head of the stream and decide whether it is binary,
    /// without consuming anything. Cheaper than a second open, and it keeps
    /// Grep from matching lossy garbage inside object files.
    fn looks_binary(&mut self) -> bool {
        let Ok(head) = self.reader.fill_buf() else {
            return false;
        };
        if head.is_empty() {
            return false;
        }
        let sample = &head[..head.len().min(4096)];
        if sample.contains(&0) {
            return true;
        }
        // UTF-8 continuation bytes are >= 0x80, so text in any language stays
        // well under the threshold.
        let non_printable = sample
            .iter()
            .filter(|byte| **byte < 9 || (**byte > 13 && **byte < 32))
            .count();
        non_printable * 10 > sample.len() * 3
    }

    /// Next line with its trailing newline (and CR) stripped, clipped to
    /// `max_chars`. `Ok(None)` marks end of input.
    fn next_line(&mut self, max_chars: usize) -> std::io::Result<Option<ScannedLine>> {
        // Cap the raw read at the widest UTF-8 encoding of the char budget so
        // the char clip below never has to split a multi-byte sequence.
        let max_bytes = max_chars.saturating_mul(4);
        let mut buf: Vec<u8> = Vec::new();
        let mut clipped = false;
        let mut saw_input = false;
        loop {
            let chunk = match self.reader.fill_buf() {
                Ok(chunk) => chunk,
                Err(error) if error.kind() == ErrorKind::Interrupted => continue,
                Err(error) => return Err(error),
            };
            if chunk.is_empty() {
                break;
            }
            saw_input = true;
            let newline = chunk.iter().position(|byte| *byte == b'\n');
            let take = newline.unwrap_or(chunk.len());
            let room = max_bytes.saturating_sub(buf.len());
            if take > room {
                buf.extend_from_slice(&chunk[..room]);
                clipped = true;
            } else {
                buf.extend_from_slice(&chunk[..take]);
            }
            self.reader
                .consume(newline.map(|idx| idx + 1).unwrap_or(take));
            if newline.is_some() {
                break;
            }
        }
        if !saw_input {
            return Ok(None);
        }
        if buf.last() == Some(&b'\r') {
            buf.pop();
        }
        let text = String::from_utf8_lossy(&buf).into_owned();
        let (text, char_clipped) = clip_chars(text, max_chars);
        Ok(Some(ScannedLine {
            text,
            clipped: clipped || char_clipped,
        }))
    }
}

pub(super) fn clip_chars(text: String, max_chars: usize) -> (String, bool) {
    match text.char_indices().nth(max_chars) {
        Some((idx, _)) => (text[..idx].to_string(), true),
        None => (text, false),
    }
}

/// Fast line count without parsing content — counts newline bytes in 64KB
/// chunks. The cost is one sequential pass (~2ms for 10MB on SSD). A trailing
/// line without a final newline still counts as one line.
fn count_lines_fast(path: &Path) -> std::io::Result<usize> {
    let file = File::open(path)?;
    let mut reader = BufReader::with_capacity(64 * 1024, file);
    let mut count = 0_usize;
    let mut last_byte = 0_u8;
    let mut saw_any = false;
    loop {
        let buf = reader.fill_buf()?;
        if buf.is_empty() {
            break;
        }
        saw_any = true;
        count += buf.iter().filter(|&&b| b == b'\n').count();
        last_byte = buf[buf.len() - 1];
        let len = buf.len();
        reader.consume(len);
    }
    if !saw_any {
        // Empty file: 0 lines.
        Ok(0)
    } else if last_byte != b'\n' {
        // File does not end with a newline — the trailing content is one more line.
        Ok(count + 1)
    } else {
        // Each \n terminates exactly one line.
        Ok(count)
    }
}

/// Tools host-core gates but does not run itself: the plugin bridge and the
/// user's MCP servers both live in Electron main, so both are forwarded over
/// `plugins.execute` instead of being executed here.
///
/// `mcp_` is treated exactly like `plugin_` for risk and read-only-mode
/// purposes: the user typed the command or URL into the MCP editor themselves,
/// which is at least as deliberate as accepting a plugin's manifest.
pub fn is_desktop_dispatched(tool_name: &str) -> bool {
    tool_name.starts_with("plugin_") || tool_name.starts_with("mcp_")
}

#[cfg(test)]
pub async fn execute_tool(
    workspace: Option<&Path>,
    scratch: Option<&Path>,
    tool_name: &str,
    args: &Value,
    timeout_ms: u64,
) -> ToolsExecuteResult {
    let command_shell_id = shell::catalog(None)
        .effective
        .map(|option| option.id)
        .unwrap_or_else(|| shell::default_shell_id().to_string());
    execute_tool_with_options(
        workspace,
        scratch,
        tool_name,
        args,
        Some(timeout_ms),
        if tool_name == "Bash" {
            Some(BashExecutionOptions::local(
                command_shell_id,
                Some(timeout_ms),
            ))
        } else {
            None
        },
    )
    .await
}

#[cfg(test)]
pub async fn execute_tool_with_options(
    workspace: Option<&Path>,
    scratch: Option<&Path>,
    tool_name: &str,
    args: &Value,
    timeout_ms: Option<u64>,
    bash_options: Option<BashExecutionOptions>,
) -> ToolsExecuteResult {
    execute_tool_with_path_access(
        workspace,
        scratch,
        tool_name,
        args,
        timeout_ms,
        bash_options,
        false,
    )
    .await
}

/// Execute a builtin tool after the host permission gate has decided whether
/// an explicit outside-workspace path is allowed for this call.
pub async fn execute_tool_with_path_access(
    workspace: Option<&Path>,
    scratch: Option<&Path>,
    tool_name: &str,
    args: &Value,
    timeout_ms: Option<u64>,
    bash_options: Option<BashExecutionOptions>,
    allow_external_paths: bool,
) -> ToolsExecuteResult {
    let started = Instant::now();
    let timeout_ms = effective_timeout_ms(tool_name, timeout_ms);
    let tool_call_id = bash_options
        .as_ref()
        .map(|options| options.tool_call_id.clone())
        .unwrap_or_else(|| "local".into());
    let command_shell_id = bash_options
        .as_ref()
        .map(|options| options.command_shell_id.clone());
    // Scratch is created lazily, and only for tools that can produce files
    // there — Read/Glob/Grep on a session that never wrote scratch files
    // should not leave empty directories behind.
    if matches!(tool_name, "Write" | "Edit" | "Bash") {
        if let Some(dir) = scratch {
            let _ = std::fs::create_dir_all(dir);
        }
    }
    let result = match tool_name {
        "Read" => tool_read(workspace, scratch, args, allow_external_paths),
        "Glob" => tool_glob(workspace, scratch, args, allow_external_paths),
        "Grep" => tool_grep(workspace, scratch, args, allow_external_paths),
        "Write" => tool_write(workspace, scratch, args, allow_external_paths),
        "Edit" => tool_edit(workspace, scratch, args, allow_external_paths),
        "Bash" => {
            let options = bash_options.unwrap_or_else(|| {
                let id = shell::catalog(None)
                    .effective
                    .map(|option| option.id)
                    .unwrap_or_else(|| shell::default_shell_id().to_string());
                BashExecutionOptions::local(id, timeout_ms)
            });
            tool_bash(workspace, scratch, args, options).await
        }
        other if is_desktop_dispatched(other) => Err((
            "TOOL_NOT_FOUND".into(),
            format!("{other} requires the desktop runner (dispatched via plugins.execute)"),
        )),
        other => Err(("TOOL_NOT_FOUND".into(), format!("unknown tool: {other}"))),
    };

    match result {
        Ok(content) => {
            // Preserve Bash stdout/stderr/exitCode for the model, but still
            // surface a non-zero command as a failed tool result. Previously
            // the shell process could exit 1/128 while the outer tool stayed
            // successful, which hid command failures from the UI and timing
            // logs and encouraged blind patch retries.
            let command_failed = tool_name == "Bash"
                && match content.get("exitCode") {
                    Some(Value::Number(code)) => code.as_i64() != Some(0),
                    Some(Value::Null) => true,
                    _ => false,
                };
            ToolsExecuteResult {
                tool_call_id,
                ok: !command_failed,
                is_error: command_failed.then_some(true),
                content,
                duration_ms: started.elapsed().as_millis() as u64,
                denied: None,
                error_code: command_failed.then_some("TOOL_FAILED".into()),
                command_shell_id,
            }
        }
        Err((code, message)) => {
            let read_path_is_directory = code == READ_PATH_IS_DIRECTORY;
            let public_code = if read_path_is_directory {
                "INVALID_ARGUMENT".to_string()
            } else {
                code
            };
            let mut content = json!({ "error": message, "code": public_code.clone() });
            if read_path_is_directory {
                content["suggestedTool"] = json!("Glob");
                content["suggestedArgs"] = json!({
                    "path": args.get("path").and_then(Value::as_str).unwrap_or_default(),
                    "pattern": "**/*",
                });
            }
            ToolsExecuteResult {
                tool_call_id,
                ok: false,
                is_error: Some(true),
                content,
                duration_ms: started.elapsed().as_millis() as u64,
                denied: Some(
                    public_code == "TOOL_DENIED" || public_code == "PATH_OUTSIDE_WORKSPACE",
                ),
                error_code: Some(public_code),
                command_shell_id,
            }
        }
    }
}

fn require_workspace(workspace: Option<&Path>) -> Result<&Path, (String, String)> {
    workspace.ok_or_else(|| ("WORKSPACE_REQUIRED".into(), "No workspace is open".into()))
}

/// Path shown to the model and recorded downstream: workspace files keep the
/// familiar workspace-relative form; scratch files stay absolute so they are
/// unambiguous (the model addresses scratch by absolute path only).
fn display_tool_path(root_kind: ToolRoot, workspace_root: &Path, resolved: &Path) -> String {
    match root_kind {
        ToolRoot::Workspace => relative_display(workspace_root, resolved),
        ToolRoot::Scratch | ToolRoot::External => resolved.to_string_lossy().to_string(),
    }
}

fn root_label(root_kind: ToolRoot) -> &'static str {
    match root_kind {
        ToolRoot::Workspace => "workspace",
        ToolRoot::Scratch => "scratch",
        ToolRoot::External => "external",
    }
}

fn tool_read(
    workspace: Option<&Path>,
    scratch: Option<&Path>,
    args: &Value,
    allow_external_paths: bool,
) -> Result<Value, (String, String)> {
    let root = require_workspace(workspace)?;
    let path = args
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| ("INVALID_ARGUMENT".into(), "path required".into()))?;
    let (resolved, root_kind) =
        resolve_tool_path_with_external(root, scratch, path, allow_external_paths)
            .map_err(|e| (e.clone(), e))?;
    let offset = args
        .get("offset")
        .and_then(|v| v.as_u64())
        .unwrap_or(0)
        .min(usize::MAX as u64) as usize;
    // A window, not a whole file: an unpaginated Read was the single largest
    // context consumer measured (154KB average), and the old >512KB refusal
    // pushed the model into hand-rolled `sed`/`awk` pipelines instead.
    let limit = args
        .get("limit")
        .and_then(|v| v.as_u64())
        .map(|v| v.min(usize::MAX as u64) as usize)
        .filter(|v| *v > 0)
        .unwrap_or(DEFAULT_READ_LINES)
        .min(BUDGET_SEARCH.max_lines);

    let meta = std::fs::metadata(&resolved)
        .map_err(|e| ("TOOL_FAILED".into(), format!("read failed: {e}")))?;
    if meta.is_dir() {
        return Err((
            READ_PATH_IS_DIRECTORY.into(),
            format!(
                "Read requires a file, but {path} is a directory; use Glob with path={path:?} and pattern=\"**/*\" (activate Glob first if it is deferred)"
            ),
        ));
    }
    if !meta.is_file() {
        return Err((
            "INVALID_ARGUMENT".into(),
            format!("Read requires a regular file: {path}"),
        ));
    }
    let display = display_tool_path(root_kind, root, &resolved);
    let extension = resolved
        .extension()
        .map(|ext| ext.to_string_lossy().to_lowercase());
    if let Some(ext) = &extension {
        if BINARY_EXTENSIONS.contains(&ext.as_str()) {
            return Err((
                "TOOL_BINARY_CONTENT".into(),
                format!("{display} is a binary file (.{ext}) and has no text to read"),
            ));
        }
    }

    let mut reader = LineReader::open(&resolved)
        .map_err(|e| ("TOOL_FAILED".into(), format!("read failed: {e}")))?;
    if reader.looks_binary() {
        return Err((
            "TOOL_BINARY_CONTENT".into(),
            format!("{display} looks like binary content and was not read as text"),
        ));
    }

    // Pre-scan total line count so the model always knows the file's scale
    // and can decide whether to grep-first or read sequentially.
    let total_line_count = count_lines_fast(&resolved)
        .map_err(|e| ("TOOL_FAILED".into(), format!("read failed: {e}")))?;

    let read_error = |e: std::io::Error| ("TOOL_FAILED".to_string(), format!("read failed: {e}"));
    let mut eof = false;
    let mut skipped = 0_usize;
    while skipped < offset {
        match reader.next_line(MAX_LINE_CHARS).map_err(read_error)? {
            Some(_) => skipped += 1,
            None => {
                eof = true;
                break;
            }
        }
    }

    let mut kept: Vec<String> = Vec::new();
    let mut bytes = 0_usize;
    let mut clipped_lines = 0_usize;
    let mut budget_capped = false;
    while !eof && kept.len() < limit {
        match reader.next_line(MAX_LINE_CHARS).map_err(read_error)? {
            Some(line) => {
                let size = line.text.len() + usize::from(!kept.is_empty());
                if bytes + size > BUDGET_SEARCH.max_bytes {
                    budget_capped = true;
                    break;
                }
                bytes += size;
                if line.clipped {
                    clipped_lines += 1;
                }
                kept.push(line.text);
            }
            None => eof = true,
        }
    }
    // Distinguish "stopped on the limit" from "reached the end", so the notice
    // can promise a useful next offset instead of guessing.
    let mut has_more = budget_capped;
    if !eof && !budget_capped {
        match reader.next_line(1).map_err(read_error)? {
            Some(_) => has_more = true,
            None => {}
        }
    }

    let mut notes: Vec<String> = Vec::new();
    if kept.is_empty() && offset > 0 {
        notes.push(format!(
            "offset {offset} is past the end of the file ({total_line_count} lines total)"
        ));
    }
    if budget_capped {
        notes.push(format!(
            "stopped at the {}KB result budget",
            BUDGET_SEARCH.max_bytes / 1024
        ));
    }
    if has_more {
        notes.push(format!(
            "{total_line_count} lines total; next offset is {}",
            offset + kept.len()
        ));
    } else if !(kept.is_empty() && offset > 0) {
        notes.push(format!("end of file ({total_line_count} lines total)"));
    }
    if clipped_lines > 0 {
        notes.push(format!(
            "{clipped_lines} line(s) longer than {MAX_LINE_CHARS} characters were cut"
        ));
    }

    // `truncated` means this window was cut — budget or a clipped line —
    // not merely that the file continues after it. `totalLines` / `offset` /
    // `lineCount` already describe pagination; treating a full window as
    // truncated made every long file look like a failure.
    let mut out = json!({
        "path": display,
        "root": root_label(root_kind),
        "content": kept.join("\n"),
        "truncated": budget_capped || clipped_lines > 0,
        "offset": offset,
        "lineCount": kept.len(),
        "totalLines": total_line_count,
        "fileBytes": meta.len(),
    });
    if !notes.is_empty() {
        out["notice"] = json!(notes.join("; "));
    }
    Ok(out)
}

fn tool_write(
    workspace: Option<&Path>,
    scratch: Option<&Path>,
    args: &Value,
    allow_external_paths: bool,
) -> Result<Value, (String, String)> {
    let root = require_workspace(workspace)?;
    let path = args
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| ("INVALID_ARGUMENT".into(), "path required".into()))?;
    let content = args
        .get("content")
        .and_then(|v| v.as_str())
        .ok_or_else(|| ("INVALID_ARGUMENT".into(), "content required".into()))?;
    let (resolved, root_kind) =
        resolve_tool_path_with_external(root, scratch, path, allow_external_paths)
            .map_err(|e| (e.clone(), e))?;
    if let Some(parent) = resolved.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| ("TOOL_FAILED".into(), format!("mkdir failed: {e}")))?;
    }
    std::fs::write(&resolved, content)
        .map_err(|e| ("TOOL_FAILED".into(), format!("write failed: {e}")))?;
    Ok(json!({
        "path": display_tool_path(root_kind, root, &resolved),
        "root": root_label(root_kind),
        "bytes": content.len(),
    }))
}

fn tool_edit(
    workspace: Option<&Path>,
    scratch: Option<&Path>,
    args: &Value,
    allow_external_paths: bool,
) -> Result<Value, (String, String)> {
    let root = require_workspace(workspace)?;
    let path = args
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| ("INVALID_ARGUMENT".into(), "path required".into()))?;
    let old_str = args
        .get("old_string")
        .or_else(|| args.get("oldString"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| ("INVALID_ARGUMENT".into(), "old_string required".into()))?;
    let new_str = args
        .get("new_string")
        .or_else(|| args.get("newString"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| ("INVALID_ARGUMENT".into(), "new_string required".into()))?;
    let (resolved, root_kind) =
        resolve_tool_path_with_external(root, scratch, path, allow_external_paths)
            .map_err(|e| (e.clone(), e))?;
    let original = std::fs::read_to_string(&resolved)
        .map_err(|e| ("TOOL_FAILED".into(), format!("read failed: {e}")))?;

    // CRLF normalization: Read tool strips \r before returning content to the
    // model, so old_str/new_str always use LF-only line endings.  When the file
    // on disk uses CRLF we must normalize before matching and restore afterwards.
    let has_crlf = original.contains("\r\n");
    let normalized = if has_crlf {
        original.replace("\r\n", "\n")
    } else {
        original.clone()
    };

    let match_count = normalized.match_indices(old_str).count();
    if match_count == 0 {
        return Err((
            "TOOL_FAILED".into(),
            "old_string not found in file; re-read the current file and retry with a fresh, unique context instead of repairing an old patch".into(),
        ));
    }
    if match_count > 1 {
        return Err((
            "TOOL_FAILED".into(),
            format!(
                "old_string matches {match_count} locations; re-read the current file and include more surrounding context"
            ),
        ));
    }
    let updated = normalized.replacen(old_str, new_str, 1);
    // Restore CRLF line endings if the original file used them.
    let updated = if has_crlf {
        updated.replace("\n", "\r\n")
    } else {
        updated
    };
    std::fs::write(&resolved, &updated)
        .map_err(|e| ("TOOL_FAILED".into(), format!("write failed: {e}")))?;
    Ok(json!({
        "path": display_tool_path(root_kind, root, &resolved),
        "root": root_label(root_kind),
        "replacements": 1,
    }))
}

fn build_glob_set(pattern: &str) -> Result<globset::GlobSet, (String, String)> {
    let glob = globset::GlobBuilder::new(pattern)
        .literal_separator(true)
        .build()
        .map_err(|e| ("INVALID_ARGUMENT".into(), e.to_string()))?;
    let mut set = globset::GlobSetBuilder::new();
    set.add(glob);
    set.build()
        .map_err(|e| ("INVALID_ARGUMENT".into(), e.to_string()))
}

/// A pattern matches either the path relative to the search root or the bare
/// file name, so both `src/**/*.ts` and `*.ts` do what the caller meant.
/// Returning nothing for `*.ts` is what sends the model back to shell `find`.
fn glob_matches(set: &globset::GlobSet, relative: &Path) -> bool {
    if set.is_match(relative) {
        return true;
    }
    relative
        .file_name()
        .map(|name| set.is_match(Path::new(name)))
        .unwrap_or(false)
}

/// Resolve the optional `path` argument to a search root.
///
/// Returns the root plus whether it was explicitly scoped, which decides how
/// ignore files apply: an explicit path is an explicit request, so only ignore
/// files at or below it count. Otherwise a `path` pointing into an ignored tree
/// (`node_modules`, `dist`) would be filtered to zero matches by the
/// workspace's own `.gitignore` — again pushing the model back to the shell.
#[derive(Debug, Clone, Copy)]
enum SearchPathKind {
    DirectoryOnly,
    FileOrDirectory,
}

fn search_root(
    root: &Path,
    scratch: Option<&Path>,
    args: &Value,
    allow_external_paths: bool,
    expected: SearchPathKind,
) -> Result<(PathBuf, ToolRoot, bool), (String, String)> {
    match args
        .get("path")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|p| !p.is_empty())
    {
        Some(path) => {
            let (resolved, kind) =
                resolve_tool_path_with_external(root, scratch, path, allow_external_paths)
                    .map_err(|e| (e.clone(), e))?;
            let accepted = resolved.is_dir()
                || matches!(expected, SearchPathKind::FileOrDirectory) && resolved.is_file();
            if !accepted {
                let expected_label = match expected {
                    SearchPathKind::DirectoryOnly => "a directory",
                    SearchPathKind::FileOrDirectory => "a file or directory",
                };
                return Err((
                    "INVALID_ARGUMENT".into(),
                    format!("path is not {expected_label}: {path}"),
                ));
            }
            Ok((resolved, kind, true))
        }
        None => Ok((root.to_path_buf(), ToolRoot::Workspace, false)),
    }
}

fn candidate_files(
    search_root: &Path,
    scoped: bool,
    include: Option<&globset::GlobSet>,
    max_files: usize,
) -> (Vec<PathBuf>, bool) {
    if search_root.is_file() {
        let relative = search_root
            .file_name()
            .map(Path::new)
            .unwrap_or(search_root);
        if include.is_some_and(|set| !glob_matches(set, relative)) {
            return (Vec::new(), false);
        }
        return (vec![search_root.to_path_buf()], false);
    }

    let mut walker = WalkBuilder::new(search_root);
    walker.hidden(false).git_ignore(true);
    if scoped {
        walker.parents(false);
    }
    let mut candidates: Vec<(PathBuf, SystemTime)> = Vec::new();
    let mut capped = false;
    for entry in walker.build().flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let relative = path.strip_prefix(search_root).unwrap_or(path);
        if let Some(set) = include {
            if !glob_matches(set, relative) {
                continue;
            }
        }
        if candidates.len() >= max_files {
            capped = true;
            break;
        }
        let mtime = entry
            .metadata()
            .ok()
            .and_then(|meta| meta.modified().ok())
            .unwrap_or(UNIX_EPOCH);
        candidates.push((path.to_path_buf(), mtime));
    }
    // Most recently touched first: the file someone just edited is far more
    // likely to be the one the question is about than an alphabetically early
    // one, so a capped result keeps the useful half.
    candidates.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    (
        candidates.into_iter().map(|(path, _)| path).collect(),
        capped,
    )
}

fn tool_glob(
    workspace: Option<&Path>,
    scratch: Option<&Path>,
    args: &Value,
    allow_external_paths: bool,
) -> Result<Value, (String, String)> {
    let root = require_workspace(workspace)?;
    let pattern = args
        .get("pattern")
        .and_then(|v| v.as_str())
        .unwrap_or("**/*");
    let set = build_glob_set(pattern)?;
    let (search_dir, root_kind, scoped) = search_root(
        root,
        scratch,
        args,
        allow_external_paths,
        SearchPathKind::DirectoryOnly,
    )?;
    let limit = args
        .get("limit")
        .and_then(|v| v.as_u64())
        .map(|v| v.min(GLOB_MAX_LIMIT as u64) as usize)
        .filter(|v| *v > 0)
        .unwrap_or(GLOB_DEFAULT_LIMIT);

    let (files, mut truncated) =
        candidate_files(&search_dir, scoped, Some(&set), GLOB_MAX_LIMIT * 8);
    let mut matches: Vec<String> = Vec::new();
    let mut bytes = 0_usize;
    for path in &files {
        if matches.len() >= limit {
            truncated = true;
            break;
        }
        let shown = display_tool_path(root_kind, root, path);
        bytes += shown.len() + 8;
        if bytes > BUDGET_SEARCH.max_bytes {
            truncated = true;
            break;
        }
        matches.push(shown);
    }

    let mut out = json!({
        "matches": matches,
        "count": matches.len(),
        "truncated": truncated,
    });
    if truncated {
        out["notice"] = json!(format!(
            "more files match; raise limit (max {GLOB_MAX_LIMIT}) or narrow pattern/path. Results are ordered by modification time, newest first"
        ));
    }
    Ok(out)
}

fn tool_grep(
    workspace: Option<&Path>,
    scratch: Option<&Path>,
    args: &Value,
    allow_external_paths: bool,
) -> Result<Value, (String, String)> {
    let root = require_workspace(workspace)?;
    let pattern = args
        .get("pattern")
        .and_then(|v| v.as_str())
        .ok_or_else(|| ("INVALID_ARGUMENT".into(), "pattern required".into()))?;
    let re = RegexBuilder::new(pattern)
        .case_insensitive(
            args.get("caseInsensitive")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
        )
        .build()
        .map_err(|e| ("INVALID_ARGUMENT".into(), e.to_string()))?;
    let (search_dir, root_kind, scoped) = search_root(
        root,
        scratch,
        args,
        allow_external_paths,
        SearchPathKind::FileOrDirectory,
    )?;
    let include = args
        .get("include")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(build_glob_set)
        .transpose()?;
    let mode = match args.get("outputMode").and_then(|v| v.as_str()) {
        Some("files_with_matches") | Some("files-with-matches") => "filesWithMatches",
        Some(value) => value,
        None => "content",
    };
    if !matches!(mode, "content" | "filesWithMatches" | "count") {
        return Err((
            "INVALID_ARGUMENT".into(),
            format!("unknown outputMode: {mode} (content | filesWithMatches | count)"),
        ));
    }
    let head_limit = args
        .get("headLimit")
        .and_then(|v| v.as_u64())
        .map(|v| v.min(BUDGET_SEARCH.max_lines as u64) as usize)
        .filter(|v| *v > 0)
        .unwrap_or(GREP_DEFAULT_HEAD_LIMIT);
    let include_pattern = args
        .get("include")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|p| !p.is_empty());
    let case_insensitive = args
        .get("caseInsensitive")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    // Prefer a system `rg` when one is installed (Codex's search default).
    // The result shape, budgets, newest-first order, and scoped-ignore rule
    // stay host-defined; a missing or failing binary falls through.
    if let Some(value) = grep_rg::try_system_rg(grep_rg::SystemGrep {
        pattern,
        search_dir: &search_dir,
        workspace_root: root,
        root_kind,
        scoped,
        include: include_pattern,
        mode,
        case_insensitive,
        head_limit,
    }) {
        return Ok(value);
    }

    let (files, mut truncated) = candidate_files(
        &search_dir,
        scoped,
        include.as_ref(),
        GREP_MAX_CANDIDATE_FILES,
    );

    let mut hits: Vec<Value> = Vec::new();
    let mut counts: Vec<Value> = Vec::new();
    let mut matched_files: Vec<String> = Vec::new();
    let mut total_matches = 0_usize;
    let mut clipped_lines = 0_usize;
    let mut bytes = 0_usize;
    'files: for path in &files {
        let Ok(mut reader) = LineReader::open(path) else {
            continue;
        };
        // Skipped rather than lossily decoded: a regex over mangled bytes
        // produces hits nobody can act on.
        if reader.looks_binary() {
            continue;
        }
        let shown = display_tool_path(root_kind, root, path);
        let mut line_no = 0_usize;
        let mut file_matches = 0_usize;
        // A read error mid-file is treated as end of file: partial matches from
        // what was readable beat dropping the file entirely.
        while let Ok(Some(line)) = reader.next_line(MAX_LINE_CHARS) {
            line_no += 1;
            if !re.is_match(&line.text) {
                continue;
            }
            file_matches += 1;
            total_matches += 1;
            if line.clipped {
                clipped_lines += 1;
            }
            match mode {
                "content" => {
                    // 48 bytes covers the JSON envelope of one hit.
                    bytes += shown.len() + line.text.len() + 48;
                    if hits.len() >= head_limit || bytes > BUDGET_SEARCH.max_bytes {
                        truncated = true;
                        break 'files;
                    }
                    hits.push(json!({
                        "path": shown,
                        "line": line_no,
                        "text": line.text,
                    }));
                }
                // One hit settles it; no reason to read the rest of the file.
                "filesWithMatches" => break,
                _ => {}
            }
        }
        if file_matches == 0 {
            continue;
        }
        matched_files.push(shown.clone());
        if mode == "count" {
            counts.push(json!({ "path": shown, "count": file_matches }));
        }
        if mode != "content" && matched_files.len() >= head_limit {
            truncated = true;
            break;
        }
    }

    Ok(grep_output(
        mode,
        hits,
        counts,
        matched_files,
        total_matches,
        clipped_lines,
        truncated,
    ))
}

pub(super) fn grep_output(
    mode: &str,
    hits: Vec<Value>,
    counts: Vec<Value>,
    matched_files: Vec<String>,
    total_matches: usize,
    clipped_lines: usize,
    truncated: bool,
) -> Value {
    let mut notes: Vec<String> = Vec::new();
    if truncated {
        notes.push(
            "results are truncated (ordered by modification time, newest first); narrow path/include or raise headLimit".into(),
        );
    }
    if clipped_lines > 0 {
        notes.push(format!(
            "{clipped_lines} matching line(s) longer than {MAX_LINE_CHARS} characters were cut"
        ));
    }

    let mut out = match mode {
        "filesWithMatches" => json!({
            "files": matched_files,
            "count": total_matches,
            "truncated": truncated,
        }),
        "count" => json!({
            "counts": counts,
            "count": total_matches,
            "truncated": truncated,
        }),
        _ => json!({
            "matches": hits,
            "count": hits.len(),
            "files": matched_files.len(),
            "truncated": truncated,
        }),
    };
    if !notes.is_empty() {
        out["notice"] = json!(notes.join("; "));
    }
    out
}

#[derive(Debug, Clone, Copy)]
enum OutputStream {
    Stdout,
    Stderr,
}

impl OutputStream {
    fn as_str(self) -> &'static str {
        match self {
            Self::Stdout => "stdout",
            Self::Stderr => "stderr",
        }
    }
}

#[derive(Debug)]
struct OutputChunk {
    stream: OutputStream,
    bytes: Vec<u8>,
}

#[derive(Debug, Default)]
struct Utf8Decoder {
    pending: Vec<u8>,
}

impl Utf8Decoder {
    fn push(&mut self, bytes: &[u8]) -> String {
        self.pending.extend_from_slice(bytes);
        let mut output = String::new();
        loop {
            match std::str::from_utf8(&self.pending) {
                Ok(text) => {
                    output.push_str(text);
                    self.pending.clear();
                    break;
                }
                Err(error) => {
                    let valid = error.valid_up_to();
                    if valid > 0 {
                        output.push_str(
                            std::str::from_utf8(&self.pending[..valid])
                                .expect("valid UTF-8 prefix"),
                        );
                        self.pending.drain(..valid);
                        continue;
                    }
                    if let Some(error_len) = error.error_len() {
                        output.push('\u{FFFD}');
                        self.pending.drain(..error_len.max(1));
                        continue;
                    }
                    // An incomplete code point is retained for the next pipe
                    // chunk, so a notification never splits valid UTF-8.
                    break;
                }
            }
        }
        output
    }

    fn finish(&mut self) -> String {
        if self.pending.is_empty() {
            return String::new();
        }
        let output = String::from_utf8_lossy(&self.pending).to_string();
        self.pending.clear();
        output
    }
}

#[derive(Debug, Default)]
struct CapturedOutput {
    bytes: Vec<u8>,
    decoder: Utf8Decoder,
    retained_lines: usize,
    omitted_bytes: u64,
    omitted_lines: u64,
    truncated: bool,
}

impl CapturedOutput {
    fn push(&mut self, bytes: &[u8]) -> String {
        let decoded = self.decoder.push(bytes);
        self.retain(&decoded);
        decoded
    }

    fn finish(&mut self) -> String {
        let decoded = self.decoder.finish();
        self.retain(&decoded);
        decoded
    }

    fn retain(&mut self, text: &str) {
        if text.is_empty() {
            return;
        }
        if self.truncated && self.bytes.len() >= CAPTURE_MAX_BYTES {
            self.note_omitted(text);
            return;
        }

        let mut text_end = text.len();
        let mut lines = self.retained_lines;
        if lines >= CAPTURE_MAX_LINES {
            text_end = 0;
        } else {
            for (index, character) in text.char_indices() {
                if character == '\n' {
                    lines += 1;
                    if lines >= CAPTURE_MAX_LINES {
                        text_end = index + character.len_utf8();
                        break;
                    }
                }
            }
        }

        let capacity = CAPTURE_MAX_BYTES.saturating_sub(self.bytes.len());
        let mut byte_end = text_end.min(capacity);
        while byte_end > 0 && !text.is_char_boundary(byte_end) {
            byte_end -= 1;
        }
        self.bytes
            .extend_from_slice(text.as_bytes().get(..byte_end).unwrap_or_default());
        self.retained_lines += text[..byte_end]
            .bytes()
            .filter(|byte| *byte == b'\n')
            .count();

        if byte_end < text.len() {
            self.truncated = true;
            self.note_omitted(&text[byte_end..]);
        }
    }

    fn note_omitted(&mut self, text: &str) {
        self.omitted_bytes = self.omitted_bytes.saturating_add(text.len() as u64);
        self.omitted_lines = self.omitted_lines.saturating_add(
            text.bytes().filter(|byte| *byte == b'\n').count() as u64
                + u64::from(!text.is_empty() && !text.ends_with('\n')),
        );
    }

    fn result(&self) -> (String, bool) {
        let mut text = String::from_utf8_lossy(&self.bytes).to_string();
        if self.truncated {
            text.push_str(&format!(
                "\n\n[truncated: output exceeded {}KB or {} lines; omitted {} bytes and {} lines]",
                CAPTURE_MAX_BYTES / 1024,
                CAPTURE_MAX_LINES,
                self.omitted_bytes,
                self.omitted_lines
            ));
        }
        (text, self.truncated)
    }
}

#[derive(Debug)]
struct OutputNotifier {
    tx: Option<mpsc::UnboundedSender<String>>,
    session_id: String,
    tool_call_id: String,
    command_shell_id: String,
    stdout: String,
    stderr: String,
    sent: usize,
    dropped_bytes: u64,
    dropped_lines: u64,
    last_emit: Instant,
}

impl OutputNotifier {
    fn new(options: &BashExecutionOptions) -> Self {
        Self {
            tx: options.output_tx.clone(),
            session_id: options.session_id.clone(),
            tool_call_id: options.tool_call_id.clone(),
            command_shell_id: options.command_shell_id.clone(),
            stdout: String::new(),
            stderr: String::new(),
            sent: 0,
            dropped_bytes: 0,
            dropped_lines: 0,
            last_emit: Instant::now(),
        }
    }

    fn push(&mut self, stream: OutputStream, chunk: String) {
        if chunk.is_empty() {
            return;
        }
        if self.tx.is_none() || self.sent >= MAX_OUTPUT_NOTIFICATIONS {
            self.note_dropped(&chunk);
            return;
        }
        let pending = match stream {
            OutputStream::Stdout => &mut self.stdout,
            OutputStream::Stderr => &mut self.stderr,
        };
        pending.push_str(&chunk);
        if pending.len() >= OUTPUT_NOTIFICATION_MAX_CHUNK_BYTES
            || self.last_emit.elapsed() >= OUTPUT_NOTIFICATION_INTERVAL
        {
            self.flush_stream(stream);
        }
    }

    fn flush_stream(&mut self, stream: OutputStream) {
        let pending = match stream {
            OutputStream::Stdout => &mut self.stdout,
            OutputStream::Stderr => &mut self.stderr,
        };
        if pending.is_empty() {
            return;
        }
        if self.sent >= MAX_OUTPUT_NOTIFICATIONS {
            let dropped = std::mem::take(pending);
            self.note_dropped(&dropped);
            return;
        }
        let chunk = std::mem::take(pending);
        let notification = json!({
            "jsonrpc": "2.0",
            "method": "tools.output",
            "params": {
                "sessionId": self.session_id,
                "toolCallId": self.tool_call_id,
                "commandShellId": self.command_shell_id,
                "stream": stream.as_str(),
                "chunk": chunk,
            }
        });
        if let (Some(tx), Ok(raw)) = (self.tx.as_ref(), serde_json::to_string(&notification)) {
            let _ = tx.send(format!("{raw}\n"));
            self.sent += 1;
            self.last_emit = Instant::now();
        }
    }

    fn note_dropped(&mut self, text: &str) {
        self.dropped_bytes = self.dropped_bytes.saturating_add(text.len() as u64);
        self.dropped_lines = self.dropped_lines.saturating_add(
            text.bytes().filter(|byte| *byte == b'\n').count() as u64
                + u64::from(!text.is_empty() && !text.ends_with('\n')),
        );
    }

    fn finish(&mut self) {
        self.flush_stream(OutputStream::Stdout);
        self.flush_stream(OutputStream::Stderr);
        if self.dropped_bytes == 0 || self.sent >= MAX_OUTPUT_NOTIFICATIONS {
            return;
        }
        let marker = format!(
            "\n\n[tool output notifications truncated: omitted {} bytes and {} lines]",
            self.dropped_bytes, self.dropped_lines
        );
        self.stdout.push_str(&marker);
        self.flush_stream(OutputStream::Stdout);
    }

    fn flush_due(&mut self) {
        if self.last_emit.elapsed() < OUTPUT_NOTIFICATION_INTERVAL {
            return;
        }
        self.flush_stream(OutputStream::Stdout);
        self.flush_stream(OutputStream::Stderr);
    }
}

async fn read_pipe<R>(pipe: Option<R>, stream: OutputStream, tx: mpsc::Sender<OutputChunk>)
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    let Some(mut pipe) = pipe else {
        return;
    };
    let mut buffer = [0u8; 8192];
    loop {
        match pipe.read(&mut buffer).await {
            Ok(0) => break,
            Ok(read) => {
                if tx
                    .send(OutputChunk {
                        stream,
                        bytes: buffer[..read].to_vec(),
                    })
                    .await
                    .is_err()
                {
                    break;
                }
            }
            Err(_) => break,
        }
    }
}

fn process_output_chunk(
    chunk: OutputChunk,
    stdout: &mut CapturedOutput,
    stderr: &mut CapturedOutput,
    notifier: &mut OutputNotifier,
) {
    let decoded = match chunk.stream {
        OutputStream::Stdout => stdout.push(&chunk.bytes),
        OutputStream::Stderr => stderr.push(&chunk.bytes),
    };
    notifier.push(chunk.stream, decoded);
}

async fn wait_for_cancellation(receiver: &mut Option<watch::Receiver<bool>>) -> bool {
    let Some(receiver) = receiver.as_mut() else {
        return pending::<bool>().await;
    };
    if *receiver.borrow() {
        return true;
    }
    loop {
        if receiver.changed().await.is_err() {
            return pending::<bool>().await;
        }
        if *receiver.borrow() {
            return true;
        }
    }
}

struct SpawnedToolRunner {
    pid: u32,
    ownership: ProcessOwnership,
    control: Option<ChildStdin>,
    stdout: Option<ChildStdout>,
    stderr: Option<ChildStderr>,
    wait_task: tokio::task::JoinHandle<std::io::Result<ExitStatus>>,
}

async fn spawn_tool_runner(
    config: &ToolRunnerStartConfig,
) -> Result<SpawnedToolRunner, (String, String)> {
    #[cfg(not(test))]
    let config_frame =
        encode_runner_config(config).map_err(|error| ("TOOL_FAILED".to_string(), error))?;

    #[cfg(not(test))]
    let mut command = {
        let executable = std::env::current_exe().map_err(|error| {
            (
                "TOOL_FAILED".to_string(),
                format!("failed to resolve host-core executable: {error}"),
            )
        })?;
        let mut command = Command::new(executable);
        command.arg(INTERNAL_TOOL_RUNNER_FLAG);
        command
    };

    // Unit tests run inside libtest's harness rather than the host binary. A
    // direct resolved-shell child keeps those tests focused on ownership and
    // descendant cleanup while production always uses the hidden runner mode.
    #[cfg(test)]
    let mut command = Command::new(&config.program);

    #[cfg(test)]
    {
        command.args(&config.args).current_dir(&config.workspace);
        if let Some(scratch_dir) = config.scratch_dir.as_deref() {
            command.env("PI_SCRATCH_DIR", scratch_dir);
        }
        if let Some(path) = config.env_path.as_deref() {
            command.env("PATH", path);
        }
    }

    #[cfg(not(test))]
    command.stdin(Stdio::piped());
    #[cfg(test)]
    command.stdin(Stdio::null());
    command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);

    let mut child = spawn_with_retries(&mut command).await?;
    let pid = child.id().unwrap_or_default();
    #[allow(unused_mut)]
    let mut ownership = match ProcessOwnership::assign(&child) {
        Ok(ownership) => ownership,
        Err(error) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            return Err((
                "TOOL_FAILED".into(),
                format!("shell runner process ownership failed: {error}"),
            ));
        }
    };

    #[allow(unused_mut)]
    let mut control = child.stdin.take();
    #[cfg(not(test))]
    {
        let Some(mut control_pipe) = control.take() else {
            let _ = ownership.terminate_fail_closed(pid);
            let _ = child.kill().await;
            let _ = child.wait().await;
            return Err((
                "TOOL_FAILED".into(),
                "shell runner did not expose its control pipe".into(),
            ));
        };
        let write_result = control_pipe.write_all(&config_frame).await;
        let flush_result = if write_result.is_ok() {
            control_pipe.flush().await
        } else {
            Ok(())
        };
        if let Err(error) = write_result.and(flush_result) {
            let _ = ownership.terminate_fail_closed(pid);
            let _ = child.kill().await;
            let _ = child.wait().await;
            return Err((
                "TOOL_FAILED".into(),
                format!("failed to start shell runner: {error}"),
            ));
        }
        control = Some(control_pipe);
    }

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let wait_task = tokio::spawn(async move { child.wait().await });
    Ok(SpawnedToolRunner {
        pid,
        ownership,
        control,
        stdout,
        stderr,
        wait_task,
    })
}

fn terminate_runner_tree(pid: u32, ownership: &mut ProcessOwnership) -> Result<(), String> {
    ownership.terminate_fail_closed(pid)
}

async fn kill_and_reap(
    pid: u32,
    ownership: &mut ProcessOwnership,
    control: &mut Option<ChildStdin>,
    wait_task: &mut tokio::task::JoinHandle<std::io::Result<ExitStatus>>,
) -> Result<(), String> {
    // Closing the control pipe lets the Unix runner apply its own process-group
    // cleanup. The host also terminates the owned tree and waits for the runner
    // so no child is left unreaped.
    control.take();
    let mut termination_error = terminate_runner_tree(pid, ownership).err();
    let mut waited = tokio::time::timeout(PROCESS_TERMINATION_TIMEOUT, &mut *wait_task).await;
    if waited.is_err() {
        if let Err(error) = terminate_runner_tree(pid, ownership) {
            termination_error.get_or_insert(error);
        }
        // A killed runner must eventually be reaped. Do not detach or abort
        // this wait task when the bounded grace period expires.
        waited = Ok((&mut *wait_task).await);
    }

    if let Some(error) = termination_error {
        return Err(error);
    }
    match waited {
        Ok(Ok(Ok(_))) => Ok(()),
        Ok(Ok(Err(error))) => Err(format!("shell runner wait failed: {error}")),
        Ok(Err(error)) => Err(format!("shell runner wait task failed: {error}")),
        Err(_) => Err("shell runner wait timed out".into()),
    }
}

#[allow(clippy::too_many_arguments)]
async fn drain_output(
    output_rx: &mut mpsc::Receiver<OutputChunk>,
    output_closed: &mut bool,
    stdout: &mut CapturedOutput,
    stderr: &mut CapturedOutput,
    notifier: &mut OutputNotifier,
    stdout_task: &mut tokio::task::JoinHandle<()>,
    stderr_task: &mut tokio::task::JoinHandle<()>,
    pid: u32,
    ownership: &mut ProcessOwnership,
    control: &mut Option<ChildStdin>,
) -> Result<(), String> {
    let drain = async {
        while let Some(chunk) = output_rx.recv().await {
            process_output_chunk(chunk, stdout, stderr, notifier);
        }
        *output_closed = true;
    };
    if tokio::time::timeout(PIPE_DRAIN_TIMEOUT, drain)
        .await
        .is_err()
    {
        control.take();
        let termination_error = terminate_runner_tree(pid, ownership).err();
        stdout_task.abort();
        stderr_task.abort();
        let _ = stdout_task.await;
        let _ = stderr_task.await;
        if let Some(error) = termination_error {
            return Err(error);
        }
    } else {
        let _ = stdout_task.await;
        let _ = stderr_task.await;
    }
    Ok(())
}

enum BashStop {
    Exited(Result<Result<ExitStatus, std::io::Error>, tokio::task::JoinError>),
    TimedOut,
    Aborted,
    LifecycleFailed(String),
}

async fn tool_bash(
    workspace: Option<&Path>,
    scratch: Option<&Path>,
    args: &Value,
    options: BashExecutionOptions,
) -> Result<Value, (String, String)> {
    let timeout_ms = options.timeout_ms.unwrap_or(DEFAULT_BASH_TIMEOUT_MS);
    validate_bash_timeout_ms(timeout_ms)?;
    let root = require_workspace(workspace)?;
    let command = args
        .get("command")
        .and_then(|v| v.as_str())
        .ok_or_else(|| ("INVALID_ARGUMENT".into(), "command required".into()))?;

    let resolved = shell::resolve_shell(&options.command_shell_id)
        .map_err(|message| ("SHELL_NOT_FOUND".to_string(), message))?;
    let invocation = shell::build_invocation_for_platform(
        shell::current_platform(),
        &options.command_shell_id,
        resolved.program,
        command,
    )
    .map_err(|message| {
        let code = if message.contains("NUL") || message.contains("too long") {
            "INVALID_ARGUMENT"
        } else {
            "SHELL_NOT_FOUND"
        };
        (code.into(), message)
    })?;

    let config = ToolRunnerStartConfig {
        program: invocation.program,
        args: invocation.args,
        workspace: root.to_path_buf(),
        scratch_dir: scratch.map(Path::to_path_buf),
        env_path: shell::user_login_path().map(str::to_string),
    };
    let SpawnedToolRunner {
        pid,
        mut ownership,
        mut control,
        stdout,
        stderr,
        mut wait_task,
    } = spawn_tool_runner(&config).await?;

    // Drain both pipes in small chunks while the child is running. Waiting for
    // the process first can deadlock once a command exceeds the OS pipe size.
    let (chunk_tx, mut output_rx) = mpsc::channel(OUTPUT_CHANNEL_CAPACITY);
    let stdout_task = tokio::spawn(read_pipe(stdout, OutputStream::Stdout, chunk_tx.clone()));
    let stderr_task = tokio::spawn(read_pipe(stderr, OutputStream::Stderr, chunk_tx.clone()));
    drop(chunk_tx);

    let timeout_future = tokio::time::sleep(Duration::from_millis(timeout_ms));
    tokio::pin!(timeout_future);
    let mut cancellation = options.cancellation.clone();
    let mut stdout = CapturedOutput::default();
    let mut stderr = CapturedOutput::default();
    let mut notifier = OutputNotifier::new(&options);
    let mut output_tick = tokio::time::interval(OUTPUT_NOTIFICATION_INTERVAL);
    let mut output_closed = false;

    let stop = loop {
        tokio::select! {
            waited = &mut wait_task => {
                break BashStop::Exited(waited);
            }
            chunk = output_rx.recv(), if !output_closed => {
                match chunk {
                    Some(chunk) => process_output_chunk(chunk, &mut stdout, &mut stderr, &mut notifier),
                    None => output_closed = true,
                }
            }
            _ = output_tick.tick() => {
                notifier.flush_due();
            }
            _ = &mut timeout_future => {
                match kill_and_reap(pid, &mut ownership, &mut control, &mut wait_task).await {
                    Ok(()) => break BashStop::TimedOut,
                    Err(error) => break BashStop::LifecycleFailed(error),
                }
            }
            cancelled = wait_for_cancellation(&mut cancellation) => {
                if cancelled {
                    match kill_and_reap(pid, &mut ownership, &mut control, &mut wait_task).await {
                        Ok(()) => break BashStop::Aborted,
                        Err(error) => break BashStop::LifecycleFailed(error),
                    }
                }
            }
        }
    };

    let mut stdout_task = stdout_task;
    let mut stderr_task = stderr_task;
    let drain_result = drain_output(
        &mut output_rx,
        &mut output_closed,
        &mut stdout,
        &mut stderr,
        &mut notifier,
        &mut stdout_task,
        &mut stderr_task,
        pid,
        &mut ownership,
        &mut control,
    )
    .await;
    let stop = match drain_result {
        Ok(()) => stop,
        Err(error) => BashStop::LifecycleFailed(error),
    };
    notifier.push(OutputStream::Stdout, stdout.finish());
    notifier.push(OutputStream::Stderr, stderr.finish());
    notifier.finish();

    match stop {
        BashStop::TimedOut => Err(("TOOL_TIMEOUT".into(), "bash timed out".into())),
        BashStop::Aborted => Err(("TOOL_ABORTED".into(), "bash aborted".into())),
        BashStop::LifecycleFailed(error) => Err((
            "TOOL_FAILED".into(),
            format!("bash process lifecycle failed: {error}"),
        )),
        BashStop::Exited(waited) => {
            let status = waited
                .map_err(|error| ("TOOL_FAILED".into(), format!("bash wait failed: {error}")))?
                .map_err(|error| ("TOOL_FAILED".into(), format!("bash failed: {error}")))?;
            let (stdout, stream_trunc_out) = stdout.result();
            let (stderr, stream_trunc_err) = stderr.result();
            if let Some(error) = stderr
                .split_once(INTERNAL_RUNNER_ERROR_PREFIX)
                .and_then(|(_, value)| value.lines().next())
            {
                if let Some((code, message)) = error.split_once('\t') {
                    return Err((code.to_string(), message.to_string()));
                }
            }
            // The streaming capture above bounds what the host holds in memory;
            // these budgets bound what reaches the model's context, which is far
            // smaller. stderr keeps its tail because a failing command's
            // actionable message is the last thing it prints, and the
            // over-budget copy spills to scratch so the marker can name a real
            // file to Grep instead of just apologizing. The runner-error probe
            // runs first: the marker must be found before the tail budget can
            // cut it away.
            let (stdout, budget_trunc_out) =
                truncate_with_spill(&stdout, BUDGET_SHELL, scratch, "bash-stdout");
            let (stderr, budget_trunc_err) =
                truncate_with_spill(&stderr, BUDGET_SHELL_ERR, scratch, "bash-stderr");
            let trunc_out = stream_trunc_out || budget_trunc_out;
            let trunc_err = stream_trunc_err || budget_trunc_err;
            Ok(json!({
                "exitCode": status.code(),
                "stdout": stdout,
                "stderr": stderr,
                "truncated": trunc_out || trunc_err,
                "commandShellId": options.command_shell_id,
            }))
        }
    }
}

fn relative_display(root: &Path, path: &Path) -> String {
    // `path` comes back canonicalized from the resolver; strip against the
    // canonical root spelling too, or symlinked roots (macOS /var vs
    // /private/var) would render absolute.
    let canonical_root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    path.strip_prefix(&canonical_root)
        .or_else(|_| path.strip_prefix(root))
        .unwrap_or(path)
        .to_string_lossy()
        .to_string()
}

pub fn builtin_tool_defs() -> Value {
    // Descriptions carry the real limits and the scoping parameters on purpose:
    // when a tool looks like it can only do the naive thing, the model routes
    // around it through Bash, and hand-rolled shell pipelines are what blew up
    // context in the first place.
    json!([
        {
            "name": "Read",
            "description": format!(
                "Read a window of an existing regular text file inside the workspace or the session scratch directory. \
                 Read never accepts a directory; activate and use Glob when a directory must be listed or the file name is uncertain. \
                 Returns at most {} lines ({}KB) starting at `offset`; lines longer than {} characters are cut. \
                 `totalLines` is always reported so you know the file scale upfront. \
                 `truncated` is true only when this window was cut short (budget or a clipped line), not merely because the file continues. \
                 For files beyond the default window, Grep to locate the target, then Read the range with offset/limit. \
                 Prefer this over `cat`/`sed`/`head` in Bash.",
                DEFAULT_READ_LINES,
                BUDGET_SEARCH.max_bytes / 1024,
                MAX_LINE_CHARS
            ),
            "risk": "low",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Existing regular file only, never a directory; workspace-relative or absolute inside the scratch directory" },
                    "offset": { "type": "integer", "description": "0-based line to start at (default 0)", "minimum": 0 },
                    "limit": { "type": "integer", "description": format!("Lines to read (default {}, max {})", DEFAULT_READ_LINES, BUDGET_SEARCH.max_lines), "minimum": 1 }
                },
                "required": ["path"]
            }
        },
        {
            "name": "Glob",
            "description": format!(
                "List files by glob pattern, newest first. Returns at most `limit` entries (default {}, max {}). \
                 The pattern matches either the path relative to the search root or the bare file name, so both \
                 `src/**/*.ts` and `*.ts` work. Prefer this over `find`/`ls` in Bash.",
                GLOB_DEFAULT_LIMIT, GLOB_MAX_LIMIT
            ),
            "risk": "low",
            "parameters": {
                "type": "object",
                "properties": {
                    "pattern": { "type": "string", "description": "Glob pattern, e.g. `**/*.rs`" },
                    "path": { "type": "string", "description": "Directory to search in; defaults to the workspace root. Pass it explicitly to search inside a git-ignored tree such as node_modules or dist" },
                    "limit": { "type": "integer", "description": format!("Max entries (default {}, max {})", GLOB_DEFAULT_LIMIT, GLOB_MAX_LIMIT), "minimum": 1 }
                },
                "required": ["pattern"]
            }
        },
        {
            "name": "Grep",
            "description": format!(
                "Search file contents by regex, results ordered by file modification time (newest first). \
                 Uses the system's `rg` when installed, otherwise an in-process searcher; the result shape is the same. \
                 `path` may name one file or a directory tree. \
                 Returns at most `headLimit` matches (default {}, hard budget {}KB) and cuts matching lines at \
                 {} characters. Scope with `path` and `include` rather than filtering shell `grep`/`rg` output; use \
                 `outputMode: \"filesWithMatches\"` or `\"count\"` when you only need the file list or tallies.",
                GREP_DEFAULT_HEAD_LIMIT,
                BUDGET_SEARCH.max_bytes / 1024,
                MAX_LINE_CHARS
            ),
            "risk": "low",
            "parameters": {
                "type": "object",
                "properties": {
                    "pattern": { "type": "string", "description": "Rust-regex pattern matched per line" },
                    "path": { "type": "string", "description": "File or directory to search; defaults to the workspace root. Pass it explicitly to search inside a git-ignored tree such as node_modules or dist" },
                    "include": { "type": "string", "description": "Glob filter on file path or name, e.g. `*.{ts,tsx}`" },
                    "outputMode": { "type": "string", "enum": ["content", "filesWithMatches", "count"], "description": "content (default): matching lines; filesWithMatches: matching file paths; count: per-file match counts" },
                    "headLimit": { "type": "integer", "description": format!("Max matches (content) or files (other modes); default {}", GREP_DEFAULT_HEAD_LIMIT), "minimum": 1 },
                    "caseInsensitive": { "type": "boolean" }
                },
                "required": ["pattern"]
            }
        },
        {
            "name": "Write",
            "description": "Create or overwrite a file inside the workspace or the session scratch directory",
            "risk": "high",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "content": { "type": "string" }
                },
                "required": ["path", "content"]
            }
        },
        {
            "name": "Edit",
            "description": "Replace one unique text occurrence in a workspace or scratch-directory file; re-read before retrying stale or ambiguous context",
            "risk": "high",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": { "type": "string" },
                    "old_string": { "type": "string" },
                    "new_string": { "type": "string" }
                },
                "required": ["path", "old_string", "new_string"]
            }
        },
        {
            "name": "Bash",
            "description": format!(
                "Run a non-interactive shell command in the workspace. stdout keeps its first {}KB, stderr its \
                 last {}KB, and anything over budget is spilled to a file named in the truncation marker. \
                 Use Read/Glob/Grep for reading and searching instead of shell equivalents; when a shell search \
                 is genuinely needed prefer `rg` and exclude build output.",
                BUDGET_SHELL.max_bytes / 1024,
                BUDGET_SHELL_ERR.max_bytes / 1024
            ),
            "risk": "high",
            "parameters": {
                "type": "object",
                "properties": { "command": { "type": "string" } },
                "required": ["command"]
            }
        }
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bash_timeout_defaults_at_the_tool_boundary() {
        assert_eq!(
            effective_timeout_ms("Bash", None),
            Some(DEFAULT_BASH_TIMEOUT_MS)
        );
        assert_eq!(
            effective_timeout_ms("Bash", Some(MIN_BASH_TIMEOUT_MS)),
            Some(MIN_BASH_TIMEOUT_MS)
        );
        assert_eq!(effective_timeout_ms("Read", None), None);
    }

    #[test]
    fn bash_timeout_accepts_one_through_three_hundred_seconds() {
        assert!(validate_bash_timeout_ms(MIN_BASH_TIMEOUT_MS).is_ok());
        assert!(validate_bash_timeout_ms(MAX_BASH_TIMEOUT_MS).is_ok());
        assert!(validate_bash_timeout_ms(MIN_BASH_TIMEOUT_MS - 1).is_err());
        assert!(validate_bash_timeout_ms(MAX_BASH_TIMEOUT_MS + 1).is_err());
    }

    #[test]
    fn runner_config_frame_validation_rejects_malformed_payloads() {
        let config = ToolRunnerStartConfig {
            program: PathBuf::from("resolved-shell"),
            args: vec!["-c".into(), "printf test".into()],
            workspace: PathBuf::from("workspace"),
            scratch_dir: None,
            env_path: None,
        };
        let frame = encode_runner_config(&config).unwrap();
        assert_eq!(decode_runner_config(&frame).unwrap().args, config.args);

        let mut wrong_length = frame.clone();
        wrong_length[0] = wrong_length[0].saturating_add(1);
        assert!(decode_runner_config(&wrong_length).is_err());

        let mut invalid_json = (8u32).to_le_bytes().to_vec();
        invalid_json.extend_from_slice(b"not-json");
        assert!(decode_runner_config(&invalid_json).is_err());

        let nul_config = ToolRunnerStartConfig {
            program: PathBuf::from("resolved-shell"),
            args: vec!["bad\0arg".into()],
            workspace: PathBuf::from("workspace"),
            scratch_dir: None,
            env_path: None,
        };
        assert!(encode_runner_config(&nul_config).is_err());
    }

    #[tokio::test]
    async fn bash_large_output_does_not_deadlock() {
        // >64KB (OS pipe buffer) must not deadlock the child; reader tasks
        // drain concurrently with wait(). Single line under BUDGET_SHELL so
        // full drainage is observable in the returned stdout.
        let dir = tempfile::tempdir().unwrap();
        #[cfg(windows)]
        let command = "[Console]::Out.Write('a' * 80000)";
        #[cfg(not(windows))]
        let command = "head -c 80000 /dev/zero | tr '\\0' 'a'";
        let result = execute_tool(
            Some(dir.path()),
            None,
            "Bash",
            &serde_json::json!({ "command": command }),
            15_000,
        )
        .await;
        assert!(result.ok, "bash tool failed: {:?}", result.content);
        let stdout = result.content["stdout"].as_str().unwrap_or_default();
        assert_eq!(stdout.len(), 80_000, "stdout fully drained");
        assert_eq!(result.content["truncated"].as_bool(), Some(false));
    }

    #[tokio::test]
    async fn bash_nonzero_exit_preserves_output_and_marks_failure() {
        let dir = tempfile::tempdir().unwrap();
        #[cfg(windows)]
        let command = "[Console]::Error.Write('diagnostic'); exit 7";
        #[cfg(not(windows))]
        let command = "printf 'diagnostic' >&2; exit 7";
        let result = execute_tool(
            Some(dir.path()),
            None,
            "Bash",
            &serde_json::json!({ "command": command }),
            15_000,
        )
        .await;

        assert!(!result.ok);
        assert_eq!(result.is_error, Some(true));
        assert_eq!(result.error_code.as_deref(), Some("TOOL_FAILED"));
        assert_eq!(result.content["exitCode"].as_i64(), Some(7));
        assert_eq!(result.content["stderr"].as_str(), Some("diagnostic"));
    }

    #[tokio::test]
    async fn bash_over_budget_output_spills_to_scratch() {
        let ws = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let scratch = data.path().join("scratch/session-spill");
        let lines = BUDGET_SHELL.max_lines + 500;
        let result = execute_tool(
            Some(ws.path()),
            Some(&scratch),
            "Bash",
            &serde_json::json!({ "command": format!("seq 1 {lines}") }),
            30_000,
        )
        .await;
        assert!(result.ok, "bash tool failed: {:?}", result.content);
        assert_eq!(result.content["truncated"].as_bool(), Some(true));
        let stdout = result.content["stdout"].as_str().unwrap();
        assert!(stdout.starts_with("1\n2\n"), "head retained");
        assert!(stdout.contains("[truncated:"), "marker present");

        // The marker names a spill file that holds the whole output.
        let spill_dir = scratch.join("tool-output");
        let spilled: Vec<_> = std::fs::read_dir(&spill_dir).unwrap().flatten().collect();
        assert_eq!(spilled.len(), 1, "one spill file per truncated stream");
        let spill_path = spilled[0].path();
        assert!(
            stdout.contains(&spill_path.display().to_string()),
            "marker points at the spill file: {stdout:?}"
        );
        let full = std::fs::read_to_string(&spill_path).unwrap();
        assert_eq!(full.lines().count(), lines, "spill kept every line");
    }

    #[tokio::test]
    async fn bash_stderr_keeps_the_tail() {
        // A failing command's actionable message is its last line.
        let ws = tempfile::tempdir().unwrap();
        let lines = BUDGET_SHELL_ERR.max_lines + 200;
        let result = execute_tool(
            Some(ws.path()),
            None,
            "Bash",
            &serde_json::json!({
                "command": format!("seq 1 {lines} >&2; printf 'error: the real problem\\n' >&2; exit 2")
            }),
            30_000,
        )
        .await;
        assert!(!result.ok);
        let stderr = result.content["stderr"].as_str().unwrap();
        assert!(
            stderr.trim_end().ends_with("error: the real problem"),
            "tail retained: {:?}",
            &stderr[stderr.len().saturating_sub(120)..]
        );
        assert!(stderr.starts_with("[truncated:"), "marker leads a tail cut");
    }

    #[test]
    fn single_oversized_line_keeps_a_prefix() {
        // Minified bundles are one enormous line: keeping nothing would be
        // worse than keeping a clipped prefix.
        let text = "x".repeat(BUDGET_SEARCH.max_bytes * 2);
        let (out, truncated) = truncate_with_spill(&text, BUDGET_SEARCH, None, "test");
        assert!(truncated);
        assert!(out.starts_with(&"x".repeat(1000)));
        assert!(out.contains("no complete line fits"));
        assert!(out.len() < BUDGET_SEARCH.max_bytes + 512);
    }

    #[tokio::test]
    async fn read_paginates_instead_of_refusing_large_files() {
        let dir = tempfile::tempdir().unwrap();
        let big = dir.path().join("big.txt");
        // Comfortably past the 512KB the old implementation refused outright.
        let body: String = (1..=70_000).map(|n| format!("line {n}\n")).collect();
        assert!(body.len() > 512 * 1024);
        std::fs::write(&big, &body).unwrap();

        let first = execute_tool(
            Some(dir.path()),
            None,
            "Read",
            &serde_json::json!({ "path": "big.txt" }),
            5_000,
        )
        .await;
        assert!(first.ok, "read failed: {:?}", first.content);
        assert_eq!(
            first.content["lineCount"].as_u64(),
            Some(DEFAULT_READ_LINES as u64)
        );
        assert_eq!(first.content["totalLines"].as_u64(), Some(70_000));
        let content = first.content["content"].as_str().unwrap();
        assert!(content.starts_with("line 1\nline 2\n"));
        assert!(content.ends_with(&format!("line {DEFAULT_READ_LINES}")));
        assert!(content.len() <= BUDGET_SEARCH.max_bytes);
        assert_eq!(
            first.content["truncated"].as_bool(),
            Some(false),
            "a full default window is pagination, not truncation: {:?}",
            first.content["notice"]
        );
        let notice = first.content["notice"].as_str().unwrap();
        assert!(notice.contains("70000 lines total"));
        assert!(notice.contains(&format!("next offset is {DEFAULT_READ_LINES}")));

        let tail = execute_tool(
            Some(dir.path()),
            None,
            "Read",
            &serde_json::json!({ "path": "big.txt", "offset": 69_998, "limit": 10 }),
            5_000,
        )
        .await;
        assert!(tail.ok, "read failed: {:?}", tail.content);
        assert_eq!(
            tail.content["content"].as_str(),
            Some("line 69999\nline 70000")
        );
        assert_eq!(tail.content["totalLines"].as_u64(), Some(70_000));
        assert!(tail.content["notice"]
            .as_str()
            .unwrap()
            .contains("end of file"));
    }

    #[tokio::test]
    async fn read_clips_overlong_lines() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("bundle.min.js"),
            format!("{}\nshort\n", "a".repeat(MAX_LINE_CHARS * 3)),
        )
        .unwrap();
        let result = execute_tool(
            Some(dir.path()),
            None,
            "Read",
            &serde_json::json!({ "path": "bundle.min.js" }),
            5_000,
        )
        .await;
        assert!(result.ok, "read failed: {:?}", result.content);
        let content = result.content["content"].as_str().unwrap();
        let first_line = content.lines().next().unwrap();
        assert_eq!(first_line.chars().count(), MAX_LINE_CHARS);
        assert!(content.ends_with("\nshort"), "later lines survive");
        assert!(result.content["notice"]
            .as_str()
            .unwrap()
            .contains(&format!("longer than {MAX_LINE_CHARS} characters")));
        assert_eq!(result.content["truncated"].as_bool(), Some(true));
    }

    #[tokio::test]
    async fn read_does_not_mark_a_filled_window_truncated() {
        let dir = tempfile::tempdir().unwrap();
        let body: String = (1..=120).map(|n| format!("line {n}\n")).collect();
        std::fs::write(dir.path().join("notes.txt"), &body).unwrap();

        let window = execute_tool(
            Some(dir.path()),
            None,
            "Read",
            &serde_json::json!({ "path": "notes.txt", "offset": 10, "limit": 20 }),
            5_000,
        )
        .await;
        assert!(window.ok, "read failed: {:?}", window.content);
        assert_eq!(window.content["lineCount"].as_u64(), Some(20));
        assert_eq!(window.content["totalLines"].as_u64(), Some(120));
        assert_eq!(window.content["truncated"].as_bool(), Some(false));
        assert_eq!(
            window.content["content"].as_str().unwrap().lines().next(),
            Some("line 11")
        );
        let notice = window.content["notice"].as_str().unwrap();
        assert!(notice.contains("next offset is 30"), "{notice}");
        assert!(!notice.contains("use Grep"), "{notice}");

        let whole = execute_tool(
            Some(dir.path()),
            None,
            "Read",
            &serde_json::json!({ "path": "notes.txt" }),
            5_000,
        )
        .await;
        assert!(whole.ok, "read failed: {:?}", whole.content);
        assert_eq!(whole.content["lineCount"].as_u64(), Some(120));
        assert_eq!(whole.content["truncated"].as_bool(), Some(false));
        assert!(whole.content["notice"]
            .as_str()
            .unwrap()
            .contains("end of file"));
    }

    #[tokio::test]
    async fn read_rejects_binary_content() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("blob.dat"), b"\x00\x01\x02binary").unwrap();
        std::fs::write(dir.path().join("blob"), b"text\x00\x00\x00\x01\x02\x03").unwrap();
        for name in ["blob.dat", "blob"] {
            let result = execute_tool(
                Some(dir.path()),
                None,
                "Read",
                &serde_json::json!({ "path": name }),
                5_000,
            )
            .await;
            assert!(!result.ok, "{name} should be refused");
            assert_eq!(
                result.error_code.as_deref(),
                Some("TOOL_BINARY_CONTENT"),
                "{name}"
            );
        }
    }

    #[tokio::test]
    async fn read_rejects_directories_as_invalid_arguments_with_glob_guidance() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("src/nested")).unwrap();

        let result = execute_tool(
            Some(dir.path()),
            None,
            "Read",
            &serde_json::json!({ "path": "src" }),
            5_000,
        )
        .await;

        assert!(!result.ok);
        assert_eq!(result.error_code.as_deref(), Some("INVALID_ARGUMENT"));
        let error = result.content["error"].as_str().unwrap_or_default();
        assert!(error.contains("Read requires a file"));
        assert!(error.contains("use Glob"));
        assert!(error.contains("pattern=\"**/*\""));
        assert_eq!(result.content["suggestedTool"].as_str(), Some("Glob"));
        assert_eq!(
            result.content["suggestedArgs"]["path"].as_str(),
            Some("src")
        );
        assert_eq!(
            result.content["suggestedArgs"]["pattern"].as_str(),
            Some("**/*")
        );
    }

    #[tokio::test]
    async fn approved_external_paths_work_for_read_and_search_tools() {
        let workspace = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(outside.path().join("src")).unwrap();
        let file = outside.path().join("src/outside.rs");
        std::fs::write(&file, "const needle = 1;\n").unwrap();
        let canonical_file = file.canonicalize().unwrap();

        let read = execute_tool_with_path_access(
            Some(workspace.path()),
            None,
            "Read",
            &serde_json::json!({ "path": file.to_str().unwrap() }),
            None,
            None,
            true,
        )
        .await;
        assert!(read.ok, "external read failed: {:?}", read.content);
        assert_eq!(read.content["root"].as_str(), Some("external"));
        assert_eq!(read.content["content"].as_str(), Some("const needle = 1;"));

        let grep = execute_tool_with_path_access(
            Some(workspace.path()),
            None,
            "Grep",
            &serde_json::json!({
                "pattern": "needle",
                "path": outside.path().to_str().unwrap(),
            }),
            None,
            None,
            true,
        )
        .await;
        assert!(grep.ok, "external grep failed: {:?}", grep.content);
        assert_eq!(grep.content["count"].as_u64(), Some(1));
        assert_eq!(
            grep.content["matches"][0]["path"].as_str(),
            Some(canonical_file.to_str().unwrap())
        );

        let exact_grep = execute_tool_with_path_access(
            Some(workspace.path()),
            None,
            "Grep",
            &serde_json::json!({
                "pattern": "needle",
                "path": file.to_str().unwrap(),
            }),
            None,
            None,
            true,
        )
        .await;
        assert!(
            exact_grep.ok,
            "external exact-file grep failed: {:?}",
            exact_grep.content
        );
        assert_eq!(exact_grep.content["count"].as_u64(), Some(1));
        assert_eq!(
            exact_grep.content["matches"][0]["path"].as_str(),
            Some(canonical_file.to_str().unwrap())
        );

        let glob = execute_tool_with_path_access(
            Some(workspace.path()),
            None,
            "Glob",
            &serde_json::json!({
                "pattern": "*.rs",
                "path": outside.path().join("src").to_str().unwrap(),
            }),
            None,
            None,
            true,
        )
        .await;
        assert!(glob.ok, "external glob failed: {:?}", glob.content);
        assert_eq!(glob.content["count"].as_u64(), Some(1));
        assert_eq!(
            glob.content["matches"][0].as_str(),
            Some(canonical_file.to_str().unwrap())
        );
    }

    #[tokio::test]
    async fn approved_external_paths_work_for_write_and_edit() {
        let workspace = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let file = outside.path().join("outside.txt");

        let write = execute_tool_with_path_access(
            Some(workspace.path()),
            None,
            "Write",
            &serde_json::json!({ "path": file.to_str().unwrap(), "content": "before" }),
            None,
            None,
            true,
        )
        .await;
        assert!(write.ok, "external write failed: {:?}", write.content);
        assert_eq!(write.content["root"].as_str(), Some("external"));

        let edit = execute_tool_with_path_access(
            Some(workspace.path()),
            None,
            "Edit",
            &serde_json::json!({
                "path": file.to_str().unwrap(),
                "old_string": "before",
                "new_string": "after",
            }),
            None,
            None,
            true,
        )
        .await;
        assert!(edit.ok, "external edit failed: {:?}", edit.content);
        assert_eq!(edit.content["root"].as_str(), Some("external"));
        assert_eq!(std::fs::read_to_string(file).unwrap(), "after");
    }

    #[tokio::test]
    async fn grep_scopes_clips_and_bounds_results() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("src")).unwrap();
        std::fs::create_dir_all(dir.path().join("dist")).unwrap();
        std::fs::write(dir.path().join("src/a.ts"), "const needle = 1;\n").unwrap();
        std::fs::write(dir.path().join("src/b.md"), "needle in markdown\n").unwrap();
        std::fs::write(
            dir.path().join("dist/bundle.js"),
            format!("needle{}\n", "!".repeat(MAX_LINE_CHARS * 4)),
        )
        .unwrap();

        let scoped = execute_tool(
            Some(dir.path()),
            None,
            "Grep",
            &serde_json::json!({ "pattern": "needle", "path": "src", "include": "*.ts" }),
            5_000,
        )
        .await;
        assert!(scoped.ok, "grep failed: {:?}", scoped.content);
        assert_eq!(scoped.content["count"].as_u64(), Some(1));
        assert_eq!(
            scoped.content["matches"][0]["path"].as_str(),
            Some("src/a.ts")
        );

        // An overlong minified hit is clipped instead of carrying the bundle.
        let clipped = execute_tool(
            Some(dir.path()),
            None,
            "Grep",
            &serde_json::json!({ "pattern": "needle", "path": "dist" }),
            5_000,
        )
        .await;
        assert!(clipped.ok, "grep failed: {:?}", clipped.content);
        let text = clipped.content["matches"][0]["text"].as_str().unwrap();
        assert_eq!(text.chars().count(), MAX_LINE_CHARS);
        assert!(clipped.content["notice"]
            .as_str()
            .unwrap()
            .contains("were cut"));

        let files = execute_tool(
            Some(dir.path()),
            None,
            "Grep",
            &serde_json::json!({ "pattern": "needle", "outputMode": "filesWithMatches" }),
            5_000,
        )
        .await;
        assert!(files.ok, "grep failed: {:?}", files.content);
        let listed: Vec<&str> = files.content["files"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        assert_eq!(listed.len(), 3, "every file listed once: {listed:?}");

        // Providers sometimes normalize the camel-case enum into a shell-style
        // spelling. Keep the canonical schema while accepting those harmless
        // compatibility aliases at the host boundary.
        let aliased_files = execute_tool(
            Some(dir.path()),
            None,
            "Grep",
            &serde_json::json!({
                "pattern": "needle",
                "outputMode": "files_with_matches",
            }),
            5_000,
        )
        .await;
        assert!(
            aliased_files.ok,
            "grep alias failed: {:?}",
            aliased_files.content
        );
        assert_eq!(aliased_files.content["files"].as_array().unwrap().len(), 3);

        let counts = execute_tool(
            Some(dir.path()),
            None,
            "Grep",
            &serde_json::json!({ "pattern": "needle", "path": "src", "outputMode": "count" }),
            5_000,
        )
        .await;
        assert!(counts.ok, "grep failed: {:?}", counts.content);
        assert_eq!(counts.content["count"].as_u64(), Some(2));
        assert_eq!(counts.content["counts"].as_array().unwrap().len(), 2);

        let single_file = execute_tool(
            Some(dir.path()),
            None,
            "Grep",
            &serde_json::json!({
                "pattern": "needle",
                "path": "src/a.ts",
                "include": "*.ts",
            }),
            5_000,
        )
        .await;
        assert!(
            single_file.ok,
            "single-file grep failed: {:?}",
            single_file.content
        );
        assert_eq!(single_file.content["count"].as_u64(), Some(1));
        assert_eq!(
            single_file.content["matches"][0]["path"].as_str(),
            Some("src/a.ts")
        );

        let excluded_file = execute_tool(
            Some(dir.path()),
            None,
            "Grep",
            &serde_json::json!({
                "pattern": "needle",
                "path": "src/a.ts",
                "include": "*.md",
            }),
            5_000,
        )
        .await;
        assert!(excluded_file.ok);
        assert_eq!(excluded_file.content["count"].as_u64(), Some(0));
    }

    #[tokio::test]
    async fn grep_head_limit_bounds_hits() {
        let dir = tempfile::tempdir().unwrap();
        let body: String = (0..500).map(|_| "needle\n").collect();
        std::fs::write(dir.path().join("many.txt"), body).unwrap();
        let result = execute_tool(
            Some(dir.path()),
            None,
            "Grep",
            &serde_json::json!({ "pattern": "needle", "headLimit": 5 }),
            5_000,
        )
        .await;
        assert!(result.ok, "grep failed: {:?}", result.content);
        assert_eq!(result.content["count"].as_u64(), Some(5));
        assert_eq!(result.content["truncated"].as_bool(), Some(true));
        assert!(result.content["notice"]
            .as_str()
            .unwrap()
            .contains("headLimit"));
    }

    fn write_fake_rg(dir: &std::path::Path, script: &str) -> std::path::PathBuf {
        #[cfg(windows)]
        {
            let path = dir.join("rg.cmd");
            std::fs::write(&path, script.replace('\n', "\r\n")).unwrap();
            path
        }
        #[cfg(not(windows))]
        {
            use std::os::unix::fs::PermissionsExt;
            let path = dir.join("rg");
            std::fs::write(&path, format!("#!/bin/sh\n{script}")).unwrap();
            let mut perms = std::fs::metadata(&path).unwrap().permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(&path, perms).unwrap();
            path
        }
    }

    #[tokio::test]
    async fn grep_uses_injected_rg_when_present() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "needle in workspace\n").unwrap();
        let fake_dir = tempfile::tempdir().unwrap();
        let rg = write_fake_rg(
            fake_dir.path(),
            if cfg!(windows) {
                "@echo off\necho {\"type\":\"match\",\"data\":{\"path\":{\"text\":\"from-rg.txt\"},\"line_number\":1,\"lines\":{\"text\":\"hello from rg\"}}}\nexit /b 0\n"
            } else {
                "printf '%s\\n' '{\"type\":\"match\",\"data\":{\"path\":{\"text\":\"from-rg.txt\"},\"line_number\":1,\"lines\":{\"text\":\"hello from rg\"}}}'\n"
            },
        );
        let _guard = grep_rg::install_test_rg(rg);
        let result = execute_tool(
            Some(dir.path()),
            None,
            "Grep",
            &serde_json::json!({ "pattern": "needle" }),
            5_000,
        )
        .await;
        assert!(result.ok, "grep failed: {:?}", result.content);
        assert_eq!(result.content["count"].as_u64(), Some(1));
        assert_eq!(
            result.content["matches"][0]["path"].as_str(),
            Some("from-rg.txt")
        );
        assert_eq!(
            result.content["matches"][0]["text"].as_str(),
            Some("hello from rg")
        );
    }

    #[tokio::test]
    async fn grep_falls_back_when_rg_exits_with_error() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "needle in workspace\n").unwrap();
        let fake_dir = tempfile::tempdir().unwrap();
        let rg = write_fake_rg(
            fake_dir.path(),
            if cfg!(windows) {
                "@echo off\nexit /b 2\n"
            } else {
                "exit 2\n"
            },
        );
        let _guard = grep_rg::install_test_rg(rg);
        let result = execute_tool(
            Some(dir.path()),
            None,
            "Grep",
            &serde_json::json!({ "pattern": "needle" }),
            5_000,
        )
        .await;
        assert!(result.ok, "grep failed: {:?}", result.content);
        assert_eq!(result.content["count"].as_u64(), Some(1));
        assert_eq!(result.content["matches"][0]["path"].as_str(), Some("a.txt"));
    }

    #[tokio::test]
    async fn grep_system_rg_honors_scoped_ignore_and_head_limit() {
        let Some(rg) = super::shell::find_user_program("rg") else {
            return;
        };
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(".ignore"), "node_modules\n").unwrap();
        std::fs::create_dir_all(dir.path().join("node_modules/pkg")).unwrap();
        std::fs::write(
            dir.path().join("node_modules/pkg/index.js"),
            "export const needle = 1;\n",
        )
        .unwrap();
        let body: String = (0..50).map(|_| "needle\n").collect();
        std::fs::write(dir.path().join("many.txt"), body).unwrap();

        let _guard = grep_rg::install_test_rg(rg);
        let unscoped = execute_tool(
            Some(dir.path()),
            None,
            "Grep",
            &serde_json::json!({ "pattern": "needle" }),
            5_000,
        )
        .await;
        assert_eq!(
            unscoped.content["count"].as_u64(),
            Some(50),
            "ignored tree stays hidden: {:?}",
            unscoped.content
        );

        let scoped = execute_tool(
            Some(dir.path()),
            None,
            "Grep",
            &serde_json::json!({ "pattern": "needle", "path": "node_modules/pkg" }),
            5_000,
        )
        .await;
        assert_eq!(
            scoped.content["count"].as_u64(),
            Some(1),
            "named ignored tree is searchable: {:?}",
            scoped.content
        );

        let limited = execute_tool(
            Some(dir.path()),
            None,
            "Grep",
            &serde_json::json!({ "pattern": "needle", "path": "many.txt", "headLimit": 5 }),
            5_000,
        )
        .await;
        assert_eq!(limited.content["count"].as_u64(), Some(5));
        assert_eq!(limited.content["truncated"].as_bool(), Some(true));
    }

    #[tokio::test]
    async fn search_reaches_explicitly_named_ignored_directories() {
        // The measured failure: the agent asked about a package under
        // node_modules, got nothing back because the workspace ignore rules
        // filtered it, and fell back to hand-rolled shell pipelines. Uses
        // `.ignore` rather than `.gitignore` because the `ignore` crate only
        // honors the latter inside a real git repo; `parents(false)` governs
        // both the same way.
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(".ignore"), "node_modules\n").unwrap();
        std::fs::create_dir_all(dir.path().join("node_modules/pkg")).unwrap();
        std::fs::write(
            dir.path().join("node_modules/pkg/index.js"),
            "export const needle = 1;\n",
        )
        .unwrap();

        let unscoped = execute_tool(
            Some(dir.path()),
            None,
            "Grep",
            &serde_json::json!({ "pattern": "needle" }),
            5_000,
        )
        .await;
        assert_eq!(
            unscoped.content["count"].as_u64(),
            Some(0),
            "ignored by default"
        );

        let scoped = execute_tool(
            Some(dir.path()),
            None,
            "Grep",
            &serde_json::json!({ "pattern": "needle", "path": "node_modules/pkg" }),
            5_000,
        )
        .await;
        assert_eq!(
            scoped.content["count"].as_u64(),
            Some(1),
            "reachable when named"
        );

        let globbed = execute_tool(
            Some(dir.path()),
            None,
            "Glob",
            &serde_json::json!({ "pattern": "*.js", "path": "node_modules/pkg" }),
            5_000,
        )
        .await;
        assert_eq!(globbed.content["count"].as_u64(), Some(1));
        assert_eq!(
            globbed.content["matches"][0].as_str(),
            Some("node_modules/pkg/index.js")
        );
    }

    #[tokio::test]
    async fn glob_orders_by_mtime_and_bounds_entries() {
        let dir = tempfile::tempdir().unwrap();
        for name in ["old.rs", "mid.rs", "new.rs"] {
            std::fs::write(dir.path().join(name), "fn main() {}\n").unwrap();
            // Coarse filesystem mtime resolution needs a real gap.
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let result = execute_tool(
            Some(dir.path()),
            None,
            "Glob",
            &serde_json::json!({ "pattern": "*.rs" }),
            5_000,
        )
        .await;
        assert!(result.ok, "glob failed: {:?}", result.content);
        let matches: Vec<&str> = result.content["matches"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        assert_eq!(matches, vec!["new.rs", "mid.rs", "old.rs"]);

        let limited = execute_tool(
            Some(dir.path()),
            None,
            "Glob",
            &serde_json::json!({ "pattern": "*.rs", "limit": 1 }),
            5_000,
        )
        .await;
        assert_eq!(limited.content["count"].as_u64(), Some(1));
        assert_eq!(limited.content["truncated"].as_bool(), Some(true));

        let file_path = execute_tool(
            Some(dir.path()),
            None,
            "Glob",
            &serde_json::json!({ "pattern": "*.rs", "path": "new.rs" }),
            5_000,
        )
        .await;
        assert!(!file_path.ok);
        assert_eq!(file_path.error_code.as_deref(), Some("INVALID_ARGUMENT"));
        assert!(file_path.content["error"]
            .as_str()
            .unwrap_or_default()
            .contains("not a directory"));
    }

    #[test]
    fn tool_defs_advertise_the_scoping_parameters() {
        // The model only reaches for these instead of Bash if it can see them.
        let defs = builtin_tool_defs();
        let by_name = |name: &str| -> Value {
            defs.as_array()
                .unwrap()
                .iter()
                .find(|def| def["name"] == name)
                .unwrap()
                .clone()
        };
        let read = by_name("Read");
        assert!(read["parameters"]["properties"]["offset"].is_object());
        assert!(read["parameters"]["properties"]["limit"].is_object());
        let grep = by_name("Grep");
        for param in ["path", "include", "outputMode", "headLimit"] {
            assert!(
                grep["parameters"]["properties"][param].is_object(),
                "Grep advertises {param}"
            );
        }
        assert!(by_name("Glob")["parameters"]["properties"]["limit"].is_object());
        assert!(read["description"].as_str().unwrap().contains("2000 lines"));
        assert!(read["description"]
            .as_str()
            .unwrap()
            .contains("truncated` is true only when this window was cut"));
        assert!(read["description"]
            .as_str()
            .unwrap()
            .contains("never accepts a directory"));
        assert!(grep["parameters"]["properties"]["path"]["description"]
            .as_str()
            .unwrap()
            .contains("File or directory"));
    }

    #[tokio::test]
    async fn write_and_read_in_scratch_root() {
        let ws = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        // Not created up front: execute_tool creates it lazily for Write.
        let scratch = data.path().join("scratch/session-1");
        let target = scratch.join("notes/tmp.txt");
        let write = execute_tool(
            Some(ws.path()),
            Some(&scratch),
            "Write",
            &serde_json::json!({ "path": target.to_str().unwrap(), "content": "scratch!" }),
            5_000,
        )
        .await;
        assert!(write.ok, "scratch write failed: {:?}", write.content);
        assert_eq!(write.content["root"].as_str(), Some("scratch"));
        // Workspace stayed clean.
        assert_eq!(std::fs::read_dir(ws.path()).unwrap().count(), 0);

        let read = execute_tool(
            Some(ws.path()),
            Some(&scratch),
            "Read",
            &serde_json::json!({ "path": target.to_str().unwrap() }),
            5_000,
        )
        .await;
        assert!(read.ok, "scratch read failed: {:?}", read.content);
        assert_eq!(read.content["content"].as_str(), Some("scratch!"));
        assert_eq!(read.content["root"].as_str(), Some("scratch"));
    }

    #[tokio::test]
    async fn workspace_write_reports_workspace_root() {
        let ws = tempfile::tempdir().unwrap();
        let scratch = tempfile::tempdir().unwrap();
        let result = execute_tool(
            Some(ws.path()),
            Some(scratch.path()),
            "Write",
            &serde_json::json!({ "path": "a.txt", "content": "hi" }),
            5_000,
        )
        .await;
        assert!(result.ok);
        assert_eq!(result.content["root"].as_str(), Some("workspace"));
        assert_eq!(result.content["path"].as_str(), Some("a.txt"));
    }

    #[tokio::test]
    async fn edit_requires_fresh_unique_context() {
        let ws = tempfile::tempdir().unwrap();
        let target = ws.path().join("note.txt");
        std::fs::write(&target, "before\nbefore\n").unwrap();

        let ambiguous = execute_tool(
            Some(ws.path()),
            None,
            "Edit",
            &serde_json::json!({
                "path": "note.txt",
                "old_string": "before",
                "new_string": "after"
            }),
            5_000,
        )
        .await;
        assert!(!ambiguous.ok);
        assert!(ambiguous.content["error"]
            .as_str()
            .unwrap()
            .contains("matches 2 locations"));

        let stale = execute_tool(
            Some(ws.path()),
            None,
            "Edit",
            &serde_json::json!({
                "path": "note.txt",
                "old_string": "missing",
                "new_string": "after"
            }),
            5_000,
        )
        .await;
        assert!(!stale.ok);
        assert!(stale.content["error"]
            .as_str()
            .unwrap()
            .contains("re-read the current file"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn bash_inherits_user_login_path() {
        // D181: the Bash tool runs with the user's login-shell PATH so nvm /
        // Homebrew tools resolve; when no probe is possible it falls back to
        // the host PATH (still non-empty for the spawned bash).
        let dir = tempfile::tempdir().unwrap();
        let result = execute_tool(
            Some(dir.path()),
            None,
            "Bash",
            &serde_json::json!({ "command": "printf %s \"$PATH\"" }),
            15_000,
        )
        .await;
        assert!(result.ok, "bash failed: {:?}", result.content);
        let stdout = result.content["stdout"].as_str().unwrap_or_default();
        if let Some(user_path) = shell::user_login_path() {
            // `bash -lc` re-runs the bash profile at startup; conda/brew
            // hooks may prepend, dedupe, or reorder entries, so assert every
            // injected entry survives rather than the exact ordering.
            let injected: std::collections::HashSet<&str> = user_path.split(':').collect();
            let actual: std::collections::HashSet<&str> = stdout.split(':').collect();
            assert!(
                injected.is_subset(&actual),
                "every injected login-PATH entry is present"
            );
        } else {
            assert!(!stdout.is_empty(), "falls back to host PATH");
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn bash_exposes_scratch_dir_env() {
        let ws = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let scratch = data.path().join("scratch/session-2");
        let result = execute_tool(
            Some(ws.path()),
            Some(&scratch),
            "Bash",
            &serde_json::json!({ "command": "printf %s \"$PI_SCRATCH_DIR\"" }),
            15_000,
        )
        .await;
        assert!(result.ok, "bash failed: {:?}", result.content);
        assert_eq!(
            result.content["stdout"].as_str(),
            Some(scratch.to_str().unwrap())
        );
        assert!(scratch.is_dir(), "scratch dir created for Bash");
    }

    #[tokio::test]
    async fn bash_output_accumulator_is_bounded_and_reports_omissions() {
        let dir = tempfile::tempdir().unwrap();
        #[cfg(windows)]
        let command = "[Console]::Out.Write(('x' * 600000) -join '')";
        #[cfg(not(windows))]
        let command = "head -c 600000 /dev/zero | tr '\\0' 'x'";
        let shell_id = shell::catalog(None)
            .effective
            .expect("test platform must have a command shell")
            .id;
        let result = execute_tool_with_options(
            Some(dir.path()),
            None,
            "Bash",
            &serde_json::json!({ "command": command }),
            Some(15_000),
            Some(BashExecutionOptions {
                session_id: "bounded-session".into(),
                tool_call_id: "bounded-call".into(),
                command_shell_id: shell_id,
                timeout_ms: Some(15_000),
                cancellation: None,
                output_tx: None,
            }),
        )
        .await;
        assert!(result.ok, "bounded output failed: {:?}", result.content);
        assert_eq!(result.content["truncated"], true);
        let stdout = result.content["stdout"].as_str().unwrap_or_default();
        // Two layers bound this. The streaming capture keeps at most
        // CAPTURE_MAX_BYTES in memory, then BUDGET_SHELL bounds what reaches the
        // model. The marker the model sees is the budget layer's: 600KB arrives
        // as a single line, so head-clipping it drops the capture layer's
        // trailing note. The capture layer's own accounting is asserted directly
        // in captured_output_reports_what_it_omitted.
        assert!(
            stdout.contains("[truncated:"),
            "marker present: {:?}",
            &stdout[..stdout.len().min(200)]
        );
        assert!(
            stdout.len() < BUDGET_SHELL.max_bytes + 512,
            "budget bounds what the model sees, got {} bytes",
            stdout.len()
        );
    }

    #[test]
    fn captured_output_reports_what_it_omitted() {
        // The capture layer is what backs the spill file, so its ceiling and its
        // omission accounting are asserted here rather than through a tool call,
        // where the per-result budget would clip the evidence away.
        let mut captured = CapturedOutput::default();
        let line = "y".repeat(1023);
        let mut pushed_lines = 0_usize;
        while pushed_lines * 1024 < CAPTURE_MAX_BYTES + 64 * 1024 {
            captured.push(format!("{line}\n").as_bytes());
            pushed_lines += 1;
        }
        let (text, truncated) = captured.result();
        assert!(truncated, "capture must report hitting its ceiling");
        assert!(
            captured.omitted_bytes > 0 && captured.omitted_lines > 0,
            "omissions accounted: {} bytes / {} lines",
            captured.omitted_bytes,
            captured.omitted_lines
        );
        assert!(
            text.contains(&format!(
                "output exceeded {}KB or {} lines",
                CAPTURE_MAX_BYTES / 1024,
                CAPTURE_MAX_LINES
            )),
            "marker names the real ceilings"
        );
        // Retention is bounded by bytes, and the ceiling sits above the result
        // budget so a spilled copy can be fuller than the excerpt it backs.
        assert!(captured.bytes.len() <= CAPTURE_MAX_BYTES);
        const { assert!(CAPTURE_MAX_BYTES > BUDGET_SHELL.max_bytes) };
        const { assert!(CAPTURE_MAX_LINES > BUDGET_SHELL.max_lines) };
    }

    #[test]
    fn output_notifications_have_a_per_call_cap() {
        let (tx, rx) = mpsc::unbounded_channel();
        let options = BashExecutionOptions {
            session_id: "notification-session".into(),
            tool_call_id: "notification-call".into(),
            command_shell_id: shell::default_shell_id().into(),
            timeout_ms: None,
            cancellation: None,
            output_tx: Some(tx),
        };
        let mut notifier = OutputNotifier::new(&options);
        for _ in 0..(MAX_OUTPUT_NOTIFICATIONS + 100) {
            notifier.push(
                OutputStream::Stdout,
                "x".repeat(OUTPUT_NOTIFICATION_MAX_CHUNK_BYTES),
            );
        }
        notifier.finish();
        assert!(rx.len() <= MAX_OUTPUT_NOTIFICATIONS);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn powershell_preserves_utf8_errors_quotes_cwd_and_native_exit_codes() {
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("cwd with spaces");
        std::fs::create_dir_all(&workspace).unwrap();
        let options = || BashExecutionOptions {
            session_id: "powershell-session".into(),
            tool_call_id: "powershell-call".into(),
            command_shell_id: shell::WINDOWS_POWERSHELL_ID.into(),
            timeout_ms: Some(5_000),
            cancellation: None,
            output_tx: None,
        };

        let output = execute_tool_with_options(
            Some(&workspace),
            None,
            "Bash",
            &serde_json::json!({
                "command": "[Console]::Out.Write('stdout π \"quoted\" & <meta>'); [Console]::Error.Write('stderr π \"quoted\" & <meta>')"
            }),
            Some(5_000),
            Some(options()),
        )
        .await;
        assert!(output.ok, "PowerShell output failed: {:?}", output.content);
        assert!(output.content["stdout"]
            .as_str()
            .unwrap()
            .contains("stdout π"));
        assert!(output.content["stderr"]
            .as_str()
            .unwrap()
            .contains("stderr π"));
        assert!(output.content["stdout"]
            .as_str()
            .unwrap()
            .contains("<meta>"));

        let cwd = execute_tool_with_options(
            Some(&workspace),
            None,
            "Bash",
            &serde_json::json!({ "command": "[Console]::Out.Write((Get-Location).Path)" }),
            Some(5_000),
            Some(options()),
        )
        .await;
        assert!(cwd.ok, "PowerShell cwd failed: {:?}", cwd.content);
        let cwd_stdout = cwd.content["stdout"].as_str().unwrap_or_default();
        let normalize_windows_path =
            |path: &str| path.trim().replace("\\\\?\\", "").replace('/', "\\");
        assert!(
            normalize_windows_path(cwd_stdout).ends_with("\\cwd with spaces"),
            "cwd stdout={cwd_stdout:?}, expected suffix for {:?}",
            workspace
        );

        let error = execute_tool_with_options(
            Some(&workspace),
            None,
            "Bash",
            &serde_json::json!({
                "command": "Get-Item -LiteralPath 'missing file for pi desktop'"
            }),
            Some(5_000),
            Some(options()),
        )
        .await;
        assert_eq!(error.content["exitCode"], 1);
        let stderr = error.content["stderr"].as_str().unwrap_or_default();
        assert!(
            stderr.contains("missing file for pi desktop"),
            "PowerShell error text was {stderr:?}"
        );
        assert!(!stderr.contains("CLIXML"));
        assert!(!stderr.contains("<Objs"));

        let native = execute_tool_with_options(
            Some(&workspace),
            None,
            "Bash",
            &serde_json::json!({ "command": "cmd /c exit 7" }),
            Some(5_000),
            Some(options()),
        )
        .await;
        assert_eq!(native.content["exitCode"], 7);
    }
    #[tokio::test]
    async fn edit_normalizes_crlf_before_matching() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("crlf.txt");
        // Write a file with CRLF line endings
        std::fs::write(&target, "line one\r\nline two\r\nline three\r\n").unwrap();

        let result = execute_tool(
            Some(dir.path()),
            None,
            "Edit",
            &serde_json::json!({
                "path": "crlf.txt",
                "old_string": "line two\n",
                "new_string": "line TWO replaced\n"
            }),
            5_000,
        )
        .await;
        assert!(result.ok, "Edit failed on CRLF file: {:?}", result.content);
        assert_eq!(result.content["replacements"], 1);

        // Verify the file still has CRLF endings and the replacement was applied
        let written = std::fs::read_to_string(&target).unwrap();
        assert_eq!(written, "line one\r\nline TWO replaced\r\nline three\r\n");
    }
}
