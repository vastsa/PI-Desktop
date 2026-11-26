use crate::{db::Database, sessions};
use anyhow::{anyhow, Result};

pub(super) fn effective_mode(db: &Database, session_id: &str) -> Result<String> {
    let mode = sessions::session_permission_mode(db, session_id)?
        .ok_or_else(|| anyhow!("NOT_FOUND: session {session_id}"))?;
    if mode != "inherit" {
        return Ok(mode);
    }
    let settings = db.get_setting("app")?;
    Ok(sessions::global_permission_mode(settings.as_ref()).to_owned())
}

pub(super) fn check_target(db: &Database, session_id: &str, ceiling: &str) -> Result<()> {
    fn rank(mode: &str) -> u8 {
        match mode {
            "auto" => 2,
            "accept-edits" => 1,
            _ => 0,
        }
    }
    if rank(&effective_mode(db, session_id)?) > rank(ceiling) {
        return Err(anyhow!(
            "PERMISSION_DENIED: target permission mode exceeds the sending session's authorization"
        ));
    }
    if sessions::session_mode(db, session_id)?.as_deref() != Some("agent") {
        return Err(anyhow!(
            "PERMISSION_DENIED: session communication requires Agent mode"
        ));
    }
    Ok(())
}
