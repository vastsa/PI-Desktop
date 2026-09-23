use anyhow::{anyhow, Result};
use rusqlite::{params, OptionalExtension};
use std::collections::HashMap;

use super::repository;
use crate::{db::Database, sessions::UiMessage, transcripts};

/// The ledger supplies provenance even when a runtime forgets the metadata.
/// Conversely, a caller cannot attach provenance to arbitrary transcript text.
pub fn prepare_append(
    db: &Database,
    session_id: &str,
    input: &UiMessage,
    turn_id: Option<&str>,
) -> Result<UiMessage> {
    if let Some(received) = super::current_turn::prepare_append(db, session_id, input, turn_id)? {
        return Ok(received);
    }
    let delivery = match turn_id {
        Some(turn) => db
            .conn()
            .prepare_cached(&format!("{} WHERE turn_id=?1", repository::SELECT))?
            .query_row(params![turn], repository::row)
            .optional()?,
        None => None,
    };
    let mut message = input.clone();
    if message.role == "user" && message.parent_tool_call_id.is_none() {
        if let Some(delivery) = delivery {
            // A steering input is additional human input to an already-claimed
            // delivery turn, not the delivery itself: it must land in the same
            // session but is exempt from the delivery's content/attachment
            // contract and must not inherit the delivery's agent origin.
            if message.steering == Some(true) {
                if delivery.target_session_id != session_id {
                    return Err(anyhow!(
                        "PERMISSION_DENIED: steering input does not target its delivery session"
                    ));
                }
                // Extra human input must not inherit or smuggle agent origin.
                message.session_message = None;
                return Ok(message);
            }
            if delivery.target_session_id != session_id
                || delivery.content != message.content
                || message
                    .attachments
                    .as_ref()
                    .is_some_and(|items| !items.is_empty())
            {
                return Err(anyhow!(
                    "PERMISSION_DENIED: transcript input does not match its session delivery"
                ));
            }
            message.session_message = Some(repository::origin(&delivery));
            return Ok(message);
        }
    }
    if message.session_message.is_some() {
        return Err(anyhow!(
            "PERMISSION_DENIED: session message provenance requires its owning turn"
        ));
    }
    Ok(message)
}

/// Rewrites may retain or remove a branch, but cannot turn agent input into
/// human input by stripping its origin or reuse its identity with new content.
pub fn validate_replacement(db: &Database, session_id: &str, messages: &[UiMessage]) -> Result<()> {
    let originals: HashMap<_, _> = transcripts::read_transcript(db.data_dir(), session_id)?
        .into_iter()
        .filter(|record| {
            record
                .meta
                .as_ref()
                .is_some_and(|meta| meta.get("sessionMessage").is_some())
        })
        .map(|record| {
            let message = crate::sessions::record_to_ui(record);
            (message.id.clone(), message)
        })
        .collect();
    for message in messages {
        match originals.get(&message.id) {
            Some(original)
                if original.role != message.role
                    || original.content != message.content
                    || original.session_message != message.session_message =>
            {
                return Err(anyhow!(
                    "PERMISSION_DENIED: session message provenance is immutable"
                ));
            }
            None if message.session_message.is_some() => {
                return Err(anyhow!(
                    "PERMISSION_DENIED: cannot forge a session message during transcript rewrite"
                ));
            }
            _ => {}
        }
    }
    Ok(())
}
