//! Host-owned workspace content index storage.
//!
//! This module deliberately exposes only lifecycle operations (status,
//! rebuild, clear). Grep execution stays untouched: whether and how the index
//! may ever accelerate a search is a separate, independently reviewed change.

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

pub mod fts;

pub const MAX_FILES: usize = 50_000;
pub const MAX_FILE_BYTES: u64 = 1024 * 1024;
pub const MAX_INDEXED_BYTES: u64 = 2 * 1024 * 1024 * 1024;
// v2 stores the whole *visible* file set, not just the ingested subset: the
// `files` table gained `content_indexed`. The index is a rebuildable cache, so
// `open` quarantines a v1 database and re-crawls rather than migrating.
const INDEX_SCHEMA_VERSION: i64 = 2;

#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IndexStatus {
    Fresh,
    Building,
    Stale,
    Failed,
    Partial,
    Disabled,
    SkippedOverLimit,
}

impl IndexStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::Fresh => "fresh",
            Self::Building => "building",
            Self::Stale => "stale",
            Self::Failed => "failed",
            Self::Partial => "partial",
            Self::Disabled => "disabled",
            Self::SkippedOverLimit => "skipped_over_limit",
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct IndexLimits {
    pub max_files: usize,
    pub max_file_bytes: u64,
    pub max_indexed_bytes: u64,
}

impl Default for IndexLimits {
    fn default() -> Self {
        Self {
            max_files: MAX_FILES,
            max_file_bytes: MAX_FILE_BYTES,
            max_indexed_bytes: MAX_INDEXED_BYTES,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RootStatus {
    pub root_id: String,
    pub root_path: String,
    pub status: String,
    pub file_count: i64,
    pub indexed_bytes: i64,
    pub error_count: i64,
    pub last_error: Option<String>,
    pub updated_at: i64,
    /// Only present while `status == "building"`; omitted otherwise so the
    /// non-building response shape is unchanged.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<RootProgress>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RootProgress {
    pub files_done: u64,
    pub files_total: u64,
}

#[derive(Debug, Clone)]
struct IndexedFile {
    rel_path: String,
    size: u64,
    mtime_ms: i64,
    /// `None` when the file is visible but was never ingested (binary
    /// extension, over-size text, unreadable). Such files are still stored so
    /// the persisted set stays equal to the set Grep can reach.
    body: Option<String>,
}

#[derive(Debug, Clone, Default)]
struct ScanResult {
    file_count: i64,
    ingested_count: i64,
    indexed_bytes: u64,
    error_count: i64,
    over_limit: bool,
}

/// Result of [`IndexStore::ensure_index`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EnsureOutcome {
    /// The root already had a fresh index; nothing to do.
    Fresh,
    /// A background rebuild is already in flight.
    InProgress,
    /// The root was marked `building`; the caller must run `rebuild` in the
    /// background to finish it.
    Triggered,
}

#[derive(Debug)]
struct RootUpdate<'a> {
    status: IndexStatus,
    file_count: i64,
    indexed_bytes: i64,
    error_count: i64,
    last_error: Option<&'a str>,
}

#[derive(Debug, Clone)]
pub struct IndexStore {
    path: PathBuf,
    /// Roots with a build running in *this* process, each with its own live
    /// crawl counters. A `building` row in the store without a matching entry
    /// here is crash residue from a previous host process, and may be
    /// re-armed instead of answered InProgress; an entry whose root already
    /// has one means a second build must wait, not interleave.
    building_roots: Arc<Mutex<HashMap<String, Arc<BuildProgress>>>>,
    /// Set when opening the real store failed: every operation then answers
    /// as unavailable instead of blocking host startup. Indexing is an
    /// optimization layer, so losing it must not cost the boot.
    disabled: bool,
}

/// Live crawl counters for a `building` root. `total` starts as an estimate
/// (the previous visible file count) and `done` advances as files are seen.
#[derive(Debug, Default)]
pub struct BuildProgress {
    done: std::sync::atomic::AtomicU64,
    total: std::sync::atomic::AtomicU64,
}

impl BuildProgress {
    pub fn reset(&self, total_estimate: u64) {
        use std::sync::atomic::Ordering;
        self.done.store(0, Ordering::Relaxed);
        self.total.store(total_estimate, Ordering::Relaxed);
    }

