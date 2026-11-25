//! Per-call narrowing for the host file tools. The runtime supplies the frozen
//! delegation scope outside model-controlled tool arguments.
use super::hashline::ToolError;
use crate::workspace::{normalize_lexical, simple_canonicalize, ToolRoot};
use serde::{de, Deserialize, Deserializer};
use std::ffi::OsStr;
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};

#[cfg(unix)]
use unix as platform;
#[cfg(unix)]
mod unix;
#[cfg(windows)]
use windows as platform;
#[cfg(windows)]
mod windows;

pub(crate) const VIOLATION: &str = "WRITE_SCOPE_VIOLATION";

#[derive(Clone, Debug)]
pub(crate) struct WriteScope(Vec<String>);

/// The field is optional, but if present it must be an array (not null).
pub(super) fn deserialize<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<WriteScope>, D::Error> {
    let entries = Vec::<String>::deserialize(deserializer)?;
    if entries
        .iter()
        .any(|entry| entry.trim().is_empty() || entry.chars().any(char::is_control))
    {
        return Err(de::Error::custom(
            "writeScope entries must be non-empty paths without control characters",
        ));
    }
    Ok(Some(WriteScope(entries)))
}

pub(crate) struct BoundWriteScope {
    root: PathBuf,
    entries: Vec<PathBuf>,
}

impl WriteScope {
    pub(crate) fn bind(&self, workspace: &Path) -> Option<BoundWriteScope> {
        let root = simple_canonicalize(workspace).ok()?;
        // The Host supplies a canonical registered worktree/project path. Do
        // not bind a redirected workspace and silently adopt its new target.
        if !root.is_dir() || !plain_path(&root) || normalize_lexical(workspace) != root {
            return None;
        }
        let entries = self
            .0
            .iter()
            .filter_map(|entry| scope_address(&root, Path::new(entry.trim())))
            .collect();
        Some(BoundWriteScope { root, entries })
    }
}

impl BoundWriteScope {
    pub(super) fn validate_target(&self, input: &str) -> Result<(), ToolError> {
        if !input.is_empty() && scope_address(&self.root, Path::new(input)).is_some() {
            Ok(())
        } else {
            Err(denied(input))
        }
    }

    pub(super) fn check(
        &self,
        workspace: &Path,
        input: &str,
        resolved: &Path,
        kind: ToolRoot,
    ) -> Result<(), ToolError> {
        if kind != ToolRoot::Workspace
            || normalize_lexical(workspace) != self.root
            || !self.contains(resolved)
        {
            return Err(denied(input));
        }
        // Check the canonical pathname the file operation will actually use.
        // Reject a binding that has changed since the tool's resolution and
        // files that have other (potentially out-of-scope) directory entries.
        check_binding(resolved).map_err(|_| denied(input))
    }

    fn contains(&self, path: &Path) -> bool {
        // Only regular workspace content belongs to a scoped delegate. In an
        // isolated worktree, `.git` is a link *file* into shared Git state.
        path.strip_prefix(&self.root).is_ok_and(|relative| {
            !relative
                .components()
                .any(|part| part.as_os_str().eq_ignore_ascii_case(".git"))
        }) && self.entries.iter().any(|entry| path.starts_with(entry))
    }

    pub(super) fn target<'a>(
        &self,
        input: &str,
        path: &'a Path,
        create_parents: bool,
    ) -> Result<ScopedTarget<'a>, ToolError> {
        self.open_target(path, create_parents).map_err(|error| {
            if !create_parents && error.kind() == io::ErrorKind::NotFound {
                ToolError::new("FILE_NOT_FOUND", format!("File not found: {input}"))
            } else {
                denied(input)
            }
        })
    }

    fn open_target<'a>(
        &self,
        path: &'a Path,
        create_parents: bool,
    ) -> io::Result<ScopedTarget<'a>> {
        if !self.contains(path) {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        // Pin each component from the absolute volume root, not from a
        // previously resolved string. Never follow a link introduced by a
        // concurrent namespace change, even while creating missing parents.
        let name = path.file_name().ok_or(io::ErrorKind::InvalidInput)?;
        let parent = path.parent().ok_or(io::ErrorKind::InvalidInput)?;
        let volume = path.ancestors().last().ok_or(io::ErrorKind::InvalidInput)?;
        let relative = parent.strip_prefix(volume).map_err(io::Error::other)?;
        let mut pinned = platform::Parent::open_root(volume)?;
        let mut address = volume.to_owned();
        for component in relative.components() {
            let Component::Normal(child) = component else {
                return Err(io::ErrorKind::InvalidInput.into());
            };
            address.push(child);
            let may_create =
                create_parents && self.entries.iter().any(|entry| address.starts_with(entry));
            pinned.open_dir(child, may_create)?;
            pinned.verify_address(&address)?;
        }
        Ok(ScopedTarget {
            parent: pinned,
            name,
            path,
        })
    }
}

/// A checked pathname anchored to its actual parent object, not a second
/// lookup through potentially replaced ancestor names.
pub(super) struct ScopedTarget<'a> {
    parent: platform::Parent,
    name: &'a OsStr,
    path: &'a Path,
}

