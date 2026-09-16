use super::*;

pub(super) fn migrate(conn: &Connection, path: &Path) -> Result<()> {
    create_migration_backup(conn, path, 15)?;
    let tx = conn.unchecked_transaction()?;
    tx.execute_batch(crate::session_collaboration::SCHEMA)?;
    let has_column: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('turn_queue') WHERE name = 'session_message_id')",
        [],
        |row| row.get(0),
    )?;
    if !has_column {
        tx.execute_batch("ALTER TABLE turn_queue ADD COLUMN session_message_id TEXT;")?;
    }
    // A v15 file walks the later steps in the same launch (plugin providers
    // then the turn-queue priority block), so this step only stamps its own
    // version.
    tx.pragma_update(None, "user_version", 16)?;
    tx.commit()
        .context("commit session collaboration migration")?;
    Ok(())
}