    pub fn inc_done(&self) {
        use std::sync::atomic::Ordering;
        self.done.fetch_add(1, Ordering::Relaxed);
    }

    /// `(filesDone, filesTotal)`. The total never reports less than the count
    /// already processed, so a stale estimate cannot show >100%.
    pub fn snapshot(&self) -> (u64, u64) {
        use std::sync::atomic::Ordering;
        let done = self.done.load(Ordering::Relaxed);
        let total = self.total.load(Ordering::Relaxed).max(done);
        (done, total)
    }
}

/// Removes a root from [`IndexStore::building_roots`] when the build call
/// ends, whatever the outcome.
struct BuildingGuard<'a>(&'a Mutex<HashMap<String, Arc<BuildProgress>>>, String);

impl Drop for BuildingGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut roots) = self.0.lock() {
            roots.remove(&self.1);
        }
    }
}

impl IndexStore {
    pub fn open(data_dir: &Path) -> Result<Self> {
        let directory = data_dir.join("index");
        std::fs::create_dir_all(&directory).context("create index directory")?;
        let path = directory.join("index.db");
        let store = Self {
            path,
            building_roots: Arc::new(Mutex::new(HashMap::new())),
            disabled: false,
        };
        if let Err(error) = store.initialize() {
            store.quarantine_corrupt_db();
            store
                .initialize()
                .with_context(|| format!("rebuild index database after failure: {error}"))?;
        }
        Ok(store)
    }

    /// A store that answers every operation as unavailable. Used when opening
    /// the real store failed and the quarantine-and-retry could not recover
    /// it: every RPC reports the store as unavailable and the host keeps
    /// booting.
    pub fn disabled() -> Self {
        Self {
            path: PathBuf::new(),
            building_roots: Arc::new(Mutex::new(HashMap::new())),
            disabled: true,
        }
    }

    pub fn status(&self, root: Option<&Path>) -> Result<Vec<RootStatus>> {
        let connection = self.connection()?;
        let normalized = root.map(normalize_root);
        let root_filter = normalized
            .as_ref()
            .map(|path| path.to_string_lossy().into_owned());
        let mut statement = connection.prepare(
            "SELECT root_id, root_path, status, file_count, indexed_bytes, error_count, last_error, updated_at
             FROM indexed_roots
             WHERE (?1 IS NULL OR root_path = ?1)
             ORDER BY root_path",
        )?;
        let rows = statement.query_map([root_filter], |row| {
            Ok(RootStatus {
                root_id: row.get(0)?,
                root_path: row.get(1)?,
                status: row.get(2)?,
                file_count: row.get(3)?,
                indexed_bytes: row.get(4)?,
                error_count: row.get(5)?,
                last_error: row.get(6)?,
                updated_at: row.get(7)?,
                // Filled in below: the row callback cannot borrow `self`.
                progress: None,
            })
        })?;
        let mut statuses = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        let building = self.building_roots.lock().unwrap().clone();
        for status in &mut statuses {
            if status.status == IndexStatus::Building.as_str() {
                if let Some(progress) = building.get(&status.root_id) {
                    let (files_done, files_total) = progress.snapshot();
                    status.progress = Some(RootProgress {
                        files_done,
                        files_total,
                    });
                }
            }
        }
        Ok(statuses)
    }

