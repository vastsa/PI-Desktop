use anyhow::{bail, Context, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// The only on-disk roots owned by user-facing agent capability management.
pub const AGENTS_DIR: &str = ".agents";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CapabilityLevel {
    Global,
    Project,
}

impl CapabilityLevel {
    pub fn parse(value: Option<&str>) -> Result<Self> {
        match value.unwrap_or("global") {
            "global" => Ok(Self::Global),
            "project" => Ok(Self::Project),
            other => bail!("CAPABILITY_INVALID: unknown level \"{other}\""),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Global => "global",
            Self::Project => "project",
        }
    }
}

/// The application-local state file deliberately lives outside capability
/// directories. Capability documents remain portable and user-editable.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct StateFile {
    #[serde(default)]
    values: BTreeMap<String, bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StateKey {
    kind: String,
    level: String,
    id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    project_path: Option<String>,
}

pub struct CapabilityState {
    path: PathBuf,
    values: BTreeMap<String, bool>,
}

impl CapabilityState {
    pub fn new(data_dir: &Path, kind: &str) -> Self {
        let path = data_dir
            .join("agent-capabilities")
            .join(format!("{kind}.json"));
        let values = fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str::<StateFile>(&raw).ok())
            .map(|file| file.values)
            .unwrap_or_default();
        Self { path, values }
    }

    fn key(kind: &str, level: CapabilityLevel, id: &str, project_path: Option<&str>) -> String {
        serde_json::to_string(&StateKey {
            kind: kind.to_string(),
            level: level.as_str().to_string(),
            id: id.to_string(),
            project_path: project_path.map(normalize_project_path),
        })
        .expect("state key is serializable")
    }

    fn get(
        &self,
        kind: &str,
        level: CapabilityLevel,
        id: &str,
        project_path: Option<&str>,
    ) -> Option<bool> {
        self.values
            .get(&Self::key(kind, level, id, project_path))
            .copied()
    }

    /// Global records default on. A global record may have a per-project
    /// override, while a project record has one state for its owning project.
    pub fn enabled(
        &self,
        kind: &str,
        level: CapabilityLevel,
        id: &str,
        project_path: Option<&str>,
    ) -> bool {
        match level {
            CapabilityLevel::Global => project_path
                .and_then(|path| self.get(kind, level, id, Some(path)))
                .or_else(|| self.get(kind, level, id, None))
                .unwrap_or(true),
            CapabilityLevel::Project => self.get(kind, level, id, project_path).unwrap_or(true),
        }
    }

    pub fn set_enabled(
        &mut self,
        kind: &str,
        level: CapabilityLevel,
        id: &str,
        project_path: Option<&str>,
        enabled: bool,
    ) -> Result<()> {
        let path = project_path.map(normalize_project_path);
        let key = Self::key(kind, level, id, path.as_deref());
        match level {
            CapabilityLevel::Global if path.is_some() => {
                let global_default = self.get(kind, level, id, None).unwrap_or(true);
                if enabled == global_default {
                    self.values.remove(&key);
                } else {
                    self.values.insert(key, enabled);
                }
            }
            CapabilityLevel::Global => {
                if enabled {
                    self.values.remove(&key);
                } else {
                    self.values.insert(key, false);
                }
            }
            CapabilityLevel::Project => {
                if enabled {
                    self.values.remove(&key);
                } else {
                    self.values.insert(key, false);
                }
            }
        }
        self.save()
    }

    /// Every id of `kind` at `level` whose stored value is an explicit `false`.
    ///
    /// Global records default on, so the state file holds only what a user
    /// turned off. A caller that owns a catalog of records with no document to
    /// scan — the shipped subagent builtins — needs exactly these ids, because
    /// the directory scan that prunes state for deleted files can never see
    /// them. Ids come back sorted so a result never depends on insertion order.
    pub fn disabled_ids(&self, kind: &str, level: CapabilityLevel) -> Vec<String> {
        let mut ids: Vec<String> = self
            .values
            .iter()
            .filter(|(_, enabled)| !**enabled)
            .filter_map(|(raw_key, _)| serde_json::from_str::<StateKey>(raw_key).ok())
            .filter(|key| {
                key.kind == kind && key.level == level.as_str() && key.project_path.is_none()
            })
            .map(|key| key.id)
            .collect();
        ids.sort();
        ids
    }

    /// Remove state for records that disappeared from the selected directory.
    /// Other project selections remain untouched because they may still exist.
    pub fn prune(
        &mut self,
        kind: &str,
        level: CapabilityLevel,
        project_path: Option<&str>,
        ids: &std::collections::HashSet<String>,
    ) -> Result<()> {
        let normalized_project = project_path.map(normalize_project_path);
        let before = self.values.len();
        self.values.retain(|raw_key, _| {
            let Ok(key) = serde_json::from_str::<StateKey>(raw_key) else {
                return false;
            };
            if key.kind != kind || key.level != level.as_str() || ids.contains(&key.id) {
                return true;
            }
            match level {
                // A global file is the source for every project, so every
                // override for a missing global id is orphaned at once.
                CapabilityLevel::Global => false,
                // A project scan only has authority over the selected project;
                // overrides belonging to other projects may still be live.
                CapabilityLevel::Project => match (&key.project_path, &normalized_project) {
                    (Some(key_project), Some(selected)) => !same_path(key_project, selected),
                    _ => false,
                },
            }
        });
        if before != self.values.len() {
            self.save()?;
        }
        Ok(())
    }

    /// Drop the stored state of one document at its source level.
    ///
    /// A global document is one shared file, so its id owns the global default
    /// and every project override alike: they are all dropped, whichever
    /// project context the move started from (`project_path` is ignored there).
    /// A project document has exactly one owner, so only the entry belonging to
    /// `project_path` goes with it — another project's same-named document is a
    /// different file with its own state.
    pub fn forget(
        &mut self,
        kind: &str,
        level: CapabilityLevel,
        id: &str,
        project_path: Option<&str>,
    ) -> Result<()> {
        let before = self.values.len();
        self.values.retain(|raw_key, _| {
            let Ok(key) = serde_json::from_str::<StateKey>(raw_key) else {
                return false;
            };
            if key.kind != kind || key.level != level.as_str() || key.id != id {
                return true;
            }
            match level {
                CapabilityLevel::Global => false,
                CapabilityLevel::Project => match (&key.project_path, project_path) {
                    (Some(owner), Some(selected)) => !same_path(owner, selected),
                    (None, None) => false,
                    _ => true,
                },
            }
        });
        if before != self.values.len() {
            self.save()?;
        }
        Ok(())
    }

    fn save(&self) -> Result<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        let file = StateFile {
            values: self.values.clone(),
        };
        fs::write(&self.path, serde_json::to_string_pretty(&file)?)?;
        Ok(())
    }
}

