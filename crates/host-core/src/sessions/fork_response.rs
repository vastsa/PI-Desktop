//! Keep a committed fork reachable even when its complete projection is large.
use std::io::{self, Write};

use super::{record_to_ui_for_display, ui_to_record, SessionDetail};

const FULL_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
const WINDOW_MESSAGES: usize = 32;
const DISPLAY_CHARS: usize = 32 * 1024;

struct SizeBudget(usize);
impl Write for SizeBudget {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > self.0 {
            return Err(io::Error::other("fork response needs a display window"));
        }
        self.0 -= bytes.len();
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// The full canonical fork is already durable. Only its immediate UI reply is
/// windowed; future reads and model restoration still use the complete child.
pub(crate) fn for_rpc(mut session: SessionDetail) -> SessionDetail {
    if serde_json::to_writer(&mut SizeBudget(FULL_RESPONSE_BYTES), &session).is_ok() {
        return session;
    }
    let total = session.messages.len();
    let start = total.saturating_sub(WINDOW_MESSAGES);
    let visible = session.messages.split_off(start);
    session.messages = visible
        .into_iter()
        .map(|message| {
            let (record, _) = ui_to_record(&message);
            record_to_ui_for_display(record, DISPLAY_CHARS)
        })
        .collect();
    session.message_start = Some(start as i64);
    session.message_end = Some(total as i64);
    session.has_more_before = Some(start > 0);
    session.has_more_after = Some(false);
    // Checkpoint bodies are model data and can dwarf the visible page. They
    // are reloaded losslessly by the runtime; the fork reply only needs the
    // display divider's identity, time and bounded summary.
    if let Some(checkpoint) = session.compaction.as_mut() {
        checkpoint.summary = checkpoint.summary.chars().take(DISPLAY_CHARS).collect();
        checkpoint.retained_tail = None;
        checkpoint.details = checkpoint.details.as_ref().and_then(|details| {
            details
                .get("generation")
                .map(|generation| serde_json::json!({ "generation": generation }))
        });
    }
    session.compactions = session.compaction.clone().into_iter().collect();
    session.plan_history.clear();
    session.navigation_parent = None;
    session
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{db::Database, sessions};
    use serde_json::json;

    #[test]
    fn a_large_fork_reply_keeps_a_page_and_the_complete_child_remains_durable() {
        let root = tempfile::tempdir().unwrap();
        let db = Database::open(&root.path().join("pi.sqlite")).unwrap();
        let source =
            sessions::create_session(&db, Some("source".into()), None, None, None, None).unwrap();
        let content = "界".repeat(100_000);
        for index in 0..40 {
            let message = serde_json::from_value(json!({
                "id": format!("message-{index}"), "role": "assistant", "content": content,
                "status": "complete", "createdAt": "2026-11-26T00:00:00Z"
            }))
            .unwrap();
            sessions::append_message(&db, &source.id, &message, None).unwrap();
        }
        let sessions::ForkSessionResult::Created(fork) =
            sessions::fork_session_through(&db, &source.id, None, None).unwrap()
        else {
            panic!("expected a fork");
        };
        let child = fork.summary.id.clone();
        let reply = for_rpc(*fork);
        assert_eq!(reply.messages.len(), WINDOW_MESSAGES);
        assert_eq!(reply.message_start, Some(8));
        assert_eq!(reply.has_more_before, Some(true));
        assert!(serde_json::to_vec(&reply).unwrap().len() < FULL_RESPONSE_BYTES);
        let full = sessions::get_session(&db, &child).unwrap().unwrap();
        assert_eq!(full.messages.len(), 40);
        assert_eq!(full.messages[0].content, content);
    }

    #[test]
    fn small_forks_keep_their_complete_legacy_shape() {
        let root = tempfile::tempdir().unwrap();
        let db = Database::open(&root.path().join("pi.sqlite")).unwrap();
        let source = sessions::create_session(&db, None, None, None, None, None).unwrap();
        let detail = sessions::get_session(&db, &source.id).unwrap().unwrap();
        let before = serde_json::to_value(&detail).unwrap();
        assert_eq!(serde_json::to_value(for_rpc(detail)).unwrap(), before);
    }
}
