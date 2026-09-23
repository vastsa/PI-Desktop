use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Weak};
use std::time::Duration;

use tokio::sync::{Mutex, OwnedMutexGuard, OwnedSemaphorePermit, Semaphore};

pub const MAX_IN_FLIGHT_TOOLS: usize = 16;
pub const MAX_IN_FLIGHT_SHELL: usize = 4;
pub const MAX_IN_FLIGHT_READS: usize = 8;
pub const MAX_IN_FLIGHT_MUTATIONS: usize = 2;
pub const MAX_IN_FLIGHT_MUTATIONS_PER_SESSION: usize = 1;
pub const MAX_IN_FLIGHT_PLUGINS: usize = 4;
pub const MAX_IN_FLIGHT_PER_SESSION: usize = 4;
pub const MAX_QUEUED_TOOLS: usize = 64;
/// How long a call waits for workspace, class and session admission. A call
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
    _total: OwnedSemaphorePermit,
    _class: OwnedSemaphorePermit,
    _session: OwnedSemaphorePermit,
    _session_mutation: Option<OwnedSemaphorePermit>,
    _workspace_mutation: Option<OwnedMutexGuard<()>>,
}

struct QueuedTool {
    queued: Arc<AtomicUsize>,
}

impl QueuedTool {
    fn enter(queued: Arc<AtomicUsize>) -> Result<Self, AdmissionError> {
        queued
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |depth| {
                (depth < MAX_QUEUED_TOOLS).then_some(depth + 1)
            })
            .map_err(|depth| AdmissionError::QueueFull {
                queue_depth: depth + 1,
            })?;
        Ok(Self { queued })
    }
}

impl Drop for QueuedTool {
    fn drop(&mut self) {
        self.queued.fetch_sub(1, Ordering::SeqCst);
    }
}

#[derive(Clone, Default)]
pub struct WorkspaceMutationLocks {
    locks: Arc<Mutex<HashMap<String, Weak<Mutex<()>>>>>,
}

impl WorkspaceMutationLocks {
    async fn lock_for(&self, root: &Path) -> Arc<Mutex<()>> {
        let key = crate::workspace::simple_canonicalize(root)
            .unwrap_or_else(|_| root.to_path_buf())
            .to_string_lossy()
            .to_string();
        let mut locks = self.locks.lock().await;
        locks.retain(|_, lock| lock.strong_count() > 0);
        if let Some(lock) = locks.get(&key).and_then(Weak::upgrade) {
            return lock;
        }
        let lock = Arc::new(Mutex::new(()));
        locks.insert(key, Arc::downgrade(&lock));
        lock
    }

