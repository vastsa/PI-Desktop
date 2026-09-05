use anyhow::{anyhow, Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};

/// Storage schema v13: SQLite holds
/// index data only; transcript content lives in per-session JSONL files
/// (D119, `transcripts.rs`). v11 adds the Plan/Goal approval kind (D198).
/// v12 added A2A broker tables (ADR 0147); v13 drops them (ADR 0165).
pub const SCHEMA_VERSION: i64 = 13;

/// Absolute approval deadline for a newly submitted Plan or Goal proposal.
pub const PLAN_APPROVAL_TIMEOUT_MS: i64 = 30 * 60 * 1000;

/// Audit rows older than this are pruned at boot.
const AUDIT_RETENTION_MS: i64 = 90 * 24 * 3600 * 1000;
/// task_runs kept per task after the boot prune.
const TASK_RUNS_KEEP: i64 = 100;
/// Durable notification rows kept globally.
pub const NOTIFICATION_KEEP: i64 = 200;

const OBSOLETE_PLAN_APPROVAL_PERMISSION_MODE: &str = "planApprovalPermissionMode";

fn strip_obsolete_plan_approval_permission_mode(value: &mut Value) -> bool {
    value
        .as_object_mut()
        .and_then(|object| object.remove(OBSOLETE_PLAN_APPROVAL_PERMISSION_MODE))
        .is_some()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRecord {
    pub id: i64,
    pub path: String,
    pub name: String,
    pub pinned: bool,
    pub created_at: i64,
    pub last_opened_at: i64,
}

fn normalize_project_path(path: &str) -> Option<String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return None;
    }
    let mut normalized = trimmed.replace('\\', "/");
    // Strip the forward-slash form of the Windows extended-length prefix
    // (`//?/C:/...` → `C:/...`) which older versions stored in the DB.
    if normalized.starts_with("//?/")
        && normalized.len() >= 7
        && normalized.as_bytes()[5] == b':'
        && normalized.as_bytes()[6] == b'/'
    {
        normalized = normalized[4..].to_string();
    }
    while normalized.len() > 1
        && normalized.ends_with('/')
        && !normalized
            .strip_suffix('/')
            .is_some_and(|prefix| prefix.ends_with(':'))
    {
        normalized.pop();
    }
    Some(normalized)
}

/// Canonical storage spelling of a project path: resolve symlinks when the
/// directory exists (matching `WorkspaceState::set`), then normalize
/// separators/trailing slashes.
fn canonical_project_path(path: &str) -> Option<String> {
    let canonical = std::path::Path::new(path)
        .canonicalize()
        .ok()
        .map(|p| {
            let s = p.to_string_lossy().to_string();
            // Strip Windows extended-length prefix `\\?\X:\...` → `X:\...`
            #[cfg(windows)]
            {
                if let Some(rest) = s.strip_prefix(r"\\?\") {
                    if rest.len() >= 3
                        && rest.as_bytes()[1] == b':'
                        && rest.as_bytes()[2] == b'\\'
                    {
                        return rest.to_string();
                    }
                }
            }
            s
        });
    normalize_project_path(canonical.as_deref().unwrap_or(path))
}

fn project_display_name(path: &str) -> String {
    std::path::Path::new(path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("workspace")
        .to_string()
}

/// Upsert a projects row by raw path on any connection (used by live code and
/// the v1 migration alike). Returns None for blank paths.
fn upsert_project_row(conn: &Connection, raw: &str, touch: bool) -> Result<Option<i64>> {
    let Some(path) = canonical_project_path(raw) else {
        return Ok(None);
    };
    let name = project_display_name(&path);
    let now = now_ms();
    let mut stmt = conn.prepare_cached(
        "INSERT INTO projects (path, name, created_at, last_opened_at)
         VALUES (?1, ?2, ?3, ?3)
         ON CONFLICT(path) DO UPDATE SET
           last_opened_at = CASE WHEN ?4 THEN excluded.last_opened_at
                                 ELSE projects.last_opened_at END
         RETURNING id",
    )?;
    let id: i64 = stmt.query_row(params![path, name, now, touch], |r| r.get(0))?;
    Ok(Some(id))
}

const SCHEMA_LATEST: &str = r#"
CREATE TABLE kv (
  ns         TEXT NOT NULL,
  key        TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (ns, key)
) WITHOUT ROWID;

CREATE TABLE projects (
  id             INTEGER PRIMARY KEY,
  path           TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  pinned         INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  last_opened_at INTEGER NOT NULL
);

CREATE TABLE providers (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  vendor_key       TEXT NOT NULL DEFAULT 'custom',
  type             TEXT NOT NULL DEFAULT 'openai_compatible',
  protocol         TEXT NOT NULL DEFAULT 'openai_compatible',
  api_style        TEXT,
  auth_kind        TEXT NOT NULL DEFAULT 'api_key_and_base_url',
  base_url         TEXT,
  enabled          INTEGER NOT NULL DEFAULT 1,
  secret_ref       TEXT,
  default_model_id TEXT,
  config_json      TEXT NOT NULL DEFAULT '{}',
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE TABLE models (
  provider_id       TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  model_id          TEXT NOT NULL,
  display_name      TEXT NOT NULL,
  source            TEXT NOT NULL DEFAULT 'user',
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  context_window    INTEGER,
  max_output_tokens INTEGER,
  deprecated        INTEGER NOT NULL DEFAULT 0,
  updated_at        INTEGER NOT NULL,
  PRIMARY KEY (provider_id, model_id)
) WITHOUT ROWID;

CREATE TABLE sessions (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL DEFAULT '',
  project_id  INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  provider_id TEXT,
  model_id    TEXT,
  mode        TEXT NOT NULL DEFAULT 'agent',
  thinking_level TEXT NOT NULL DEFAULT 'off'
                CHECK (thinking_level IN ('off', 'minimal', 'low', 'medium',
                                          'high', 'xhigh', 'max')),
  permission_mode TEXT NOT NULL DEFAULT 'inherit'
                CHECK (permission_mode IN ('inherit', 'ask', 'accept-edits', 'auto')),
  source      TEXT,
  pinned      INTEGER NOT NULL DEFAULT 0,
  last_seq    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_sessions_updated ON sessions(updated_at DESC);
CREATE INDEX idx_sessions_project ON sessions(project_id) WHERE project_id IS NOT NULL;

CREATE TABLE turns (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'running',
  provider_id   TEXT,
  model_id      TEXT,
  error_code    TEXT,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  usage_json    TEXT,
  started_at    INTEGER NOT NULL,
  ended_at      INTEGER
);
CREATE INDEX idx_turns_session ON turns(session_id, started_at DESC);
CREATE UNIQUE INDEX idx_turns_one_running_session
  ON turns(session_id) WHERE status = 'running';

CREATE TABLE notifications (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('task.completed', 'task.failed')),
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  session_title TEXT NOT NULL,
  turn_id    TEXT NOT NULL UNIQUE,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  read_at    INTEGER
);
CREATE INDEX idx_notifications_created ON notifications(created_at DESC);
CREATE INDEX idx_notifications_unread
  ON notifications(created_at DESC) WHERE read_at IS NULL;

CREATE TABLE messages (
  mid          INTEGER PRIMARY KEY,
  id           TEXT NOT NULL UNIQUE,
  session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_id      TEXT REFERENCES turns(id) ON DELETE SET NULL,
  seq          INTEGER NOT NULL,
  role         TEXT NOT NULL,
  tool_name    TEXT,
  is_error     INTEGER NOT NULL DEFAULT 0,
  text         TEXT,
  created_at   INTEGER NOT NULL,
  UNIQUE (session_id, seq)
);

CREATE VIRTUAL TABLE messages_fts USING fts5(
  text,
  content='messages', content_rowid='mid',
  tokenize='trigram'
);
CREATE TRIGGER messages_ai AFTER INSERT ON messages WHEN new.text IS NOT NULL
  BEGIN INSERT INTO messages_fts(rowid, text) VALUES (new.mid, new.text); END;
CREATE TRIGGER messages_ad AFTER DELETE ON messages WHEN old.text IS NOT NULL
  BEGIN INSERT INTO messages_fts(messages_fts, rowid, text)
        VALUES ('delete', old.mid, old.text); END;
CREATE TRIGGER messages_au AFTER UPDATE OF text ON messages
  BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, text)
      SELECT 'delete', old.mid, old.text WHERE old.text IS NOT NULL;
    INSERT INTO messages_fts(rowid, text)
      SELECT new.mid, new.text WHERE new.text IS NOT NULL;
  END;

CREATE TABLE artifacts (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  path       TEXT NOT NULL,
  op         TEXT NOT NULL,
  turn_id    TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, path)
) WITHOUT ROWID;
CREATE INDEX idx_artifacts_time ON artifacts(updated_at DESC);

