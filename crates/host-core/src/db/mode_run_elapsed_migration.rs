use super::{create_migration_backup, Connection, Context, Path, Result};
use rusqlite::Transaction;

/// Shared by fresh initialization and the additive v29 -> v30 migration.
/// Legacy runs start at zero, never at a duration inferred from created_at.
/// Legacy queued turns do not explicitly request a new Goal run.
pub(super) fn initialize(tx: &Transaction<'_>) -> Result<()> {
    for (table, column, ddl) in [
        (
            "mode_runs",
            "elapsed_ms",
            "ALTER TABLE mode_runs ADD COLUMN elapsed_ms INTEGER NOT NULL DEFAULT 0
             CHECK (elapsed_ms BETWEEN 0 AND 9007199254740991);",
        ),
        (
            "mode_runs",
            "active_since_ms",
            "ALTER TABLE mode_runs ADD COLUMN active_since_ms INTEGER
             CHECK (active_since_ms BETWEEN 0 AND 9007199254740991);",
        ),
        (
            "turn_queue",
            "start_goal",
            "ALTER TABLE turn_queue ADD COLUMN start_goal INTEGER NOT NULL DEFAULT 0
             CHECK (start_goal IN (0, 1));",
        ),
    ] {
        let exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info(?1) WHERE name = ?2)",
            [table, column],
            |row| row.get(0),
        )?;
        if !exists {
            tx.execute_batch(ddl)?;
        }
    }
    Ok(())
}

pub(super) fn migrate(conn: &Connection, path: &Path) -> Result<()> {
    let backup = create_migration_backup(conn, path, 29)?;
    let tx = conn.unchecked_transaction()?;
    initialize(&tx)?;
    tx.pragma_update(None, "user_version", 30i64)?;
    tx.commit().with_context(|| {
        format!(
            "commit schema v29 to v30 mode run elapsed migration; backup {} remains",
            backup.display()
        )
    })?;
    Ok(())
}
