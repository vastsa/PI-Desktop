//! Per-session visualization directories (D671).
//!
//! Inline GenUI cards are HTML fragments the agent writes under
//! `<data_dir>/visualizations/<session_id>/`; the desktop serves them through
//! the sandboxed `pi-genui:` protocol. Unlike scratch, these files are part of
//! the transcript: they are never removed by age, only together with their
//! session (or by the startup sweep once the session no longer exists).
//! Created lazily on the first Write/Edit that targets the directory.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::{fs, io};

pub(crate) mod files;
pub(crate) mod references;

/// Session ids come from our own DB (UUIDs), but stay defensive: an id that
/// could traverse out of the base directory gets no directory at all.
fn safe_session_id(session_id: &str) -> bool {
    !session_id.is_empty()
        && session_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

pub fn base_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("visualizations")
}

/// Absolute visualization directory for a session, or None for unsafe ids.
pub fn session_dir(data_dir: &Path, session_id: &str) -> Option<PathBuf> {
    if !safe_session_id(session_id) {
        return None;
    }
    Some(base_dir(data_dir).join(session_id))
}

/// Validate the owned base and session entries on every use, including before
/// their lazy creation. The data directory itself may legitimately be an alias
/// (for example /var on macOS); neither owned entry may redirect elsewhere.
pub(crate) fn validate_session_root(root: &Path) -> io::Result<PathBuf> {
    let (data, id) = session_root_parts(root)?;
    let canonical_base = validated_base(data)?;
    let canonical_root = canonical_base.join(id);
    validate_directory(root, &canonical_root)?;
    Ok(canonical_root)
}

fn session_root_parts(root: &Path) -> io::Result<(&Path, &str)> {
    let id = root
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|id| safe_session_id(id))
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid visualization session root",
            )
        })?;
    let base = root
        .parent()
        .filter(|base| {
            base.file_name()
                .is_some_and(|name| name == "visualizations")
        })
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid visualization base"))?;
    let data = base.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid visualization data directory",
        )
    })?;
    Ok((data, id))
}

/// Recognize the advertised spelling or a canonical data-directory alias.
/// Canonicalize only the data parent, never a possibly redirected owned root.
/// This identifies a claimed visualization path; validation still decides
/// whether it is safe, including when it also lies inside the workspace.
pub(crate) fn contains_session_path(root: &Path, input: &str) -> bool {
    if crate::workspace::lexically_inside(root, input) {
        return true;
    }
    let Ok((data, id)) = session_root_parts(root) else {
        return false;
    };
    crate::workspace::simple_canonicalize(data).is_ok_and(|data| {
        crate::workspace::lexically_inside(&data.join("visualizations").join(id), input)
    })
}

fn validated_base(data_dir: &Path) -> io::Result<PathBuf> {
    let canonical = crate::workspace::simple_canonicalize(data_dir)?.join("visualizations");
    validate_directory(&base_dir(data_dir), &canonical)?;
    Ok(canonical)
}

fn validate_directory(path: &Path, expected: &Path) -> io::Result<()> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    if !metadata.is_dir() || is_redirected(&metadata) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "visualization directory is redirected or not a regular directory",
        ));
    }
    let canonical = crate::workspace::simple_canonicalize(path)?;
    // Use the resolver's platform-aware comparisons (Windows is case-insensitive).
    if !crate::workspace::lexically_inside(expected, &canonical.to_string_lossy())
        || !crate::workspace::lexically_inside(&canonical, &expected.to_string_lossy())
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "visualization directory is redirected",
        ));
    }
    Ok(())
}

fn is_redirected(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes()
            & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT
            != 0
        {
            return true;
        }
    }
    metadata.file_type().is_symlink()
}

/// Create one owned directory at a time, checking both before and after each
/// step. Never let create_dir_all follow a replaced base/session entry.
pub(crate) fn ensure_session_root(root: &Path) -> io::Result<PathBuf> {
    let canonical = validate_session_root(root)?;
    let base = canonical
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid visualization base"))?;
    for directory in [base, canonical.as_path()] {
        // Revalidate the chain, not just the leaf, after a previous operation.
        validate_session_root(root)?;
        match fs::create_dir(directory) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
        validate_session_root(root)?;
    }
    Ok(canonical)
}

