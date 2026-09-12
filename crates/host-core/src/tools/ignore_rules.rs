//! Workspace ignore rules (spec 03-runtime/15, D032).
//!
//! Four layers, highest priority first:
//!
//! 1. Security denylist: private keys, `.env` files, and credential bundles
//!    are never read, written, edited, or surfaced by a search, whichever
//!    root the path resolved into. The denylist cannot be disabled.
//! 2. App defaults: build output and dependency trees are hidden from an
//!    unscoped `Glob`/`Grep` walk. An explicit `path` argument opts back in,
//!    the same way it already bypasses parent `.gitignore` rules.
//! 3. Workspace rules: a gitignore-style `.pi-desktopignore` at the workspace
//!    root, honored by unscoped walks.
//! 4. User global rules: `<data_dir>/ignore` (`~/.pi-desktop/ignore` by
//!    default), honored by unscoped walks.

use ignore::WalkBuilder;
use std::path::{Path, PathBuf};

/// Workspace-root ignore file name (spec 15 §5).
pub const WORKSPACE_IGNORE_FILE: &str = ".pi-desktopignore";

/// Exact file names on the security denylist (spec 15 §3).
const SENSITIVE_FILE_NAMES: &[&str] = &["id_rsa", "id_ed25519", "credentials.json", ".env"];

/// File-name suffixes on the security denylist (spec 15 §3).
const SENSITIVE_SUFFIXES: &[&str] = &[".pem", ".key", ".p12", ".pfx"];

/// `.env.*` variants that document configuration instead of holding it and
/// therefore stay readable (`.env.example`, `.env.sample`, `.env.template`).
const ENV_TEMPLATE_SUFFIXES: &[&str] = &[".example", ".sample", ".template"];

/// Directory names hidden from unscoped walks (spec 15 §4, plus `.git`).
pub const DEFAULT_IGNORE_DIRS: &[&str] = &[
    "node_modules",
    "dist",
    "build",
    ".target",
    "target",
    ".venv",
    "venv",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    "coverage",
    ".turbo",
    ".next",
    ".cache",
    ".git",
];

/// File names hidden from unscoped walks (spec 15 §4).
const DEFAULT_IGNORE_FILES: &[&str] = &[".DS_Store"];

/// File suffixes hidden from unscoped walks (spec 15 §4).
const DEFAULT_IGNORE_FILE_SUFFIXES: &[&str] = &[".log"];

/// Error code returned when an explicit tool path hits the denylist.
pub const DENIED_CODE: &str = "WORKSPACE_PATH_DENIED";

/// Whether a file name is on the always-on security denylist.
pub fn is_sensitive_file_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    if lower.starts_with(".env.") {
        return !ENV_TEMPLATE_SUFFIXES
            .iter()
            .any(|suffix| lower.ends_with(suffix));
    }
    if SENSITIVE_FILE_NAMES.contains(&lower.as_str()) {
        return true;
    }
    SENSITIVE_SUFFIXES
        .iter()
        .any(|suffix| lower.ends_with(suffix) && lower.len() > suffix.len())
}

/// Whether a resolved path is blocked by the security denylist: either its
/// file name matches, or it lives under a `.git/objects` tree.
pub fn is_sensitive_path(path: &Path) -> bool {
    if path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(is_sensitive_file_name)
    {
        return true;
    }
    let mut previous_was_git = false;
    for component in path.components() {
        let name = component.as_os_str().to_string_lossy();
        if previous_was_git && name == "objects" {
            return true;
        }
        previous_was_git = name == ".git";
    }
    false
}

/// Denial error for an explicit Read/Write/Edit on a denylisted path.
pub fn denied_error(display: &str) -> (String, String) {
    (
        DENIED_CODE.into(),
        format!("{display} is blocked by the workspace security denylist (private keys, .env files, and credential bundles are never exposed to tools)"),
    )
}

fn is_default_ignored_dir_name(name: &str) -> bool {
    DEFAULT_IGNORE_DIRS.contains(&name)
}

fn is_default_ignored_file_name(name: &str) -> bool {
    DEFAULT_IGNORE_FILES.contains(&name)
        || DEFAULT_IGNORE_FILE_SUFFIXES
            .iter()
            .any(|suffix| name.len() > suffix.len() && name.ends_with(suffix))
}

/// The workspace-root ignore file, when present.
pub fn workspace_ignore_file(ignore_root: &Path) -> Option<PathBuf> {
    let candidate = ignore_root.join(WORKSPACE_IGNORE_FILE);
    candidate.is_file().then_some(candidate)
}

