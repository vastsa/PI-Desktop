use super::*;

const AUDIT_RETENTION_MS: i64 = 90 * 24 * 3600 * 1000;
const TASK_RUNS_KEEP: i64 = 100;

impl Database {
    pub(crate) fn boot_maintenance(&self) -> Result<()> {
        let now = now_ms();
        let _ = self.conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_turns_ended_at ON turns(ended_at DESC)",
            [],
        );
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
        let mut stmt = self
            .conn
            .prepare("SELECT id, path FROM projects WHERE path LIKE '//?/%'")?;
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
}

// ---- legacy database reset ----------------------------------------------

/// Breaking reset for pre-v7 files (D119): transcript content moved out of
/// SQLite and old schemas get no data migration. The file (WAL folded back in
/// by the caller) is archived next to itself for manual recovery; `-wal` /
/// `-shm` leftovers are removed so the fresh database starts clean.
pub(crate) fn archive_legacy_db(path: &Path, version: i64) -> Result<()> {
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

pub(crate) fn migrate_and_validate_top_level_mode(
    value: &mut Value,
    key: &str,
    context: &str,
) -> Result<()> {
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

pub(crate) fn validate_session_modes(tx: &rusqlite::Transaction<'_>) -> Result<()> {
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

pub(crate) fn migrate_app_settings(
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

pub(crate) fn migrate_v7_to_v8(conn: &Connection) -> Result<()> {
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

/// v14 adds the plugin session ownership sidecar and hides soft-deleted
/// plugin sessions from the normal session catalog. Existing sessions remain
/// live and have a null deletion timestamp.
fn migrate_v13_to_v14_tx(tx: &rusqlite::Transaction<'_>) -> Result<()> {
    let has_deleted_at: bool = tx.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM pragma_table_info('sessions') WHERE name = 'deleted_at'
        )",
        [],
        |row| row.get(0),
    )?;
    if !has_deleted_at {
        tx.execute_batch("ALTER TABLE sessions ADD COLUMN deleted_at INTEGER;")?;
    }
    tx.execute_batch(
        r#"
        CREATE INDEX IF NOT EXISTS idx_sessions_deleted
          ON sessions(deleted_at) WHERE deleted_at IS NOT NULL;
        CREATE TABLE IF NOT EXISTS session_import_origins (
          plugin_id    TEXT NOT NULL,
          source_id    TEXT NOT NULL,
          external_id  TEXT NOT NULL,
          session_id   TEXT NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
          source_label TEXT,
          origin_json  TEXT,
          created_at   INTEGER NOT NULL,
          UNIQUE(plugin_id, source_id, external_id)
        );
        CREATE INDEX IF NOT EXISTS idx_session_import_origins_plugin
          ON session_import_origins(plugin_id, source_id, created_at DESC);
        "#,
    )?;
    tx.pragma_update(None, "user_version", 14i64)?;
    Ok(())
}

/// v15 persists the Host-owned turn queue (D375 / ADR 0213). Queued prompts
/// used to live in renderer memory; the table lets a restart restore them in
/// order, held until a controller attaches.
pub(crate) fn migrate_v14_to_v15_tx(tx: &rusqlite::Transaction<'_>) -> Result<()> {
    tx.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS turn_queue (
          id               TEXT PRIMARY KEY,
          session_id       TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          principal        TEXT NOT NULL,
          idempotency_key  TEXT,
          input_hash       TEXT NOT NULL,
          content          TEXT NOT NULL,
          attachments_json TEXT,
          permission_mode  TEXT NOT NULL,
          position         INTEGER NOT NULL,
          created_at       INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_turn_queue_session
          ON turn_queue(session_id, position);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_turn_queue_idempotency
          ON turn_queue(session_id, principal, idempotency_key)
          WHERE idempotency_key IS NOT NULL;
        "#,
    )?;
    tx.pragma_update(None, "user_version", 15i64)?;
    Ok(())
}

pub(crate) fn migration_backup_path(path: &Path, version: i64) -> PathBuf {
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

pub(crate) fn create_migration_backup(
    conn: &Connection,
    path: &Path,
    version: i64,
) -> Result<PathBuf> {
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

pub(crate) fn migrate_v8_to_v15(conn: &Connection, path: &Path) -> Result<()> {
    let backup = create_migration_backup(conn, path, 8)?;
    let tx = conn.unchecked_transaction()?;
    migrate_v8_to_v9_tx(&tx)?;
    migrate_v9_to_v10_tx(&tx)?;
    migrate_v10_to_v11_tx(&tx)?;
    migrate_v11_to_v12_tx(&tx)?;
    migrate_v12_to_v13_tx(&tx)?;
    migrate_v13_to_v14_tx(&tx)?;
    migrate_v14_to_v15_tx(&tx)?;
    tx.commit().with_context(|| {
        format!(
            "commit schema v8 to v15 migration; backup {} remains",
            backup.display()
        )
    })?;
    Ok(())
}

pub(crate) fn migrate_v9_to_v15(conn: &Connection, path: &Path) -> Result<()> {
    let backup = create_migration_backup(conn, path, 9)?;
    let tx = conn.unchecked_transaction()?;
    migrate_v9_to_v10_tx(&tx)?;
    migrate_v10_to_v11_tx(&tx)?;
    migrate_v11_to_v12_tx(&tx)?;
    migrate_v12_to_v13_tx(&tx)?;
    migrate_v13_to_v14_tx(&tx)?;
    migrate_v14_to_v15_tx(&tx)?;
    tx.commit().with_context(|| {
        format!(
            "commit schema v9 to v15 migration; backup {} remains",
            backup.display()
        )
    })?;
    Ok(())
}

pub(crate) fn migrate_v10_to_v15(conn: &Connection, path: &Path) -> Result<()> {
    let backup = create_migration_backup(conn, path, 10)?;
    let tx = conn.unchecked_transaction()?;
    migrate_v10_to_v11_tx(&tx)?;
    migrate_v11_to_v12_tx(&tx)?;
    migrate_v12_to_v13_tx(&tx)?;
    migrate_v13_to_v14_tx(&tx)?;
    migrate_v14_to_v15_tx(&tx)?;
    tx.commit().with_context(|| {
        format!(
            "commit schema v10 to v15 migration; backup {} remains",
            backup.display()
        )
    })?;
    Ok(())
}

pub(crate) fn migrate_v11_to_v15(conn: &Connection, path: &Path) -> Result<()> {
    let backup = create_migration_backup(conn, path, 11)?;
    let tx = conn.unchecked_transaction()?;
    migrate_v11_to_v12_tx(&tx)?;
    migrate_v12_to_v13_tx(&tx)?;
    migrate_v13_to_v14_tx(&tx)?;
    migrate_v14_to_v15_tx(&tx)?;
    tx.commit().with_context(|| {
        format!(
            "commit schema v11 to v15 migration; backup {} remains",
            backup.display()
        )
    })?;
    Ok(())
}

pub(crate) fn migrate_v12_to_v15(conn: &Connection, path: &Path) -> Result<()> {
    let backup = create_migration_backup(conn, path, 12)?;
    let tx = conn.unchecked_transaction()?;
    migrate_v12_to_v13_tx(&tx)?;
    migrate_v13_to_v14_tx(&tx)?;
    migrate_v14_to_v15_tx(&tx)?;
    tx.commit().with_context(|| {
        format!(
            "commit schema v12 to v15 migration; backup {} remains",
            backup.display()
        )
    })?;
    Ok(())
}

pub(crate) fn migrate_v13_to_v15(conn: &Connection, path: &Path) -> Result<()> {
    let backup = create_migration_backup(conn, path, 13)?;
    let tx = conn.unchecked_transaction()?;
    migrate_v13_to_v14_tx(&tx)?;
    migrate_v14_to_v15_tx(&tx)?;
    tx.commit().with_context(|| {
        format!(
            "commit schema v13 to v15 migration; backup {} remains",
            backup.display()
        )
    })?;
    Ok(())
}

pub(crate) fn migrate_v14_to_v15(conn: &Connection, path: &Path) -> Result<()> {
    let backup = create_migration_backup(conn, path, 14)?;
    let tx = conn.unchecked_transaction()?;
    migrate_v14_to_v15_tx(&tx)?;
    tx.commit().with_context(|| {
        format!(
            "commit schema v14 to v15 migration; backup {} remains",
            backup.display()
        )
    })?;
    Ok(())
}
