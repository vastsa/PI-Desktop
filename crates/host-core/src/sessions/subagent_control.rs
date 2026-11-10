use anyhow::{anyhow, Result};
use serde_json::Value;

use super::{indexed_message_record, truncate_display_text, MessageRecord, UiMessage};
use crate::db::Database;

// Identity fields keep their producer bounds verbatim: dedup, routing, and
// resume compare them byte for byte, so a clipped handle must never look like
// a different, actionable command.
const MAX_OPERATION_ID_CHARS: usize = 128;
const MAX_HASH_CHARS: usize = 64;
const MAX_ID_CHARS: usize = 200;
const MAX_MODEL_CHARS: usize = 500;
const ACTION_START: &str = "start";
const ACTION_MESSAGE: &str = "message";
const STATUSES: [&str; 7] = [
    "running",
    "completed",
    "failed",
    "denied",
    "stopped",
    "aborted",
    "timed_out",
];

fn invalid() -> anyhow::Error {
    anyhow!("Invalid subagent control metadata")
}

fn bounded_text(value: &str, max: usize) -> bool {
    !value.is_empty() && value.chars().count() <= max && !value.contains('\0')
}

fn valid_operation_id(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    first.is_ascii_alphanumeric()
        && value.chars().count() <= MAX_OPERATION_ID_CHARS
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '-'))
}

impl super::SubagentControlMetadata {
    /// Producer contract for the additive metadata. Only a real, child-owned
    /// user row may carry it; the synthetic `Task` projection stays a renderer
    /// concern and is never accepted here.
    fn is_valid(&self) -> bool {
        let status_ok = self
            .status
            .as_deref()
            .is_none_or(|status| STATUSES.contains(&status));
        let text_ok = |value: &Option<String>, max: usize| {
            value.as_deref().is_none_or(|text| bounded_text(text, max))
        };
        valid_operation_id(&self.operation_id)
            && self.request_hash.chars().count() == MAX_HASH_CHARS
            && self
                .request_hash
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
            && bounded_text(&self.delegation_id, MAX_ID_CHARS)
            && bounded_text(&self.agent, MAX_ID_CHARS)
            && matches!(self.action.as_str(), ACTION_START | ACTION_MESSAGE)
            && status_ok
            && text_ok(&self.model_id, MAX_MODEL_CHARS)
            && text_ok(&self.model_key, MAX_MODEL_CHARS)
            && text_ok(&self.thinking_level, MAX_MODEL_CHARS)
            && text_ok(&self.resume, MAX_ID_CHARS)
            && self
                .description
                .as_deref()
                .is_none_or(|text| !text.contains('\0'))
    }

    fn owner_binding(&self, row: &UiMessage) -> bool {
        if row.role != "user" || row.agent_name.as_deref() != Some(self.agent.as_str()) {
            return false;
        }
        if row.id != format!("user-subagent-{}", self.operation_id) {
            return false;
        }
        match self.action.as_str() {
            // A started operation is its own delegated root: the owner call id
            // is the row id. This is what tells Host and renderer apart from a
            // row that merely lives inside somebody else's subagent.
            ACTION_START => row.parent_tool_call_id.as_deref() == Some(row.id.as_str()),
            // A live direction points at the root it continues.
            ACTION_MESSAGE => row
                .parent_tool_call_id
                .as_deref()
                .is_some_and(|parent| !parent.is_empty()),
            _ => false,
        }
    }
}

pub(super) fn validate(row: &UiMessage) -> Result<()> {
    let Some(control) = &row.subagent_control else {
        return Ok(());
    };
    if !control.is_valid() || !control.owner_binding(row) {
        return Err(invalid());
    }
    Ok(())
}

pub(super) fn record_control(record: &MessageRecord) -> Option<super::SubagentControlMetadata> {
    let stored = record.meta.as_ref()?.get("subagentControl")?.clone();
    serde_json::from_value(stored).ok()
}

fn record_parent(record: &MessageRecord) -> Option<&str> {
    record.meta.as_ref()?.get("parentToolCallId")?.as_str()
}

