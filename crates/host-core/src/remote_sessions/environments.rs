use std::collections::HashSet;

use anyhow::{ensure, Result};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::db::{ms_to_ts, now_ms, Database, RemoteWorkspace};
use crate::workspace_git::layout::validate_variable_name;
use crate::workspace_git::registry::Variable;

const NS: &str = "remoteEnvironments";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Input {
    id: Option<String>,
    name: String,
    host_key: String,
    #[serde(default)]
    setup_script: String,
    #[serde(default)]
    variables: Vec<Variable>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Environment {
    id: String,
    name: String,
    host_key: String,
    setup_script: String,
    variables: Vec<Variable>,
    created_at: String,
    updated_at: String,
}

pub fn list(db: &Database) -> Result<Vec<Environment>> {
    db.kv_entries(NS)?
        .into_iter()
        .map(|(_, value)| Ok(serde_json::from_value(value)?))
        .collect()
}

pub fn upsert(db: &Database, input: Input) -> Result<Environment> {
    RemoteWorkspace {
        host_key: input.host_key.clone(),
        path: "/".into(),
    }
    .validate()?;
    let name = input.name.trim();
    ensure!(
        !name.is_empty() && name.chars().count() <= 80 && !name.chars().any(char::is_control),
        "invalid environment name"
    );
    ensure!(
        input.setup_script.chars().count() <= 65_536 && !input.setup_script.contains('\0'),
        "invalid setup script"
    );
    ensure!(
        input.variables.len() <= 64,
        "too many environment variables"
    );
    let mut names = HashSet::new();
    for variable in &input.variables {
        validate_variable_name(&variable.name)?;
        ensure!(
            names.insert(&variable.name),
            "duplicate environment variable"
        );
        ensure!(
            variable.value.chars().count() <= 8192 && !variable.value.contains('\0'),
            "invalid environment variable value"
        );
    }
    let id = input.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    if let Some(host) = id.strip_prefix("default:") {
        ensure!(host == input.host_key, "invalid default environment id");
    } else {
        uuid::Uuid::parse_str(&id)?;
    }
    let previous: Option<Environment> = db
        .kv_get(NS, &id)?
        .map(serde_json::from_value)
        .transpose()?;
    ensure!(
        previous
            .as_ref()
            .is_none_or(|previous| previous.host_key == input.host_key),
        "an existing environment cannot change hosts"
    );
    let now = ms_to_ts(now_ms());
    let environment = Environment {
        id,
        name: name.into(),
        host_key: input.host_key,
        setup_script: input.setup_script,
        variables: input.variables,
        created_at: previous.map_or_else(|| now.clone(), |e| e.created_at),
        updated_at: now,
    };
    db.kv_set(NS, &environment.id, &json!(environment))?;
    Ok(environment)
}

pub fn remove(db: &Database, id: &str) -> Result<bool> {
    if db.kv_get(NS, id)?.is_none() {
        return Ok(false);
    }
    db.kv_delete(NS, id)?;
    Ok(true)
}

pub fn remove_for_host(db: &Database, host_key: &str) -> Result<usize> {
    let mut removed = 0;
    for entry in list(db)? {
        if entry.host_key == host_key && remove(db, &entry.id)? {
            removed += 1;
        }
    }
    Ok(removed)
}
