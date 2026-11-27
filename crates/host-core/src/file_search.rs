//! Project text search behind the global search dialog's "Files" tab.
//!
//! The renderer never touches the filesystem, so the search runs here and the
//! window only renders rows. Walking uses ripgrep's `ignore` engine, which is
//! the same traversal `rg` uses, so `.gitignore`, hidden files, and the
//! repository's own ignore layering behave exactly like the agent's Grep tool.
//!
//! `tools::ignore_rules` supplies both the layered ignore configuration and the
//! security denylist: private keys and `.env` files are never surfaced by a
//! search, whichever directory it starts in.

use crate::tools::ignore_rules::{configure_walker, is_sensitive_path};
use ignore::WalkBuilder;
use regex::Regex;
use serde_json::{json, Value};
use std::fs;
use std::path::Path;
use std::time::Instant;

/// Rows the dialog shows before it stops and reports `truncated`.
const MAX_MATCHES: usize = 120;
/// Files larger than this are skipped: a text search in the palette only needs
/// source-sized files, and reading a multi-megabyte blob would stall the walk.
const MAX_FILE_BYTES: u64 = 1_048_576;
/// Longest line preview kept per match, in characters.
const MAX_PREVIEW_CHARS: usize = 240;
/// Queries shorter than this match nearly every file and are not useful.
const MIN_QUERY_CHARS: usize = 2;

fn preview(line: &str) -> String {
    let trimmed = line.trim_end();
    if trimmed.chars().count() <= MAX_PREVIEW_CHARS {
        return trimmed.to_string();
    }
    let head: String = trimmed.chars().take(MAX_PREVIEW_CHARS).collect();
    format!("{head}…")
}

/// Searches the text of every file under `root` and returns flat match rows.
///
/// Params: `{ root, query, caseSensitive? }`. Literal matching only: the query
/// is regex-escaped so a stray `(` or `*` cannot fail the search.
pub fn search_text(params: &Value) -> Result<Value, String> {
    let root = params
        .get("root")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "root required".to_string())?;
    let query = params
        .get("query")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "query required".to_string())?;
    if query.chars().count() < MIN_QUERY_CHARS {
        return Err(format!("query must be at least {MIN_QUERY_CHARS} characters"));
    }
    let case_sensitive = params
        .get("caseSensitive")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let root_path = Path::new(root);
    if !root_path.is_dir() {
        return Err(format!("not a directory: {root}"));
    }

    let pattern = if case_sensitive {
        regex::escape(query)
    } else {
        format!("(?i){}", regex::escape(query))
    };
    let matcher = Regex::new(&pattern).map_err(|error| format!("invalid query: {error}"))?;

    let started = Instant::now();
    let mut builder = WalkBuilder::new(root_path);
    builder.max_filesize(Some(MAX_FILE_BYTES));
    configure_walker(&mut builder, root_path, false);

    let mut matches: Vec<Value> = Vec::new();
    let mut scanned_files: usize = 0;
    let mut truncated = false;

    for entry in builder.build() {
        let Ok(entry) = entry else { continue };
        if !entry.file_type().is_some_and(|kind| kind.is_file()) {
            continue;
        }
        let path = entry.path();
        if is_sensitive_path(path) {
            continue;
        }
        scanned_files += 1;
        let Ok(bytes) = fs::read(path) else { continue };
        // Binary and non-UTF-8 files are skipped rather than lossily decoded, so
        // a match preview never contains replacement characters.
        let Ok(text) = String::from_utf8(bytes) else {
            continue;
        };
        let relative = path.strip_prefix(root_path).unwrap_or(path);
        let relative = relative.to_string_lossy().replace('\\', "/");
        for (index, line) in text.lines().enumerate() {
            let Some(found) = matcher.find(line) else {
                continue;
            };
            matches.push(json!({
                "path": relative,
                "line": index + 1,
                "column": found.start() + 1,
                "text": preview(line),
            }));
            if matches.len() >= MAX_MATCHES {
                truncated = true;
                break;
            }
        }
        if truncated {
            break;
        }
    }

    Ok(json!({
        "engine": "ignore",
        "matches": matches,
        "truncated": truncated,
        "scannedFiles": scanned_files,
        "elapsedMs": started.elapsed().as_millis() as u64,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_project(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "pi-desktop-file-search-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn finds_matching_lines_with_positions() {
        let dir = temp_project("basic");
        fs::write(dir.join("a.ts"), "const needle = 1;\nother\n").unwrap();
        fs::write(dir.join("b.ts"), "nothing here\n").unwrap();
        let result = search_text(&json!({ "root": dir, "query": "needle" })).unwrap();
        let matches = result["matches"].as_array().unwrap();
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0]["path"], "a.ts");
        assert_eq!(matches[0]["line"], 1);
        assert_eq!(matches[0]["column"], 7);
        assert_eq!(result["truncated"], false);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn is_case_insensitive_by_default() {
        let dir = temp_project("case");
        fs::write(dir.join("a.md"), "NEEDLE\n").unwrap();
        let insensitive = search_text(&json!({ "root": dir, "query": "needle" })).unwrap();
        assert_eq!(insensitive["matches"].as_array().unwrap().len(), 1);
        let sensitive =
            search_text(&json!({ "root": dir, "query": "needle", "caseSensitive": true })).unwrap();
        assert_eq!(sensitive["matches"].as_array().unwrap().len(), 0);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn never_surfaces_sensitive_files() {
        let dir = temp_project("sensitive");
        fs::write(dir.join(".env"), "needle\n").unwrap();
        fs::write(dir.join("id_rsa"), "needle\n").unwrap();
        fs::write(dir.join("ok.ts"), "needle\n").unwrap();
        let result = search_text(&json!({ "root": dir, "query": "needle" })).unwrap();
        let paths: Vec<&str> = result["matches"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| row["path"].as_str().unwrap())
            .collect();
        assert_eq!(paths, vec!["ok.ts"]);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn rejects_short_queries_and_missing_roots() {
        let dir = temp_project("guards");
        assert!(search_text(&json!({ "root": dir, "query": "a" })).is_err());
        assert!(search_text(&json!({ "query": "ab" })).is_err());
        assert!(search_text(&json!({ "root": dir })).is_err());
        fs::remove_dir_all(&dir).unwrap();
    }
}
