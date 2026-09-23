use serde_json::Value;
use std::time::{Duration, Instant};
use uuid::Uuid;

use super::{grants, PermissionGeneration};

pub const MAX_OUTSTANDING_PERMITS: usize = 256;

/// A process-local admission for exactly one desktop-dispatched tool call.
/// The desktop runner must consume this before executing any side effects.
pub struct ExecutionPermit {
    pub token: String,
    pub session_id: String,
    pub turn_id: Option<String>,
    pub tool_call_id: String,
    pub tool_name: String,
    pub argument_fingerprint: String,
    pub generation: PermissionGeneration,
    pub scope_fingerprint: String,
    pub actor_id: String,
    pub requires_grant: bool,
    pub consumed: bool,
    pub created_at: Instant,
}

impl ExecutionPermit {
    pub fn new(
        session_id: &str,
        turn_id: Option<&str>,
        tool_call_id: &str,
        tool_name: &str,
        args: &Value,
        generation: PermissionGeneration,
        scope_fingerprint: &str,
        actor_id: &str,
        requires_grant: bool,
    ) -> Self {
        Self {
            token: Uuid::new_v4().to_string(),
            session_id: session_id.to_string(),
            turn_id: turn_id.map(str::to_string),
            tool_call_id: tool_call_id.to_string(),
            tool_name: tool_name.to_string(),
            argument_fingerprint: grants::fingerprint(args),
            generation,
            scope_fingerprint: scope_fingerprint.to_string(),
            actor_id: actor_id.to_string(),
            requires_grant,
            consumed: false,
            created_at: Instant::now(),
        }
    }

    pub fn matches(
        &self,
        token: &str,
        session_id: &str,
        turn_id: Option<&str>,
        tool_call_id: &str,
        tool_name: &str,
        args: &Value,
        generation: PermissionGeneration,
        scope_fingerprint: Option<&str>,
        grant_active: bool,
        turn_running: bool,
    ) -> bool {
        !self.consumed
            && self.created_at.elapsed() < Duration::from_secs(120)
            && self.token == token
            && self.session_id == session_id
            && self.turn_id.as_deref() == turn_id
            && self.tool_call_id == tool_call_id
            && self.tool_name == tool_name
            && self.argument_fingerprint == grants::fingerprint(args)
            && self.generation == generation
            && Some(self.scope_fingerprint.as_str()) == scope_fingerprint
            && (!self.requires_grant || grant_active)
            && (turn_id.is_none() || turn_running)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permit_binds_identity_arguments_scope_and_generation() {
        let generation = PermissionGeneration { session: 0 };
        let args = serde_json::json!({"path": "out.txt"});
        let permit = ExecutionPermit::new(
            "session",
            Some("turn"),
            "call",
            "plugin_test_write",
            &args,
            generation,
            "scope",
            "agent",
            true,
        );
        let matches = |token: &str, args: &Value, generation, scope, active, running| {
            permit.matches(
                token,
                "session",
                Some("turn"),
                "call",
                "plugin_test_write",
                args,
                generation,
                scope,
                active,
                running,
            )
        };
        assert!(matches(
            &permit.token,
            &args,
            generation,
            Some("scope"),
            true,
            true
        ));
        assert!(!matches(
            "wrong",
            &args,
            generation,
            Some("scope"),
            true,
            true
        ));
        assert!(!matches(
            &permit.token,
            &serde_json::json!({"path": "other.txt"}),
            generation,
            Some("scope"),
            true,
            true
        ));
        assert!(!matches(
            &permit.token,
            &args,
            PermissionGeneration { session: 1 },
            Some("scope"),
            true,
            true
        ));
        assert!(!matches(
            &permit.token,
            &args,
            generation,
            Some("other"),
            true,
            true
        ));
        assert!(!matches(
            &permit.token,
            &args,
            generation,
            Some("scope"),
            false,
            true
        ));
        assert!(!matches(
            &permit.token,
            &args,
            generation,
            Some("scope"),
            true,
            false
        ));
    }
}
