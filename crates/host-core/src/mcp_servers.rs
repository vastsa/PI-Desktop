use crate::activation::{ActivationMode, ActivationScope};
use crate::agent_capabilities::{
    capability_dir, file_timestamp, normalize_project_path, sorted_files, CapabilityLevel,
    CapabilityState,
};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::Path;

const MAX_SERVERS: usize = 128;
const MAX_ARGS: usize = 64;
const MAX_ENV_ENTRIES: usize = 64;
const MAX_HEADERS: usize = 32;
const MAX_VALUE_BYTES: usize = 4096;
const MCP_KIND: &str = "mcp";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct McpServerRecord {
    pub id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub level: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub transport: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub headers: BTreeMap<String, String>,
    pub enabled: bool,
    #[serde(default)]
    pub scope: ActivationScope,
    pub created_at: String,
    pub updated_at: String,
}

/// JSON stored in `.agents/servers/<id>.json`. Activation fields never enter
/// this file; they belong to the application-local capability state.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct McpConfig {
    id: String,
    label: String,
    #[serde(default)]
    description: Option<String>,
    transport: String,
    #[serde(default)]
    command: Option<String>,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    env: BTreeMap<String, String>,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    headers: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerInput {
    pub id: String,
    pub label: Option<String>,
    pub level: Option<String>,
    pub project_path: Option<String>,
    pub description: Option<String>,
    pub transport: Option<String>,
    pub command: Option<String>,
    pub args: Option<Vec<String>>,
    pub env: Option<BTreeMap<String, String>>,
    pub url: Option<String>,
    pub headers: Option<BTreeMap<String, String>>,
    pub enabled: Option<bool>,
    /// Kept for protocol compatibility; capability state is app-local instead.
    #[allow(dead_code)]
    pub scope: Option<ActivationScope>,
}

pub struct McpServerRegistry {
    state: CapabilityState,
}

