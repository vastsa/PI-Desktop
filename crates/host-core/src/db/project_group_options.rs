//! Validated app-owned project configuration. Missing selections inherit the catalog;
//! present empty lists deliberately select nothing, and an empty object resets both.
use super::*;
use serde::{Deserialize, Deserializer, Serialize};
use std::collections::HashSet;

pub const MAX_PROJECT_GROUP_INSTRUCTIONS_BYTES: usize = 32 * 1024;
const MAX_CAPABILITY_IDS: usize = 512;
const MAX_CAPABILITY_ID_BYTES: usize = 512;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", try_from = "Value")]
pub struct ProjectCapabilities {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skill_ids: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mcp_server_ids: Option<Vec<String>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawProjectCapabilities {
    #[serde(default, deserialize_with = "deserialize_present")]
    skill_ids: Option<Vec<String>>,
    #[serde(default, deserialize_with = "deserialize_present")]
    mcp_server_ids: Option<Vec<String>>,
}

// Serde's default Option accepts explicit null. Only an absent field inherits.
pub(super) fn deserialize_present<'de, D, T>(
    deserializer: D,
) -> std::result::Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

impl TryFrom<Value> for ProjectCapabilities {
    type Error = anyhow::Error;

    fn try_from(value: Value) -> Result<Self> {
        if !value.is_object() {
            return Err(anyhow!("project capabilities must be an object"));
        }
        let raw: RawProjectCapabilities = serde_json::from_value(value)?;
        Self {
            skill_ids: raw.skill_ids,
            mcp_server_ids: raw.mcp_server_ids,
        }
        .normalized()
    }
}

impl ProjectCapabilities {
    fn normalized(mut self) -> Result<Self> {
        for (field, ids) in [
            ("skillIds", &mut self.skill_ids),
            ("mcpServerIds", &mut self.mcp_server_ids),
        ] {
            if let Some(ids) = ids {
                if ids.len() > MAX_CAPABILITY_IDS {
                    return Err(anyhow!("{field} exceeds {MAX_CAPABILITY_IDS} IDs"));
                }
                for id in ids.iter() {
                    if id.trim().is_empty()
                        || id.len() > MAX_CAPABILITY_ID_BYTES
                        || id.chars().any(char::is_control)
                    {
                        return Err(anyhow!("{field} contains an invalid capability ID"));
                    }
                }
                let mut seen = HashSet::new();
                ids.retain(|id| seen.insert(id.clone()));
            }
        }
        Ok(self)
    }
}

#[derive(Debug, Clone, Default)]
pub struct ProjectGroupOptions {
    pub(super) capabilities: Option<ProjectCapabilities>,
    pub(super) instructions: Option<String>,
}

impl ProjectGroupOptions {
    /// Read only the optional settings from an RPC or sync payload. Explicit
    /// null, mistyped lists and unknown capability keys fail before any write.
    pub fn from_json(params: &Value) -> Result<Self> {
        let object = params
            .as_object()
            .ok_or_else(|| anyhow!("project settings must be an object"))?;
        let capabilities = object
            .get("capabilities")
            .cloned()
            .map(serde_json::from_value::<ProjectCapabilities>)
            .transpose()?;
        let instructions = object
            .get("instructions")
            .map(|value| {
                value
                    .as_str()
                    .map(str::to_owned)
                    .ok_or_else(|| anyhow!("project instructions must be a string"))
            })
            .transpose()?;
        Self {
            capabilities,
            instructions,
        }
        .normalized()
    }

    pub(super) fn normalized(&self) -> Result<Self> {
        if let Some(content) = &self.instructions {
            validate_instructions(content)?;
        }
        Ok(Self {
            capabilities: self
                .capabilities
                .clone()
                .map(ProjectCapabilities::normalized)
                .transpose()?,
            instructions: self.instructions.clone(),
        })
    }

    pub(super) fn has_changes(&self) -> bool {
        self.capabilities.is_some() || self.instructions.is_some()
    }
}

pub(super) fn validate_instructions(content: &str) -> Result<()> {
    if content.len() > MAX_PROJECT_GROUP_INSTRUCTIONS_BYTES {
        return Err(anyhow!(
            "project instructions exceed {MAX_PROJECT_GROUP_INSTRUCTIONS_BYTES} bytes"
        ));
    }
    Ok(())
}

#[cfg(test)]
#[path = "project_group_options_tests.rs"]
mod tests;