    pub(crate) async fn acquire(&self, root: &Path) -> Result<OwnedMutexGuard<()>, AdmissionError> {
        tokio::time::timeout(QUEUE_WAIT, self.lock_for(root).await.lock_owned())
            .await
            .map_err(|_| AdmissionError::QueueWaitTimeout)
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
        workspace_root: Option<&Path>,
        workspace_locks: &WorkspaceMutationLocks,
    ) -> Result<ToolPermit, AdmissionError> {
        let deadline = tokio::time::Instant::now() + QUEUE_WAIT;
        let class = ToolClass::from_name(tool_name);
        let workspace_lock = if matches!(class, ToolClass::Mutation | ToolClass::Shell) {
            match workspace_root {
                Some(root) => Some(workspace_locks.lock_for(root).await),
                None => None,
            }
        } else {
            None
        };
        let class_semaphore = self.class_semaphore(class);
        let session_semaphore = self.session_semaphore(session_id).await;
        let session_mutation_semaphore = match class {
            ToolClass::Mutation => Some(self.session_mutation_semaphore(session_id).await),
            _ => None,
        };

        // Try every resource without waiting, releasing partial guards on failure.
        // In particular, never reserve class/total capacity behind a workspace lock.
        let workspace_mutation = match &workspace_lock {
            Some(lock) => lock.clone().try_lock_owned().map(Some),
            None => Ok(None),
        };
        if let Ok(workspace_mutation) = workspace_mutation {
            if let Some(mut permit) = Self::try_acquire(
                self.total.clone(),
                class_semaphore.clone(),
                session_semaphore.clone(),
                session_mutation_semaphore.clone(),
            ) {
                permit._workspace_mutation = workspace_mutation;
                return Ok(permit);
            }
        }

        let _queued = QueuedTool::enter(self.queued.clone())?;
        tokio::time::timeout_at(deadline, async {
            let workspace_mutation = match workspace_lock {
                Some(lock) => Some(lock.lock_owned().await),
                None => None,
            };
            let mut permit = Self::acquire_all(
                self.total.clone(),
                class_semaphore,
                session_semaphore,
                session_mutation_semaphore,
            )
            .await;
            permit._workspace_mutation = workspace_mutation;
            permit
        })
        .await
        .map_err(|_| AdmissionError::QueueWaitTimeout)
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
            _workspace_mutation: None,
        })
    }

    async fn acquire_all(
        total: Arc<Semaphore>,
        class: Arc<Semaphore>,
        session: Arc<Semaphore>,
        session_mutation: Option<Arc<Semaphore>>,
    ) -> ToolPermit {
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
            _workspace_mutation: None,
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
    use super::{AdmissionError, ToolBudget, WorkspaceMutationLocks, MAX_QUEUED_TOOLS, QUEUE_WAIT};
    use std::future::{poll_fn, Future};
    use std::path::Path;
    use std::pin::Pin;
    use std::task::Poll;
    use std::time::Duration;

    async fn assert_pending<F: Future>(mut future: Pin<&mut F>) {
        poll_fn(|cx| {
            assert!(future.as_mut().poll(cx).is_pending());
            Poll::Ready(())
        })
        .await;
    }

    #[tokio::test(start_paused = true)]
    async fn workspace_and_class_waits_share_one_deadline() {
        let budget = ToolBudget::new();
        let locks = WorkspaceMutationLocks::default();
        let root = Path::new("shared");
        let workspace = locks.acquire(root).await.unwrap();
        let mut holders = Vec::new();
        for index in 0..super::MAX_IN_FLIGHT_MUTATIONS {
            holders.push(
                budget
                    .acquire(&format!("holder-{index}"), "Edit", None, &locks)
                    .await
                    .unwrap(),
            );
        }
        let mut waiter = Box::pin(budget.acquire("waiter", "Write", Some(root), &locks));
        assert_pending(waiter.as_mut()).await;
        tokio::time::advance(Duration::from_secs(20)).await;
        drop(workspace);
        assert_pending(waiter.as_mut()).await;
        tokio::time::advance(Duration::from_secs(10)).await;
        let result = poll_fn(|cx| match waiter.as_mut().poll(cx) {
            Poll::Ready(result) => Poll::Ready(result),
            Poll::Pending => {
                panic!("workspace and class waits exceeded the single admission deadline")
            }
        })
        .await;
        assert!(matches!(result, Err(AdmissionError::QueueWaitTimeout)));
        assert_eq!(budget.snapshot().queued, 0);
        assert_eq!(budget.snapshot().active, holders.len());
        assert!(locks.lock_for(root).await.try_lock_owned().is_ok());
        drop(holders);
        assert!(budget
            .acquire("waiter", "Write", Some(root), &locks)
            .await
            .is_ok());
        assert_eq!(budget.snapshot().active, 0);
    }

    #[tokio::test(start_paused = true)]
    async fn workspace_and_class_waiters_share_queue_capacity() {
        let budget = ToolBudget::new();
        let locks = WorkspaceMutationLocks::default();
        let root = Path::new("shared");
        let workspace = locks.acquire(root).await.unwrap();
        let mut holders = Vec::new();
        for index in 0..super::MAX_IN_FLIGHT_SHELL {
            holders.push(
                budget
                    .acquire(&format!("holder-{index}"), "Bash", None, &locks)
                    .await
                    .unwrap(),
            );
        }
        let mut waiters = Vec::new();
        for index in 0..MAX_QUEUED_TOOLS {
            let workspace_root = if index == 0 { None } else { Some(root) };
            let mut waiter = Box::pin(budget.acquire("waiter", "Bash", workspace_root, &locks));
            assert_pending(waiter.as_mut()).await;
            // Refill Tokio's cooperative budget before polling the next admission.
            tokio::task::yield_now().await;
            waiters.push(waiter);
        }
        assert_eq!(budget.snapshot().queued, MAX_QUEUED_TOOLS);
        // Only the class waiter can reserve a total permit; workspace waiters cannot.
        assert_eq!(budget.snapshot().active, holders.len() + 1);
        let mut overflow = Box::pin(budget.acquire("overflow", "Edit", Some(root), &locks));
        let result = poll_fn(|cx| match overflow.as_mut().poll(cx) {
            Poll::Ready(result) => Poll::Ready(result),
            Poll::Pending => panic!("a full queue must reject workspace waiters immediately"),
        })
        .await;
        assert!(matches!(result, Err(AdmissionError::QueueFull { .. })));
        assert_eq!(budget.snapshot().queued, MAX_QUEUED_TOOLS);
        // Free capacity still takes the immediate path even when the queue is full.
        assert!(budget.acquire("reader", "Read", None, &locks).await.is_ok());
        // Queue rejection also releases a workspace acquired by the fast path.
        let other = Path::new("other");
        assert!(matches!(
            budget
                .acquire("overflow", "Bash", Some(other), &locks)
                .await,
            Err(AdmissionError::QueueFull { .. })
        ));
        assert!(locks.lock_for(other).await.try_lock_owned().is_ok());
        drop(waiters);
        assert_eq!(budget.snapshot().queued, 0);
        assert_eq!(budget.snapshot().active, holders.len());
        drop(workspace);
        drop(holders);
        assert!(budget
            .acquire("waiter", "Bash", Some(root), &locks)
            .await
            .is_ok());
    }

    #[tokio::test(start_paused = true)]
    async fn cancelled_workspace_waiter_releases_queue_slot() {
        let budget = ToolBudget::new();
        let locks = WorkspaceMutationLocks::default();
        let root = Path::new("shared");
        let holder = budget
            .acquire("holder", "Bash", Some(root), &locks)
            .await
            .unwrap();
        let mut waiter = Box::pin(budget.acquire("waiter", "Edit", Some(root), &locks));
        assert_pending(waiter.as_mut()).await;
        assert_eq!(budget.snapshot().queued, 1);
        assert_eq!(budget.snapshot().active, 1);
        assert_eq!(budget.snapshot().mutations, 0);
        drop(waiter);
        assert_eq!(budget.snapshot().queued, 0);
        drop(holder);
        let permit = budget
            .acquire("waiter", "Edit", Some(root), &locks)
            .await
            .unwrap();
        assert!(locks.lock_for(root).await.try_lock_owned().is_err());
        drop(permit);
        assert!(locks.lock_for(root).await.try_lock_owned().is_ok());
        assert_eq!(budget.snapshot().active, 0);
    }

    #[tokio::test(start_paused = true)]
    async fn cancelled_class_or_session_waiter_releases_queue_lock_and_permits() {
        for block_class in [true, false] {
            let budget = ToolBudget::new();
            let locks = WorkspaceMutationLocks::default();
            let root = Path::new("shared");
            let mut holders = Vec::new();
            let count = if block_class {
                super::MAX_IN_FLIGHT_MUTATIONS
            } else {
                super::MAX_IN_FLIGHT_PER_SESSION
            };
            for index in 0..count {
                let session = if block_class {
                    format!("holder-{index}")
                } else {
                    "waiter".to_string()
                };
                let tool = if block_class { "Edit" } else { "Read" };
                holders.push(budget.acquire(&session, tool, None, &locks).await.unwrap());
            }
            let mut waiter = Box::pin(budget.acquire("waiter", "Write", Some(root), &locks));
            assert_pending(waiter.as_mut()).await;
            assert_eq!(budget.snapshot().queued, 1);
            assert_eq!(budget.snapshot().active, holders.len() + 1);
            assert!(locks.lock_for(root).await.try_lock_owned().is_err());
            drop(waiter);
            assert_eq!(budget.snapshot().queued, 0);
            assert_eq!(budget.snapshot().active, holders.len());
            assert_eq!(
                budget.snapshot().mutations,
                if block_class { count } else { 0 }
            );
            assert!(locks.lock_for(root).await.try_lock_owned().is_ok());
            assert_eq!(
                budget
                    .session_mutation_semaphore("waiter")
                    .await
                    .available_permits(),
                1
            );
            drop(holders);
            assert!(budget
                .acquire("waiter", "Write", Some(root), &locks)
                .await
                .is_ok());
            assert_eq!(budget.snapshot().active, 0);
        }
    }

    #[tokio::test(start_paused = true)]
    async fn standalone_workspace_wait_remains_bounded() {
        let locks = WorkspaceMutationLocks::default();
        let root = Path::new("shared");
        let holder = locks.acquire(root).await.unwrap();
        let mut waiter = Box::pin(locks.acquire(root));
        assert_pending(waiter.as_mut()).await;
        tokio::time::advance(QUEUE_WAIT).await;
        assert!(matches!(
            waiter.await,
            Err(AdmissionError::QueueWaitTimeout)
        ));
        drop(holder);
        assert!(locks.acquire(root).await.is_ok());
    }

    #[tokio::test]
    async fn limits_shell_concurrency_and_reports_active_work() {
        let budget = ToolBudget::new();
        let locks = WorkspaceMutationLocks::default();
        let mut permits = Vec::new();
        for index in 0..4 {
            permits.push(
                budget
                    .acquire(&format!("session-{index}"), "Bash", None, &locks)
                    .await
                    .unwrap(),
            );
        }
        let snapshot = budget.snapshot();
        assert_eq!(snapshot.active, 4);
        assert_eq!(snapshot.shell, 4);
        let waiting_budget = budget.clone();
        let waiting_locks = locks.clone();
        let waiter = tokio::spawn(async move {
            waiting_budget
                .acquire("session-waiter", "Bash", None, &waiting_locks)
                .await
        });
        drop(permits);
        assert!(waiter.await.unwrap().is_ok());
    }

    #[tokio::test]
    async fn separates_session_capacity() {
        let budget = ToolBudget::new();
        let locks = WorkspaceMutationLocks::default();
        let mut first = Vec::new();
        for _ in 0..4 {
            first.push(
                budget
                    .acquire("session-a", "Read", None, &locks)
                    .await
                    .unwrap(),
            );
        }
        assert!(budget
            .acquire("session-b", "Read", None, &locks)
            .await
            .is_ok());
        drop(first);
    }

    #[tokio::test]
    async fn serializes_mutations_within_a_session() {
        let budget = ToolBudget::new();
        let locks = WorkspaceMutationLocks::default();
        let first = budget
            .acquire("session-a", "Edit", None, &locks)
            .await
            .unwrap();
        let mut waiter = tokio::spawn({
            let budget = budget.clone();
            let locks = locks.clone();
            async move { budget.acquire("session-a", "Write", None, &locks).await }
        });
        assert!(tokio::time::timeout(Duration::from_millis(50), &mut waiter)
            .await
            .is_err());
        drop(first);
        assert!(tokio::time::timeout(Duration::from_secs(1), waiter)
            .await
            .unwrap()
            .unwrap()
            .is_ok());
    }

    #[tokio::test]
    async fn serializes_same_workspace_across_sessions_but_not_other_workspaces() {
        let budget = ToolBudget::new();
        let locks = WorkspaceMutationLocks::default();
        let first = budget
            .acquire("session-a", "Bash", Some(Path::new("shared")), &locks)
            .await
            .unwrap();
        let mut same = tokio::spawn({
            let budget = budget.clone();
            let locks = locks.clone();
            async move {
                budget
                    .acquire("session-b", "Write", Some(Path::new("shared")), &locks)
                    .await
            }
        });
        assert!(budget
            .acquire("session-c", "Edit", Some(Path::new("other")), &locks)
            .await
            .is_ok());
        assert!(tokio::time::timeout(Duration::from_millis(50), &mut same)
            .await
            .is_err());
        drop(first);
        assert!(tokio::time::timeout(Duration::from_secs(1), same)
            .await
            .unwrap()
            .unwrap()
            .is_ok());
    }
}
