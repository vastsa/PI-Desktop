use super::*;
use std::collections::BTreeMap;

pub(super) fn migrate(conn: &Connection, path: &Path, from: i64) -> Result<()> {
    let backup = create_migration_backup(conn, path, from)?;
    let tx = conn.unchecked_transaction()?;
    reconcile_project_paths(conn, None)?;
    tx.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    tx.commit().with_context(|| {
        format!(
            "commit project path migration; backup {} remains",
            backup.display()
        )
    })
}

/// Resolve actual filesystem identities, not a platform-wide lowercase guess:
/// Windows directories and macOS volumes can both be case-sensitive.
pub(super) fn reconcile_project_paths(conn: &Connection, target: Option<&str>) -> Result<()> {
    let rows = conn
        .prepare(
            "SELECT id, path FROM projects
         ORDER BY EXISTS(SELECT 1 FROM sessions s WHERE s.project_id=projects.id) DESC,
                  last_opened_at DESC, id ASC",
        )?
        .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    // Most lists contain no aliases. Avoid filesystem probes of unrelated or
    // unavailable roots on every project-group/tool-context read.
    let mut spellings = BTreeMap::<String, usize>::new();
    for (_, path) in &rows {
        if let Some(path) = normalize_project_path(path) {
            *spellings.entry(path.to_uppercase()).or_default() += 1;
        }
    }
    let mut groups = BTreeMap::<String, Vec<(i64, String)>>::new();
    for (id, path) in rows {
        if path.starts_with(REMOTE_PROJECT_PREFIX) {
            continue;
        }
        let Some(normalized) = normalize_project_path(&path) else {
            continue;
        };
        if target.is_none()
            && normalized == path
            && spellings.get(&normalized.to_uppercase()) == Some(&1)
        {
            continue;
        }
        if target.is_some_and(|target| normalized.to_uppercase() != target.to_uppercase()) {
            continue;
        }
        if let Some(canonical) = canonical_project_path(&path) {
            // A retargeted symlink must not redirect an old project's ownership.
            if normalized.to_uppercase() != canonical.to_uppercase() {
                continue;
            }
            if target.is_none_or(|target| target == canonical) {
                groups.entry(canonical).or_default().push((id, path));
            }
        }
    }
    let groups: Vec<_> = groups
        .into_iter()
        .filter(|(path, rows)| rows.len() > 1 || rows[0].1 != *path)
        .collect();
    if groups.is_empty() {
        return Ok(());
    }
    // Session import can already own a transaction on this connection.
    conn.execute_batch("SAVEPOINT reconcile_project_paths")?;
    let result = (|| -> Result<()> {
        for (canonical, rows) in groups {
            let keep = rows[0].0;
            for (id, old_path) in &rows {
                // Keep both original memory records if they conflict. A missing
                // canonical record inherits the survivor's memory without loss.
                conn.execute(
                    "INSERT OR IGNORE INTO kv(ns,key,value_json,updated_at)
                 SELECT ns,?1,value_json,updated_at FROM kv WHERE ns='projectMemory' AND key=?2",
                    params![canonical, old_path],
                )?;
                if *id == keep {
                    continue;
                }
                conn.execute(
                    "UPDATE sessions SET project_id=?1 WHERE project_id=?2",
                    params![keep, id],
                )?;
                conn.execute(
                    "UPDATE scheduled_tasks SET project_id=?1 WHERE project_id=?2",
                    params![keep, id],
                )?;
                conn.execute(
                "UPDATE projects SET pinned=MAX(pinned,(SELECT pinned FROM projects WHERE id=?2)),
                 created_at=MIN(created_at,(SELECT created_at FROM projects WHERE id=?2)),
                 last_opened_at=MAX(last_opened_at,(SELECT last_opened_at FROM projects WHERE id=?2)),
                 worktree_setup_command=COALESCE(worktree_setup_command,(SELECT worktree_setup_command FROM projects WHERE id=?2))
                 WHERE id=?1", params![keep, id],
            )?;
                conn.execute(
                "UPDATE kv SET value_json=?1 WHERE ns='app' AND key='currentProjectId' AND value_json=?2",
                params![keep.to_string(), id.to_string()],
            )?;
                conn.execute("DELETE FROM projects WHERE id=?1", params![id])?;
            }
            conn.execute(
                "UPDATE projects SET path=?1 WHERE id=?2",
                params![canonical, keep],
            )?;
        }
        conn.execute_batch("RELEASE reconcile_project_paths")?;
        Ok(())
    })();
    if let Err(error) = result {
        conn.execute_batch("ROLLBACK TO reconcile_project_paths; RELEASE reconcile_project_paths")
            .context("roll back project path repair")?;
        return Err(error);
    }
    Ok(())
}

impl Database {
    /// A destructive operation must prefer the selected stored row. Resolving
    /// symlinks/case first can silently select a different historical row.
    pub(crate) fn stored_project_path(&self, raw: &str) -> Result<Option<String>> {
        let Some(path) = normalize_project_path(raw) else {
            return Ok(None);
        };
        let target = canonical_project_path(raw);
        if let Some(target) = target.as_deref() {
            reconcile_project_paths(&self.conn, Some(target))?;
        }
        let exact = self
            .conn
            .query_row(
                "SELECT path FROM projects WHERE path=?1",
                params![path],
                |r| r.get::<_, String>(0),
            )
            .optional()?;
        Ok(exact.or_else(|| canonical_project_path(raw)))
    }
}
