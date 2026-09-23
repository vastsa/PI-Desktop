use super::*;
use std::collections::HashSet;
use uuid::Uuid;

use super::model::{ProjectMemoryEntryRecord, ProjectMemoryRecord};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMemoryEditorState {
    pub owner: String,
    pub memory: ProjectMemoryRecord,
    pub auto_record_enabled: bool,
}

pub(crate) fn memory_entries(memory: &ProjectMemoryRecord) -> Vec<ProjectMemoryEntryRecord> {
    if let Some(entries) = &memory.entries {
        entries
            .iter()
            .map(|entry| ProjectMemoryEntryRecord {
                id: entry.id.clone(),
                title: entry.title.clone(),
                content: entry.content.clone(),
            })
            .collect()
    } else if memory.content.is_empty() {
        Vec::new()
    } else {
        vec![ProjectMemoryEntryRecord {
            id: "legacy-project-memory".to_string(),
            title: String::new(),
            content: memory.content.clone(),
        }]
    }
}

impl Database {
    fn editor_owner(&self, path: &str) -> Result<(String, Option<String>, String)> {
        let canonical =
            canonical_project_path(path).ok_or_else(|| anyhow!("project path required"))?;
        let group = self
            .project_group_for_path(&canonical)?
            .ok_or_else(|| anyhow!("project not found"))?;
        if group.legacy {
            Ok((format!("path:{canonical}"), None, canonical))
        } else {
            Ok((format!("group:{}", group.id), Some(group.id), canonical))
        }
    }

    pub fn get_project_memory_editor(&self, path: &str) -> Result<ProjectMemoryEditorState> {
        let (owner, group_id, canonical) = self.editor_owner(path)?;
        let auto_record_enabled = self.get_auto_record_enabled(&canonical)?;
        let memory = if let Some(id) = group_id {
            self.get_project_group_memory(&id)?
        } else {
            self.get_project_memory(&canonical)?
        };
        Ok(ProjectMemoryEditorState {
            owner,
            memory,
            auto_record_enabled,
        })
    }

    pub fn save_project_memory_editor(
        &self,
        path: &str,
        expected_owner: &str,
        expected_memory: &Value,
        entries: &Value,
    ) -> Result<ProjectMemoryEditorState> {
        let mut ids = HashSet::new();
        for entry in entries
            .as_array()
            .ok_or_else(|| anyhow!("project memory entries must be an array"))?
        {
            if entry
                .get("content")
                .and_then(Value::as_str)
                .is_some_and(|text| !text.trim().is_empty())
            {
                let id = entry
                    .get("id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| anyhow!("project memory entry id required"))?;
                if !ids.insert(id.trim()) {
                    return Err(anyhow!("duplicate project memory entry id"));
                }
            }
        }
        // Migrate any preview records before comparing the client's exact snapshot.
        self.get_project_memory_editor(path)?;
        let transaction = self.conn.unchecked_transaction()?;
        let current = self.get_project_memory_editor(path)?;
        if current.owner != expected_owner
            || serde_json::to_value(&current.memory)? != *expected_memory
        {
            return Err(anyhow!("project memory changed; reload before saving"));
        }
        let (_, group_id, canonical) = self.editor_owner(path)?;
        if let Some(id) = group_id {
            self.set_project_group_memory(&id, entries)?;
        } else {
            self.set_project_memory_entries(&canonical, entries)?;
        }
        let result = self.get_project_memory_editor(&canonical)?;
        transaction.commit()?;
        Ok(result)
    }

    fn mutate_project_memory_as_agent(
        &self,
        path: &str,
        id: Option<&str>,
        title: Option<&str>,
        content: Option<&str>,
        expected_title: Option<&str>,
        expected_content: Option<&str>,
    ) -> Result<ProjectMemoryEditorState> {
        self.get_project_memory_editor(path)?;
        let transaction = self.conn.unchecked_transaction()?;
        let current = self.get_project_memory_editor(path)?;
        if !current.auto_record_enabled {
            return Err(anyhow!("automatic recording is disabled"));
        }
        let mut entries = memory_entries(&current.memory);
        match (id, content) {
            (Some(id), content) => {
                let mut matching = entries
                    .iter()
                    .enumerate()
                    .filter(|(_, entry)| entry.id == id);
                let index = matching
                    .next()
                    .map(|(index, _)| index)
                    .ok_or_else(|| anyhow!("project memory entry not found"))?;
                if matching.next().is_some() {
                    return Err(anyhow!("duplicate project memory entry id; edit manually"));
                }
                let entry = &entries[index];
                if Some(entry.title.as_str()) != expected_title
                    || Some(entry.content.as_str()) != expected_content
                {
                    return Err(anyhow!("project memory changed; reload before editing"));
                }
                if let Some(content) = content {
                    let content = content.trim();
                    if content.is_empty() {
                        return Err(anyhow!("project memory content required"));
                    }
                    entries[index].title = title.unwrap_or("").trim().to_string();
                    entries[index].content = content.to_string();
                } else {
                    entries.remove(index);
                }
            }
            (None, Some(content)) => {
                let content = content.trim();
                if content.is_empty() {
                    return Err(anyhow!("project memory content required"));
                }
                let mut id = Uuid::new_v4().to_string();
                while entries.iter().any(|entry| entry.id == id) {
                    id = Uuid::new_v4().to_string();
                }
                entries.push(ProjectMemoryEntryRecord {
                    id,
                    title: title.unwrap_or("").trim().to_string(),
                    content: content.to_string(),
                });
            }
            (None, None) => return Err(anyhow!("project memory entry id required")),
        }
        let (_, group_id, canonical) = self.editor_owner(path)?;
        let entries = serde_json::to_value(&entries)?;
        if let Some(id) = group_id {
            self.set_project_group_memory(&id, &entries)?;
        } else {
            self.set_project_memory_entries(&canonical, &entries)?;
        }
        let result = self.get_project_memory_editor(&canonical)?;
        transaction.commit()?;
        Ok(result)
    }

    pub fn agent_upsert_project_memory(
        &self,
        path: &str,
        id: Option<&str>,
        title: &str,
        content: &str,
        expected_title: Option<&str>,
        expected_content: Option<&str>,
    ) -> Result<ProjectMemoryEditorState> {
        self.mutate_project_memory_as_agent(
            path,
            id,
            Some(title),
            Some(content),
            expected_title,
            expected_content,
        )
    }

    pub fn agent_delete_project_memory(
        &self,
        path: &str,
        id: &str,
        expected_title: Option<&str>,
        expected_content: Option<&str>,
    ) -> Result<ProjectMemoryEditorState> {
        self.mutate_project_memory_as_agent(
            path,
            Some(id),
            None,
            None,
            expected_title,
            expected_content,
        )
    }
}
