use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use crate::file_batches::{BatchCall, FileBatches};
use crate::file_resources::FileResources;
use tokio::sync::Notify;

pub const MAX_IN_FLIGHT_TOOLS: usize = 16;
pub const MAX_IN_FLIGHT_SHELL: usize = 4;
pub const MAX_IN_FLIGHT_READS: usize = 8;
pub const MAX_IN_FLIGHT_MUTATIONS: usize = 2;
pub const MAX_IN_FLIGHT_MUTATIONS_PER_SESSION: usize = 1;
pub const MAX_IN_FLIGHT_PLUGINS: usize = 4;
pub const MAX_IN_FLIGHT_PER_SESSION: usize = 4;
pub const MAX_QUEUED_TOOLS: usize = 64;
/// How long a call waits for execution capacity before admission fails. A call
/// waits here after the permission gate and before it runs, so the transport
/// deadline has to carry it too. Mirrored by `TOOL_QUEUE_WAIT_MS` in
/// `packages/shared/src/rpc-timeouts.ts`.
pub const TOOL_QUEUE_WAIT_MS: u64 = 30_000;
const QUEUE_WAIT: Duration = Duration::from_millis(TOOL_QUEUE_WAIT_MS);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ToolClass {
    Read,
    Mutation,
    Shell,
    Plugin,
}

impl ToolClass {
    fn from_name(tool_name: &str) -> Self {
        match tool_name {
            "Read" | "Glob" | "Grep" => Self::Read,
            "Write" | "Edit" => Self::Mutation,
            "Bash" => Self::Shell,
            _ => Self::Plugin,
        }
    }
}

#[derive(Debug)]
pub enum AdmissionError {
    QueueFull { queue_depth: usize },
    QueueWaitTimeout,
}

impl AdmissionError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::QueueFull { .. } | Self::QueueWaitTimeout => "HOST_OVERLOADED",
        }
    }

    pub fn message(&self) -> String {
        match self {
            Self::QueueFull { queue_depth } => format!(
                "host tool capacity is exhausted; bounded queue is full ({queue_depth} queued)"
            ),
            Self::QueueWaitTimeout => "host tool capacity did not become available in time".into(),
        }
    }
}

pub struct ToolPermit {
    budget: ToolBudget,
    request: Request,
    pub wait_ms: u64,
    pub initial_wait_reason: &'static str,
}

#[cfg(test)]
mod file_tests;

impl Drop for ToolPermit {
    fn drop(&mut self) {
        let mut state = self.budget.lock();
        state.release(&self.request);
        state.dispatch();
        drop(state);
        self.budget.released.notify_waiters();
    }
}

/// Owns a submitted ticket across permission, validation and admission failures.
/// Once running, only ToolPermit (also held by the disk task) may settle it.
pub struct PendingFileCall {
    budget: ToolBudget,
    ticket: String,
}

impl Drop for PendingFileCall {
    fn drop(&mut self) {
        let mut state = self.budget.lock();
        state.batches.finish(&self.ticket, false);
        state.dispatch();
    }
}

/// Marks a session whose exclusive permit is awaited; see `BudgetState::
/// exclusive_pending`.
struct PendingExclusive {
    budget: ToolBudget,
    session_id: String,
}

impl PendingExclusive {
    fn register(budget: &ToolBudget, session_id: &str) -> Self {
        *budget
            .lock()
            .exclusive_pending
            .entry(session_id.to_string())
            .or_default() += 1;
        Self {
            budget: budget.clone(),
            session_id: session_id.to_string(),
        }
    }
}

impl Drop for PendingExclusive {
    fn drop(&mut self) {
        let mut state = self.budget.lock();
        if let Some(count) = state.exclusive_pending.get_mut(&self.session_id) {
            *count -= 1;
            if *count == 0 {
                state.exclusive_pending.remove(&self.session_id);
            }
        }
        // Calls held back while the permit was awaited may run now (or
        // stay held by the granted exclusive permit).
        state.dispatch();
    }
}

/// See `ToolBudget::acquire_session_exclusive`.
pub struct SessionExclusivePermit {
    budget: ToolBudget,
    session_id: String,
}

impl Drop for SessionExclusivePermit {
    fn drop(&mut self) {
        let mut state = self.budget.lock();
        state.exclusive.remove(&self.session_id);
        state.dispatch();
        drop(state);
        self.budget.released.notify_waiters();
    }
}

#[derive(Debug, Clone, Copy)]
pub struct ToolBudgetSnapshot {
    pub active: usize,
    pub queued: usize,
    pub total: usize,
    pub shell: usize,
    pub reads: usize,
    pub mutations: usize,
    pub plugins: usize,
}

