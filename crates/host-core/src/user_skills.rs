use crate::activation::ActivationScope;
use crate::agent_capabilities::{
    capability_dir, capability_id, copy_directory_tree, display_name_candidate, file_timestamp,
    move_capability_file, normalize_project_path, parse_front_matter, path_stem_for_id,
    set_moved_capability_state, slugify, sorted_files, suffixed_capability_id, valid_capability_id,
    CapabilityLevel, CapabilityState, CapabilityTarget, MAX_ID_SUFFIX,
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
    result.sort_by_key(|record| record.name.to_lowercase());
    result
}

/// The text after the opening `---` line, when `text` really starts frontmatter.
///
/// `parse_front_matter` accepts any first line that trims to `---`, so `--- `,
/// `---\r` and `--- \r\n` all open a block. A stricter check here would send
/// those documents down the "no frontmatter" path and copy the old block into
/// the body of a fresh one, leaving two frontmatter blocks in the file.
fn front_matter_body(text: &str) -> Option<&str> {
    let newline = text.find('\n')?;
    let first = text[..newline].trim_end_matches('\r');
    if first.trim() != "---" {
        return None;
    }
    Some(&text[newline + 1..])
}

/// Give a skill document the display name a destination needs, rewriting the
/// frontmatter `name` line and nothing else.
///
/// A move that has to rename must not reformat the document: `render_document`
/// normalizes prose, drops unknown frontmatter keys, and re-indents the body,
/// which would silently edit a file the user only asked to relocate. Everything
/// outside the rewritten lines — extra fields, whitespace, line endings — is
/// copied through byte for byte.
fn rewrite_document_name(raw: &str, name: &str) -> String {
    let value = name.replace(['\n', '\r'], " ");
    let (bom, text) = match raw.strip_prefix('\u{feff}') {
        Some(rest) => ("\u{feff}", rest),
        None => ("", raw),
    };
    let Some(front) = front_matter_body(text) else {
        return with_fresh_frontmatter(bom, text, &value);
    };
    let mut out = String::with_capacity(raw.len() + value.len() + 16);
    out.push_str(bom);
    out.push_str("---\n");
    let mut cursor = 0usize;
    let mut replaced = false;
    while cursor < front.len() {
        let end = match front[cursor..].find('\n') {
            Some(at) => cursor + at + 1,
            None => front.len(),
        };
        let line = &front[cursor..end];
        if line.trim_end_matches(['\n', '\r']).trim() == "---" {
            if !replaced {
                out.push_str(&format!("name: {value}\n"));
            }
            // The terminator and everything after it, body included, is copied
            // through untouched.
            out.push_str(&front[cursor..]);
            return out;
        }
        let top_level = !line.starts_with(' ') && !line.starts_with('\t');
        let is_name = top_level
            && line
                .trim_end_matches(['\n', '\r'])
                .split_once(':')
                .is_some_and(|(key, _)| key.trim().eq_ignore_ascii_case("name"));
        if is_name {
            if !replaced {
                out.push_str(&format!("name: {value}\n"));
                replaced = true;
            }
            // A later `name:` line is dropped rather than kept: the parser
            // inserts into a map, so the *last* line wins. Keeping a stale one
            // would silently defeat the rename — the document would keep its
            // old display name while the move claims it was changed.
        } else {
            out.push_str(line);
        }
        cursor = end;
    }
    // An unterminated opening delimiter is not frontmatter (`parse_front_matter`
    // rejects it), so the text becomes the body of a fresh, complete block.
    with_fresh_frontmatter(bom, text, &value)
}

fn with_fresh_frontmatter(bom: &str, text: &str, value: &str) -> String {
    format!(
        "{bom}---\nname: {value}\n---\n\n{}",
        text.trim_start_matches(['\n', '\r'])
    )
}

/// The directory a `<skill>/SKILL.md` document owns, when the document really is
/// the directory shape.
///
/// A skill may ship sibling resources next to its `SKILL.md`, so moving one
/// document is not enough — the directory is the unit. The guard matters: a
/// loose `SKILL.md` sitting directly in the skills directory has the skills
/// directory itself as its parent, and treating that as the unit would move
/// every skill at once.
fn directory_skill_root(path: &Path, skills_dir: &Path) -> Option<PathBuf> {
    if !path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("SKILL.md"))
    {
        return None;
    }
    let dir = path.parent()?;
    if dir == skills_dir {
        return None;
    }
    Some(dir.to_path_buf())
}

/// Where an arriving skill document should land, and under which display name.
struct SkillPlacement {
    name: String,
    stem: String,
}

