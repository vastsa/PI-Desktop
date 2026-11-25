use super::{create_migration_backup, Connection, Context, Path, Result};

/// Existing discovered rows establish past publication, not binding provenance.
/// User-owned rows remain unknown. No saved configuration is changed.
pub(crate) fn migrate(conn: &Connection, path: &Path) -> Result<()> {
    let backup = create_migration_backup(conn, path, 24)?;
    let tx = conn.unchecked_transaction()?;
    let has_column: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('models') WHERE name = 'discovery_state')",
        [],
        |row| row.get(0),
    )?;
    if !has_column {
        tx.execute_batch(
            "ALTER TABLE models ADD COLUMN discovery_state TEXT
            CHECK (discovery_state IN ('published', 'unlisted'));
            UPDATE models SET discovery_state = 'published' WHERE source = 'discovered';",
        )?;
    }
    tx.pragma_update(None, "user_version", 25i64)?;
    tx.commit().with_context(|| {
        format!(
            "commit schema v24 to v25 migration; backup {} remains",
            backup.display()
        )
    })?;
    Ok(())
}

pub(crate) fn migrate_reported_context_window(conn: &Connection, path: &Path) -> Result<()> {
    let backup = create_migration_backup(conn, path, 33)?;
    let tx = conn.unchecked_transaction()?;
    let has_column: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('models') WHERE name = 'reported_context_window')",
        [],
        |row| row.get(0),
    )?;
    if !has_column {
        // The previous cache could contain enriched defaults, so leave provenance unknown.
        tx.execute_batch("ALTER TABLE models ADD COLUMN reported_context_window INTEGER;")?;
    }
    tx.pragma_update(None, "user_version", 34i64)?;
    tx.commit().with_context(|| {
        format!(
            "commit schema v33 to v34 migration; backup {} remains",
            backup.display()
        )
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::db::{Database, SCHEMA_VERSION};

    #[test]
    fn upgrade_keeps_cached_capacity_without_inventing_its_provenance() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pi.sqlite");
        let db = Database::open(&path).unwrap();
        db.conn().execute_batch(
            "ALTER TABLE models DROP COLUMN reported_context_window;
             INSERT INTO providers(id, name, vendor_key, type, protocol, auth_kind, created_at, updated_at)
             VALUES ('relay', 'Relay', 'custom', 'openai_compatible', 'openai_compatible', 'none', 0, 0);
             INSERT INTO models(provider_id, model_id, display_name, source, context_window, discovery_state, updated_at)
             VALUES ('relay', 'model', 'Model', 'discovered', 500000, 'published', 0);
             PRAGMA user_version = 33;",
        ).unwrap();
        drop(db);

        let upgraded = Database::open(&path).unwrap();
        let version: i64 = upgraded
            .conn()
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
        let rows = crate::providers::list_models(&upgraded, Some("relay")).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].context_window, Some(500_000));
        assert_eq!(rows[0].reported_context_window, None);
        assert!(super::super::migration_backup_path(&path, 33).is_file());
    }
}
