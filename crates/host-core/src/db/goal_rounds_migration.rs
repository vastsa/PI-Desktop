use super::{create_migration_backup, Connection, Context, Path, Result};

pub(super) fn apply(conn: &Connection) -> Result<()> {
    let exists = conn
        .prepare("PRAGMA table_info(session_goals)")?
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?
        .iter()
        .any(|c| c == "rounds_completed");
    if !exists {
        conn.execute_batch("ALTER TABLE session_goals ADD COLUMN rounds_completed INTEGER NOT NULL DEFAULT 0 CHECK(rounds_completed BETWEEN 0 AND 9007199254740991);
        UPDATE session_goals SET rounds_completed=(SELECT count(*) FROM goal_turns c
          JOIN turn_execution e ON e.goal_claim_id=c.turn_id JOIN turns t ON t.id=e.turn_id
          WHERE c.goal_id=session_goals.id AND t.session_id=session_goals.session_id
          AND c.settled=1 AND c.interrupted=0 AND c.tokens IS NOT NULL AND t.status='completed');")?;
    }
    Ok(())
}
pub(super) fn migrate(conn: &Connection, path: &Path) -> Result<()> {
    let backup = create_migration_backup(conn, path, 32)?;
    let tx = conn.unchecked_transaction()?;
    apply(&tx)?;
    tx.pragma_update(None, "user_version", 33i64)?;
    tx.commit().with_context(|| {
        format!(
            "commit schema v32 to v33 completed Goal rounds; backup {} remains",
            backup.display()
        )
    })?;
    Ok(())
}
