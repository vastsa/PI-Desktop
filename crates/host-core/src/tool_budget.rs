use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

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
}

impl Drop for ToolPermit {
    fn drop(&mut self) {
        let mut state = self.budget.lock();
        state.release(&self.request);
        state.dispatch();
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
}

#[derive(Default)]
struct SessionUsage {
    active: usize,
    mutations: usize,
}

struct WaitingRequest {
    id: u64,
    request: Request,
    ready: Arc<Notify>,
    granted: bool,
}

#[derive(Default)]
struct BudgetState {
    active: usize,
    classes: [usize; 4],
    sessions: HashMap<String, SessionUsage>,
    waiting: VecDeque<WaitingRequest>,
    queued: usize,
    next_id: u64,
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
    fn can_admit(&self, request: &Request) -> bool {
        if self.active >= MAX_IN_FLIGHT_TOOLS
            || self.classes[request.class as usize] >= request.class.limit()
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
        self.active += 1;
        self.classes[request.class as usize] += 1;
        let usage = self.sessions.entry(request.session_id.clone()).or_default();
        usage.active += 1;
        if request.class == ToolClass::Mutation {
            usage.mutations += 1;
        }
    }

    fn release(&mut self, request: &Request) {
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
        if usage.active == 0 {
            self.sessions.remove(&request.session_id);
        }
    }

    fn dispatch(&mut self) {
        // Scan the bounded queue in arrival order. A blocked class/session
        // must not prevent unrelated runnable work from using spare capacity.
        for index in 0..self.waiting.len() {
            let entry = &self.waiting[index];
            if entry.granted || !self.can_admit(&entry.request) {
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
        if entry.granted {
            state.release(&entry.request);
        } else {
            state.queued -= 1;
        }
        state.dispatch();
    }
}

#[derive(Clone, Default)]
pub struct ToolBudget {
    state: Arc<Mutex<BudgetState>>,
}

impl ToolBudget {
    pub fn new() -> Self {
        Self::default()
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
        self.acquire_with_timeout(session_id, tool_name, QUEUE_WAIT)
            .await
    }

    async fn acquire_with_timeout(
        &self,
        session_id: &str,
        tool_name: &str,
        wait: Duration,
    ) -> Result<ToolPermit, AdmissionError> {
        let request = Request {
            session_id: session_id.to_string(),
            class: ToolClass::from_name(tool_name),
        };
        let ready = Arc::new(Notify::new());
        let guard = {
            let mut state = self.lock();
            if state.can_admit(&request) {
                state.reserve(&request);
                return Ok(ToolPermit {
                    budget: self.clone(),
                    request,
                });
            }
            let queue_depth = state.queued + 1;
            if queue_depth > MAX_QUEUED_TOOLS {
                return Err(AdmissionError::QueueFull { queue_depth });
            }
            let id = state.next_id;
            state.next_id = state.next_id.wrapping_add(1);
            state.queued += 1;
            state.waiting.push_back(WaitingRequest {
                id,
                request,
                ready: ready.clone(),
                granted: false,
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