    pub fn rebuild(&self, root: &Path, limits: IndexLimits) -> Result<RootStatus> {
        let root = normalize_root(root);
        if !root.is_dir() {
            anyhow::bail!("workspace root does not exist: {}", root.display());
        }
        let root_id = root_id(&root);
        // Register the build (with its own progress counters) before the row
        // flips, and hold the registration for the whole call — the guard
        // also covers early returns — so a `building` row that outlives the
        // process is recognizable as crash residue, not a running build.
        // A root already registered by an earlier call in this process keeps
        // that registration and its progress. A genuinely concurrent second
        // rebuild sees the root already registered *and its guard held* only
        // via ensure_index's InProgress answer; direct double-entry adopts
        // the existing counters rather than interleaving a second crawl's
        // totals into the card.
        let progress = {
            let mut roots = self.building_roots.lock().unwrap();
            match roots.get(&root_id) {
                Some(existing) => existing.clone(),
                None => {
                    let progress = Arc::new(BuildProgress::default());
                    roots.insert(root_id.clone(), progress.clone());
                    progress
                }
            }
        };
        let _guard = BuildingGuard(&self.building_roots, root_id.clone());
        // Seed the progress denominator from the previous visible set (or 0 on
        // a first build). The crawler advances `done` as it visits files.
        let previous_files: i64 = self
            .connection()?
            .query_row(
                "SELECT COUNT(*) FROM files WHERE root_id = ?1",
                [&root_id],
                |row| row.get(0),
            )
            .unwrap_or(0);
        progress.reset(previous_files.max(0) as u64);
        self.set_root_status(
            &root_id,
            &root,
            RootUpdate {
                status: IndexStatus::Building,
                file_count: 0,
                indexed_bytes: 0,
                error_count: 0,
                last_error: None,
            },
        )?;

        let connection = self.connection()?;
        // Files stream from the crawler into one open transaction — bodies
        // never accumulate in memory, so a 2GB budget costs SQLite page
        // cache, not heap.
        let mut writer = RootWriter::begin(&connection, &root_id)?;
        let scan = scan_root(&root, limits, Some(&progress), |file| {
            writer.write(&root_id, &file)
        });
        match scan {
            Ok(result) => {
                writer.commit()?;
                let status = if result.over_limit {
                    IndexStatus::SkippedOverLimit
                } else if result.error_count > 0 {
                    IndexStatus::Partial
                } else {
                    IndexStatus::Fresh
                };
                let message = if result.over_limit {
                    Some("index budget exceeded; fast-path use is disabled".to_string())
                } else if result.error_count > 0 {
                    Some(format!(
                        "{} file(s) could not be indexed",
                        result.error_count
                    ))
                } else {
                    None
                };
                upsert_root(
                    &connection,
                    &root_id,
                    &root,
                    RootUpdate {
                        status,
                        // The health card's "files indexed" figure stays about
                        // ingested content. The visible-but-unindexed rows
                        // exist for search completeness, not for display.
                        file_count: result.ingested_count,
                        indexed_bytes: result.indexed_bytes as i64,
                        error_count: result.error_count,
                        last_error: message.as_deref(),
                    },
                )?;
            }
            Err(error) => {
                upsert_root(
                    &connection,
                    &root_id,
                    &root,
                    RootUpdate {
                        status: IndexStatus::Failed,
                        file_count: 0,
                        indexed_bytes: 0,
                        error_count: 1,
                        last_error: Some(&error.to_string()),
                    },
                )?;
            }
        }
        self.status(Some(&root))?
            .into_iter()
            .next()
            .context("index status missing after rebuild")
    }

    /// Mark an unindexed/stale workspace as `building` without scanning, so a
    /// caller can run [`IndexStore::rebuild`] off the hot path. Idempotent:
    /// a fresh root stays fresh and a building root is not re-marked.
    pub fn ensure_index(&self, root: &Path) -> Result<EnsureOutcome> {
        let root = normalize_root(root);
        if !root.is_dir() {
            anyhow::bail!("workspace root does not exist: {}", root.display());
        }
        let root_id = root_id(&root);
        let building_in_process = self.building_roots.lock().unwrap().contains_key(&root_id);
        match self.status(Some(&root))?.into_iter().next() {
            Some(status) if status.status == IndexStatus::Fresh.as_str() => {
                Ok(EnsureOutcome::Fresh)
            }
            // A live build answers InProgress. A `building` row with no
            // in-process build behind it is crash residue — the previous host
            // process died mid-build — so it falls through and re-arms
            // instead of answering InProgress forever.
            Some(status)
                if status.status == IndexStatus::Building.as_str() && building_in_process =>
            {
                Ok(EnsureOutcome::InProgress)
            }
            _ => {
                // Register before the row flips, so the health card sees a
                // progress block as soon as the root reports `building`. The
                // total is seeded from the previous visible set — the same
                // figure the spawned rebuild will use — so the card never
                // shows 0/0. The spawned rebuild adopts this registration
                // instead of creating a second one; a concurrent caller sees
                // the in-process entry and answers InProgress.
                let previous_files: i64 = self
                    .connection()?
                    .query_row(
                        "SELECT COUNT(*) FROM files WHERE root_id = ?1",
                        [&root_id],
                        |row| row.get(0),
                    )
                    .unwrap_or(0);
                let progress = Arc::new(BuildProgress::default());
                progress.reset(previous_files.max(0) as u64);
                self.building_roots
                    .lock()
                    .unwrap()
                    .entry(root_id.clone())
                    .or_insert(progress);
                self.set_root_status(
                    &root_id,
                    &root,
                    RootUpdate {
                        status: IndexStatus::Building,
                        file_count: 0,
                        indexed_bytes: 0,
                        error_count: 0,
                        last_error: None,
                    },
                )?;
                Ok(EnsureOutcome::Triggered)
            }
        }
    }