/// True when `path` names an `.html` file (lowercase `.html` only).
pub fn is_fragment_path(path: &Path) -> bool {
    // Mirrors `isGenUiFileName` in packages/shared/src/gen-ui.ts.
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    let Some(stem) = name.strip_suffix(".html") else {
        return false;
    };
    let mut chars = stem.chars();
    stem.len() <= 128
        && !name.contains("..")
        && chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// Fork only real regular fragments; file links and Windows reparse points
/// cannot turn a transcript reference into an external read.
pub(crate) fn is_regular_fragment_file(path: &Path) -> io::Result<bool> {
    if !is_fragment_path(path) {
        return Ok(false);
    }
    match fs::symlink_metadata(path) {
        Ok(metadata) => Ok(metadata.is_file() && !is_redirected(&metadata)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error),
    }
}

/// Remove a session's visualization directory (idempotent, best-effort).
pub fn remove_session_dir(data_dir: &Path, session_id: &str) {
    if let Some(dir) = session_dir(data_dir, session_id) {
        remove_session_root(&dir);
    }
}

/// Also used by fork rollback. Recheck the base at deletion time: a root
/// validated during creation is not authority after directory replacement.
pub(crate) fn remove_session_root(root: &Path) {
    let result = (|| -> io::Result<()> {
        let dir = validate_session_root(root)?;
        match fs::remove_dir_all(&dir) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            result => result,
        }
    })();
    if let Err(error) = result {
        tracing::warn!(path = %root.display(), %error, "visualization cleanup failed");
    }
}

