use crate::activation::ActivationScope;
use crate::agent_capabilities::{
    capability_dir, capability_id, file_timestamp, normalize_project_path, parse_front_matter,
    path_stem_for_id, slugify, sorted_files, valid_capability_id, CapabilityLevel, CapabilityState,
};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

const MAX_SKILLS: usize = 128;
pub const MAX_SKILL_BYTES: usize = 128 * 1024;
const MAX_NAME_CHARS: usize = 120;
const MAX_DESCRIPTION_CHARS: usize = 400;
const SKILL_KIND: &str = "skills";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UserSkillRecord {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub level: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub enabled: bool,
    #[serde(default)]
    pub scope: ActivationScope,
    pub source: String,
    pub path: String,
    #[serde(default)]
    pub size_bytes: u64,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserSkillInput {
    pub id: Option<String>,
    pub name: Option<String>,
    pub level: Option<String>,
    pub project_path: Option<String>,
    pub description: Option<String>,
    pub body: Option<String>,
    pub enabled: Option<bool>,
    /// Kept for protocol compatibility. Capability pages use directory level
    /// instead of writing activation scope into a skill document.
    #[allow(dead_code)]
    pub scope: Option<ActivationScope>,
}

pub struct UserSkillRegistry {
    state: CapabilityState,
}

fn clip(value: &str, max_chars: usize) -> String {
    let trimmed = value.trim();
    if trimmed.chars().count() <= max_chars {
        return trimmed.to_string();
    }
    trimmed.chars().take(max_chars).collect()
}

fn valid_id(id: &str) -> bool {
    valid_capability_id(id, 64)
}

fn render_document(name: &str, description: Option<&str>, body: &str) -> String {
    let mut out = String::from("---\n");
    out.push_str(&format!("name: {}\n", name.replace('\n', " ")));
    if let Some(description) = description.filter(|value| !value.trim().is_empty()) {
        out.push_str(&format!(
            "description: {}\n",
            description.replace('\n', " ")
        ));
    }
    out.push_str("---\n\n");
    out.push_str(body.trim());
    out.push('\n');
    out
}

fn default_body(name: &str) -> String {
    format!("# {name}\n\nDescribe the steps the agent should follow when this skill applies.\n")
}

fn level_and_project(input: &UserSkillInput) -> Result<(CapabilityLevel, Option<String>)> {
    let level = CapabilityLevel::parse(input.level.as_deref())?;
    let project_path = input
        .project_path
        .as_deref()
        .map(normalize_project_path)
        .filter(|value| !value.is_empty());
    if level == CapabilityLevel::Project && project_path.is_none() {
        bail!("CAPABILITY_INVALID: projectPath is required for project skills");
    }
    if level == CapabilityLevel::Global && project_path.is_some() {
        // A project path on a global request is meaningful only for its local
        // enabled override; the file still belongs to the global directory.
        return Ok((level, project_path));
    }
    Ok((level, project_path))
}

fn merge_active_records(
    global: Vec<UserSkillRecord>,
    project: Vec<UserSkillRecord>,
) -> Vec<UserSkillRecord> {
    let mut result = global;
    for record in project {
        result.retain(|existing| {
            existing.id != record.id && !existing.name.eq_ignore_ascii_case(&record.name)
        });
        if record.enabled {
            result.push(record);
        }
    }
    result.retain(|record| record.enabled);
    result.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    result
}

impl UserSkillRegistry {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            state: CapabilityState::new(data_dir, SKILL_KIND),
        }
    }

    fn scan_level(
        &mut self,
        level: CapabilityLevel,
        project_path: Option<&str>,
        effective_project: Option<&str>,
    ) -> Result<Vec<UserSkillRecord>> {
        let directory = capability_dir(level, project_path, "skills")?;
        let mut paths = sorted_files(&directory, "md");
        // Support the conventional `<skill>/SKILL.md` shape without making a
        // directory import necessary. Direct markdown files remain the shape
        // produced by the single-file importer.
        if let Ok(entries) = fs::read_dir(&directory) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    let skill_file = path.join("SKILL.md");
                    if skill_file.is_file() {
                        paths.push(skill_file);
                    }
                }
            }
        }
        paths.sort();

        let owner_project_path = if level == CapabilityLevel::Project {
            project_path.map(normalize_project_path)
        } else {
            None
        };
        let mut records = Vec::new();
        let mut seen = HashSet::new();
        for path in paths {
            let raw = match fs::read_to_string(&path) {
                Ok(raw) if raw.len() <= MAX_SKILL_BYTES => raw,
                _ => continue,
            };
            let (front, body) = parse_front_matter(&raw);
            if body.trim().is_empty() {
                continue;
            }
            let fallback = path_stem_for_id(&path);
            let name = clip(
                front.get("name").map(String::as_str).unwrap_or(&fallback),
                MAX_NAME_CHARS,
            );
            if name.is_empty() {
                continue;
            }
            let id = capability_id(&name, &path, 64);
            if !valid_id(&id) || !seen.insert(id.clone()) {
                continue;
            }
            let scope = scope_for(level, owner_project_path.as_deref());
            let enabled = self
                .state
                .enabled(SKILL_KIND, level, &id, effective_project);
            let description = front
                .get("description")
                .map(|value| clip(value, MAX_DESCRIPTION_CHARS))
                .filter(|value| !value.is_empty());
            let updated_at = file_timestamp(&path);
            records.push(UserSkillRecord {
                id,
                name,
                level: Some(level.as_str().to_string()),
                project_path: owner_project_path.clone(),
                description,
                enabled,
                scope,
                source: "imported".into(),
                path: path.to_string_lossy().to_string(),
                size_bytes: raw.len() as u64,
                created_at: updated_at.clone(),
                updated_at,
            });
        }
        let ids = records.iter().map(|record| record.id.clone()).collect();
        self.state.prune(SKILL_KIND, level, project_path, &ids)?;
        records.sort_by(|a, b| {
            a.name
                .to_lowercase()
                .cmp(&b.name.to_lowercase())
                .then(a.id.cmp(&b.id))
        });
        Ok(records)
    }

    pub fn list(
        &mut self,
        level: CapabilityLevel,
        project_path: Option<&str>,
    ) -> Result<Vec<UserSkillRecord>> {
        let selected = project_path.map(normalize_project_path);
        self.scan_level(level, project_path, selected.as_deref())
    }

    /// Return the effective user skill catalog. A project document shadows a
    /// global document with the same normalized name.
    pub fn active_for(&mut self, project_path: Option<&str>) -> Result<Vec<UserSkillRecord>> {
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
    ) -> Result<Option<UserSkillRecord>> {
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

    pub fn create(&mut self, input: UserSkillInput) -> Result<UserSkillRecord> {
        let (level, project_path) = level_and_project(&input)?;
        let directory = capability_dir(level, project_path.as_deref(), "skills")?;
        let name = clip(input.name.as_deref().unwrap_or_default(), MAX_NAME_CHARS);
        if name.is_empty() {
            bail!("SKILL_INVALID: name is required");
        }
        let id = input
            .id
            .as_deref()
            .filter(|value| valid_id(value))
            .map(str::to_string)
            .unwrap_or_else(|| slugify(&name, 64));
        if !valid_id(&id) {
            bail!("SKILL_INVALID: invalid id");
        }
        if self
            .list(level, project_path.as_deref())?
            .iter()
            .any(|record| record.id == id || record.name.eq_ignore_ascii_case(&name))
        {
            bail!("SKILL_INVALID: a skill with this name already exists at this level");
        }
        if self.list(level, project_path.as_deref())?.len() >= MAX_SKILLS {
            bail!("SKILL_INVALID: at most {MAX_SKILLS} skills");
        }
        let body = input
            .body
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| default_body(&name));
        let description = input
            .description
            .as_deref()
            .map(|value| clip(value, MAX_DESCRIPTION_CHARS))
            .filter(|value| !value.is_empty());
        let document = render_document(&name, description.as_deref(), &body);
        if document.len() > MAX_SKILL_BYTES {
            bail!("SKILL_INVALID: document exceeds {MAX_SKILL_BYTES} bytes");
        }
        fs::create_dir_all(&directory)?;
        let path = directory.join(format!("{id}.md"));
        fs::write(&path, &document).with_context(|| format!("write {}", path.display()))?;
        if input.enabled == Some(false) {
            self.state
                .set_enabled(SKILL_KIND, level, &id, project_path.as_deref(), false)?;
        }
        self.find(&id, Some(level), project_path.as_deref())?
            .ok_or_else(|| anyhow::anyhow!("SKILL_INVALID: created skill was not found"))
    }

    /// Import exactly one file and preserve its bytes. The native dialog is also
    /// single-file; this guard prevents a caller from turning import into a
    /// directory copy.
    pub fn import(&mut self, source: &str, input: UserSkillInput) -> Result<UserSkillRecord> {
        let source_path = PathBuf::from(source);
        if !source_path.is_file() {
            bail!("SKILL_INVALID: import requires one file");
        }
        let raw = fs::read_to_string(&source_path)
            .with_context(|| format!("read {}", source_path.display()))?;
        if raw.len() > MAX_SKILL_BYTES {
            bail!("SKILL_INVALID: document exceeds {MAX_SKILL_BYTES} bytes");
        }
        let (front, body) = parse_front_matter(&raw);
        if body.trim().is_empty() {
            bail!("SKILL_INVALID: document is empty");
        }
        let fallback = path_stem_for_id(&source_path);
        let name = clip(
            front.get("name").map(String::as_str).unwrap_or(&fallback),
            MAX_NAME_CHARS,
        );
        let id = input
            .id
            .as_deref()
            .filter(|value| valid_id(value))
            .map(str::to_string)
            .unwrap_or_else(|| capability_id(&name, &source_path, 64));
        if !valid_id(&id) {
            bail!("SKILL_INVALID: the file needs a name or a valid id");
        }
        let (level, project_path) = level_and_project(&input)?;
        if self
            .list(level, project_path.as_deref())?
            .iter()
            .any(|record| record.id == id || record.name.eq_ignore_ascii_case(&name))
        {
            bail!("SKILL_INVALID: a skill with this name already exists at this level");
        }
        let directory = capability_dir(level, project_path.as_deref(), "skills")?;
        fs::create_dir_all(&directory)?;
        let target = directory.join(format!("{id}.md"));
        fs::copy(&source_path, &target)
            .with_context(|| format!("copy {} to {}", source_path.display(), target.display()))?;
        if input.enabled == Some(false) {
            self.state
                .set_enabled(SKILL_KIND, level, &id, project_path.as_deref(), false)?;
        }
        self.find(&id, Some(level), project_path.as_deref())?
            .ok_or_else(|| anyhow::anyhow!("SKILL_INVALID: imported skill was not found"))
    }

    pub fn update(&mut self, id: &str, input: UserSkillInput) -> Result<Option<UserSkillRecord>> {
        let level = input
            .level
            .as_deref()
            .map(|value| CapabilityLevel::parse(Some(value)))
            .transpose()?;
        let record = self.find(id, level, input.project_path.as_deref())?;
        let Some(record) = record else {
            return Ok(None);
        };
        let raw = fs::read_to_string(&record.path)?;
        let (front, old_body) = parse_front_matter(&raw);
        let name = input
            .name
            .as_deref()
            .map(|value| clip(value, MAX_NAME_CHARS))
            .filter(|value| !value.is_empty())
            .or_else(|| front.get("name").cloned())
            .unwrap_or(record.name.clone());
        let description = match input.description.as_deref() {
            Some(value) if value.trim().is_empty() => None,
            Some(value) => Some(clip(value, MAX_DESCRIPTION_CHARS)),
            None => record.description.clone(),
        };
        let body = input.body.unwrap_or(old_body);
        if body.trim().is_empty() {
            bail!("SKILL_INVALID: document is empty");
        }
        let document = render_document(&name, description.as_deref(), &body);
        if document.len() > MAX_SKILL_BYTES {
            bail!("SKILL_INVALID: document exceeds {MAX_SKILL_BYTES} bytes");
        }
        fs::write(&record.path, document)?;
        if let Some(enabled) = input.enabled {
            self.state.set_enabled(
                SKILL_KIND,
                record
                    .level
                    .as_deref()
                    .and_then(|value| CapabilityLevel::parse(Some(value)).ok())
                    .unwrap_or(CapabilityLevel::Global),
                id,
                record.project_path.as_deref(),
                enabled,
            )?;
        }
        Ok(self.find(id, level, record.project_path.as_deref())?)
    }

    pub fn read(
        &mut self,
        id: &str,
        level: Option<CapabilityLevel>,
        project_path: Option<&str>,
    ) -> Result<Option<(UserSkillRecord, String)>> {
        let Some(record) = self.find(id, level, project_path)? else {
            return Ok(None);
        };
        let raw = fs::read_to_string(&record.path)?;
        if raw.len() > MAX_SKILL_BYTES {
            bail!("SKILL_INVALID: document exceeds {MAX_SKILL_BYTES} bytes");
        }
        let (_, body) = parse_front_matter(&raw);
        Ok(Some((record, body)))
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
        fs::remove_file(&record.path).ok();
        let level = record
            .level
            .as_deref()
            .map(|value| CapabilityLevel::parse(Some(value)))
            .transpose()?
            .unwrap_or(CapabilityLevel::Global);
        let _ = self.find(id, Some(level), record.project_path.as_deref())?;
        Ok(true)
    }

    pub fn set_enabled(
        &mut self,
        id: &str,
        enabled: bool,
        level: Option<CapabilityLevel>,
        project_path: Option<&str>,
    ) -> Result<Option<UserSkillRecord>> {
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
            SKILL_KIND,
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
    ) -> Result<Option<UserSkillRecord>> {
        // Scope is no longer persisted in capability files. Keep this RPC
        // harmless for older callers and return the scanned record.
        let _ = scope;
        self.find(id, None, None)
    }
}