    pub fn clear(&self, root: Option<&Path>) -> Result<usize> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        let count = if let Some(root) = root {
            let normalized = normalize_root(root);
            let root_id = transaction
                .query_row(
                    "SELECT root_id FROM indexed_roots WHERE root_path = ?1",
                    [normalized.to_string_lossy().into_owned()],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;
            let Some(root_id) = root_id else {
                return Ok(0);
            };
            transaction.execute(
                "DELETE FROM file_content_fts WHERE root_id = ?1",
                [&root_id],
            )?;
            transaction.execute("DELETE FROM indexed_roots WHERE root_id = ?1", [&root_id])?
        } else {
            transaction.execute("DELETE FROM file_content_fts", [])?;
            transaction.execute("DELETE FROM indexed_roots", [])?
        };
        transaction.commit()?;
        Ok(count)
    }

    /// Test-only: the relative paths currently stored for `root`. With schema
    /// v2 this is the whole *visible* set (ingested or not), which is exactly
    /// what the Grep-vs-index diff test needs to compare.
    #[cfg(test)]
    pub fn indexed_rel_paths(&self, root: &Path) -> Result<Vec<String>> {
        let normalized = normalize_root(root).to_string_lossy().into_owned();
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT f.rel_path FROM files AS f
             JOIN indexed_roots AS r ON r.root_id = f.root_id
             WHERE r.root_path = ?1
             ORDER BY f.rel_path",
        )?;
        let rows = statement.query_map([normalized], |row| row.get::<_, String>(0))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    fn connection(&self) -> Result<Connection> {
        if self.disabled {
            anyhow::bail!("index store is unavailable");
        }
        fts::open(&self.path)
    }

    fn initialize(&self) -> Result<()> {
        let connection = self.connection()?;
        let version: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if version != 0 && version != INDEX_SCHEMA_VERSION {
            anyhow::bail!("unsupported index schema version {version}");
        }
        if version == 0 {
            connection.execute_batch(fts::SCHEMA)?;
            connection.pragma_update(None, "user_version", INDEX_SCHEMA_VERSION)?;
        }
        let integrity: String =
            connection.query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
        if integrity != "ok" {
            anyhow::bail!("index database integrity check failed: {integrity}");
        }
        Ok(())
    }

    fn quarantine_corrupt_db(&self) {
        if !self.path.exists() {
            return;
        }
        let stamp = now_ms();
        let quarantined = self.path.with_extension(format!("db.corrupt-{stamp}"));
        let _ = std::fs::rename(&self.path, quarantined);
        let _ = std::fs::remove_file(self.path.with_extension("db-wal"));
        let _ = std::fs::remove_file(self.path.with_extension("db-shm"));
    }

    fn set_root_status(&self, root_id: &str, root: &Path, update: RootUpdate<'_>) -> Result<()> {
        let connection = self.connection()?;
        upsert_root(&connection, root_id, root, update)
    }
}

