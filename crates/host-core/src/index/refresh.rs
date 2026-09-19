//! Same-path auto refresh for the workspace index.
//!
//! The index has no filesystem watcher, so an in-place edit is invisible to
//! the fast path until the root is re-crawled. [`IndexStore::refresh_due`]
//! spaces those re-crawls at least [`AUTO_REFRESH_MIN_INTERVAL`] apart per
//! root, and [`IndexStore::request_refresh`] marks a fresh root building so
//! `index.status` tells the truth while the re-walk runs.

use anyhow::Result;
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant, UNIX_EPOCH};

use super::{
    normalize_rel_path, normalize_root, root_id, BuildProgress, IndexStatus, IndexStore,
    RootUpdate, MAX_FILES,
};

/// Minimum spacing between same-path auto refreshes of a workspace index.
/// Bounds how long Grep's fast path can keep serving candidates that predate
/// an in-place edit, without paying for a re-walk on every `workspace.set`.
pub const AUTO_REFRESH_MIN_INTERVAL: Duration = Duration::from_secs(600);

impl IndexStore {
    /// Whether a same-path auto refresh of `root` is due now. This only
    /// *peeks* — the interval clock starts when the caller reports the
    /// refresh actually triggered via [`Self::refresh_mark`], so a failed
    /// trigger retries on the next `workspace.set` instead of waiting out
    /// the interval.
    pub fn refresh_due(&self, root: &Path) -> bool {
        let root_id = root_id(&normalize_root(root));
        let last = self.last_refresh.lock().unwrap();
        match last.get(&root_id) {
            Some(at) => at.elapsed() >= AUTO_REFRESH_MIN_INTERVAL,
            None => true,
        }
    }

    /// Start the same-path refresh interval for `root`. Call this only after
    /// the re-walk has actually been triggered (an equivalent fresh rebuild
    /// from a changed-path set marks too — a workspace that was just crawled
    /// has no need for an immediate refresh).
    pub fn refresh_mark(&self, root: &Path) {
        let root_id = root_id(&normalize_root(root));
        self.last_refresh
            .lock()
            .unwrap()
            .insert(root_id, Instant::now());
    }

    /// Stat-only freshness probe run before committing to a full re-crawl.
    /// Returns `true` when the root needs a rebuild — it is not `fresh`, or
    /// the visible set's on-disk sizes/mtimes disagree with the stored rows
    /// (a file changed, appeared, or vanished) — after marking it `building`
    /// via [`Self::request_refresh`], so the caller goes straight to
    /// `rebuild`. Returns `false` only when the walk reproduces the stored
    /// visible set exactly, letting the caller skip the re-crawl and keep
    /// the root fresh. On any uncertain outcome (unreadable entry, vanished
    /// file mid-walk) the probe answers `true` and lets the crawl decide.
    pub fn refresh_if_changed(&self, root: &Path) -> Result<bool> {
        let root = normalize_root(root);
        let root_id = root_id(&root);
        let fresh = self
            .status(Some(&root))?
            .into_iter()
            .next()
            .is_some_and(|status| status.status == IndexStatus::Fresh.as_str());
        let changed = !fresh || self.visible_set_changed(&root, &root_id)?;
        if changed {
            self.request_refresh(&root)?;
        }
        Ok(changed)
    }