/// Repoints the global capability root, the way `PI_DESKTOP_DATA_DIR` repoints
/// the app-local data directory.
///
/// The global `.agents` root is otherwise the real home directory, which leaves
/// the global half of a level switch untestable and makes an isolated install
/// impossible. An empty value falls back to the home directory.
pub const AGENTS_DIR_ENV: &str = "PI_DESKTOP_AGENTS_DIR";

pub fn global_agents_dir() -> PathBuf {
    if let Ok(configured) = std::env::var(AGENTS_DIR_ENV) {
        let trimmed = configured.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(AGENTS_DIR)
}

pub fn capability_dir(
    level: CapabilityLevel,
    project_path: Option<&str>,
    leaf: &str,
) -> Result<PathBuf> {
    match level {
        CapabilityLevel::Global => Ok(global_agents_dir().join(leaf)),
        CapabilityLevel::Project => {
            let path = project_path
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| anyhow::anyhow!("CAPABILITY_INVALID: projectPath is required"))?;
            Ok(PathBuf::from(path).join(AGENTS_DIR).join(leaf))
        }
    }
}

pub fn normalize_project_path(path: &str) -> String {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let mut normalized = trimmed.replace('\\', "/");
    while normalized.len() > 1
        && normalized.ends_with('/')
        && !normalized
            .strip_suffix('/')
            .is_some_and(|prefix| prefix.ends_with(':'))
    {
        normalized.pop();
    }
    normalized
}

