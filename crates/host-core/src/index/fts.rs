//! SQLite storage for the workspace content index: the schema, the
//! connection opener, and the pragmas every writer relies on.

use anyhow::{Context, Result};
use rusqlite::Connection;
use std::path::Path;

/// Binary/archival extensions the index never ingests. This is a *content*
/// filter, not a visibility rule: such files stay visible to Grep and are
/// simply not worth indexing. Vendor/ignore visibility lives in
/// `crate::tools::ignore_rules`.
pub(crate) fn is_binary_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "7z" | "a"
                    | "bmp"
                    | "class"
                    | "dll"
                    | "dmg"
                    | "exe"
                    | "gif"
                    | "ico"
                    | "jar"
                    | "jpeg"
                    | "jpg"
                    | "mov"
                    | "mp3"
                    | "mp4"
                    | "o"
                    | "obj"
                    | "pdf"
                    | "png"
                    | "so"
                    | "tar"
                    | "wasm"
                    | "webp"
                    | "woff"
                    | "woff2"
                    | "zip"
            )
        })
}

pub const SCHEMA: &str = r#"
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS indexed_roots (
        root_id TEXT PRIMARY KEY,
        root_path TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK (status IN ('fresh','building','stale','failed','partial','disabled','skipped_over_limit')),
        file_count INTEGER NOT NULL DEFAULT 0,
        indexed_bytes INTEGER NOT NULL DEFAULT 0,
        error_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        updated_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS files (
        root_id TEXT NOT NULL REFERENCES indexed_roots(root_id) ON DELETE CASCADE,
        rel_path TEXT NOT NULL,
        size INTEGER NOT NULL,
        mtime_ms INTEGER NOT NULL,
        content_indexed INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (root_id, rel_path)
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS file_content_fts USING fts5(
        root_id UNINDEXED,
        rel_path UNINDEXED,
        body,
        tokenize = 'trigram'
    );
"#;

pub fn open(path: &Path) -> Result<Connection> {
    let connection = Connection::open(path).context("open index database")?;
    connection.busy_timeout(std::time::Duration::from_secs(5))?;
    connection.execute_batch("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;")?;
    Ok(connection)
}
