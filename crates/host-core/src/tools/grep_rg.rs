//! Optional system `rg` backend for the Grep tool.
//!
//! Codex prefers `rg` when the machine has it. PI-Desktop keeps Grep as the
//! model-facing contract (budgets, newest-first, scoped ignore) and uses a
//! direct `rg` exec as the fast path when a binary is on the user PATH.
//! Spawn failures and `rg` exit 2 fall back to the in-process searcher so a
//! missing or broken install never changes the tool's public shape.

use super::{BUDGET_SEARCH, MAX_LINE_CHARS, clip_chars, display_tool_path, grep_output};
use crate::workspace::ToolRoot;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

/// Cap on `rg --json` stdout so a pathological tree cannot fill host memory
/// before we apply the Grep result budget.
const RG_STDOUT_CAP: usize = 8 * 1024 * 1024;

pub struct SystemGrep<'a> {
    pub pattern: &'a str,
    pub search_dir: &'a Path,
    pub workspace_root: &'a Path,
    pub root_kind: ToolRoot,
    pub scoped: bool,
    pub include: Option<&'a str>,
    pub mode: &'a str,
    pub case_insensitive: bool,
    pub head_limit: usize,
}

#[cfg(test)]
static TEST_RG: std::sync::Mutex<Option<PathBuf>> = std::sync::Mutex::new(None);

#[cfg(test)]
static TEST_RG_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
pub struct TestRgGuard {
    _serial: std::sync::MutexGuard<'static, ()>,
}

#[cfg(test)]
pub fn install_test_rg(path: PathBuf) -> TestRgGuard {
    let serial = TEST_RG_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    *TEST_RG
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(path);
    TestRgGuard { _serial: serial }
}

#[cfg(test)]
impl Drop for TestRgGuard {
    fn drop(&mut self) {
        *TEST_RG
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
    }
}

pub fn try_system_rg(req: SystemGrep<'_>) -> Option<Value> {
    let rg = resolve_rg()?;
    grep_with_rg(&rg, req)
}

fn resolve_rg() -> Option<PathBuf> {
    #[cfg(test)]
    {
        return TEST_RG
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
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

fn grep_with_rg(rg: &Path, req: SystemGrep<'_>) -> Option<Value> {
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
    if let Some(include) = req.include {
        args.push("--glob".into());
        args.push(include.to_string());
    }
    args.push("-e".into());
    args.push(req.pattern.to_string());
    args.push("--".into());
    args.push(req.search_dir.to_string_lossy().into_owned());

    let mut child = Command::new(rg)
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let stdout = child.stdout.take()?;
    let mut reader = BufReader::with_capacity(64 * 1024, stdout);
    let mut raw = String::new();
    let mut total = 0_usize;
    let mut capped = false;
    let mut parsed: BTreeMap<PathBuf, FileHits> = BTreeMap::new();
    loop {
        raw.clear();
        match reader.read_line(&mut raw) {
            Ok(0) => break,
            Ok(n) => {
                total = total.saturating_add(n);
                if total > RG_STDOUT_CAP {
                    capped = true;
                    let _ = child.kill();
                    break;
                }
                consume_rg_line(&raw, req.search_dir, &mut parsed);
            }
            Err(_) => {
                let _ = child.kill();
                return None;
            }
        }
    }
    let status = child.wait().ok()?;
    // 0 = matches, 1 = no matches. Anything else is an rg failure: fall back.
    if !status.success() && status.code() != Some(1) {
        return None;
    }

    Some(build_result(req, parsed, capped))
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
) -> Value {
    let mut files: Vec<(PathBuf, FileHits)> = parsed.into_iter().collect();
    files.sort_by(|a, b| b.1.mtime.cmp(&a.1.mtime).then_with(|| a.0.cmp(&b.0)));

    let mut hits: Vec<Value> = Vec::new();
    let mut counts: Vec<Value> = Vec::new();
    let mut matched_files: Vec<String> = Vec::new();
    let mut total_matches = 0_usize;
    let mut clipped_lines = 0_usize;
    let mut bytes = 0_usize;
    let mut truncated = stdout_capped;

    'files: for (path, file) in files {
        let shown = display_tool_path(req.root_kind, req.workspace_root, &path);
        let file_matches = file.lines.len();
        if file_matches == 0 {
            continue;
        }
        match req.mode {
            "content" => {
                for (line_no, text, clipped) in file.lines {
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

    grep_output(
        req.mode,
        hits,
        counts,
        matched_files,
        total_matches,
        clipped_lines,
        truncated,
    )
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
