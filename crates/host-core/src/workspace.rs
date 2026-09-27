use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};

/// Canonicalize a path, stripping the Windows extended-length prefix (`\\?\`)
/// when the result is a simple drive-letter path (e.g. `C:\...`). This keeps
/// paths compatible with shell APIs (`ShellExecuteW`) that reject `\\?\`.
fn simple_canonicalize(path: &Path) -> std::io::Result<PathBuf> {
    let canonical = path.canonicalize()?;
    #[cfg(windows)]
    {
        let s = canonical.to_string_lossy();
        // Strip `\\?\X:\...` → `X:\...` but keep true UNC paths like `\\?\UNC\...`
        if let Some(rest) = s.strip_prefix(r"\\?\") {
            if rest.len() >= 3 && rest.as_bytes()[1] == b':' && rest.as_bytes()[2] == b'\\' {
                return Ok(PathBuf::from(rest));
            }
        }
    }
    Ok(canonical)
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct WorkspaceState {
    pub path: Option<String>,
    pub name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectWorkspace {
    pub path: String,
    pub name: String,
}

impl WorkspaceState {
    pub fn get(&self) -> Option<ProjectWorkspace> {
        match (&self.path, &self.name) {
            (Some(path), Some(name)) => Some(ProjectWorkspace {
                path: path.clone(),
                name: name.clone(),
            }),
            _ => None,
        }
    }

    pub fn set(&mut self, path: impl AsRef<Path>) -> ProjectWorkspace {
        let path = simple_canonicalize(path.as_ref())
            .unwrap_or_else(|_| path.as_ref().to_path_buf());
        let name = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("workspace")
            .to_string();
        let path_str = path.to_string_lossy().to_string();
        self.path = Some(path_str.clone());
        self.name = Some(name.clone());
        ProjectWorkspace {
            path: path_str,
            name,
        }
    }

    pub fn clear(&mut self) {
        self.path = None;
        self.name = None;
    }
}

/// Which containment root a tool path resolved into.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolRoot {
    Workspace,
    Scratch,
    External,
}

/// Lexically resolve `.` / `..` components without touching the filesystem.
/// `..` at the filesystem root clamps (stays at root); the caller's
/// starts_with check then rejects anything that climbed out of the workspace.
fn normalize_lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Compare path components using the platform's filesystem semantics.
/// Windows paths are case-insensitive even though `Path` comparisons are not.
fn path_is_within(root: &Path, candidate: &Path) -> bool {
    let root_components: Vec<_> = root.components().collect();
    let candidate_components: Vec<_> = candidate.components().collect();
    root_components.len() <= candidate_components.len()
        && root_components
            .iter()
            .zip(candidate_components.iter())
            .all(|(root, candidate)| {
                #[cfg(windows)]
                {
                    root.as_os_str()
                        .to_string_lossy()
                        .eq_ignore_ascii_case(&candidate.as_os_str().to_string_lossy())
                }
                #[cfg(not(windows))]
                {
                    root == candidate
                }
            })
}

/// Resolve a normalized path by canonicalizing its deepest existing ancestor.
/// The same resolver is used for contained and explicitly approved paths so
/// symlink behavior does not change when a permission card is accepted.
fn resolve_with_existing_ancestor(normalized: PathBuf) -> Result<PathBuf, String> {
    let mut existing = normalized;
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    while !existing.exists() {
        match (existing.parent(), existing.file_name()) {
            (Some(parent), Some(name)) => {
                tail.push(name.to_os_string());
                existing = parent.to_path_buf();
            }
            _ => break,
        }
    }
    let mut resolved = simple_canonicalize(&existing)
        .map_err(|e| format!("path canonicalize failed: {e}"))?;
    for part in tail.iter().rev() {
        resolved.push(part);
    }
    Ok(resolved)
}

/// Resolve a user-provided path against workspace root and ensure it stays inside.
///
/// Two layers of defense:
/// 1. Lexical normalization of `.`/`..` before any check, so traversal via
///    nonexistent parents cannot hide behind an uncanonicalizable path.
/// 2. Canonicalization of the deepest existing ancestor, so symlinks inside
///    the workspace cannot smuggle a target outside it.
pub fn resolve_in_workspace(workspace_root: &Path, input: &str) -> Result<PathBuf, String> {
    let root = simple_canonicalize(workspace_root)
        .map_err(|e| format!("workspace canonicalize failed: {e}"))?;
    let candidate = if Path::new(input).is_absolute() {
        PathBuf::from(input)
    } else {
        root.join(input)
    };

    let normalized = normalize_lexical(&candidate);
    if !path_is_within(&root, &normalized) {
        return Err("PATH_OUTSIDE_WORKSPACE".into());
    }

    // Canonicalize the deepest existing ancestor (resolves symlinks), then
    // re-append the not-yet-existing tail.
    let resolved = resolve_with_existing_ancestor(normalized)?;

    if !path_is_within(&root, &resolved) {
        return Err("PATH_OUTSIDE_WORKSPACE".into());
    }
    Ok(resolved)
}

/// Resolve an explicitly approved path without applying workspace
/// containment. Relative paths still use the session workspace as their base;
/// only the permission decision can opt a tool into this resolver.
pub fn resolve_external_path(workspace_root: &Path, input: &str) -> Result<PathBuf, String> {
    let root = simple_canonicalize(workspace_root)
        .map_err(|e| format!("workspace canonicalize failed: {e}"))?;
    let candidate = if Path::new(input).is_absolute() {
        PathBuf::from(input)
    } else {
        root.join(input)
    };
    resolve_with_existing_ancestor(normalize_lexical(&candidate))
}

/// Resolve a tool path against the workspace root, falling back to the
/// session scratch root (D114). Relative paths always resolve against the
/// workspace; the scratch directory is addressed by absolute path only (the
/// model learns it from the system prompt / `PI_SCRATCH_DIR`). Both roots get
/// the same lexical + symlink containment defense.
pub fn resolve_tool_path(
    workspace_root: &Path,
    scratch_root: Option<&Path>,
    input: &str,
) -> Result<(PathBuf, ToolRoot), String> {
    let workspace_err = match resolve_in_workspace(workspace_root, input) {
        Ok(path) => return Ok((path, ToolRoot::Workspace)),
        Err(e) => e,
    };
    if Path::new(input).is_absolute() {
        if let Some(scratch) = scratch_root {
            if let Ok(path) = resolve_in_workspace(scratch, input) {
                return Ok((path, ToolRoot::Scratch));
            }
            // The model addresses scratch with the exact spelling we
            // advertised, which may differ from the canonical one (macOS
            // /var vs /private/var, /tmp vs /private/tmp). Rewrite a literal
            // scratch-root prefix to a relative path and resolve that — the
            // full containment defense still runs.
            let candidate = normalize_lexical(Path::new(input));
            if let Ok(rel) = candidate.strip_prefix(normalize_lexical(scratch)) {
                if let Ok(path) = resolve_in_workspace(scratch, &rel.to_string_lossy()) {
                    return Ok((path, ToolRoot::Scratch));
                }
            }
        }
    }
    Err(workspace_err)
}

/// Resolve a tool path after the host has granted explicit outside-workspace
/// access for this call. Contained workspace and scratch paths keep their
/// normal roots; only an otherwise rejected path becomes `External`.
pub fn resolve_tool_path_with_external(
    workspace_root: &Path,
    scratch_root: Option<&Path>,
    input: &str,
    allow_external: bool,
) -> Result<(PathBuf, ToolRoot), String> {
    match resolve_tool_path(workspace_root, scratch_root, input) {
        Ok(result) => Ok(result),
        Err(error) if allow_external && error == "PATH_OUTSIDE_WORKSPACE" => Ok((
            resolve_external_path(workspace_root, input)?,
            ToolRoot::External,
        )),
        Err(error) => Err(error),
    }
}

/// Purely lexical containment check: does `input` (absolute) normalize to a
/// path under `root`? Used only to decide whether a scratch write can skip
/// the permission prompt — execution still runs the full symlink-aware
/// resolver, so a false positive here cannot escape containment.
pub fn lexically_inside(root: &Path, input: &str) -> bool {
    let candidate = Path::new(input);
    if !candidate.is_absolute() {
        return false;
    }
    path_is_within(&normalize_lexical(root), &normalize_lexical(candidate))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn blocks_escape() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("a.txt"), "x").unwrap();
        let err = resolve_in_workspace(root, "../outside.txt").unwrap_err();
        assert_eq!(err, "PATH_OUTSIDE_WORKSPACE");
    }

    #[test]
    fn blocks_escape_via_nonexistent_parent() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        // `sub` does not exist; lexical traversal must still be caught.
        let err = resolve_in_workspace(root, "sub/../../evil/new.txt").unwrap_err();
        assert_eq!(err, "PATH_OUTSIDE_WORKSPACE");
        let err = resolve_in_workspace(root, "a/b/../../../evil.txt").unwrap_err();
        assert_eq!(err, "PATH_OUTSIDE_WORKSPACE");
    }

    #[test]
    fn blocks_absolute_outside() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        let err = resolve_in_workspace(root, "/etc/hosts").unwrap_err();
        assert_eq!(err, "PATH_OUTSIDE_WORKSPACE");
    }

    #[test]
    fn allows_new_nested_path() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        let p = resolve_in_workspace(root, "newdir/sub/file.txt").unwrap();
        assert!(p.starts_with(root.canonicalize().unwrap()));
        assert!(p.ends_with("newdir/sub/file.txt"));
    }

    #[cfg(unix)]
    #[test]
    fn blocks_symlink_escape() {
        let dir = tempdir().unwrap();
        let outside = tempdir().unwrap();
        let root = dir.path();
        std::os::unix::fs::symlink(outside.path(), root.join("link")).unwrap();
        let err = resolve_in_workspace(root, "link/new.txt").unwrap_err();
        assert_eq!(err, "PATH_OUTSIDE_WORKSPACE");
    }

    #[test]
    fn tool_path_relative_resolves_to_workspace() {
        let ws = tempdir().unwrap();
        let scratch = tempdir().unwrap();
        let (p, root) = resolve_tool_path(ws.path(), Some(scratch.path()), "notes.txt").unwrap();
        assert_eq!(root, ToolRoot::Workspace);
        assert!(p.starts_with(ws.path().canonicalize().unwrap()));
    }

    #[test]
    fn tool_path_absolute_scratch_resolves_to_scratch() {
        let ws = tempdir().unwrap();
        let scratch = tempdir().unwrap();
        let input = scratch.path().join("tmp.json");
        let (p, root) =
            resolve_tool_path(ws.path(), Some(scratch.path()), input.to_str().unwrap()).unwrap();
        assert_eq!(root, ToolRoot::Scratch);
        assert!(p.starts_with(scratch.path().canonicalize().unwrap()));
    }

    #[test]
    fn tool_path_escape_from_scratch_blocked() {
        let ws = tempdir().unwrap();
        let scratch = tempdir().unwrap();
        let input = scratch.path().join("a/../../evil.txt");
        let err = resolve_tool_path(ws.path(), Some(scratch.path()), input.to_str().unwrap())
            .unwrap_err();
        assert_eq!(err, "PATH_OUTSIDE_WORKSPACE");
    }

    #[cfg(unix)]
    #[test]
    fn tool_path_symlink_escape_from_scratch_blocked() {
        let ws = tempdir().unwrap();
        let scratch = tempdir().unwrap();
        let outside = tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), scratch.path().join("link")).unwrap();
        let input = scratch.path().join("link/new.txt");
        let err = resolve_tool_path(ws.path(), Some(scratch.path()), input.to_str().unwrap())
            .unwrap_err();
        assert_eq!(err, "PATH_OUTSIDE_WORKSPACE");
    }

    #[test]
    fn tool_path_absolute_outside_both_roots_blocked() {
        let ws = tempdir().unwrap();
        let scratch = tempdir().unwrap();
        let err = resolve_tool_path(ws.path(), Some(scratch.path()), "/etc/hosts").unwrap_err();
        assert_eq!(err, "PATH_OUTSIDE_WORKSPACE");
    }

    #[test]
    fn approved_external_path_resolves_and_keeps_absolute_identity() {
        let ws = tempdir().unwrap();
        let outside = tempdir().unwrap();
        let input = outside.path().join("outside.txt");
        fs::write(&input, "outside").unwrap();

        let (resolved, root) =
            resolve_tool_path_with_external(ws.path(), None, input.to_str().unwrap(), true)
                .unwrap();
        assert_eq!(root, ToolRoot::External);
        assert_eq!(resolved, input.canonicalize().unwrap());
    }

    #[test]
    fn relative_escape_can_be_resolved_only_after_external_approval() {
        let parent = tempdir().unwrap();
        let ws = parent.path().join("workspace");
        let outside = parent.path().join("outside.txt");
        fs::create_dir_all(&ws).unwrap();
        fs::write(&outside, "outside").unwrap();

        let input = "../outside.txt";
        assert_eq!(
            resolve_tool_path(&ws, None, input).unwrap_err(),
            "PATH_OUTSIDE_WORKSPACE"
        );
        let (resolved, root) = resolve_tool_path_with_external(&ws, None, input, true).unwrap();
        assert_eq!(root, ToolRoot::External);
        assert_eq!(resolved, outside.canonicalize().unwrap());
    }

    #[test]
    fn lexically_inside_checks() {
        let dir = tempdir().unwrap();
        let data = dir.path().join("data");
        let root = data.join("scratch").join("s1");
        let inside = root.join("a.txt");
        let normalized_inside = root.join("sub").join(".").join("b.txt");
        let sibling = root.join("..").join("s2").join("a.txt");
        let other = data.join("other").join("a.txt");

        assert!(lexically_inside(&root, inside.to_str().unwrap()));
        assert!(lexically_inside(&root, normalized_inside.to_str().unwrap()));
        assert!(!lexically_inside(&root, sibling.to_str().unwrap()));
        assert!(!lexically_inside(&root, other.to_str().unwrap()));
        assert!(!lexically_inside(&root, "relative/a.txt"));
    }

    #[test]
    fn allows_inside() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::write(root.join("a.txt"), "x").unwrap();
        let p = resolve_in_workspace(root, "a.txt").unwrap();
        assert!(p.ends_with("a.txt"));
    }
}
