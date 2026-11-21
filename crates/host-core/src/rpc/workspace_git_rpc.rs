//! `workspaceGit.*`: git workspaces on a remote host (D687, decision record
//! `remote-git-workspaces`).
//!
//! `pi-host` calls these on behalf of a paired desktop that holds the owner
//! role. Callers name a repository and a session; no method accepts a worktree
//! path, and every name is re-validated here before a directory is created or
//! git is started. Clone, fetch, worktree creation, the setup script, and push
//! run as jobs the caller polls, so no request waits on git.
//!
//! The GitHub token never reaches this process. Network git is pointed at the
//! loopback credential proxy `pi-host` runs, by one per-command rewrite.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::{watch, Mutex};

use super::{command_shell_catalog, rpc_err, JsonRpcError};
use crate::session_worktrees::git::GitRunner;
use crate::session_worktrees::remove::is_real_dir;
use crate::state::AppState;
use crate::workspace_git::environment::{self, parse_proxy_url};
use crate::workspace_git::jobs::{
    self, JobKind, JobPhase, JobProgress, JobState, Outcome, Pushed, SharedJobs,
};
use crate::workspace_git::layout::{
    short_id, validate_branch, validate_installation_id, validate_session_id,
    validate_variable_name, work_branch, Layout, Repository,
};
use crate::workspace_git::registry::{self, SetupStatus, Variable, WorktreeRecord};
use crate::workspace_git::repository::{self, NetworkContext, Phase};
use crate::workspace_git::setup::{self, SetupRun};
use crate::workspace_git::worktree::{self, StartPoint};
use crate::workspace_git::WorkspaceGitError;

type SharedState = Arc<Mutex<AppState>>;

/// Numeric JSON-RPC code shared by every `WORKSPACE_GIT_*` error; `errorCode`
/// carries the specific reason.
const WORKSPACE_GIT_RPC_CODE: i64 = 1027;

/// Limits of the shared contract (`racp-workspace-git.ts`).
const MAX_VARIABLES: usize = 64;
const MAX_VARIABLE_VALUE_CHARS: usize = 8192;
const MAX_SETUP_SCRIPT_CHARS: usize = 65_536;

/// How long `workspaceGit.jobCancel` waits for the job to stop and clean up.
const CANCEL_WAIT: Duration = Duration::from_secs(10);
const CANCEL_POLL: Duration = Duration::from_millis(20);

fn to_rpc(error: WorkspaceGitError) -> JsonRpcError {
    let code = if error.code == "INVALID_ARGUMENT" {
        1002
    } else {
        WORKSPACE_GIT_RPC_CODE
    };
    let mut rpc = rpc_err(code, error.message, error.code);
    if let (Some(job_id), Some(data)) = (error.running_job_id, rpc.data.as_mut()) {
        data["jobId"] = json!(job_id);
    }
    rpc
}

fn not_found() -> WorkspaceGitError {
    WorkspaceGitError::new(
        "WORKSPACE_GIT_NOT_FOUND",
        "this host has no worktree for the session",
    )
}

/// What the handlers run git with. Production always clones from GitHub
/// through the proxy rewrite; only a test can point it somewhere else, and
/// only through this constructor, never through an RPC parameter.
#[derive(Default)]
pub(super) struct WorkspaceGitContext {
    git: GitRunner,
    remote_base: Option<String>,
}

impl WorkspaceGitContext {
    /// Clone `<base>/<owner>/<repo>.git` instead of the GitHub URL.
    #[cfg(test)]
    pub(super) fn with_remote_base(base: &str) -> Self {
        Self {
            git: GitRunner::default(),
            remote_base: Some(base.trim_end_matches('/').to_string()),
        }
    }

    #[cfg(test)]
    pub(super) fn with_git(mut self, git: GitRunner) -> Self {
        self.git = git;
        self
    }

    fn clone_url(&self, layout: &Layout, repository: &Repository) -> String {
        match &self.remote_base {
            Some(base) => format!("{base}/{}/{}.git", repository.owner, repository.name),
            None => layout.clone_url(repository),
        }
    }

