use super::{create_migration_backup, Connection, Context, Path, Result};
use rusqlite::Transaction;

/// v25 stores the per-session `/fast` switch (ADR 0334). Every existing
/// session keeps the default service tier.
fn migrate_v24_to_v25_tx(tx: &Transaction<'_>) -> Result<()> {
    let has_fast_mode: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('sessions') WHERE name = 'fast_mode')",
        [],
        |row| row.get(0),
    )?;
    if !has_fast_mode {
        tx.execute_batch(
            "ALTER TABLE sessions ADD COLUMN fast_mode INTEGER NOT NULL DEFAULT 0
             CHECK (fast_mode IN (0, 1));",
        )?;
    }
    tx.pragma_update(None, "user_version", 25i64)?;
    Ok(())
}

pub(crate) fn migrate_v24_to_v25(conn: &Connection, path: &Path) -> Result<()> {
    let backup = create_migration_backup(conn, path, 24)?;
    let tx = conn.unchecked_transaction()?;
    migrate_v24_to_v25_tx(&tx)?;
    tx.commit().with_context(|| {
        format!(
            "commit schema v24 to v25 migration; backup {} remains",
            backup.display()
        )
    })?;
    Ok(())
}