fn scan_root(
    root: &Path,
    limits: IndexLimits,
    progress: Option<&BuildProgress>,
    mut sink: impl FnMut(IndexedFile) -> Result<()>,
) -> Result<ScanResult> {
    let mut result = ScanResult::default();
    // The crawler and Grep share one visible-set definition; see
    // `crate::tools::ignore_rules`. The crawler always covers the whole root,
    // so it uses the unscoped walk.
    for entry in crate::tools::ignore_rules::visible_walker(root, false).build() {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => {
                result.error_count += 1;
                continue;
            }
        };
        if !entry
            .file_type()
            .is_some_and(|file_type| file_type.is_file())
            || crate::tools::ignore_rules::is_vendor_path(root, entry.path())
        {
            continue;
        }
        if result.file_count >= limits.max_files as i64 {
            result.over_limit = true;
            break;
        }
        // One visible file counts as progress, whether or not it is ingested.
        if let Some(progress) = progress {
            progress.inc_done();
        }
        let metadata = match entry.metadata() {
            Ok(metadata) => metadata,
            Err(_) => {
                result.error_count += 1;
                continue;
            }
        };
        let size = metadata.len();
        // The content filters below decide whether a *visible* file is worth
        // ingesting — not whether it exists. A filtered file still gets a row
        // (with `content_indexed = 0`) so the stored set keeps matching the set
        // Grep can reach; the fast path then re-scans it instead of losing it.
        let body = if size <= limits.max_file_bytes && !fts::is_binary_extension(entry.path()) {
            match std::fs::read_to_string(entry.path()) {
                Ok(body) => Some(body),
                Err(_) => {
                    result.error_count += 1;
                    None
                }
            }
        } else {
            None
        };
        if body.is_some() {
            if result.indexed_bytes.saturating_add(size) > limits.max_indexed_bytes {
                result.over_limit = true;
                break;
            }
            result.indexed_bytes = result.indexed_bytes.saturating_add(size);
            result.ingested_count += 1;
        }
        let rel_path = entry
            .path()
            .strip_prefix(root)
            .map(normalize_rel_path)
            .unwrap_or_else(|_| normalize_rel_path(entry.path()));
        result.file_count += 1;
        sink(IndexedFile {
            rel_path,
            size,
            mtime_ms: metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis() as i64)
                .unwrap_or(0),
            body,
        })?;
    }
    Ok(result)
}

/// A per-file writer into an open rebuild transaction. Files stream straight
/// from the crawler into SQLite — nothing accumulates the bodies in memory.
/// A per-file writer over one open rebuild transaction. Files stream
/// straight from the crawler into SQLite — nothing accumulates the bodies in
/// memory. The two INSERT statements are prepared from the connection before
/// the transaction opens (SQLite transactions are connection-scoped, so
/// stepping them inside is equivalent and keeps the writer free of
/// self-referential borrows).
struct RootWriter<'conn> {
    insert_file: rusqlite::Statement<'conn>,
    insert_fts: rusqlite::Statement<'conn>,
    transaction: rusqlite::Transaction<'conn>,
}

impl<'conn> RootWriter<'conn> {
    fn begin(connection: &'conn Connection, root_id: &str) -> Result<Self> {
        let insert_file = connection.prepare(
            "INSERT INTO files (root_id, rel_path, size, mtime_ms, content_indexed) VALUES (?1, ?2, ?3, ?4, ?5)",
        )?;
        let insert_fts = connection.prepare(
            "INSERT INTO file_content_fts (root_id, rel_path, body) VALUES (?1, ?2, ?3)",
        )?;
        let transaction = connection.unchecked_transaction()?;
        // Old rows go first: the FTS hit set must never outlive the files
        // rows it points into.
        transaction.execute("DELETE FROM file_content_fts WHERE root_id = ?1", [root_id])?;
        transaction.execute("DELETE FROM files WHERE root_id = ?1", [root_id])?;
        Ok(Self {
            insert_file,
            insert_fts,
            transaction,
        })
    }

    fn write(&mut self, root_id: &str, file: &IndexedFile) -> Result<()> {
        self.insert_file.execute(params![
            root_id,
            file.rel_path,
            file.size as i64,
            file.mtime_ms,
            if file.body.is_some() { 1_i64 } else { 0_i64 }
        ])?;
        // Only ingested files reach the full-text table, so an FTS hit always
        // implies a readable body behind it.
        if let Some(body) = &file.body {
            self.insert_fts
                .execute(params![root_id, file.rel_path, body])?;
        }
        Ok(())
    }

    fn commit(self) -> Result<()> {
        self.transaction.commit()?;
        Ok(())
    }
}

fn upsert_root(
    connection: &Connection,
    root_id: &str,
    root: &Path,
    update: RootUpdate<'_>,
) -> Result<()> {
    connection.execute(
        "INSERT INTO indexed_roots (root_id, root_path, status, file_count, indexed_bytes, error_count, last_error, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(root_id) DO UPDATE SET root_path=excluded.root_path, status=excluded.status,
         file_count=excluded.file_count, indexed_bytes=excluded.indexed_bytes, error_count=excluded.error_count,
         last_error=excluded.last_error, updated_at=excluded.updated_at",
        params![
            root_id,
            normalize_root(root).to_string_lossy().into_owned(),
            update.status.as_str(),
            update.file_count,
            update.indexed_bytes,
            update.error_count,
            update.last_error,
            now_ms()
        ],
    )?;
    Ok(())
}

