//! One async lock per repository: every mutating git command host-core runs
//! for a repository is serialized under its canonical common git directory,
//! because worktrees share refs, the object store, and worktree metadata.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};

static LOCKS: OnceLock<Mutex<HashMap<PathBuf, Arc<AsyncMutex<()>>>>> = OnceLock::new();

pub async fn lock(common_dir: &Path) -> OwnedMutexGuard<()> {
    let entry = {
        let mut locks = LOCKS
            .get_or_init(Default::default)
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        locks
            .entry(common_dir.to_path_buf())
            .or_insert_with(|| Arc::new(AsyncMutex::new(())))
            .clone()
    };
    entry.lock_owned().await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn one_repository_is_serialized_and_others_are_not() {
        let first = lock(Path::new("/repo-a/.git")).await;
        // A different repository is independent.
        let other = lock(Path::new("/repo-b/.git")).await;
        drop(other);
        // The same repository waits until the first guard is released.
        let waiting = tokio::spawn(async { lock(Path::new("/repo-a/.git")).await });
        tokio::task::yield_now().await;
        assert!(!waiting.is_finished());
        drop(first);
        waiting.await.unwrap();
    }
}
