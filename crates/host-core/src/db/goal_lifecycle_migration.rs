use super::{create_migration_backup, Connection, Context, Path, Result};

// v30 retains removed goals/claims and records millisecond active-time
// checkpoints. Legacy rows start at zero; offline time is never reconstructed.
pub(super) fn apply(conn: &Connection) -> Result<()> {
    let columns = conn
        .prepare("PRAGMA table_info(session_goals)")?
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (name, ddl) in [
        ("deleted", "ALTER TABLE session_goals ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN (0,1))"),
        ("elapsed_ms", "ALTER TABLE session_goals ADD COLUMN elapsed_ms INTEGER NOT NULL DEFAULT 0 CHECK(typeof(elapsed_ms)='integer' AND elapsed_ms BETWEEN 0 AND 9007199254740991)"),
        ("active_since_ms", "ALTER TABLE session_goals ADD COLUMN active_since_ms INTEGER CHECK(active_since_ms IS NULL OR (typeof(active_since_ms)='integer' AND active_since_ms BETWEEN 0 AND 9007199254740991))"),
    ] {
        // Some older migration fixtures rewind only user_version.
        if !columns.iter().any(|column| column == name) { conn.execute_batch(ddl)?; }
    }
    conn.execute_batch(
        r#"
DROP TRIGGER IF EXISTS session_goals_mode_fence;
CREATE TRIGGER session_goals_mode_fence AFTER UPDATE OF mode ON sessions
WHEN NEW.mode != 'goal'
BEGIN
  UPDATE session_goals SET status='paused', revision=revision+1,
    stop_reason='session_mode_changed',
    elapsed_ms=min(9007199254740991,elapsed_ms+CASE WHEN active_since_ms IS NULL THEN 0
      ELSE max(0,goal_now_ms()-active_since_ms) END),
    active_since_ms=NULL
    WHERE session_id=NEW.id AND status='active';
END;
"#,
    )?;
    Ok(())
}

pub(super) fn migrate(conn: &Connection, path: &Path) -> Result<()> {
    let backup = create_migration_backup(conn, path, 29)?;
    let tx = conn.unchecked_transaction()?;
    apply(&tx)?;
    tx.pragma_update(None, "user_version", 30i64)?;
    tx.commit().with_context(|| {
        format!(
            "commit schema v29 to v30 goal lifecycle migration; backup {} remains",
            backup.display()
        )
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        db::{migration_backup_path, Database, SCHEMA_VERSION},
        goals, sessions,
    };
    use serde_json::json;

    #[test]
    fn goals_extension_v29_upgrade_backs_up_original_rows_and_defaults_timers() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("v29.sqlite");
        let db = Database::open(&path).unwrap();
        let session =
            sessions::create_session(&db, None, Some("goal".into()), None, None, None).unwrap();
        let g = goals::start(
            &db,
            serde_json::from_value(
                json!({"sessionId":session.id,"objective":"legacy exact scope"}),
            )
            .unwrap(),
        )
        .unwrap();
        goals::claim_turn(&db, serde_json::from_value(json!({"sessionId":session.id,"goalId":g.id,"expectedRevision":1,"turnId":"v29-claim"})).unwrap()).unwrap();
        // Build the actual v29 shape, not merely a rewound version stamp.
        db.conn()
            .execute_batch(
                "DROP TRIGGER session_goals_mode_fence;
            ALTER TABLE session_goals DROP COLUMN active_since_ms;
            ALTER TABLE session_goals DROP COLUMN elapsed_ms;
            ALTER TABLE session_goals DROP COLUMN deleted;
            PRAGMA user_version=29;",
            )
            .unwrap();
        db.conn()
            .execute_batch(super::super::goals_migration::SCHEMA)
            .unwrap();
        drop(db);
        let db = Database::open(&path).unwrap();
        assert_eq!(
            db.conn()
                .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            SCHEMA_VERSION
        );
        let read = goals::get(&db, &session.id).unwrap().unwrap();
        assert_eq!(read.objective, "legacy exact scope");
        assert_eq!(read.rounds_started, 1);
        assert_eq!(read.token_usage, 0);
        assert_eq!(read.status, goals::GoalStatus::Paused);
        assert_eq!(read.elapsed_ms, 0);
        assert!(read.active_since_ms.is_none() && !read.deleted);
        let backup_path = migration_backup_path(&path, 29);
        let backup = Connection::open(&backup_path).unwrap();
        assert_eq!(
            backup
                .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            29
        );
        let original: (String, i64, String) = backup
            .query_row(
                "SELECT status,revision,active_turn_id FROM session_goals WHERE id=?1",
                [&g.id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(original, ("active".into(), 2, "v29-claim".into()));
        assert!(backup
            .prepare("SELECT elapsed_ms FROM session_goals")
            .is_err());
        assert_eq!(
            backup
                .query_row(
                    "SELECT settled FROM goal_turns WHERE turn_id='v29-claim'",
                    [],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
            0
        );
        drop(backup);
        let bytes = std::fs::read(&backup_path).unwrap();
        drop(db);
        let db = Database::open(&path).unwrap();
        assert_eq!(std::fs::read(&backup_path).unwrap(), bytes);
        assert!(goals::get(&db, &session.id)
            .unwrap()
            .unwrap()
            .active_since_ms
            .is_none());
    }

    #[test]
    fn goals_extension_fresh_schema_guards_timer_counters() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("fresh.sqlite")).unwrap();
        let session =
            sessions::create_session(&db, None, Some("goal".into()), None, None, None).unwrap();
        let g = goals::start(
            &db,
            serde_json::from_value(json!({"sessionId":session.id,"objective":"fresh"})).unwrap(),
        )
        .unwrap();
        for field in ["elapsed_ms", "active_since_ms"] {
            for invalid in ["-1", "9007199254740992", "0.5", "'bad'"] {
                assert!(db
                    .conn()
                    .execute(
                        &format!("UPDATE session_goals SET {field}={invalid} WHERE id=?1"),
                        [&g.id]
                    )
                    .is_err());
            }
        }
        assert!(!migration_backup_path(&dir.path().join("fresh.sqlite"), 29).exists());
    }
}
