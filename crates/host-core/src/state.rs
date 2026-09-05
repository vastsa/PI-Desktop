use std::collections::HashMap;
use std::time::{Duration, Instant};

use anyhow::Result;

use crate::db::Database;
use crate::mcp_servers::McpServerRegistry;
use crate::permissions::PermissionManager;
use crate::plans::PlanManager;
use crate::plugins::PluginManager;
use crate::secrets::SecretStore;
use crate::tool_budget::ToolBudget;
use crate::user_skills::UserSkillRegistry;
use crate::user_subagents::UserSubagentRegistry;
use crate::workspace::WorkspaceState;

pub const PROTOCOL_VERSION: u32 = 10;
pub const HOST_VERSION: &str = env!("CARGO_PKG_VERSION");
const BASH_ABORT_TOMBSTONE_TTL: Duration = Duration::from_secs(60);
const MAX_BASH_ABORT_TOMBSTONES: usize = 1024;

pub struct AppState {
    pub data_dir: std::path::PathBuf,
    pub db: Database,
    pub secrets: SecretStore,
    pub workspace: WorkspaceState,
    pub permissions: PermissionManager,
    pub plans: PlanManager,
    pub plugins: PluginManager,
    /// A2A (Agent2Agent) broker: in-memory peer registry + task coordination
    /// with the store, so concurrent subagents discover each other and run
    /// tasks with a real lifecycle (ADR 0146).
    pub a2a: crate::a2a::A2aBroker,
    /// MCP servers the user configured directly, without a plugin around them.
    pub mcp_servers: McpServerRegistry,
    /// Skill documents the user wrote or imported directly.
    pub user_skills: UserSkillRegistry,
    /// Subagent definitions the user owns, alongside the builtin and per-project
    /// ones the runtime discovers itself (D202).
    pub user_subagents: UserSubagentRegistry,
    pub started_at: Instant,
    pub handshook: bool,
    pub shutting_down: bool,
    /// session_id -> toolName grants
    pub session_grants: HashMap<String, Vec<String>>,
    /// executionId -> responder for plugin tool dispatches awaiting the
    /// desktop runner (Electron main executes the plugin JS and resolves).
    pub plugin_execs: HashMap<String, tokio::sync::oneshot::Sender<serde_json::Value>>,
    pub tool_budget: ToolBudget,
    /// (session_id, tool_call_id) -> cancellation signal for an active Bash
    /// process. The signal is removed by the execution owner in all outcomes.
    pub active_bash_cancellations: HashMap<(String, String), tokio::sync::watch::Sender<bool>>,
    /// request_id -> (session_id, tool_call_id) for permission requests that
    /// are currently awaited by an RPC task. PermissionManager intentionally
    /// keeps its pending map private, so AppState tracks the ownership needed
    /// for shutdown cancellation.
    pending_permissions: HashMap<String, (String, String)>,
    /// Abort can race ahead of tools.execute because host RPC requests run in
    /// separate tasks. A short-lived tombstone makes the later request start
    /// already cancelled instead of executing after Stop was acknowledged.
    pending_bash_aborts: HashMap<(String, String), Instant>,
}

impl AppState {
    pub fn open(data_dir: &std::path::Path) -> Result<Self> {
        let db = Database::open_in_dir(data_dir)?;
        // Replies that were still streaming when the previous process ended
        // are promoted into their transcripts before any client can read them
        // (D299). The turn sweep inside `open` has already marked those turns
        // aborted, so the promoted rows land under an aborted turn.
        match crate::sessions::recover_orphaned_sessions(&db) {
            Ok(restored) if restored > 0 => {
                tracing::info!(count = restored, "restored orphaned session rows from transcripts");
            }
            Ok(_) => {}
            Err(error) => tracing::warn!(%error, "orphaned session sweep failed"),
        }
        match crate::sessions::recover_inflight_messages(&db) {
            Ok(recovered) if !recovered.is_empty() => {
                tracing::info!(count = recovered.len(), "recovered in-flight replies");
            }
            Ok(_) => {}
            Err(error) => tracing::warn!(%error, "in-flight reply sweep failed"),
        }
        let secrets = SecretStore::open(data_dir)?;
        // The marketplace source is read before the manager builds its first
        // catalog, so a mirror configured for networks without GitHub access
        // applies on launch instead of only after a manual refresh.
        let app_settings = db.get_setting("app").unwrap_or_default();
        let plugins = PluginManager::new(
            data_dir,
            crate::plugins::market_source_from_settings(app_settings.as_ref()),
        );
        let mcp_servers = McpServerRegistry::new(data_dir);
        let user_skills = UserSkillRegistry::new(data_dir);
        let user_subagents = UserSubagentRegistry::new(data_dir);
        Ok(Self {
            data_dir: data_dir.to_path_buf(),
            db,
            secrets,
            workspace: WorkspaceState::default(),
            permissions: PermissionManager::default(),
            plans: PlanManager,
            plugins,
            a2a: crate::a2a::A2aBroker::new(),
            mcp_servers,
            user_skills,
            user_subagents,
            started_at: Instant::now(),
            handshook: false,
            shutting_down: false,
            session_grants: HashMap::new(),
            plugin_execs: HashMap::new(),
            tool_budget: ToolBudget::new(),
            active_bash_cancellations: HashMap::new(),
            pending_permissions: HashMap::new(),
            pending_bash_aborts: HashMap::new(),
        })
    }