#[derive(Clone)]
struct Request {
    session_id: String,
    class: ToolClass,
    /// Runs in a subagent's own worktree (ADR 0329), so holding the session
    /// for work in the session worktree does not need to stop it.
    own_worktree: bool,
    resources: Option<Arc<FileResources>>,
    ticket: Option<String>,
}

#[derive(Default)]
struct SessionUsage {
    active: usize,
    mutations: usize,
    /// Of `active`, calls rooted in a subagent's own worktree.
    own_worktree: usize,
}

struct WaitingRequest {
    id: u64,
    request: Request,
    ready: Arc<Notify>,
    granted: bool,
    queued_at: Instant,
    initial_wait_reason: &'static str,
}

#[derive(Default)]
struct BudgetState {
    active: usize,
    classes: [usize; 4],
    sessions: HashMap<String, SessionUsage>,
    waiting: VecDeque<WaitingRequest>,
    queued: usize,
    next_id: u64,
    /// Sessions held by a `SessionExclusivePermit`.
    exclusive: HashSet<String>,
    /// Sessions whose exclusive permit is being awaited; their new calls wait
    /// too, so steady traffic cannot keep the session from ever going quiet.
    exclusive_pending: HashMap<String, usize>,
    batches: FileBatches,
    file_holders: Vec<Arc<FileResources>>,
}

impl ToolClass {
    fn limit(self) -> usize {
        match self {
            Self::Read => MAX_IN_FLIGHT_READS,
            Self::Mutation => MAX_IN_FLIGHT_MUTATIONS,
            Self::Shell => MAX_IN_FLIGHT_SHELL,
            Self::Plugin => MAX_IN_FLIGHT_PLUGINS,
        }
    }
}

impl BudgetState {
    fn wait_reason(&self, request: &Request) -> &'static str {
        if let Some(resources) = &request.resources {
            if request
                .ticket
                .as_deref()
                .is_some_and(|t| !self.batches.can_run(t, resources))
            {
                return "source_order";
            }
            if self.file_holders.iter().any(|r| r.conflicts(resources))
                || !self.can_pass_waiters(request, self.waiting.len())
            {
                return "resource";
            }
        }
        "capacity"
    }
    fn can_admit(&self, request: &Request) -> bool {
        if let Some(resources) = &request.resources {
            if self
                .file_holders
                .iter()
                .any(|held| held.conflicts(resources))
                || request
                    .ticket
                    .as_deref()
                    .is_some_and(|ticket| !self.batches.can_run(ticket, resources))
            {
                return false;
            }
        }
        if self.active >= MAX_IN_FLIGHT_TOOLS
            || self.classes[request.class as usize] >= request.class.limit()
        {
            return false;
        }
        if !request.own_worktree
            && (self.exclusive.contains(&request.session_id)
                || self.exclusive_pending.contains_key(&request.session_id))
        {
            return false;
        }
        self.sessions.get(&request.session_id).is_none_or(|usage| {
            usage.active < MAX_IN_FLIGHT_PER_SESSION
                && (request.class != ToolClass::Mutation
                    || usage.mutations < MAX_IN_FLIGHT_MUTATIONS_PER_SESSION)
        })
    }

    fn reserve(&mut self, request: &Request) {
        if let Some(resources) = &request.resources {
            self.file_holders.push(resources.clone());
        }
        if let Some(ticket) = &request.ticket {
            self.batches.start(ticket);
        }
        self.active += 1;
        self.classes[request.class as usize] += 1;
        let usage = self.sessions.entry(request.session_id.clone()).or_default();
        usage.active += 1;
        if request.class == ToolClass::Mutation {
            usage.mutations += 1;
        }
        if request.own_worktree {
            usage.own_worktree += 1;
        }
    }

    fn release(&mut self, request: &Request) {
        if let Some(resources) = &request.resources {
            if let Some(index) = self
                .file_holders
                .iter()
                .position(|held| Arc::ptr_eq(held, resources))
            {
                self.file_holders.remove(index);
            }
        }
        if let Some(ticket) = &request.ticket {
            self.batches.finish(ticket, true);
        }
        self.active -= 1;
        self.classes[request.class as usize] -= 1;
        let usage = self
            .sessions
            .get_mut(&request.session_id)
            .expect("admitted tool owns session capacity");
        usage.active -= 1;
        if request.class == ToolClass::Mutation {
            usage.mutations -= 1;
        }
        if request.own_worktree {
            usage.own_worktree -= 1;
        }
        if usage.active == 0 {
            self.sessions.remove(&request.session_id);
        }
    }

    fn dispatch(&mut self) {
        // Scan the bounded queue in arrival order. A blocked class/session
        // must not prevent unrelated runnable work from using spare capacity.
        for index in 0..self.waiting.len() {
            let entry = &self.waiting[index];
            if entry.granted
                || !self.can_admit(&entry.request)
                || !self.can_pass_waiters(&entry.request, index)
            {
                continue;
            }
            let request = entry.request.clone();
            self.reserve(&request);
            self.queued -= 1;
            let entry = &mut self.waiting[index];
            entry.granted = true;
            // notify_one retains a notification if acquire has not yet awaited.
            entry.ready.notify_one();
        }
    }

    fn can_pass_waiters(&self, request: &Request, before: usize) -> bool {
        let Some(resources) = &request.resources else {
            return true;
        };
        self.waiting.iter().take(before).all(|entry| {
            entry.granted
                || match &entry.request.resources {
                    Some(prior) => {
                        // An unready DAG successor cannot become a fairness
                        // barrier for another batch: that batch could otherwise
                        // block the successor's own predecessor and form a cycle.
                        if entry
                            .request
                            .ticket
                            .as_deref()
                            .is_some_and(|ticket| !self.batches.can_run(ticket, prior))
                        {
                            return true;
                        }
                        // Source-order predecessors must pass a later call that arrived
                        // first; otherwise RPC arrival fairness would deadlock the DAG.
                        let source_predecessor = match (&request.ticket, &entry.request.ticket) {
                            (Some(ours), Some(theirs)) => self.batches.precedes(ours, theirs),
                            _ => false,
                        };
                        source_predecessor || !resources.conflicts(prior)
                    }
                    None => true,
                }
        })
    }
}

