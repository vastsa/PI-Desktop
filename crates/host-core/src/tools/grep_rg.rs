//! Optional system `rg` backend for the Grep tool.
//!
//! Codex prefers `rg` when the machine has it. PI-Desktop keeps Grep as the
//! model-facing contract (budgets, newest-first, scoped ignore) and uses a
//! direct `rg` exec as the fast path when a binary is on the user PATH.
//! Spawn failures and `rg` exit 2 fall back to the in-process searcher so a
//! missing or broken install never changes the tool's public shape.

use super::{
    cancel::ToolCancellation, clip_chars, display_tool_path, grep_output, ProcessOwnership,
    BUDGET_SEARCH, MAX_LINE_CHARS,
};
use crate::workspace::ToolRoot;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::io::AsyncReadExt;
use tokio::process::{Child, Command};

/// Cap on `rg --json` stdout so a pathological tree cannot fill host memory
/// before we apply the Grep result budget.
const RG_STDOUT_CAP: usize = 8 * 1024 * 1024;

pub struct SystemGrep<'a> {
    pub pattern: &'a str,
    pub search_dir: &'a Path,
    pub workspace_root: &'a Path,
    /// Root whose `.pi-desktopignore` applies (workspace root, or the search
    /// root for scratch/external searches).
    pub ignore_root: &'a Path,
    pub root_kind: ToolRoot,
    pub scoped: bool,
    pub include: Option<&'a str>,
    pub mode: &'a str,
    pub case_insensitive: bool,
    pub head_limit: usize,
    pub cancellation: &'a ToolCancellation,
}

