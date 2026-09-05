//! A2A (Agent2Agent) protocol broker for host-core (ADR 0146).
//!
//! The broker owns the in-memory agent registry (agent cards keyed by a minted
//! capability token) and coordinates task lifecycle with the SQLite [`store`].
//! Concurrent subagents ("peers") register under a shared context, discover
//! each other, and exchange multimodal messages that drive real A2A tasks.
//!
//! Broker methods are pure state transitions: they return the RPC result plus a
//! list of [`Notification`]s the RPC layer emits on host→client stdout. The
//! broker never touches the transport itself, which keeps it unit-testable.

pub mod store;
pub mod types;

use std::collections::HashMap;

use rusqlite::Connection;
use serde_json::Value;
use uuid::Uuid;

pub use types::{
    can_transition, is_terminal, A2aError, AgentCard, AgentsDeregisterParams,
    AgentsDeregisterResult, AgentsListParams, AgentsListResult, AgentsRegisterParams,
    AgentsRegisterResult, Message, MessageSendParams, MessageSendResult, MessageStreamParams, Part,
    PushConfigGetParams, PushConfigGetResult, PushConfigSetParams, PushConfigSetResult,
    PushNotification, StreamEvent, Task, TaskEventNotification, TaskKind, TaskResult, TaskState,
    TaskStatus, TaskStatusUpdateEvent, TasksCancelParams, TasksGetParams, TasksResubscribeParams,
    TasksStatusParams,
};

/// Host→client notification the RPC layer must emit after a broker call.
#[derive(Debug, Clone, PartialEq)]
pub struct Notification {
    pub method: String,
    pub params: Value,
}

/// The two A2A notification method names (mirrors `A2A_NOTIFICATIONS`).
pub const NOTIFY_TASK_EVENT: &str = "a2a.task.event";
pub const NOTIFY_PUSH: &str = "a2a.push";

/// A registered peer: its capability token, grouping context, and agent card.
#[derive(Debug, Clone)]
struct RegisteredAgent {
    agent_id: String,
    context_id: String,
    card: AgentCard,
}

/// In-memory A2A broker. Agent registry and tokens are valid only while a
/// delegation runs; durable task state lives in the store.
#[derive(Default)]
pub struct A2aBroker {
    /// token -> registered agent.
    agents: HashMap<String, RegisteredAgent>,
    /// token -> number of sends issued this run (bounded by A2A_MAX_SENDS_PER_RUN).
    send_counts: HashMap<String, usize>,
    /// recipient peer name -> parked wakers. Long-poll is not used in this pass,
    /// but shutdown drains and wakes any parked waiters.
    waiters: HashMap<String, Vec<tokio::sync::oneshot::Sender<()>>>,
}

impl A2aBroker {
    pub fn new() -> Self {
        Self::default()
    }

    fn agent_for_token(&self, token: &str) -> Result<&RegisteredAgent, A2aError> {
        self.agents.get(token).ok_or(A2aError::UnknownToken)
    }

    fn authorize_task(task: &Task, caller_name: &str) -> Result<(), A2aError> {
        if task.agent_name != caller_name && task.requester_name != caller_name {
            return Err(A2aError::UnknownAgent);
        }
        Ok(())
    }

    fn name_taken(&self, name: &str) -> bool {
        self.agents.values().any(|agent| agent.agent_id == name)
    }

    /// Suffix-uniquify `requested` against the live registry (`name`, `name-2`, …).
    fn unique_agent_name(&self, requested: &str) -> String {
        if !self.name_taken(requested) {
            return requested.to_string();
        }
        let mut i = 2;
        loop {
            let candidate = format!("{requested}-{i}");
            if !self.name_taken(&candidate) {
                return candidate;
            }
            i += 1;
        }
    }

    fn peer_context(&self, name: &str) -> Option<String> {
        self.agents
            .values()
            .find(|agent| agent.agent_id == name)
            .map(|agent| agent.context_id.clone())
    }

    /// Register a peer under a context, minting a capability token.
    /// `card.name` is uniquified against every live agent on the host so
    /// `agentName` / `requesterName` on a task cannot collide (ADR 0162).
    pub fn register(&mut self, mut params: AgentsRegisterParams) -> AgentsRegisterResult {
        let token = Uuid::new_v4().to_string();
        let agent_id = self.unique_agent_name(&params.card.name);
        params.card.name = agent_id.clone();
        params.card.context_id = Some(params.context_id.clone());
        self.agents.insert(
            token.clone(),
            RegisteredAgent {
                agent_id: agent_id.clone(),
                context_id: params.context_id,
                card: params.card,
            },
        );
        self.send_counts.insert(token.clone(), 0);
        AgentsRegisterResult { agent_id, token }
    }

    /// Deregister a peer, fail its unfinished tasks, and wake parked waiters.
    pub fn deregister(
        &mut self,
        conn: &Connection,
        params: AgentsDeregisterParams,
    ) -> Result<(AgentsDeregisterResult, Vec<Notification>), A2aError> {
        let mut notifications = Vec::new();
        if let Some(agent) = self.agents.get(&params.token).cloned() {
            for task in store::active_tasks_for_peer(conn, &agent.agent_id)? {
                let failed = TaskStatus {
                    state: TaskState::Failed,
                    message: None,
                    timestamp: store::now_ts(),
                };
                store::update_status(conn, &task.id, &failed)?;
                let task = store::load_task(conn, &task.id)?.ok_or(A2aError::UnknownTask)?;
                let recipient = counterpart(&task, &agent.agent_id);
                notifications.extend(self.terminal_notifications(conn, &recipient, &task)?);
            }
            self.agents.remove(&params.token);
            self.send_counts.remove(&params.token);
            self.wake_recipient(&agent.card.name);
        }
        Ok((AgentsDeregisterResult { ok: true }, notifications))
    }