    /// Walk the visible set the way the crawler does (unscoped visible walk,
    /// vendor prune) minus the content read: stat is all the staleness
    /// decision needs. Returns `true` on any disagreement with the stored
    /// rows or on any uncertain outcome.
    fn visible_set_changed(&self, root: &Path, root_id: &str) -> Result<bool> {
        let connection = self.connection()?;
        let mut stored: HashMap<String, (i64, i64)> = HashMap::new();
        {
            let mut statement = connection
                .prepare("SELECT rel_path, size, mtime_ms FROM files WHERE root_id = ?1")?;
            let rows = statement.query_map([root_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })?;
            for row in rows {
                let (rel_path, size, mtime_ms) = row?;
                stored.insert(rel_path, (size, mtime_ms));
            }
        }
        let mut seen = 0_usize;
        for entry in crate::tools::ignore_rules::visible_walker(root, false).build() {
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => return Ok(true),
            };
            if !entry
                .file_type()
                .is_some_and(|file_type| file_type.is_file())
                || crate::tools::ignore_rules::is_vendor_path(root, entry.path())
            {
                continue;
            }
            seen += 1;
            if seen > MAX_FILES {
                return Ok(true); // over budget: the crawl re-arms the limit state
            }
            let path = entry.path().to_path_buf();
            let Ok(metadata) = std::fs::metadata(&path) else {
                return Ok(true); // vanished mid-walk
            };
            let rel_path = match path.strip_prefix(root) {
                Ok(rel) => normalize_rel_path(rel),
                Err(_) => return Ok(true),
            };
            let mtime_ms = metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis() as i64)
                .unwrap_or(0);
            match stored.remove(&rel_path) {
                Some((size, stored_mtime)) => {
                    if size != metadata.len() as i64 || stored_mtime != mtime_ms {
                        return Ok(true);
                    }
                }
                None => return Ok(true), // a file the index never saw
            }
        }
        Ok(!stored.is_empty()) // leftover rows are files no longer on disk
    }

    /// Mark a `fresh` root `stale` after the host itself changed workspace
    /// content (a Write/Edit/Bash tool call). Grep's fast path answers
    /// `StateGate` for a stale root and falls back to the full walk, so the
    /// index can never serve candidates that predate the write — the
    /// correctness rule the review asked for. A no-op for a root that is not
    /// `fresh` (nothing to invalidate) or not indexed at all.
    ///
    /// The rebuild itself stays opportunistic: the next `workspace.set`
    /// (or the watcher, where one runs) picks the root up, and until then
    /// Grep is merely un-accelerated, never wrong.
    pub fn mark_stale(&self, root: &Path) {
        let root = normalize_root(root);
        let root_id = root_id(&root);
        let current = self
            .status(Some(&root))
            .ok()
            .and_then(|mut statuses| statuses.pop())
            .map(|status| status.status);
        match current.as_deref() {
            // A build in flight cannot guarantee it captured whatever the
            // watcher just saw; flag the root so the build lands as `stale`
            // instead of `fresh` and the next trigger re-crawls.
            Some(status) if status == IndexStatus::Building.as_str() => {
                self.pending_dirty.lock().unwrap().insert(root_id);
            }
            // A fresh root loses the fast path immediately.
            Some(status) if status == IndexStatus::Fresh.as_str() => {
                if let Err(error) = self.set_root_status(
                    &root_id,
                    &root,
                    RootUpdate {
                        status: IndexStatus::Stale,
                        file_count: 0,
                        indexed_bytes: 0,
                        error_count: 0,
                        last_error: None,
                    },
                ) {
                    tracing::warn!(error = %error, "mark index stale failed");
                }
            }
            _ => {}
        }
    }

    /// Mark a `fresh` root `building` ahead of a same-path auto refresh, so
    /// `index.status` tells the truth while the re-walk runs.
    pub fn request_refresh(&self, root: &Path) -> Result<()> {
        let root = normalize_root(root);
        let root_id = root_id(&root);
        // Register the root as building in-process *before* the row flips:
        // a concurrent ensure_index in the window before the spawned rebuild
        // starts must see a live build, not crash residue, or it would
        // trigger a second crawl. If the rebuild never ends up running, the
        // registration lives until process exit — the cheaper side of the
        // ambiguity, since the alternative is a permanently spinning health
        // card.
        self.building_roots
            .lock()
            .unwrap()
            .insert(root_id.clone(), Arc::new(BuildProgress::default()));
        self.set_root_status(
            &root_id,
            &root,
            RootUpdate {
                status: IndexStatus::Building,
                file_count: 0,
                indexed_bytes: 0,
                error_count: 0,
                last_error: None,
            },
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::IndexLimits;
    use std::fs;

    #[test]
    fn same_path_refresh_is_due_until_marked() {
        let data = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("one.txt"), "one\n").unwrap();
        let store = IndexStore::open(data.path()).unwrap();

        assert!(store.refresh_due(root.path()), "first peek is due");
        assert!(
            store.refresh_due(root.path()),
            "peeking does not consume the interval"
        );
        store.refresh_mark(root.path());
        assert!(
            !store.refresh_due(root.path()),
            "marking starts the interval"
        );
        // An unrelated root has its own clock.
        let other = tempfile::tempdir().unwrap();
        assert!(store.refresh_due(other.path()));
    }

    #[test]
    fn probe_skips_the_recrawl_when_the_visible_set_is_unchanged() {
        let data = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("one.txt"), "one\n").unwrap();
        let store = IndexStore::open(data.path()).unwrap();
        store.rebuild(root.path(), IndexLimits::default()).unwrap();

        assert!(!store.refresh_if_changed(root.path()).unwrap());
        assert_eq!(
            store.status(Some(root.path())).unwrap()[0].status,
            "fresh",
            "an unchanged root is never flipped to building"
        );
    }

    #[test]
    fn probe_detects_edited_added_and_removed_files() {
        let data = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("one.txt"), "one\n").unwrap();
        let store = IndexStore::open(data.path()).unwrap();
        store.rebuild(root.path(), IndexLimits::default()).unwrap();

        // Edited in place (mtime moves): rebuild is required.
        std::thread::sleep(std::time::Duration::from_millis(1100));
        fs::write(root.path().join("one.txt"), "one edited\n").unwrap();
        assert!(store.refresh_if_changed(root.path()).unwrap());
        assert_eq!(
            store.status(Some(root.path())).unwrap()[0].status,
            "building",
            "a changed root is marked building for the re-crawl"
        );
        store.rebuild(root.path(), IndexLimits::default()).unwrap();

        // A new file appears.
        fs::write(root.path().join("two.txt"), "two\n").unwrap();
        assert!(store.refresh_if_changed(root.path()).unwrap());
        store.rebuild(root.path(), IndexLimits::default()).unwrap();

        // A stored file disappears.
        fs::remove_file(root.path().join("two.txt")).unwrap();
        assert!(store.refresh_if_changed(root.path()).unwrap());
    }

    #[test]
    fn probe_falls_through_to_a_full_rebuild_for_a_non_fresh_root() {
        let data = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("one.txt"), "one\n").unwrap();
        let store = IndexStore::open(data.path()).unwrap();

        // Unknown root: not fresh, so the probe takes the rebuild path.
        assert!(store.refresh_if_changed(root.path()).unwrap());
        assert_eq!(
            store.status(Some(root.path())).unwrap()[0].status,
            "building"
        );
    }

    #[test]
    fn mark_stale_takes_a_fresh_root_out_of_the_fast_path() {
        let data = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("one.txt"), "needle\n").unwrap();
        let store = IndexStore::open(data.path()).unwrap();
        store.rebuild(root.path(), IndexLimits::default()).unwrap();

        // A fresh root serves the fast path…
        assert_eq!(store.status(Some(root.path())).unwrap()[0].status, "fresh");
        store.mark_stale(root.path());
        // …and a stale one does not: the fast path answers StateGate, so
        // Grep falls back instead of trusting candidates that predate a write.
        assert_eq!(store.status(Some(root.path())).unwrap()[0].status, "stale");
        assert!(matches!(
            crate::index::fast_path::select_candidates(&store, root.path(), "needle", 20_000),
            crate::index::fast_path::CandidateSelection::Fallback
        ));
    }

    #[test]
    fn events_during_a_build_land_the_root_stale_after_it() {
        let data = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("one.txt"), "needle\n").unwrap();
        let store = IndexStore::open(data.path()).unwrap();

        // ensure_index registers the build and flips the row to building
        // (the auto-index path); a watcher event arriving mid-build cannot
        // be trusted to be inside the crawl, so it must be remembered.
        store.ensure_index(root.path()).unwrap();
        store.mark_stale(root.path());
        assert!(store
            .pending_dirty
            .lock()
            .unwrap()
            .contains(&root_id(&normalize_root(root.path()))));

        // The build lands, but the remembered event downgrades fresh to
        // stale: the fast path stays off until the next re-crawl.
        let status = store.rebuild(root.path(), IndexLimits::default()).unwrap();
        assert_eq!(status.status, "stale");
        assert!(!store
            .pending_dirty
            .lock()
            .unwrap()
            .contains(&root_id(&normalize_root(root.path()))));
    }

    #[test]
    fn mark_stale_leaves_an_unindexed_root_alone() {
        let data = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let store = IndexStore::open(data.path()).unwrap();
        // No row at all: nothing to invalidate, and no row must appear.
        store.mark_stale(root.path());
        assert!(store.status(Some(root.path())).unwrap().is_empty());
    }

    #[test]
    fn request_refresh_registers_the_build_in_process() {
        let data = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("one.txt"), "one\n").unwrap();
        let store = IndexStore::open(data.path()).unwrap();
        store.rebuild(root.path(), IndexLimits::default()).unwrap();
        assert_eq!(store.status(Some(root.path())).unwrap()[0].status, "fresh");

        store.request_refresh(root.path()).unwrap();
        // The registration must exist before the spawned rebuild starts, or
        // a concurrent ensure_index would read the `building` row as crash
        // residue and re-trigger the crawl.
        assert!(store
            .building_roots
            .lock()
            .unwrap()
            .contains_key(&root_id(&normalize_root(root.path()))));
        assert_eq!(
            store.status(Some(root.path())).unwrap()[0].status,
            "building"
        );
    }
}