pub fn normalize_root(path: &Path) -> PathBuf {
    let mut text = path.to_string_lossy().replace('\\', "/");
    if let Some(rest) = text.strip_prefix("//?/") {
        text = rest.to_string();
    }
    let candidate = PathBuf::from(text);
    candidate.canonicalize().unwrap_or(candidate)
}

pub fn normalize_rel_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

pub fn root_id(root: &Path) -> String {
    let mut hash = Sha256::new();
    hash.update(normalize_root(root).to_string_lossy().as_bytes());
    hex::encode(hash.finalize())
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn normalizes_root_and_relative_paths() {
        let directory = tempfile::tempdir().unwrap();
        let root = normalize_root(&PathBuf::from(format!("{}/", directory.path().display())));
        assert_eq!(root, directory.path().canonicalize().unwrap());
        assert_eq!(normalize_rel_path(Path::new("src\\lib.rs")), "src/lib.rs");
        assert_eq!(root_id(&root), root_id(&root));
    }

    #[test]
    fn empty_store_is_safe() {
        let data = tempfile::tempdir().unwrap();
        let store = IndexStore::open(data.path()).unwrap();
        assert!(store.status(None).unwrap().is_empty());
        assert_eq!(store.clear(None).unwrap(), 0);
    }

    #[test]
    fn building_residue_from_a_dead_process_is_rearmed() {
        let data = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("one.txt"), "one\n").unwrap();
        let store = IndexStore::open(data.path()).unwrap();
        // Simulate crash residue: a `building` row with no in-process build
        // behind it (as if the previous host process died mid-build).
        store
            .set_root_status(
                &root_id(&normalize_root(root.path())),
                &normalize_root(root.path()),
                RootUpdate {
                    status: IndexStatus::Building,
                    file_count: 0,
                    indexed_bytes: 0,
                    error_count: 0,
                    last_error: None,
                },
            )
            .unwrap();
        assert!(matches!(
            store.ensure_index(root.path()).unwrap(),
            EnsureOutcome::Triggered,
        ));

        // The same row while a build IS running in this process must still
        // answer InProgress.
        let rebuilding = IndexStore::open(data.path()).unwrap();
        rebuilding
            .set_root_status(
                &root_id(&normalize_root(root.path())),
                &normalize_root(root.path()),
                RootUpdate {
                    status: IndexStatus::Building,
                    file_count: 0,
                    indexed_bytes: 0,
                    error_count: 0,
                    last_error: None,
                },
            )
            .unwrap();
        rebuilding.building_roots.lock().unwrap().insert(
            root_id(&normalize_root(root.path())),
            Arc::new(BuildProgress::default()),
        );
        assert!(matches!(
            rebuilding.ensure_index(root.path()).unwrap(),
            EnsureOutcome::InProgress,
        ));
    }

    #[test]
    fn disabled_store_answers_every_read_as_unavailable() {
        let store = IndexStore::disabled();
        assert!(store.status(None).is_err());
        assert!(store.ensure_index(Path::new("/nonexistent")).is_err());
    }

    #[test]
    fn rebuild_indexes_text_and_ignores_binary_and_vendor_dirs() {
        let data = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("node_modules/pkg")).unwrap();
        fs::create_dir_all(root.path().join(".git")).unwrap();
        fs::write(root.path().join(".pi-desktopignore"), "private.txt\n").unwrap();
        fs::write(root.path().join("README.md"), "hello index\n").unwrap();
        fs::write(root.path().join("notes.md"), "indexed too\n").unwrap();
        fs::write(root.path().join("private.txt"), "private\n").unwrap();
        fs::write(root.path().join("node_modules/pkg/ignored.js"), "ignored\n").unwrap();
        fs::write(root.path().join("image.png"), [0_u8, 1, 2, 3]).unwrap();
        let store = IndexStore::open(data.path()).unwrap();
        let status = store.rebuild(root.path(), IndexLimits::default()).unwrap();
        assert_eq!(status.status, "fresh");
        assert_eq!(status.file_count, 2);
        assert!(status.indexed_bytes > 0);
        // The binary file is visible but not ingested. Both halves matter: it
        // must be recorded (so the fast path still searches it) yet must not
        // count as indexed content.
        assert_eq!(
            store.indexed_rel_paths(root.path()).unwrap(),
            vec![
                "README.md".to_string(),
                "image.png".to_string(),
                "notes.md".to_string()
            ]
        );
    }

    #[test]
    fn budget_marks_root_skipped_without_serving_partial_index() {
        let data = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("one.txt"), "one\n").unwrap();
        fs::write(root.path().join("two.txt"), "two\n").unwrap();
        let store = IndexStore::open(data.path()).unwrap();
        let status = store
            .rebuild(
                root.path(),
                IndexLimits {
                    max_files: 1,
                    ..IndexLimits::default()
                },
            )
            .unwrap();
        assert_eq!(status.status, "skipped_over_limit");
    }

    #[test]
    fn corrupt_store_is_quarantined_and_recreated() {
        let data = tempfile::tempdir().unwrap();
        let path = data.path().join("index/index.db");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"not sqlite").unwrap();
        let store = IndexStore::open(data.path()).unwrap();
        assert!(store.status(None).unwrap().is_empty());
        assert!(fs::read_dir(path.parent().unwrap()).unwrap().count() >= 2);
    }

    #[test]
    fn multiple_roots_are_namespaced_and_clear_is_scoped() {
        let data = tempfile::tempdir().unwrap();
        let root_a = tempfile::tempdir().unwrap();
        let root_b = tempfile::tempdir().unwrap();
        fs::write(root_a.path().join("a.txt"), "alpha\n").unwrap();
        fs::write(root_b.path().join("b.txt"), "bravo\n").unwrap();
        let store = IndexStore::open(data.path()).unwrap();
        store
            .rebuild(root_a.path(), IndexLimits::default())
            .unwrap();
        store
            .rebuild(root_b.path(), IndexLimits::default())
            .unwrap();
        assert_eq!(store.status(None).unwrap().len(), 2);
        assert_eq!(store.clear(Some(root_a.path())).unwrap(), 1);
        let remaining = store.status(None).unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(
            remaining[0].root_path,
            normalize_root(root_b.path()).to_string_lossy()
        );

        // The FTS side of the cleared root must go too: the virtual table has
        // no foreign keys, so clear deletes its rows explicitly. A leftover
        // row would silently keep workspace content readable after "clear".
        let connection = fts::open(&store.path).unwrap();
        let orphaned: i64 = connection
            .query_row("SELECT COUNT(*) FROM file_content_fts", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(orphaned, 1);
        let files_left: i64 = connection
            .query_row("SELECT COUNT(*) FROM files", [], |row| row.get(0))
            .unwrap();
        assert_eq!(files_left, 1);
    }

    #[test]
    fn status_reports_progress_only_while_building() {
        let data = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("a.txt"), "alpha\n").unwrap();
        let store = IndexStore::open(data.path()).unwrap();

        // An unindexed root marked building (as the auto-index path does)
        // surfaces the progress block; a never-built root seeds the total at 0.
        assert_eq!(
            store.ensure_index(root.path()).unwrap(),
            crate::index::EnsureOutcome::Triggered
        );
        let building = store
            .status(Some(root.path()))
            .unwrap()
            .into_iter()
            .next()
            .unwrap();
        assert_eq!(building.status, "building");
        let progress = building.progress.expect("building exposes progress");
        assert_eq!(progress.files_done, 0);

        // A fresh root carries no progress field.
        let fresh = store.rebuild(root.path(), IndexLimits::default()).unwrap();
        assert_eq!(fresh.status, "fresh");
        assert!(fresh.progress.is_none());

        // Marking the freshly built root stale makes the next ensure_index mark
        // it building again; the progress denominator is seeded from the
        // previous visible set (1 file).
        fts::open(&store.path)
            .unwrap()
            .execute("UPDATE indexed_roots SET status = 'stale'", [])
            .unwrap();
        assert_eq!(
            store.ensure_index(root.path()).unwrap(),
            crate::index::EnsureOutcome::Triggered
        );
        let rebuilding = store
            .status(Some(root.path()))
            .unwrap()
            .into_iter()
            .next()
            .unwrap();
        let progress = rebuilding.progress.expect("building exposes progress");
        assert_eq!(progress.files_total, 1);
    }

    #[test]
    fn progress_never_reports_total_below_done() {
        let progress = BuildProgress::default();
        progress.reset(1);
        progress.inc_done();
        progress.inc_done();
        progress.inc_done();
        assert_eq!(progress.snapshot(), (3, 3));
    }
}