#[cfg(test)]
thread_local! {
    static TEST_RG: std::cell::RefCell<Option<PathBuf>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
pub struct TestRgGuard;

#[cfg(test)]
pub fn current_test_rg() -> Option<PathBuf> {
    TEST_RG.with(|rg| rg.borrow().clone())
}

#[cfg(test)]
pub fn install_test_rg(path: PathBuf) -> TestRgGuard {
    TEST_RG.with(|rg| *rg.borrow_mut() = Some(path));
    TestRgGuard
}

#[cfg(test)]
impl Drop for TestRgGuard {
    fn drop(&mut self) {
        TEST_RG.with(|rg| *rg.borrow_mut() = None);
    }
}

pub fn try_system_rg(req: SystemGrep<'_>) -> Result<Option<Value>, (String, String)> {
    req.cancellation.check()?;
    let Some(rg) = resolve_rg() else {
        return Ok(None);
    };
    // The caller remains on the blocking pool for filesystem work. Async
    // pipe reads let cancellation wake a quiet child without a watcher thread.
    tokio::runtime::Handle::current().block_on(grep_with_rg(&rg, req))
}

fn resolve_rg() -> Option<PathBuf> {
    #[cfg(test)]
    {
        TEST_RG.with(|rg| rg.borrow().clone())
    }
    #[cfg(not(test))]
    {
        if std::env::var_os("PI_DESKTOP_DISABLE_RG").is_some() {
            return None;
        }
        if let Some(overridden) = std::env::var_os("PI_DESKTOP_RG") {
            let path = PathBuf::from(overridden);
            return path.is_file().then_some(path);
        }
        crate::tools::shell::find_user_program("rg")
    }
}

async fn grep_with_rg(rg: &Path, req: SystemGrep<'_>) -> Result<Option<Value>, (String, String)> {
    let mut args: Vec<String> = vec!["--json".into(), "--no-config".into(), "--hidden".into()];
    // Per-file cap: content never needs more than headLimit hits from one file.
    // count mode needs the real per-file total, so it is left unbounded.
    if req.mode == "filesWithMatches" {
        args.push("--max-count".into());
        args.push("1".into());
    } else if req.mode == "content" {
        // One extra match lets the host set `truncated` the same way the
        // in-process path peeks past headLimit.
        args.push("--max-count".into());
        args.push(req.head_limit.saturating_add(1).to_string());
    }
    if req.case_insensitive {
        args.push("-i".into());
    }
    if req.scoped {
        args.push("--no-ignore-parent".into());
    }
    args.extend(super::ignore_rules::rg_args(req.ignore_root, req.scoped));
    if let Some(include) = req.include {
        args.push("--glob".into());
        args.push(include.to_string());
    }
    args.push("-e".into());
    args.push(req.pattern.to_string());
    args.push("--".into());
    args.push(req.search_dir.to_string_lossy().into_owned());

    req.cancellation.check()?;
    let mut command = Command::new(rg);
    command
        .args(&args)
        // Anchor ignore patterns at the same root as the in-process walker.
        .current_dir(req.ignore_root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(super::windows_tool_runner_creation_flags(
        super::windows_breakaway_allowed(),
    ));
    #[cfg(unix)]
    command.process_group(0);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(_) => return Ok(None),
    };
    let mut ownership = match ProcessOwnership::assign(&child) {
        Ok(ownership) => ownership,
        Err(error) => {
            tracing::warn!(%error, "rg process ownership failed");
            child.kill().await.map_err(rg_lifecycle_error)?;
            return Ok(None);
        }
    };
    let Some(mut stdout) = child.stdout.take() else {
        stop_and_reap(&mut child, &mut ownership).await?;
        return Ok(None);
    };
    let mut chunk = [0_u8; 64 * 1024];
    let mut raw = Vec::new();
    let mut total = 0_usize;
    let mut capped = false;
    let mut parsed: BTreeMap<PathBuf, FileHits> = BTreeMap::new();
    loop {
        let read = tokio::select! {
            biased;
            _ = req.cancellation.cancelled() => {
                stop_and_reap(&mut child, &mut ownership).await?;
                return Err(super::cancel::Cancelled.into());
            },
            read = stdout.read(&mut chunk) => read,
        };
        let size = match read {
            Ok(0) => break,
            Ok(size) => size,
            Err(_) => {
                stop_and_reap(&mut child, &mut ownership).await?;
                return Ok(None);
            }
        };
        total = total.saturating_add(size);
        if total > RG_STDOUT_CAP {
            capped = true;
            stop_and_reap(&mut child, &mut ownership).await?;
            break;
        }
        let mut scan_from = raw.len();
        raw.extend_from_slice(&chunk[..size]);
        let mut consumed = 0;
        while let Some(newline) = raw[scan_from..].iter().position(|byte| *byte == b'\n') {
            let end = scan_from + newline;
            consume_rg_line(
                &String::from_utf8_lossy(&raw[consumed..end]),
                req.search_dir,
                &mut parsed,
            );
            consumed = end + 1;
            scan_from = consumed;
        }
        raw.drain(..consumed);
    }
    if !raw.is_empty() && !capped {
        consume_rg_line(&String::from_utf8_lossy(&raw), req.search_dir, &mut parsed);
    }
    if !capped {
        let status = tokio::select! {
            biased;
            _ = req.cancellation.cancelled() => {
                stop_and_reap(&mut child, &mut ownership).await?;
                return Err(super::cancel::Cancelled.into());
            },
            status = child.wait() => match status {
                Ok(status) => status,
                Err(error) => {
                    stop_and_reap(&mut child, &mut ownership).await?;
                    return Err(rg_lifecycle_error(error));
                }
            },
        };
        // 0 = matches, 1 = no matches. A broken rg still falls back; Stop does not.
        if !status.success() && status.code() != Some(1) {
            return Ok(None);
        }
    }
    req.cancellation.check()?;
    Ok(Some(build_result(req, parsed, capped)?))
}

fn rg_lifecycle_error(error: std::io::Error) -> (String, String) {
    (
        "INTERNAL".into(),
        format!("rg process lifecycle failed: {error}"),
    )
}

async fn stop_and_reap(
    child: &mut Child,
    ownership: &mut ProcessOwnership,
) -> Result<(), (String, String)> {
    let termination_error = child
        .id()
        .and_then(|pid| ownership.terminate_fail_closed(pid).err());
    if termination_error.is_some() {
        // Best-effort root kill after the ownership fallback, but do not hide
        // a failure to terminate the complete process tree.
        let _ = child.start_kill();
    }
    // Even after a termination error, reap before releasing tool admission.
    child.wait().await.map_err(rg_lifecycle_error)?;
    match termination_error {
        Some(error) => Err(("INTERNAL".into(), format!("rg termination failed: {error}"))),
        None => Ok(()),
    }
}

struct FileHits {
    mtime: SystemTime,
    lines: Vec<(usize, String, bool)>,
}

fn consume_rg_line(line: &str, search_dir: &Path, parsed: &mut BTreeMap<PathBuf, FileHits>) {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return;
    }
    let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
        return;
    };
    if value.get("type").and_then(Value::as_str) != Some("match") {
        return;
    }
    let data = match value.get("data") {
        Some(data) => data,
        None => return,
    };
    let path_text = data
        .get("path")
        .and_then(|p| p.get("text"))
        .and_then(Value::as_str)
        .unwrap_or("");
    if path_text.is_empty() {
        return;
    }
    let mut path = PathBuf::from(path_text);
    if path.is_relative() {
        path = search_dir.join(path);
    }
    // Belt and braces for the security denylist: `.env.*` cannot be expressed
    // as an rg exclude glob without flipping the run into whitelist mode.
    if super::ignore_rules::is_sensitive_path(&path) {
        return;
    }
    let line_no = data.get("line_number").and_then(Value::as_u64).unwrap_or(0) as usize;
    let text = data
        .get("lines")
        .and_then(|l| l.get("text"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim_end_matches('\n')
        .trim_end_matches('\r')
        .to_string();
    let (text, clipped) = clip_chars(text, MAX_LINE_CHARS);
    let mtime = std::fs::metadata(&path)
        .ok()
        .and_then(|meta| meta.modified().ok())
        .unwrap_or(UNIX_EPOCH);
    let entry = parsed.entry(path).or_insert_with(|| FileHits {
        mtime,
        lines: Vec::new(),
    });
    entry.lines.push((line_no, text, clipped));
}

fn build_result(
    req: SystemGrep<'_>,
    parsed: BTreeMap<PathBuf, FileHits>,
    stdout_capped: bool,
) -> Result<Value, (String, String)> {
    req.cancellation.check()?;
    let mut files: Vec<(PathBuf, FileHits)> = parsed.into_iter().collect();
    files.sort_by(|a, b| b.1.mtime.cmp(&a.1.mtime).then_with(|| a.0.cmp(&b.0)));
    req.cancellation.check()?;

    let mut hits: Vec<Value> = Vec::new();
    let mut counts: Vec<Value> = Vec::new();
    let mut matched_files: Vec<String> = Vec::new();
    let mut total_matches = 0_usize;
    let mut clipped_lines = 0_usize;
    let mut bytes = 0_usize;
    let mut truncated = stdout_capped;

    'files: for (path, file) in files {
        req.cancellation.check()?;
        let shown = display_tool_path(req.root_kind, req.workspace_root, &path);
        let file_matches = file.lines.len();
        if file_matches == 0 {
            continue;
        }
        match req.mode {
            "content" => {
                for (line_no, text, clipped) in file.lines {
                    req.cancellation.check()?;
                    if clipped {
                        clipped_lines += 1;
                    }
                    bytes += shown.len() + text.len() + 48;
                    if hits.len() >= req.head_limit || bytes > BUDGET_SEARCH.max_bytes {
                        truncated = true;
                        break 'files;
                    }
                    hits.push(json!({
                        "path": shown,
                        "line": line_no,
                        "text": text,
                    }));
                    total_matches += 1;
                }
                matched_files.push(shown);
            }
            "filesWithMatches" => {
                total_matches += file_matches;
                matched_files.push(shown);
                if matched_files.len() >= req.head_limit {
                    truncated = true;
                    break;
                }
            }
            _ => {
                total_matches += file_matches;
                matched_files.push(shown.clone());
                counts.push(json!({ "path": shown, "count": file_matches }));
                if matched_files.len() >= req.head_limit {
                    truncated = true;
                    break;
                }
            }
        }
    }

    req.cancellation.check()?;
    Ok(grep_output(
        req.mode,
        hits,
        counts,
        matched_files,
        total_matches,
        clipped_lines,
        truncated,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn json_match_line_is_clipped_and_crlf_stripped() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.txt");
        std::fs::write(&file, "x").unwrap();
        let long = format!("needle{}\r\n", "!".repeat(MAX_LINE_CHARS + 8));
        let event = json!({
            "type": "match",
            "data": {
                "path": { "text": file.to_string_lossy() },
                "line_number": 3,
                "lines": { "text": long },
            }
        });
        let mut parsed = BTreeMap::new();
        consume_rg_line(&event.to_string(), dir.path(), &mut parsed);
        let hits = parsed.get(&file).expect("file recorded");
        assert_eq!(hits.lines.len(), 1);
        assert_eq!(hits.lines[0].0, 3);
        assert_eq!(hits.lines[0].1.chars().count(), MAX_LINE_CHARS);
        assert!(hits.lines[0].2);
        assert!(!hits.lines[0].1.contains('\r'));
    }
}
