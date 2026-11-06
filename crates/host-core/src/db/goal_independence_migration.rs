use super::{create_migration_backup, Connection, Context, Path, Result};

// Composer preferences are not execution authority. Existing turns deliberately
// have no inferred binding: restart recovery pauses their Goals without replay.
pub(super) fn apply(conn: &Connection) -> Result<()> {
    let has_scope = conn
        .prepare("PRAGMA table_info(session_goals)")?
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?
        .iter()
        .any(|column| column == "active_scope_json");
    if !has_scope {
        conn.execute_batch("ALTER TABLE session_goals ADD COLUMN active_scope_json TEXT;")?;
    }
    let has_goal_start = conn
        .prepare("PRAGMA table_info(turn_queue)")?
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?
        .iter()
        .any(|column| column == "goal_start_id");
    if !has_goal_start {
        conn.execute_batch("ALTER TABLE turn_queue ADD COLUMN goal_start_id TEXT;")?;
    }
    conn.execute_batch(
        r#"
DROP TRIGGER IF EXISTS session_goals_mode_fence;
DROP INDEX IF EXISTS session_goals_one_unfinished;
CREATE UNIQUE INDEX session_goals_one_unfinished ON session_goals(session_id)
 WHERE deleted=0 AND (status IN ('active','paused','blocked','budget_exhausted') OR active_turn_id IS NOT NULL);
CREATE TABLE IF NOT EXISTS turn_execution (
 turn_id TEXT PRIMARY KEY REFERENCES turns(id) ON DELETE CASCADE,
 mode TEXT NOT NULL CHECK(mode IN ('agent','plan','goal')),
 goal_claim_id TEXT UNIQUE REFERENCES goal_turns(turn_id),
 provenance TEXT CHECK(provenance IN ('user-goal','goal-continuation')),
 CHECK((goal_claim_id IS NULL AND provenance IS NULL) OR
       (goal_claim_id IS NOT NULL AND provenance IS NOT NULL AND mode='goal'))
);
CREATE TRIGGER IF NOT EXISTS turn_execution_snapshot AFTER INSERT ON turns
BEGIN
 INSERT INTO turn_execution(turn_id,mode)
 SELECT NEW.id,mode FROM sessions WHERE id=NEW.session_id;
END;
"#,
    )?;
    Ok(())
}

pub(super) fn migrate(conn: &Connection, path: &Path) -> Result<()> {
    let backup = create_migration_backup(conn, path, 31)?;
    let tx = conn.unchecked_transaction()?;
    apply(&tx)?;
    tx.pragma_update(None, "user_version", 32i64)?;
    tx.commit().with_context(|| {
        format!(
            "commit schema v31 to v32 Goal execution independence migration; backup {} remains",
            backup.display()
        )
    })?;
    Ok(())
}
