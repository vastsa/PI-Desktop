//! Git workspaces on a remote host (D687, decision record
//! `remote-git-workspaces`).
//!
//! A paired desktop asks this host to clone a GitHub repository once and to
//! give each of its sessions a git worktree on a work branch. host-core owns
//! every git invocation and the worktree registry here, as it does for local
//! isolated sessions (ADR 0329). The GitHub token never reaches this process:
//! git authenticates through a loopback proxy that `pi-host` runs, named by a
//! per-command URL rewrite.

pub mod environment;
pub mod layout;
pub mod registry;
pub mod repository;
pub mod worktree;

#[cfg(test)]
pub(crate) mod test_support;

/// A failure that reaches the RPC surface with a stable code: one of the
/// `WORKSPACE_GIT_*` codes, or `INVALID_ARGUMENT` for a refused name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceGitError {
    pub code: &'static str,
    pub message: String,
}

impl WorkspaceGitError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    /// A name, id, or path the caller supplied was refused before any use.
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new("INVALID_ARGUMENT", message)
    }

    pub fn failed(message: impl Into<String>) -> Self {
        Self::new("WORKSPACE_GIT_FAILED", message)
    }
}

impl std::fmt::Display for WorkspaceGitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl From<anyhow::Error> for WorkspaceGitError {
    fn from(error: anyhow::Error) -> Self {
        Self::failed(error.to_string())
    }
}

impl From<std::io::Error> for WorkspaceGitError {
    fn from(error: std::io::Error) -> Self {
        Self::failed(error.to_string())
    }
}