fn valid_id(id: &str) -> bool {
    let mut chars = id.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    first.is_ascii_alphabetic()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn valid_env_key(key: &str) -> bool {
    let mut chars = key.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    (first.is_ascii_alphabetic() || first == '_')
        && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn valid_header_key(key: &str) -> bool {
    let mut chars = key.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    first.is_ascii_alphanumeric() && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

fn check_url(url: &str) -> Result<()> {
    let lower = url.trim().to_lowercase();
    let (scheme, rest) = lower
        .split_once("://")
        .ok_or_else(|| anyhow::anyhow!("MCP_INVALID: url must be absolute"))?;
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host_port = authority.rsplit('@').next().unwrap_or(authority);
    let host = if let Some(end) = host_port.find(']') {
        &host_port[..=end]
    } else {
        host_port.split(':').next().unwrap_or(host_port)
    };
    if host.is_empty() {
        bail!("MCP_INVALID: url must include a host");
    }
    match scheme {
        "http" | "https" => Ok(()),
        _ => bail!("MCP_INVALID: url must use http or https"),
    }
}

fn check_len(field: &str, value: &str) -> Result<()> {
    if value.len() > MAX_VALUE_BYTES {
        bail!("MCP_INVALID: {field} is too long");
    }
    Ok(())
}

fn level_and_project(input: &McpServerInput) -> Result<(CapabilityLevel, Option<String>)> {
    let level = CapabilityLevel::parse(input.level.as_deref())?;
    let project_path = input
        .project_path
        .as_deref()
        .map(normalize_project_path)
        .filter(|value| !value.is_empty());
    if level == CapabilityLevel::Project && project_path.is_none() {
        bail!("CAPABILITY_INVALID: projectPath is required for project MCP servers");
    }
    Ok((level, project_path))
}

fn scope_for(level: CapabilityLevel, project_path: Option<&str>) -> ActivationScope {
    match level {
        CapabilityLevel::Global => ActivationScope::default(),
        CapabilityLevel::Project => ActivationScope {
            mode: ActivationMode::Projects,
            projects: project_path.into_iter().map(str::to_string).collect(),
        },
    }
}

fn merge_active_records(
    global: Vec<McpServerRecord>,
    project: Vec<McpServerRecord>,
) -> Vec<McpServerRecord> {
    let mut result = global;
    for record in project {
        result.retain(|existing| {
            existing.id != record.id && !existing.label.eq_ignore_ascii_case(&record.label)
        });
        if record.enabled {
            result.push(record);
        }
    }
    result.retain(|record| record.enabled);
    result.sort_by(|a, b| a.label.to_lowercase().cmp(&b.label.to_lowercase()));
    result
}

impl McpServerRegistry {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            state: CapabilityState::new(data_dir, MCP_KIND),
        }
    }

    fn scan_level(
        &mut self,
        level: CapabilityLevel,
        project_path: Option<&str>,
        effective_project: Option<&str>,
    ) -> Result<Vec<McpServerRecord>> {
        let directory = capability_dir(level, project_path, "servers")?;
        let owner_project_path = if level == CapabilityLevel::Project {
            project_path.map(normalize_project_path)
        } else {
            None
        };
        let mut records = Vec::new();
        let mut seen = HashSet::new();
        for path in sorted_files(&directory, "json") {
            let raw = match fs::read_to_string(&path) {
                Ok(raw) => raw,
                Err(_) => continue,
            };
            let config = match serde_json::from_str::<McpConfig>(&raw) {
                Ok(config) => config,
                Err(_) => continue,
            };
            if !valid_id(&config.id) || !seen.insert(config.id.clone()) {
                continue;
            }
            let updated_at = file_timestamp(&path);
            let enabled = self
                .state
                .enabled(MCP_KIND, level, &config.id, effective_project);
            records.push(McpServerRecord {
                id: config.id,
                label: config.label,
                level: Some(level.as_str().to_string()),
                project_path: owner_project_path.clone(),
                path: Some(path.to_string_lossy().to_string()),
                description: config.description,
                transport: config.transport,
                command: config.command,
                args: config.args,
                env: config.env,
                url: config.url,
                headers: config.headers,
                enabled,
                scope: scope_for(level, owner_project_path.as_deref()),
                created_at: updated_at.clone(),
                updated_at,
            });
        }
        let ids = records.iter().map(|record| record.id.clone()).collect();
        self.state.prune(MCP_KIND, level, project_path, &ids)?;
        records.sort_by(|a, b| {
            a.label
                .to_lowercase()
                .cmp(&b.label.to_lowercase())
                .then(a.id.cmp(&b.id))
        });
        Ok(records)
    }

    pub fn list(
        &mut self,
        level: CapabilityLevel,
        project_path: Option<&str>,
    ) -> Result<Vec<McpServerRecord>> {
        let selected = project_path.map(normalize_project_path);
        self.scan_level(level, project_path, selected.as_deref())
    }

    /// Active runtime records with project definitions shadowing global records
    /// by id or label. The returned list already applies local enable state.
    pub fn active_for(&mut self, project_path: Option<&str>) -> Result<Vec<McpServerRecord>> {
        let selected = project_path.map(normalize_project_path);
        let global = self.scan_level(CapabilityLevel::Global, None, selected.as_deref())?;
        let project = selected
            .as_deref()
            .map(|path| self.scan_level(CapabilityLevel::Project, Some(path), Some(path)))
            .transpose()?
            .unwrap_or_default();
        Ok(merge_active_records(global, project))
    }

    fn find(
        &mut self,
        id: &str,
        level: Option<CapabilityLevel>,
        project_path: Option<&str>,
    ) -> Result<Option<McpServerRecord>> {
        if let Some(level) = level {
            return Ok(self
                .list(level, project_path)?
                .into_iter()
                .find(|record| record.id == id));
        }
        if let Some(project) = project_path {
            if let Some(record) = self
                .list(CapabilityLevel::Project, Some(project))?
                .into_iter()
                .find(|record| record.id == id)
            {
                return Ok(Some(record));
            }
        }
        Ok(self
            .list(CapabilityLevel::Global, project_path)?
            .into_iter()
            .find(|record| record.id == id))
    }

    fn validate_config(config: &McpConfig) -> Result<()> {
        if !valid_id(&config.id) {
            bail!("MCP_INVALID: id must match [a-zA-Z][a-zA-Z0-9_-]{{0,63}}");
        }
        if config.label.trim().is_empty() {
            bail!("MCP_INVALID: label is required");
        }
        check_len("label", &config.label)?;
        if let Some(description) = &config.description {
            check_len("description", description)?;
        }
        match config.transport.as_str() {
            "stdio" => {
                let command = config
                    .command
                    .as_deref()
                    .filter(|value| !value.trim().is_empty())
                    .ok_or_else(|| {
                        anyhow::anyhow!("MCP_INVALID: a stdio server requires command")
                    })?;
                if command.contains("..") {
                    bail!("MCP_INVALID: command must not contain \"..\"");
                }
                check_len("command", command)?;
                if config.args.len() > MAX_ARGS {
                    bail!("MCP_INVALID: at most {MAX_ARGS} args");
                }
                for arg in &config.args {
                    check_len("args", arg)?;
                }
                if config.env.len() > MAX_ENV_ENTRIES {
                    bail!("MCP_INVALID: at most {MAX_ENV_ENTRIES} env entries");
                }
                for (key, value) in &config.env {
                    if !valid_env_key(key) {
                        bail!("MCP_INVALID: env key \"{key}\" is not allowed");
                    }
                    check_len("env", value)?;
                }
                if config.url.is_some() || !config.headers.is_empty() {
                    bail!("MCP_INVALID: a stdio server must not set url or headers");
                }
            }
            "http" => {
                let url = config
                    .url
                    .as_deref()
                    .filter(|value| !value.trim().is_empty())
                    .ok_or_else(|| anyhow::anyhow!("MCP_INVALID: an http server requires url"))?;
                check_len("url", url)?;
                check_url(url)?;
                if config.command.is_some() || !config.args.is_empty() || !config.env.is_empty() {
                    bail!("MCP_INVALID: an http server must not set command, args or env");
                }
                if config.headers.len() > MAX_HEADERS {
                    bail!("MCP_INVALID: at most {MAX_HEADERS} headers");
                }
                for (key, value) in &config.headers {
                    if !valid_header_key(key) {
                        bail!("MCP_INVALID: header key \"{key}\" is not allowed");
                    }
                    check_len("headers", value)?;
                }
            }
            _ => bail!("MCP_INVALID: transport must be \"stdio\" or \"http\""),
        }
        Ok(())
    }

    pub fn upsert(&mut self, input: McpServerInput) -> Result<McpServerRecord> {
        let (level, project_path) = level_and_project(&input)?;
        let existing = self.find(&input.id, Some(level), project_path.as_deref())?;
        let same_level = self.list(level, project_path.as_deref())?;
        let current = existing.as_ref();
        let transport = input
            .transport
            .clone()
            .or_else(|| current.map(|record| record.transport.clone()))
            .unwrap_or_default();
        let label = input
            .label
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .or_else(|| current.map(|record| record.label.clone()))
            .unwrap_or_else(|| input.id.clone());
        if same_level
            .iter()
            .any(|record| record.id != input.id && record.label.eq_ignore_ascii_case(&label))
        {
            bail!("MCP_INVALID: a server with this name already exists at this level");
        }
        let previous_same_transport = current.filter(|record| record.transport == transport);
        let mut config = McpConfig {
            id: input.id.trim().to_string(),
            label,
            description: input
                .description
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .or_else(|| current.and_then(|record| record.description.clone())),
            transport,
            ..Default::default()
        };
        if config.transport == "stdio" {
            if input.url.is_some() || input.headers.is_some() {
                bail!("MCP_INVALID: a stdio server must not set url or headers");
            }
            config.command = input
                .command
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .or_else(|| previous_same_transport.and_then(|record| record.command.clone()));
            config.args = input
                .args
                .or_else(|| previous_same_transport.map(|record| record.args.clone()))
                .unwrap_or_default();
            config.env = input
                .env
                .or_else(|| previous_same_transport.map(|record| record.env.clone()))
                .unwrap_or_default();
        } else if config.transport == "http" {
            if input.command.is_some() || input.args.is_some() || input.env.is_some() {
                bail!("MCP_INVALID: an http server must not set command, args or env");
            }
            config.url = input
                .url
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .or_else(|| previous_same_transport.and_then(|record| record.url.clone()));
            config.headers = input
                .headers
                .or_else(|| previous_same_transport.map(|record| record.headers.clone()))
                .unwrap_or_default();
        }
        Self::validate_config(&config)?;
        if same_level.len() >= MAX_SERVERS && existing.is_none() {
            bail!("MCP_INVALID: at most {MAX_SERVERS} MCP servers");
        }
        let directory = capability_dir(level, project_path.as_deref(), "servers")?;
        fs::create_dir_all(&directory)?;
        let path = directory.join(format!("{}.json", config.id));
        fs::write(&path, serde_json::to_string_pretty(&config)?)
            .with_context(|| format!("write {}", path.display()))?;
        if let Some(enabled) = input.enabled {
            self.state.set_enabled(
                MCP_KIND,
                level,
                &config.id,
                project_path.as_deref(),
                enabled,
            )?;
        }
        self.find(&config.id, Some(level), project_path.as_deref())?
            .ok_or_else(|| anyhow::anyhow!("MCP_INVALID: saved server was not found"))
    }

    pub fn remove(
        &mut self,
        id: &str,
        level: Option<CapabilityLevel>,
        project_path: Option<&str>,
    ) -> Result<bool> {
        let Some(record) = self.find(id, level, project_path)? else {
            return Ok(false);
        };
        if let Some(path) = record.path.as_deref() {
            fs::remove_file(path).ok();
        }
        let record_level = record
            .level
            .as_deref()
            .map(|value| CapabilityLevel::parse(Some(value)))
            .transpose()?
            .unwrap_or(CapabilityLevel::Global);
        let _ = self.list(record_level, record.project_path.as_deref())?;
        Ok(true)
    }

    pub fn set_enabled(
        &mut self,
        id: &str,
        enabled: bool,
        level: Option<CapabilityLevel>,
        project_path: Option<&str>,
    ) -> Result<Option<McpServerRecord>> {
        let Some(record) = self.find(id, level, project_path)? else {
            return Ok(None);
        };
        let record_level = record
            .level
            .as_deref()
            .map(|value| CapabilityLevel::parse(Some(value)))
            .transpose()?
            .unwrap_or(CapabilityLevel::Global);
        self.state.set_enabled(
            MCP_KIND,
            record_level,
            &record.id,
            project_path.or(record.project_path.as_deref()),
            enabled,
        )?;
        self.find(
            &record.id,
            Some(record_level),
            project_path.or(record.project_path.as_deref()),
        )
    }

    pub fn set_scope(
        &mut self,
        id: &str,
        scope: ActivationScope,
    ) -> Result<Option<McpServerRecord>> {
        let _ = scope;
        self.find(id, None, None)
    }

    /// Compatibility lookup for older host callers; management uses level-aware list/find paths.
    #[allow(dead_code)]
    pub fn get(&mut self, id: &str) -> Option<McpServerRecord> {
        self.find(id, None, None).ok().flatten()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn stdio(id: &str) -> McpServerInput {
        McpServerInput {
            id: id.into(),
            transport: Some("stdio".into()),
            command: Some("npx".into()),
            args: Some(vec!["-y".into(), "server".into()]),
            ..Default::default()
        }
    }

    #[test]
    fn validation_accepts_http_endpoints_and_rejects_bad_ids() {
        assert!(!valid_id("1files"));
        assert!(check_url("http://localhost:3000/mcp").is_ok());
        assert!(check_url("http://192.168.1.20:8080/mcp").is_ok());
        assert!(check_url("https://example.com/mcp").is_ok());
        assert!(check_url("ftp://example.com/mcp").is_err());
        let mut config = McpConfig {
            id: "files".into(),
            label: "Files".into(),
            transport: "stdio".into(),
            command: Some("node..bin".into()),
            ..Default::default()
        };
        assert!(McpServerRegistry::validate_config(&config).is_err());
        config.command = Some("node".into());
        assert!(McpServerRegistry::validate_config(&config).is_ok());
    }

    #[test]
    fn config_round_trips_without_activation_fields() {
        let config = McpConfig {
            id: "files".into(),
            label: "Files".into(),
            transport: "stdio".into(),
            command: Some("npx".into()),
            ..Default::default()
        };
        let raw = serde_json::to_string(&config).unwrap();
        assert!(!raw.contains("enabled"));
        assert_eq!(serde_json::from_str::<McpConfig>(&raw).unwrap().id, "files");
    }

    #[test]
    fn disabled_project_server_shadows_global_server() {
        let global = McpServerRecord {
            id: "files".into(),
            label: "Files".into(),
            level: Some("global".into()),
            project_path: None,
            path: None,
            description: None,
            transport: "stdio".into(),
            command: Some("npx".into()),
            args: Vec::new(),
            env: BTreeMap::new(),
            url: None,
            headers: BTreeMap::new(),
            enabled: true,
            scope: ActivationScope::default(),
            created_at: String::new(),
            updated_at: String::new(),
        };
        let mut project = global.clone();
        project.level = Some("project".into());
        project.project_path = Some("/repo".into());
        project.enabled = false;

        let active = merge_active_records(vec![global], vec![project]);
        assert!(active.is_empty());
    }

    #[test]
    fn project_server_is_copied_and_state_is_pruned_after_removal() {
        let dir = tempdir().unwrap();
        let project_path = dir.path().to_str().unwrap().to_string();
        let mut registry = McpServerRegistry::new(dir.path());
        let mut first = stdio("files");
        first.label = Some("Files".into());
        first.level = Some("project".into());
        first.project_path = Some(project_path.clone());
        let record = registry.upsert(first).unwrap();
        let target = dir.path().join(".agents/servers/files.json");
        assert_eq!(record.path.as_deref(), target.to_str());
        assert!(!fs::read_to_string(&target).unwrap().contains("enabled"));

        let mut duplicate = stdio("other");
        duplicate.label = Some("files".into());
        duplicate.level = Some("project".into());
        duplicate.project_path = Some(project_path.clone());
        assert!(registry.upsert(duplicate).is_err());

        let disabled = registry
            .set_enabled(
                "files",
                false,
                Some(CapabilityLevel::Project),
                Some(&project_path),
            )
            .unwrap()
            .unwrap();
        assert!(!disabled.enabled);
        assert!(!registry.state.enabled(
            MCP_KIND,
            CapabilityLevel::Project,
            "files",
            Some(&project_path)
        ));

        assert!(registry
            .remove("files", Some(CapabilityLevel::Project), Some(&project_path))
            .unwrap());
        assert!(!target.exists());
        assert!(registry.state.enabled(
            MCP_KIND,
            CapabilityLevel::Project,
            "files",
            Some(&project_path)
        ));
    }
}