// Own the queue entry across every await. Cancellation may occur after
// dispatch reserves capacity but before the caller receives its ToolPermit.
struct QueueGuard {
    budget: ToolBudget,
    id: Option<u64>,
}

impl QueueGuard {
    fn into_permit(mut self) -> ToolPermit {
        let mut state = self.budget.lock();
        let id = self.id.take().expect("waiting request has a queue id");
        let index = state
            .waiting
            .iter()
            .position(|entry| entry.id == id)
            .expect("waiting request remains registered until claimed");
        let entry = state.waiting.remove(index).expect("queue index exists");
        assert!(
            entry.granted,
            "notified request owns all execution capacity"
        );
        ToolPermit {
            budget: self.budget.clone(),
            request: entry.request,
            wait_ms: entry.queued_at.elapsed().as_millis() as u64,
            initial_wait_reason: entry.initial_wait_reason,
        }
    }
}

impl Drop for QueueGuard {
    fn drop(&mut self) {
        let Some(id) = self.id else {
            return;
        };
        let mut state = self.budget.lock();
        let index = state
            .waiting
            .iter()
            .position(|entry| entry.id == id)
            .expect("waiting request remains registered until cleanup");
        let entry = state.waiting.remove(index).expect("queue index exists");
        let released = entry.granted;
        if released {
            state.release(&entry.request);
        } else {
            state.queued -= 1;
        }
        state.dispatch();
        drop(state);
        if released {
            self.budget.released.notify_waiters();
        }
    }
}

#[derive(Clone, Default)]
pub struct ToolBudget {
    state: Arc<Mutex<BudgetState>>,
    /// Woken whenever a session's last tool finishes or an exclusive permit
    /// drops, for `acquire_session_exclusive`.
    released: Arc<Notify>,
}