    /// List all OTHER live peers on the host, including other sessions.
    pub fn list(&self, params: AgentsListParams) -> Result<AgentsListResult, A2aError> {
        let _caller = self.agent_for_token(&params.token)?;
        let mut agents: Vec<AgentCard> = self
            .agents
            .iter()
            .filter(|(token, _)| token.as_str() != params.token)
            .map(|(_, agent)| agent.card.clone())
            .collect();
        agents.sort_by(|a, b| a.name.cmp(&b.name).then(a.context_id.cmp(&b.context_id)));
        Ok(AgentsListResult { agents })
    }

    /// `a2a.message.send`. Returns the task and the notifications to emit.
    pub fn message_send(
        &mut self,
        conn: &Connection,
        params: MessageSendParams,
    ) -> Result<(MessageSendResult, Vec<Notification>), A2aError> {
        let push = params
            .configuration
            .as_ref()
            .and_then(|config| config.push_notification_config.clone());
        let (task, notifications) =
            self.dispatch_message(conn, &params.token, params.message, push)?;
        Ok((MessageSendResult { task }, notifications))
    }

    /// `a2a.message.stream`. Same routing as send; always emits a status event.
    pub fn message_stream(
        &mut self,
        conn: &Connection,
        params: MessageStreamParams,
    ) -> Result<(TaskResult, Vec<Notification>), A2aError> {
        let (task, notifications) =
            self.dispatch_message(conn, &params.token, params.message, None)?;
        Ok((TaskResult { task }, notifications))
    }

    /// Shared send/stream routing: validate, bound, route, transition, notify.
    fn dispatch_message(
        &mut self,
        conn: &Connection,
        token: &str,
        mut message: Message,
        push: Option<types::PushNotificationConfig>,
    ) -> Result<(Task, Vec<Notification>), A2aError> {
        let (caller_name, caller_context) = {
            let caller = self.agent_for_token(token)?;
            (caller.agent_id.clone(), caller.context_id.clone())
        };

        // Check the cap before dispatch, but only charge successful sends below.
        if self.send_counts.get(token).copied().unwrap_or(0) >= types::A2A_MAX_SENDS_PER_RUN {
            return Err(A2aError::SendCap);
        }

        // The broker owns provenance: overwrite `from`, bind the context.
        message.from = Some(caller_name.clone());
        message.context_id = Some(caller_context.clone());
        bound_message_parts(&mut message)?;

        let task_id = message
            .task_id
            .as_ref()
            .filter(|id| !id.trim().is_empty())
            .cloned();

        let result = if let Some(task_id) = task_id {
            self.send_to_existing_task(conn, &caller_name, task_id, message, push)
        } else {
            self.create_task(conn, &caller_name, &caller_context, message, push)
        };
        if result.is_ok() {
            *self.send_counts.entry(token.to_string()).or_insert(0) += 1;
        }
        result
    }

    fn create_task(
        &mut self,
        conn: &Connection,
        caller_name: &str,
        caller_context: &str,
        mut message: Message,
        push: Option<types::PushNotificationConfig>,
    ) -> Result<(Task, Vec<Notification>), A2aError> {
        let recipient =
            self.resolve_recipient(caller_name, caller_context, message.to.as_deref())?;

        if store::count_tasks_in_context(conn, caller_context)? >= types::A2A_MAX_TASKS_PER_CONTEXT
        {
            return Err(A2aError::SendCap);
        }

        let task_id = Uuid::new_v4().to_string();
        message.task_id = Some(task_id.clone());
        let now = store::now_ts();
        // submitted → working, per the contract's normal path.
        let task = Task {
            kind: TaskKind::Task,
            id: task_id.clone(),
            context_id: caller_context.to_string(),
            status: TaskStatus {
                state: TaskState::Working,
                message: None,
                timestamp: now,
            },
            history: vec![message],
            artifacts: vec![],
            agent_name: recipient.clone(),
            requester_name: caller_name.to_string(),
        };
        // Persist the task, its first message, and any push config atomically.
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| A2aError::Internal(e.to_string()))?;
        store::insert_task(&tx, &task)?;
        if let Some(config) = push {
            store::set_push_config(&tx, &task_id, &config)?;
        }
        tx.commit().map_err(|e| A2aError::Internal(e.to_string()))?;

