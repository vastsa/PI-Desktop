use super::{create_migration_backup, Connection, Context, Path, Result};
use rusqlite::Transaction;

fn migrate_v22_to_v23_tx(tx: &Transaction<'_>) -> Result<()> {
    let has_title_source: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('sessions') WHERE name = 'title_source')",
        [],
        |row| row.get(0),
    )?;
    if !has_title_source {
        tx.execute_batch(
            "ALTER TABLE sessions ADD COLUMN title_source TEXT NOT NULL DEFAULT 'legacy'
             CHECK (title_source IN ('legacy', 'default', 'manual', 'generated'));",
        )?;
        // Historical v22 sessions lack provenance metadata to distinguish an
        // untouched default placeholder from a deliberate manual rename to the
        // same text (e.g. `new task`). All pre-existing titles remain `legacy`,
        // safely protecting them from automatic replacement by first-prompt
        // title derivation or title plugins. Newly created sessions after
        // upgrade set `default` or `manual` as appropriate.
    }
    tx.pragma_update(None, "user_version", 23i64)?;
    Ok(())
}

pub(crate) fn migrate_v22_to_v23(conn: &Connection, path: &Path) -> Result<()> {
    let backup = create_migration_backup(conn, path, 22)?;
    let tx = conn.unchecked_transaction()?;
    migrate_v22_to_v23_tx(&tx)?;
    tx.commit().with_context(|| {
        format!(
            "commit schema v22 to v23 migration; backup {} remains",
            backup.display()
        )
    })?;
    Ok(())
}
