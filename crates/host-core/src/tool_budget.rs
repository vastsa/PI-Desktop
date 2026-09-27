use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{Mutex, OwnedSemaphorePermit, Semaphore};

pub const MAX_IN_FLIGHT_TOOLS: usize = 16;
pub const MAX_IN_FLIGHT_SHELL: usize = 4;
pub const MAX_IN_FLIGHT_READS: usize = 8;
pub const MAX_IN_FLIGHT_MUTATIONS: usize = 2;
pub const MAX_IN_FLIGHT_MUTATIONS_PER_SESSION: usize = 1;
pub const MAX_IN_FLIGHT_PLUGINS: usize = 4;
pub const MAX_IN_FLIGHT_PER_SESSION: usize = 4;
pub const MAX_QUEUED_TOOLS: usize = 64;
const QUEUE_WAIT: Duration = Duration::from_secs(30);

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
    _total: OwnedSemaphorePermit,
    _class: OwnedSemaphorePermit,
    _session: OwnedSemaphorePermit,
    _session_mutation: Option<OwnedSemaphorePermit>,
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
pub struct ToolBudget {
    total: Arc<Semaphore>,
    reads: Arc<Semaphore>,
    mutations: Arc<Semaphore>,
    shell: Arc<Semaphore>,
    plugins: Arc<Semaphore>,
    sessions: Arc<Mutex<HashMap<String, Arc<Semaphore>>>>,
    session_mutations: Arc<Mutex<HashMap<String, Arc<Semaphore>>>>,
    queued: Arc<AtomicUsize>,
}

impl ToolBudget {
    pub fn new() -> Self {
        Self {
            total: Arc::new(Semaphore::new(MAX_IN_FLIGHT_TOOLS)),
            reads: Arc::new(Semaphore::new(MAX_IN_FLIGHT_READS)),
            mutations: Arc::new(Semaphore::new(MAX_IN_FLIGHT_MUTATIONS)),
            shell: Arc::new(Semaphore::new(MAX_IN_FLIGHT_SHELL)),
            plugins: Arc::new(Semaphore::new(MAX_IN_FLIGHT_PLUGINS)),
            sessions: Arc::new(Mutex::new(HashMap::new())),
            session_mutations: Arc::new(Mutex::new(HashMap::new())),
            queued: Arc::new(AtomicUsize::new(0)),
        }
    }

    pub async fn acquire(
        &self,
        session_id: &str,
        tool_name: &str,
    ) -> Result<ToolPermit, AdmissionError> {
        let class = ToolClass::from_name(tool_name);
        let class_semaphore = self.class_semaphore(class);
        let session_semaphore = self.session_semaphore(session_id).await;
        let session_mutation_semaphore = match class {
            ToolClass::Mutation => Some(self.session_mutation_semaphore(session_id).await),
            _ => None,
        };

        if let Some(permit) = Self::try_acquire(
            self.total.clone(),
            class_semaphore.clone(),
            session_semaphore.clone(),
            session_mutation_semaphore.clone(),
        ) {
            return Ok(permit);
        }

        let queue_depth = self.queued.fetch_add(1, Ordering::SeqCst) + 1;
        if queue_depth > MAX_QUEUED_TOOLS {
            self.queued.fetch_sub(1, Ordering::SeqCst);
            return Err(AdmissionError::QueueFull { queue_depth });
        }

        let result = tokio::time::timeout(
            QUEUE_WAIT,
            Self::acquire_all(
                self.total.clone(),
                class_semaphore,
                session_semaphore,
                session_mutation_semaphore,
            ),
        )
        .await;
        self.queued.fetch_sub(1, Ordering::SeqCst);

        match result {
            Ok(permit) => Ok(permit),
            Err(_) => Err(AdmissionError::QueueWaitTimeout),
        }
    }

    pub fn snapshot(&self) -> ToolBudgetSnapshot {
        let active = MAX_IN_FLIGHT_TOOLS - self.total.available_permits();
        ToolBudgetSnapshot {
            active,
            queued: self.queued.load(Ordering::SeqCst),
            total: MAX_IN_FLIGHT_TOOLS,
            shell: MAX_IN_FLIGHT_SHELL - self.shell.available_permits(),
            reads: MAX_IN_FLIGHT_READS - self.reads.available_permits(),
            mutations: MAX_IN_FLIGHT_MUTATIONS - self.mutations.available_permits(),
            plugins: MAX_IN_FLIGHT_PLUGINS - self.plugins.available_permits(),
        }
    }

    fn class_semaphore(&self, class: ToolClass) -> Arc<Semaphore> {
        match class {
            ToolClass::Read => self.reads.clone(),
            ToolClass::Mutation => self.mutations.clone(),
            ToolClass::Shell => self.shell.clone(),
            ToolClass::Plugin => self.plugins.clone(),
        }
    }

