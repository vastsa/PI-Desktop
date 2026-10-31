use super::{create_migration_backup, Connection, Context, Path, Result};

/// v25 → v26 marks the storage-private lossless tool-image envelope. No table
/// changes or transcript conversion happen at startup. Earlier applications
/// refuse this version before they can interpret encoded transcript records.
pub(super) fn migrate(conn: &Connection, path: &Path) -> Result<()> {
    let backup = create_migration_backup(conn, path, 25)?;
    let tx = conn.unchecked_transaction()?;
    tx.pragma_update(None, "user_version", 26i64)?;
    tx.commit().with_context(|| {
        format!(
            "commit schema v25 to v26 storage migration; backup {} remains",
            backup.display()
        )
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::db::*;
    use rusqlite::types::Value as SqlValue;

    fn version(conn: &Connection) -> i64 {
        conn.query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap()
    }

    fn legacy_database(path: &Path) {
        let db = Database::open(path).unwrap();
        db.conn().execute_batch("INSERT INTO kv(ns,key,value_json,updated_at) VALUES ('fixture','config','{\"exact\":true}',1);
            INSERT INTO providers(id,name,config_json,created_at,updated_at) VALUES ('fixture','Saved provider','{\"baseUrl\":\"https://example.test\"}',1,1);
            INSERT INTO models(provider_id,model_id,display_name,source,updated_at) VALUES ('fixture','saved-model','Saved model','user',1);
            INSERT INTO sessions(id,title,title_source,provider_id,model_id,last_seq,created_at,updated_at) VALUES ('fixture-session','Saved session','manual','fixture','saved-model',1,1,1);
            INSERT INTO turns(id,session_id,status,started_at,ended_at) VALUES ('fixture-turn','fixture-session','completed',1,2);
            INSERT INTO messages(id,session_id,turn_id,seq,role,text,created_at) VALUES ('fixture-message','fixture-session','fixture-turn',0,'user','Saved searchable text',1);
            PRAGMA user_version=25;").unwrap();
    }

    fn rows(conn: &Connection, table: &str) -> Vec<Vec<SqlValue>> {
        // The test controls every table name; values remain SQLite-owned data.
        let mut statement = conn
            .prepare(&format!("SELECT * FROM {table} ORDER BY 1"))
            .unwrap();
        let columns = statement.column_count();
        statement
            .query_map([], |row| {
                (0..columns).map(|column| row.get(column)).collect()
            })
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    }

    #[test]
    fn schema_25_upgrades_only_the_version_and_keeps_legacy_files_and_backup() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pi.sqlite");
        legacy_database(&path);
        let before = Connection::open(&path).unwrap();
        let tables = [
            "kv",
            "providers",
            "models",
            "sessions",
            "messages",
            "turns",
            "message_revisions",
            "sqlite_master",
        ];
        let snapshots: Vec<_> = tables.iter().map(|table| rows(&before, table)).collect();
        drop(before);
        let files = [
            crate::transcripts::transcript_path(dir.path(), "fixture-session").unwrap(),
            crate::transcripts::revisions_path(dir.path(), "fixture-session").unwrap(),
            crate::transcripts::inflight_path(dir.path(), "fixture-session").unwrap(),
        ];
        for file in &files {
            std::fs::create_dir_all(file.parent().unwrap()).unwrap();
            std::fs::write(file, b"legacy bytes are not rewritten on database open\n").unwrap();
        }
        let db = Database::open(&path).unwrap();
        assert_eq!(version(db.conn()), 27);
        let backup_path = migration_backup_path(&path, 25);
        let backup = Connection::open(&backup_path).unwrap();
        assert_eq!(version(&backup), 25);
        for (table, snapshot) in tables.iter().zip(&snapshots) {
            assert_eq!(&rows(db.conn(), table), snapshot, "live {table}");
            assert_eq!(&rows(&backup, table), snapshot, "backup {table}");
        }
        for file in &files {
            assert_eq!(
                std::fs::read(file).unwrap(),
                b"legacy bytes are not rewritten on database open\n"
            );
        }
        drop(backup);
        drop(db);
        let original_backup = std::fs::read(&backup_path).unwrap();
        let db = Database::open(&path).unwrap();
        assert_eq!(version(db.conn()), 27);
        assert_eq!(
            std::fs::read(backup_path).unwrap(),
            original_backup,
            "reopening must not replace the schema-25 backup"
        );
    }

    #[test]
    fn fresh_database_uses_27_and_future_28_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pi.sqlite");
        let db = Database::open(&path).unwrap();
        assert_eq!(version(db.conn()), 27);
        db.conn().pragma_update(None, "user_version", 28).unwrap();
        drop(db);
        let error = Database::open(&path)
            .err()
            .expect("future schema must be refused");
        assert!(error.to_string().contains("28 is newer than supported 27"));
        assert_eq!(version(&Connection::open(path).unwrap()), 28);
    }

    #[test]
    fn schema_24_chains_through_25_and_its_original_model_migration_stays_single_step() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pi.sqlite");
        legacy_database(&path);
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "ALTER TABLE models DROP COLUMN discovery_state; PRAGMA user_version=24;",
        )
        .unwrap();
        super::super::model_discovery_migration::migrate(&conn, &path).unwrap();
        assert_eq!(
            version(&conn),
            25,
            "the model migration still produces schema 25"
        );
        drop(conn);
        // Recreate the old version to exercise Database::open's complete chain.
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "ALTER TABLE models DROP COLUMN discovery_state; PRAGMA user_version=24;",
        )
        .unwrap();
        drop(conn);
        let db = Database::open(&path).unwrap();
        assert_eq!(version(db.conn()), 27);
        for schema in [24, 25] {
            let backup = Connection::open(migration_backup_path(&path, schema)).unwrap();
            assert_eq!(version(&backup), schema);
        }
        assert_eq!(rows(db.conn(), "messages").len(), 1);
    }
    #[test]
    fn failed_version_stamp_keeps_schema_25_and_its_readable_backup() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pi.sqlite");
        legacy_database(&path);
        let conn = Connection::open(&path).unwrap();
        let original = rows(&conn, "messages");
        conn.pragma_update(None, "query_only", true).unwrap();
        let error = super::migrate(&conn, &path).unwrap_err();
        assert!(error.to_string().contains("readonly"), "{error:#}");
        assert_eq!(version(&conn), 25);
        assert_eq!(rows(&conn, "messages"), original);
        let backup = Connection::open(migration_backup_path(&path, 25)).unwrap();
        assert_eq!(version(&backup), 25);
        assert_eq!(rows(&backup, "messages"), original);
        let integrity: String = backup
            .query_row("PRAGMA integrity_check", [], |row| row.get(0))
            .unwrap();
        assert_eq!(integrity, "ok");
        drop(backup);
        // The failed transaction releases its lock so the same DB can retry.
        conn.pragma_update(None, "query_only", false).unwrap();
        super::migrate(&conn, &path).unwrap();
        assert_eq!(version(&conn), 26);
    }
}
