use super::*;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::model::{ProjectMemoryEntryRecord, ProjectMemoryRecord, ProjectRecord};
use super::repositories::{
    canonical_project_path, normalize_project_memory_entries, project_display_name,
    render_project_memory_entries, MAX_PROJECT_MEMORY_BYTES,
};

const GROUP_NAMESPACE: &str = "projectGroups";
const GROUP_MEMORY_NAMESPACE: &str = "projectGroupMemory";
const GROUP_INSTRUCTIONS_NAMESPACE: &str = "projectGroupInstructions";
pub const MAX_PROJECT_GROUP_NAME_CHARS: usize = 80;
pub const MAX_PROJECT_GROUP_INSTRUCTIONS_BYTES: usize = 32 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectGroupRoot {
    pub path: String,
    pub name: String,
    pub position: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectGroupRecord {
    pub id: String,
    pub name: String,
    pub primary_path: String,
    pub roots: Vec<ProjectGroupRoot>,
    pub created_at: i64,
    pub updated_at: i64,
    pub pinned: bool,
    pub last_opened_at: i64,
    #[serde(default)]
    pub legacy: bool,
    /// Roots removed from the group remain suppressed as legacy projections.
    #[serde(default)]
    pub detached_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectGroupContextRecord {
    pub group_id: String,
    pub roots: Vec<ProjectGroupRoot>,
    pub instructions: String,
    pub memory: ProjectMemoryRecord,
}

fn group_from_value(raw: &str) -> Result<ProjectGroupRecord> {
    let group: ProjectGroupRecord = serde_json::from_str(raw)?;
    if group.id.trim().is_empty() || group.name.trim().is_empty() {
        return Err(anyhow!("project group record is missing an id or name"));
    }
    if group.roots.is_empty() || group.primary_path.trim().is_empty() {
        return Err(anyhow!("project group record must contain a primary root"));
    }
    if group.roots[0].path != group.primary_path {
        return Err(anyhow!("project group primary root must be first"));
    }
    Ok(group)
}

fn legacy_group(project: &ProjectRecord) -> ProjectGroupRecord {
    ProjectGroupRecord {
        id: format!("legacy:{}", project.path),
        name: project.name.clone(),
        primary_path: project.path.clone(),
        roots: vec![ProjectGroupRoot {
            path: project.path.clone(),
            name: project.name.clone(),
            position: 0,
        }],
        created_at: project.created_at,
        updated_at: project.last_opened_at,
        pinned: project.pinned,
        last_opened_at: project.last_opened_at,
        legacy: true,
        detached_paths: Vec::new(),
    }
}

impl Database {
    fn stored_project_groups(&self) -> Result<Vec<ProjectGroupRecord>> {
        let mut stmt = self
            .conn
            .prepare_cached("SELECT value_json FROM kv WHERE ns = ?1 ORDER BY key")?;
        let rows = stmt.query_map(params![GROUP_NAMESPACE], |row| row.get::<_, String>(0))?;
        rows.map(|row| group_from_value(&row?)).collect()
    }

    fn group_by_id(&self, id: &str) -> Result<Option<ProjectGroupRecord>> {
        Ok(self
            .list_project_groups()?
            .into_iter()
            .find(|group| group.id == id))
    }

    pub fn list_project_groups(&self) -> Result<Vec<ProjectGroupRecord>> {
        let projects = self.list_projects()?;
        let stored = self.stored_project_groups()?;
        let mut used_paths = std::collections::HashSet::new();
        let mut groups = Vec::with_capacity(stored.len() + projects.len());

        for group in stored {
            for root in &group.roots {
                let path = canonical_project_path(&root.path)
                    .ok_or_else(|| anyhow!("project group root path must not be blank"))?;
                used_paths.insert(path);
            }
            for path in &group.detached_paths {
                if let Some(path) = canonical_project_path(path) {
                    used_paths.insert(path);
                }
            }
            groups.push(group);
        }
        for project in projects {
            if !used_paths.contains(&project.path) {
                groups.push(legacy_group(&project));
            }
        }
        groups.sort_by(|left, right| {
            right
                .pinned
                .cmp(&left.pinned)
                .then(right.last_opened_at.cmp(&left.last_opened_at))
                .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
        });
        Ok(groups)
    }

    pub fn project_group_for_path(&self, path: &str) -> Result<Option<ProjectGroupRecord>> {
        let Some(canonical) = canonical_project_path(path) else {
            return Ok(None);
        };
        Ok(self
            .list_project_groups()?
            .into_iter()
            .find(|group| group.roots.iter().any(|root| root.path == canonical)))
    }

    /// Whether the path is a root of a stored (non-legacy) project group. A
    /// legacy group is only the projection of the project row itself, so it
    /// must not block removing that project.
    pub fn path_is_in_stored_project_group(&self, path: &str) -> Result<bool> {
        Ok(self
            .project_group_for_path(path)?
            .is_some_and(|group| !group.legacy))
    }

    pub fn create_project_group(&self, name: &str, paths: &[String]) -> Result<ProjectGroupRecord> {
        let name = name.trim();
        if name.is_empty() {
            return Err(anyhow!("project group name must not be blank"));
        }
        if name.chars().count() > MAX_PROJECT_GROUP_NAME_CHARS {
            return Err(anyhow!(
                "project group name exceeds {MAX_PROJECT_GROUP_NAME_CHARS} characters"
            ));
        }
        let mut canonical_paths = Vec::with_capacity(paths.len());
        for raw in paths {
            let path = canonical_project_path(raw)
                .ok_or_else(|| anyhow!("project group root path must not be blank"))?;
            if !Path::new(&path).is_dir() {
                return Err(anyhow!("project group root is not a directory: {path}"));
            }
            if canonical_paths.iter().any(|candidate| candidate == &path) {
                continue;
            }
            if self
                .project_group_for_path(&path)?
                .is_some_and(|group| !group.legacy)
            {
                return Err(anyhow!("folder already belongs to a project group: {path}"));
            }
            canonical_paths.push(path);
        }
        if canonical_paths.is_empty() {
            return Err(anyhow!("project group requires at least one folder"));
        }

        let now = now_ms();
        let roots = canonical_paths
            .iter()
            .enumerate()
            .map(|(position, path)| ProjectGroupRoot {
                path: path.clone(),
                name: project_display_name(path),
                position: position as i64,
            })
            .collect::<Vec<_>>();
        for path in &canonical_paths {
            self.ensure_project(path, false)?;
        }
        let group = ProjectGroupRecord {
            id: Uuid::new_v4().to_string(),
            name: name.to_string(),
            primary_path: canonical_paths[0].clone(),
            roots,
            created_at: now,
            updated_at: now,
            pinned: false,
            last_opened_at: now,
            legacy: false,
            detached_paths: Vec::new(),
        };
        self.kv_set(GROUP_NAMESPACE, &group.id, &serde_json::to_value(&group)?)?;
        Ok(group)
    }

    pub fn update_project_group(
        &self,
        id: &str,
        name: &str,
        paths: &[String],
    ) -> Result<ProjectGroupRecord> {
        let name = name.trim();
        if name.is_empty() || name.chars().count() > MAX_PROJECT_GROUP_NAME_CHARS {
            return Err(anyhow!("project group name is invalid"));
        }
        let Some(current) = self.group_by_id(id.trim())? else {
            return Err(anyhow!("project group not found"));
        };
        let primary = canonical_project_path(&current.primary_path)
            .ok_or_else(|| anyhow!("project group primary path is invalid"))?;
        let mut selected = Vec::with_capacity(paths.len());
        for raw in paths {
            let path = canonical_project_path(raw)
                .ok_or_else(|| anyhow!("project group root path must not be blank"))?;
            if !Path::new(&path).is_dir() {
                return Err(anyhow!("project group root is not a directory: {path}"));
            }
            if selected.iter().any(|candidate| candidate == &path) {
                continue;
            }
            if let Some(other) = self.project_group_for_path(&path)? {
                if other.id != current.id && !other.legacy {
                    return Err(anyhow!("folder already belongs to a project group: {path}"));
                }
            }
            selected.push(path);
        }
        if !selected.iter().any(|path| path == &primary) {
            return Err(anyhow!("the primary folder cannot be removed"));
        }
        let mut ordered = vec![primary.clone()];
        ordered.extend(selected.into_iter().filter(|path| path != &primary));

        let removed = current
            .roots
            .iter()
            .map(|root| root.path.as_str())
            .filter(|path| !ordered.iter().any(|candidate| candidate == path))
            .collect::<Vec<_>>();
        for path in &removed {
            let has_sessions: bool = self.conn.query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM sessions s
                    JOIN projects p ON p.id = s.project_id
                    WHERE p.path = ?1
                )",
                params![path],
                |row| row.get(0),
            )?;
            if has_sessions {
                return Err(anyhow!(
                    "cannot remove a folder that still has chats: {path}"
                ));
            }
        }
        for path in &ordered {
            self.ensure_project(path, false)?;
        }

        if current.legacy && ordered.len() == 1 {
            self.conn
                .prepare_cached("UPDATE projects SET name = ?1 WHERE path = ?2")?
                .execute(params![name, primary])?;
            let mut legacy = current;
            legacy.name = name.to_string();
            return Ok(legacy);
        }

        let now = now_ms();
        let roots = ordered
            .iter()
            .enumerate()
            .map(|(position, path)| ProjectGroupRoot {
                path: path.clone(),
                name: project_display_name(path),
                position: position as i64,
            })
            .collect::<Vec<_>>();
        let mut detached_paths = current.detached_paths;
        for path in removed {
            if !detached_paths.iter().any(|candidate| candidate == path) {
                detached_paths.push(path.to_string());
            }
        }
        detached_paths.retain(|path| !ordered.iter().any(|candidate| candidate == path));

        let group = ProjectGroupRecord {
            id: if current.legacy {
                Uuid::new_v4().to_string()
            } else {
                current.id
            },
            name: name.to_string(),
            primary_path: primary,
            roots,
            created_at: current.created_at,
            updated_at: now,
            pinned: current.pinned,
            last_opened_at: current.last_opened_at,
            legacy: false,
            detached_paths,
        };
        if current.legacy {
            // A legacy project may already have path-scoped memory. Merge the
            // memory of every selected legacy root into the new group so
            // upgrading a project never silently discards user context.
            let mut merged_entries = Vec::new();
            for (root_index, path) in ordered.iter().enumerate() {
                let memory = self.get_project_memory(path)?;
                if let Some(entries) = memory.entries {
                    merged_entries.extend(entries.into_iter().map(|entry| {
                        ProjectMemoryEntryRecord {
                            id: format!("root-{root_index}-{}", entry.id),
                            title: entry.title,
                            content: entry.content,
                        }
                    }));
                } else if !memory.content.is_empty() {
                    merged_entries.push(ProjectMemoryEntryRecord {
                        id: format!("root-{root_index}-legacy"),
                        title: project_display_name(path),
                        content: memory.content,
                    });
                }
            }
            if !merged_entries.is_empty() {
                let content = render_project_memory_entries(&merged_entries);
                self.kv_set(
                    GROUP_MEMORY_NAMESPACE,
                    &group.id,
                    &serde_json::json!({
                        "format": "entries-v1",
                        "content": content,
                        "entries": merged_entries,
                        "updatedAt": now_ms()
                    }),
                )?;
            }
        }
        self.kv_set(GROUP_NAMESPACE, &group.id, &serde_json::to_value(&group)?)?;
        Ok(group)
    }

    pub fn rename_project_group(&self, id: &str, name: &str) -> Result<ProjectGroupRecord> {
        let name = name.trim();
        if name.is_empty() || name.chars().count() > MAX_PROJECT_GROUP_NAME_CHARS {
            return Err(anyhow!("project group name is invalid"));
        }
        let Some(mut group) = self.group_by_id(id.trim())? else {
            return Err(anyhow!("project group not found"));
        };
        if group.legacy {
            self.conn
                .prepare_cached("UPDATE projects SET name = ?1 WHERE path = ?2")?
                .execute(params![name, group.primary_path])?;
        } else {
            group.name = name.to_string();
            group.updated_at = now_ms();
            self.kv_set(GROUP_NAMESPACE, &group.id, &serde_json::to_value(&group)?)?;
        }
        group.name = name.to_string();
        Ok(group)
    }

    pub fn get_project_group_memory(&self, id: &str) -> Result<ProjectMemoryRecord> {
        let Some(group) = self.group_by_id(id)? else {
            return Err(anyhow!("project group not found"));
        };
        if group.legacy {
            return self.get_project_memory(&group.primary_path);
        }
        let value = self.kv_get(GROUP_MEMORY_NAMESPACE, &group.id)?;
        let content = value
            .as_ref()
            .and_then(|item| item.get("content"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let updated_at = value
            .as_ref()
            .and_then(|item| item.get("updatedAt"))
            .and_then(Value::as_i64)
            .unwrap_or_default();
        let entries = value
            .as_ref()
            .and_then(super::repositories::parse_project_memory_entries);
        Ok(ProjectMemoryRecord {
            content,
            entries,
            updated_at,
        })
    }

    pub fn set_project_group_memory(
        &self,
        id: &str,
        raw_entries: &Value,
    ) -> Result<ProjectMemoryRecord> {
        let Some(group) = self.group_by_id(id)? else {
            return Err(anyhow!("project group not found"));
        };
        if group.legacy {
            return self.set_project_memory_entries(&group.primary_path, raw_entries);
        }
        let entries = normalize_project_memory_entries(raw_entries)?;
        let content = render_project_memory_entries(&entries);
        if content.len() > MAX_PROJECT_MEMORY_BYTES {
            return Err(anyhow!(
                "project memory exceeds {MAX_PROJECT_MEMORY_BYTES} bytes"
            ));
        }
        let updated_at = now_ms();
        self.kv_set(
            GROUP_MEMORY_NAMESPACE,
            &group.id,
            &serde_json::json!({
                "format": "entries-v1",
                "content": content,
                "entries": entries,
                "updatedAt": updated_at
            }),
        )?;
        Ok(ProjectMemoryRecord {
            content,
            entries: Some(entries),
            updated_at,
        })
    }

    pub fn get_project_group_instructions(&self, id: &str) -> Result<String> {
        let Some(group) = self.group_by_id(id)? else {
            return Err(anyhow!("project group not found"));
        };
        if group.legacy {
            return Ok(String::new());
        }
        Ok(self
            .kv_get(GROUP_INSTRUCTIONS_NAMESPACE, &group.id)?
            .and_then(|value| {
                value
                    .get("content")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .unwrap_or_default())
    }

    pub fn set_project_group_instructions(&self, id: &str, content: &str) -> Result<String> {
        let Some(group) = self.group_by_id(id)? else {
            return Err(anyhow!("project group not found"));
        };
        if group.legacy {
            return Err(anyhow!("legacy project groups use folder instructions"));
        }
        if content.len() > MAX_PROJECT_GROUP_INSTRUCTIONS_BYTES {
            return Err(anyhow!(
                "project instructions exceed {MAX_PROJECT_GROUP_INSTRUCTIONS_BYTES} bytes"
            ));
        }
        self.kv_set(
            GROUP_INSTRUCTIONS_NAMESPACE,
            &group.id,
            &serde_json::json!({ "content": content, "updatedAt": now_ms() }),
        )?;
        Ok(content.to_string())
    }

    pub fn project_group_context_for_path(
        &self,
        path: &str,
    ) -> Result<Option<ProjectGroupContextRecord>> {
        let Some(group) = self.project_group_for_path(path)? else {
            return Ok(None);
        };
        if group.legacy {
            return Ok(None);
        }
        Ok(Some(ProjectGroupContextRecord {
            group_id: group.id.clone(),
            roots: group.roots,
            instructions: self.get_project_group_instructions(&group.id)?,
            memory: self.get_project_group_memory(&group.id)?,
        }))
    }
}
