use crate::db::{canonical_project_path, now_ms, Database};
use anyhow::Result;

fn bound_tasks(db: &Database, path: &str) -> Result<Vec<super::ScheduledTask>> {
    let path = canonical_project_path(path);
    Ok(super::list_tasks(db)?
        .into_iter()
        .filter(|task| {
            path.is_some()
                && task
                    .workspace_path
                    .as_deref()
                    .and_then(canonical_project_path)
                    == path
        })
        .collect())
}

/// Admission owns a task before its session has opened a turn.
pub fn has_running_tasks(db: &Database, path: &str) -> Result<bool> {
    for task in bound_tasks(db, path)? {
        if super::automation::running(db, &task.id)? {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Keep definitions and history, but require explicit user action to run again.
pub fn pause(db: &Database, path: &str) -> Result<()> {
    let tasks = bound_tasks(db, path)?;
    let transaction = db.conn().unchecked_transaction()?;
    for task in tasks {
        transaction.execute(
            "UPDATE scheduled_tasks SET enabled = 0, updated_at = ?1 WHERE id = ?2",
            rusqlite::params![now_ms(), task.id],
        )?;
    }
    transaction.commit()?;
    Ok(())
}