fn same_path(a: &str, b: &str) -> bool {
    normalize_project_path(a).to_lowercase() == normalize_project_path(b).to_lowercase()
}

/// One place a capability document can live: a level plus, for the project
/// level, the project that owns it.
///
/// A global target may still carry a project path. There it means "resolve the
/// global document with this project's enabled override", which is the context
/// a move needs to read the state the user was actually looking at.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapabilityTarget {
    pub level: CapabilityLevel,
    pub project_path: Option<String>,
}

impl CapabilityTarget {
    pub fn new(level: CapabilityLevel, project_path: Option<&str>) -> Result<Self> {
        let project_path = project_path
            .map(normalize_project_path)
            .filter(|value| !value.is_empty());
        if level == CapabilityLevel::Project && project_path.is_none() {
            bail!("CAPABILITY_INVALID: projectPath is required for project capabilities");
        }
        Ok(Self {
            level,
            project_path,
        })
    }

    /// True when both targets name the same directory.
    pub fn same_directory(&self, other: &Self) -> bool {
        if self.level != other.level {
            return false;
        }
        match (&self.project_path, &other.project_path) {
            (Some(a), Some(b)) => same_path(a, b),
            (None, None) => true,
            // A global target's project path is a state context, not an owner,
            // so two global targets always name the same directory.
            _ => self.level == CapabilityLevel::Global,
        }
    }
}

/// Carry a moved document's activation state across to its destination.
///
/// The value that travels is the one the user was looking at at the source. A
/// document arriving in a project gets that project's own state; one arriving
/// globally gets the global default, never a per-project override, because the
/// move says nothing about the projects it left behind. The source entry is
/// dropped first so the old level holds no state for a document it lost, and
/// `source_project_path` scopes that drop to the document's real owner: moving
/// project A's document must not clear project B's state for a same-named one.
// Every parameter names a distinct part of the move (source kind, level, id,
// owner, target, target id, value); bundling them would hide the owner, which
// is the one that must not be dropped.
#[allow(clippy::too_many_arguments)]
pub fn set_moved_capability_state(
    state: &mut CapabilityState,
    kind: &str,
    source_level: CapabilityLevel,
    source_id: &str,
    source_project_path: Option<&str>,
    target: &CapabilityTarget,
    target_id: &str,
    enabled: bool,
) -> Result<()> {
    state.forget(kind, source_level, source_id, source_project_path)?;
    let owner = match target.level {
        CapabilityLevel::Global => None,
        CapabilityLevel::Project => target.project_path.as_deref(),
    };
    state.set_enabled(kind, target.level, target_id, owner, enabled)
}

/// How many `-2`, `-3`, … candidates a move tries before giving up.
pub(crate) const MAX_ID_SUFFIX: u32 = 999;

/// The id a document should carry at a destination that already holds `taken`.
///
/// A level switch that silently overwrote a document the user still has would
/// be data loss, and refusing the move outright would make the global/project
/// switch useless whenever both sides happen to share a name. Renaming mirrors
/// how a file manager disambiguates a copy. The returned ordinal is the suffix
/// that was applied, or `0` when the preferred id was free.
///
/// `taken` must already be lowercased, and the comparison is lowercased on
/// both sides: on macOS and Windows `MyServer.json` and `myserver.json` are the
/// same file, so a case-sensitive check would hand the arriving document a name
/// that silently replaces an existing one.
pub fn suffixed_capability_id(
    preferred: &str,
    taken: &HashSet<String>,
    max_chars: usize,
) -> Option<(String, u32)> {
    if !taken.contains(&preferred.to_lowercase()) {
        return Some((preferred.to_string(), 0));
    }
    for ordinal in 2..=MAX_ID_SUFFIX {
        let suffix = format!("-{ordinal}");
        let keep = max_chars.saturating_sub(suffix.len());
        let mut base: String = preferred.chars().take(keep).collect();
        while base.ends_with('-') {
            base.pop();
        }
        if base.is_empty() {
            return None;
        }
        let candidate = format!("{base}{suffix}");
        if !taken.contains(&candidate.to_lowercase()) {
            return Some((candidate, ordinal));
        }
    }
    None
}

