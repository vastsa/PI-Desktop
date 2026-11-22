use super::*;
use std::collections::BTreeMap;

pub(super) fn migrate(conn: &Connection, path: &Path, from: i64) -> Result<()> {
    let backup = create_migration_backup(conn, path, from)?;
    let tx = conn.unchecked_transaction()?;
    reconcile_project_paths(conn, None)?;
    // Stamp the version this step produces so the v28 -> v29 step follows.
    tx.pragma_update(None, "user_version", from + 1)?;
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

fn scheduled_task_workspace_paths(conn: &Connection) -> Result<Vec<(String, Option<String>)>> {
    let mut statement = conn.prepare(
        "SELECT id,json_extract(config_json,'$.workspacePath') FROM scheduled_tasks
         WHERE json_extract(config_json,'$.workspacePath') IS NOT NULL",
    )?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Whether the canonical `path` owns chats, scheduled tasks (by project id or
/// bound `workspacePath`), or path-scoped memory. Relocation moves such data
/// only onto a path that owns none of it.
pub(super) fn project_path_owns_data(conn: &Connection, path: &str) -> Result<bool> {
    let project = conn
        .query_row("SELECT id FROM projects WHERE path=?1", [path], |row| {
            row.get::<_, i64>(0)
        })
        .optional()?;
    let bound_task = scheduled_task_workspace_paths(conn)?
        .iter()
        .any(|(_, task)| task.as_deref().and_then(canonical_project_path).as_deref() == Some(path));
    Ok(bound_task
        || conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM kv WHERE ns='projectMemory' AND key=?1)
                OR EXISTS(SELECT 1 FROM sessions WHERE project_id=?2)
                OR EXISTS(SELECT 1 FROM scheduled_tasks WHERE project_id=?2)",
            params![path, project],
            |row| row.get(0),
        )?)
}

/// Move one explicitly selected project to its replacement directory while
/// retaining the project id used by sessions and scheduled tasks. The target
/// may be an empty shadow row created by opening the replacement path first;
/// a target with its own chats, tasks, or memory is never merged implicitly.
pub(super) fn relocate_project_path(conn: &Connection, old: &str, new: &str) -> Result<i64> {
    let source = conn
        .query_row("SELECT id FROM projects WHERE path=?1", [old], |row| {
            row.get::<_, i64>(0)
        })
        .optional()?
        .ok_or_else(|| anyhow!("project to relocate was not found: {old}"))?;
    let target = conn
        .query_row("SELECT id FROM projects WHERE path=?1", [new], |row| {
            row.get::<_, i64>(0)
        })
        .optional()?;
    let task_paths = scheduled_task_workspace_paths(conn)?;
    if project_path_owns_data(conn, new)? {
        return Err(anyhow!(
            "replacement folder belongs to a non-empty project: {new}"
        ));
    }

    conn.execute_batch("SAVEPOINT relocate_project_path")?;
    let result = (|| -> Result<()> {
        if let Some(target) = target {
            conn.execute(
                "UPDATE projects SET pinned=MAX(pinned,(SELECT pinned FROM projects WHERE id=?2)),
                 created_at=MIN(created_at,(SELECT created_at FROM projects WHERE id=?2)),
                 last_opened_at=MAX(last_opened_at,(SELECT last_opened_at FROM projects WHERE id=?2)),
                 worktree_setup_command=COALESCE(worktree_setup_command,(SELECT worktree_setup_command FROM projects WHERE id=?2))
                 WHERE id=?1",
                params![source, target],
            )?;
            conn.execute(
                "UPDATE kv SET value_json=?1 WHERE ns='app' AND key='currentProjectId'
                 AND (value_json=?2 OR value_json=printf('\"%d\"',?2))",
                params![source.to_string(), target],
            )?;
            conn.execute("DELETE FROM projects WHERE id=?1", [target])?;
        }
        for (id, path) in &task_paths {
            if path.as_deref().and_then(canonical_project_path).as_deref() == Some(old) {
                conn.execute(
                    "UPDATE scheduled_tasks SET config_json=json_set(config_json,'$.workspacePath',?1)
                     WHERE id=?2",
                    params![new, id],
                )?;
            }
        }
        conn.execute(
            "UPDATE kv SET key=?1 WHERE ns='projectMemory' AND key=?2",
            params![new, old],
        )?;
        conn.execute(
            "UPDATE projects SET path=?1 WHERE id=?2",
            params![new, source],
        )?;
        conn.execute_batch("RELEASE relocate_project_path")?;
        Ok(())
    })();
    if let Err(error) = result {
        conn.execute_batch("ROLLBACK TO relocate_project_path; RELEASE relocate_project_path")
            .context("roll back explicit project relocation")?;
        return Err(error);
    }
    Ok(source)
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

    /// Id of the project row stored at the given spelling or its canonical
    /// form, without creating one. Lets callers notice an explicit relocation.
    pub(crate) fn project_id_at_path(&self, raw: &str) -> Result<Option<i64>> {
        for path in [normalize_project_path(raw), canonical_project_path(raw)]
            .into_iter()
            .flatten()
        {
            let id = self
                .conn
                .query_row("SELECT id FROM projects WHERE path=?1", [&path], |r| {
                    r.get::<_, i64>(0)
                })
                .optional()?;
            if id.is_some() {
                return Ok(id);
            }
        }
        Ok(None)
    }
}
