use super::*;

#[test]
fn project_memory_is_path_scoped_and_bounded() {
    let dir = tempfile::tempdir().unwrap();
    let first = dir.path().join("first");
    let second = dir.path().join("second");
    std::fs::create_dir_all(&first).unwrap();
    std::fs::create_dir_all(&second).unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();

    assert_eq!(
        db.get_project_memory(first.to_str().unwrap())
            .unwrap()
            .content,
        ""
    );
    let saved = db
        .set_project_memory(first.to_str().unwrap(), "Keep the API stable.")
        .unwrap();
    assert_eq!(saved.content, "Keep the API stable.");
    assert!(saved.updated_at > 0);
    assert_eq!(
        db.get_project_memory(&format!("{}/", first.to_string_lossy()))
            .unwrap()
            .content,
        "Keep the API stable."
    );
    assert_eq!(
        db.get_project_memory(second.to_str().unwrap())
            .unwrap()
            .content,
        ""
    );
    let structured = serde_json::json!([
        {
            "id": "api",
            "title": "API",
            "content": "Keep the API stable."
        },
        {
            "id": "blank",
            "title": "Ignored",
            "content": "  "
        }
    ]);
    let structured_saved = db
        .set_project_memory_entries(first.to_str().unwrap(), &structured)
        .unwrap();
    assert_eq!(structured_saved.content, "## API\n\nKeep the API stable.");
    assert_eq!(structured_saved.entries.as_ref().unwrap().len(), 1);
    assert_eq!(
        db.get_project_memory(first.to_str().unwrap())
            .unwrap()
            .entries
            .unwrap()[0]
            .title,
        "API"
    );
    let oversized = "x".repeat(MAX_PROJECT_MEMORY_BYTES + 1);
    assert!(db
        .set_project_memory(first.to_str().unwrap(), &oversized)
        .is_err());
    assert_eq!(
        db.get_project_memory(first.to_str().unwrap())
            .unwrap()
            .content,
        "## API\n\nKeep the API stable."
    );
}

fn table_exists(conn: &Connection, name: &str) -> bool {
    conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
        params![name],
        |r| r.get::<_, i64>(0),
    )
    .map(|n| n > 0)
    .unwrap_or(false)
}

#[test]
fn v14_database_migrates_to_v15_with_the_turn_queue() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pi.sqlite");
    {
        let db = Database::open(&path).unwrap();
        db.conn()
            .execute_batch(
                "DROP INDEX idx_turn_queue_idempotency;
                     DROP INDEX idx_turn_queue_session;
                     DROP TABLE turn_queue;",
            )
            .unwrap();
        db.conn().pragma_update(None, "user_version", 14).unwrap();
    }
    let db = Database::open(&path).unwrap();
    assert_eq!(schema_version(db.conn()), SCHEMA_VERSION);
    assert!(table_exists(db.conn(), "turn_queue"));
    assert!(migration_backup_path(&path, 14).exists());
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
        "session_import_origins",
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
fn migrates_v13_plugin_session_schema() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pi.sqlite");
    {
        let db = Database::open(&path).unwrap();
        db.conn()
            .execute(
                "INSERT INTO sessions (id, created_at, updated_at)
                     VALUES ('existing-core', 1, 1)",
                [],
            )
            .unwrap();
        db.conn()
            .execute_batch(
                "DROP TABLE session_import_origins;
                     DROP INDEX idx_sessions_deleted;
                     ALTER TABLE sessions DROP COLUMN deleted_at;",
            )
            .unwrap();
        db.conn().pragma_update(None, "user_version", 13).unwrap();
    }

    let db = Database::open(&path).unwrap();
    assert_eq!(schema_version(db.conn()), SCHEMA_VERSION);
    assert!(table_exists(db.conn(), "session_import_origins"));
    assert_eq!(
        db.conn()
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('sessions')
                     WHERE name = 'deleted_at'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
        1
    );
    assert_eq!(
        db.conn()
            .query_row(
                "SELECT deleted_at FROM sessions WHERE id = 'existing-core'",
                [],
                |row| row.get::<_, Option<i64>>(0),
            )
            .unwrap(),
        None
    );
    assert_readable_migration_backup(&path, 13);
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
        migrate_and_validate_top_level_mode(&mut invalid, "defaultMode", "app settings").is_err()
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