    async fn session_semaphore(&self, session_id: &str) -> Arc<Semaphore> {
        let mut sessions = self.sessions.lock().await;
        sessions
            .entry(session_id.to_string())
            .or_insert_with(|| Arc::new(Semaphore::new(MAX_IN_FLIGHT_PER_SESSION)))
            .clone()
    }

    async fn session_mutation_semaphore(&self, session_id: &str) -> Arc<Semaphore> {
        let mut sessions = self.session_mutations.lock().await;
        sessions
            .entry(session_id.to_string())
            .or_insert_with(|| Arc::new(Semaphore::new(MAX_IN_FLIGHT_MUTATIONS_PER_SESSION)))
            .clone()
    }

    fn try_acquire(
        total: Arc<Semaphore>,
        class: Arc<Semaphore>,
        session: Arc<Semaphore>,
        session_mutation: Option<Arc<Semaphore>>,
    ) -> Option<ToolPermit> {
        // Reserve the narrow per-session mutation slot first. This keeps a
        // queued second Write/Edit from consuming a global mutation permit
        // while it waits for the first mutation in the same session.
        let session_mutation_permit = match session_mutation {
            Some(semaphore) => Some(semaphore.try_acquire_owned().ok()?),
            None => None,
        };
        let total_permit = total.try_acquire_owned().ok()?;
        let class_permit = class.try_acquire_owned().ok()?;
        let session_permit = session.try_acquire_owned().ok()?;
        Some(ToolPermit {
            _total: total_permit,
            _class: class_permit,
            _session: session_permit,
            _session_mutation: session_mutation_permit,
        })
    }

    async fn acquire_all(
        total: Arc<Semaphore>,
        class: Arc<Semaphore>,
        session: Arc<Semaphore>,
        session_mutation: Option<Arc<Semaphore>>,
    ) -> ToolPermit {
        // Keep the per-session mutation permit outside the global capacity
        // wait so one session cannot reserve global slots while its earlier
        // mutation is still running.
        let session_mutation_permit = match session_mutation {
            Some(semaphore) => Some(
                semaphore
                    .acquire_owned()
                    .await
                    .expect("session mutation semaphore cannot be closed"),
            ),
            None => None,
        };
        let total_permit = total
            .acquire_owned()
            .await
            .expect("tool total semaphore cannot be closed");
        let class_permit = class
            .acquire_owned()
            .await
            .expect("tool class semaphore cannot be closed");
        let session_permit = session
            .acquire_owned()
            .await
            .expect("tool session semaphore cannot be closed");
        ToolPermit {
            _total: total_permit,
            _class: class_permit,
            _session: session_permit,
            _session_mutation: session_mutation_permit,
        }
    }
}

impl Default for ToolBudget {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::ToolBudget;
    use std::time::Duration;

    #[tokio::test]
    async fn limits_shell_concurrency_and_reports_active_work() {
        let budget = ToolBudget::new();
        let mut permits = Vec::new();
        for index in 0..4 {
            permits.push(
                budget
                    .acquire(&format!("session-{index}"), "Bash")
                    .await
                    .unwrap(),
            );
        }

        let snapshot = budget.snapshot();
        assert_eq!(snapshot.active, 4);
        assert_eq!(snapshot.shell, 4);
        assert_eq!(snapshot.queued, 0);

        let waiting_budget = budget.clone();
        let waiter =
            tokio::spawn(async move { waiting_budget.acquire("session-waiter", "Bash").await });
        drop(permits);
        assert!(waiter.await.unwrap().is_ok());
        assert_eq!(budget.snapshot().active, 0);
    }

    #[tokio::test]
    async fn separates_session_capacity() {
        let budget = ToolBudget::new();
        let mut first = Vec::new();
        for _ in 0..4 {
            first.push(budget.acquire("session-a", "Read").await.unwrap());
        }

        let second = budget.acquire("session-b", "Read").await;
        assert!(second.is_ok());
        let waiting_budget = budget.clone();
        let waiter = tokio::spawn(async move { waiting_budget.acquire("session-a", "Read").await });
        drop(first);
        assert!(waiter.await.unwrap().is_ok());
    }

    #[tokio::test]
    async fn serializes_mutations_within_a_session() {
        let budget = ToolBudget::new();
        let first = budget.acquire("session-a", "Edit").await.unwrap();
        let mut waiter = tokio::spawn({
            let budget = budget.clone();
            async move { budget.acquire("session-a", "Write").await }
        });

        assert!(tokio::time::timeout(Duration::from_millis(50), &mut waiter)
            .await
            .is_err());
        assert_eq!(budget.snapshot().mutations, 1);

        drop(first);
        assert!(tokio::time::timeout(Duration::from_secs(1), &mut waiter)
            .await
            .unwrap()
            .unwrap()
            .is_ok());
    }
}