/// The display name for `ordinal` collisions, suffix included.
///
/// `ordinal <= 1` is the name itself, trimmed to the character budget.
/// Otherwise the suffix is appended *after* the base is trimmed to fit, so a
/// name already at the budget still yields a distinct candidate instead of a
/// truncated copy of itself, and a base cut mid-word keeps no trailing space
/// before the suffix.
pub fn display_name_candidate(name: &str, ordinal: u32, max_chars: usize) -> String {
    if ordinal <= 1 {
        return name.chars().take(max_chars).collect();
    }
    let suffix = format!(" ({ordinal})");
    let keep = max_chars.saturating_sub(suffix.len());
    let mut base: String = name.chars().take(keep).collect();
    while base.ends_with(' ') {
        base.pop();
    }
    format!("{base}{suffix}")
}

/// The display name a document should carry at a destination that already
/// holds `taken` (compared case-insensitively, the way shadowing compares it).
pub fn suffixed_display_name(preferred: &str, taken: &HashSet<String>, max_chars: usize) -> String {
    for ordinal in 1..=MAX_ID_SUFFIX {
        let candidate = display_name_candidate(preferred, ordinal, max_chars);
        if !candidate.is_empty() && !taken.contains(&candidate.to_lowercase()) {
            return candidate;
        }
    }
    preferred.to_string()
}

/// Copy a directory tree, optionally leaving a skill's own `SKILL.md` behind.
///
/// Shared by the cross-filesystem fallback of `move_capability_file` and the
/// skill move that has already written the renamed document and only needs the
/// resources beside it (`skip_skill_document` skips the document at the root of
/// `from` — the one the caller wrote; a nested `SKILL.md` is just a resource
/// and is copied, because the source directory is deleted afterwards).
/// Same-named files are overwritten: the destination unit is new (its id is
/// unique at the level), so a file already there can only be the leftover of an
/// interrupted move, never another skill's data.
pub fn copy_directory_tree(from: &Path, to: &Path, skip_skill_document: bool) -> Result<()> {
    fs::create_dir_all(to).map_err(|error| anyhow::anyhow!("create {}: {error}", to.display()))?;
    let entries = fs::read_dir(from).with_context(|| format!("read {}", from.display()))?;
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name() else {
            continue;
        };
        if skip_skill_document && name.eq_ignore_ascii_case("SKILL.md") {
            continue;
        }
        let target = to.join(name);
        if path.is_dir() {
            copy_directory_tree(&path, &target, false)?;
        } else {
            fs::copy(&path, &target)
                .map_err(|error| anyhow::anyhow!("copy {}: {error}", path.display()))?;
        }
    }
    Ok(())
}

