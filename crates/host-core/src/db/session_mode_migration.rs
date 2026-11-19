use super::{anyhow, create_migration_backup, Connection, Context, Path, Result};
use regex::Regex;
use rusqlite::Transaction;

/// Existing databases can retain the builtin-only mode CHECK even though the
/// current schema and Host accept validated custom mode ids. Remove only that
/// legacy constraint, preserving the rest of the actual sessions definition.
pub(super) fn widen_session_modes(tx: &Transaction<'_>) -> Result<()> {
    let sql: String = tx.query_row(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='sessions'",
        [],
        |row| row.get(0),
    )?;
    let legacy_check = Regex::new(
        r#"(?i)(?:,\s*)?\bCHECK\s*\(\s*(?:mode|"mode"|`mode`|\[mode\])\s+IN\s*\(\s*'agent'\s*,\s*'plan'\s*,\s*'goal'\s*\)\s*\)"#,
    )?;
    if !legacy_check.is_match(&sql) {
        return Ok(());
    }
    let widened = legacy_check.replace_all(&sql, "");
    let columns_start = widened
        .find('(')
        .ok_or_else(|| anyhow!("unrecognized sessions table definition"))?;
    let create = format!("CREATE TABLE sessions_v32 {}", &widened[columns_start..]);
    let objects = tx
        .prepare("SELECT sql FROM sqlite_master WHERE tbl_name='sessions' AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type,name")?
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    tx.execute_batch(&create)?;
    tx.execute_batch(
        "INSERT INTO sessions_v32 SELECT * FROM sessions;
         DROP TABLE sessions;
         ALTER TABLE sessions_v32 RENAME TO sessions;",
    )?;
    for object in objects {
        tx.execute_batch(&object)?;
    }
    if tx.prepare("PRAGMA foreign_key_check")?.exists([])? {
        return Err(anyhow!(
            "foreign key check failed during session mode migration"
        ));
    }
    Ok(())
}

pub(super) fn migrate(conn: &Connection, path: &Path) -> Result<()> {
    let backup = create_migration_backup(conn, path, 31)?;
    super::schema_rebuild::with_table_rebuild(conn, || {
        let tx = conn.unchecked_transaction()?;
        widen_session_modes(&tx)?;
        tx.pragma_update(None, "user_version", 32i64)?;
        tx.commit().with_context(|| {
            format!(
                "commit schema v31 to v32 session mode migration; backup {} remains",
                backup.display()
            )
        })
    })
}

#[cfg(test)]
#[path = "session_mode_migration_tests.rs"]
mod tests;