CREATE TABLE message_revisions (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  root_user_id    TEXT NOT NULL,
  revision_index  INTEGER NOT NULL,
  is_active       INTEGER NOT NULL DEFAULT 0,
  message_count   INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  UNIQUE (session_id, root_user_id, revision_index)
);
CREATE INDEX idx_message_revisions_root
  ON message_revisions(session_id, root_user_id, revision_index);

CREATE TABLE scheduled_tasks (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  prompt      TEXT NOT NULL,
  cadence     TEXT NOT NULL DEFAULT 'manual',
  enabled     INTEGER NOT NULL DEFAULT 1,
  project_id  INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  last_run_at INTEGER,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE task_runs (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  status     TEXT NOT NULL DEFAULT 'running',
  error_code TEXT,
  started_at INTEGER NOT NULL,
  ended_at   INTEGER
);
CREATE INDEX idx_task_runs ON task_runs(task_id, started_at DESC);

CREATE TABLE secrets_meta (
  secret_ref TEXT PRIMARY KEY,
  owner_kind TEXT NOT NULL DEFAULT 'provider',
  owner_id   TEXT,
  kind       TEXT NOT NULL DEFAULT 'api_key',
  backend    TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE audit_log (
  id           INTEGER PRIMARY KEY,
  ts           INTEGER NOT NULL,
  kind         TEXT NOT NULL,
  session_id   TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_audit_ts ON audit_log(ts);
CREATE INDEX idx_audit_session ON audit_log(session_id, ts) WHERE session_id IS NOT NULL;

"#;

/// Approval storage is kept in one batch so fresh databases and migrations
/// cannot drift in table names, checks, or indexes.
const PLAN_APPROVALS_SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS plan_approvals (
  request_id             TEXT PRIMARY KEY,
  session_id            TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_id               TEXT NOT NULL,
  tool_call_id          TEXT NOT NULL UNIQUE,
  kind                  TEXT NOT NULL DEFAULT 'plan' CHECK (kind IN ('plan', 'goal')),
  plan_json             TEXT NOT NULL,
  title                 TEXT NOT NULL DEFAULT '',
  question              TEXT NOT NULL DEFAULT '',
  status                TEXT NOT NULL CHECK (status IN (
    'pending', 'approved', 'changes_requested', 'rejected',
    'expired', 'interrupted'
  )),
  action                TEXT CHECK (action IN ('approve', 'request_changes', 'reject')),
  target_permission_mode TEXT CHECK (target_permission_mode IN ('ask', 'accept-edits', 'auto')),
  feedback              TEXT,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  expires_at            INTEGER,
  resolved_at           INTEGER,
  error_code            TEXT,
  artifact_relative_path TEXT,
  artifact_sha256       TEXT,
  artifact_size_bytes   INTEGER,
  version               INTEGER NOT NULL DEFAULT 1,
  execution_id          TEXT UNIQUE,
  execution_state       TEXT CHECK (execution_state IN (
    'queued', 'running', 'completed', 'interrupted'
  ))
);
CREATE INDEX IF NOT EXISTS idx_plan_approvals_session
  ON plan_approvals(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_plan_approvals_pending
  ON plan_approvals(status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_approvals_one_pending_session
  ON plan_approvals(session_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_plan_approvals_execution_queue
  ON plan_approvals(execution_state, created_at DESC)
  WHERE execution_state IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS idx_plan_approvals_execution_id
  ON plan_approvals(execution_id) WHERE execution_id IS NOT NULL;
"#;

pub struct Database {
    conn: Connection,
    /// App data directory (the sqlite file's parent); transcript files live
    /// under `<data_dir>/sessions/` (D119).
    data_dir: std::path::PathBuf,
}

struct PlanWorkRow {
    proposal_id: String,
    session_id: String,
    turn_id: String,
    tool_call_id: String,
    execution_id: Option<String>,
    status: String,
    execution_state: Option<String>,
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// Parse an RFC3339 timestamp into epoch ms, falling back to `now`.
pub fn ts_to_ms(value: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|dt| dt.timestamp_millis())
        .unwrap_or_else(|_| now_ms())
}

/// Epoch ms → RFC3339 (UTC, `Z` suffix) for the wire format.
pub fn ms_to_ts(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .unwrap_or_else(chrono::Utc::now)
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

impl Database {
    /// Open (creating as needed) the app database inside `data_dir`.
    pub fn open_in_dir(data_dir: &Path) -> Result<Self> {
        Self::open(&data_dir.join("pi.sqlite"))
    }

    /// Open a specific database file, bootstrapping the latest schema on a
    /// fresh file. A pre-v7 file is archived and replaced by a fresh one
    /// (D119 breaking reset — content moved to transcript files, no data
    /// migration); files with an unknown newer schema fail.
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
            std::fs::create_dir_all(parent)?;
        }
        let data_dir = match path.parent() {
            Some(p) if !p.as_os_str().is_empty() => p.to_path_buf(),
            _ => std::path::PathBuf::from("."),
        };
        let conn = Connection::open(path).context("open sqlite")?;
        conn.execute_batch(
            r#"
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
            PRAGMA foreign_keys = ON;
            PRAGMA busy_timeout = 5000;
            PRAGMA temp_store = MEMORY;
            PRAGMA cache_size = -16000;
            PRAGMA trusted_schema = ON;
            "#,
        )?;
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        match version {
            0 => {
                let has_tables: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table'",
                    [],
                    |r| r.get(0),
                )?;
                if has_tables > 0 {
                    return Err(anyhow!(
                        "database {} has tables but no schema version; refusing to touch it",
                        path.display()
                    ));
                }
                // auto_vacuum must be set before the first table exists.
                conn.execute_batch("PRAGMA auto_vacuum = INCREMENTAL;")?;
                let tx = conn.unchecked_transaction()?;
                tx.execute_batch(SCHEMA_LATEST)?;
                tx.execute_batch(PLAN_APPROVALS_SCHEMA)?;
                tx.pragma_update(None, "user_version", SCHEMA_VERSION)?;
                tx.commit()?;
            }
            7 => {
                migrate_v7_to_v8(&conn)?;
                migrate_v8_to_v13(&conn, path)?;
            }
            8 => {
                migrate_v8_to_v13(&conn, path)?;
            }
            9 => {
                migrate_v9_to_v13(&conn, path)?;
            }
            10 => {
                migrate_v10_to_v13(&conn, path)?;
            }
            11 => {
                migrate_v11_to_v13(&conn, path)?;
            }
            12 => {
                migrate_v12_to_v13(&conn, path)?;
            }
            legacy @ 1..=6 => {
                let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
                drop(conn);
                archive_legacy_db(path, legacy)?;
                return Self::open(path);
            }
            SCHEMA_VERSION => {}
            other => {
                return Err(anyhow!(
                    "database schema version {other} is newer than supported {SCHEMA_VERSION}"
                ));
            }
        }
        let db = Self { conn, data_dir };
        db.boot_maintenance()?;
        Ok(db)
    }

    /// App data directory hosting the DB and the transcript file store.
    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    /// Crash recovery + retention, run once per process at open.
    fn boot_maintenance(&self) -> Result<()> {
        let now = now_ms();
        let tx = self.conn.unchecked_transaction()?;
        tx.execute(
            "UPDATE turns
             SET status = 'aborted', error_code = COALESCE(error_code, 'TURN_ABORTED'),
                 ended_at = ?1
             WHERE status = 'running'",
            params![now],
        )?;
        tx.execute(
            "UPDATE task_runs SET status = 'aborted', ended_at = ?1 WHERE status = 'running'",
            params![now],
        )?;

        // No durable Plan work is safe to replay after a host restart. Keep
        // terminal approved session configuration intact, but interrupt every
        // pending approval and execution descriptor that could otherwise be
        // returned as queued to the desktop runner.
        let plan_work: Vec<PlanWorkRow> = {
            let mut stmt = tx.prepare_cached(
                "SELECT request_id, session_id, turn_id, tool_call_id, execution_id,
                        status, execution_state
                 FROM plan_approvals
                 WHERE status = 'pending' OR execution_state IN ('queued', 'running')",
            )?;
            let rows = stmt.query_map([], |row| {
                Ok(PlanWorkRow {
                    proposal_id: row.get(0)?,
                    session_id: row.get(1)?,
                    turn_id: row.get(2)?,
                    tool_call_id: row.get(3)?,
                    execution_id: row.get(4)?,
                    status: row.get(5)?,
                    execution_state: row.get(6)?,
                })
            })?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        tx.execute(
            "UPDATE plan_approvals
             SET status = CASE WHEN status = 'pending' THEN 'interrupted' ELSE status END,
                 resolved_at = CASE WHEN status = 'pending' THEN ?1 ELSE resolved_at END,
                 execution_state = CASE
                   WHEN execution_state IN ('queued', 'running') THEN 'interrupted'
                   ELSE execution_state
                 END,
                 updated_at = ?1,
                 version = version + 1,
                 error_code = CASE
                   WHEN status = 'pending' THEN 'PLAN_APPROVAL_INTERRUPTED'
                   WHEN execution_state IN ('queued', 'running')
                     THEN 'PLAN_EXECUTION_INTERRUPTED'
                   ELSE error_code
                 END
             WHERE status = 'pending' OR execution_state IN ('queued', 'running')",
            params![now],
        )?;
        for PlanWorkRow {
            proposal_id,
            session_id,
            turn_id,
            tool_call_id,
            execution_id,
            status,
            execution_state,
        } in plan_work
        {
            if status == "pending" {
                crate::audit::append_tx(
                    &tx,
                    "plan_approval_interrupted",
                    Some(&session_id),
                    serde_json::json!({
                        "proposalId": proposal_id,
                        "sessionId": session_id,
                        "turnId": turn_id,
                        "toolCallId": tool_call_id,
                        "status": "interrupted",
                        "errorCode": "PLAN_APPROVAL_INTERRUPTED",
                        "reason": "host_restart"
                    }),
                )?;
            }
            if matches!(execution_state.as_deref(), Some("queued") | Some("running")) {
                crate::audit::append_tx(
                    &tx,
                    "plan_execution_interrupted",
                    Some(&session_id),
                    serde_json::json!({
                        "proposalId": proposal_id,
                        "sessionId": session_id,
                        "executionId": execution_id,
                        "errorCode": "PLAN_EXECUTION_INTERRUPTED",
                        "reason": "host_restart"
                    }),
                )?;
            }
        }
        tx.commit()?;
        self.conn.execute(
            "DELETE FROM audit_log WHERE ts < ?1",
            params![now - AUDIT_RETENTION_MS],
        )?;
        self.conn.execute(
            "DELETE FROM task_runs WHERE id IN (
               SELECT id FROM (
                 SELECT id, ROW_NUMBER() OVER (
                   PARTITION BY task_id ORDER BY started_at DESC
                 ) AS rn FROM task_runs
               ) WHERE rn > ?1
             )",
            params![TASK_RUNS_KEEP],
        )?;
        self.conn.execute(
            "DELETE FROM notifications
             WHERE id IN (
               SELECT id FROM notifications
               ORDER BY created_at DESC, id DESC
               LIMIT -1 OFFSET ?1
             )",
            params![NOTIFICATION_KEEP],
        )?;
        let _ = self.conn.execute_batch("PRAGMA incremental_vacuum;");
        // One-time repair: strip the Windows extended-length path prefix
        // (`//?/X:/...` → `X:/...`) from project paths stored by older versions.
        self.fix_extended_length_project_paths()?;
        Ok(())
    }

    /// Repair project paths that were stored with the Windows extended-length
    /// prefix (`//?/X:/...`). Idempotent: rows already in normal form are
    /// skipped, and duplicates are merged by keeping the most-recently-opened.
    fn fix_extended_length_project_paths(&self) -> Result<()> {
        let mut stmt = self.conn.prepare(
            "SELECT id, path FROM projects WHERE path LIKE '//?/%'",
        )?;
        let rows: Vec<(i64, String)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for (id, old_path) in rows {
            let Some(fixed) = normalize_project_path(&old_path) else {
                continue;
            };
            if fixed == old_path {
                continue;
            }
            // Check if a row with the fixed path already exists.
            let existing: Option<i64> = self
                .conn
                .query_row(
                    "SELECT id FROM projects WHERE path = ?1",
                    params![fixed],
                    |r| r.get(0),
                )
                .optional()?;
            if let Some(keep_id) = existing {
                // Merge: reassign FKs pointing to old id, then delete the old row.
                self.conn.execute(
                    "UPDATE sessions SET project_id = ?1 WHERE project_id = ?2",
                    params![keep_id, id],
                )?;
                self.conn.execute(
                    "UPDATE scheduled_tasks SET project_id = ?1 WHERE project_id = ?2",
                    params![keep_id, id],
                )?;
                self.conn
                    .execute("DELETE FROM projects WHERE id = ?1", params![id])?;
            } else {
                self.conn.execute(
                    "UPDATE projects SET path = ?1 WHERE id = ?2",
                    params![fixed, id],
                )?;
            }
        }
        Ok(())
    }

    pub fn conn(&self) -> &Connection {
        &self.conn
    }

    // ---- kv --------------------------------------------------------------

    pub fn kv_get(&self, ns: &str, key: &str) -> Result<Option<Value>> {
        let mut stmt = self
            .conn
            .prepare_cached("SELECT value_json FROM kv WHERE ns = ?1 AND key = ?2")?;
        let mut rows = stmt.query(params![ns, key])?;
        if let Some(row) = rows.next()? {
            let raw: String = row.get(0)?;
            Ok(Some(serde_json::from_str(&raw)?))
        } else {
            Ok(None)
        }
    }

    pub fn kv_set(&self, ns: &str, key: &str, value: &Value) -> Result<()> {
        let mut stmt = self.conn.prepare_cached(
            "INSERT INTO kv (ns, key, value_json, updated_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(ns, key) DO UPDATE SET
               value_json = excluded.value_json, updated_at = excluded.updated_at",
        )?;
        stmt.execute(params![ns, key, value.to_string(), now_ms()])?;
        Ok(())
    }

    pub fn kv_delete(&self, ns: &str, key: &str) -> Result<()> {
        let mut stmt = self
            .conn
            .prepare_cached("DELETE FROM kv WHERE ns = ?1 AND key = ?2")?;
        stmt.execute(params![ns, key])?;
        Ok(())
    }

    // ---- settings compatibility shims (kv ns='app') -----------------------

    pub fn get_setting(&self, key: &str) -> Result<Option<Value>> {
        let mut value = self.kv_get("app", key)?;
        if key == "app" {
            if let Some(value) = value.as_mut() {
                strip_obsolete_plan_approval_permission_mode(value);
            }
        }
        Ok(value)
    }

    pub fn set_setting(&self, key: &str, value: &Value) -> Result<()> {
        if key != "app" {
            return self.kv_set("app", key, value);
        }
        let mut sanitized = value.clone();
        strip_obsolete_plan_approval_permission_mode(&mut sanitized);
        self.kv_set("app", key, &sanitized)
    }

    // ---- projects ----------------------------------------------------------

    /// Upsert a project row by path, returning its id. Also bumps
    /// last_opened_at when `touch` is set. The path is canonicalized when it
    /// exists on disk (matching `WorkspaceState::set`) so symlinked spellings
    /// of the same directory share one row.
    pub fn ensure_project(&self, path: &str, touch: bool) -> Result<i64> {
        upsert_project_row(&self.conn, path, touch)?
            .ok_or_else(|| anyhow!("project path must not be blank"))
    }

    pub fn project_path(&self, id: i64) -> Result<Option<String>> {
        let mut stmt = self
            .conn
            .prepare_cached("SELECT path FROM projects WHERE id = ?1")?;
        let mut rows = stmt.query(params![id])?;
        Ok(rows.next()?.map(|r| r.get(0)).transpose()?)
    }

    pub fn list_projects(&self) -> Result<Vec<ProjectRecord>> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT id, path, name, pinned, created_at, last_opened_at
             FROM projects
             ORDER BY pinned DESC, last_opened_at DESC, name COLLATE NOCASE",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(ProjectRecord {
                id: row.get(0)?,
                path: row.get(1)?,
                name: row.get(2)?,
                pinned: row.get(3)?,
                created_at: row.get(4)?,
                last_opened_at: row.get(5)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }
}

// ---- legacy database reset ----------------------------------------------

/// Breaking reset for pre-v7 files (D119): transcript content moved out of
/// SQLite and old schemas get no data migration. The file (WAL folded back in
/// by the caller) is archived next to itself for manual recovery; `-wal` /
/// `-shm` leftovers are removed so the fresh database starts clean.
fn archive_legacy_db(path: &Path, version: i64) -> Result<()> {
    let bak = path.with_extension("sqlite.v6.bak");
    // Keep the newest archive if several legacy files are opened in sequence.
    let _ = std::fs::remove_file(&bak);
    std::fs::rename(path, &bak)
        .with_context(|| format!("archive {} -> {}", path.display(), bak.display()))?;
    for suffix in ["-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
    }
    tracing::warn!(
        from_version = version,
        archived = %bak.display(),
        "pre-v7 database archived; starting fresh (D119 transcript-file reset)"
    );
    Ok(())
}

fn migrate_and_validate_top_level_mode(value: &mut Value, key: &str, context: &str) -> Result<()> {
    let object = value
        .as_object_mut()
        .ok_or_else(|| anyhow!("{context} must be an object"))?;
    let Some(item) = object.get_mut(key) else {
        return Ok(());
    };
    let mode = item
        .as_str()
        .ok_or_else(|| anyhow!("{context}.{key} must be the string 'agent', 'plan' or 'goal'"))?;
    match mode {
        "chat" => *item = Value::String("plan".into()),
        "agent" | "plan" | "goal" => {}
        other => {
            return Err(anyhow!(
                "{context}.{key} has invalid mode '{other}'; expected 'agent', 'plan' or 'goal'"
            ));
        }
    }
    Ok(())
}

fn validate_session_modes(tx: &rusqlite::Transaction<'_>) -> Result<()> {
    let invalid: Option<(String, String)> = tx
        .query_row(
            "SELECT id, mode FROM sessions
             WHERE mode NOT IN ('agent', 'plan', 'goal')
             LIMIT 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    if let Some((id, mode)) = invalid {
        return Err(anyhow!(
            "session '{id}' has invalid mode '{mode}'; expected 'agent', 'plan' or 'goal'"
        ));
    }
    Ok(())
}

fn validate_default_command_shell(
    settings: &Value,
    catalog: &crate::tools::shell::ShellCatalog,
) -> Result<()> {
    let Some(object) = settings.as_object() else {
        return Err(anyhow!("app settings JSON must be an object"));
    };
    let Some(value) = object.get("defaultCommandShell") else {
        return Ok(());
    };
    let shell_id = value
        .as_str()
        .ok_or_else(|| anyhow!("app settings defaultCommandShell must be a string"))?;
    if !crate::tools::shell::is_known_shell_id(shell_id) {
        return Err(anyhow!(
            "app settings defaultCommandShell has unknown shell ID '{shell_id}'"
        ));
    }
    if !catalog.choices.iter().any(|choice| choice.id == shell_id) {
        return Err(anyhow!(
            "app settings defaultCommandShell '{shell_id}' is unavailable on this platform"
        ));
    }
    Ok(())
}

fn migrate_app_settings(
    tx: &rusqlite::Transaction<'_>,
    catalog: &crate::tools::shell::ShellCatalog,
) -> Result<()> {
    let existing: Option<String> = tx
        .query_row(
            "SELECT value_json FROM kv WHERE ns = 'app' AND key = 'app'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    let Some(raw) = existing else {
        return Ok(());
    };
    let mut settings = serde_json::from_str::<Value>(&raw)
        .with_context(|| "app settings JSON is malformed during migration")?;
    if !settings.is_object() {
        return Err(anyhow!(
            "app settings JSON must be an object during migration"
        ));
    }
    let before = settings.clone();
    strip_obsolete_plan_approval_permission_mode(&mut settings);
    migrate_and_validate_top_level_mode(&mut settings, "defaultMode", "app settings")?;
    validate_default_command_shell(&settings, catalog)?;
    if settings != before {
        tx.execute(
            "UPDATE kv SET value_json = ?1, updated_at = ?2
             WHERE ns = 'app' AND key = 'app'",
            params![settings.to_string(), now_ms()],
        )?;
    }
    Ok(())
}

fn normalize_scheduled_config_modes(tx: &rusqlite::Transaction<'_>) -> Result<()> {
    let scheduled: Vec<(String, String)> = {
        let mut stmt = tx.prepare("SELECT id, config_json FROM scheduled_tasks")?;
        let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    for (id, raw) in scheduled {
        let mut value = serde_json::from_str::<Value>(&raw)
            .with_context(|| format!("scheduled task '{id}' config_json is malformed"))?;
        if !value.is_object() {
            return Err(anyhow!(
                "scheduled task '{id}' config_json must be an object"
            ));
        }
        let before = value.clone();
        migrate_and_validate_top_level_mode(
            &mut value,
            "mode",
            &format!("scheduled task '{id}' config_json"),
        )?;
        if value != before {
            tx.execute(
                "UPDATE scheduled_tasks SET config_json = ?1, updated_at = ?2 WHERE id = ?3",
                params![value.to_string(), now_ms(), id],
            )?;
        }
    }
    Ok(())
}

fn migrate_v7_to_v8(conn: &Connection) -> Result<()> {
    let tx = conn.unchecked_transaction()?;
    let shell_catalog = crate::tools::shell::catalog(None);
    tx.execute("UPDATE sessions SET mode = 'plan' WHERE mode = 'chat'", [])?;
    validate_session_modes(&tx)?;
    migrate_app_settings(&tx, &shell_catalog)?;

    normalize_scheduled_config_modes(&tx)?;

    tx.execute_batch(PLAN_APPROVALS_SCHEMA)?;
    tx.pragma_update(None, "user_version", 8i64)?;
    tx.commit()?;
    Ok(())
}

fn migrate_v8_to_v9_tx(tx: &rusqlite::Transaction<'_>) -> Result<()> {
    let has_approvals: bool = tx.query_row(
        "SELECT EXISTS(
             SELECT 1 FROM sqlite_master
             WHERE type = 'table' AND name = 'plan_approvals'
         )",
        [],
        |row| row.get(0),
    )?;

    if has_approvals {
        for index in [
            "idx_plan_approvals_session",
            "idx_plan_approvals_pending",
            "idx_plan_approvals_one_pending_session",
            "idx_plan_approvals_execution_queue",
            "idx_plan_approvals_execution_id",
        ] {
            tx.execute_batch(&format!("DROP INDEX IF EXISTS {index};"))?;
        }
        tx.execute_batch("ALTER TABLE plan_approvals RENAME TO plan_approvals_v8;")?;
    }
    tx.execute_batch(PLAN_APPROVALS_SCHEMA)?;
    if has_approvals {
        let now = now_ms();
        tx.execute(
            "INSERT INTO plan_approvals (
                 request_id, session_id, turn_id, tool_call_id, plan_json,
                 title, question, status, action, target_permission_mode,
                 feedback, created_at, updated_at, expires_at, resolved_at,
                 error_code, version
             )
             SELECT request_id, session_id, turn_id, tool_call_id, plan_json,
                    '', '',
                    CASE WHEN status = 'pending' THEN 'interrupted' ELSE status END,
                    action, target_permission_mode, feedback, created_at,
                    CASE WHEN status = 'pending' THEN ?1
                         ELSE COALESCE(resolved_at, created_at) END,
                    expires_at,
                    CASE WHEN status = 'pending' THEN ?1 ELSE resolved_at END,
                    CASE WHEN status = 'pending' THEN 'PLAN_APPROVAL_INTERRUPTED'
                         ELSE error_code END,
                    CASE WHEN status = 'pending' THEN 2 ELSE 1 END
             FROM plan_approvals_v8",
            params![now],
        )?;
        tx.execute_batch("DROP TABLE plan_approvals_v8;")?;
    }
    Ok(())
}

fn migrate_v9_to_v10_tx(tx: &rusqlite::Transaction<'_>) -> Result<()> {
    let shell_catalog = crate::tools::shell::catalog(None);
    migrate_app_settings(tx, &shell_catalog)?;
    normalize_scheduled_config_modes(tx)?;
    validate_session_modes(tx)?;
    let now = now_ms();

    // v9 did not enforce one live turn per session. Abort every old live row
    // before creating the partial unique index, including duplicate rows from
    // a damaged database.
    tx.execute(
        "UPDATE turns
         SET status = 'aborted', error_code = COALESCE(error_code, 'TURN_ABORTED'),
             ended_at = COALESCE(ended_at, ?1)
         WHERE status = 'running'",
        params![now],
    )?;
    tx.execute_batch(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_turns_one_running_session
         ON turns(session_id) WHERE status = 'running';",
    )?;
    tx.execute(
        "UPDATE plan_approvals
         SET expires_at = created_at + ?1
         WHERE status = 'pending' AND expires_at IS NULL",
        params![PLAN_APPROVAL_TIMEOUT_MS],
    )?;
    tx.pragma_update(None, "user_version", 10i64)?;
    Ok(())
}

/// v11 adds the Plan/Goal approval discriminator (D198). Legacy rows are Plan
/// contracts by definition, which is exactly the column default.
fn migrate_v10_to_v11_tx(tx: &rusqlite::Transaction<'_>) -> Result<()> {
    // A v8 database migrated in the same chain already created the table from
    // PLAN_APPROVALS_SCHEMA, which carries `kind`; only true v10 files need it.
    let has_kind: bool = tx.query_row(
        "SELECT EXISTS(
             SELECT 1 FROM pragma_table_info('plan_approvals') WHERE name = 'kind'
         )",
        [],
        |row| row.get(0),
    )?;
    if !has_kind {
        tx.execute_batch(
            "ALTER TABLE plan_approvals
             ADD COLUMN kind TEXT NOT NULL DEFAULT 'plan'
             CHECK (kind IN ('plan', 'goal'));",
        )?;
    }
    validate_session_modes(tx)?;
    tx.pragma_update(None, "user_version", 11i64)?;
    Ok(())
}

/// v12 historically created A2A tables. Those tables are dropped in v13, so
/// this step is now a version-only bump.
fn migrate_v11_to_v12_tx(tx: &rusqlite::Transaction<'_>) -> Result<()> {
    tx.pragma_update(None, "user_version", 12i64)?;
    Ok(())
}

/// v13 drops the withdrawn A2A tables (ADR 0165).
fn migrate_v12_to_v13_tx(tx: &rusqlite::Transaction<'_>) -> Result<()> {
    tx.execute_batch(
        r#"
        DROP TABLE IF EXISTS a2a_push_configs;
        DROP TABLE IF EXISTS a2a_artifacts;
        DROP TABLE IF EXISTS a2a_messages;
        DROP TABLE IF EXISTS a2a_tasks;
        "#,
    )?;
    tx.pragma_update(None, "user_version", 13i64)?;
    Ok(())
}

fn migration_backup_path(path: &Path, version: i64) -> PathBuf {
    path.with_extension(format!("sqlite.v{version}.bak"))
}

fn verify_migration_backup(path: &Path, expected_version: i64) -> Result<()> {
    let backup = Connection::open(path)
        .with_context(|| format!("open migration backup {}", path.display()))?;
    let version: i64 = backup
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .with_context(|| format!("read migration backup version {}", path.display()))?;
    if version != expected_version {
        return Err(anyhow!(
            "migration backup {} has schema version {version}, expected {expected_version}",
            path.display()
        ));
    }
    let integrity: String = backup
        .query_row("PRAGMA integrity_check", [], |row| row.get(0))
        .with_context(|| format!("check migration backup integrity {}", path.display()))?;
    if integrity != "ok" {
        return Err(anyhow!(
            "migration backup {} failed integrity check: {integrity}",
            path.display()
        ));
    }
    Ok(())
}

fn create_migration_backup(conn: &Connection, path: &Path, version: i64) -> Result<PathBuf> {
    let checkpoint: (i64, i64, i64) = conn
        .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .with_context(|| format!("checkpoint database before v{version} backup"))?;
    if checkpoint.0 != 0 {
        return Err(anyhow!(
            "database WAL is busy; cannot create v{version} migration backup"
        ));
    }

    let backup = migration_backup_path(path, version);
    let backup_name = backup
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| anyhow!("migration backup path is not valid UTF-8"))?;
    let temporary = backup.with_file_name(format!("{backup_name}.tmp"));
    if temporary.exists() {
        std::fs::remove_file(&temporary)
            .with_context(|| format!("remove stale migration backup {}", temporary.display()))?;
    }
    if let Err(error) = std::fs::copy(path, &temporary) {
        let _ = std::fs::remove_file(&temporary);
        return Err(error).with_context(|| {
            format!(
                "copy schema v{version} database {} to temporary backup {}",
                path.display(),
                temporary.display()
            )
        });
    }
    if let Err(error) = verify_migration_backup(&temporary, version) {
        let _ = std::fs::remove_file(&temporary);
        return Err(error);
    }
    if backup.exists() {
        std::fs::remove_file(&backup)
            .with_context(|| format!("replace existing migration backup {}", backup.display()))?;
    }
    if let Err(error) = std::fs::rename(&temporary, &backup) {
        let _ = std::fs::remove_file(&temporary);
        return Err(error).with_context(|| {
            format!(
                "install migration backup {} from {}",
                backup.display(),
                temporary.display()
            )
        });
    }
    Ok(backup)
}

fn migrate_v8_to_v13(conn: &Connection, path: &Path) -> Result<()> {
    let backup = create_migration_backup(conn, path, 8)?;
    let tx = conn.unchecked_transaction()?;
    migrate_v8_to_v9_tx(&tx)?;
    migrate_v9_to_v10_tx(&tx)?;
    migrate_v10_to_v11_tx(&tx)?;
    migrate_v11_to_v12_tx(&tx)?;
    migrate_v12_to_v13_tx(&tx)?;
    tx.commit().with_context(|| {
        format!(
            "commit schema v8 to v13 migration; backup {} remains",
            backup.display()
        )
    })?;
    Ok(())
}

fn migrate_v9_to_v13(conn: &Connection, path: &Path) -> Result<()> {
    let backup = create_migration_backup(conn, path, 9)?;
    let tx = conn.unchecked_transaction()?;
    migrate_v9_to_v10_tx(&tx)?;
    migrate_v10_to_v11_tx(&tx)?;
    migrate_v11_to_v12_tx(&tx)?;
    migrate_v12_to_v13_tx(&tx)?;
    tx.commit().with_context(|| {
        format!(
            "commit schema v9 to v13 migration; backup {} remains",
            backup.display()
        )
    })?;
    Ok(())
}

fn migrate_v10_to_v13(conn: &Connection, path: &Path) -> Result<()> {
    let backup = create_migration_backup(conn, path, 10)?;
    let tx = conn.unchecked_transaction()?;
    migrate_v10_to_v11_tx(&tx)?;
    migrate_v11_to_v12_tx(&tx)?;
    migrate_v12_to_v13_tx(&tx)?;
    tx.commit().with_context(|| {
        format!(
            "commit schema v10 to v13 migration; backup {} remains",
            backup.display()
        )
    })?;
    Ok(())
}

fn migrate_v11_to_v13(conn: &Connection, path: &Path) -> Result<()> {
    let backup = create_migration_backup(conn, path, 11)?;
    let tx = conn.unchecked_transaction()?;
    migrate_v11_to_v12_tx(&tx)?;
    migrate_v12_to_v13_tx(&tx)?;
    tx.commit().with_context(|| {
        format!(
            "commit schema v11 to v13 migration; backup {} remains",
            backup.display()
        )
    })?;
    Ok(())
}

fn migrate_v12_to_v13(conn: &Connection, path: &Path) -> Result<()> {
    let backup = create_migration_backup(conn, path, 12)?;
    let tx = conn.unchecked_transaction()?;
    migrate_v12_to_v13_tx(&tx)?;
    tx.commit().with_context(|| {
        format!(
            "commit schema v12 to v13 migration; backup {} remains",
            backup.display()
        )
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn table_exists(conn: &Connection, name: &str) -> bool {
        conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
            params![name],
            |r| r.get::<_, i64>(0),
        )
        .map(|n| n > 0)
        .unwrap_or(false)
    }

    fn schema_version(conn: &Connection) -> i64 {
        conn.query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap()
    }

    fn insert_raw_app_settings(db: &Database, raw: &str) {
        db.conn()
            .execute(
                "INSERT INTO kv (ns, key, value_json, updated_at)
                 VALUES ('app', 'app', ?1, 1)
                 ON CONFLICT(ns, key) DO UPDATE SET value_json = excluded.value_json",
                params![raw],
            )
            .unwrap();
    }

    fn assert_readable_migration_backup(path: &Path, version: i64) {
        let backup_path = migration_backup_path(path, version);
        assert!(
            backup_path.exists(),
            "missing {} backup",
            backup_path.display()
        );
        let backup = Connection::open(&backup_path).unwrap();
        assert_eq!(schema_version(&backup), version);
        let integrity: String = backup
            .query_row("PRAGMA integrity_check", [], |row| row.get(0))
            .unwrap();
        assert_eq!(integrity, "ok");
        drop(backup);
    }

    fn fail_v8_migration(path: &Path) -> String {
        let error = match Database::open(path) {
            Ok(db) => {
                drop(db);
                panic!("schema v8 migration unexpectedly succeeded")
            }
            Err(error) => error,
        };
        let source = Connection::open(path).unwrap();
        assert_eq!(schema_version(&source), 8);
        drop(source);
        assert_readable_migration_backup(path, 8);
        error.to_string()
    }

    #[test]
    fn fresh_open_creates_latest_schema() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
        let version: i64 = db
            .conn()
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
        for table in [
            "kv",
            "projects",
            "providers",
            "models",
            "sessions",
            "turns",
            "notifications",
            "messages",
            "message_revisions",
            "artifacts",
            "scheduled_tasks",
            "task_runs",
            "secrets_meta",
            "audit_log",
            "plan_approvals",
        ] {
            assert!(table_exists(db.conn(), table), "missing {table}");
        }
        let thinking_column: (String, String) = db
            .conn()
            .query_row(
                "SELECT name, dflt_value
                 FROM pragma_table_info('sessions')
                 WHERE name = 'thinking_level'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(thinking_column, ("thinking_level".into(), "'off'".into()));

        let index_count: i64 = db
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type = 'index' AND name IN (
                   'idx_plan_approvals_session',
                   'idx_plan_approvals_pending',
                   'idx_plan_approvals_one_pending_session',
                   'idx_plan_approvals_execution_queue',
                   'idx_plan_approvals_execution_id'
                 )",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(index_count, 5);
        let running_turn_index: i64 = db
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type = 'index' AND name = 'idx_turns_one_running_session'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(running_turn_index, 1);

        let scheduled_mode_columns: i64 = db
            .conn()
            .query_row(
                "SELECT COUNT(*)
                 FROM pragma_table_info('scheduled_tasks')
                 WHERE name = 'mode'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(scheduled_mode_columns, 0);

        // v7: transcript payloads live in per-session files, not columns.
        for (table, column) in [
            ("messages", "content_json"),
            ("messages", "meta_json"),
            ("message_revisions", "messages_json"),
        ] {
            let n: i64 = db
                .conn()
                .query_row(
                    &format!("SELECT COUNT(*) FROM pragma_table_info('{table}') WHERE name = ?1"),
                    params![column],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(n, 0, "{table}.{column} must not exist in v7");
        }
    }

    #[test]
    fn archives_pre_v7_database_and_starts_fresh() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pi.sqlite");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE sessions (id TEXT PRIMARY KEY);
                 INSERT INTO sessions (id) VALUES ('legacy');",
            )
            .unwrap();
            conn.pragma_update(None, "user_version", 6).unwrap();
        }

        let db = Database::open(&path).unwrap();
        let version: i64 = db
            .conn()
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
        let sessions: i64 = db
            .conn()
            .query_row("SELECT COUNT(*) FROM sessions", [], |r| r.get(0))
            .unwrap();
        assert_eq!(sessions, 0, "fresh database starts empty");

        let bak = dir.path().join("pi.sqlite.v6.bak");
        assert!(bak.exists(), "legacy file is archived for manual recovery");
        let old = Connection::open(&bak).unwrap();
        let preserved: i64 = old
            .query_row("SELECT COUNT(*) FROM sessions", [], |r| r.get(0))
            .unwrap();
        assert_eq!(preserved, 1, "archive keeps the legacy data");

        // Reopening the fresh v7 file is a plain open, not another reset.
        drop(db);
        let db = Database::open(&path).unwrap();
        let version: i64 = db
            .conn()
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
        assert!(table_exists(db.conn(), "messages"));
    }

    #[test]
    fn kv_roundtrip_and_delete() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
        db.kv_set("plugin:demo", "cfg", &serde_json::json!({ "on": true }))
            .unwrap();
        assert_eq!(
            db.kv_get("plugin:demo", "cfg").unwrap().unwrap(),
            serde_json::json!({ "on": true })
        );
        db.kv_delete("plugin:demo", "cfg").unwrap();
        assert!(db.kv_get("plugin:demo", "cfg").unwrap().is_none());
    }

    #[test]
    fn migrates_v7_chat_modes_settings_and_scheduled_values_to_plan() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pi.sqlite");
        {
            let db = Database::open(&path).unwrap();
            db.conn()
                .execute(
                    "INSERT INTO sessions (id, mode, created_at, updated_at)
                     VALUES ('legacy-session', 'chat', 1, 1)",
                    [],
                )
                .unwrap();
            db.kv_set(
                "app",
                "app",
                &serde_json::json!({
                    "defaultMode": "chat",
                    "theme": "dark",
                    "planApprovalPermissionMode": "auto",
                    "notification": { "mode": "silent" },
                    "plugin": { "mode": "plugin", "defaultMode": "extension" }
                }),
            )
            .unwrap();
            db.conn()
                .execute(
                    "INSERT INTO scheduled_tasks
                        (id, title, prompt, config_json, created_at, updated_at)
                     VALUES (
                         'task-1', 'legacy', 'run',
                         '{\"mode\":\"chat\",\"notification\":{\"mode\":\"silent\"},\"plugin\":{\"defaultMode\":\"extension\",\"mode\":\"plugin\"}}',
                         1, 1
                     )",
                    [],
                )
                .unwrap();
            db.kv_set(
                "plugin:test",
                "config",
                &serde_json::json!({
                    "mode": "chat",
                    "defaultMode": "chat",
                    "nested": { "operatingMode": "chat" }
                }),
            )
            .unwrap();
            // Simulate a real v7 file: the approval table did not exist until
            // the migration itself creates the canonical table and indexes.
            db.conn()
                .execute_batch("DROP TABLE plan_approvals;")
                .unwrap();
            db.conn().pragma_update(None, "user_version", 7).unwrap();
        }

        let db = Database::open(&path).unwrap();
        let version: i64 = db
            .conn()
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
        let mode: String = db
            .conn()
            .query_row(
                "SELECT mode FROM sessions WHERE id = 'legacy-session'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(mode, "plan");
        assert_eq!(
            db.get_setting("app").unwrap().unwrap()["defaultMode"],
            serde_json::json!("plan")
        );
        let settings = db.get_setting("app").unwrap().unwrap();
        assert_eq!(settings["theme"], serde_json::json!("dark"));
        assert_eq!(settings["notification"]["mode"], "silent");
        assert_eq!(
            settings["plugin"],
            serde_json::json!({ "mode": "plugin", "defaultMode": "extension" })
        );
        assert!(settings
            .get(OBSOLETE_PLAN_APPROVAL_PERMISSION_MODE)
            .is_none());
        let raw_settings = db.kv_get("app", "app").unwrap().unwrap();
        assert!(raw_settings
            .get(OBSOLETE_PLAN_APPROVAL_PERMISSION_MODE)
            .is_none());
        let config: String = db
            .conn()
            .query_row(
                "SELECT config_json FROM scheduled_tasks WHERE id = 'task-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&config).unwrap()["mode"],
            "plan"
        );
        let config_value = serde_json::from_str::<Value>(&config).unwrap();
        assert_eq!(config_value["notification"]["mode"], "silent");
        assert_eq!(
            config_value["plugin"],
            serde_json::json!({ "defaultMode": "extension", "mode": "plugin" })
        );
        assert_eq!(
            db.kv_get("plugin:test", "config").unwrap().unwrap(),
            serde_json::json!({
                "mode": "chat",
                "defaultMode": "chat",
                "nested": { "operatingMode": "chat" }
            })
        );
        assert!(table_exists(db.conn(), "plan_approvals"));
        let index_count: i64 = db
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master
                 WHERE type = 'index' AND name IN (
                   'idx_plan_approvals_session',
                   'idx_plan_approvals_pending',
                   'idx_plan_approvals_one_pending_session',
                   'idx_plan_approvals_execution_queue',
                   'idx_plan_approvals_execution_id'
                 )",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(index_count, 5);
        drop(db);
        assert_readable_migration_backup(&path, 8);
    }

    #[test]
    fn migrates_v8_approvals_without_expiring_new_work() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pi.sqlite");
        {
            let db = Database::open(&path).unwrap();
            db.conn()
                .execute(
                    "INSERT INTO sessions (id, mode, created_at, updated_at)
                     VALUES ('v8-session', 'plan', 1, 1)",
                    [],
                )
                .unwrap();
            db.conn()
                .execute_batch("DROP TABLE plan_approvals;")
                .unwrap();
            db.kv_set(
                "app",
                "app",
                &serde_json::json!({
                    "theme": "light",
                    "planApprovalPermissionMode": "accept-edits"
                }),
            )
            .unwrap();
            db.conn()
                .execute_batch(
                    "CREATE TABLE plan_approvals (
                       request_id TEXT PRIMARY KEY,
                       session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                       turn_id TEXT NOT NULL,
                       tool_call_id TEXT NOT NULL UNIQUE,
                       plan_json TEXT NOT NULL,
                       status TEXT NOT NULL CHECK (status IN (
                         'pending', 'approved', 'changes_requested', 'rejected',
                         'expired', 'interrupted'
                       )),
                       action TEXT CHECK (action IN ('approve', 'request_changes', 'reject')),
                       target_permission_mode TEXT CHECK (
                         target_permission_mode IN ('ask', 'accept-edits', 'auto')
                       ),
                       feedback TEXT,
                       created_at INTEGER NOT NULL,
                       expires_at INTEGER NOT NULL,
                       resolved_at INTEGER,
                       error_code TEXT
                     );
                     INSERT INTO plan_approvals (
                       request_id, session_id, turn_id, tool_call_id, plan_json,
                       status, created_at, expires_at
                     ) VALUES
                       ('terminal-v8', 'v8-session', 'turn-terminal', 'call-terminal',
                        'terminal plan', 'approved', 10, 20),
                       ('pending-v8', 'v8-session', 'turn-pending', 'call-pending',
                        'pending plan', 'pending', 11, 21);",
                )
                .unwrap();
            db.conn().pragma_update(None, "user_version", 8).unwrap();
        }

        let db = Database::open(&path).unwrap();
        let version: i64 = db
            .conn()
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
        let terminal: (String, Option<String>, i64) = db
            .conn()
            .query_row(
                "SELECT status, error_code, version FROM plan_approvals
                 WHERE request_id = 'terminal-v8'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(terminal, ("approved".into(), None, 1));
        let pending: (String, Option<String>, Option<String>, i64) = db
            .conn()
            .query_row(
                "SELECT status, error_code, artifact_relative_path, version
                 FROM plan_approvals WHERE request_id = 'pending-v8'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(
            pending,
            (
                "interrupted".into(),
                Some("PLAN_APPROVAL_INTERRUPTED".into()),
                None,
                2
            )
        );
        let settings = db.get_setting("app").unwrap().unwrap();
        assert_eq!(settings["theme"], serde_json::json!("light"));
        assert!(settings
            .get(OBSOLETE_PLAN_APPROVAL_PERMISSION_MODE)
            .is_none());
        let raw_settings = db.kv_get("app", "app").unwrap().unwrap();
        assert!(raw_settings
            .get(OBSOLETE_PLAN_APPROVAL_PERMISSION_MODE)
            .is_none());
        drop(db);
        assert_readable_migration_backup(&path, 8);
    }

    #[test]
    fn v8_migration_rejects_malformed_app_settings_and_preserves_source() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pi.sqlite");
        {
            let db = Database::open(&path).unwrap();
            db.conn()
                .execute(
                    "INSERT INTO sessions (id, mode, created_at, updated_at)
                     VALUES ('malformed-app-session', 'agent', 1, 1)",
                    [],
                )
                .unwrap();
            insert_raw_app_settings(&db, "{not-json");
            db.conn().pragma_update(None, "user_version", 8).unwrap();
        }

        let error = fail_v8_migration(&path);
        assert!(error.contains("app settings JSON is malformed"), "{error}");
        let source = Connection::open(&path).unwrap();
        let mode: String = source
            .query_row(
                "SELECT mode FROM sessions WHERE id = 'malformed-app-session'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(mode, "agent");
        drop(source);
    }

    #[test]
    fn v8_migration_rejects_malformed_scheduled_config_and_preserves_source() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pi.sqlite");
        {
            let db = Database::open(&path).unwrap();
            db.conn()
                .execute(
                    "INSERT INTO scheduled_tasks
                        (id, title, prompt, config_json, created_at, updated_at)
                     VALUES ('malformed-config-task', 'broken', 'run', '{not-json', 1, 1)",
                    [],
                )
                .unwrap();
            db.conn().pragma_update(None, "user_version", 8).unwrap();
        }

        let error = fail_v8_migration(&path);
        assert!(
            error.contains("scheduled task 'malformed-config-task' config_json is malformed"),
            "{error}"
        );
        let source = Connection::open(&path).unwrap();
        let config: String = source
            .query_row(
                "SELECT config_json FROM scheduled_tasks
                 WHERE id = 'malformed-config-task'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(config, "{not-json");
        drop(source);
    }

    #[test]
    fn v8_migration_rejects_invalid_session_mode_and_preserves_source() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pi.sqlite");
        {
            let db = Database::open(&path).unwrap();
            db.conn()
                .execute(
                    "INSERT INTO sessions (id, mode, created_at, updated_at)
                     VALUES ('invalid-mode-session', 'invalid', 1, 1)",
                    [],
                )
                .unwrap();
            db.conn().pragma_update(None, "user_version", 8).unwrap();
        }

        let error = fail_v8_migration(&path);
        assert!(
            error.contains("session 'invalid-mode-session' has invalid mode 'invalid'"),
            "{error}"
        );
        let source = Connection::open(&path).unwrap();
        let mode: String = source
            .query_row(
                "SELECT mode FROM sessions WHERE id = 'invalid-mode-session'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(mode, "invalid");
        drop(source);
    }

    #[test]
    fn v8_migration_rejects_invalid_shell_and_preserves_source() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pi.sqlite");
        let invalid_shell = if cfg!(windows) {
            crate::tools::shell::BASH_ID
        } else {
            crate::tools::shell::WINDOWS_POWERSHELL_ID
        };
        {
            let db = Database::open(&path).unwrap();
            insert_raw_app_settings(
                &db,
                &serde_json::json!({
                    "defaultCommandShell": invalid_shell,
                    "theme": "dark"
                })
                .to_string(),
            );
            db.conn().pragma_update(None, "user_version", 8).unwrap();
        }

        let error = fail_v8_migration(&path);
        assert!(
            error.contains("app settings defaultCommandShell")
                && error.contains("unavailable on this platform"),
            "{error}"
        );
        let source = Connection::open(&path).unwrap();
        let raw: String = source
            .query_row(
                "SELECT value_json FROM kv WHERE ns = 'app' AND key = 'app'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&raw).unwrap()["defaultCommandShell"],
            invalid_shell
        );
        drop(source);
    }

    #[test]
    fn v8_migration_rejects_unknown_shell_and_preserves_source() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pi.sqlite");
        let unknown_shell = "not-a-real-command-shell";
        {
            let db = Database::open(&path).unwrap();
            insert_raw_app_settings(
                &db,
                &serde_json::json!({
                    "defaultCommandShell": unknown_shell,
                    "theme": "dark"
                })
                .to_string(),
            );
            db.conn().pragma_update(None, "user_version", 8).unwrap();
        }

        let error = fail_v8_migration(&path);
        assert!(
            error.contains("app settings defaultCommandShell has unknown shell ID")
                && error.contains(unknown_shell),
            "{error}"
        );
        let source = Connection::open(&path).unwrap();
        let raw: String = source
            .query_row(
                "SELECT value_json FROM kv WHERE ns = 'app' AND key = 'app'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&raw).unwrap()["defaultCommandShell"],
            unknown_shell
        );
        drop(source);
    }

    #[test]
    fn migration_accepts_current_platform_shell_when_catalog_marks_it_unavailable() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE kv (
                ns TEXT NOT NULL,
                key TEXT NOT NULL,
                value_json TEXT NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (ns, key)
            ) WITHOUT ROWID;",
        )
        .unwrap();
        let shell_id = crate::tools::shell::default_shell_id();
        conn.execute(
            "INSERT INTO kv (ns, key, value_json, updated_at)
             VALUES ('app', 'app', ?1, 1)",
            params![serde_json::json!({
                "defaultCommandShell": shell_id,
                "defaultMode": "chat"
            })
            .to_string()],
        )
        .unwrap();
        let catalog = crate::tools::shell::catalog_for_platform(
            crate::tools::shell::current_platform(),
            Some(shell_id),
            |_| false,
        );
        assert!(catalog
            .choices
            .iter()
            .any(|choice| { choice.id == shell_id && !choice.available }));

        let tx = conn.unchecked_transaction().unwrap();
        migrate_app_settings(&tx, &catalog).unwrap();
        tx.commit().unwrap();

        let raw: String = conn
            .query_row(
                "SELECT value_json FROM kv WHERE ns = 'app' AND key = 'app'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let settings = serde_json::from_str::<Value>(&raw).unwrap();
        assert_eq!(settings["defaultCommandShell"], shell_id);
        assert_eq!(settings["defaultMode"], "plan");
    }

    #[test]
    fn boot_interrupts_pending_and_queued_plan_work_without_replaying_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pi.sqlite");
        {
            let db = Database::open(&path).unwrap();
            db.conn()
                .execute(
                    "INSERT INTO sessions (id, mode, permission_mode, created_at, updated_at)
                     VALUES ('execution-session', 'agent', 'auto', 1, 1)",
                    [],
                )
                .unwrap();
            db.conn()
                .execute(
                    "INSERT INTO plan_approvals (
                       request_id, session_id, turn_id, tool_call_id, plan_json,
                       title, question, status, created_at, updated_at,
                       artifact_relative_path, artifact_sha256, artifact_size_bytes,
                       version, execution_id, execution_state, target_permission_mode
                     ) VALUES
                       ('running-proposal', 'execution-session', 'turn-1', 'call-1',
                        'running', 'Running', '?', 'approved', 1, 1,
                        '.pi/plan/running.md', 'hash', 7, 1, 'running-execution', 'running', 'auto'),
                       ('queued-proposal', 'execution-session', 'turn-2', 'call-2',
                        'queued', 'Queued', '?', 'approved', 2, 2,
                        '.pi/plan/queued.md', 'hash', 6, 1, 'queued-execution', 'queued', 'auto'),
                       ('pending-proposal', 'execution-session', 'turn-3', 'call-3',
                        'pending', 'Pending', '?', 'pending', 3, 3,
                        '.pi/plan/pending.md', 'hash', 7, 1, NULL, NULL, 'auto')",
                    [],
                )
                .unwrap();
        }
        let db = Database::open(&path).unwrap();
        let running: (String, Option<String>) = db
            .conn()
            .query_row(
                "SELECT execution_state, error_code FROM plan_approvals
                 WHERE execution_id = 'running-execution'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            running,
            (
                "interrupted".into(),
                Some("PLAN_EXECUTION_INTERRUPTED".into())
            )
        );
        let queued: String = db
            .conn()
            .query_row(
                "SELECT execution_state FROM plan_approvals
                 WHERE execution_id = 'queued-execution'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(queued, "interrupted");
        let pending: (String, Option<String>) = db
            .conn()
            .query_row(
                "SELECT status, error_code FROM plan_approvals
                 WHERE request_id = 'pending-proposal'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            pending,
            (
                "interrupted".into(),
                Some("PLAN_APPROVAL_INTERRUPTED".into())
            )
        );
        let execution_audits: i64 = db
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM audit_log
                 WHERE kind = 'plan_execution_interrupted'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(execution_audits, 2);
        let approval_audits: i64 = db
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM audit_log
                 WHERE kind = 'plan_approval_interrupted'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(approval_audits, 1);
        let session_config: (String, String) = db
            .conn()
            .query_row(
                "SELECT mode, permission_mode FROM sessions
                 WHERE id = 'execution-session'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(session_config, ("agent".into(), "auto".into()));
    }

    #[test]
    fn migrates_v9_running_turns_before_creating_single_turn_index() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pi.sqlite");
        {
            let db = Database::open(&path).unwrap();
            db.conn()
                .execute_batch("DROP INDEX idx_turns_one_running_session;")
                .unwrap();
            db.conn()
                .execute(
                    "INSERT INTO sessions (id, created_at, updated_at)
                     VALUES ('migration-session', 1, 1)",
                    [],
                )
                .unwrap();
            db.conn()
                .execute(
                    "INSERT INTO turns (id, session_id, started_at)
                     VALUES ('old-turn-1', 'migration-session', 1),
                            ('old-turn-2', 'migration-session', 2)",
                    [],
                )
                .unwrap();
            db.conn()
                .execute(
                    "INSERT INTO scheduled_tasks
                        (id, title, prompt, config_json, created_at, updated_at)
                     VALUES ('migration-task', 'legacy', 'run', '{\"mode\":\"chat\"}', 1, 1)",
                    [],
                )
                .unwrap();
            db.conn().pragma_update(None, "user_version", 9).unwrap();
        }

        let db = Database::open(&path).unwrap();
        let states: Vec<(String, Option<String>, Option<i64>)> = {
            let mut stmt = db
                .conn()
                .prepare(
                    "SELECT status, error_code, ended_at FROM turns
                     WHERE session_id = 'migration-session' ORDER BY id",
                )
                .unwrap();
            stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
                .unwrap()
                .collect::<rusqlite::Result<Vec<_>>>()
                .unwrap()
        };
        assert_eq!(states.len(), 2);
        for (status, error_code, ended_at) in states {
            assert_eq!(status, "aborted");
            assert_eq!(error_code.as_deref(), Some("TURN_ABORTED"));
            assert!(ended_at.is_some());
        }
        let index_exists: bool = db
            .conn()
            .query_row(
                "SELECT EXISTS(
                   SELECT 1 FROM sqlite_master
                   WHERE type = 'index' AND name = 'idx_turns_one_running_session'
                 )",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(index_exists);
        let config: String = db
            .conn()
            .query_row(
                "SELECT config_json FROM scheduled_tasks WHERE id = 'migration-task'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&config).unwrap()["mode"],
            "plan"
        );
        drop(db);
        assert_readable_migration_backup(&path, 9);
    }

    #[test]
    fn migrates_v10_approvals_by_labelling_them_plan_contracts() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pi.sqlite");
        {
            let db = Database::open(&path).unwrap();
            db.conn()
                .execute_batch(
                    "ALTER TABLE plan_approvals DROP COLUMN kind;
                     INSERT INTO sessions (id, mode, created_at, updated_at)
                     VALUES ('legacy-session', 'plan', 1, 1);
                     INSERT INTO plan_approvals
                        (request_id, session_id, turn_id, tool_call_id, plan_json,
                         status, created_at, updated_at)
                     VALUES ('legacy-approval', 'legacy-session', 'legacy-turn',
                             'legacy-call', '# Plan', 'approved', 1, 1);",
                )
                .unwrap();
            db.conn().pragma_update(None, "user_version", 10).unwrap();
        }

        let db = Database::open(&path).unwrap();
        let version: i64 = db
            .conn()
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
        let kind: String = db
            .conn()
            .query_row(
                "SELECT kind FROM plan_approvals WHERE request_id = 'legacy-approval'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(kind, "plan");
        // The new column still refuses anything outside the two contracts.
        assert!(db
            .conn()
            .execute(
                "UPDATE plan_approvals SET kind = 'sprint' WHERE request_id = 'legacy-approval'",
                [],
            )
            .is_err());
        db.conn()
            .execute(
                "UPDATE plan_approvals SET kind = 'goal' WHERE request_id = 'legacy-approval'",
                [],
            )
            .unwrap();
        drop(db);
        assert_readable_migration_backup(&path, 10);
    }

    #[test]
    fn migrates_v12_by_dropping_a2a_tables() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pi.sqlite");
        {
            let db = Database::open(&path).unwrap();
            db.conn()
                .execute_batch(
                    "CREATE TABLE a2a_tasks (id TEXT PRIMARY KEY);
                     CREATE TABLE a2a_messages (id TEXT PRIMARY KEY);
                     CREATE TABLE a2a_artifacts (id TEXT PRIMARY KEY);
                     CREATE TABLE a2a_push_configs (id TEXT PRIMARY KEY);",
                )
                .unwrap();
            db.conn().pragma_update(None, "user_version", 12).unwrap();
        }

        let db = Database::open(&path).unwrap();
        let version: i64 = db
            .conn()
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
        for table in [
            "a2a_tasks",
            "a2a_messages",
            "a2a_artifacts",
            "a2a_push_configs",
        ] {
            assert!(!table_exists(db.conn(), table), "leftover {table}");
        }
        drop(db);
        assert_readable_migration_backup(&path, 12);
    }

    #[test]
    fn goal_is_a_valid_persisted_session_mode() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
        db.conn()
            .execute(
                "INSERT INTO sessions (id, mode, created_at, updated_at)
                 VALUES ('goal-session', 'goal', 1, 1)",
                [],
            )
            .unwrap();
        let tx = db.conn().unchecked_transaction().unwrap();
        validate_session_modes(&tx).unwrap();
        let mut settings = serde_json::json!({ "defaultMode": "goal" });
        migrate_and_validate_top_level_mode(&mut settings, "defaultMode", "app settings").unwrap();
        assert_eq!(settings["defaultMode"], "goal");
        let mut invalid = serde_json::json!({ "defaultMode": "sprint" });
        assert!(
            migrate_and_validate_top_level_mode(&mut invalid, "defaultMode", "app settings")
                .is_err()
        );
    }

    #[test]
    fn ensure_project_upserts_by_path() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
        let a = db.ensure_project("/tmp/demo", true).unwrap();
        let b = db.ensure_project("/tmp/demo/", false).unwrap();
        assert_eq!(a, b);
        assert_eq!(db.project_path(a).unwrap().as_deref(), Some("/tmp/demo"));
        let projects = db.list_projects().unwrap();
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].path, "/tmp/demo");
        assert_eq!(projects[0].name, "demo");

        let windows = db.ensure_project("C:\\work\\project\\", false).unwrap();
        assert_eq!(
            db.project_path(windows).unwrap().as_deref(),
            Some("C:/work/project")
        );
    }

    #[test]
    fn list_projects_propagates_row_decode_errors() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
        db.conn()
            .execute(
                "INSERT INTO projects
                    (path, name, pinned, created_at, last_opened_at)
                 VALUES ('/tmp/broken', 'broken', 'not-a-number', 1, 1)",
                [],
            )
            .unwrap();

        assert!(db.list_projects().is_err());
    }

    #[cfg(unix)]
    #[test]
    fn ensure_project_dedupes_symlinked_spellings() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real-project");
        std::fs::create_dir_all(&real).unwrap();
        let link = dir.path().join("link-project");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
        let a = db.ensure_project(&real.to_string_lossy(), true).unwrap();
        let b = db.ensure_project(&link.to_string_lossy(), true).unwrap();
        assert_eq!(a, b, "symlinked path spellings must share one project row");
        assert_eq!(db.list_projects().unwrap().len(), 1);
    }

    #[test]
    fn normalize_project_path_strips_extended_length_prefix() {
        // Forward-slash variant stored by older DB versions on Windows
        assert_eq!(
            normalize_project_path("//?/C:/Users/mi/project"),
            Some("C:/Users/mi/project".to_string()),
        );
        assert_eq!(
            normalize_project_path("//?/D:/work/app"),
            Some("D:/work/app".to_string()),
        );
        // Backslash variant coming directly from canonicalize on Windows
        assert_eq!(
            normalize_project_path(r"\\?\C:\Users\mi\project"),
            Some("C:/Users/mi/project".to_string()),
        );
        // Non-drive UNC paths should NOT be stripped
        assert_eq!(
            normalize_project_path("//?/UNC/server/share"),
            Some("//?/UNC/server/share".to_string()),
        );
        // Normal paths remain unchanged
        assert_eq!(
            normalize_project_path("C:/Users/mi/project"),
            Some("C:/Users/mi/project".to_string()),
        );
        assert_eq!(
            normalize_project_path("/home/user/project"),
            Some("/home/user/project".to_string()),
        );
    }
}