/// The document a skill with `stem` occupies inside the skills directory.
///
/// Directory-shape skills live at `<stem>/SKILL.md` because the scan gives that
/// document the *directory* name as its path-derived id; flat skills are one
/// `<stem>.md` file. The two shapes are why the landing path cannot be derived
/// from the stem alone.
fn skill_document_path(directory: &Path, stem: &str, shared_directory: bool) -> PathBuf {
    if shared_directory {
        directory.join(stem).join("SKILL.md")
    } else {
        directory.join(format!("{stem}.md"))
    }
}

/// Choose the name and file stem an arriving skill must use at a destination.
///
/// The scan, not the move, decides the arriving document's id: it derives the
/// id from the frontmatter name first and only then from the path. Planning
/// against the file stem alone therefore mismatches every document whose name
/// slugs to something else — a Chinese name, or a name whose slug happens to be
/// another document's id — and a mismatch hides documents: the source is
/// already gone while the arrival is either not found or loses the scan's
/// `seen` de-duplication. So every candidate is put through the real
/// `capability_id` for the exact path it would land on, and only a placement
/// the scan lists as its own record is accepted. `shared_directory` selects the
/// destination's shape, because that shape decides what `path_stem_for_id`
/// reads.
fn plan_skill_placement(
    source: &UserSkillRecord,
    directory: &Path,
    shared_directory: bool,
    existing: &[UserSkillRecord],
) -> Option<SkillPlacement> {
    let taken_names = existing
        .iter()
        .map(|record| record.name.to_lowercase())
        .collect::<HashSet<_>>();
    // Ids are compared lowercased, like the filesystem that will hold them.
    let taken_ids = existing
        .iter()
        .map(|record| record.id.to_lowercase())
        .collect::<HashSet<_>>();
    for ordinal in 1..=MAX_ID_SUFFIX {
        let name = display_name_candidate(&source.name, ordinal, MAX_NAME_CHARS);
        // A duplicate display name makes shadowing merge two records on the
        // next scan, so the destination may not already have it.
        if name.is_empty() || taken_names.contains(&name.to_lowercase()) {
            continue;
        }
        // The scan prefers the name's slug, so a valid slug *is* the id the
        // document will carry and the file stem has to match it.
        let from_name = slugify(&name, 64);
        let stem = if valid_capability_id(&from_name, 64) {
            from_name
        } else {
            suffixed_capability_id(&source.id, &taken_ids, 64)?.0
        };
        let document_path = skill_document_path(directory, &stem, shared_directory);
        // Something already on disk at this path is either a listed document
        // (caught again below) or one the scan refuses to list; never write
        // over it.
        if document_path.exists() {
            continue;
        }
        // Simulate the real scan: `capability_id` can still land on an id the
        // name slug did not predict (the path fallback), and an id collision
        // makes one of the two documents disappear from the catalog.
        let id = capability_id(&name, &document_path, 64);
        if !valid_capability_id(&id, 64) || taken_ids.contains(&id.to_lowercase()) {
            continue;
        }
        return Some(SkillPlacement { name, stem });
    }
    None
}

/// True when a scanned record path names the document a move just wrote.
///
/// The record path comes back from a directory scan and the planned path from a
/// join, so the comparison is normalized and case-insensitive — the same rules
/// project paths use, and the only rules that hold on a volume that ignores
/// case.
fn same_document(record_path: &str, planned: &Path) -> bool {
    normalize_project_path(record_path)
        .eq_ignore_ascii_case(&normalize_project_path(&planned.to_string_lossy()))
}