impl ScopedTarget<'_> {
    pub(super) fn read(&self) -> io::Result<Vec<u8>> {
        let mut file = self.parent.open_read(self.name)?;
        require_single_link(&file)?;
        platform::verify_file_address(&file, self.path)?;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)?;
        Ok(bytes)
    }

    pub(super) fn write(&self, bytes: &[u8], allow_create: bool) -> io::Result<()> {
        // Never truncate before checking the opened object. Hard links have
        // no distinguished real address, so a multiply linked file is denied.
        let mut file = match self.parent.open_write(self.name, false) {
            Ok(file) => file,
            Err(error) if allow_create && error.kind() == io::ErrorKind::NotFound => {
                self.parent.open_write(self.name, true)?
            }
            Err(error) => return Err(error),
        };
        require_single_link(&file)?;
        platform::verify_file_address(&file, self.path)?;
        file.set_len(0)?;
        file.write_all(bytes)
    }

    pub(super) fn remove(&self) -> io::Result<()> {
        self.parent.remove_file(self.name, self.path)
    }
}

fn require_single_link(file: &fs::File) -> io::Result<()> {
    if platform::is_single_link(file)? {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "not a single-link regular file",
        ))
    }
}

fn scope_address(root: &Path, path: &Path) -> Option<PathBuf> {
    if !plain_path(path) {
        return None;
    }
    let address = normalize_lexical(&root.join(path));
    // Freeze lexical addresses, not link targets. A link inside the scope may
    // name another allowed target, but a link used as a scope entry must not
    // make its target (or a swapped-in target) part of the boundary.
    address.starts_with(root).then_some(address)
}

#[cfg(not(windows))]
fn plain_path(path: &Path) -> bool {
    path.to_str().is_some_and(|name| !name.contains('\0'))
}

#[cfg(windows)]
fn plain_path(path: &Path) -> bool {
    use std::path::Prefix;

    // Drive-relative, network/device namespaces, alternate streams and DOS
    // name rewrites are not provably ordinary workspace addresses.
    let mut components = path.components().peekable();
    if let Some(Component::Prefix(prefix)) = components.peek() {
        if !matches!(prefix.kind(), Prefix::Disk(_)) || !path.is_absolute() {
            return false;
        }
        components.next();
    } else if path.has_root() {
        return false;
    }
    components.all(|part| match part {
        Component::Normal(name) => name.to_str().is_some_and(|name| {
            let stem = name.split('.').next().unwrap_or("").trim_end();
            !name.contains([':', '\0'])
                && !name.ends_with([' ', '.'])
                && !matches!(
                    stem.to_ascii_uppercase().as_str(),
                    "CON"
                        | "PRN"
                        | "AUX"
                        | "NUL"
                        | "CONIN$"
                        | "CONOUT$"
                        | "CLOCK$"
                        | "COM1"
                        | "COM2"
                        | "COM3"
                        | "COM4"
                        | "COM5"
                        | "COM6"
                        | "COM7"
                        | "COM8"
                        | "COM9"
                        | "LPT1"
                        | "LPT2"
                        | "LPT3"
                        | "LPT4"
                        | "LPT5"
                        | "LPT6"
                        | "LPT7"
                        | "LPT8"
                        | "LPT9"
                        | "COM¹"
                        | "COM²"
                        | "COM³"
                        | "LPT¹"
                        | "LPT²"
                        | "LPT³"
                )
        }),
        _ => true,
    })
}

fn check_binding(path: &Path) -> io::Result<()> {
    let mut ancestor = path;
    loop {
        match fs::symlink_metadata(ancestor) {
            Ok(metadata) => {
                if simple_canonicalize(ancestor)? != ancestor
                    || if ancestor == path {
                        !metadata.is_file() || !platform::is_single_link_path(ancestor, &metadata)?
                    } else {
                        !metadata.is_dir()
                    }
                {
                    return Err(io::Error::other("unverifiable write target"));
                }
                return Ok(());
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                ancestor = ancestor.parent().ok_or(error)?;
            }
            Err(error) => return Err(error),
        }
    }
}

pub(super) fn denied(input: &str) -> ToolError {
    ToolError::new(
        VIOLATION,
        format!("Cannot verify `{input}` is an allowed file in this delegation's write scope. Report the path you needed and why instead of retrying."),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session_worktrees::test_support::link_dir;

    #[test]
    fn write_scope_does_not_follow_replaced_ancestor_or_create_under_it() {
        let dir = tempfile::tempdir().unwrap();
        let root = simple_canonicalize(dir.path()).unwrap();
        let allowed = root.join("allowed");
        let outside = root.join("outside");
        fs::create_dir(&allowed).unwrap();
        fs::create_dir(&outside).unwrap();
        let scope = WriteScope(vec!["allowed".into()]).bind(&root).unwrap();
        let path = allowed.join("missing/leaf.txt");
        scope
            .check(
                &root,
                "allowed/missing/leaf.txt",
                &path,
                ToolRoot::Workspace,
            )
            .unwrap();
        fs::rename(&allowed, root.join("original")).unwrap();
        link_dir(&outside, &allowed);
        assert!(scope
            .target("allowed/missing/leaf.txt", &path, true)
            .is_err());
        assert!(!outside.join("missing").exists());
    }

    #[test]
    fn write_scope_checks_hard_links_after_open_before_truncating() {
        let dir = tempfile::tempdir().unwrap();
        let root = simple_canonicalize(dir.path()).unwrap();
        let scope = WriteScope(vec!["inside.txt".into()]).bind(&root).unwrap();
        let path = root.join("inside.txt");
        fs::write(&path, "inside").unwrap();
        scope
            .check(&root, "inside.txt", &path, ToolRoot::Workspace)
            .unwrap();
        let target = scope.target("inside.txt", &path, false).unwrap();
        let outside = root.join("outside.txt");
        fs::hard_link(&path, &outside).unwrap();
        assert!(target.write(b"not written", false).is_err());
        assert_eq!(fs::read_to_string(outside).unwrap(), "inside");
    }
}
