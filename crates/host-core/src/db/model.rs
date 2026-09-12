use super::*;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRecord {
    pub id: i64,
    pub path: String,
    pub name: String,
    pub pinned: bool,
    pub created_at: i64,
    pub last_opened_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMemoryRecord {
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entries: Option<Vec<ProjectMemoryEntryRecord>>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMemoryEntryRecord {
    pub id: String,
    pub title: String,
    pub content: String,
}

pub struct Database {
    pub(crate) conn: Connection,
    /// App data directory (the sqlite file's parent); transcript files live
    /// under `<data_dir>/sessions/` (D119).
    pub(crate) data_dir: std::path::PathBuf,
}

pub(crate) struct PlanWorkRow {
    pub(crate) proposal_id: String,
    pub(crate) session_id: String,
    pub(crate) turn_id: String,
    pub(crate) tool_call_id: String,
    pub(crate) execution_id: Option<String>,
    pub(crate) status: String,
    pub(crate) execution_state: Option<String>,
}