        // The new task is addressed to the recipient (the worker).
        let notifications = vec![self.task_event_notification(&recipient, &task, false)];
        Ok((task, notifications))
    }

    /// Pick a reachable peer. Same-session agents win when `to` is omitted or
    /// when several live agents share a requested name (should not happen after
    /// register uniquify). Cross-session peers are otherwise addressable.
    fn resolve_recipient(
        &self,
        caller_name: &str,
        caller_context: &str,
        to: Option<&str>,
    ) -> Result<String, A2aError> {
        let mut others: Vec<&RegisteredAgent> = self
            .agents
            .values()
            .filter(|agent| agent.agent_id != caller_name)
            .collect();
        if others.is_empty() {
            return Err(A2aError::NoPeers);
        }
        others.sort_by(|a, b| {
            a.agent_id
                .cmp(&b.agent_id)
                .then(a.context_id.cmp(&b.context_id))
        });

        let requested = to.map(str::trim).filter(|value| !value.is_empty());
        if let Some(to) = requested {
            let matches: Vec<&RegisteredAgent> = others
                .iter()
                .copied()
                .filter(|agent| agent.agent_id == to)
                .collect();
            if matches.is_empty() {
                return Err(A2aError::UnknownAgent);
            }
            if let Some(same) = matches
                .iter()
                .find(|agent| agent.context_id == caller_context)
            {
                return Ok(same.agent_id.clone());
            }
            return Ok(matches[0].agent_id.clone());
        }

        let same: Vec<&RegisteredAgent> = others
            .iter()
            .copied()
            .filter(|agent| agent.context_id == caller_context)
            .collect();
        if !same.is_empty() {
            return Ok(same[0].agent_id.clone());
        }
        if others.len() == 1 {
            return Ok(others[0].agent_id.clone());
        }
        Err(A2aError::NoPeers)
    }

    fn send_to_existing_task(
        &mut self,
        conn: &Connection,
        caller_name: &str,
        task_id: String,
        message: Message,
        push: Option<types::PushNotificationConfig>,
    ) -> Result<(Task, Vec<Notification>), A2aError> {
        let mut task = store::load_task(conn, &task_id)?.ok_or(A2aError::UnknownTask)?;
        Self::authorize_task(&task, caller_name)?;
        if is_terminal(task.status.state) {
            return Err(A2aError::TaskTerminal);
        }
        if !can_transition(task.status.state, TaskState::Working) {
            return Err(A2aError::InvalidTransition);
        }

        task.status = TaskStatus {
            state: TaskState::Working,
            message: None,
            timestamp: store::now_ts(),
        };
        // Append the message, cap history, and update status atomically.
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| A2aError::Internal(e.to_string()))?;
        store::append_message(&tx, &task_id, &message)?;
        store::cap_history(&tx, &task_id, types::A2A_MAX_TASK_HISTORY)?;
        store::update_status(&tx, &task_id, &task.status)?;
        if let Some(config) = push {
            store::set_push_config(&tx, &task_id, &config)?;
        }
        tx.commit().map_err(|e| A2aError::Internal(e.to_string()))?;

        // Reload so the returned task carries the full, capped history.
        let task = store::load_task(conn, &task_id)?.ok_or(A2aError::UnknownTask)?;
        // Route the event to the other party: a worker's reply wakes the
        // requester, and a requester's follow-up wakes the worker.
        let recipient = counterpart(&task, caller_name);
        let notifications = vec![self.task_event_notification(&recipient, &task, false)];
        Ok((task, notifications))
    }

    /// `a2a.tasks.get`. Optionally truncates history to the newest N messages.
    pub fn tasks_get(
        &self,
        conn: &Connection,
        params: TasksGetParams,
    ) -> Result<TaskResult, A2aError> {
        let caller = self.agent_for_token(&params.token)?;
        let mut task = store::load_task(conn, &params.id)?.ok_or(A2aError::UnknownTask)?;
        Self::authorize_task(&task, &caller.agent_id)?;
        if let Some(limit) = params.history_length {
            truncate_history(&mut task, limit);
        }
        Ok(TaskResult { task })
    }

    /// `a2a.tasks.cancel`. Moves a non-terminal task to `canceled`.
    pub fn tasks_cancel(
        &mut self,
        conn: &Connection,
        params: TasksCancelParams,
    ) -> Result<(TaskResult, Vec<Notification>), A2aError> {
        let caller_name = self.agent_for_token(&params.token)?.agent_id.clone();
        let mut task = store::load_task(conn, &params.id)?.ok_or(A2aError::UnknownTask)?;
        Self::authorize_task(&task, &caller_name)?;
        if is_terminal(task.status.state) {
            return Err(A2aError::TaskTerminal);
        }
        if !can_transition(task.status.state, TaskState::Canceled) {
            return Err(A2aError::InvalidTransition);
        }
        task.status = TaskStatus {
            state: TaskState::Canceled,
            message: None,
            timestamp: store::now_ts(),
        };
        store::update_status(conn, &params.id, &task.status)?;
        let task = store::load_task(conn, &params.id)?.ok_or(A2aError::UnknownTask)?;
        let recipient = counterpart(&task, &caller_name);
        let notifications = self.terminal_notifications(conn, &recipient, &task)?;
        Ok((TaskResult { task }, notifications))
    }

    /// `a2a.tasks.status`. Drive a task to a new state (the completion/failure/
    /// interactive-pause path), validating the transition and routing the event
    /// to the counterpart of the caller — so a worker's `completed` wakes the
    /// requester. An optional message is stamped and appended like any other.
    pub fn tasks_status(
        &mut self,
        conn: &Connection,
        params: TasksStatusParams,
    ) -> Result<(TaskResult, Vec<Notification>), A2aError> {
        let (caller_name, caller_context) = {
            let caller = self.agent_for_token(&params.token)?;
            (caller.agent_id.clone(), caller.context_id.clone())
        };
        let mut task = store::load_task(conn, &params.id)?.ok_or(A2aError::UnknownTask)?;
        Self::authorize_task(&task, &caller_name)?;
        if is_terminal(task.status.state) {
            return Err(A2aError::TaskTerminal);
        }
        if !can_transition(task.status.state, params.state) {
            return Err(A2aError::InvalidTransition);
        }

        // A caller-supplied status message is stamped and appended to history.
        let status_message = match params.message {
            Some(mut message) => {
                message.from = Some(caller_name.clone());
                message.context_id = Some(caller_context.clone());
                message.task_id = Some(task.id.clone());
                bound_message_parts(&mut message)?;
                Some(message)
            }
            None => None,
        };

        task.status = TaskStatus {
            state: params.state,
            message: status_message.clone(),
            timestamp: store::now_ts(),
        };
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| A2aError::Internal(e.to_string()))?;
        if let Some(message) = &status_message {
            store::append_message(&tx, &task.id, message)?;
            store::cap_history(&tx, &task.id, types::A2A_MAX_TASK_HISTORY)?;
        }
        store::update_status(&tx, &task.id, &task.status)?;
        tx.commit().map_err(|e| A2aError::Internal(e.to_string()))?;

        let task = store::load_task(conn, &params.id)?.ok_or(A2aError::UnknownTask)?;
        let recipient = counterpart(&task, &caller_name);
        let notifications = if is_terminal(task.status.state) {
            self.terminal_notifications(conn, &recipient, &task)?
        } else {
            vec![self.task_event_notification(&recipient, &task, false)]
        };
        Ok((TaskResult { task }, notifications))
    }

    /// `a2a.tasks.resubscribe`. Re-emits the current status as an event.
    pub fn tasks_resubscribe(
        &self,
        conn: &Connection,
        params: TasksResubscribeParams,
    ) -> Result<(TaskResult, Vec<Notification>), A2aError> {
        let caller = self.agent_for_token(&params.token)?;
        let task = store::load_task(conn, &params.id)?.ok_or(A2aError::UnknownTask)?;
        Self::authorize_task(&task, &caller.agent_id)?;
        let is_final = is_terminal(task.status.state);
        // Re-emit the current status to the caller who is resubscribing.
        let notifications = vec![self.task_event_notification(&caller.agent_id, &task, is_final)];
        Ok((TaskResult { task }, notifications))
    }

    /// `a2a.tasks.pushNotificationConfig.set`.
    pub fn push_config_set(
        &self,
        conn: &Connection,
        params: PushConfigSetParams,
    ) -> Result<PushConfigSetResult, A2aError> {
        let caller = self.agent_for_token(&params.token)?;
        let task = store::load_task(conn, &params.task_id)?.ok_or(A2aError::UnknownTask)?;
        Self::authorize_task(&task, &caller.agent_id)?;
        store::set_push_config(conn, &params.task_id, &params.config)?;
        Ok(PushConfigSetResult {
            config: params.config,
        })
    }

    /// `a2a.tasks.pushNotificationConfig.get`.
    pub fn push_config_get(
        &self,
        conn: &Connection,
        params: PushConfigGetParams,
    ) -> Result<PushConfigGetResult, A2aError> {
        let caller = self.agent_for_token(&params.token)?;
        let task = store::load_task(conn, &params.task_id)?.ok_or(A2aError::UnknownTask)?;
        Self::authorize_task(&task, &caller.agent_id)?;
        let config = store::get_push_config(conn, &params.task_id)?;
        Ok(PushConfigGetResult { config })
    }

    /// Build the terminal notifications for a task: a `final` status event and,
    /// if a push config exists, an `a2a.push`.
    fn terminal_notifications(
        &self,
        conn: &Connection,
        recipient: &str,
        task: &Task,
    ) -> Result<Vec<Notification>, A2aError> {
        let mut notifications = vec![self.task_event_notification(recipient, task, true)];
        if let Some(config) = store::get_push_config(conn, &task.id)? {
            let recipient_context = self
                .peer_context(recipient)
                .unwrap_or_else(|| task.context_id.clone());
            let push = PushNotification {
                recipient: recipient.to_string(),
                recipient_context_id: Some(recipient_context),
                context_id: task.context_id.clone(),
                task_id: task.id.clone(),
                token: config.token,
                status: task.status.clone(),
            };
            notifications.push(Notification {
                method: NOTIFY_PUSH.to_string(),
                params: serde_json::to_value(push).unwrap_or(Value::Null),
            });
        }
        Ok(notifications)
    }

    /// Build an `a2a.task.event` notification for a task's current status.
    fn task_event_notification(
        &self,
        recipient: &str,
        task: &Task,
        is_final: bool,
    ) -> Notification {
        let event = StreamEvent::StatusUpdate(TaskStatusUpdateEvent {
            task_id: task.id.clone(),
            context_id: task.context_id.clone(),
            status: task.status.clone(),
            is_final,
        });
        let recipient_context = self
            .peer_context(recipient)
            .unwrap_or_else(|| task.context_id.clone());
        let notification = TaskEventNotification {
            recipient: recipient.to_string(),
            recipient_context_id: Some(recipient_context),
            context_id: task.context_id.clone(),
            event,
        };
        Notification {
            method: NOTIFY_TASK_EVENT.to_string(),
            params: serde_json::to_value(notification).unwrap_or(Value::Null),
        }
    }

    fn wake_recipient(&mut self, recipient: &str) {
        if let Some(waiters) = self.waiters.remove(recipient) {
            for waiter in waiters {
                let _ = waiter.send(());
            }
        }
    }

    /// Clear the registry and wake every parked waiter. Called on shutdown.
    pub fn clear(&mut self) {
        self.agents.clear();
        self.send_counts.clear();
        for (_, waiters) in self.waiters.drain() {
            for waiter in waiters {
                let _ = waiter.send(());
            }
        }
    }
}

