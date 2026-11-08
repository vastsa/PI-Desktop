//! Definition snapshots: the security-relevant subset of `ModeDefinition`
//! (`packages/shared/src/mode-definition.ts`) that the Host re-validates
//! before it trusts a snapshot for tool policy or gates. Unknown keys are
//! kept in the stored JSON but never interpreted here.

use std::collections::HashSet;

use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::{is_mode_id, mode_error_detail};
use crate::db::{ms_to_ts, now_ms};

pub const SNAPSHOT_VERSION: i64 = 1;
pub const MAX_SNAPSHOT_BYTES: usize = 256 * 1024;
const MAX_STAGES: usize = 16;
const MAX_GATES: usize = 8;
const MAX_ARTIFACTS: usize = 16;
const MAX_HEADINGS: usize = 32;
const MAX_HEADING_CHARS: usize = 200;
const MAX_COMMAND_CHARS: usize = 2_000;
const MAX_PATH_CHARS: usize = 300;
const MAX_RETRIES: i64 = 10;
const MAX_TIMEOUT_MINUTES: i64 = 60;
const MAX_TURNS: i64 = 10_000;
const MIN_TOKENS: i64 = 1_000;
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ModePermission {
    Agent,
    Contract,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModeDefinition {
    pub version: i64,
    pub id: String,
    pub permission: ModePermission,
    #[serde(default)]
    pub artifacts: Vec<ModeArtifact>,
    #[serde(default)]
    pub budget: ModeBudget,
    #[serde(default = "default_return_to")]
    pub return_to: String,
    #[serde(default)]
    pub stages: Vec<ModeStage>,
}

fn default_return_to() -> String {
    "agent".into()
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModeArtifact {
    pub id: String,
    pub path: String,
    #[serde(default)]
    pub template: Option<String>,
    #[serde(default)]
    pub required_headings: Vec<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModeBudget {
    #[serde(default)]
    pub max_turns: Option<i64>,
    #[serde(default)]
    pub max_tokens: Option<i64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModeStage {
    pub id: String,
    pub permission: ModePermission,
    #[serde(default, rename = "loop")]
    pub looping: bool,
    #[serde(default)]
    pub exit: Vec<ModeGate>,
    #[serde(default)]
    pub next: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", rename_all_fields = "camelCase")]
pub enum ModeGate {
    Require {
        artifact: String,
        #[serde(default)]
        on_fail: GateFailure,
    },
    Run {
        command: String,
        timeout_minutes: i64,
        #[serde(default)]
        on_fail: GateFailure,
    },
    Ask,
}

#[derive(Debug, Clone, Deserialize)]
pub struct GateFailure {
    #[serde(default = "default_retries")]
    pub retries: i64,
    #[serde(default)]
    pub goto: Option<String>,
}

fn default_retries() -> i64 {
    2
}

impl Default for GateFailure {
    fn default() -> Self {
        Self {
            retries: default_retries(),
            goto: None,
        }
    }
}

impl ModeDefinition {
    pub fn stage(&self, id: &str) -> Option<&ModeStage> {
        self.stages.iter().find(|stage| stage.id == id)
    }

    pub fn artifact(&self, id: &str) -> Option<&ModeArtifact> {
        self.artifacts.iter().find(|artifact| artifact.id == id)
    }

    pub fn is_staged(&self) -> bool {
        !self.stages.is_empty()
    }
}

/// A validated snapshot plus its canonical JSON and content hash.
#[derive(Debug, Clone)]
pub struct Snapshot {
    pub hash: String,
    pub json: String,
    pub value: Value,
    pub definition: ModeDefinition,
}

fn invalid(detail: impl std::fmt::Display) -> anyhow::Error {
    mode_error_detail("MODE_SNAPSHOT_INVALID", detail)
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// Validate a snapshot the client sent for `mode`.
pub fn validate(value: &Value, mode: &str) -> Result<Snapshot> {
    if !value.is_object() {
        return Err(invalid("modeSnapshot must be an object"));
    }
    let json = serde_json::to_string(value)?;
    if json.len() > MAX_SNAPSHOT_BYTES {
        return Err(invalid("modeSnapshot is larger than 256 KiB"));
    }
    let definition: ModeDefinition =
        serde_json::from_value(value.clone()).map_err(|error| invalid(error))?;
    check(&definition, mode)?;
    Ok(Snapshot {
        hash: sha256_hex(json.as_bytes()),
        json,
        value: value.clone(),
        definition,
    })
}

fn check(definition: &ModeDefinition, mode: &str) -> Result<()> {
    if definition.version != SNAPSHOT_VERSION {
        return Err(invalid("version must be 1"));
    }
    if !is_mode_id(&definition.id) || definition.id != mode {
        return Err(invalid("id must equal the session mode"));
    }
    if !is_mode_id(&definition.return_to) || definition.return_to == definition.id {
        return Err(invalid("returnTo must name another mode"));
    }
    let budget = &definition.budget;
    if budget
        .max_turns
        .is_some_and(|turns| !(1..=MAX_TURNS).contains(&turns))
    {
        return Err(invalid("budget.maxTurns is out of range"));
    }
    if budget
        .max_tokens
        .is_some_and(|tokens| !(MIN_TOKENS..=MAX_SAFE_INTEGER).contains(&tokens))
    {
        return Err(invalid("budget.maxTokens is out of range"));
    }
    if definition.artifacts.len() > MAX_ARTIFACTS {
        return Err(invalid("at most 16 artifacts"));
    }
    let mut artifact_ids = HashSet::new();
    for artifact in &definition.artifacts {
        if !is_mode_id(&artifact.id) || !artifact_ids.insert(artifact.id.as_str()) {
            return Err(invalid(format!("artifact id `{}` is invalid", artifact.id)));
        }
        if !valid_artifact_path(&artifact.path) {
            return Err(invalid(format!("artifact `{}` has an unsafe path", artifact.id)));
        }
        if artifact.required_headings.len() > MAX_HEADINGS
            || artifact.required_headings.iter().any(|heading| {
                heading.trim().is_empty() || heading.chars().count() > MAX_HEADING_CHARS
            })
        {
            return Err(invalid(format!(
                "artifact `{}` has invalid requiredHeadings",
                artifact.id
            )));
        }
    }
    if definition.stages.len() > MAX_STAGES {
        return Err(invalid("at most 16 stages"));
    }
    let mut stage_ids = HashSet::new();
    for stage in &definition.stages {
        if !is_mode_id(&stage.id) || !stage_ids.insert(stage.id.as_str()) {
            return Err(invalid(format!("stage id `{}` is invalid", stage.id)));
        }
    }
    for stage in &definition.stages {
        check_stage(stage, &stage_ids, &artifact_ids)?;
    }
    Ok(())
}

fn check_stage(
    stage: &ModeStage,
    stage_ids: &HashSet<&str>,
    artifact_ids: &HashSet<&str>,
) -> Result<()> {
    let at = &stage.id;
    if stage.exit.len() > MAX_GATES {
        return Err(invalid(format!("stage `{at}` has more than 8 exit gates")));
    }
    if let Some(next) = &stage.next {
        if !stage_ids.contains(next.as_str()) {
            return Err(invalid(format!("stage `{at}` names an unknown next stage")));
        }
    }
    let last = stage.exit.len().saturating_sub(1);
    for (index, gate) in stage.exit.iter().enumerate() {
        let on_fail = match gate {
            ModeGate::Require { artifact, on_fail } => {
                if !artifact_ids.contains(artifact.as_str()) {
                    return Err(invalid(format!(
                        "stage `{at}` gate {index} requires an undeclared artifact"
                    )));
                }
                on_fail
            }
            ModeGate::Run {
                command,
                timeout_minutes,
                on_fail,
            } => {
                if command.trim().is_empty() || command.chars().count() > MAX_COMMAND_CHARS {
                    return Err(invalid(format!(
                        "stage `{at}` gate {index} command is empty or too long"
                    )));
                }
                if !(1..=MAX_TIMEOUT_MINUTES).contains(timeout_minutes) {
                    return Err(invalid(format!(
                        "stage `{at}` gate {index} timeoutMinutes is out of range"
                    )));
                }
                on_fail
            }
            ModeGate::Ask => {
                if index != last {
                    return Err(invalid(format!(
                        "stage `{at}` ask gate must be the last gate"
                    )));
                }
                continue;
            }
        };
        if !(0..=MAX_RETRIES).contains(&on_fail.retries) {
            return Err(invalid(format!(
                "stage `{at}` gate {index} onFail.retries is out of range"
            )));
        }
        if let Some(goto) = &on_fail.goto {
            if !stage_ids.contains(goto.as_str()) {
                return Err(invalid(format!(
                    "stage `{at}` gate {index} onFail.goto names an unknown stage"
                )));
            }
        }
    }
    Ok(())
}

/// Workspace-relative POSIX path: no absolute or home prefix, no drive
/// letter, no `..` or empty segment, no trailing `/`. The only variable is
/// `{{run.id}}`, which resolves to a UUID.
pub fn valid_artifact_path(path: &str) -> bool {
    if path.is_empty()
        || path.chars().count() > MAX_PATH_CHARS
        || path.contains('\\')
        || path.contains('\0')
        || path.starts_with('/')
        || path.starts_with('~')
        || path.ends_with('/')
    {
        return false;
    }
    let bytes = path.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return false;
    }
    let resolved = substitute_run_id(path, "run-id");
    if resolved.contains("{{") || resolved.contains("}}") {
        return false;
    }
    resolved
        .split('/')
        .all(|segment| !segment.is_empty() && segment != "..")
}

/// Replace every `{{ run.id }}` (whitespace inside the braces allowed).
pub fn substitute_run_id(text: &str, run_id: &str) -> String {
    substitute(text, |name| (name == "run.id").then(|| run_id.to_string()))
}

/// Text-only `{{ name }}` substitution, mirroring `substituteModeVariables`:
/// unknown names stay as written.
pub fn substitute(text: &str, lookup: impl Fn(&str) -> Option<String>) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let Some(end) = after.find("}}") else {
            out.push_str(&rest[start..]);
            return out;
        };
        let inner = &after[..end];
        let replacement = (!inner.contains('{') && !inner.contains('}'))
            .then(|| lookup(inner.trim()))
            .flatten();
        match replacement {
            Some(value) => {
                out.push_str(&value);
                rest = &after[end + 2..];
            }
            None => {
                out.push_str("{{");
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

pub fn store(conn: &Connection, snapshot: &Snapshot) -> Result<()> {
    conn.prepare_cached(
        "INSERT OR IGNORE INTO mode_snapshots (hash, json, created_at) VALUES (?1, ?2, ?3)",
    )?
    .execute(params![snapshot.hash, snapshot.json, ms_to_ts(now_ms())])?;
    Ok(())
}

/// Load a stored snapshot. A row that no longer parses is reported, never
/// silently treated as a definition.
pub fn load(conn: &Connection, hash: &str) -> Result<Option<Snapshot>> {
    let json: Option<String> = conn
        .prepare_cached("SELECT json FROM mode_snapshots WHERE hash = ?1")?
        .query_row(params![hash], |row| row.get(0))
        .optional()?;
    let Some(json) = json else {
        return Ok(None);
    };
    let value: Value = serde_json::from_str(&json).map_err(|error| invalid(error))?;
    let definition: ModeDefinition =
        serde_json::from_value(value.clone()).map_err(|error| invalid(error))?;
    Ok(Some(Snapshot {
        hash: hash.to_string(),
        json,
        value,
        definition,
    }))
}

/// A snapshot a run or session references must exist.
pub fn require(conn: &Connection, hash: &str) -> Result<Snapshot> {
    load(conn, hash)?.ok_or_else(|| invalid("stored snapshot is missing"))
}
