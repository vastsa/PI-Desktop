use super::*;

/// Preserve the display form of plugin references in durable queued prompts.
pub(super) fn migrate(conn: &Connection, path: &Path) -> Result<()> {
    create_migration_backup(conn, path, 19)?;
    let tx = conn.unchecked_transaction()?;
    let exists: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('turn_queue') WHERE name = 'composer_display_json')",
        [],
        |row| row.get(0),
    )?;
    if !exists {
        tx.execute_batch("ALTER TABLE turn_queue ADD COLUMN composer_display_json TEXT;")?;
    }
    tx.pragma_update(None, "user_version", 20)?;
    tx.commit()
        .context("commit composer reference display migration")?;
    Ok(())
}
