//! Names and paths for remote git workspaces.
//!
//! Every value that later becomes a git operand or a path segment is checked
//! here first. The rules are the ones `packages/shared/src/racp-workspace-git.ts`
//! applies at the RACP boundary, re-implemented so host-core never trusts its
//! caller: a name that looks like an option or a path is refused before a
//! directory is created or git is started.
//!
//! ```text
//! <workspacesRoot>/repos/github.com/<owner>/<repo>            main checkout
//! <workspacesRoot>/worktrees/github.com/<owner>/<repo>/<id>   session worktree
//! ```

use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::WorkspaceGitError;

/// The only host repositories are ever cloned from.
const GITHUB_HOST: &str = "github.com";
pub const WORK_BRANCH_PREFIX: &str = "pi-desktop/";
/// Hex characters of the hash kept in the work branch and the directory name.
const SHORT_ID_LENGTH: usize = 12;

const FORBIDDEN_VARIABLE_NAMES: &[&str] = &[
    "PATH",
    "HOME",
    "SHELL",
    "USER",
    "LOGNAME",
    "PWD",
    "OLDPWD",
    "IFS",
    "ENV",
    "BASH_ENV",
    "PROMPT_COMMAND",
    "NODE_OPTIONS",
    "ELECTRON_RUN_AS_NODE",
];
const FORBIDDEN_VARIABLE_PREFIXES: &[&str] = &["GIT_", "PI_", "LD_", "DYLD_", "BASH_FUNC_"];

/// A validated GitHub repository coordinate.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Repository {
    pub owner: String,
    pub name: String,
}

impl Repository {
    pub fn parse(owner: &str, name: &str) -> Result<Repository, WorkspaceGitError> {
        // 1 to 39 characters of [A-Za-z0-9-], not starting or ending with `-`.
        let owner_ok = (1..=39).contains(&owner.len())
            && owner
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            && !owner.starts_with('-')
            && !owner.ends_with('-');
        if !owner_ok {
            return Err(WorkspaceGitError::invalid(
                "repository owner is not a valid GitHub owner name",
            ));
        }
        // 1 to 100 characters of [A-Za-z0-9._-], not `.` or `..`, not `*.git`.
        let name_ok = (1..=100).contains(&name.len())
            && name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
            && name != "."
            && name != ".."
            && !name.ends_with(".git");
        if !name_ok {
            return Err(WorkspaceGitError::invalid(
                "repository name is not a valid GitHub repository name",
            ));
        }
        Ok(Repository {
            owner: owner.to_string(),
            name: name.to_string(),
        })
    }

    /// Re-check a value that was deserialized rather than parsed.
    pub fn validated(&self) -> Result<Repository, WorkspaceGitError> {
        Self::parse(&self.owner, &self.name)
    }
}

/// 1 to 244 characters of `[A-Za-z0-9._/@+-]`; no leading `-` or `/`, no
/// trailing `/`, `.`, or `.lock`, and none of `..`, `//`, `@{`, `/.`.
pub fn validate_branch(name: &str) -> Result<(), WorkspaceGitError> {
    let ok = (1..=244).contains(&name.len())
        && name.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'/' | b'@' | b'+' | b'-')
        })
        && !name.starts_with('-')
        && !name.starts_with('/')
        && !name.ends_with('/')
        && !name.ends_with('.')
        && !name.ends_with(".lock")
        && !["..", "//", "@{", "/."]
            .iter()
            .any(|sequence| name.contains(sequence));
    if ok {
        Ok(())
    } else {
        Err(WorkspaceGitError::invalid(
            "branch name is not an allowed git branch name",
        ))
    }
}

/// `[A-Za-z_][A-Za-z0-9_]{0,127}`, minus the names and prefixes that would
/// redirect git, the shell loader, the dynamic linker, or the tool runner.
pub fn validate_variable_name(name: &str) -> Result<(), WorkspaceGitError> {
    let mut bytes = name.bytes();
    let ok = (1..=128).contains(&name.len())
        && bytes
            .next()
            .is_some_and(|first| first.is_ascii_alphabetic() || first == b'_')
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
        && !FORBIDDEN_VARIABLE_NAMES.contains(&name)
        && !FORBIDDEN_VARIABLE_PREFIXES
            .iter()
            .any(|prefix| name.starts_with(prefix));
    if ok {
        Ok(())
    } else {
        Err(WorkspaceGitError::invalid(
            "environment variable name is not allowed",
        ))
    }
}

/// The desktop installation id is a UUID. It is an ownership label, not a
/// credential; its fixed shape keeps the registry key unambiguous.
pub fn validate_installation_id(id: &str) -> Result<(), WorkspaceGitError> {
    let ok = id.len() == 36
        && id.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        });
    if ok {
        Ok(())
    } else {
        Err(WorkspaceGitError::invalid("installationId is not a UUID"))
    }
}

