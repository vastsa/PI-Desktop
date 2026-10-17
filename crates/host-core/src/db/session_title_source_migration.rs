use super::{create_migration_backup, Connection, Context, Path, Result};
use rusqlite::Transaction;

fn migrate_v22_to_v23_tx(tx: &Transaction<'_>) -> Result<()> {
    let has_title_source: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('sessions') WHERE name = 'title_source')",
        [],
        |row| row.get(0),
    )?;
    if !has_title_source {
        tx.execute_batch(
            "ALTER TABLE sessions ADD COLUMN title_source TEXT NOT NULL DEFAULT 'legacy'
             CHECK (title_source IN ('legacy', 'default', 'manual', 'generated'));",
        )?;
        // Older releases stored default and manually-entered titles in the
        // same column. Preserve the distinction where it is observable: only
        // known placeholders remain eligible for automatic replacement; every
        // other pre-existing title is treated as manual. The list mirrors
        // `sessions::PLACEHOLDER_TITLES` and covers the localized
        // `chat.untitledTask` / `nav.newChat` labels the renderer writes.
        tx.execute(
            "UPDATE sessions SET title_source = CASE
                 WHEN title IN ('', 'New task', 'New chat', '新建任务', '新对话',
                                '新建任務', '新對話', '새 작업', '새 채팅',
                                'Tarefa sem título', 'Nova conversa',
                                'Yeni görev', 'Yeni sohbet') THEN 'default'
                 ELSE 'manual'
             END",
            [],
        )?;
    }
    tx.pragma_update(None, "user_version", 23i64)?;
    Ok(())
}

pub(crate) fn migrate_v22_to_v23(conn: &Connection, path: &Path) -> Result<()> {
    let backup = create_migration_backup(conn, path, 22)?;
    let tx = conn.unchecked_transaction()?;
    migrate_v22_to_v23_tx(&tx)?;
    tx.commit().with_context(|| {
        format!(
            "commit schema v22 to v23 migration; backup {} remains",
            backup.display()
        )
    })?;
    Ok(())
}
