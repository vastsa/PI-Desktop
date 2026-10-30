use super::{create_migration_backup, Connection, Context, Path, Result};

pub(crate) const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS session_goals (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK(revision > 0),
  status TEXT NOT NULL CHECK(status IN ('active','paused','blocked','completed','budget_exhausted','cancelled')),
  objective TEXT NOT NULL,
  criteria_json TEXT NOT NULL,
  progress_summary TEXT NOT NULL,
  rounds_started INTEGER NOT NULL CHECK(rounds_started >= 0),
  token_usage INTEGER NOT NULL CHECK(token_usage >= 0),
  budget_json TEXT NOT NULL,
  active_turn_id TEXT UNIQUE,
  stop_reason TEXT,
  outcomes_json TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS session_goals_one_unfinished ON session_goals(session_id)
  WHERE status IN ('active','paused','blocked','budget_exhausted') OR active_turn_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS session_goals_session ON session_goals(session_id);
CREATE TABLE IF NOT EXISTS goal_turns (
  turn_id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES session_goals(id) ON DELETE CASCADE,
  settled INTEGER NOT NULL DEFAULT 0 CHECK(settled IN (0,1)),
  interrupted INTEGER NOT NULL DEFAULT 0 CHECK(interrupted IN (0,1)),
  tokens INTEGER CHECK(tokens >= 0)
);
CREATE INDEX IF NOT EXISTS goal_turns_goal ON goal_turns(goal_id);
-- All host mutation paths fence the autonomous run with the mode switch.
-- Keep the claim until its runtime settles; never replay it.
CREATE TRIGGER IF NOT EXISTS session_goals_mode_fence AFTER UPDATE OF mode ON sessions
WHEN NEW.mode != 'goal'
BEGIN
  UPDATE session_goals SET status = 'paused', revision = revision + 1,
    stop_reason = 'session_mode_changed'
    WHERE session_id = NEW.id AND status = 'active';
END;
"#;

pub(super) fn migrate(conn: &Connection, path: &Path) -> Result<()> {
    let backup = create_migration_backup(conn, path, 27)?;
    let tx = conn.unchecked_transaction()?;
    tx.execute_batch(SCHEMA)?;
    tx.pragma_update(None, "user_version", 28i64)?;
    tx.commit().with_context(|| {
        format!(
            "commit schema v27 to v28 goal migration; backup {} remains",
            backup.display()
        )
    })?;
    Ok(())
}