    pub fn register_pending_permission(
        &mut self,
        request_id: &str,
        session_id: &str,
        tool_call_id: &str,
    ) {
        self.pending_permissions.insert(
            request_id.to_string(),
            (session_id.to_string(), tool_call_id.to_string()),
        );
    }

    pub fn clear_pending_permission(&mut self, request_id: &str) {
        self.pending_permissions.remove(request_id);
    }

    pub fn cancel_pending_permission(&mut self, session_id: &str, tool_call_id: &str) -> bool {
        let request_id = self
            .pending_permissions
            .iter()
            .find(|(_, (pending_session_id, pending_tool_call_id))| {
                pending_session_id == session_id && pending_tool_call_id == tool_call_id
            })
            .map(|(request_id, _)| request_id.clone());
        let Some(request_id) = request_id else {
            return false;
        };
        self.pending_permissions.remove(&request_id);
        self.permissions.cancel_for_tool(session_id, tool_call_id)
    }

    pub fn resolve_permission(
        &mut self,
        request_id: &str,
        decision: crate::permissions::PermissionDecision,
    ) -> Result<(), String> {
        let result = self.permissions.resolve(request_id, decision);
        self.clear_pending_permission(request_id);
        result
    }

    fn prune_bash_abort_tombstones(&mut self) {
        self.pending_bash_aborts
            .retain(|_, requested_at| requested_at.elapsed() < BASH_ABORT_TOMBSTONE_TTL);
        while self.pending_bash_aborts.len() > MAX_BASH_ABORT_TOMBSTONES {
            let Some(oldest) = self
                .pending_bash_aborts
                .iter()
                .min_by_key(|(_, requested_at)| **requested_at)
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            self.pending_bash_aborts.remove(&oldest);
        }
    }

    pub fn register_bash_cancellation(
        &mut self,
        session_id: &str,
        tool_call_id: &str,
    ) -> Result<tokio::sync::watch::Receiver<bool>, String> {
        if self.shutting_down {
            return Err("HOST_SHUTTING_DOWN".into());
        }
        self.prune_bash_abort_tombstones();
        let key = (session_id.to_string(), tool_call_id.to_string());
        if self.active_bash_cancellations.contains_key(&key) {
            return Err("TOOL_BUSY".into());
        }
        let initially_aborted = self.pending_bash_aborts.remove(&key).is_some();
        let (sender, receiver) = tokio::sync::watch::channel(initially_aborted);
        self.active_bash_cancellations.insert(key, sender);
        Ok(receiver)
    }

    pub fn abort_or_queue_bash(&mut self, session_id: &str, tool_call_id: &str) -> (bool, bool) {
        self.prune_bash_abort_tombstones();
        let key = (session_id.to_string(), tool_call_id.to_string());
        let active = self
            .active_bash_cancellations
            .get(&key)
            .is_some_and(|sender| sender.send(true).is_ok());
        if active {
            (true, false)
        } else {
            self.pending_bash_aborts.insert(key, Instant::now());
            (false, true)
        }
    }

    pub fn clear_bash_cancellation(&mut self, session_id: &str, tool_call_id: &str) {
        let key = (session_id.to_string(), tool_call_id.to_string());
        self.active_bash_cancellations.remove(&key);
        self.pending_bash_aborts.remove(&key);
    }

    pub fn shutdown(&mut self) {
        self.shutting_down = true;
        for sender in self.active_bash_cancellations.values() {
            let _ = sender.send(true);
        }
        self.active_bash_cancellations.clear();

        let pending_request_ids: Vec<String> = self.pending_permissions.keys().cloned().collect();
        for request_id in pending_request_ids {
            let _ = self.permissions.cancel(&request_id);
        }
        self.pending_permissions.clear();

        self.pending_bash_aborts.clear();
        self.plugin_execs.clear();
        self.a2a.clear();
    }

    pub fn uptime_ms(&self) -> u64 {
        self.started_at.elapsed().as_millis() as u64
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shutdown_cancels_pending_permissions_and_active_bash() {
        let data_dir = tempfile::tempdir().unwrap();
        let mut state = AppState::open(data_dir.path()).unwrap();
        let (request, _receiver) = state.permissions.create_request(
            "session-1",
            "tool-call-1",
            "Bash",
            serde_json::json!({ "command": "sleep 30" }),
            "test",
        );
        state.register_pending_permission(
            &request.request_id,
            &request.session_id,
            &request.tool_call_id,
        );
        let mut cancellation = state
            .register_bash_cancellation("session-1", "tool-call-2")
            .unwrap();

        state.shutdown();

        assert!(state.pending_permissions.is_empty());
        assert!(state.active_bash_cancellations.is_empty());
        assert!(state.pending_bash_aborts.is_empty());
        assert!(state.shutting_down);
        assert!(matches!(
            state.register_bash_cancellation("session-1", "tool-call-3"),
            Err(error) if error == "HOST_SHUTTING_DOWN"
        ));
        assert!(*cancellation.borrow_and_update());
        assert_eq!(
            state.permissions.resolve(
                &request.request_id,
                crate::permissions::PermissionDecision::Deny,
            ),
            Err("NOT_FOUND".into())
        );
    }
}