/// Apply one newer snapshot of a user-created subagent root.
///
/// A root is durable user input, not a model-created `Task` result, so the
/// settlement cannot replace its blocks. Every applied snapshot must keep the
/// original command identity and may only move a still-running root to another
/// running view of the same binding or to a terminal status. A replay after a
/// terminal status, or a snapshot for another operation, is a no-op: it neither
/// overwrites the settled row nor appends a duplicate.
pub(super) fn update_root_snapshot(
    db: &Database,
    session_id: &str,
    incoming: &MessageRecord,
) -> Result<()> {
    if incoming.role != "user" {
        return Ok(());
    }
    let Some(next) = record_control(incoming) else {
        return Ok(());
    };
    if next.action != ACTION_START || !next.is_valid() {
        return Ok(());
    }
    if incoming.id != format!("user-subagent-{}", next.operation_id)
        || record_parent(incoming) != Some(incoming.id.as_str())
    {
        return Ok(());
    }
    let Some(status) = next.status.as_deref().filter(|s| STATUSES.contains(s)) else {
        return Ok(());
    };
    let Some(mut existing) = indexed_message_record(db, session_id, &incoming.id)? else {
        return Ok(());
    };
    if existing.role != "user" {
        return Ok(());
    }
    let Some(stored) = record_control(&existing) else {
        return Ok(());
    };
    if stored.action != ACTION_START
        || stored.operation_id != next.operation_id
        || stored.request_hash != next.request_hash
        || stored.delegation_id != next.delegation_id
        || stored.agent != next.agent
        || record_parent(&existing) != Some(existing.id.as_str())
        || stored.status.as_deref() != Some("running")
    {
        return Ok(());
    }
    let mut patch = vec![("status", Value::String(status.into()))];
    for (key, value) in [
        ("modelId", next.model_id),
        ("modelKey", next.model_key),
        ("thinkingLevel", next.thinking_level),
        ("resume", next.resume),
        ("description", next.description),
    ] {
        if let Some(value) = value {
            patch.push((key, Value::String(value)));
        }
    }
    let Some(control) = existing
        .meta
        .as_mut()
        .and_then(Value::as_object_mut)
        .and_then(|meta| meta.get_mut("subagentControl"))
        .and_then(Value::as_object_mut)
    else {
        return Err(anyhow!(
            "user subagent root is missing its transcript metadata"
        ));
    };
    let mut changed = false;
    for (key, value) in patch {
        if control.get(key) != Some(&value) {
            control.insert(key.into(), value);
            changed = true;
        }
    }
    if !changed {
        return Ok(());
    }
    if !crate::transcripts::update_message(db.data_dir(), session_id, &existing)? {
        return Err(anyhow!(
            "user subagent snapshot is missing from its transcript"
        ));
    }
    Ok(())
}

/// Bound only prose metadata for a renderer page. Command identity, the
/// request hash, delegation/agent routing, and the model binding stay verbatim
/// so a bounded read cannot break dedup, resume, or chain ownership.
pub(super) fn bound_for_display(control: &mut super::SubagentControlMetadata, limit: usize) {
    if let Some(description) = control.description.take() {
        control.description = Some(truncate_display_text(description, limit.max(1)).0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(value: serde_json::Value) -> UiMessage {
        serde_json::from_value(value).unwrap()
    }

    fn root() -> UiMessage {
        row(serde_json::json!({
            "id": "user-subagent-start-1", "role": "user", "content": "Inspect",
            "createdAt": "2026-11-03T00:00:00Z", "parentToolCallId": "user-subagent-start-1",
            "agentName": "explorer",
            "subagentControl": {
                "operationId": "start-1", "requestHash": "a".repeat(64), "action": "start",
                "delegationId": "delegate-1", "agent": "explorer", "status": "running",
            }
        }))
    }

    #[test]
    fn control_metadata_requires_its_child_owned_owner_binding() {
        validate(&root()).unwrap();

        let mut followup = root();
        followup.id = "user-subagent-message-1".into();
        followup.subagent_control.as_mut().unwrap().operation_id = "message-1".into();
        followup.subagent_control.as_mut().unwrap().action = "message".into();
        followup.parent_tool_call_id = Some("user-subagent-start-1".into());
        validate(&followup).unwrap();

        let mut forged = root();
        forged.parent_tool_call_id = Some("call_other".into());
        assert!(validate(&forged).is_err());

        let mut wrong_agent = root();
        wrong_agent.agent_name = Some("reviewer".into());
        assert!(validate(&wrong_agent).is_err());

        let mut wrong_id = root();
        wrong_id.id = "user-subagent-other".into();
        assert!(validate(&wrong_id).is_err());
    }

    #[test]
    fn control_metadata_rejects_unbounded_or_malformed_identity() {
        type Forge = fn(&mut super::super::SubagentControlMetadata);
        let cases: [(&str, Forge); 8] = [
            ("operationId", |c| c.operation_id = "bad id".into()),
            ("operationId length", |c| {
                c.operation_id = format!("a{}", "b".repeat(MAX_OPERATION_ID_CHARS))
            }),
            ("requestHash", |c| c.request_hash = "abc".into()),
            ("non-hex requestHash", |c| {
                c.request_hash = "z".repeat(MAX_HASH_CHARS)
            }),
            ("empty delegationId", |c| c.delegation_id.clear()),
            ("delegationId length", |c| {
                c.delegation_id = "d".repeat(MAX_ID_CHARS + 1)
            }),
            ("agent length", |c| c.agent = "a".repeat(MAX_ID_CHARS + 1)),
            ("status", |c| c.status = Some("unknown".into())),
        ];
        for (name, forge) in cases {
            let mut forged = root();
            forge(forged.subagent_control.as_mut().unwrap());
            assert!(validate(&forged).is_err(), "{name} should be rejected");
        }
    }
}
