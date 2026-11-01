use super::{create_migration_backup, Connection, Context, Path, Result};

// Deferred owner intent survives restart without authorizing another turn.
pub(super) fn apply(conn: &Connection) -> Result<()> {
    let columns = conn
        .prepare("PRAGMA table_info(session_goals)")?
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (name, ddl) in [
        ("pause_requested", "ALTER TABLE session_goals ADD COLUMN pause_requested INTEGER NOT NULL DEFAULT 0 CHECK(pause_requested IN (0,1))"),
        ("pending_budget_json", "ALTER TABLE session_goals ADD COLUMN pending_budget_json TEXT"),
    ] {
        // Rewound-version fixtures may already carry additive columns.
        if !columns.iter().any(|column| column == name) {
            conn.execute_batch(ddl)?;
        }
    }
    conn.execute_batch(
        r#"
DROP TRIGGER IF EXISTS session_goals_mode_fence;
CREATE TRIGGER session_goals_mode_fence AFTER UPDATE OF mode ON sessions
WHEN NEW.mode != 'goal'
BEGIN
  UPDATE session_goals SET status='paused', revision=revision+1,
    stop_reason='session_mode_changed', pause_requested=0,
    elapsed_ms=min(9007199254740991,elapsed_ms+CASE WHEN active_since_ms IS NULL THEN 0
      ELSE max(0,goal_now_ms()-active_since_ms) END),
    active_since_ms=NULL
    WHERE session_id=NEW.id AND status='active';
END;
"#,
    )?;
    Ok(())
}

pub(super) fn migrate(conn: &Connection, path: &Path) -> Result<()> {
    let backup = create_migration_backup(conn, path, 30)?;
    let tx = conn.unchecked_transaction()?;
    apply(&tx)?;
    tx.pragma_update(None, "user_version", 31i64)?;
    tx.commit().with_context(|| {
        format!(
            "commit schema v30 to v31 goal refinement migration; backup {} remains",
            backup.display()
        )
    })?;
    Ok(())
}

#[cfg(test)]
#[path = "goal_refinement_migration_tests.rs"]
mod tests;
