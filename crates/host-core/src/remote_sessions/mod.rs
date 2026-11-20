pub mod bindings;
pub mod environments;

use anyhow::{ensure, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::db::{
    Database, ProjectGroupRecord, RemoteWorkspace, MAX_PROJECT_GROUP_NAME_CHARS,
    REMOTE_PROJECT_PREFIX,
};
use crate::workspace_git::layout::{validate_branch, Repository};

const PROJECTS: &str = "repositoryProjects";

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryProject {
    pub owner: String,
    pub name: String,
    pub default_branch: String,
    pub host_key: String,
}

pub fn marker(db: &Database, project_path: &str) -> Result<Option<RepositoryProject>> {
    let Some(id) = project_path.strip_prefix(REMOTE_PROJECT_PREFIX) else {
        return Ok(None);
    };
    db.kv_get(PROJECTS, id)?
        .map(|value| serde_json::from_value(value).map_err(Into::into))
        .transpose()
}

pub fn decorate_group(db: &Database, group: &ProjectGroupRecord) -> Result<Value> {
    let mut value = serde_json::to_value(group)?;
    if let Some(repository) = marker(db, &group.primary_path)? {
        value["repository"] = json!(repository);
    }
    Ok(value)
}

pub fn ensure_repository(
    db: &Database,
    remote: RemoteWorkspace,
    repository: Repository,
    default_branch: String,
) -> Result<(Value, bool)> {
    remote.validate()?;
    validate_branch(&default_branch)?;
    let existing = db
        .list_project_groups()?
        .into_iter()
        .find(|group| group.remote.as_ref() == Some(&remote));
    let stored_project = RepositoryProject {
        owner: repository.owner,
        name: repository.name,
        default_branch,
        host_key: remote.host_key.clone(),
    };
    let metadata = json!(stored_project);
    let created = existing.is_none();
    let group = match existing {
        Some(group) => {
            let stored = marker(db, &group.primary_path)?;
            ensure!(
                stored
                    .as_ref()
                    .is_some_and(|stored| stored.owner == stored_project.owner
                        && stored.name == stored_project.name),
                "the remote root already belongs to a different project"
            );
            db.kv_set(PROJECTS, &group.id, &metadata)?;
            group
        }
        None => {
            let name: String = format!("{}/{}", stored_project.owner, stored_project.name)
                .chars()
                .take(MAX_PROJECT_GROUP_NAME_CHARS)
                .collect();
            db.create_remote_project_group_with_metadata(
                &name,
                remote,
                Some((PROJECTS, &metadata)),
            )?
        }
    };
    Ok((decorate_group(db, &group)?, created))
}

pub fn scope(
    db: &Database,
    session_id: &str,
    project_path: &str,
) -> Result<(Option<RemoteWorkspace>, bool)> {
    let Some(project) = marker(db, project_path)? else {
        return Ok((db.remote_workspace_for_path(project_path)?, false));
    };
    let workspace = bindings::get(db, session_id)?.and_then(|binding| {
        if binding.state != bindings::State::Ready
            || binding.host_key != project.host_key
            || binding.repository.owner != project.owner
            || binding.repository.name != project.name
        {
            return None;
        }
        binding.path.map(|path| RemoteWorkspace {
            host_key: binding.target.host_key,
            path,
        })
    });
    Ok((workspace, true))
}
