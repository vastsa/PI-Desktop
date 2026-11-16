use super::{Connection, Context, Result};

/// Keep dependent views, triggers and child FK targets stable during table
/// replacement, then restore both connection settings on every exit path.
pub(super) fn with_table_rebuild(
    conn: &Connection,
    action: impl FnOnce() -> Result<()>,
) -> Result<()> {
    let foreign_keys: bool = conn.pragma_query_value(None, "foreign_keys", |row| row.get(0))?;
    let legacy_alter_table: bool =
        conn.pragma_query_value(None, "legacy_alter_table", |row| row.get(0))?;
    conn.pragma_update(None, "foreign_keys", false)?;
    let result = (|| {
        conn.pragma_update(None, "legacy_alter_table", true)?;
        action()
    })();
    // Attempt both restores even when migration or the other restore fails.
    let restore_alter = conn.pragma_update(None, "legacy_alter_table", legacy_alter_table);
    let restore_keys = conn.pragma_update(None, "foreign_keys", foreign_keys);
    restore_alter.context("restore legacy alter table after schema rebuild")?;
    restore_keys.context("restore foreign keys after schema rebuild")?;
    result
}