/// Startup sweep: drop directories whose session no longer exists. Live
/// sessions keep their cards regardless of age — the transcript still
/// references them.
pub fn sweep(data_dir: &Path, live_session_ids: &HashSet<String>) {
    let result = (|| -> io::Result<()> {
        let base = validated_base(data_dir)?;
        let entries = match fs::read_dir(&base) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error),
        };
        for entry in entries {
            let entry = entry?;
            let name = entry.file_name();
            let Some(id) = name.to_str().filter(|id| safe_session_id(id)) else {
                continue;
            };
            if live_session_ids.contains(id) || !entry.file_type()?.is_dir() {
                continue;
            }
            // An iterator survives renaming its directory. Revalidate the
            // owned base before using any entry path for deletion.
            validated_base(data_dir)?;
            remove_session_root(&base.join(id));
        }
        Ok(())
    })();
    if let Err(error) = result {
        tracing::warn!(%error, "visualization sweep failed");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, SystemTime};
    use tempfile::tempdir;

    #[test]
    fn rejects_unsafe_session_ids() {
        let dir = tempdir().unwrap();
        assert!(session_dir(dir.path(), "../evil").is_none());
        assert!(session_dir(dir.path(), "a/b").is_none());
        assert!(session_dir(dir.path(), "").is_none());
        assert_eq!(
            session_dir(dir.path(), "0b0e9a52-1_ok").unwrap(),
            dir.path().join("visualizations").join("0b0e9a52-1_ok")
        );
    }

    #[test]
    fn fragment_paths_require_html_extension() {
        assert!(is_fragment_path(Path::new("/x/chart.html")));
        assert!(!is_fragment_path(Path::new("/x/Chart.HTML")));
        assert!(!is_fragment_path(Path::new("/x/.hidden.html")));
        assert!(!is_fragment_path(Path::new("/x/a..b.html")));
        assert!(is_fragment_path(Path::new("/x/chart-v2_final.html")));
        assert!(!is_fragment_path(Path::new("/x/chart.htm")));
        assert!(!is_fragment_path(Path::new("/x/chart.js")));
        assert!(!is_fragment_path(Path::new("/x/html")));
    }

    #[test]
    fn remove_is_idempotent() {
        let dir = tempdir().unwrap();
        let s = session_dir(dir.path(), "s1").unwrap();
        std::fs::create_dir_all(&s).unwrap();
        std::fs::write(s.join("a.html"), "<p>x</p>").unwrap();
        remove_session_dir(dir.path(), "s1");
        assert!(!s.exists());
        remove_session_dir(dir.path(), "s1");
    }

    #[test]
    fn sweep_removes_orphans_and_keeps_live_regardless_of_age() {
        let dir = tempdir().unwrap();
        let live = session_dir(dir.path(), "live").unwrap();
        let orphan = session_dir(dir.path(), "orphan").unwrap();
        std::fs::create_dir_all(&live).unwrap();
        std::fs::create_dir_all(&orphan).unwrap();
        let card = live.join("old.html");
        std::fs::write(&card, "<p>old</p>").unwrap();
        let ancient = SystemTime::now() - Duration::from_secs(365 * 24 * 60 * 60);
        std::fs::File::options()
            .write(true)
            .open(&card)
            .unwrap()
            .set_modified(ancient)
            .unwrap();
        let mut directory = std::fs::File::options();
        directory.read(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            use windows_sys::Win32::Storage::FileSystem::{
                FILE_FLAG_BACKUP_SEMANTICS, FILE_READ_ATTRIBUTES, FILE_WRITE_ATTRIBUTES,
            };
            directory
                .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
                .access_mode(FILE_READ_ATTRIBUTES | FILE_WRITE_ATTRIBUTES);
        }
        directory
            .open(&live)
            .unwrap()
            .set_modified(ancient)
            .unwrap();
        let mut ids = HashSet::new();
        ids.insert("live".to_string());
        sweep(dir.path(), &ids);
        assert!(card.exists());
        assert!(!orphan.exists());
    }

    #[test]
    fn sweep_rejects_a_redirected_base_without_deleting_external_data() {
        let data = tempdir().unwrap();
        let external = tempdir().unwrap();
        let important = external.path().join("important").join("keep.html");
        std::fs::create_dir_all(important.parent().unwrap()).unwrap();
        std::fs::write(&important, "irreplaceable").unwrap();
        crate::session_worktrees::test_support::link_dir(external.path(), &base_dir(data.path()));
        sweep(data.path(), &HashSet::new());
        assert_eq!(std::fs::read_to_string(important).unwrap(), "irreplaceable");
    }

    #[test]
    fn session_cleanup_rejects_a_redirected_base() {
        let data = tempdir().unwrap();
        let external = tempdir().unwrap();
        let important = external.path().join("source").join("keep.html");
        std::fs::create_dir_all(important.parent().unwrap()).unwrap();
        std::fs::write(&important, "irreplaceable").unwrap();
        crate::session_worktrees::test_support::link_dir(external.path(), &base_dir(data.path()));
        remove_session_dir(data.path(), "source");
        assert_eq!(std::fs::read_to_string(important).unwrap(), "irreplaceable");
    }

    #[test]
    fn sweep_preserves_directories_that_cannot_be_session_ids() {
        let data = tempdir().unwrap();
        let important = base_dir(data.path())
            .join("important documents")
            .join("keep.html");
        std::fs::create_dir_all(important.parent().unwrap()).unwrap();
        std::fs::write(&important, "irreplaceable").unwrap();
        sweep(data.path(), &HashSet::new());
        assert_eq!(std::fs::read_to_string(important).unwrap(), "irreplaceable");
    }

    #[test]
    fn cleanup_allows_a_data_directory_alias_but_not_a_session_link() {
        let data = tempdir().unwrap();
        let alias_parent = tempdir().unwrap();
        let alias = alias_parent.path().join("profile");
        crate::session_worktrees::test_support::link_dir(data.path(), &alias);
        let live = session_dir(&alias, "live").unwrap();
        let orphan = session_dir(&alias, "orphan").unwrap();
        std::fs::create_dir_all(&live).unwrap();
        std::fs::create_dir_all(&orphan).unwrap();
        std::fs::write(live.join("keep.html"), "live").unwrap();
        let external = tempdir().unwrap();
        std::fs::write(external.path().join("keep.html"), "external").unwrap();
        let link = session_dir(&alias, "linked").unwrap();
        crate::session_worktrees::test_support::link_dir(external.path(), &link);
        sweep(&alias, &HashSet::from(["live".into()]));
        remove_session_dir(&alias, "linked");
        assert_eq!(
            std::fs::read_to_string(external.path().join("keep.html")).unwrap(),
            "external"
        );
        assert!(live.join("keep.html").exists());
        assert!(!orphan.exists());
        remove_session_dir(&alias, "live");
        assert!(!live.exists());
    }
}
