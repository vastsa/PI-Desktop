//! ID-only mutations of canonical history. RPC callers hold the Host state lock.
use super::*;

#[cfg(test)]
mod tests;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteMessageResult {
    pub ok: bool,
    pub deleted: bool,
    pub deleted_count: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetractPendingPromptResult {
    pub ok: bool,
    pub retracted: bool,
    pub removed_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<&'static str>,
}

fn not_retracted(reason: &'static str) -> RetractPendingPromptResult {
    RetractPendingPromptResult {
        ok: true,
        retracted: false,
        removed_count: 0,
        reason: Some(reason),
    }
}

fn running_turn(db: &Database, session_id: &str) -> Result<bool> {
    Ok(db.conn().query_row(
        "SELECT EXISTS(SELECT 1 FROM turns WHERE session_id=?1 AND status='running')",
        params![session_id],
        |row| row.get(0),
    )?)
}

fn message_turn(db: &Database, session_id: &str, message_id: &str) -> Result<Option<String>> {
    Ok(db
        .conn()
        .query_row(
            "SELECT turn_id FROM messages WHERE session_id=?1 AND id=?2",
            params![session_id, message_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten())
}

fn canonical_messages(db: &Database, session_id: &str) -> Result<Vec<UiMessage>> {
    get_session(db, session_id)?
        .map(|detail| detail.messages)
        .ok_or_else(|| anyhow!("NOT_FOUND: session not found"))
}

/// Delete one row, or a user prompt and its replies up to the next user row.
/// A missing target is a successful no-op, including retries after a lost reply.
pub fn delete_message(
    db: &Database,
    session_id: &str,
    message_id: &str,
) -> Result<DeleteMessageResult> {
    let mut messages = canonical_messages(db, session_id)?;
    let Some(start) = messages.iter().position(|message| message.id == message_id) else {
        return Ok(DeleteMessageResult {
            ok: true,
            deleted: false,
            deleted_count: 0,
        });
    };
    if running_turn(db, session_id)? {
        return Err(anyhow!(
            "TURN_RUNNING: cannot delete messages during a running turn"
        ));
    }
    let end = if messages[start].role == "user" {
        messages[start + 1..]
            .iter()
            .position(|message| message.role == "user")
            .map_or(messages.len(), |offset| start + 1 + offset)
    } else {
        start + 1
    };
    let inflight = transcripts::read_inflight(db.data_dir(), session_id)?;
    let mut remove_inflight = inflight.as_ref().is_some_and(|checkpoint| {
        messages[start..end]
            .iter()
            .any(|message| message.id == checkpoint.message.id)
    });
    // An unindexed checkpoint belongs to the deleted prompt too, unless a later
    // steering prompt in the same turn survives the selected user-row range.
    if let Some(turn) = inflight
        .as_ref()
        .and_then(|checkpoint| checkpoint.turn_id.as_deref())
    {
        if messages[start].role == "user"
            && message_turn(db, session_id, &messages[start].id)?.as_deref() == Some(turn)
        {
            let mut surviving_user = false;
            for message in messages[..start]
                .iter()
                .chain(&messages[end..])
                .filter(|m| m.role == "user")
            {
                surviving_user |=
                    message_turn(db, session_id, &message.id)?.as_deref() == Some(turn);
            }
            remove_inflight |= !surviving_user;
        }
    }
    let deleted_count = end - start;
    messages.drain(start..end);
    rewrite_transcript(db, session_id, &messages, &[])?;
    if remove_inflight {
        transcripts::remove_inflight(db.data_dir(), session_id)?;
    }
    Ok(DeleteMessageResult {
        ok: true,
        deleted: true,
        deleted_count,
    })
}

fn substantive_reply(message: &UiMessage) -> bool {
    message.role != "assistant"
        || !message.content.trim().is_empty()
        || message
            .thinking
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty())
        || message.tool_name.is_some()
        || message.tool_call_id.is_some()
        || message.tool_args.is_some()
        || message.tool_result.is_some()
        || message.hosted_search.is_some()
}

/// Retract exactly the named last pending prompt after its turn has stopped.
/// Durable attribution and checkpoints are checked before any history is changed.
pub fn retract_pending_prompt(
    db: &Database,
    session_id: &str,
    user_message_id: &str,
    turn_id: Option<&str>,
) -> Result<RetractPendingPromptResult> {
    let messages = canonical_messages(db, session_id)?;
    let Some(start) = messages
        .iter()
        .position(|message| message.id == user_message_id)
    else {
        return Ok(not_retracted("message_not_found"));
    };
    let prompt = &messages[start];
    if prompt.role != "user"
        || messages[start + 1..]
            .iter()
            .any(|message| message.role == "user")
    {
        return Ok(not_retracted("not_final_user_prompt"));
    }
    if prompt.steering == Some(true) {
        return Ok(not_retracted("steering_prompt"));
    }
    if running_turn(db, session_id)? {
        return Ok(not_retracted("turn_running"));
    }
    let Some(owner) = message_turn(db, session_id, user_message_id)? else {
        return Ok(not_retracted("turn_not_found"));
    };
    if turn_id.is_some_and(|expected| expected != owner) {
        return Ok(not_retracted("turn_mismatch"));
    }
    let known: bool = db.conn().query_row(
        "SELECT EXISTS(SELECT 1 FROM turns WHERE session_id=?1 AND id=?2)",
        params![session_id, owner],
        |row| row.get(0),
    )?;
    if !known {
        return Ok(not_retracted("turn_not_found"));
    }
    // Row order disambiguates turns created within the same millisecond.
    let latest: String = db.conn().query_row(
        "SELECT id FROM turns WHERE session_id=?1 ORDER BY rowid DESC LIMIT 1",
        params![session_id],
        |row| row.get(0),
    )?;
    if latest != owner {
        return Ok(not_retracted("turn_mismatch"));
    }
    for message in &messages[start + 1..] {
        if substantive_reply(message) {
            return Ok(not_retracted("reply_started"));
        }
        if message_turn(db, session_id, &message.id)?.as_deref() != Some(owner.as_str()) {
            return Ok(not_retracted("turn_mismatch"));
        }
    }
    let inflight = transcripts::read_inflight(db.data_dir(), session_id)?;
    if let Some(checkpoint) = &inflight {
        if checkpoint.turn_id.as_deref() != Some(owner.as_str()) {
            return Ok(not_retracted("turn_mismatch"));
        }
        if substantive_reply(&record_to_ui(checkpoint.message.clone())) {
            return Ok(not_retracted("reply_started"));
        }
    }
    rewrite_transcript(db, session_id, &messages[..start], &[])?;
    if inflight.is_some() {
        transcripts::remove_inflight(db.data_dir(), session_id)?;
    }
    Ok(RetractPendingPromptResult {
        ok: true,
        retracted: true,
        removed_count: messages.len() - start,
        reason: None,
    })
}

/// Opt-in revision activation that never trusts an uploaded or absent prefix.
/// The legacy activation API keeps its explicit-prefix behavior unchanged.
pub fn activate_message_revision_canonical(
    db: &Database,
    session_id: &str,
    root_user_id: &str,
    revision_index: i64,
) -> Result<Vec<UiMessage>> {
    if running_turn(db, session_id)? {
        return Err(anyhow!(
            "TURN_RUNNING: cannot activate a revision during a running turn"
        ));
    }
    activate_message_revision_with_prefix(db, session_id, root_user_id, revision_index, None)
}