    /// The per-command git configuration for a network operation: the proxy
    /// rewrite for this repository, and nothing of the host user's own
    /// credential helpers, askpass program, or HTTP proxy.
    pub(super) fn network_config(
        &self,
        proxy_url: &str,
        repository: &Repository,
    ) -> Vec<(String, String)> {
        match &self.remote_base {
            // A substituted remote is not GitHub: there is nothing to rewrite.
            Some(_) => environment::network_config(None, repository),
            None => environment::network_config(Some(proxy_url), repository),
        }
    }
}

// ---- parameters ---------------------------------------------------------------

#[derive(Deserialize)]
struct RepositoryInput {
    owner: String,
    name: String,
}

#[derive(Deserialize)]
struct VariableInput {
    name: String,
    value: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EnvironmentInput {
    variables: Vec<VariableInput>,
    #[serde(default)]
    setup_script: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RepositoryParams {
    workspaces_root: String,
    repository: RepositoryInput,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PrepareParams {
    workspaces_root: String,
    #[serde(default)]
    git_proxy: Option<Value>,
    installation_id: String,
    session_id: String,
    repository: RepositoryInput,
    base_branch: String,
    #[serde(default)]
    from_session_id: Option<String>,
    #[serde(default)]
    restore_only: bool,
    #[serde(default)]
    rerun_setup: bool,
    #[serde(default)]
    environment: Option<EnvironmentInput>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PushParams {
    workspaces_root: String,
    #[serde(default)]
    git_proxy: Option<Value>,
    installation_id: String,
    session_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionParams {
    installation_id: String,
    session_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoveParams {
    installation_id: String,
    session_id: String,
    force: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListParams {
    installation_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct JobParams {
    job_id: String,
}

fn parse<T: DeserializeOwned>(params: Value) -> Result<T, JsonRpcError> {
    serde_json::from_value(params).map_err(|error| {
        to_rpc(WorkspaceGitError::invalid(format!(
            "invalid params: {error}"
        )))
    })
}

fn layout(workspaces_root: &str) -> Result<Layout, WorkspaceGitError> {
    Layout::new(Path::new(workspaces_root))
}

fn session_key(installation_id: &str, session_id: &str) -> Result<(), WorkspaceGitError> {
    validate_installation_id(installation_id)?;
    validate_session_id(session_id)
}

/// `gitProxy: { url }`, required by the network methods.
fn proxy_url(git_proxy: Option<&Value>) -> Result<String, WorkspaceGitError> {
    parse_proxy_url(git_proxy.and_then(|proxy| proxy.get("url")))?
        .ok_or_else(|| WorkspaceGitError::invalid("gitProxy.url is required"))
}

/// A prepare request after every name and limit has been checked.
struct PrepareRequest {
    layout: Layout,
    proxy_url: String,
    installation_id: String,
    session_id: String,
    repository: Repository,
    base_branch: String,
    from_session_id: Option<String>,
    restore_only: bool,
    rerun_setup: bool,
    environment_provided: bool,
    variables: Vec<Variable>,
    setup_script: Option<String>,
}

impl PrepareRequest {
    fn validate(params: PrepareParams) -> Result<Self, WorkspaceGitError> {
        let layout = layout(&params.workspaces_root)?;
        let proxy_url = proxy_url(params.git_proxy.as_ref())?;
        session_key(&params.installation_id, &params.session_id)?;
        let repository = Repository::parse(&params.repository.owner, &params.repository.name)?;
        validate_branch(&params.base_branch)?;
        if let Some(from) = &params.from_session_id {
            validate_session_id(from)?;
        }
        let environment_provided = params.environment.is_some();
        let environment = params.environment.unwrap_or(EnvironmentInput {
            variables: Vec::new(),
            setup_script: None,
        });
        if environment.variables.len() > MAX_VARIABLES {
            return Err(WorkspaceGitError::invalid(
                "environment has too many variables",
            ));
        }
        let mut variables = Vec::with_capacity(environment.variables.len());
        for variable in environment.variables {
            validate_variable_name(&variable.name)?;
            if variable.value.chars().count() > MAX_VARIABLE_VALUE_CHARS
                || variable.value.contains('\0')
            {
                return Err(WorkspaceGitError::invalid(
                    "environment variable value is not allowed",
                ));
            }
            variables.push(Variable {
                name: variable.name,
                value: variable.value,
            });
        }
        if environment
            .setup_script
            .as_ref()
            .is_some_and(|script| script.chars().count() > MAX_SETUP_SCRIPT_CHARS)
        {
            return Err(WorkspaceGitError::invalid("setupScript is too long"));
        }
        Ok(Self {
            layout,
            proxy_url,
            installation_id: params.installation_id,
            session_id: params.session_id,
            repository,
            base_branch: params.base_branch,
            from_session_id: params.from_session_id,
            restore_only: params.restore_only,
            rerun_setup: params.rerun_setup,
            environment_provided,
            variables,
            // A blank script is no script.
            setup_script: environment
                .setup_script
                .filter(|script| !script.trim().is_empty()),
        })
    }

    fn work_branch(&self) -> String {
        work_branch(&self.installation_id, &self.session_id)
    }

    fn main_path(&self) -> PathBuf {
        self.layout.main_path(&self.repository)
    }

    fn worktree_path(&self) -> PathBuf {
        self.layout.worktree_path(
            &self.repository,
            &short_id(&self.installation_id, &self.session_id),
        )
    }
}

// ---- dispatch -----------------------------------------------------------------

pub(super) async fn handle(
    state: &SharedState,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    handle_with(
        state,
        &Arc::new(WorkspaceGitContext::default()),
        method,
        params,
    )
    .await
}

pub(super) async fn handle_with(
    state: &SharedState,
    context: &Arc<WorkspaceGitContext>,
    method: &str,
    params: Value,
) -> Result<Value, JsonRpcError> {
    match method {
        // Where a repository's main checkout lives on this host, and whether
        // it is cloned. No side effects: nothing is created.
        "workspaceGit.repository" => {
            let p: RepositoryParams = parse(params)?;
            let layout = layout(&p.workspaces_root).map_err(to_rpc)?;
            let repository =
                Repository::parse(&p.repository.owner, &p.repository.name).map_err(to_rpc)?;
            let path = layout.main_path(&repository);
            let cloned = is_real_dir(&path) && path.join(".git").is_dir();
            Ok(json!({ "path": path, "cloned": cloned }))
        }
        "workspaceGit.prepare" => {
            let request = PrepareRequest::validate(parse(params)?).map_err(to_rpc)?;
            start_prepare(state, context, request).await.map_err(to_rpc)
        }
        "workspaceGit.push" => {
            let p: PushParams = parse(params)?;
            start_push(state, context, p).await.map_err(to_rpc)
        }
        "workspaceGit.job" => {
            let p: JobParams = parse(params)?;
            let jobs = state.lock().await.workspace_git_jobs.clone();
            let job = lock(&jobs)
                .get(&p.job_id)
                .ok_or_else(|| to_rpc(jobs::job_not_found()))?;
            serde_json::to_value(job).map_err(|e| rpc_err(1000, e.to_string(), "INTERNAL"))
        }
        "workspaceGit.jobCancel" => {
            let p: JobParams = parse(params)?;
            let jobs = state.lock().await.workspace_git_jobs.clone();
            lock(&jobs).cancel(&p.job_id).map_err(to_rpc)?;
            // The job stops its git process and removes what it created. Wait
            // for that, so the caller can act on the session right away.
            let deadline = tokio::time::Instant::now() + CANCEL_WAIT;
            while tokio::time::Instant::now() < deadline {
                let running = lock(&jobs)
                    .get(&p.job_id)
                    .is_some_and(|job| job.state == JobState::Running);
                if !running {
                    break;
                }
                tokio::time::sleep(CANCEL_POLL).await;
            }
            Ok(json!({ "ok": true }))
        }
        "workspaceGit.status" => {
            let p: SessionParams = parse(params)?;
            status(state, context, &p).await.map_err(to_rpc)
        }
        "workspaceGit.removeSafely" => {
            let p: SessionParams = parse(params)?;
            remove(
                state,
                context,
                &RemoveParams {
                    installation_id: p.installation_id,
                    session_id: p.session_id,
                    force: false,
                },
            )
            .await
            .map_err(to_rpc)
        }
        "workspaceGit.remove" => {
            let p: RemoveParams = parse(params)?;
            remove(state, context, &p).await.map_err(to_rpc)
        }
        // Private host pipe only. The path is canonicalized by pi-host
        // after it resolves the authorized workspace tool root.
        "workspaceGit.scopeForPath" => {
            let root = params
                .get("path")
                .and_then(Value::as_str)
                .ok_or_else(|| to_rpc(WorkspaceGitError::invalid("path is required")))?;
            let st = state.lock().await;
            let scope = registry::find_by_path(&st.db, Path::new(root))
                .map_err(|error| to_rpc(error.into()))?
                .map(|record| {
                    json!({
                        "installationId": record.installation_id,
                        "sessionId": record.session_id,
                        "repository": record.repository,
                    })
                });
            Ok(json!({ "scope": scope }))
        }
        "workspaceGit.list" => {
            let p: ListParams = parse(params)?;
            validate_installation_id(&p.installation_id).map_err(to_rpc)?;
            let st = state.lock().await;
            let worktrees: Vec<Value> = registry::list_for_installation(&st.db, &p.installation_id)
                .map_err(|error| to_rpc(error.into()))?
                .iter()
                .map(WorktreeRecord::wire)
                .collect();
            Ok(json!({ "worktrees": worktrees }))
        }
        _ => Err(rpc_err(-32601, "method not found", "METHOD_NOT_FOUND")),
    }
}

fn lock(jobs: &SharedJobs) -> std::sync::MutexGuard<'_, jobs::JobTable> {
    jobs.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The session's record, read from the registry. Paths always come from here.
async fn mutation_lock(
    installation_id: &str,
    session_id: &str,
) -> tokio::sync::OwnedMutexGuard<()> {
    let lock_path = PathBuf::from(format!("workspace-git:{installation_id}:{session_id}"));
    crate::session_worktrees::repo_lock::lock(&lock_path).await
}

async fn record_of(
    state: &SharedState,
    installation_id: &str,
    session_id: &str,
) -> Result<Option<WorktreeRecord>, WorkspaceGitError> {
    let st = state.lock().await;
    Ok(registry::get(&st.db, installation_id, session_id)?)
}

// ---- prepare ------------------------------------------------------------------

async fn start_prepare(
    state: &SharedState,
    context: &Arc<WorkspaceGitContext>,
    request: PrepareRequest,
) -> Result<Value, WorkspaceGitError> {
    let _mutation = mutation_lock(&request.installation_id, &request.session_id).await;
    let (jobs, job_id, cancel) = {
        let st = state.lock().await;
        let jobs = st.workspace_git_jobs.clone();
        let mut table = lock(&jobs);
        // A running job wins over an existing record: during the setup script
        // the record already exists, and the session is still busy.
        if let Some(job_id) = table.running_job(&request.installation_id, &request.session_id) {
            return Err(WorkspaceGitError::busy(job_id));
        }
        // A retry after a lost reply, or a double click: the worktree exists,
        // so the answer is that worktree, not a second one.
        if let Some(mut record) =
            registry::get(&st.db, &request.installation_id, &request.session_id)?
        {
            if record.repository != request.repository {
                return Err(WorkspaceGitError::invalid(
                    "this session is already bound to another repository",
                ));
            }
            if is_real_dir(Path::new(&record.path)) {
                if !request.rerun_setup {
                    let job_id = table.completed(
                        JobKind::Prepare,
                        &request.installation_id,
                        &request.session_id,
                        Outcome::Prepared(record.wire()),
                    );
                    return Ok(json!({ "jobId": job_id }));
                }
                if request.environment_provided {
                    record.variables = request.variables.clone();
                    record.setup_script = request.setup_script.clone();
                }
                if record.setup_script.is_none() {
                    record.setup_status = SetupStatus::None;
                    record.setup_log_tail = None;
                    registry::insert(&st.db, &record)?;
                    let job_id = table.completed(
                        JobKind::Prepare,
                        &request.installation_id,
                        &request.session_id,
                        Outcome::Prepared(record.wire()),
                    );
                    return Ok(json!({ "jobId": job_id }));
                }
                record.setup_status = SetupStatus::Running;
                record.setup_log_tail = None;
                registry::insert(&st.db, &record)?;
            }
        } else if request.restore_only {
            return Err(not_found());
        }
        let (job_id, cancel) = table.start(
            JobKind::Prepare,
            &request.installation_id,
            &request.session_id,
        )?;
        drop(table);
        (jobs, job_id, cancel)
    };
    tokio::spawn(run_prepare(
        state.clone(),
        context.clone(),
        jobs,
        job_id.clone(),
        request,
        cancel,
    ));
    Ok(json!({ "jobId": job_id }))
}

async fn run_prepare(
    state: SharedState,
    context: Arc<WorkspaceGitContext>,
    jobs: SharedJobs,
    job_id: String,
    request: PrepareRequest,
    mut cancel: watch::Receiver<bool>,
) {
    // Dropping the git future kills its process (`kill_on_drop`) and removes
    // a half-written clone directory.
    let may_discard = match record_of(&state, &request.installation_id, &request.session_id).await {
        Ok(None) => matches!(
            std::fs::symlink_metadata(request.worktree_path()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound
        ),
        _ => false,
    };
    let created = tokio::select! {
        biased;
        _ = jobs::cancelled(&mut cancel) => None,
        result = create_worktree(&state, &context, &jobs, &job_id, &request) => Some(result),
    };
    let outcome = match created {
        None => Outcome::Cancelled,
        Some(Err(error)) => Outcome::Failed(error),
        Some(Ok(record)) => {
            run_setup(
                &state,
                &jobs,
                &job_id,
                &request,
                record,
                may_discard,
                cancel,
            )
            .await
        }
    };
    if outcome == Outcome::Cancelled
        && may_discard
        && matches!(
            record_of(&state, &request.installation_id, &request.session_id).await,
            Ok(Some(_))
        )
    {
        // A cancelled prepare leaves no worktree, record, or branch behind;
        // the main checkout stays.
        discard(&state, &context, &request).await;
    } else if !may_discard
        && (outcome == Outcome::Cancelled || matches!(outcome, Outcome::Failed(_)))
    {
        // Never leave an existing worktree stuck in `setup_status = Running`.
        if let Ok(Some(record)) =
            record_of(&state, &request.installation_id, &request.session_id).await
        {
            if record.setup_status == SetupStatus::Running {
                let note = match &outcome {
                    Outcome::Cancelled => "Setup was cancelled.".to_string(),
                    Outcome::Failed(error) => error.message.clone(),
                    _ => "Setup did not complete.".to_string(),
                };
                let st = state.lock().await;
                if let Err(error) = registry::set_setup(
                    &st.db,
                    &request.installation_id,
                    &request.session_id,
                    SetupStatus::Failed,
                    Some(note),
                ) {
                    tracing::warn!(%error, "could not recover setup status after failed rerun");
                }
            }
        }
    }
    lock(&jobs).finish(&job_id, outcome);
}

/// Ensure the main checkout, create the worktree, and register it.
async fn create_worktree(
    state: &SharedState,
    context: &WorkspaceGitContext,
    jobs: &SharedJobs,
    job_id: &str,
    request: &PrepareRequest,
) -> Result<WorktreeRecord, WorkspaceGitError> {
    let main_path = request.main_path();
    let worktree_path = request.worktree_path();
    let work_branch = request.work_branch();
    request.layout.ensure_private_directories()?;
    if let Some(mut record) =
        record_of(state, &request.installation_id, &request.session_id).await?
    {
        if request.rerun_setup && is_real_dir(Path::new(&record.path)) {
            return Ok(record);
        }
        lock(jobs).set_phase(job_id, JobPhase::CreatingWorktree);
        worktree::restore(
            &context.git,
            Path::new(&record.main_path),
            Path::new(&record.path),
            &record.work_branch,
        )
        .await?;
        if request.rerun_setup {
            if request.environment_provided {
                record.variables = request.variables.clone();
                record.setup_script = request.setup_script.clone();
            }
            record.setup_status = if record.setup_script.is_some() {
                SetupStatus::Running
            } else {
                SetupStatus::None
            };
            record.setup_log_tail = None;
            let st = state.lock().await;
            registry::insert(&st.db, &record)?;
        }
        return Ok(record);
    }
    if request.restore_only {
        return Err(not_found());
    }

    let config = context.network_config(&request.proxy_url, &request.repository);
    let config: Vec<(&str, &str)> = config
        .iter()
        .map(|(key, value)| (key.as_str(), value.as_str()))
        .collect();
    let on_progress = |progress: JobProgress| {
        lock(jobs).set_progress(job_id, Some(progress));
    };
    let network = NetworkContext {
        git: &context.git,
        config: &config,
        on_progress: Some(&on_progress),
    };
    let on_phase = |phase: Phase| {
        lock(jobs).set_phase(
            job_id,
            match phase {
                Phase::Cloning => JobPhase::Cloning,
                Phase::Fetching => JobPhase::Fetching,
            },
        );
    };
    let remote_url = context.clone_url(&request.layout, &request.repository);
    repository::ensure(&network, &remote_url, &main_path, &on_phase).await?;

    // A forked session starts at its parent's work branch as it is on this
    // host, including commits the parent never pushed.
    let parent_branch = match &request.from_session_id {
        Some(from) => {
            let parent = record_of(state, &request.installation_id, from).await?;
            match parent {
                Some(parent) if parent.repository == request.repository => Some(parent.work_branch),
                _ => return Err(not_found()),
            }
        }
        None => None,
    };
    let start = match &parent_branch {
        Some(branch) => StartPoint::LocalBranch(branch),
        None => StartPoint::RemoteBranch(&request.base_branch),
    };

    lock(jobs).set_phase(job_id, JobPhase::CreatingWorktree);
    let base_commit = worktree::create(
        &context.git,
        &main_path,
        &worktree_path,
        &work_branch,
        start,
    )
    .await?;

    register(state, request, &main_path, &worktree_path, base_commit).await
}

async fn register(
    state: &SharedState,
    request: &PrepareRequest,
    main_path: &Path,
    worktree_path: &Path,
    base_commit: String,
) -> Result<WorktreeRecord, WorkspaceGitError> {
    // Tool roots are canonicalized before they are matched against records.
    let path = crate::workspace::simple_canonicalize(worktree_path)?;
    let text = |path: &Path| {
        path.to_str()
            .map(str::to_string)
            .ok_or_else(|| WorkspaceGitError::invalid("path is not valid UTF-8"))
    };
    let record = WorktreeRecord {
        installation_id: request.installation_id.clone(),
        session_id: request.session_id.clone(),
        repository: request.repository.clone(),
        base_branch: request.base_branch.clone(),
        work_branch: request.work_branch(),
        path: text(&path)?,
        main_path: text(main_path)?,
        base_commit,
        created_at: crate::db::ms_to_ts(crate::db::now_ms()),
        variables: request.variables.clone(),
        setup_script: request.setup_script.clone(),
        setup_status: if request.setup_script.is_some() {
            SetupStatus::Running
        } else {
            SetupStatus::None
        },
        setup_log_tail: None,
    };
    let st = state.lock().await;
    registry::insert(&st.db, &record)?;
    Ok(record)
}

/// Run the environment's setup script, when there is one. A failing script
/// does not fail the job: the worktree is ready, and its setup status says so.
async fn run_setup(
    state: &SharedState,
    jobs: &SharedJobs,
    job_id: &str,
    request: &PrepareRequest,
    record: WorktreeRecord,
    may_discard: bool,
    cancel: watch::Receiver<bool>,
) -> Outcome {
    let Some(script) = record
        .setup_script
        .as_deref()
        .filter(|_| record.setup_status == SetupStatus::Running)
    else {
        return Outcome::Prepared(record.wire());
    };
    lock(jobs).set_phase(job_id, JobPhase::RunningSetup);
    let root = PathBuf::from(&record.path);
    let (shell_id, env) = {
        let st = state.lock().await;
        let shell_id = command_shell_catalog(&st)
            .ok()
            .and_then(|catalog| catalog.effective)
            .map(|shell| shell.id);
        let env = environment::for_tool(&st.db, &root, Some(&request.proxy_url));
        (shell_id, env)
    };
    let jobs_for_output = jobs.clone();
    let job_id_for_output = job_id.to_string();
    let on_output: Arc<dyn Fn(String) + Send + Sync> = Arc::new(move |tail: String| {
        lock(&jobs_for_output).set_setup_log_tail(&job_id_for_output, Some(tail));
    });
    let (status, log) = match shell_id {
        Some(shell_id) => {
            setup::run(SetupRun {
                root: &root,
                script,
                shell_id,
                env,
                session_id: &request.session_id,
                short_id: &short_id(&request.installation_id, &request.session_id),
                cancellation: cancel.clone(),
                on_output: Some(on_output),
            })
            .await
        }
        None => (
            SetupStatus::Failed,
            "no command shell is available on this host".to_string(),
        ),
    };
    if *cancel.borrow() {
        if !may_discard {
            let cancel_log = if log.trim().is_empty() {
                "Setup was cancelled.".to_string()
            } else {
                format!("{log}\n[setup cancelled]")
            };
            let st = state.lock().await;
            if let Err(error) = registry::set_setup(
                &st.db,
                &request.installation_id,
                &request.session_id,
                SetupStatus::Failed,
                Some(cancel_log),
            ) {
                tracing::warn!(%error, "could not record cancelled setup status");
            }
        }
        return Outcome::Cancelled;
    }
    let st = state.lock().await;
    let updated = registry::set_setup(
        &st.db,
        &request.installation_id,
        &request.session_id,
        status,
        Some(log),
    )
    .and_then(|()| registry::get(&st.db, &request.installation_id, &request.session_id));
    match updated {
        Ok(Some(record)) => Outcome::Prepared(record.wire()),
        Ok(None) => Outcome::Failed(not_found()),
        Err(error) => Outcome::Failed(error.into()),
    }
}

/// Undo a cancelled prepare: the record, the worktree, and its branch.
async fn discard(state: &SharedState, context: &WorkspaceGitContext, request: &PrepareRequest) {
    {
        let st = state.lock().await;
        if let Err(error) = registry::remove(&st.db, &request.installation_id, &request.session_id)
        {
            tracing::warn!(%error, "could not remove a cancelled worktree record");
        }
    }
    if let Err(error) = worktree::remove(
        &context.git,
        &request.main_path(),
        &request.worktree_path(),
        &request.work_branch(),
    )
    .await
    {
        tracing::warn!(%error, "could not remove a cancelled worktree");
    }
}

// ---- push ---------------------------------------------------------------------

async fn start_push(
    state: &SharedState,
    context: &Arc<WorkspaceGitContext>,
    params: PushParams,
) -> Result<Value, WorkspaceGitError> {
    layout(&params.workspaces_root)?;
    let proxy_url = proxy_url(params.git_proxy.as_ref())?;
    session_key(&params.installation_id, &params.session_id)?;
    let _mutation = mutation_lock(&params.installation_id, &params.session_id).await;
    let (jobs, job_id, cancel, record) = {
        let st = state.lock().await;
        let jobs = st.workspace_git_jobs.clone();
        let mut table = lock(&jobs);
        if let Some(job_id) = table.running_job(&params.installation_id, &params.session_id) {
            return Err(WorkspaceGitError::busy(job_id));
        }
        let record = registry::get(&st.db, &params.installation_id, &params.session_id)?
            .filter(|record| is_real_dir(Path::new(&record.path)))
            .ok_or_else(not_found)?;
        let (job_id, cancel) =
            table.start(JobKind::Push, &params.installation_id, &params.session_id)?;
        drop(table);
        (jobs, job_id, cancel, record)
    };
    tokio::spawn(run_push(
        context.clone(),
        jobs,
        job_id.clone(),
        record,
        proxy_url,
        cancel,
    ));
    Ok(json!({ "jobId": job_id }))
}

async fn run_push(
    context: Arc<WorkspaceGitContext>,
    jobs: SharedJobs,
    job_id: String,
    record: WorktreeRecord,
    proxy_url: String,
    mut cancel: watch::Receiver<bool>,
) {
    lock(&jobs).set_phase(&job_id, JobPhase::Pushing);
    let outcome = match record.repository.validated() {
        Err(error) => Outcome::Failed(error),
        Ok(repository) => {
            let config = context.network_config(&proxy_url, &repository);
            let config: Vec<(&str, &str)> = config
                .iter()
                .map(|(key, value)| (key.as_str(), value.as_str()))
                .collect();
            let on_progress = |progress: JobProgress| {
                lock(&jobs).set_progress(&job_id, Some(progress));
            };
            let network = NetworkContext {
                git: &context.git,
                config: &config,
                on_progress: Some(&on_progress),
            };
            let pushed = tokio::select! {
                biased;
                _ = jobs::cancelled(&mut cancel) => None,
                result = worktree::push(&network, Path::new(&record.path), &record.work_branch) => Some(result),
            };
            match pushed {
                None => Outcome::Cancelled,
                Some(Err(error)) => Outcome::Failed(error),
                Some(Ok(remote_head)) => Outcome::Pushed(Pushed {
                    branch: record.work_branch.clone(),
                    remote_head,
                }),
            }
        }
    };
    lock(&jobs).finish(&job_id, outcome);
}

// ---- status and remove ----------------------------------------------------------

async fn status(
    state: &SharedState,
    context: &WorkspaceGitContext,
    params: &SessionParams,
) -> Result<Value, WorkspaceGitError> {
    session_key(&params.installation_id, &params.session_id)?;
    let record = record_of(state, &params.installation_id, &params.session_id)
        .await?
        .ok_or_else(not_found)?;
    let path = Path::new(&record.path);
    let main = Path::new(&record.main_path);
    let counts = if is_real_dir(path) {
        worktree::status(&context.git, path, &record.work_branch).await?
    } else {
        worktree::branch_status(&context.git, main, &record.work_branch, 0).await?
    };
    let ahead_of_base = worktree::commits_ahead_of_base(
        &context.git,
        main,
        &record.work_branch,
        &record.base_branch,
        &record.base_commit,
    )
    .await?;
    Ok(json!({
        "worktree": record.wire(),
        "aheadOfBase": ahead_of_base,
        "ahead": counts.ahead,
        "behind": counts.behind,
        "uncommittedFiles": counts.uncommitted_files,
        "unpushedCommits": counts.unpushed_commits,
        "pushedOnce": counts.pushed_once,
    }))
}

/// Remove a worktree and its local work branch. Without `force`, work that
/// would be lost (uncommitted files, commits no remote branch has) makes it
/// answer `removed: false` with the counts instead.
async fn remove(
    state: &SharedState,
    context: &WorkspaceGitContext,
    params: &RemoveParams,
) -> Result<Value, WorkspaceGitError> {
    session_key(&params.installation_id, &params.session_id)?;
    let _removal = mutation_lock(&params.installation_id, &params.session_id).await;
    let record = {
        let st = state.lock().await;
        if let Some(job_id) =
            lock(&st.workspace_git_jobs).running_job(&params.installation_id, &params.session_id)
        {
            return Err(WorkspaceGitError::busy(job_id));
        }
        registry::get(&st.db, &params.installation_id, &params.session_id)?.ok_or_else(not_found)?
    };
    let (removed, uncommitted_files, unpushed_commits) = worktree::remove_checked(
        &context.git,
        Path::new(&record.main_path),
        Path::new(&record.path),
        &record.work_branch,
        params.force,
    )
    .await?;
    if removed {
        let st = state.lock().await;
        registry::remove(&st.db, &params.installation_id, &params.session_id)?;
    }
    Ok(json!({
        "removed": removed, "uncommittedFiles": uncommitted_files, "unpushedCommits": unpushed_commits,
    }))
}