impl ToolBudget {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register_file_call(&self, call: BatchCall) -> Result<String, &'static str> {
        self.lock().batches.register(call)
    }

    pub fn seal_file_batch(&self, batch: &str, session: &str) -> Result<(), &'static str> {
        self.lock().batches.seal(batch, session)
    }

    pub fn close_file_batch(&self, batch: &str, session: &str) -> Result<(), &'static str> {
        let mut state = self.lock();
        state.batches.close(batch, session)?;
        state.dispatch();
        Ok(())
    }

    pub fn abandon_file_call(&self, ticket: &str, session: &str) -> Result<(), &'static str> {
        let mut state = self.lock();
        state.batches.abandon(ticket, session)?;
        state.dispatch();
        Ok(())
    }

    pub fn begin_file_call(
        &self,
        ticket: &str,
        session: &str,
        delegation: Option<&str>,
        id: &str,
        name: &str,
        args: &serde_json::Value,
    ) -> Result<PendingFileCall, &'static str> {
        self.lock()
            .batches
            .begin(ticket, session, delegation, id, name, args)?;
        Ok(PendingFileCall {
            budget: self.clone(),
            ticket: ticket.into(),
        })
    }

    pub async fn acquire_files(
        &self,
        session: &str,
        name: &str,
        own_worktree: bool,
        resources: Arc<FileResources>,
        ticket: Option<String>,
    ) -> Result<ToolPermit, AdmissionError> {
        if let Some(ticket) = &ticket {
            let mut state = self.lock();
            state.batches.classify(ticket, resources.clone());
            state.dispatch();
        }
        self.acquire_request(
            Request {
                session_id: session.into(),
                class: ToolClass::from_name(name),
                own_worktree,
                resources: Some(resources),
                ticket,
            },
            QUEUE_WAIT,
        )
        .await
    }

    fn lock(&self) -> MutexGuard<'_, BudgetState> {
        // Only bounded in-memory bookkeeping runs under this synchronous lock.
        // No filesystem operation, callback, or await is allowed here.
        self.state
            .lock()
            .expect("tool budget state lock is not poisoned")
    }

    pub async fn acquire(
        &self,
        session_id: &str,
        tool_name: &str,
    ) -> Result<ToolPermit, AdmissionError> {
        self.acquire_with_timeout(session_id, tool_name, false, QUEUE_WAIT)
            .await
    }

    /// `acquire` for a call rooted in a subagent's own worktree: a session
    /// hold for the session worktree does not stop it.
    pub async fn acquire_in_own_worktree(
        &self,
        session_id: &str,
        tool_name: &str,
    ) -> Result<ToolPermit, AdmissionError> {
        self.acquire_with_timeout(session_id, tool_name, true, QUEUE_WAIT)
            .await
    }

    async fn acquire_with_timeout(
        &self,
        session_id: &str,
        tool_name: &str,
        own_worktree: bool,
        wait: Duration,
    ) -> Result<ToolPermit, AdmissionError> {
        let request = Request {
            session_id: session_id.to_string(),
            class: ToolClass::from_name(tool_name),
            own_worktree,
            resources: None,
            ticket: None,
        };
        self.acquire_request(request, wait).await
    }

    async fn acquire_request(
        &self,
        request: Request,
        wait: Duration,
    ) -> Result<ToolPermit, AdmissionError> {
        let ready = Arc::new(Notify::new());
        let guard = {
            let mut state = self.lock();
            if state.can_admit(&request) && state.can_pass_waiters(&request, state.waiting.len()) {
                state.reserve(&request);
                return Ok(ToolPermit {
                    budget: self.clone(),
                    request,
                    wait_ms: 0,
                    initial_wait_reason: "none",
                });
            }
            let queue_depth = state.queued + 1;
            if queue_depth > MAX_QUEUED_TOOLS {
                return Err(AdmissionError::QueueFull { queue_depth });
            }
            let id = state.next_id;
            state.next_id = state.next_id.wrapping_add(1);
            state.queued += 1;
            let initial_wait_reason = state.wait_reason(&request);
            state.waiting.push_back(WaitingRequest {
                id,
                request,
                ready: ready.clone(),
                granted: false,
                queued_at: Instant::now(),
                initial_wait_reason,
            });
            QueueGuard {
                budget: self.clone(),
                id: Some(id),
            }
        };
        match tokio::time::timeout(wait, ready.notified()).await {
            Ok(()) => Ok(guard.into_permit()),
            Err(_) => Err(AdmissionError::QueueWaitTimeout),
        }
    }

    /// Hold `session_id` alone: wait (at most `wait`) until none of its tools
    /// is in flight, then keep every new tool of that session queued until
    /// the permit drops. Used around git operations on an isolated session's
    /// worktree (ADR 0329) so a Bash or Write call cannot interleave with
    /// them. `None` when the session stayed busy; other sessions and global
    /// capacity are unaffected either way.
    pub async fn acquire_session_exclusive(
        &self,
        session_id: &str,
        wait: Duration,
    ) -> Option<SessionExclusivePermit> {
        let deadline = tokio::time::Instant::now() + wait;
        // Dropped on every exit, including cancellation of this future.
        let _pending = PendingExclusive::register(self, session_id);
        loop {
            // Registered before the check, so a release in between still wakes us.
            let released = self.released.notified();
            tokio::pin!(released);
            released.as_mut().enable();
            {
                let mut state = self.lock();
                let busy = state
                    .sessions
                    .get(session_id)
                    .is_some_and(|usage| usage.active > usage.own_worktree);
                if !busy && !state.exclusive.contains(session_id) {
                    state.exclusive.insert(session_id.to_string());
                    return Some(SessionExclusivePermit {
                        budget: self.clone(),
                        session_id: session_id.to_string(),
                    });
                }
            }
            if tokio::time::timeout_at(deadline, released).await.is_err() {
                return None;
            }
        }
    }

    pub fn snapshot(&self) -> ToolBudgetSnapshot {
        let state = self.lock();
        ToolBudgetSnapshot {
            active: state.active,
            queued: state.queued,
            total: MAX_IN_FLIGHT_TOOLS,
            shell: state.classes[ToolClass::Shell as usize],
            reads: state.classes[ToolClass::Read as usize],
            mutations: state.classes[ToolClass::Mutation as usize],
            plugins: state.classes[ToolClass::Plugin as usize],
        }
    }
}

#[cfg(test)]
mod tests;