/// The other party of a task relative to `caller`: worker ↔ requester. A caller
/// that is neither (should not happen within a context) defaults to the worker.
fn counterpart(task: &Task, caller: &str) -> String {
    if caller == task.agent_name {
        task.requester_name.clone()
    } else {
        task.agent_name.clone()
    }
}

/// Enforce per-part bounds: truncate long text, reject oversized inline files.
fn bound_message_parts(message: &mut Message) -> Result<(), A2aError> {
    for part in &mut message.parts {
        match part {
            Part::Text { text } => {
                if text.chars().count() > types::A2A_MAX_TEXT_CHARS {
                    *text = text.chars().take(types::A2A_MAX_TEXT_CHARS).collect();
                }
            }
            Part::File { file } => {
                if let Some(bytes) = &file.bytes {
                    // base64 decodes to ~3/4 of its character length.
                    let decoded_len = bytes.trim_end_matches('=').len() / 4 * 3;
                    if decoded_len > types::A2A_MAX_FILE_BYTES {
                        return Err(A2aError::PayloadTooLarge);
                    }
                }
            }
            Part::Data { .. } => {}
        }
    }
    Ok(())
}

/// Keep only the newest `limit` messages of a task's history.
fn truncate_history(task: &mut Task, limit: usize) {
    if task.history.len() > limit {
        let start = task.history.len() - limit;
        task.history.drain(0..start);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;

    fn open_db() -> (tempfile::TempDir, Database) {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
        (dir, db)
    }

    fn card(name: &str) -> AgentCard {
        AgentCard {
            name: name.into(),
            description: format!("agent {name}"),
            version: "1.0.0".into(),
            skills: vec![],
            capabilities: types::AgentCapabilities {
                streaming: true,
                push_notifications: true,
            },
            default_input_modes: vec!["text".into()],
            default_output_modes: vec!["text".into()],
            context_id: None,
        }
    }

    fn register(broker: &mut A2aBroker, context: &str, name: &str) -> String {
        broker
            .register(AgentsRegisterParams {
                context_id: context.into(),
                card: card(name),
            })
            .token
    }

    fn text_message(id: &str, to: Option<&str>, task_id: Option<&str>) -> Message {
        Message {
            role: types::Role::User,
            parts: vec![Part::Text { text: "hi".into() }],
            message_id: id.into(),
            task_id: task_id.map(|s| s.to_string()),
            context_id: None,
            from: Some("forged".into()),
            to: to.map(|s| s.to_string()),
        }
    }

    #[test]
    fn register_list_includes_other_contexts_and_hides_self() {
        let mut broker = A2aBroker::new();
        let a = register(&mut broker, "ctx-1", "alice");
        let _b = register(&mut broker, "ctx-1", "bob");
        let _c = register(&mut broker, "ctx-2", "carol");

        let listed = broker.list(AgentsListParams { token: a }).unwrap();
        let names: Vec<&str> = listed.agents.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["bob", "carol"]);
        let carol = listed
            .agents
            .iter()
            .find(|card| card.name == "carol")
            .unwrap();
        assert_eq!(carol.context_id.as_deref(), Some("ctx-2"));
    }

    #[test]
    fn unknown_token_is_rejected() {
        let broker = A2aBroker::new();
        let err = broker
            .list(AgentsListParams {
                token: "nope".into(),
            })
            .unwrap_err();
        assert_eq!(err, A2aError::UnknownToken);
        assert_eq!(err.code(), types::error_codes::UNKNOWN_TOKEN);
    }

    #[test]
    fn message_send_creates_a_task_stamps_from_and_round_trips() {
        let (_dir, db) = open_db();
        let mut broker = A2aBroker::new();
        let alice = register(&mut broker, "ctx", "alice");
        let _bob = register(&mut broker, "ctx", "bob");

        let (result, notifications) = broker
            .message_send(
                db.conn(),
                MessageSendParams {
                    token: alice.clone(),
                    message: text_message("m1", Some("bob"), None),
                    configuration: None,
                },
            )
            .unwrap();
        let task = result.task;
        assert_eq!(task.agent_name, "bob");
        assert_eq!(task.status.state, TaskState::Working);
        // `from` is stamped by the broker, never trusted from the client.
        assert_eq!(task.history[0].from.as_deref(), Some("alice"));
        assert_eq!(notifications.len(), 1);
        assert_eq!(notifications[0].method, NOTIFY_TASK_EVENT);

        let fetched = broker
            .tasks_get(
                db.conn(),
                TasksGetParams {
                    token: alice,
                    id: task.id.clone(),
                    history_length: None,
                },
            )
            .unwrap();
        assert_eq!(fetched.task, task);
    }

    #[test]
    fn stranger_cannot_read_a_cross_session_task() {
        let (_dir, db) = open_db();
        let mut broker = A2aBroker::new();
        let alice = register(&mut broker, "ctx-1", "alice");
        let _bob = register(&mut broker, "ctx-1", "bob");
        let carol = register(&mut broker, "ctx-2", "carol");

        let (result, _) = broker
            .message_send(
                db.conn(),
                MessageSendParams {
                    token: alice,
                    message: text_message("m1", Some("bob"), None),
                    configuration: None,
                },
            )
            .unwrap();

        let err = broker
            .tasks_get(
                db.conn(),
                TasksGetParams {
                    token: carol,
                    id: result.task.id,
                    history_length: None,
                },
            )
            .unwrap_err();
        assert_eq!(err, A2aError::UnknownAgent);
    }

    #[test]
    fn cross_session_send_and_complete_round_trip() {
        let (_dir, db) = open_db();
        let mut broker = A2aBroker::new();
        let alice = register(&mut broker, "ctx-1", "alice");
        let bob = register(&mut broker, "ctx-2", "bob");

        let (created, notes) = broker
            .message_send(
                db.conn(),
                MessageSendParams {
                    token: alice.clone(),
                    message: text_message("m1", Some("bob"), None),
                    configuration: None,
                },
            )
            .unwrap();
        assert_eq!(created.task.agent_name, "bob");
        assert_eq!(created.task.requester_name, "alice");
        assert_eq!(created.task.context_id, "ctx-1");
        assert_eq!(notes[0].params["recipient"], Value::String("bob".into()));
        assert_eq!(
            notes[0].params["recipientContextId"],
            Value::String("ctx-2".into())
        );

        let fetched = broker
            .tasks_get(
                db.conn(),
                TasksGetParams {
                    token: bob.clone(),
                    id: created.task.id.clone(),
                    history_length: None,
                },
            )
            .unwrap();
        assert_eq!(fetched.task.id, created.task.id);

        let (_, done_notes) = broker
            .tasks_status(
                db.conn(),
                TasksStatusParams {
                    token: bob,
                    id: created.task.id,
                    state: TaskState::Completed,
                    message: None,
                },
            )
            .unwrap();
        assert_eq!(
            done_notes[0].params["recipient"],
            Value::String("alice".into())
        );
        assert_eq!(
            done_notes[0].params["recipientContextId"],
            Value::String("ctx-1".into())
        );
    }

    #[test]
    fn omitted_to_prefers_same_session_then_unique_remote() {
        let (_dir, db) = open_db();
        let mut broker = A2aBroker::new();
        let alice = register(&mut broker, "ctx-1", "alice");
        let _bob = register(&mut broker, "ctx-1", "bob");
        let _carol = register(&mut broker, "ctx-2", "carol");

        let (created, _) = broker
            .message_send(
                db.conn(),
                MessageSendParams {
                    token: alice,
                    message: text_message("m1", None, None),
                    configuration: None,
                },
            )
            .unwrap();
        assert_eq!(created.task.agent_name, "bob");

        let mut remote_only = A2aBroker::new();
        let dave = register(&mut remote_only, "ctx-1", "dave");
        let _erin = register(&mut remote_only, "ctx-2", "erin");
        let (remote, _) = remote_only
            .message_send(
                db.conn(),
                MessageSendParams {
                    token: dave,
                    message: text_message("m2", None, None),
                    configuration: None,
                },
            )
            .unwrap();
        assert_eq!(remote.task.agent_name, "erin");
    }

    #[test]
    fn register_uniquifies_colliding_names_across_sessions() {
        let mut broker = A2aBroker::new();
        let first = register(&mut broker, "ctx-1", "discussant");
        let second = register(&mut broker, "ctx-2", "discussant");
        let listed = broker.list(AgentsListParams { token: first }).unwrap();
        assert_eq!(listed.agents.len(), 1);
        assert_eq!(listed.agents[0].name, "discussant-2");
        assert_eq!(listed.agents[0].context_id.as_deref(), Some("ctx-2"));
        let listed_back = broker.list(AgentsListParams { token: second }).unwrap();
        assert_eq!(listed_back.agents[0].name, "discussant");
    }

    #[test]
    fn sending_to_a_terminal_task_is_rejected() {
        let (_dir, db) = open_db();
        let mut broker = A2aBroker::new();
        let alice = register(&mut broker, "ctx", "alice");
        let _bob = register(&mut broker, "ctx", "bob");

        let (result, _) = broker
            .message_send(
                db.conn(),
                MessageSendParams {
                    token: alice.clone(),
                    message: text_message("m1", Some("bob"), None),
                    configuration: None,
                },
            )
            .unwrap();
        let task_id = result.task.id;

        broker
            .tasks_cancel(
                db.conn(),
                TasksCancelParams {
                    token: alice.clone(),
                    id: task_id.clone(),
                },
            )
            .unwrap();

        let err = broker
            .message_send(
                db.conn(),
                MessageSendParams {
                    token: alice,
                    message: text_message("m2", Some("bob"), Some(&task_id)),
                    configuration: None,
                },
            )
            .unwrap_err();
        assert_eq!(err, A2aError::TaskTerminal);
    }

    #[test]
    fn cancel_emits_final_event_and_push_when_configured() {
        let (_dir, db) = open_db();
        let mut broker = A2aBroker::new();
        let alice = register(&mut broker, "ctx", "alice");
        let _bob = register(&mut broker, "ctx", "bob");

        let (result, _) = broker
            .message_send(
                db.conn(),
                MessageSendParams {
                    token: alice.clone(),
                    message: text_message("m1", Some("bob"), None),
                    configuration: Some(types::MessageSendConfiguration {
                        blocking: Some(false),
                        history_length: None,
                        push_notification_config: Some(types::PushNotificationConfig {
                            id: "cfg".into(),
                            url: None,
                            token: Some("secret".into()),
                        }),
                    }),
                },
            )
            .unwrap();

        let (_, notifications) = broker
            .tasks_cancel(
                db.conn(),
                TasksCancelParams {
                    token: alice,
                    id: result.task.id,
                },
            )
            .unwrap();
        assert_eq!(notifications.len(), 2);
        assert_eq!(notifications[0].method, NOTIFY_TASK_EVENT);
        assert_eq!(notifications[0].params["event"]["final"], Value::Bool(true));
        assert_eq!(notifications[1].method, NOTIFY_PUSH);
        assert_eq!(
            notifications[1].params["token"],
            Value::String("secret".into())
        );
    }

    #[test]
    fn completing_a_task_routes_the_final_event_to_the_requester() {
        let (_dir, db) = open_db();
        let mut broker = A2aBroker::new();
        let alice = register(&mut broker, "ctx", "alice");
        let bob = register(&mut broker, "ctx", "bob");

        // alice (requester) creates a task for bob (worker).
        let (created, notes) = broker
            .message_send(
                db.conn(),
                MessageSendParams {
                    token: alice.clone(),
                    message: text_message("m1", Some("bob"), None),
                    configuration: None,
                },
            )
            .unwrap();
        let task_id = created.task.id;
        assert_eq!(created.task.requester_name, "alice");
        // The new task is addressed to the worker.
        assert_eq!(notes[0].params["recipient"], Value::String("bob".into()));

        // bob completes the task; the final event must reach alice.
        let (done, notifications) = broker
            .tasks_status(
                db.conn(),
                TasksStatusParams {
                    token: bob,
                    id: task_id.clone(),
                    state: TaskState::Completed,
                    message: Some(text_message("done", None, Some(&task_id))),
                },
            )
            .unwrap();
        assert_eq!(done.task.status.state, TaskState::Completed);
        assert_eq!(notifications.len(), 1);
        assert_eq!(
            notifications[0].params["recipient"],
            Value::String("alice".into())
        );
        assert_eq!(notifications[0].params["event"]["final"], Value::Bool(true));
        // The completion message is stamped with bob's identity, not the client's.
        assert_eq!(
            done.task.status.message.unwrap().from.as_deref(),
            Some("bob")
        );
    }

    #[test]
    fn worker_reply_routes_event_to_the_requester() {
        let (_dir, db) = open_db();
        let mut broker = A2aBroker::new();
        let alice = register(&mut broker, "ctx", "alice");
        let bob = register(&mut broker, "ctx", "bob");

        let (created, _) = broker
            .message_send(
                db.conn(),
                MessageSendParams {
                    token: alice,
                    message: text_message("m1", Some("bob"), None),
                    configuration: None,
                },
            )
            .unwrap();
        let task_id = created.task.id;

        // bob replies on the same task; the event must wake alice.
        let (_, notifications) = broker
            .message_send(
                db.conn(),
                MessageSendParams {
                    token: bob,
                    message: text_message("m2", None, Some(&task_id)),
                    configuration: None,
                },
            )
            .unwrap();
        assert_eq!(
            notifications[0].params["recipient"],
            Value::String("alice".into())
        );
        assert_eq!(
            notifications[0].params["event"]["final"],
            Value::Bool(false)
        );
    }

    #[test]
    fn illegal_status_transition_is_rejected() {
        let (_dir, db) = open_db();
        let mut broker = A2aBroker::new();
        let alice = register(&mut broker, "ctx", "alice");
        let bob = register(&mut broker, "ctx", "bob");

        let (created, _) = broker
            .message_send(
                db.conn(),
                MessageSendParams {
                    token: alice,
                    message: text_message("m1", Some("bob"), None),
                    configuration: None,
                },
            )
            .unwrap();
        let task_id = created.task.id;

        broker
            .tasks_status(
                db.conn(),
                TasksStatusParams {
                    token: bob.clone(),
                    id: task_id.clone(),
                    state: TaskState::Completed,
                    message: None,
                },
            )
            .unwrap();

        // A terminal task never moves again.
        let err = broker
            .tasks_status(
                db.conn(),
                TasksStatusParams {
                    token: bob,
                    id: task_id,
                    state: TaskState::Working,
                    message: None,
                },
            )
            .unwrap_err();
        assert_eq!(err, A2aError::TaskTerminal);
    }

    #[test]
    fn send_cap_is_enforced_per_token() {
        let (_dir, db) = open_db();
        let mut broker = A2aBroker::new();
        let alice = register(&mut broker, "ctx", "alice");
        let _bob = register(&mut broker, "ctx", "bob");

        // Drive the counter to the cap without creating unbounded tasks: reuse a
        // single task via its taskId so only the send count grows.
        let (result, _) = broker
            .message_send(
                db.conn(),
                MessageSendParams {
                    token: alice.clone(),
                    message: text_message("m0", Some("bob"), None),
                    configuration: None,
                },
            )
            .unwrap();
        let task_id = result.task.id;
        // One send already used; drive to the cap.
        for i in 1..types::A2A_MAX_SENDS_PER_RUN {
            broker
                .message_send(
                    db.conn(),
                    MessageSendParams {
                        token: alice.clone(),
                        message: text_message(&format!("m{i}"), Some("bob"), Some(&task_id)),
                        configuration: None,
                    },
                )
                .unwrap();
        }
        let err = broker
            .message_send(
                db.conn(),
                MessageSendParams {
                    token: alice,
                    message: text_message("over", Some("bob"), Some(&task_id)),
                    configuration: None,
                },
            )
            .unwrap_err();
        assert_eq!(err, A2aError::SendCap);
    }

    #[test]
    fn text_is_truncated_and_oversized_files_are_rejected() {
        let (_dir, db) = open_db();
        let mut broker = A2aBroker::new();
        let alice = register(&mut broker, "ctx", "alice");
        let _bob = register(&mut broker, "ctx", "bob");

        let long = "x".repeat(types::A2A_MAX_TEXT_CHARS + 500);
        let mut message = text_message("m1", Some("bob"), None);
        message.parts = vec![Part::Text { text: long }];
        let (result, _) = broker
            .message_send(
                db.conn(),
                MessageSendParams {
                    token: alice.clone(),
                    message,
                    configuration: None,
                },
            )
            .unwrap();
        if let Part::Text { text } = &result.task.history[0].parts[0] {
            assert_eq!(text.chars().count(), types::A2A_MAX_TEXT_CHARS);
        } else {
            panic!("expected text part");
        }

        let oversized = "A".repeat((types::A2A_MAX_FILE_BYTES + 1024) * 4 / 3 + 8);
        let mut message = text_message("m2", Some("bob"), None);
        message.parts = vec![Part::File {
            file: types::FileContent {
                name: Some("big.bin".into()),
                mime_type: Some("application/octet-stream".into()),
                uri: None,
                bytes: Some(oversized),
            },
        }];
        let err = broker
            .message_send(
                db.conn(),
                MessageSendParams {
                    token: alice,
                    message,
                    configuration: None,
                },
            )
            .unwrap_err();
        assert_eq!(err, A2aError::PayloadTooLarge);
    }

    #[test]
    fn push_config_set_and_get_round_trip_through_broker() {
        let (_dir, db) = open_db();
        let mut broker = A2aBroker::new();
        let alice = register(&mut broker, "ctx", "alice");
        let _bob = register(&mut broker, "ctx", "bob");

        let (result, _) = broker
            .message_send(
                db.conn(),
                MessageSendParams {
                    token: alice.clone(),
                    message: text_message("m1", Some("bob"), None),
                    configuration: None,
                },
            )
            .unwrap();
        let task_id = result.task.id;

        let got = broker
            .push_config_get(
                db.conn(),
                PushConfigGetParams {
                    token: alice.clone(),
                    task_id: task_id.clone(),
                },
            )
            .unwrap();
        assert!(got.config.is_none());

        let config = types::PushNotificationConfig {
            id: "cfg".into(),
            url: None,
            token: Some("t".into()),
        };
        broker
            .push_config_set(
                db.conn(),
                PushConfigSetParams {
                    token: alice.clone(),
                    task_id: task_id.clone(),
                    config: config.clone(),
                },
            )
            .unwrap();
        let got = broker
            .push_config_get(
                db.conn(),
                PushConfigGetParams {
                    token: alice,
                    task_id,
                },
            )
            .unwrap();
        assert_eq!(got.config, Some(config));
    }

    #[test]
    fn task_serialization_matches_the_wire_contract() {
        let (_dir, db) = open_db();
        let mut broker = A2aBroker::new();
        let alice = register(&mut broker, "ctx", "alice");
        let _bob = register(&mut broker, "ctx", "bob");
        let (result, _) = broker
            .message_send(
                db.conn(),
                MessageSendParams {
                    token: alice,
                    message: text_message("m1", Some("bob"), None),
                    configuration: None,
                },
            )
            .unwrap();
        let json = serde_json::to_value(&result.task).unwrap();
        assert_eq!(json["kind"], Value::String("task".into()));
        assert_eq!(json["status"]["state"], Value::String("working".into()));
        assert_eq!(json["agentName"], Value::String("bob".into()));
        assert_eq!(json["history"][0]["from"], Value::String("alice".into()));
        assert!(json["history"][0]["parts"][0]["kind"] == Value::String("text".into()));
    }

    #[test]
    fn no_peers_is_rejected() {
        let (_dir, db) = open_db();
        let mut broker = A2aBroker::new();
        let solo = register(&mut broker, "ctx", "solo");
        let err = broker
            .message_send(
                db.conn(),
                MessageSendParams {
                    token: solo,
                    message: text_message("m1", None, None),
                    configuration: None,
                },
            )
            .unwrap_err();
        assert_eq!(err, A2aError::NoPeers);
    }
}
