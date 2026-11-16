use super::{anyhow, create_migration_backup, Connection, Context, Path, Result};
use rusqlite::Transaction;

/// Add model evidence without changing any legacy value or immutable snapshot.
/// SQLite cannot ALTER a CHECK: widening wait_reason requires a lossless table
/// rebuild. Fresh initialization shares this exact schema transformation.
pub(super) fn initialize(tx: &Transaction<'_>) -> Result<()> {
    let has_report: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('mode_runs') WHERE name='completion_report_json')",
        [],
        |row| row.get(0),
    )?;
    if !has_report {
        tx.execute_batch("ALTER TABLE mode_runs ADD COLUMN completion_report_json TEXT;")?;
    }
    let sql: String = tx.query_row(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='mode_runs'",
        [],
        |row| row.get(0),
    )?;
    if sql.contains("'blocked'") {
        return Ok(());
    }
    let old = "wait_reason IN ('approval', 'retries', 'turn_end', 'error')";
    if !sql.contains(old) {
        return Err(anyhow!("unrecognized mode_runs wait_reason constraint"));
    }
    // Keep all existing columns/checks (including elapsed accounting) and
    // optional pre-existing report data, rather than reconstructing run rows.
    let widened = sql
        .replace(
            old,
            "wait_reason IN ('approval', 'retries', 'turn_end', 'error', 'blocked')",
        )
        .replacen("mode_runs", "mode_runs_v31", 1);
    let objects = tx.prepare(
        "SELECT sql FROM sqlite_master WHERE tbl_name='mode_runs' AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type,name",
    )?.query_map([], |row| row.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
    tx.execute_batch(&widened)?;
    tx.execute_batch(
        "INSERT INTO mode_runs_v31 SELECT * FROM mode_runs;
         DROP TABLE mode_runs;
         ALTER TABLE mode_runs_v31 RENAME TO mode_runs;",
    )?;
    for object in objects {
        tx.execute_batch(&object)?;
    }
    if tx.prepare("PRAGMA foreign_key_check")?.exists([])? {
        return Err(anyhow!(
            "foreign key check failed during completion report migration"
        ));
    }
    Ok(())
}

pub(super) fn migrate(conn: &Connection, path: &Path) -> Result<()> {
    let backup = create_migration_backup(conn, path, 30)?;
    // Disable cascades only during the transactional table replacement. Child
    // gate rows keep their original ids, evidence and foreign-key definition.
    let foreign_keys: bool = conn.pragma_query_value(None, "foreign_keys", |row| row.get(0))?;
    conn.pragma_update(None, "foreign_keys", false)?;
    let result = (|| {
        let tx = conn.unchecked_transaction()?;
        initialize(&tx)?;
        tx.pragma_update(None, "user_version", 31i64)?;
        tx.commit().with_context(|| {
            format!(
                "commit schema v30 to v31 completion report migration; backup {} remains",
                backup.display()
            )
        })
    })();
    conn.pragma_update(None, "foreign_keys", foreign_keys)
        .context("restore foreign keys after completion report migration")?;
    result
}
