//! User-operated side conversations; no parent execution or delivery relationship.
use super::*;

pub const NAMESPACE: &str = "session:side-question";

#[cfg(test)]
mod tests;

pub fn tool_allowed(db: &Database, id: &str, tool: &str) -> Result<bool> {
    Ok(origin(db, id)?.is_none() || matches!(tool, "Read" | "Glob" | "Grep"))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SideQuestionOrigin {
    pub parent_session_id: String,
    pub parent_title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub through_message_id: Option<String>,
    pub anchor_label: String,
    pub inherited_message_count: i64,
    pub archived: bool,
}

#[derive(Serialize)]
pub struct SideQuestionList {
    pub sessions: Vec<SessionSummary>,
    pub total: i64,
}

pub fn origin(db: &Database, id: &str) -> Result<Option<SideQuestionOrigin>> {
    let raw: Option<String> = db
        .conn()
        .query_row(
            "SELECT value_json FROM kv WHERE ns = ?1 AND key = ?2",
            params![NAMESPACE, id],
            |row| row.get(0),
        )
        .optional()?;
    raw.map(|raw| serde_json::from_str(&raw).map_err(Into::into))
        .transpose()
}

pub fn create(
    db: &Database,
    parent_id: &str,
    title: Option<&str>,
    reference_only: bool,
) -> Result<ForkSessionResult> {
    super::fork::fork_side_question(db, parent_id, title, reference_only)
}

pub fn list(
    db: &Database,
    parent_id: &str,
    query: &str,
    archived: bool,
    limit: i64,
    offset: i64,
) -> Result<SideQuestionList> {
    let query: String = query.trim().chars().take(256).collect();
    let pattern = format!(
        "%{}%",
        query
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_")
    );
    let base = format!("{SUMMARY_SELECT}
        AND s.id IN (SELECT key FROM kv WHERE ns = 'session:side-question'
            AND json_extract(value_json, '$.parentSessionId') = ?1
            AND json_extract(value_json, '$.archived') = ?2)
        AND (?3 = '' OR s.title LIKE ?4 ESCAPE '\\' OR EXISTS (
            SELECT 1 FROM messages m WHERE m.session_id = s.id
            AND m.seq >= json_extract((SELECT value_json FROM kv WHERE ns = 'session:side-question' AND key = s.id), '$.inheritedMessageCount')
            AND m.text LIKE ?4 ESCAPE '\\'))");
    let total = db.conn().query_row(
        &format!("SELECT COUNT(*) FROM ({base})"),
        params![parent_id, archived, query, pattern],
        |row| row.get(0),
    )?;
    let sql = format!("{base} ORDER BY s.updated_at DESC, s.id DESC LIMIT ?5 OFFSET ?6");
    let mut statement = db.conn().prepare_cached(&sql)?;
    let sessions = statement
        .query_map(
            params![
                parent_id,
                archived,
                query,
                pattern,
                limit.clamp(1, 100),
                offset.max(0)
            ],
            summary_from_row,
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(SideQuestionList { sessions, total })
}

pub fn archive(db: &Database, id: &str, archived: bool) -> Result<bool> {
    let Some(mut value) = origin(db, id)? else {
        return Ok(false);
    };
    value.archived = archived;
    db.conn().execute(
        "UPDATE kv SET value_json = ?1, updated_at = ?4 WHERE ns = ?2 AND key = ?3",
        params![serde_json::to_string(&value)?, NAMESPACE, id, now_ms()],
    )?;
    Ok(true)
}
