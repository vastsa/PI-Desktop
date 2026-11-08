//! Run artifacts on disk. Every path is a workspace-relative path the
//! snapshot declared; it is resolved under the session's workspace root and
//! refused when it (or a symlink on the way) leaves that root.

use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use anyhow::Result;

use super::snapshot::{valid_artifact_path, ModeDefinition};
use super::{mode_error, mode_error_detail};

/// Largest artifact a stage completion may write.
pub const MAX_ARTIFACT_BYTES: usize = 256 * 1024;
/// Largest artifact a `require` gate reads; a bigger file fails the gate.
const MAX_READ_BYTES: u64 = 1024 * 1024;

fn path_error(detail: impl std::fmt::Display) -> anyhow::Error {
    mode_error_detail("MODE_ARTIFACT_PATH", detail)
}

fn canonical_root(workspace: &Path) -> Result<PathBuf> {
    fs::canonicalize(workspace).map_err(|error| path_error(format!("workspace root: {error}")))
}

/// `root/relative` after the lexical rules. Nothing is touched on disk.
fn lexical_target(root: &Path, relative: &str) -> Result<PathBuf> {
    if !valid_artifact_path(relative) {
        return Err(path_error(format!("`{relative}` is not a workspace-relative path")));
    }
    let mut target = root.to_path_buf();
    for segment in relative.split('/') {
        if segment == "." {
            continue;
        }
        target.push(segment);
    }
    Ok(target)
}

/// Deepest existing ancestor of `path`, canonicalized.
fn existing_ancestor(path: &Path) -> Result<PathBuf> {
    let mut current = path;
    loop {
        if current.exists() {
            return fs::canonicalize(current).map_err(path_error);
        }
        current = current
            .parent()
            .ok_or_else(|| path_error("no existing ancestor"))?;
    }
}

fn ensure_inside(root: &Path, path: &Path, relative: &str) -> Result<()> {
    if path.starts_with(root) {
        Ok(())
    } else {
        Err(path_error(format!("`{relative}` leaves the workspace")))
    }
}

/// Write `content` to `relative` under `workspace`, creating parent
/// directories. The write is a sibling temp file plus rename, so an existing
/// symlink at the target is replaced rather than followed.
pub fn write(workspace: &Path, relative: &str, content: &str) -> Result<()> {
    if content.len() > MAX_ARTIFACT_BYTES {
        return Err(mode_error_detail(
            "MODE_ARTIFACT_TOO_LARGE",
            format!("`{relative}` is larger than 256 KiB"),
        ));
    }
    let root = canonical_root(workspace)?;
    let target = lexical_target(&root, relative)?;
    let parent = target
        .parent()
        .ok_or_else(|| path_error("artifact has no parent directory"))?;
    ensure_inside(&root, &existing_ancestor(parent)?, relative)?;
    fs::create_dir_all(parent).map_err(path_error)?;
    let parent = fs::canonicalize(parent).map_err(path_error)?;
    ensure_inside(&root, &parent, relative)?;
    let name = target
        .file_name()
        .ok_or_else(|| path_error("artifact has no file name"))?;
    let final_path = parent.join(name);
    let temp = parent.join(format!(
        ".{}.{}.tmp",
        name.to_string_lossy(),
        uuid::Uuid::new_v4()
    ));
    fs::write(&temp, content).map_err(|error| mode_error_detail("MODE_ARTIFACT_WRITE", error))?;
    if let Err(error) = fs::rename(&temp, &final_path) {
        let _ = fs::remove_file(&temp);
        return Err(mode_error_detail("MODE_ARTIFACT_WRITE", error));
    }
    Ok(())
}

