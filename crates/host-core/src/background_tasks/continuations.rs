//! Host-lifetime continuation intents. Pending results remain in the original
//! job registry, bounded independently from ordinary finished-job history.
use super::*;
use crate::state::AppState;
use rusqlite::OptionalExtension;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ContinuationState {
    Pending,
    Started,
    Consumed,
    Cancelled,
    Failed,
}

#[derive(Debug)]
pub struct Continuation {
    pub source_turn_id: String,
    pub state: ContinuationState,
}

pub fn enabled(st: &AppState) -> Result<bool, String> {
    Ok(st
        .db
        .get_setting("app")
        .map_err(|e| e.to_string())?
        .and_then(|v| {
            v.get("backgroundJobContinuationEnabled")
                .and_then(serde_json::Value::as_bool)
        })
        == Some(true))
}

pub fn turn_status(
    st: &AppState,
    session_id: &str,
    turn_id: &str,
) -> Result<Option<String>, String> {
    st.db
        .conn()
        .query_row(
            "SELECT status FROM turns WHERE id = ?1 AND session_id = ?2",
            rusqlite::params![turn_id, session_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())
}

pub fn agent_session(st: &AppState, session_id: &str) -> Result<bool, String> {
    let mode: Option<String> = st
        .db
        .conn()
        .query_row(
            "SELECT mode FROM sessions WHERE id = ?1",
            [session_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(mode.as_deref() == Some("agent"))
}

pub fn authorize_registration(
    st: &AppState,
    session_id: &str,
    turn_id: &str,
) -> Result<(), (String, String)> {
    let internal = |e| ("INTERNAL".to_owned(), e);
    if !enabled(st).map_err(internal)? || !agent_session(st, session_id).map_err(internal)? {
        return Err((
            "PERMISSION_DENIED".into(),
            "Background completion continuation is disabled in settings; use TaskWait instead"
                .into(),
        ));
    }
    if turn_status(st, session_id, turn_id)
        .map_err(internal)?
        .as_deref()
        != Some("running")
    {
        return Err((
            "TOOL_ABORTED".into(),
            "The originating turn is no longer running".into(),
        ));
    }
    if st
        .background_tasks
        .continuations
        .values()
        .filter(|entry| entry.state == ContinuationState::Pending)
        .count()
        >= 64
    {
        return Err((
            "TOOL_FAILED".into(),
            "Too many pending background continuations; wait for or cancel an existing one".into(),
        ));
    }
    Ok(())
}

impl BackgroundTaskRegistry {
    pub fn cancel_continuations(
        &mut self,
        session_id: Option<&str>,
        source_turn: Option<&str>,
        id: Option<&str>,
    ) {
        let mut changed = false;
        for (job_id, entry) in &mut self.continuations {
            if entry.state != ContinuationState::Pending
                || id.is_some_and(|id| id != job_id)
                || source_turn.is_some_and(|turn| turn != entry.source_turn_id)
                || session_id.is_some_and(|session| {
                    self.tasks
                        .get(job_id)
                        .is_none_or(|task| task.session_id != session)
                })
            {
                continue;
            }
            entry.state = ContinuationState::Cancelled;
            changed = true;
        }
        if changed {
            bump_change_counter();
        }
    }
}
