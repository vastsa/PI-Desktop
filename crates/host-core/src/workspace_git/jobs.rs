//! Long git work as pollable jobs.
//!
//! The host-core RPC layer, the `pi-host` RPC client, and the RACP client all
//! have request budgets far shorter than a clone, and RACP has no progress
//! notification outside session events. A job id plus polling needs neither a
//! timeout exemption nor a new notification kind, and a desktop that
//! reconnects can resume polling.
//!
//! The table is process-local: a host restart forgets every job. The desktop
//! then reads the registry (`workspaceGit.list`) to learn what exists.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;
use tokio::sync::watch;

use super::WorkspaceGitError;

/// How many finished jobs are kept, and for how long.
pub const MAX_FINISHED_JOBS: usize = 64;
pub const FINISHED_RETENTION: Duration = Duration::from_secs(10 * 60);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum JobKind {
    Prepare,
    Push,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum JobState {
    Running,
    Succeeded,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum JobPhase {
    Queued,
    Cloning,
    Fetching,
    CreatingWorktree,
    RunningSetup,
    Pushing,
    Done,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pushed {
    pub branch: String,
    pub remote_head: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct JobError {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobProgress {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub percent: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// The wire shape of `WorkspaceGitJob`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub job_id: String,
    pub kind: JobKind,
    pub state: JobState,
    pub phase: JobPhase,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<JobProgress>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub setup_log_tail: Option<String>,
    /// A prepare job's worktree, on success.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree: Option<Value>,
    /// A push job's result, on success.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pushed: Option<Pushed>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<JobError>,
}

/// How a job ended.
#[derive(Debug, Clone, PartialEq)]
pub enum Outcome {
    Prepared(Value),
    Pushed(Pushed),
    Failed(WorkspaceGitError),
    Cancelled,
}

struct Entry {
    job: Job,
    /// `(installationId, sessionId)`: one running job per session.
    key: (String, String),
    cancel: watch::Sender<bool>,
    finished_at: Option<Instant>,
}

#[derive(Default)]
pub struct JobTable {
    entries: HashMap<String, Entry>,
}

/// Shared by the RPC handlers and the job tasks. A plain mutex, never held
/// across an await: job tasks must not need the host state lock to report a
/// phase.
pub type SharedJobs = Arc<Mutex<JobTable>>;

impl JobTable {
    /// Register a running job, or `WORKSPACE_GIT_BUSY` when the session
    /// already has one. Returns the job id and its cancellation signal.
    pub fn start(
        &mut self,
        kind: JobKind,
        installation_id: &str,
        session_id: &str,
    ) -> Result<(String, watch::Receiver<bool>), WorkspaceGitError> {
        self.prune(Instant::now());
        if let Some(job_id) = self.running_job(installation_id, session_id) {
            return Err(WorkspaceGitError::busy(job_id));
        }
        let (cancel, cancelled) = watch::channel(false);
        let job_id = self.insert(kind, installation_id, session_id, cancel);
        Ok((job_id, cancelled))
    }

    /// Record a job that needed no work, already finished.
    pub fn completed(
        &mut self,
        kind: JobKind,
        installation_id: &str,
        session_id: &str,
        outcome: Outcome,
    ) -> String {
        self.prune(Instant::now());
        let (cancel, _) = watch::channel(false);
        let job_id = self.insert(kind, installation_id, session_id, cancel);
        self.finish(&job_id, outcome);
        job_id
    }

    fn insert(
        &mut self,
        kind: JobKind,
        installation_id: &str,
        session_id: &str,
        cancel: watch::Sender<bool>,
    ) -> String {
        let job_id = uuid::Uuid::new_v4().to_string();
        self.entries.insert(
            job_id.clone(),
            Entry {
                job: Job {
                    job_id: job_id.clone(),
                    kind,
                    state: JobState::Running,
                    phase: JobPhase::Queued,
                    progress: None,
                    setup_log_tail: None,
                    worktree: None,
                    pushed: None,
                    error: None,
                },
                key: (installation_id.to_string(), session_id.to_string()),
                cancel,
                finished_at: None,
            },
        );
        job_id
    }

    #[cfg(test)]
    pub fn is_running(&self, installation_id: &str, session_id: &str) -> bool {
        self.running_job(installation_id, session_id).is_some()
    }

    pub fn running_job(&self, installation_id: &str, session_id: &str) -> Option<&str> {
        self.entries
            .values()
            .find(|entry| {
                entry.job.state == JobState::Running
                    && entry.key.0 == installation_id
                    && entry.key.1 == session_id
            })
            .map(|entry| entry.job.job_id.as_str())
    }

    pub fn set_phase(&mut self, job_id: &str, phase: JobPhase) {
        if let Some(entry) = self.entries.get_mut(job_id) {
            if entry.job.state == JobState::Running {
                if entry.job.phase != phase {
                    entry.job.progress = None;
                }
                entry.job.phase = phase;
            }
        }
    }

    pub fn set_progress(&mut self, job_id: &str, progress: Option<JobProgress>) {
        if let Some(entry) = self.entries.get_mut(job_id) {
            if entry.job.state == JobState::Running {
                entry.job.progress = progress;
            }
        }
    }

    pub fn set_setup_log_tail(&mut self, job_id: &str, log_tail: Option<String>) {
        if let Some(entry) = self.entries.get_mut(job_id) {
            if entry.job.state == JobState::Running {
                entry.job.setup_log_tail = log_tail;
            }
        }
    }

    pub fn finish(&mut self, job_id: &str, outcome: Outcome) {
        self.finish_at(job_id, outcome, Instant::now());
    }

    fn finish_at(&mut self, job_id: &str, outcome: Outcome, now: Instant) {
        let Some(entry) = self.entries.get_mut(job_id) else {
            return;
        };
        if entry.job.state != JobState::Running {
            return;
        }
        entry.finished_at = Some(now);
        entry.job.progress = None;
        match outcome {
            Outcome::Prepared(worktree) => {
                entry.job.state = JobState::Succeeded;
                entry.job.phase = JobPhase::Done;
                entry.job.worktree = Some(worktree);
            }
            Outcome::Pushed(pushed) => {
                entry.job.state = JobState::Succeeded;
                entry.job.phase = JobPhase::Done;
                entry.job.pushed = Some(pushed);
            }
            // A failed or cancelled job keeps the phase it stopped in.
            Outcome::Failed(error) => {
                entry.job.state = JobState::Failed;
                entry.job.error = Some(JobError {
                    code: error.code.to_string(),
                    message: error.message,
                });
            }
            Outcome::Cancelled => entry.job.state = JobState::Cancelled,
        }
        self.prune(now);
    }

    /// The job's current state, or `None` for an unknown or forgotten id.
    pub fn get(&mut self, job_id: &str) -> Option<Job> {
        self.prune(Instant::now());
        self.peek(job_id)
    }

    fn peek(&self, job_id: &str) -> Option<Job> {
        self.entries.get(job_id).map(|entry| entry.job.clone())
    }

    /// Ask a running job to stop. The job cleans up and reports `cancelled`
    /// itself; a finished job is left as it is.
    pub fn cancel(&mut self, job_id: &str) -> Result<(), WorkspaceGitError> {
        self.prune(Instant::now());
        let entry = self.entries.get(job_id).ok_or_else(job_not_found)?;
        if entry.job.state == JobState::Running {
            entry.cancel.send_replace(true);
        }
        Ok(())
    }

    /// Forget finished jobs older than the retention, then the oldest beyond
    /// the cap. A running job is never forgotten.
    fn prune(&mut self, now: Instant) {
        self.entries.retain(|_, entry| match entry.finished_at {
            Some(finished) => now.saturating_duration_since(finished) < FINISHED_RETENTION,
            None => true,
        });
        let mut finished: Vec<(Instant, String)> = self
            .entries
            .iter()
            .filter_map(|(id, entry)| entry.finished_at.map(|at| (at, id.clone())))
            .collect();
        if finished.len() > MAX_FINISHED_JOBS {
            finished.sort();
            let excess = finished.len() - MAX_FINISHED_JOBS;
            for (_, id) in finished.into_iter().take(excess) {
                self.entries.remove(&id);
            }
        }
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    #[cfg(test)]
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

pub fn job_not_found() -> WorkspaceGitError {
    WorkspaceGitError::new(
        "WORKSPACE_GIT_JOB_NOT_FOUND",
        "the job is unknown or its result has expired",
    )
}

/// Resolves when the job has been asked to stop; never otherwise.
pub async fn cancelled(signal: &mut watch::Receiver<bool>) {
    loop {
        if *signal.borrow() {
            return;
        }
        if signal.changed().await.is_err() {
            return std::future::pending().await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const INSTALLATION: &str = "00000000-0000-4000-8000-000000000000";

    fn pushed() -> Outcome {
        Outcome::Pushed(Pushed {
            branch: "pi-desktop/8b54618f6bc1".into(),
            remote_head: "a".repeat(40),
        })
    }

    #[test]
    fn a_job_reports_its_phase_and_its_terminal_result() {
        let mut table = JobTable::default();
        let (id, cancel) = table.start(JobKind::Prepare, INSTALLATION, "s-1").unwrap();
        assert!(!*cancel.borrow());
        assert!((1..=64).contains(&id.len()));
        let job = table.get(&id).unwrap();
        assert_eq!(
            serde_json::to_value(&job).unwrap(),
            serde_json::json!({ "jobId": id, "kind": "prepare", "state": "running", "phase": "queued" })
        );
        table.set_phase(&id, JobPhase::CreatingWorktree);
        assert_eq!(
            serde_json::to_value(table.get(&id).unwrap()).unwrap()["phase"],
            "creatingWorktree"
        );
        table.finish(
            &id,
            Outcome::Prepared(serde_json::json!({ "sessionId": "s-1" })),
        );
        assert_eq!(
            serde_json::to_value(table.get(&id).unwrap()).unwrap(),
            serde_json::json!({
                "jobId": id, "kind": "prepare", "state": "succeeded", "phase": "done",
                "worktree": { "sessionId": "s-1" },
            })
        );
        // A late phase update never reopens a finished job.
        table.set_phase(&id, JobPhase::RunningSetup);
        table.finish(&id, Outcome::Cancelled);
        let job = serde_json::to_value(table.get(&id).unwrap()).unwrap();
        assert_eq!(
            (&job["state"], &job["phase"]),
            (&"succeeded".into(), &"done".into())
        );
    }

    #[test]
    fn failures_and_cancellations_keep_the_phase_they_stopped_in() {
        let mut table = JobTable::default();
        let (failed, _cancel) = table.start(JobKind::Push, INSTALLATION, "s-1").unwrap();
        table.set_phase(&failed, JobPhase::Pushing);
        table.finish(
            &failed,
            Outcome::Failed(WorkspaceGitError::new(
                "WORKSPACE_GIT_AUTH_REQUIRED",
                "git push failed: 401",
            )),
        );
        assert_eq!(
            serde_json::to_value(table.get(&failed).unwrap()).unwrap(),
            serde_json::json!({
                "jobId": failed, "kind": "push", "state": "failed", "phase": "pushing",
                "error": { "code": "WORKSPACE_GIT_AUTH_REQUIRED", "message": "git push failed: 401" },
            })
        );
        let (cancelled, _cancel) = table.start(JobKind::Prepare, INSTALLATION, "s-2").unwrap();
        table.set_phase(&cancelled, JobPhase::Cloning);
        table.finish(&cancelled, Outcome::Cancelled);
        let job = serde_json::to_value(table.get(&cancelled).unwrap()).unwrap();
        assert_eq!(
            (&job["state"], &job["phase"]),
            (&"cancelled".into(), &"cloning".into())
        );
        let (ok, _cancel) = table.start(JobKind::Push, INSTALLATION, "s-3").unwrap();
        table.finish(&ok, pushed());
        assert_eq!(
            serde_json::to_value(table.get(&ok).unwrap()).unwrap()["pushed"],
            serde_json::json!({ "branch": "pi-desktop/8b54618f6bc1", "remoteHead": "a".repeat(40) })
        );
    }

    #[test]
    fn one_session_runs_one_job_at_a_time() {
        let mut table = JobTable::default();
        let (first, _cancel) = table.start(JobKind::Prepare, INSTALLATION, "s-1").unwrap();
        for kind in [JobKind::Prepare, JobKind::Push] {
            let error = table.start(kind, INSTALLATION, "s-1").unwrap_err();
            assert_eq!(error.code, "WORKSPACE_GIT_BUSY");
        }
        assert!(table.is_running(INSTALLATION, "s-1"));
        // Another session, or the same session id of another installation.
        assert!(table.start(JobKind::Prepare, INSTALLATION, "s-2").is_ok());
        assert!(table
            .start(
                JobKind::Prepare,
                "11111111-1111-4111-8111-111111111111",
                "s-1"
            )
            .is_ok());
        table.finish(&first, pushed());
        assert!(!table.is_running(INSTALLATION, "s-1"));
        assert!(table.start(JobKind::Push, INSTALLATION, "s-1").is_ok());
    }

    #[test]
    fn cancel_signals_a_running_job_and_rejects_an_unknown_id() {
        let mut table = JobTable::default();
        assert_eq!(
            table.cancel("nope").unwrap_err().code,
            "WORKSPACE_GIT_JOB_NOT_FOUND"
        );
        let (id, cancel) = table.start(JobKind::Prepare, INSTALLATION, "s-1").unwrap();
        table.cancel(&id).unwrap();
        assert!(*cancel.borrow());
        // Still running until the job itself has cleaned up and said so.
        assert!(table.is_running(INSTALLATION, "s-1"));
        table.finish(&id, Outcome::Cancelled);
        // Cancelling a finished job is not an error and changes nothing.
        table.cancel(&id).unwrap();
        assert_eq!(
            serde_json::to_value(table.get(&id).unwrap()).unwrap()["state"],
            "cancelled"
        );
    }

    #[test]
    fn a_completed_job_can_be_recorded_without_running() {
        let mut table = JobTable::default();
        let id = table.completed(
            JobKind::Prepare,
            INSTALLATION,
            "s-1",
            Outcome::Prepared(serde_json::json!({ "sessionId": "s-1" })),
        );
        let job = serde_json::to_value(table.get(&id).unwrap()).unwrap();
        assert_eq!(job["state"], "succeeded");
        assert_eq!(job["worktree"]["sessionId"], "s-1");
        assert!(!table.is_running(INSTALLATION, "s-1"));
    }

    #[test]
    fn finished_jobs_are_kept_for_ten_minutes_and_at_most_sixty_four() {
        let mut table = JobTable::default();
        let start = Instant::now();
        let mut ids = Vec::new();
        for index in 0..(MAX_FINISHED_JOBS + 6) {
            let (id, _cancel) = table
                .start(JobKind::Push, INSTALLATION, &format!("s-{index}"))
                .unwrap();
            table.finish_at(&id, pushed(), start + Duration::from_secs(index as u64));
            ids.push(id);
        }
        let (running, _cancel) = table.start(JobKind::Prepare, INSTALLATION, "live").unwrap();
        table.prune(start + Duration::from_secs(100));
        // The six oldest finished jobs are gone; a running job is never pruned.
        for id in &ids[..6] {
            assert!(table.peek(id).is_none());
        }
        for id in &ids[6..] {
            assert!(table.peek(id).is_some());
        }
        assert!(table.peek(&running).is_some());
        // Ten minutes after it finished, a job is forgotten.
        table.prune(start + Duration::from_secs(6) + FINISHED_RETENTION);
        assert!(table.peek(&ids[6]).is_none());
        assert!(table.peek(&ids[7]).is_some());
        table.prune(start + Duration::from_secs(24 * 3600));
        assert_eq!(table.len(), 1);
        assert!(table.peek(&running).is_some());
    }

    #[test]
    fn progress_and_setup_log_tail_track_running_jobs_and_reset_on_phase_or_finish() {
        let mut table = JobTable::default();
        let (id, _cancel) = table.start(JobKind::Prepare, INSTALLATION, "s-1").unwrap();
        table.set_phase(&id, JobPhase::Cloning);
        table.set_progress(
            &id,
            Some(JobProgress {
                percent: Some(42),
                detail: Some("Receiving objects".into()),
            }),
        );
        let job = serde_json::to_value(table.get(&id).unwrap()).unwrap();
        assert_eq!(
            job["progress"],
            serde_json::json!({ "percent": 42, "detail": "Receiving objects" })
        );
        assert!(job.get("setupLogTail").is_none());

        // Transitioning to a new phase clears stale progress from the previous phase.
        table.set_phase(&id, JobPhase::CreatingWorktree);
        let job = serde_json::to_value(table.get(&id).unwrap()).unwrap();
        assert_eq!(job["phase"], "creatingWorktree");
        assert!(job.get("progress").is_none());

        // Live setup log tail is exposed while running setup.
        table.set_phase(&id, JobPhase::RunningSetup);
        table.set_setup_log_tail(&id, Some("installing dependencies...\n".into()));
        let job = serde_json::to_value(table.get(&id).unwrap()).unwrap();
        assert_eq!(job["setupLogTail"], "installing dependencies...\n");

        // Finishing clears progress and ignores subsequent updates.
        table.set_progress(
            &id,
            Some(JobProgress {
                percent: Some(99),
                detail: Some("Writing objects".into()),
            }),
        );
        table.finish(
            &id,
            Outcome::Prepared(serde_json::json!({ "sessionId": "s-1" })),
        );
        table.set_progress(
            &id,
            Some(JobProgress {
                percent: Some(50),
                detail: Some("Receiving objects".into()),
            }),
        );
        table.set_setup_log_tail(&id, Some("late update".into()));
        let finished = serde_json::to_value(table.get(&id).unwrap()).unwrap();
        assert!(finished.get("progress").is_none());
        assert_eq!(finished["setupLogTail"], "installing dependencies...\n");
    }
}