/// Move one capability document or directory, staying byte-identical whenever
/// the caller does not need to rewrite it.
///
/// `fs::rename` is tried first so a same-filesystem move is atomic and cheap;
/// the copy fallback covers a project on another mount. `fs::copy` cannot move
/// a directory (it fails with EISDIR), so a directory falls back to a recursive
/// copy, a destination check, and only then a recursive delete of the source:
/// the copy is complete before the original is touched, so a failure leaves the
/// source intact. The caller must have checked that `to` is free, because this
/// never replaces an existing destination.
pub fn move_capability_file(from: &Path, to: &Path) -> Result<()> {
    if to.exists() {
        bail!(
            "CAPABILITY_INVALID: destination already exists: {}",
            to.display()
        );
    }
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent)?;
    }
    match fs::rename(from, to) {
        Ok(()) => Ok(()),
        Err(_) => {
            if from.is_dir() {
                copy_directory_tree(from, to, false)?;
                if !to.is_dir() {
                    bail!(
                        "CAPABILITY_INVALID: could not copy directory {}",
                        from.display()
                    );
                }
                fs::remove_dir_all(from)
                    .map_err(|error| anyhow::anyhow!("remove {}: {error}", from.display()))?;
                return Ok(());
            }
            fs::copy(from, to)
                .map_err(|error| anyhow::anyhow!("copy {}: {error}", from.display()))?;
            fs::remove_file(from)
                .map_err(|error| anyhow::anyhow!("remove {}: {error}", from.display()))?;
            Ok(())
        }
    }
}

pub fn parse_front_matter(raw: &str) -> (BTreeMap<String, String>, String) {
    let text = raw.trim_start_matches('\u{feff}');
    let Some(rest) = text.strip_prefix("---") else {
        return (BTreeMap::new(), text.trim().to_string());
    };
    let Some((head, tail)) = rest.split_once('\n') else {
        return (BTreeMap::new(), text.trim().to_string());
    };
    if !head.trim().is_empty() {
        return (BTreeMap::new(), text.trim().to_string());
    }
    let mut fields = BTreeMap::new();
    let mut consumed = 0usize;
    let mut lines = tail.split_inclusive('\n').peekable();
    while let Some(line) = lines.next() {
        consumed += line.len();
        let trimmed = line.trim_end_matches(['\n', '\r']).trim_end();
        if trimmed.trim() == "---" {
            return (fields, tail[consumed..].trim().to_string());
        }
        let content = trimmed.trim();
        if content.is_empty() || content.starts_with('#') {
            continue;
        }
        // Nested YAML maps are ignored; block scalars collect indent below.
        if trimmed.starts_with(' ') || trimmed.starts_with('\t') {
            continue;
        }
        let Some((key, raw_value)) = trimmed.split_once(':') else {
            continue;
        };
        let key = key.trim().to_lowercase();
        if key.is_empty() {
            continue;
        }
        let raw_value = raw_value.trim();
        if is_block_scalar_indicator(raw_value) {
            let mut block = String::new();
            while let Some(next) = lines.peek().copied() {
                let next_trimmed = next.trim_end_matches(['\n', '\r']).trim_end();
                if next_trimmed.trim() == "---" {
                    break;
                }
                let next_content = next_trimmed.trim();
                let indented = next_trimmed.starts_with(' ') || next_trimmed.starts_with('\t');
                if !indented && !next_content.is_empty() {
                    break;
                }
                let _ = lines.next();
                consumed += next.len();
                if indented && !next_content.is_empty() {
                    if !block.is_empty() {
                        block.push(' ');
                    }
                    block.push_str(next_content);
                }
            }
            if !block.is_empty() {
                fields.insert(key, block);
            }
            continue;
        }
        let value = raw_value.trim_matches('"').trim_matches('\'').trim();
        if !value.is_empty() {
            fields.insert(key, value.to_string());
        }
    }
    (BTreeMap::new(), text.trim().to_string())
}

fn is_block_scalar_indicator(value: &str) -> bool {
    matches!(value, "|" | "|-" | "|+" | ">" | ">-" | ">+")
}

/// True when `id` can be used as a capability file stem and RPC id.
pub fn valid_capability_id(id: &str, max_chars: usize) -> bool {
    !id.is_empty()
        && id.len() <= max_chars
        && id.starts_with(|c: char| c.is_ascii_alphanumeric())
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// Display-name fallback when frontmatter has no `name`.
///
/// `<skill>/SKILL.md` uses the directory, not the `SKILL` file stem — otherwise
/// every unnamed directory skill collapses onto the same id. Dump folders
/// (`Downloads`, `Desktop`, …) are skipped so a picker import does not inherit
/// the staging directory as its id.
pub fn path_stem_for_id(path: &Path) -> String {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("");
    if file_name.eq_ignore_ascii_case("SKILL.md") {
        if let Some(parent) = path
            .parent()
            .and_then(|parent| parent.file_name())
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty() && !is_generic_skill_parent(name))
        {
            return parent.to_string();
        }
        return String::new();
    }
    path.file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("skill")
        .to_string()
}