/// Read `relative` under `workspace`; `None` when it does not exist.
pub fn read(workspace: &Path, relative: &str) -> Result<Option<String>> {
    let root = canonical_root(workspace)?;
    let target = lexical_target(&root, relative)?;
    if fs::symlink_metadata(&target).is_err() {
        return Ok(None);
    }
    let resolved = match fs::canonicalize(&target) {
        Ok(resolved) => resolved,
        // A dangling symlink is a missing artifact.
        Err(_) => return Ok(None),
    };
    ensure_inside(&root, &resolved, relative)?;
    if !resolved.is_file() {
        return Ok(None);
    }
    let mut bytes = Vec::new();
    fs::File::open(&resolved)
        .and_then(|file| file.take(MAX_READ_BYTES + 1).read_to_end(&mut bytes))
        .map_err(|error| mode_error_detail("MODE_ARTIFACT_READ", error))?;
    if bytes.len() as u64 > MAX_READ_BYTES {
        return Err(mode_error_detail(
            "MODE_ARTIFACT_TOO_LARGE",
            format!("`{relative}` is larger than 1 MiB"),
        ));
    }
    Ok(Some(String::from_utf8_lossy(&bytes).into_owned()))
}

/// Required headings `markdown` lacks, in declaration order. Mirrors
/// `missingModeHeadings` in `packages/shared/src/mode-definition.ts`: ATX
/// headings at any level, case-insensitive, trailing `#` ignored, fenced
/// lines skipped.
pub fn missing_headings(markdown: &str, required: &[String]) -> Vec<String> {
    let mut present = std::collections::HashSet::new();
    let mut fenced = false;
    for line in markdown.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            fenced = !fenced;
        }
        if fenced {
            continue;
        }
        if let Some(text) = heading_text(line) {
            present.insert(text.to_lowercase());
        }
    }
    required
        .iter()
        .filter(|heading| !present.contains(&heading.trim().to_lowercase()))
        .cloned()
        .collect()
}

fn heading_text(line: &str) -> Option<String> {
    let indent = line.len() - line.trim_start_matches(' ').len();
    if indent > 3 {
        return None;
    }
    let rest = &line[indent..];
    let hashes = rest.len() - rest.trim_start_matches('#').len();
    if !(1..=6).contains(&hashes) {
        return None;
    }
    let rest = &rest[hashes..];
    if !rest.starts_with(|ch: char| ch.is_whitespace()) {
        return None;
    }
    let text = rest
        .trim()
        .trim_end_matches('#')
        .trim_end()
        .to_string();
    Some(text)
}

/// Outcome of a `require` gate: `Err(message)` names the file or headings.
pub fn check_required(
    workspace: &Path,
    artifact_id: &str,
    relative: &str,
    required: &[String],
) -> Result<std::result::Result<(), String>> {
    let Some(markdown) = read(workspace, relative)? else {
        return Ok(Err(format!(
            "artifact `{artifact_id}` is missing: write {relative}"
        )));
    };
    let missing = missing_headings(&markdown, required);
    if missing.is_empty() {
        Ok(Ok(()))
    } else {
        Ok(Err(format!(
            "artifact `{artifact_id}` ({relative}) is missing headings: {}",
            missing.join(", ")
        )))
    }
}

/// Copy declared templates into place for artifacts that do not exist yet.
pub fn seed_templates(
    workspace: &Path,
    definition: &ModeDefinition,
    paths: &BTreeMap<String, String>,
) -> Result<()> {
    for artifact in &definition.artifacts {
        let (Some(template), Some(relative)) = (&artifact.template, paths.get(&artifact.id)) else {
            continue;
        };
        if read(workspace, relative)?.is_none() {
            write(workspace, relative, template)?;
        }
    }
    Ok(())
}

/// Write the artifacts a stage completion carries; all ids and sizes are
/// checked before the first byte is written.
pub fn write_declared(
    workspace: &Path,
    paths: &BTreeMap<String, String>,
    artifacts: &BTreeMap<String, String>,
) -> Result<()> {
    for (id, content) in artifacts {
        if !paths.contains_key(id) {
            return Err(mode_error_detail("MODE_ARTIFACT_UNKNOWN", id));
        }
        if content.len() > MAX_ARTIFACT_BYTES {
            return Err(mode_error_detail(
                "MODE_ARTIFACT_TOO_LARGE",
                format!("artifact `{id}` is larger than 256 KiB"),
            ));
        }
    }
    for (id, content) in artifacts {
        let relative = paths
            .get(id)
            .ok_or_else(|| mode_error("MODE_ARTIFACT_UNKNOWN"))?;
        write(workspace, relative, content)?;
    }
    Ok(())
}