pub fn validate_session_id(id: &str) -> Result<(), WorkspaceGitError> {
    if (1..=256).contains(&id.chars().count()) {
        Ok(())
    } else {
        Err(WorkspaceGitError::invalid(
            "sessionId must be 1 to 256 characters",
        ))
    }
}

/// The first 12 lowercase hex characters of
/// `SHA-256(installationId + "\n" + sessionId)`. `pi-host` computes the same
/// value in TypeScript; both test suites pin one vector.
pub fn short_id(installation_id: &str, session_id: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(installation_id.as_bytes());
    hasher.update(b"\n");
    hasher.update(session_id.as_bytes());
    let mut id = hex::encode(hasher.finalize());
    id.truncate(SHORT_ID_LENGTH);
    id
}

/// `pi-desktop/<short id>`: the only branch a session may push.
pub fn work_branch(installation_id: &str, session_id: &str) -> String {
    format!(
        "{WORK_BRANCH_PREFIX}{}",
        short_id(installation_id, session_id)
    )
}

/// Where repositories and worktrees live under one workspaces root.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Layout {
    root: PathBuf,
}

impl Layout {
    pub fn new(workspaces_root: &Path) -> Result<Layout, WorkspaceGitError> {
        let absolute = workspaces_root.is_absolute();
        let escapes = workspaces_root
            .components()
            .any(|part| matches!(part, Component::ParentDir));
        if !absolute || escapes {
            return Err(WorkspaceGitError::invalid(
                "workspacesRoot must be an absolute path without `..` segments",
            ));
        }
        Ok(Layout {
            root: workspaces_root.to_path_buf(),
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// The repository's main checkout; sessions never edit it.
    pub fn main_path(&self, repository: &Repository) -> PathBuf {
        self.root
            .join("repos")
            .join(GITHUB_HOST)
            .join(&repository.owner)
            .join(&repository.name)
    }

    /// One session's worktree; `short_id` is `short_id(installation, session)`.
    pub fn worktree_path(&self, repository: &Repository, short_id: &str) -> PathBuf {
        self.root
            .join("worktrees")
            .join(GITHUB_HOST)
            .join(&repository.owner)
            .join(&repository.name)
            .join(short_id)
    }

    /// The URL stored as `origin`. It never carries a credential or a proxy
    /// address, so a host restart on a new proxy port needs no rewrite.
    pub fn clone_url(&self, repository: &Repository) -> String {
        Self::github_url(repository)
    }

    /// `https://github.com/<owner>/<repo>.git`: the only URL ever cloned, and
    /// the one the credential proxy rewrite stands in for.
    pub fn github_url(repository: &Repository) -> String {
        format!(
            "https://{GITHUB_HOST}/{}/{}.git",
            repository.owner, repository.name
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const INSTALLATION: &str = "00000000-0000-4000-8000-000000000000";

    fn long(len: usize) -> String {
        "a".repeat(len)
    }

    #[test]
    fn owners_follow_the_shared_contract_tables() {
        for owner in ["o", "octo-cat", "A1", &long(39)] {
            assert!(Repository::parse(owner, "r").is_ok(), "{owner:?}");
        }
        for owner in [
            "-a",
            "a-",
            "",
            "a/b",
            &long(40),
            "a.b",
            "a b",
            "a\n",
            "..",
            "--upload-pack=x",
        ] {
            let error = Repository::parse(owner, "r").unwrap_err();
            assert_eq!(error.code, "INVALID_ARGUMENT", "{owner:?}");
        }
    }

    #[test]
    fn repository_names_follow_the_shared_contract_tables() {
        for name in ["r", "PI-Desktop", "repo.js", ".github", "a_b", &long(100)] {
            assert!(Repository::parse("o", name).is_ok(), "{name:?}");
        }
        for name in [
            ".",
            "..",
            "a/b",
            "repo.git",
            "--upload-pack=x",
            "",
            &long(101),
            "a b",
            "a\u{0}b",
            "a\n",
        ] {
            let error = Repository::parse("o", name).unwrap_err();
            assert_eq!(error.code, "INVALID_ARGUMENT", "{name:?}");
        }
    }

    #[test]
    fn branches_follow_the_shared_contract_tables() {
        for branch in [
            "main",
            "feature/x-1",
            "release/1.2",
            "user@fix",
            "a+b",
            &long(244),
        ] {
            assert!(validate_branch(branch).is_ok(), "{branch:?}");
        }
        for branch in [
            "-x",
            "/a",
            "a/",
            "a..b",
            "a//b",
            "a@{b",
            "a/.b",
            "a.lock",
            "a b",
            "a\u{0}b",
            "",
            "a.",
            &long(245),
            "a~1",
            "a^",
            "a:b",
            "a?",
            "a*",
            "a[b",
            "a\\b",
            "a\n",
            "--upload-pack=x",
            "../../etc",
            "refs/heads/a.lock",
        ] {
            let error = validate_branch(branch).unwrap_err();
            assert_eq!(error.code, "INVALID_ARGUMENT", "{branch:?}");
        }
    }

    #[test]
    fn variable_names_follow_the_shared_contract_tables() {
        for name in ["my_var", "A", "_x", "NODE_ENV", &"A".repeat(128)] {
            assert!(validate_variable_name(name).is_ok(), "{name:?}");
        }
        for name in [
            "PATH",
            "GIT_DIR",
            "PI_PORT",
            "LD_PRELOAD",
            "1A",
            "A-B",
            "",
            &"A".repeat(129),
            "HOME",
            "SHELL",
            "USER",
            "LOGNAME",
            "PWD",
            "OLDPWD",
            "IFS",
            "ENV",
            "BASH_ENV",
            "PROMPT_COMMAND",
            "NODE_OPTIONS",
            "ELECTRON_RUN_AS_NODE",
            "DYLD_INSERT_LIBRARIES",
            "BASH_FUNC_x",
            "A=B",
            "A\n",
        ] {
            let error = validate_variable_name(name).unwrap_err();
            assert_eq!(error.code, "INVALID_ARGUMENT", "{name:?}");
        }
    }

    #[test]
    fn installation_and_session_ids_are_bounded() {
        assert!(validate_installation_id(INSTALLATION).is_ok());
        for id in [
            "",
            "not-a-uuid",
            "00000000-0000-4000-8000-00000000000",
            "00000000-0000-4000-8000-000000000000\n",
            "00000000:0000-4000-8000-000000000000",
            "0000000g-0000-4000-8000-000000000000",
        ] {
            assert_eq!(
                validate_installation_id(id).unwrap_err().code,
                "INVALID_ARGUMENT",
                "{id:?}"
            );
        }
        assert!(validate_session_id("s").is_ok());
        assert!(validate_session_id(&long(256)).is_ok());
        assert!(validate_session_id("").is_err());
        assert!(validate_session_id(&long(257)).is_err());
    }

    #[test]
    fn the_work_branch_matches_the_cross_language_test_vector() {
        assert_eq!(short_id(INSTALLATION, "session-1"), "8b54618f6bc1");
        assert_eq!(
            work_branch(INSTALLATION, "session-1"),
            "pi-desktop/8b54618f6bc1"
        );
        assert_ne!(
            short_id(INSTALLATION, "session-2"),
            short_id(INSTALLATION, "session-1")
        );
        // The work branch is itself a valid branch name.
        assert!(validate_branch(&work_branch(INSTALLATION, "session-1")).is_ok());
    }

    #[test]
    fn the_layout_needs_an_absolute_root_without_parent_segments() {
        assert!(Layout::new(Path::new("/srv/pi-workspaces")).is_ok());
        for root in ["pi-workspaces", "./pi-workspaces", "", "/srv/../etc"] {
            let error = Layout::new(Path::new(root)).unwrap_err();
            assert_eq!(error.code, "INVALID_ARGUMENT", "{root:?}");
        }
    }

    #[test]
    fn every_accepted_name_stays_under_the_root() {
        let root = Path::new("/srv/pi-workspaces");
        let layout = Layout::new(root).unwrap();
        let id = short_id(INSTALLATION, "session-1");
        for (owner, name) in [
            ("o", "r"),
            ("octo-cat", ".github"),
            ("A1", "repo.js"),
            ("a", "..."),
            ("a", "-r"),
            (&long(39), &long(100)),
        ] {
            let repository = Repository::parse(owner, name).unwrap();
            let main = layout.main_path(&repository);
            let worktree = layout.worktree_path(&repository, &id);
            assert_eq!(
                main,
                root.join("repos/github.com").join(owner).join(name),
                "{owner}/{name}"
            );
            assert_eq!(
                worktree,
                root.join("worktrees/github.com")
                    .join(owner)
                    .join(name)
                    .join(&id)
            );
            for path in [&main, &worktree] {
                assert!(path.starts_with(root));
                assert!(path
                    .components()
                    .all(|part| !matches!(part, std::path::Component::ParentDir)));
            }
        }
    }

    #[test]
    fn the_clone_url_is_always_github_over_https() {
        let layout = Layout::new(Path::new("/srv/pi-workspaces")).unwrap();
        let repository = Repository::parse("octo-cat", "repo.js").unwrap();
        assert_eq!(
            layout.clone_url(&repository),
            "https://github.com/octo-cat/repo.js.git"
        );
    }
}
