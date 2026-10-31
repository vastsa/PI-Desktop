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
