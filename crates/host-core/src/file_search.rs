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
//!
//! A search is complete: every matching line is kept, including matches in a
//! file that also holds tens of thousands of them. Paging exists only to bound
//! what a single IPC frame carries — a 200k-hit query stays scrollable instead
//! of stalling the window — and later pages come out of the cached scan rather
//! than a second walk.

use crate::tools::ignore_rules::{configure_walker, is_sensitive_path};
use ignore::WalkBuilder;
use regex::Regex;
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::fs;
use std::path::Path;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

/// Rows returned by one request when the caller does not ask for a size.
const DEFAULT_LIMIT: usize = 200;
/// Guard against a caller asking for an unbounded frame.
const MAX_LIMIT: usize = 2_000;
/// Files larger than this are skipped: a text search in the palette only needs
/// source-sized files, and reading a multi-megabyte blob would stall the walk.
const MAX_FILE_BYTES: u64 = 1_048_576;
/// Longest line preview kept per match, in characters.
const MAX_PREVIEW_CHARS: usize = 240;
/// Queries shorter than this match nearly every file and are not useful.
const MIN_QUERY_CHARS: usize = 2;
/// Repeated pages reuse the last scan instead of walking again. Two entries
/// cover the query being paged plus the one it just replaced.
const CACHE_ENTRIES: usize = 2;
const CACHE_TTL: Duration = Duration::from_secs(120);

/// One matching line. The path is stored once per file in [`Scan::files`] so a
/// query with a couple hundred thousand hits stays cheap in memory.
struct Hit {
    file: u32,
    line: u32,
    column: u32,
    text: Box<str>,
}

/// A finished scan for one `(root, query, caseSensitive)` key.
struct Scan {
    key: String,
    files: Vec<Box<str>>,
    hits: Vec<Hit>,
    scanned_files: usize,
    scan_ms: u64,
    created: Instant,
}

impl Scan {
    fn is_fresh(&self, key: &str) -> bool {
        self.key == key && self.created.elapsed() < CACHE_TTL
    }
}

/// Newest scan last: paging hits the tail, insertion evicts the front.
static CACHE: LazyLock<Mutex<VecDeque<Scan>>> = LazyLock::new(|| Mutex::new(VecDeque::new()));

fn cache_key(root: &str, query: &str, case_sensitive: bool) -> String {
    format!("{root}\u{1}{query}\u{1}{case_sensitive}")
}

fn preview(line: &str) -> String {
    let trimmed = line.trim_end();
    if trimmed.chars().count() <= MAX_PREVIEW_CHARS {
        return trimmed.to_string();
    }
    let head: String = trimmed.chars().take(MAX_PREVIEW_CHARS).collect();
    format!("{head}…")
}

fn cached_page(key: &str, offset: usize, limit: usize) -> Option<Value> {
    let mut cache = CACHE.lock().ok()?;
    let position = cache.iter().position(|scan| scan.is_fresh(key))?;
    let scan = cache.remove(position)?;
    // Paging renders one page from the cached scan, then refreshes its MRU spot;
    // cloning the whole hit set per page would defeat the point of the cache.
    let page = page_json(&scan, offset, limit, true);
    cache.push_back(scan);
    Some(page)
}

fn store_scan(scan: Scan) {
    let Ok(mut cache) = CACHE.lock() else { return };
    cache.retain(|entry| entry.key != scan.key);
    cache.push_back(scan);
    while cache.len() > CACHE_ENTRIES {
        cache.pop_front();
    }
}

/// Walks the project once and keeps every matching line.
///
/// A query like `se` matches a couple hundred thousand lines in a large
/// repository; the scan still keeps them all, because dropping hits is what made
/// one hot file hide every other file's matches.
fn scan_project(root_path: &Path, query: &str, case_sensitive: bool) -> Result<Scan, String> {
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

    let mut files: Vec<Box<str>> = Vec::new();
    let mut hits: Vec<Hit> = Vec::new();
    let mut scanned_files: usize = 0;
    let mut file_hits: Vec<Hit> = Vec::new();

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
        file_hits.clear();
        for (index, line) in text.lines().enumerate() {
            let Some(found) = matcher.find(line) else {
                continue;
            };
            file_hits.push(Hit {
                file: 0,
                line: (index + 1) as u32,
                column: (found.start() + 1) as u32,
                text: preview(line).into_boxed_str(),
            });
        }
        if file_hits.is_empty() {
            continue;
        }
        let relative = path.strip_prefix(root_path).unwrap_or(path);
        let relative = relative.to_string_lossy().replace('\\', "/");
        let file_index = files.len() as u32;
        files.push(relative.into_boxed_str());
        for hit in file_hits.drain(..) {
            hits.push(Hit {
                file: file_index,
                ..hit
            });
        }
    }

    Ok(Scan {
        key: String::new(),
        files,
        hits,
        scanned_files,
        scan_ms: started.elapsed().as_millis() as u64,
        created: Instant::now(),
    })
}

