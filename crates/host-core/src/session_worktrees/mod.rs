//! Git worktrees for isolated sessions and their Write/Edit delegates
//! (ADR 0329). host-core owns every worktree path and every git command; the
//! renderer and the agent runtime only name a session or delegation.

pub mod delegate;
pub mod git;
pub mod include;
pub mod lifecycle;
pub mod merge;
pub mod probe;
pub mod registry;
pub mod remove;
mod repo_lock;

#[cfg(test)]
pub(crate) mod test_support;

use git::GitError;
use probe::ProbeError;

/// A failure that reaches the RPC surface with a stable `WORKTREE_*` code.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorktreeError {
    pub code: &'static str,
    pub message: String,
    /// Conflicting files for `WORKTREE_CONFLICT`; empty otherwise.
    pub files: Vec<String>,
}

impl WorktreeError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            files: Vec::new(),
        }
    }

    pub fn conflict(files: Vec<String>) -> Self {
        Self {
            code: "WORKTREE_CONFLICT",
            message: format!(
                "merge conflict in {} file(s); resolve them in the session and merge again",
                files.len()
            ),
            files,
        }
    }
}

impl std::fmt::Display for WorktreeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl From<GitError> for WorktreeError {
    fn from(error: GitError) -> Self {
        Self::new(error.code(), error.to_string())
    }
}

impl From<ProbeError> for WorktreeError {
    fn from(error: ProbeError) -> Self {
        Self::new(error.code(), error.to_string())
    }
}

impl From<anyhow::Error> for WorktreeError {
    fn from(error: anyhow::Error) -> Self {
        Self::new("WORKTREE_INTERNAL", error.to_string())
    }
}

impl From<std::io::Error> for WorktreeError {
    fn from(error: std::io::Error) -> Self {
        Self::new("WORKTREE_IO", error.to_string())
    }
}

/// FNV-1a: a stable hash for directory names and preview tokens. The std
/// hasher is not stable across Rust releases, and these values persist.
pub(crate) fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}
