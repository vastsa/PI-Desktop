use crate::activation::ActivationScope;
use crate::agent_capabilities::{
    capability_dir, file_timestamp, parse_front_matter, slugify, sorted_files, CapabilityLevel,
    CapabilityState,
};
use anyhow::{bail, Context, Result};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::Path;

const MAX_USER_SUBAGENTS: usize = 64;
pub const MAX_SUBAGENT_BYTES: usize = 32 * 1024;
const MAX_NAME_CHARS: usize = 40;
const MAX_DESCRIPTION_CHARS: usize = 400;
const MAX_TURNS_CEILING: u32 = 80;
/// Mirrors `MAX_SUBAGENT_MAX_TOKENS` in `packages/shared`. No published model
/// accepts an output limit above 128k, so a larger declared value is a typo.
const MAX_TOKENS_CEILING: u32 = 200_000;
const DEFAULT_TOOLS: [&str; 3] = ["Read", "Glob", "Grep"];
const ASSIGNABLE_TOOLS: [&str; 7] = [
    "Read",
    "Glob",
    "Grep",
    "BrowserPreview",
    "Bash",
    "Edit",
    "Write",
];
const THINKING_LEVELS: [&str; 8] = [
    "off", "minimal", "low", "medium", "high", "xhigh", "max", "omit",
];
const SUBAGENT_KIND: &str = "subagents";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UserSubagentRecord {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub level: Option<String>,
    pub description: String,
    pub enabled: bool,
    #[serde(default)]
    pub scope: ActivationScope,
    #[serde(default)]
    pub tools: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_level: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_turns: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
    pub path: String,
    #[serde(default)]
    pub size_bytes: u64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserSubagentInput {
    pub id: Option<String>,
    pub name: Option<String>,
    pub description: Option<String>,
    pub body: Option<String>,
    pub tools: Option<Vec<String>>,
    pub model: Option<String>,
    pub thinking_level: Option<String>,
    pub max_turns: Option<u32>,
    pub max_tokens: Option<u32>,
    pub enabled: Option<bool>,
    /// Kept for protocol compatibility; subagents are global-only now.
    #[allow(dead_code)]
    pub scope: Option<ActivationScope>,
}

pub struct UserSubagentRegistry {
    state: CapabilityState,
}

fn normalize_name(value: &str) -> String {
    slugify(value, MAX_NAME_CHARS)
}

fn clip(value: &str, max_chars: usize) -> String {
    let trimmed = value.trim();
    if trimmed.chars().count() <= max_chars {
        return trimmed.to_string();
    }
    trimmed.chars().take(max_chars).collect()
}

fn normalize_tools(requested: Option<&Vec<String>>) -> Vec<String> {
    let requested = requested
        .filter(|tools| !tools.is_empty())
        .cloned()
        .unwrap_or_else(|| {
            DEFAULT_TOOLS
                .iter()
                .map(|tool| (*tool).to_string())
                .collect()
        });
    let mut result = Vec::new();
    for tool in &requested {
        if let Some(canonical) = ASSIGNABLE_TOOLS
            .iter()
            .find(|candidate| candidate.eq_ignore_ascii_case(tool.trim()))
        {
            if !result.iter().any(|value: &String| value == canonical) {
                result.push((*canonical).to_string());
            }
        }
    }
    result
}

fn normalize_thinking(value: Option<&str>) -> Option<String> {
    let candidate = value?.trim().to_lowercase();
    THINKING_LEVELS
        .iter()
        .find(|level| **level == candidate)
        .map(|level| (*level).to_string())
}

/// A definition pin, normalized, or an error when it is not a pin.
///
/// The stored shape is `provider/model`. Only the slash is structural: the
/// provider half is matched by a normalized alias in the runtime
/// (`findProvider`), and a custom endpoint's display name may contain spaces,
/// so those are valid here too. Rejecting a value the editor offers would leave
/// the user with a definition that saves but can never resolve.
fn normalize_model(value: Option<&str>) -> Result<Option<String>> {
    let Some(trimmed) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let Some((provider, model)) = trimmed.split_once('/') else {
        bail!("SUBAGENT_INVALID: `model` must be written as provider/model");
    };
    if provider.is_empty() || model.is_empty() {
        bail!("SUBAGENT_INVALID: `model` must be written as provider/model");
    }
    Ok(Some(trimmed.to_string()))
}

fn parse_record(path: &Path, state: &CapabilityState) -> Option<UserSubagentRecord> {
    let raw = fs::read_to_string(path).ok()?;
    if raw.len() > MAX_SUBAGENT_BYTES {
        return None;
    }
    let (front, body) = parse_front_matter(&raw);
    if body.trim().is_empty() {
        return None;
    }
    let fallback = path.file_stem()?.to_str()?;
    let name = normalize_name(front.get("name").map(String::as_str).unwrap_or(fallback));
    let description = clip(front.get("description")?, MAX_DESCRIPTION_CHARS);
    if name.is_empty() || description.is_empty() {
        return None;
    }
    let tools = front.get("tools").map(|value| {
        value
            .trim_matches(['[', ']'])
            .split(',')
            .map(|tool| tool.trim().to_string())
            .collect::<Vec<_>>()
    });
    let tools = normalize_tools(tools.as_ref());
    if tools.is_empty() {
        return None;
    }
    let enabled = state.enabled(SUBAGENT_KIND, CapabilityLevel::Global, &name, None);
    let updated_at = file_timestamp(path);
    let max_turns = front
        .get("maxturns")
        .and_then(|value| value.parse::<u32>().ok())
        .filter(|value| *value > 0)
        .map(|value| value.min(MAX_TURNS_CEILING));
    let max_tokens = front
        .get("maxtokens")
        .and_then(|value| value.parse::<u32>().ok())
        .filter(|value| *value > 0)
        .map(|value| value.min(MAX_TOKENS_CEILING));
    Some(UserSubagentRecord {
        id: name.clone(),
        name,
        level: Some("global".into()),
        description,
        enabled,
        scope: ActivationScope::default(),
        tools,
        model: front
            .get("model")
            .cloned()
            .filter(|value| !value.is_empty()),
        thinking_level: normalize_thinking(front.get("thinkinglevel").map(String::as_str)),
        max_turns,
        max_tokens,
        path: path.to_string_lossy().to_string(),
        size_bytes: raw.len() as u64,
        created_at: updated_at.clone(),
        updated_at,
    })
}

fn render_document(record: &UserSubagentRecord, body: &str) -> String {
    let mut output = String::from("---\n");
    output.push_str(&format!("name: {}\n", record.name));
    output.push_str(&format!(
        "description: {}\n",
        record.description.replace('\n', " ")
    ));
    output.push_str(&format!("tools: [{}]\n", record.tools.join(", ")));
    if let Some(model) = &record.model {
        output.push_str(&format!("model: {model}\n"));
    }
    if let Some(level) = &record.thinking_level {
        output.push_str(&format!("thinkingLevel: {level}\n"));
    }
    if let Some(max_turns) = record.max_turns {
        output.push_str(&format!("maxTurns: {max_turns}\n"));
    }
    if let Some(max_tokens) = record.max_tokens {
        output.push_str(&format!("maxTokens: {max_tokens}\n"));
    }
    output.push_str("---\n\n");
    output.push_str(body.trim());
    output.push('\n');
    output
}

fn default_body(name: &str) -> String {
    format!("Do the work the task names and report only what the parent needs. Start with the first concrete step for `{name}`.\n")
}

impl UserSubagentRegistry {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            state: CapabilityState::new(data_dir, SUBAGENT_KIND),
        }
    }

    fn scan(&mut self) -> Result<Vec<UserSubagentRecord>> {
        let directory = capability_dir(CapabilityLevel::Global, None, "subagents")?;
        let mut records = Vec::new();
        let mut seen = HashSet::new();
        for path in sorted_files(&directory, "md") {
            let Some(record) = parse_record(&path, &self.state) else {
                continue;
            };
            if seen.insert(record.id.clone()) {
                records.push(record);
            }
        }
        let ids = records.iter().map(|record| record.id.clone()).collect();
        self.state
            .prune(SUBAGENT_KIND, CapabilityLevel::Global, None, &ids)?;
        records.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(records)
    }

    pub fn list(&mut self) -> Result<Vec<UserSubagentRecord>> {
        self.scan()
    }

    pub fn active_for(&mut self, _project_path: Option<&str>) -> Result<Vec<UserSubagentRecord>> {
        Ok(self
            .scan()?
            .into_iter()
            .filter(|record| record.enabled)
            .collect())
    }

    fn find(&mut self, id: &str) -> Result<Option<UserSubagentRecord>> {
        Ok(self.scan()?.into_iter().find(|record| record.id == id))
    }

    pub fn create(&mut self, input: UserSubagentInput) -> Result<UserSubagentRecord> {
        let name = normalize_name(
            input
                .id
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .or(input.name.as_deref())
                .unwrap_or_default(),
        );
        if name.is_empty() {
            bail!("SUBAGENT_INVALID: name is required");
        }
        let description = clip(
            input.description.as_deref().unwrap_or_default(),
            MAX_DESCRIPTION_CHARS,
        );
        if description.is_empty() {
            bail!("SUBAGENT_INVALID: description is required");
        }
        if self
            .scan()?
            .iter()
            .any(|record| record.id == name || record.name == name)
        {
            bail!("SUBAGENT_INVALID: a subagent named \"{name}\" already exists");
        }
        if self.scan()?.len() >= MAX_USER_SUBAGENTS {
            bail!("SUBAGENT_INVALID: at most {MAX_USER_SUBAGENTS} subagents");
        }
        let tools = normalize_tools(input.tools.as_ref());
        if tools.is_empty() {
            bail!("SUBAGENT_INVALID: grant at least one known tool");
        }
        let record = UserSubagentRecord {
            id: name.clone(),
            name,
            level: Some("global".into()),
            description,
            enabled: input.enabled.unwrap_or(true),
            scope: ActivationScope::default(),
            tools,
            model: normalize_model(input.model.as_deref())?,
            thinking_level: normalize_thinking(input.thinking_level.as_deref()),
            max_turns: input
                .max_turns
                .filter(|value| *value > 0)
                .map(|value| value.min(MAX_TURNS_CEILING)),
            max_tokens: input
                .max_tokens
                .filter(|value| *value > 0)
                .map(|value| value.min(MAX_TOKENS_CEILING)),
            path: String::new(),
            size_bytes: 0,
            created_at: Utc::now().to_rfc3339(),
            updated_at: Utc::now().to_rfc3339(),
        };
        let directory = capability_dir(CapabilityLevel::Global, None, "subagents")?;
        fs::create_dir_all(&directory)?;
        let path = directory.join(format!("{}.md", record.id));
        let default_body = default_body(&record.name);
        let body = input.body.as_deref().unwrap_or(default_body.as_str());
        let document = render_document(&record, body);
        if document.len() > MAX_SUBAGENT_BYTES {
            bail!("SUBAGENT_INVALID: document exceeds {MAX_SUBAGENT_BYTES} bytes");
        }
        fs::write(&path, &document).with_context(|| format!("write {}", path.display()))?;
        if !record.enabled {
            self.state.set_enabled(
                SUBAGENT_KIND,
                CapabilityLevel::Global,
                &record.id,
                None,
                false,
            )?;
        }
        self.find(&record.id)?
            .ok_or_else(|| anyhow::anyhow!("SUBAGENT_INVALID: created subagent was not found"))
    }

    pub fn update(
        &mut self,
        id: &str,
        input: UserSubagentInput,
    ) -> Result<Option<UserSubagentRecord>> {
        let Some(current) = self.find(id)? else {
            return Ok(None);
        };
        let name = input
            .name
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .map(normalize_name)
            .unwrap_or_else(|| current.name.clone());
        if name != current.name && self.scan()?.iter().any(|record| record.id == name) {
            bail!("SUBAGENT_INVALID: a subagent named \"{name}\" already exists");
        }
        let description = input
            .description
            .as_deref()
            .map(|value| clip(value, MAX_DESCRIPTION_CHARS))
            .unwrap_or_else(|| current.description.clone());
        if description.is_empty() {
            bail!("SUBAGENT_INVALID: description is required");
        }
        let tools = normalize_tools(input.tools.as_ref().or(Some(&current.tools)));
        if tools.is_empty() {
            bail!("SUBAGENT_INVALID: grant at least one known tool");
        }
        let raw = fs::read_to_string(&current.path)?;
        let (_, old_body) = parse_front_matter(&raw);
        let body = input.body.unwrap_or(old_body);
        let mut next = current.clone();
        next.id = name.clone();
        next.name = name.clone();
        next.description = description;
        next.tools = tools;
        next.model = match input.model {
            Some(value) if value.trim().is_empty() => None,
            Some(value) => normalize_model(Some(value.as_str()))?,
            None => current.model,
        };
        next.thinking_level = match input.thinking_level {
            Some(value) if value.trim().is_empty() => None,
            Some(value) => normalize_thinking(Some(value.as_str())),
            None => current.thinking_level,
        };
        next.max_turns = match input.max_turns {
            Some(0) => None,
            Some(value) => Some(value.min(MAX_TURNS_CEILING)),
            None => current.max_turns,
        };
        next.max_tokens = match input.max_tokens {
            Some(0) => None,
            Some(value) => Some(value.min(MAX_TOKENS_CEILING)),
            None => current.max_tokens,
        };
        next.enabled = input.enabled.unwrap_or(current.enabled);
        next.path = current.path.clone();
        if next.id != current.id {
            next.path = capability_dir(CapabilityLevel::Global, None, "subagents")?
                .join(format!("{}.md", next.id))
                .to_string_lossy()
                .to_string();
        }
        let document = render_document(&next, &body);
        if document.len() > MAX_SUBAGENT_BYTES {
            bail!("SUBAGENT_INVALID: document exceeds {MAX_SUBAGENT_BYTES} bytes");
        }
        fs::write(&next.path, &document)?;
        if next.path != current.path {
            fs::remove_file(&current.path).ok();
        }
        if next.enabled != current.enabled {
            self.state.set_enabled(
                SUBAGENT_KIND,
                CapabilityLevel::Global,
                &next.id,
                None,
                next.enabled,
            )?;
        }
        self.find(&next.id)
    }

    pub fn read(&mut self, id: &str) -> Result<Option<(UserSubagentRecord, String)>> {
        let Some(record) = self.find(id)? else {
            return Ok(None);
        };
        let raw = fs::read_to_string(&record.path)?;
        if raw.len() > MAX_SUBAGENT_BYTES {
            bail!("SUBAGENT_INVALID: document exceeds {MAX_SUBAGENT_BYTES} bytes");
        }
        let (_, body) = parse_front_matter(&raw);
        Ok(Some((record, body)))
    }

    pub fn remove(&mut self, id: &str) -> Result<bool> {
        let Some(record) = self.find(id)? else {
            return Ok(false);
        };
        fs::remove_file(&record.path).ok();
        let _ = self.scan()?;
        Ok(true)
    }

    pub fn set_enabled(&mut self, id: &str, enabled: bool) -> Result<Option<UserSubagentRecord>> {
        let Some(record) = self.find(id)? else {
            return Ok(None);
        };
        self.state.set_enabled(
            SUBAGENT_KIND,
            CapabilityLevel::Global,
            &record.id,
            None,
            enabled,
        )?;
        self.find(id)
    }

    pub fn set_scope(
        &mut self,
        id: &str,
        scope: ActivationScope,
    ) -> Result<Option<UserSubagentRecord>> {
        let _ = scope;
        self.find(id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn parser_rejects_missing_description() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("agent.md");
        fs::write(&path, "---\nname: agent\n---\n\nDo it\n").unwrap();
        let state = CapabilityState::new(dir.path(), SUBAGENT_KIND);
        assert!(parse_record(&path, &state).is_none());
    }

    #[test]
    fn tools_are_normalized_and_unknown_tools_are_dropped() {
        assert_eq!(
            normalize_tools(Some(&vec!["read".into(), "Nope".into(), "Bash".into()])),
            vec!["Read", "Bash"]
        );
    }

    #[test]
    fn omit_is_a_valid_thinking_override() {
        assert_eq!(normalize_thinking(Some("omit")), Some("omit".into()));
        assert_eq!(normalize_thinking(Some(" OMIT ")), Some("omit".into()));
    }

    #[test]
    fn document_contains_no_activation_state() {
        let record = UserSubagentRecord {
            id: "review".into(),
            name: "review".into(),
            level: Some("global".into()),
            description: "Review code".into(),
            enabled: false,
            scope: ActivationScope::default(),
            tools: vec!["Read".into()],
            model: None,
            thinking_level: None,
            max_turns: None,
            max_tokens: None,
            path: "/tmp/review.md".into(),
            size_bytes: 0,
            created_at: String::new(),
            updated_at: String::new(),
        };
        assert!(!render_document(&record, "Review it").contains("enabled"));
    }

    #[test]
    fn an_output_cap_is_written_and_an_absent_one_is_omitted() {
        let mut record = UserSubagentRecord {
            id: "review".into(),
            name: "review".into(),
            level: Some("global".into()),
            description: "Review code".into(),
            enabled: true,
            scope: ActivationScope::default(),
            tools: vec!["Read".into()],
            model: None,
            thinking_level: None,
            max_turns: Some(20),
            max_tokens: Some(16_000),
            path: "/tmp/review.md".into(),
            size_bytes: 0,
            created_at: String::new(),
            updated_at: String::new(),
        };
        let document = render_document(&record, "Review it");
        assert!(document.contains("maxTurns: 20\n"));
        assert!(document.contains("maxTokens: 16000\n"));

        // Absent means "follow the model", so the key must not appear at all —
        // a written `maxTokens: 0` would read back as an explicit empty cap.
        record.max_tokens = None;
        assert!(!render_document(&record, "Review it").contains("maxTokens"));
    }

    #[test]
    fn a_model_pin_requires_a_slash_and_keeps_the_users_spelling() {
        // The shape is `provider/model`; the provider half may be a vendor key
        // or a display name, and a custom endpoint's name contains spaces.
        assert_eq!(
            normalize_model(Some("anthropic/claude-haiku-4-5")).unwrap(),
            Some("anthropic/claude-haiku-4-5".into())
        );
        assert_eq!(
            normalize_model(Some("  My Gateway/local-model  ")).unwrap(),
            Some("My Gateway/local-model".into())
        );
        // An openrouter-style model id keeps its own slashes.
        assert_eq!(
            normalize_model(Some("openrouter/deepseek/deepseek-chat")).unwrap(),
            Some("openrouter/deepseek/deepseek-chat".into())
        );
    }

    #[test]
    fn a_cleared_model_is_none_and_a_malformed_one_is_rejected() {
        assert_eq!(normalize_model(None).unwrap(), None);
        assert_eq!(normalize_model(Some("   ")).unwrap(), None);

        // A bare id has no provider to look up, so the runtime could never
        // resolve it; the editor rejects the same shape before saving.
        assert!(normalize_model(Some("claude-haiku-4-5")).is_err());
        assert!(normalize_model(Some("/claude-haiku-4-5")).is_err());
        assert!(normalize_model(Some("anthropic/")).is_err());
    }
}