fn page_json(scan: &Scan, offset: usize, limit: usize, cached: bool) -> Value {
    let total = scan.hits.len();
    let start = offset.min(total);
    let end = start.saturating_add(limit).min(total);
    let rows: Vec<Value> = scan.hits[start..end]
        .iter()
        .map(|hit| {
            json!({
                "path": scan.files[hit.file as usize].as_ref(),
                "line": hit.line,
                "column": hit.column,
                "text": hit.text.as_ref(),
            })
        })
        .collect();
    let next_offset = if end < total { Some(end) } else { None };
    json!({
        "engine": "ignore",
        "matches": rows,
        "total": total,
        "fileCount": scan.files.len(),
        "offset": start,
        "nextOffset": next_offset,
        "scannedFiles": scan.scanned_files,
        "elapsedMs": scan.scan_ms,
        "cached": cached,
    })
}

/// Searches the text of every file under `root` and returns one page of rows.
///
/// Params: `{ root, query, caseSensitive?, offset?, limit? }`. Literal matching
/// only: the query is regex-escaped so a stray `(` or `*` cannot fail the
/// search. `offset` past the last hit yields an empty page rather than an error,
/// so a paging client that races a shrinking result set still terminates.
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
    let offset = params
        .get("offset")
        .and_then(Value::as_u64)
        .unwrap_or(0) as usize;
    let limit = params
        .get("limit")
        .and_then(Value::as_u64)
        .map(|value| (value as usize).clamp(1, MAX_LIMIT))
        .unwrap_or(DEFAULT_LIMIT);

    let root_path = Path::new(root);
    if !root_path.is_dir() {
        return Err(format!("not a directory: {root}"));
    }

    let key = cache_key(root, query, case_sensitive);
    if let Some(page) = cached_page(&key, offset, limit) {
        return Ok(page);
    }


    let mut scan = scan_project(root_path, query, case_sensitive)?;
    let page = page_json(&scan, offset, limit, false);
    scan.key = key;
    store_scan(scan);
    Ok(page)
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
        assert_eq!(result["total"], 1);
        assert_eq!(result["fileCount"], 1);
        assert!(result["nextOffset"].is_null());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn is_case_insensitive_by_default() {
        let dir = temp_project("case");
        fs::write(dir.join("a.md"), "NEEDLE\n").unwrap();
        let insensitive = search_text(&json!({ "root": dir, "query": "needle" })).unwrap();
        assert_eq!(insensitive["total"], 1);
        let sensitive =
            search_text(&json!({ "root": dir, "query": "needle", "caseSensitive": true })).unwrap();
        assert_eq!(sensitive["total"], 0);
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

    /// A query whose hits exceed one page must page through every row, even
    /// when a single file holds them all — the case a match cap used to cut.
    #[test]
    fn pages_through_every_match_without_truncating() {
        let dir = temp_project("paging");
        let bulk: String = (1..=250).map(|_| "needle in a hot file\n").collect();
        fs::write(dir.join("hot.log"), &bulk).unwrap();
        fs::write(dir.join("quiet.ts"), "needle once\n").unwrap();

        let mut collected: Vec<i64> = Vec::new();
        let mut offset = 0usize;
        loop {
            let result = search_text(
                &json!({ "root": dir, "query": "needle", "offset": offset, "limit": 100 }),
            )
            .unwrap();
            assert_eq!(result["total"], 251);
            assert_eq!(result["fileCount"], 2);
            for row in result["matches"].as_array().unwrap() {
                collected.push(row["line"].as_i64().unwrap());
            }
            match result["nextOffset"].as_u64() {
                Some(next) => offset = next as usize,
                None => break,
            }
        }
        assert_eq!(collected.len(), 251);
        // 250 rows from the bulk file plus the single row from quiet.ts, so the
        // first line of each file is present and nothing was capped away.
        assert_eq!(collected.iter().filter(|line| **line == 1).count(), 2);
        assert_eq!(collected.iter().filter(|line| **line == 250).count(), 1);
        fs::remove_dir_all(&dir).unwrap();
    }

    /// Later pages of the same query are served from the first scan.
    #[test]
    fn serves_later_pages_from_the_cached_scan() {
        let dir = temp_project("cache");
        fs::write(dir.join("many.ts"), "needle\n".repeat(40)).unwrap();
        let first = search_text(&json!({ "root": dir, "query": "needle", "limit": 10 })).unwrap();
        assert_eq!(first["cached"], false);
        assert_eq!(first["nextOffset"], 10);
        let second =
            search_text(&json!({ "root": dir, "query": "needle", "offset": 10, "limit": 10 }))
                .unwrap();
        assert_eq!(second["cached"], true);
        assert_eq!(second["matches"][0]["line"], 11);
        assert_eq!(second["offset"], 10);
        fs::remove_dir_all(&dir).unwrap();
    }
}
