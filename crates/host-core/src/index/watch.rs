//! Opt-in filesystem watcher for the workspace index (`workspace-watch`).
//!
//! The index's correctness rule is that a stale index may cost speed but
//! never change Grep's answer. Host-driven writes are covered by the
//! invalidation on the Write/Edit/Bash tool path; edits made *outside* the
//! host — an editor, `git checkout`, a build script — are only visible to a
//! watcher.
//!
//! The watcher therefore does exactly one thing: on any event under a
//! watched root it marks that root `stale`, which makes Grep's fast path
//! answer `StateGate` and fall back to the full walk. It never parses paths,
//! never patches the index incrementally, and never rebuilds by itself —
//! events are hints, and the stat-only probe plus a rebuild stay the
//! authority. That also means a burst of events needs no debouncing: marking
//! a root stale twice is a no-op the second time.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};

use super::{normalize_root, IndexStore};

/// A live watcher over the roots the index currently serves. Dropping it
/// stops every watch.
pub struct WorkspaceWatcher {
    watcher: RecommendedWatcher,
    /// Roots currently watched, by normalized path, so a repeated `watch`
    /// for the same workspace does not stack another OS watch.
    watched: Arc<Mutex<HashMap<PathBuf, ()>>>,
}

impl WorkspaceWatcher {
    /// Start a watcher that marks `root` stale on any event beneath it.
    ///
    /// Returns `None` when the platform watcher cannot be created; indexing
    /// is an optimization layer, so a host without a watcher simply keeps
    /// the stat-only refresh path.
    pub fn start(store: Arc<IndexStore>) -> Option<Self> {
        let watched: Arc<Mutex<HashMap<PathBuf, ()>>> = Arc::new(Mutex::new(HashMap::new()));
        let event_roots = watched.clone();
        let watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
            // A watch error is not actionable here: the index stays as it is
            // and Grep keeps walking. Every event, whatever its kind, maps to
            // the same response — invalidate.
            let Ok(event) = event else {
                return;
            };
            let roots: Vec<PathBuf> = match event_roots.lock() {
                Ok(roots) => roots.keys().cloned().collect(),
                Err(_) => return,
            };
            for root in roots {
                if event.paths.iter().any(|path| path.starts_with(&root)) {
                    store.mark_stale(&root);
                }
            }
        })
        .ok()?;
        Some(Self { watcher, watched })
    }

    /// Watch `root` recursively. Idempotent: watching an already-watched
    /// workspace is a no-op.
    pub fn watch(&mut self, root: &Path) -> notify::Result<()> {
        let root = normalize_root(root);
        {
            let mut watched = match self.watched.lock() {
                Ok(watched) => watched,
                Err(_) => return Ok(()),
            };
            if watched.contains_key(&root) {
                return Ok(());
            }
            watched.insert(root.clone(), ());
        }
        if let Err(error) = self.watcher.watch(&root, RecursiveMode::Recursive) {
            // Roll the bookkeeping back so a later attempt can retry.
            if let Ok(mut watched) = self.watched.lock() {
                watched.remove(&root);
            }
            return Err(error);
        }
        Ok(())
    }

    /// Stop watching `root`. `workspace.clear` drops the watch with the
    /// workspace it belonged to.
    pub fn unwatch(&mut self, root: &Path) {
        let root = normalize_root(root);
        let known = self
            .watched
            .lock()
            .map(|mut watched| watched.remove(&root).is_some())
            .unwrap_or(false);
        if known {
            let _ = self.watcher.unwatch(&root);
        }
    }

    /// The roots currently watched. Exposed for diagnostics and asserted by
    /// the watcher's own tests; a future health-card surface can report it.
    #[allow(dead_code)]
    pub fn watched_roots(&self) -> Vec<PathBuf> {
        self.watched
            .lock()
            .map(|watched| watched.keys().cloned().collect())
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::IndexLimits;
    use std::fs;
    use std::time::{Duration, Instant};

    #[test]
    fn an_external_write_marks_the_root_stale() {
        let data = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("one.txt"), "needle\n").unwrap();
        let store = Arc::new(IndexStore::open(data.path()).unwrap());
        store.rebuild(root.path(), IndexLimits::default()).unwrap();
        let Some(mut watcher) = WorkspaceWatcher::start(store.clone()) else {
            // No platform watcher: the stat-only path is the fallback and the
            // invalidation contract is covered by mark_stale's own tests.
            return;
        };
        watcher.watch(root.path()).unwrap();
        assert_eq!(watcher.watched_roots().len(), 1);

        fs::write(root.path().join("two.txt"), "fresh content\n").unwrap();
        // FSEvents/inotify delivery is asynchronous; poll briefly.
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if store.status(Some(root.path())).unwrap()[0].status == "stale" {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        panic!("an external write must mark the root stale");
    }

    #[test]
    fn watching_the_same_root_twice_is_idempotent() {
        let data = tempfile::tempdir().unwrap();
        let store = Arc::new(IndexStore::open(data.path()).unwrap());
        let root = tempfile::tempdir().unwrap();
        let Some(mut watcher) = WorkspaceWatcher::start(store) else {
            return;
        };
        watcher.watch(root.path()).unwrap();
        watcher.watch(root.path()).unwrap();
        assert_eq!(watcher.watched_roots().len(), 1);
        watcher.unwatch(root.path());
        assert!(watcher.watched_roots().is_empty());
    }
}
