use rusqlite::Transaction;

use super::{create_migration_backup, Connection, Context, Path, Result};

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS pending_completion_notifications (
    id            TEXT PRIMARY KEY,
    session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    session_title TEXT NOT NULL,
    turn_id       TEXT NOT NULL UNIQUE REFERENCES turns(id),
    created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pending_completion_notifications_created
    ON pending_completion_notifications(created_at DESC, id DESC);
";

pub(super) fn initialize(tx: &Transaction<'_>) -> Result<()> {
    tx.execute_batch(SCHEMA)?;
    Ok(())
}

pub(super) fn migrate(conn: &Connection, path: &Path) -> Result<()> {
    let backup = create_migration_backup(conn, path, 33)?;
    let tx = conn.unchecked_transaction()?;
    initialize(&tx)?;
    // Only unread completion history is evidence of an unseen result. The
    // pending record deliberately has no dependency on the bounded inbox row.
    tx.execute_batch(
        "INSERT INTO pending_completion_notifications
            (id, session_id, session_title, turn_id, created_at)
         SELECT n.id, n.session_id, n.session_title, n.turn_id, n.created_at
         FROM notifications n
         JOIN turns t ON t.id = n.turn_id AND t.session_id = n.session_id
         JOIN sessions s ON s.id = n.session_id
         WHERE n.kind = 'task.completed' AND n.read_at IS NULL
         ON CONFLICT DO NOTHING;",
    )?;
    tx.pragma_update(None, "user_version", 34i64)?;
    tx.commit().with_context(|| {
        format!(
            "commit schema v33 to v34 pending completion migration; backup {} remains",
            backup.display()
        )
    })
}
