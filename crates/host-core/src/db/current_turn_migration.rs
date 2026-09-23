use super::*;

pub(super) fn migrate(conn: &Connection, path: &Path) -> Result<()> {
    create_migration_backup(conn, path, 19)?;
    let tx = conn.unchecked_transaction()?;
    tx.execute_batch(crate::session_collaboration::CURRENT_TURN_SCHEMA)?;
    tx.pragma_update(None, "user_version", 20)?;
    tx.commit()
        .context("commit current-turn collaboration migration")?;
    Ok(())
}
