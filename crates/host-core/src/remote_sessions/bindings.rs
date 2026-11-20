use anyhow::{ensure, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::db::{ms_to_ts, now_ms, Database, RemoteWorkspace};
use crate::workspace_git::layout::{validate_branch, Repository};

const BINDINGS: &str = "sessionWorkspaces";
const PENDING: &str = "pendingWorkspaceRemovals";

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum State {
    Preparing,
    Ready,
    Failed,
    Removing,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub session_id: String,
    pub environment_id: String,
    pub host_key: String,
    pub repository: Repository,
    pub base_branch: String,
    pub from_session_id: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Binding {
    #[serde(flatten)]
    pub target: Target,
    pub state: State,
    pub work_branch: Option<String>,
    pub path: Option<String>,
    pub job_id: Option<String>,
    pub error: Option<Value>,
    pub setup: Option<Value>,
    pub pull_request: Option<Value>,
    pub created_at: String,
    pub updated_at: String,
}

impl std::ops::Deref for Binding {
    type Target = Target;

    fn deref(&self) -> &Self::Target {
        &self.target
    }
}

impl Binding {
    pub fn public(&self) -> Value {
        let mut value = json!({
            "environmentId": self.environment_id,
            "hostKey": self.host_key,
            "repository": self.repository,
            "baseBranch": self.base_branch,
            "state": self.state,
        });
        for (key, optional) in [
            (
                "workBranch",
                self.work_branch.as_ref().map(|branch| json!(branch)),
            ),
            ("error", self.error.clone()),
            ("setup", self.setup.clone()),
            ("pullRequest", self.pull_request.clone()),
        ] {
            if let Some(optional) = optional {
                value[key] = optional;
            }
        }
        value
    }
}

pub fn get(db: &Database, id: &str) -> Result<Option<Binding>> {
    Ok(db
        .kv_get(BINDINGS, id)?
        .map(serde_json::from_value)
        .transpose()?)
}

pub fn list(db: &Database, states: &[State]) -> Result<Vec<Binding>> {
    let mut bindings = Vec::new();
    for (_, value) in db.kv_entries(BINDINGS)? {
        let binding: Binding = serde_json::from_value(value)?;
        if states.is_empty() || states.contains(&binding.state) {
            bindings.push(binding);
        }
    }
    Ok(bindings)
}

pub fn bind(db: &Database, mut target: Target) -> Result<Binding> {
    let summary =
        crate::sessions::session_summary(db, &target.session_id)?.context("session not found")?;
    let project = super::marker(db, summary.project_path.as_deref().unwrap_or_default())?
        .context("session is not in a repository project")?;
    let repository = target.repository.validated()?;
    ensure!(
        project.host_key == target.host_key
            && project.owner == repository.owner
            && project.name == repository.name,
        "session target does not match its repository project"
    );
    ensure!(
        get(db, &target.session_id)?.is_none(),
        "session already has a workspace"
    );
    validate_branch(&target.base_branch)?;
    ensure!(!target.environment_id.is_empty(), "missing environment id");
    target.repository = repository;
    let now = ms_to_ts(now_ms());
    let binding = Binding {
        target,
        state: State::Preparing,
        work_branch: None,
        path: None,
        job_id: None,
        error: None,
        setup: None,
        pull_request: None,
        created_at: now.clone(),
        updated_at: now,
    };
    db.kv_set(BINDINGS, &binding.session_id, &json!(binding))?;
    Ok(binding)
}

pub fn update(db: &Database, id: &str, patch: &serde_json::Map<String, Value>) -> Result<Binding> {
    let existing = get(db, id)?.context("session has no workspace")?;
    let mut updated = json!(existing);
    for (key, value) in patch {
        ensure!(
            matches!(
                key.as_str(),
                "state" | "workBranch" | "path" | "jobId" | "error" | "setup" | "pullRequest"
            ),
            "invalid workspace patch field"
        );
        updated[key] = value.clone();
    }
    let mut binding: Binding = serde_json::from_value(updated)?;
    if binding.state == State::Ready {
        validate_branch(
            binding
                .work_branch
                .as_deref()
                .context("missing work branch")?,
        )?;
        RemoteWorkspace {
            host_key: binding.host_key.clone(),
            path: binding.path.clone().context("missing worktree path")?,
        }
        .validate()?;
    }
    binding.updated_at = ms_to_ts(now_ms());
    db.kv_set(BINDINGS, id, &json!(binding))?;
    Ok(binding)
}

pub fn remove(db: &Database, id: &str) -> Result<()> {
    db.kv_delete(BINDINGS, id)
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingRemoval {
    pub host_key: String,
    pub session_id: String,
    pub repository: Repository,
    pub work_branch: Option<String>,
}

pub fn add_pending(db: &Database, removal: PendingRemoval) -> Result<()> {
    db.kv_set(
        PENDING,
        &format!("{}:{}", removal.host_key, removal.session_id),
        &json!(removal),
    )
}

pub fn pending(db: &Database, host_key: Option<&str>) -> Result<Vec<PendingRemoval>> {
    let mut removals = Vec::new();
    for (_, value) in db.kv_entries(PENDING)? {
        let removal: PendingRemoval = serde_json::from_value(value)?;
        if host_key.is_none_or(|key| removal.host_key == key) {
            removals.push(removal);
        }
    }
    Ok(removals)
}

pub fn remove_pending(db: &Database, host_key: &str, session_id: &str) -> Result<()> {
    db.kv_delete(PENDING, &format!("{host_key}:{session_id}"))
}