fn is_generic_skill_parent(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "downloads"
            | "desktop"
            | "documents"
            | "tmp"
            | "temp"
            | "incoming"
            | "files"
            | "home"
            | "users"
            | "skills"
            | "skill"
    )
}

/// Resolve a stable ASCII id from a display name and on-disk path.
///
/// Frontmatter names are often not ASCII (Chinese titles, etc.). Prefer the
/// slug of the name, then the path stem, then a hash so a readable document is
/// never silently dropped from the catalog. The path fallback `skill` is
/// skipped: that is the stem of `SKILL.md` and would collide across imports.
pub fn capability_id(name: &str, path: &Path, max_chars: usize) -> String {
    let from_name = slugify(name, max_chars);
    if valid_capability_id(&from_name, max_chars) {
        return from_name;
    }
    let from_path = slugify(&path_stem_for_id(path), max_chars);
    if valid_capability_id(&from_path, max_chars) && from_path != "skill" {
        return from_path;
    }
    let mut hasher = Sha256::new();
    hasher.update(name.as_bytes());
    let hex = hex::encode(&hasher.finalize()[..6]);
    format!("skill-{hex}")
}

pub fn slugify(value: &str, max_chars: usize) -> String {
    let mut slug = String::new();
    let mut last_dash = false;
    for ch in value.trim().to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch);
            last_dash = false;
        } else if !slug.is_empty() && !last_dash {
            slug.push('-');
            last_dash = true;
        }
    }
    while slug.ends_with('-') {
        slug.pop();
    }
    slug.truncate(max_chars);
    while slug.ends_with('-') {
        slug.pop();
    }
    slug
}

pub fn file_timestamp(path: &Path) -> String {
    fs::metadata(path)
        .ok()
        .and_then(|metadata| metadata.modified().ok())
        .map(|time| DateTime::<Utc>::from(time).to_rfc3339())
        .unwrap_or_else(|| DateTime::<Utc>::from(SystemTime::UNIX_EPOCH).to_rfc3339())
}

pub fn sorted_files(dir: &Path, extension: &str) -> Vec<PathBuf> {
    let mut files = fs::read_dir(dir)
        .ok()
        .into_iter()
        .flat_map(|entries| entries.filter_map(|entry| entry.ok().map(|item| item.path())))
        .filter(|path| {
            path.is_file()
                && path
                    .extension()
                    .and_then(|value| value.to_str())
                    .is_some_and(|value| value.eq_ignore_ascii_case(extension))
        })
        .collect::<Vec<_>>();
    files.sort();
    files
}

/// Test-only seams shared by every capability module.
#[cfg(test)]
pub(crate) mod test_support {
    use std::path::Path;
    use std::sync::Mutex;

    static AGENTS_ENV_LOCK: Mutex<()> = Mutex::new(());

    /// Point the global capability root at `dir` for the duration of `f`.
    ///
    /// `PI_DESKTOP_AGENTS_DIR` is process-global and the test harness runs
    /// tests in parallel threads, so every repointing test takes this one lock:
    /// per-module locks would not exclude each other, and two tests would end up
    /// reading each other's directory.
    pub fn with_global_agents<T>(dir: &Path, f: impl FnOnce() -> T) -> T {
        let _guard = AGENTS_ENV_LOCK
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        // Safety: test-only process env mutation, serialized by the lock above.
        unsafe { std::env::set_var(super::AGENTS_DIR_ENV, dir) };
        let outcome = f();
        unsafe { std::env::remove_var(super::AGENTS_DIR_ENV) };
        outcome
    }
}

#[cfg(test)]
mod tests;