fn scope_for(level: CapabilityLevel, project_path: Option<&str>) -> ActivationScope {
    match level {
        CapabilityLevel::Global => ActivationScope::default(),
        CapabilityLevel::Project => ActivationScope {
            mode: crate::activation::ActivationMode::Projects,
            projects: project_path.into_iter().map(str::to_string).collect(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn input(name: &str, level: &str, project_path: Option<&str>) -> UserSkillInput {
        UserSkillInput {
            name: Some(name.into()),
            level: Some(level.into()),
            project_path: project_path.map(str::to_string),
            description: Some("Check the relevant files".into()),
            body: Some("Do the thing.".into()),
            ..Default::default()
        }
    }

    #[test]
    fn imports_one_file_into_the_selected_agents_directory() {
        let app = tempdir().unwrap();
        let source = app.path().join("incoming.md");
        let raw = "---\nname: Review\ndescription: Check code\n---\n\nDo it.\n";
        fs::write(&source, raw).unwrap();
        let mut registry = UserSkillRegistry::new(app.path());
        let record = registry
            .import(
                source.to_str().unwrap(),
                input("Ignored", "project", Some(app.path().to_str().unwrap())),
            )
            .unwrap();
        let target = app.path().join(".agents/skills/review.md");
        assert_eq!(record.level.as_deref(), Some("project"));
        assert_eq!(record.path, target.to_string_lossy());
        assert_eq!(fs::read_to_string(target).unwrap(), raw);
        assert!(source.is_file());
    }

    #[test]
    fn project_skills_shadow_global_skills_by_name() {
        let app = tempdir().unwrap();
        let global = app.path().join("global");
        let project = app.path().join("project");
        fs::create_dir_all(global.join("skills")).unwrap();
        fs::create_dir_all(project.join(".agents/skills")).unwrap();
        fs::write(
            global.join("skills/review.md"),
            "---\nname: Review\n---\n\nGlobal\n",
        )
        .unwrap();
        fs::write(
            project.join(".agents/skills/review.md"),
            "---\nname: Review\n---\n\nProject\n",
        )
        .unwrap();
        let (fields, body) = parse_front_matter(
            &fs::read_to_string(project.join(".agents/skills/review.md")).unwrap(),
        );
        assert_eq!(fields.get("name").map(String::as_str), Some("Review"));
        assert_eq!(body, "Project");
    }

    #[test]
    fn disabled_project_skill_shadows_global_skill() {
        let global = UserSkillRecord {
            id: "review".into(),
            name: "Review".into(),
            level: Some("global".into()),
            project_path: None,
            description: Some("Global".into()),
            enabled: true,
            scope: ActivationScope::default(),
            source: "imported".into(),
            path: "/global/review.md".into(),
            size_bytes: 1,
            created_at: String::new(),
            updated_at: String::new(),
        };
        let mut project = global.clone();
        project.level = Some("project".into());
        project.project_path = Some("/repo".into());
        project.enabled = false;

        let active = merge_active_records(vec![global.clone()], vec![project]);
        assert!(active.is_empty());

        let mut project = global.clone();
        project.level = Some("project".into());
        project.project_path = Some("/repo".into());
        project.path = "/repo/.agents/skills/review.md".into();
        let active = merge_active_records(vec![global], vec![project.clone()]);
        assert_eq!(active, vec![project]);
    }

    #[test]
    fn capability_state_is_not_written_into_skill_documents() {
        let app = tempdir().unwrap();
        let mut state = CapabilityState::new(app.path(), SKILL_KIND);
        state
            .set_enabled(
                SKILL_KIND,
                CapabilityLevel::Project,
                "review",
                Some("/repo"),
                false,
            )
            .unwrap();
        assert!(!app
            .path()
            .join("agent-capabilities/skills.json")
            .to_string_lossy()
            .contains(".agents"));
    }

    #[test]
    fn import_uses_parent_directory_when_name_is_not_ascii() {
        let app = tempdir().unwrap();
        let source_dir = app.path().join("incoming/code-review");
        fs::create_dir_all(&source_dir).unwrap();
        let source = source_dir.join("SKILL.md");
        fs::write(
            &source,
            "---\nname: 代码审查\ndescription: >\n  Review diffs before merge.\n---\n\nCheck the patch.\n",
        )
        .unwrap();
        let mut registry = UserSkillRegistry::new(app.path());
        let record = registry
            .import(
                source.to_str().unwrap(),
                input("Ignored", "project", Some(app.path().to_str().unwrap())),
            )
            .unwrap();
        assert_eq!(record.id, "code-review");
        assert_eq!(record.name, "代码审查");
        assert_eq!(
            record.description.as_deref(),
            Some("Review diffs before merge.")
        );
        let listed = registry
            .list(CapabilityLevel::Project, Some(app.path().to_str().unwrap()))
            .unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, "code-review");
        assert_eq!(listed[0].name, "代码审查");
    }

    #[test]
    fn directory_skills_do_not_collide_on_the_skill_file_stem() {
        let app = tempdir().unwrap();
        let project = app.path().to_str().unwrap();
        fs::create_dir_all(app.path().join(".agents/skills/pdf")).unwrap();
        fs::create_dir_all(app.path().join(".agents/skills/docx")).unwrap();
        fs::write(
            app.path().join(".agents/skills/pdf/SKILL.md"),
            "# PDF\n\nExtract text.\n",
        )
        .unwrap();
        fs::write(
            app.path().join(".agents/skills/docx/SKILL.md"),
            "# DOCX\n\nEdit documents.\n",
        )
        .unwrap();
        let mut registry = UserSkillRegistry::new(app.path());
        let listed = registry
            .list(CapabilityLevel::Project, Some(project))
            .unwrap();
        let ids: Vec<_> = listed.iter().map(|record| record.id.as_str()).collect();
        assert_eq!(ids, vec!["docx", "pdf"]);
    }
}
