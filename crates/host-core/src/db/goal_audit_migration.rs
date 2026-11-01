use super::{create_migration_backup, Connection, Context, Path, Result};

// v29 gates nullable unlimited budgets and versioned model-reported audits.
// SQL NULL is a legacy report without an audit; never fabricate old evidence.
pub(crate) const ADD_AUDIT: &str = "ALTER TABLE session_goals ADD COLUMN audit_json TEXT";

// Guard raw lifecycle SQL (restart and mode fences) as well as repository
// writes: unlimited budgets still use safe wire counters, never floating-point
// SQLite overflow or an unsafe JS integer.
pub(crate) const COUNTER_GUARDS: &str = r#"
CREATE TRIGGER IF NOT EXISTS session_goals_safe_insert BEFORE INSERT ON session_goals
WHEN NEW.revision NOT BETWEEN 1 AND 9007199254740991
  OR NEW.rounds_started NOT BETWEEN 0 AND 9007199254740991
  OR NEW.token_usage NOT BETWEEN 0 AND 9007199254740991
BEGIN SELECT RAISE(ABORT, 'GOAL_COUNTER_OVERFLOW'); END;
CREATE TRIGGER IF NOT EXISTS session_goals_safe_update BEFORE UPDATE ON session_goals
WHEN NEW.revision NOT BETWEEN 1 AND 9007199254740991
  OR NEW.rounds_started NOT BETWEEN 0 AND 9007199254740991
  OR NEW.token_usage NOT BETWEEN 0 AND 9007199254740991
BEGIN SELECT RAISE(ABORT, 'GOAL_COUNTER_OVERFLOW'); END;
"#;

pub(super) fn migrate(conn: &Connection, path: &Path) -> Result<()> {
    let backup = create_migration_backup(conn, path, 28)?;
    let tx = conn.unchecked_transaction()?;
    // Older migration fixtures can retain additive columns when rewinding the
    // version. Real v28 databases have no audit column.
    let present = tx
        .prepare("PRAGMA table_info(session_goals)")?
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?
        .iter()
        .any(|name| name == "audit_json");
    if !present {
        tx.execute_batch(ADD_AUDIT)?;
    }
    tx.execute_batch(COUNTER_GUARDS)?;
    tx.pragma_update(None, "user_version", 29i64)?;
    tx.commit().with_context(|| {
        format!(
            "commit schema v28 to v29 goal audit migration; backup {} remains",
            backup.display()
        )
    })?;
    Ok(())
}