impl UserSkillRegistry {
    /// Move one skill between the global directory and a project's.
    ///
    /// The document moves instead of being copied: a copy would leave the old
    /// level holding a skill the user just said belongs somewhere else. When the
    /// destination already owns the same id or display name the arriving skill
    /// is renamed, so both survive under names that tell them apart. The
    /// arriving document's id is read back from a scan by path, because a
    /// skill's id can come from its name rather than its file stem, and the
    /// state is written only once that record exists. A landing the scan would
    /// hide is rolled back to the source instead of stranding the skill.
    pub fn transfer(
        &mut self,
        id: &str,
        from: &CapabilityTarget,
        to: &CapabilityTarget,
    ) -> Result<UserSkillRecord> {
        let Some(source) = self.find(id, Some(from.level), from.project_path.as_deref())? else {
            bail!("SKILL_INVALID: unknown skill \"{id}\"");
        };
        if from.same_directory(to) {
            return Ok(source);
        }
        let source_path = PathBuf::from(&source.path);
        let raw = fs::read_to_string(&source_path)
            .with_context(|| format!("read {}", source_path.display()))?;
        if raw.len() > MAX_SKILL_BYTES {
            bail!("SKILL_INVALID: document exceeds {MAX_SKILL_BYTES} bytes");
        }
        let existing = self.list(to.level, to.project_path.as_deref())?;
        if existing.len() >= MAX_SKILLS {
            bail!("SKILL_INVALID: at most {MAX_SKILLS} skills");
        }

        let source_dir = capability_dir(from.level, from.project_path.as_deref(), "skills")?;
        let directory = capability_dir(to.level, to.project_path.as_deref(), "skills")?;
        let owned_dir = directory_skill_root(&source_path, &source_dir);
        let shared_directory = owned_dir.is_some();
        let placement = plan_skill_placement(&source, &directory, shared_directory, &existing)
            .ok_or_else(|| anyhow::anyhow!("SKILL_INVALID: no free name at the destination"))?;
        let document_path = skill_document_path(&directory, &placement.stem, shared_directory);
        let source_unit = owned_dir.clone().unwrap_or_else(|| source_path.clone());
        let target_unit = if shared_directory {
            match document_path.parent() {
                Some(parent) => parent.to_path_buf(),
                None => directory.join(&placement.stem),
            }
        } else {
            document_path.clone()
        };
        let rewritten = placement.name != source.name;

        if !rewritten {
            move_capability_file(&source_unit, &target_unit)?;
        } else {
            let document = rewrite_document_name(&raw, &placement.name);
            if document.len() > MAX_SKILL_BYTES {
                bail!("SKILL_INVALID: document exceeds {MAX_SKILL_BYTES} bytes");
            }
            if shared_directory && target_unit.exists() {
                // The destination id is unique at this level, so `<stem>/` is a
                // directory this move creates. Anything already sitting there
                // is not this skill's to overwrite or merge into.
                bail!(
                    "SKILL_INVALID: destination already exists: {}",
                    target_unit.display()
                );
            }
            if let Some(parent) = document_path.parent() {
                fs::create_dir_all(parent)?;
            }
            // Written before the source is removed, so a failure in between
            // leaves a shadowed duplicate rather than no skill at all.
            fs::write(&document_path, document)
                .with_context(|| format!("write {}", document_path.display()))?;
            if let Some(dir) = &owned_dir {
                // Only the document travelled; resources beside it are part of
                // the skill, so the rest of the directory follows. The landing
                // directory is new, so overwriting a same-named leftover from
                // an interrupted move is safe.
                copy_directory_tree(dir, &target_unit, true)?;
                fs::remove_dir_all(dir)
                    .map_err(|error| anyhow::anyhow!("remove {}: {error}", dir.display()))?;
            } else {
                fs::remove_file(&source_path).map_err(|error| {
                    anyhow::anyhow!("remove {}: {error}", source_path.display())
                })?;
            }
        }

        // The record is resolved by path, never by the planned stem: the scan
        // derives the arriving document's id from its name, and the name's slug
        // is not necessarily the file stem this move chose.
        let landed = self
            .list(to.level, to.project_path.as_deref())?
            .into_iter()
            .find(|record| same_document(&record.path, &document_path));
        let Some(moved) = landed else {
            // The document is on disk but the scan will not list it (empty
            // body, over the byte limit, or shadowed by a same-id document).
            // The source is already gone, so the move has to be undone: put the
            // unit back where it came from and restore the original bytes,
            // because the rewritten name would give the restored document a
            // different id. State was never written, so nothing else changes.
            move_capability_file(&target_unit, &source_unit).map_err(|error| {
                anyhow::anyhow!(
                    "SKILL_INVALID: the moved skill was not found and could not be restored to {}: {error}",
                    source_unit.display()
                )
            })?;
            fs::write(&source_path, &raw)
                .with_context(|| format!("restore {}", source_path.display()))?;
            bail!("SKILL_INVALID: moved skill was not found");
        };
        set_moved_capability_state(
            &mut self.state,
            SKILL_KIND,
            from.level,
            &source.id,
            source.project_path.as_deref(),
            to,
            &moved.id,
            source.enabled,
        )?;
        self.find(&moved.id, Some(to.level), to.project_path.as_deref())?
            .ok_or_else(|| anyhow::anyhow!("SKILL_INVALID: moved skill was not found"))
    }
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
        self.find(id, level, record.project_path.as_deref())
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
mod tests;
