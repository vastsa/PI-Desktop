use super::*;

pub(crate) const OBSOLETE_PLAN_APPROVAL_PERMISSION_MODE: &str = "planApprovalPermissionMode";

pub(crate) fn strip_obsolete_plan_approval_permission_mode(value: &mut Value) -> bool {
    value
        .as_object_mut()
        .and_then(|object| object.remove(OBSOLETE_PLAN_APPROVAL_PERMISSION_MODE))
        .is_some()
}

const PROJECT_MEMORY_NAMESPACE: &str = "projectMemory";
pub(crate) const MAX_PROJECT_MEMORY_BYTES: usize = 32 * 1024;

pub(crate) fn normalize_project_path(path: &str) -> Option<String> {
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
pub(crate) fn canonical_project_path(path: &str) -> Option<String> {
    let canonical = std::path::Path::new(path).canonicalize().ok().map(|p| {
        let s = p.to_string_lossy().to_string();
        // Strip Windows extended-length prefix `\\?\X:\...` → `X:\...`
        #[cfg(windows)]
        {
            if let Some(rest) = s.strip_prefix(r"\\?\") {
                if rest.len() >= 3 && rest.as_bytes()[1] == b':' && rest.as_bytes()[2] == b'\\' {
                    return rest.to_string();
                }
            }
        }
        s
    });
    normalize_project_path(canonical.as_deref().unwrap_or(path))
}

pub(crate) fn project_display_name(path: &str) -> String {
    std::path::Path::new(path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("workspace")
        .to_string()
}

/// Upsert a projects row by raw path on any connection (used by live code and
/// the v1 migration alike). Returns None for blank paths.
pub(crate) fn upsert_project_row(conn: &Connection, raw: &str, touch: bool) -> Result<Option<i64>> {
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

impl Database {
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
                // v7 is the oldest in-place migration; back it up like every
                // later step so a failed rewrite never leaves a file with no
                // pre-migration copy.
                let backup = create_migration_backup(&conn, path, 7)?;
                migrate_v7_to_v8(&conn).with_context(|| {
                    format!(
                        "apply schema v7 to v8 migration; backup {} remains",
                        backup.display()
                    )
                })?;
                migrate_v8_to_v15(&conn, path)?;
            }
            8 => {
                migrate_v8_to_v15(&conn, path)?;
            }
            9 => {
                migrate_v9_to_v15(&conn, path)?;
            }
            10 => {
                migrate_v10_to_v15(&conn, path)?;
            }
            11 => {
                migrate_v11_to_v15(&conn, path)?;
            }
            12 => {
                migrate_v12_to_v15(&conn, path)?;
            }
            13 => {
                migrate_v13_to_v15(&conn, path)?;
            }
            14 => {
                migrate_v14_to_v15(&conn, path)?;
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

    pub fn get_project(&self, id: i64) -> Result<Option<ProjectRecord>> {
        let mut stmt = self.conn.prepare_cached(
            "SELECT id, path, name, pinned, created_at, last_opened_at
         FROM projects
         WHERE id = ?1",
        )?;
        stmt.query_row(params![id], |row| {
            Ok(ProjectRecord {
                id: row.get(0)?,
                path: row.get(1)?,
                name: row.get(2)?,
                pinned: row.get(3)?,
                created_at: row.get(4)?,
                last_opened_at: row.get(5)?,
            })
        })
        .optional()
        .map_err(Into::into)
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

    pub fn get_project_memory(&self, path: &str) -> Result<ProjectMemoryRecord> {
        let key = canonical_project_path(path)
            .ok_or_else(|| anyhow!("project path must not be blank"))?;
        let value = self.kv_get(PROJECT_MEMORY_NAMESPACE, &key)?;
        let content = value
            .as_ref()
            .and_then(|item| item.get("content"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let updated_at = value
            .as_ref()
            .and_then(|item| item.get("updatedAt"))
            .and_then(Value::as_i64)
            .unwrap_or_default();
        let entries = value.as_ref().and_then(parse_project_memory_entries);
        Ok(ProjectMemoryRecord {
            content,
            entries,
            updated_at,
        })
    }

    pub fn set_project_memory(&self, path: &str, content: &str) -> Result<ProjectMemoryRecord> {
        let project_path = canonical_project_path(path)
            .ok_or_else(|| anyhow!("project path must not be blank"))?;
        if content.len() > MAX_PROJECT_MEMORY_BYTES {
            return Err(anyhow!(
                "project memory exceeds {MAX_PROJECT_MEMORY_BYTES} bytes"
            ));
        }
        self.ensure_project(&project_path, false)?;
        let updated_at = now_ms();
        self.kv_set(
            PROJECT_MEMORY_NAMESPACE,
            &project_path,
            &serde_json::json!({ "content": content, "updatedAt": updated_at }),
        )?;
        Ok(ProjectMemoryRecord {
            content: content.to_string(),
            entries: None,
            updated_at,
        })
    }

    pub fn set_project_memory_entries(
        &self,
        path: &str,
        raw_entries: &Value,
    ) -> Result<ProjectMemoryRecord> {
        let project_path = canonical_project_path(path)
            .ok_or_else(|| anyhow!("project path must not be blank"))?;
        let entries = normalize_project_memory_entries(raw_entries)?;
        let content = render_project_memory_entries(&entries);
        if content.len() > MAX_PROJECT_MEMORY_BYTES {
            return Err(anyhow!(
                "project memory exceeds {MAX_PROJECT_MEMORY_BYTES} bytes"
            ));
        }
        self.ensure_project(&project_path, false)?;
        let updated_at = now_ms();
        self.kv_set(
            PROJECT_MEMORY_NAMESPACE,
            &project_path,
            &serde_json::json!({
                "format": "entries-v1",
                "content": content,
                "entries": entries,
                "updatedAt": updated_at
            }),
        )?;
        Ok(ProjectMemoryRecord {
            content,
            entries: Some(entries),
            updated_at,
        })
    }
}

pub(crate) fn parse_project_memory_entries(value: &Value) -> Option<Vec<ProjectMemoryEntryRecord>> {
    let entries = value.get("entries")?.as_array()?;
    entries
        .iter()
        .map(|entry| {
            Some(ProjectMemoryEntryRecord {
                id: entry.get("id")?.as_str()?.to_string(),
                title: entry.get("title")?.as_str()?.to_string(),
                content: entry.get("content")?.as_str()?.to_string(),
            })
        })
        .collect()
}

pub(crate) fn normalize_project_memory_entries(
    value: &Value,
) -> Result<Vec<ProjectMemoryEntryRecord>> {
    let entries = value
        .as_array()
        .ok_or_else(|| anyhow!("project memory entries must be an array"))?;
    let mut normalized = Vec::with_capacity(entries.len());
    for entry in entries {
        let id = entry
            .get("id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| anyhow!("project memory entry id required"))?;
        let title = entry
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim();
        let content = entry
            .get("content")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim();
        if content.is_empty() {
            continue;
        }
        normalized.push(ProjectMemoryEntryRecord {
            id: id.to_string(),
            title: title.to_string(),
            content: content.to_string(),
        });
    }
    Ok(normalized)
}

pub(crate) fn render_project_memory_entries(entries: &[ProjectMemoryEntryRecord]) -> String {
    entries
        .iter()
        .map(|entry| {
            if entry.title.is_empty() {
                entry.content.clone()
            } else {
                format!("## {}\n\n{}", entry.title, entry.content)
            }
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}
