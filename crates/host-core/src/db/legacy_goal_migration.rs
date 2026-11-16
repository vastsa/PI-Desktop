use super::{anyhow, create_migration_backup, Connection, Context, Path, Result};

/// Retire the withdrawn independent Goal writer without deleting its history.
/// That candidate also used version 32, so version alone cannot prove that
/// either the sessions mode CHECK or its turn snapshot trigger was repaired.
pub(super) fn migrate(conn: &Connection, path: &Path) -> Result<()> {
    let backup = create_migration_backup(conn, path, 32)?;
    super::schema_rebuild::with_table_rebuild(conn, || {
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch("DROP TRIGGER IF EXISTS turn_execution_snapshot;")?;
        super::session_mode_migration::widen_session_modes(&tx)?;
        if tx.prepare("PRAGMA foreign_key_check")?.exists([])? {
            return Err(anyhow!(
                "foreign key check failed during legacy Goal migration"
            ));
        }
        tx.pragma_update(None, "user_version", 33i64)?;
        tx.commit().with_context(|| {
            format!(
                "commit schema v32 to v33 legacy Goal migration; backup {} remains",
                backup.display()
            )
        })
    })
}