/// The user's global ignore file (`<data_dir>/ignore`), when present.
pub fn user_global_ignore_file() -> Option<PathBuf> {
    let data_dir = std::env::var_os("PI_DESKTOP_DATA_DIR")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".pi-desktop")))?;
    let candidate = data_dir.join("ignore");
    candidate.is_file().then_some(candidate)
}

/// Apply the ignore layers to an in-process walk. `scoped` walks (explicit
/// `path` argument) keep only the security denylist.
pub fn configure_walker(walker: &mut WalkBuilder, ignore_root: &Path, scoped: bool) {
    if !scoped {
        if let Some(file) = workspace_ignore_file(ignore_root) {
            let _ = walker.add_ignore(file);
        }
        if let Some(file) = user_global_ignore_file() {
            let _ = walker.add_ignore(file);
        }
    }
    walker.filter_entry(move |entry| {
        let Some(name) = entry.file_name().to_str() else {
            return true;
        };
        let is_dir = entry.file_type().is_some_and(|kind| kind.is_dir());
        if is_dir {
            // `.git/objects` is denied even inside a scoped walk.
            if scoped {
                return !(name == "objects"
                    && entry
                        .path()
                        .parent()
                        .and_then(Path::file_name)
                        .is_some_and(|parent| parent == ".git"));
            }
            return !is_default_ignored_dir_name(name);
        }
        if is_sensitive_file_name(name) {
            return false;
        }
        if scoped {
            return true;
        }
        !is_default_ignored_file_name(name)
    });
}

/// Extra `rg` arguments implementing the same layers. `.env.*` is left to the
/// post-filter (`is_sensitive_path`) because an rg include glob would switch
/// the whole run into whitelist mode.
pub fn rg_args(ignore_root: &Path, scoped: bool) -> Vec<String> {
    let mut args = Vec::new();
    for name in SENSITIVE_FILE_NAMES {
        args.push("--glob".into());
        args.push(format!("!{name}"));
    }
    for suffix in SENSITIVE_SUFFIXES {
        args.push("--glob".into());
        args.push(format!("!*{suffix}"));
    }
    args.push("--glob".into());
    args.push("!.git/objects".into());
    if scoped {
        return args;
    }
    for dir in DEFAULT_IGNORE_DIRS {
        args.push("--glob".into());
        args.push(format!("!{dir}"));
    }
    for file in DEFAULT_IGNORE_FILES {
        args.push("--glob".into());
        args.push(format!("!{file}"));
    }
    for suffix in DEFAULT_IGNORE_FILE_SUFFIXES {
        args.push("--glob".into());
        args.push(format!("!*{suffix}"));
    }
    for file in [
        workspace_ignore_file(ignore_root),
        user_global_ignore_file(),
    ]
    .into_iter()
    .flatten()
    {
        args.push("--ignore-file".into());
        args.push(file.to_string_lossy().into_owned());
    }
    args
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn denylist_matches_keys_env_and_credentials() {
        for name in [
            ".env",
            ".env.local",
            ".ENV.production",
            "server.pem",
            "private.key",
            "id_rsa",
            "id_ed25519",
            "bundle.p12",
            "cert.pfx",
            "credentials.json",
        ] {
            assert!(is_sensitive_file_name(name), "{name} must be denied");
        }
        for name in [
            ".env.example",
            ".env.sample",
            ".env.template",
            "environment.ts",
            "keys.rs",
            "id_rsa.pub.md",
            "package.json",
            ".pem",
        ] {
            assert!(!is_sensitive_file_name(name), "{name} must stay readable");
        }
    }

    #[test]
    fn git_objects_tree_is_denied_by_path() {
        assert!(is_sensitive_path(Path::new("/ws/.git/objects/ab/cdef")));
        assert!(!is_sensitive_path(Path::new("/ws/.git/HEAD")));
        assert!(!is_sensitive_path(Path::new("/ws/src/objects/index.ts")));
    }

    #[test]
    fn rg_args_keep_only_denylist_when_scoped() {
        let scoped = rg_args(Path::new("/nonexistent"), true);
        assert!(scoped.contains(&"!*.pem".to_string()));
        assert!(!scoped.contains(&"!node_modules".to_string()));
        let unscoped = rg_args(Path::new("/nonexistent"), false);
        assert!(unscoped.contains(&"!node_modules".to_string()));
        assert!(unscoped.contains(&"!*.log".to_string()));
    }
}
