//! P2-B Grep literal fast path: FTS candidate selection with hit verification.
//!
//! The fast path never decides a match by itself. It only *narrows* the set of
//! files worth reading; the caller re-scans each candidate with the exact same
//! line scanner the Grep tool already uses, so the public result shape stays
//! byte-for-byte identical to the fallback path (same budgets, same newest-first
//! order, same `grep_output` exit).
//!
//! ## Safety precondition (do not relax without a diff test)
//!
//! Correctness of the fast path rests on the index visible set equalling the
//! Grep visible set. Two mechanisms hold that up, and both are covered by
//! tests — remove either and Grep silently changes its answer:
//!
//! 1. `crate::tools::ignore_rules` is the single definition of the visible set,
//!    shared by this module's crawler and by Grep's candidate walk
//!    (`grep_candidates_match_the_index_visible_set` asserts equality).
//! 2. Files that are visible but not ingested (binary extension, over-size
//!    text) are appended to every candidate set, so "not indexed" can never
//!    silently become "not searched".
//!
//! The fast path still stays behind the opt-in `indexGrepBoost` switch for the
//! remaining P2-B work (settings wiring, E2E coverage).

use anyhow::Result;
use rusqlite::{params, OptionalExtension};
use std::path::{Path, PathBuf};
use std::time::{Instant, UNIX_EPOCH};

use super::metrics::FallbackReason;
use super::{normalize_root, root_id, IndexStore};

/// Trigram tokenizer lower bound: a pattern shorter than this has no 3-gram,
/// so the FTS index can never be a superset of its matches.
pub const MIN_LITERAL_LEN: usize = 3;

/// Fraction of candidates whose on-disk size/mtime disagree with the index
/// above which the whole query falls back. Small drift is tolerated because the
/// caller re-reads file content anyway; large drift means the index is far too
/// stale to trust as a candidate source.
const MAX_DRIFT_RATIO: f64 = 0.10;

/// Admission gate. Returns `Some(literal)` only when the fast path may serve
/// `pattern`: a case-sensitive literal of at least [`MIN_LITERAL_LEN`] code
/// points with no regex metacharacters.
pub fn admitted_literal(pattern: &str, case_insensitive: bool) -> Option<&str> {
    if case_insensitive {
        return None;
    }
    if pattern.chars().count() < MIN_LITERAL_LEN {
        return None;
    }
    if pattern.chars().any(is_regex_meta) {
        return None;
    }
    Some(pattern)
}

fn is_regex_meta(c: char) -> bool {
    matches!(
        c,
        '.' | '*' | '+' | '?' | '[' | ']' | '(' | ')' | '{' | '}' | '|' | '^' | '$' | '\\'
    )
}

/// Quote a user literal as an FTS5 phrase. Internal double quotes are doubled,
/// so a pattern such as `a"b OR c` becomes the single phrase `"a""b OR c"` and
/// can never smuggle MATCH operators into the query.
pub fn fts_phrase(literal: &str) -> String {
    format!("\"{}\"", literal.replace('"', "\"\""))
}

/// Outcome of asking the index for candidate files.
pub enum CandidateSelection {
    /// Candidate files (absolute paths, newest-first). The caller re-scans them.
    Ready(Vec<PathBuf>),
    /// Cannot serve this query (index missing/stale/unknown root, or drift):
    /// the caller must use the normal fallback search.
    Fallback,
}

/// Select candidate files for `literal` under `root` from a `fresh` index.
///
/// Any internal error degrades to [`CandidateSelection::Fallback`]; the fast
/// path must never change Grep's public shape. Every outcome is recorded in the
/// store's in-memory metrics so `index.status` can report fast-path health.
pub fn select_candidates(
    index: &IndexStore,
    root: &Path,
    literal: &str,
    cap: usize,
) -> CandidateSelection {
    let started = Instant::now();
    match select_candidates_inner(index, root, literal, cap) {
        Ok(InnerSelection::Served { files, visible }) => {
            index.metrics().record_served(
                files.len(),
                visible,
                started.elapsed().as_millis() as u64,
            );
            CandidateSelection::Ready(files)
        }
        Ok(InnerSelection::Fallback(reason)) => {
            index
                .metrics()
                .record_fallback(reason, started.elapsed().as_millis() as u64);
            CandidateSelection::Fallback
        }
        Err(_) => {
            index.metrics().record_fallback(
                FallbackReason::Internal,
                started.elapsed().as_millis() as u64,
            );
            CandidateSelection::Fallback
        }
    }
}

/// Inner outcome that keeps the *why* of a fallback so the caller can count it.
enum InnerSelection {
    Served { files: Vec<PathBuf>, visible: usize },
    Fallback(FallbackReason),
}

fn select_candidates_inner(
    index: &IndexStore,
    root: &Path,
    literal: &str,
    cap: usize,
) -> Result<InnerSelection> {
    let root = normalize_root(root);
    let root_id = root_id(&root);
    let connection = index.connection()?;

    // Only a `fresh` root may serve the fast path. `building`/`stale`/
    // `partial`/`failed`/`skipped_over_limit`/`disabled` all fall back.
    let status: Option<String> = connection
        .query_row(
            "SELECT status FROM indexed_roots WHERE root_id = ?1",
            [&root_id],
            |row| row.get(0),
        )
        .optional()?;
    if status.as_deref() != Some("fresh") {
        return Ok(InnerSelection::Fallback(FallbackReason::StateGate));
    }

    let phrase = fts_phrase(literal);
    // FTS5's MATCH operator needs the real table name on the left, so the FTS
    // table is not aliased here.
    let mut statement = connection.prepare(
        "SELECT f.rel_path, f.size, f.mtime_ms
         FROM file_content_fts
         JOIN files AS f
           ON f.root_id = file_content_fts.root_id
          AND f.rel_path = file_content_fts.rel_path
         WHERE file_content_fts.root_id = ?1
           AND file_content_fts MATCH ?2
         ORDER BY f.mtime_ms DESC, f.rel_path ASC
         LIMIT ?3",
    )?;
    let rows = statement.query_map(params![root_id, phrase, (cap as i64) + 1], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, i64>(2)?,
        ))
    })?;
    let mut candidates: Vec<(String, i64, i64)> = Vec::new();
    for row in rows {
        candidates.push(row?);
    }
    if candidates.len() > cap {
        // Too wide to be a cheap narrowing; let the fallback search handle it.
        return Ok(InnerSelection::Fallback(FallbackReason::TooWide));
    }

    // Files the crawler saw but never ingested — binary extensions, over-size
    // text — are still visible to Grep, so they must still be searched. They
    // can never appear in the FTS hits, so they are appended unconditionally
    // and handed to the caller's line scanner exactly like a fallback candidate.
    // Dropping them would turn "not indexed" into "not searched": a silent
    // false negative that no drift check can detect.
    let mut unindexed = connection.prepare(
        "SELECT rel_path, size, mtime_ms
         FROM files
         WHERE root_id = ?1 AND content_indexed = 0
         ORDER BY mtime_ms DESC, rel_path ASC",
    )?;
    let rows = unindexed.query_map([&root_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, i64>(2)?,
        ))
    })?;
    for row in rows {
        candidates.push(row?);
    }
    if candidates.len() > cap {
        return Ok(InnerSelection::Fallback(FallbackReason::TooWide));
    }
    // The fallback walk serves files in one global newest-first order and the
    // caller truncates at head_limit while scanning in candidate order, so the
    // merged set is re-sorted into that same order. Appending the unindexed
    // tail as-is would let a head-limited Grep read an older indexed hit
    // before a newer unindexed file — silently changing Grep's answer.
    candidates.sort_unstable_by(|(a_path, _, a_mtime), (b_path, _, b_mtime)| {
        b_mtime.cmp(a_mtime).then_with(|| a_path.cmp(b_path))
    });
    // The visible set is every row the crawler stored for this root, ingested
    // or not; it is the denominator for the candidate-ratio diagnostic.
    let visible: i64 = connection.query_row(
        "SELECT COUNT(*) FROM files WHERE root_id = ?1",
        [&root_id],
        |row| row.get(0),
    )?;
    if candidates.is_empty() {
        return Ok(InnerSelection::Served {
            files: Vec::new(),
            visible: visible.max(0) as usize,
        });
    }

    // Hit verification: stat every candidate. A vanished candidate means the
    // index is already a stale superset; too much drift means it is not a
    // trustworthy candidate source. Either way, fall back.
    let mut drifted = 0_usize;
    let mut files = Vec::with_capacity(candidates.len());
    for (rel_path, size, mtime_ms) in candidates {
        let absolute = root.join(&rel_path);
        let Ok(metadata) = std::fs::metadata(&absolute) else {
            return Ok(InnerSelection::Fallback(FallbackReason::VerifyFailed));
        };
        let on_disk_mtime = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis() as i64)
            .unwrap_or(0);
        if metadata.len() as i64 != size || on_disk_mtime != mtime_ms {
            drifted += 1;
        }
        files.push(absolute);
    }
    if drifted as f64 / files.len() as f64 > MAX_DRIFT_RATIO {
        return Ok(InnerSelection::Fallback(FallbackReason::VerifyFailed));
    }
    Ok(InnerSelection::Served {
        files,
        visible: visible.max(0) as usize,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{index::IndexLimits, index::IndexStore};
    use std::fs;

    #[test]
    fn admission_refuses_regex_short_and_case_insensitive_patterns() {
        assert_eq!(admitted_literal("needle", false), Some("needle"));
        assert_eq!(admitted_literal("n.needle", false), None);
        assert_eq!(admitted_literal("a|b", false), None);
        assert_eq!(admitted_literal("ab", false), None);
        assert_eq!(admitted_literal("", false), None);
        assert_eq!(admitted_literal("needle", true), None);
        // CJK literals are >= 3 code points and are admitted.
        assert_eq!(admitted_literal("索引库", false), Some("索引库"));
    }

    #[test]
    fn phrase_quoting_doubles_internal_quotes() {
        assert_eq!(fts_phrase("plain"), "\"plain\"");
        assert_eq!(fts_phrase("a\"b"), "\"a\"\"b\"");
        // A would-be operator stays inside one phrase.
        assert_eq!(fts_phrase("a OR b"), "\"a OR b\"");
    }

    #[test]
    fn fresh_index_serves_only_literal_matching_files() {
        let data = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("hit.txt"), "the literal needle is here\n").unwrap();
        fs::write(root.path().join("miss.txt"), "nothing to see\n").unwrap();
        let store = IndexStore::open(data.path()).unwrap();
        let status = store.rebuild(root.path(), IndexLimits::default()).unwrap();
        assert_eq!(status.status, "fresh");

        match select_candidates(&store, root.path(), "needle", 20_000) {
            CandidateSelection::Ready(files) => {
                assert_eq!(files.len(), 1);
                assert_eq!(files[0].file_name().unwrap(), "hit.txt");
            }
            CandidateSelection::Fallback => panic!("fresh index must serve"),
        }
        // A literal that is not present yields an empty (not fallback) set.
        match select_candidates(&store, root.path(), "absent", 20_000) {
            CandidateSelection::Ready(files) => assert!(files.is_empty()),
            CandidateSelection::Fallback => panic!("empty match set is still served"),
        }
    }

    #[test]
    fn content_filtered_visible_files_stay_candidates() {
        let data = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("hit.txt"), "the literal needle is here\n").unwrap();
        fs::write(root.path().join("miss.txt"), "nothing to see\n").unwrap();
        // Never ingested: binary extension, and text past the size cap. Both
        // are still visible to Grep, so both must survive as candidates —
        // otherwise a hit inside them would be reported as no hit at all.
        fs::write(root.path().join("image.png"), [0_u8, 1, 2, 3]).unwrap();
        fs::write(
            root.path().join("big.txt"),
            "b".repeat(crate::index::MAX_FILE_BYTES as usize + 1),
        )
        .unwrap();
        let store = IndexStore::open(data.path()).unwrap();
        let status = store.rebuild(root.path(), IndexLimits::default()).unwrap();
        assert_eq!(status.status, "fresh");
        assert_eq!(status.file_count, 2, "only hit.txt/miss.txt are ingested");

        match select_candidates(&store, root.path(), "needle", 20_000) {
            CandidateSelection::Ready(files) => {
                let mut names: Vec<String> = files
                    .iter()
                    .map(|path| path.file_name().unwrap().to_string_lossy().into_owned())
                    .collect();
                names.sort();
                // FTS hit + both unindexed files. `miss.txt` is ingested and
                // does not match, so narrowing still happens.
                assert_eq!(names, vec!["big.txt", "hit.txt", "image.png"]);
            }
            CandidateSelection::Fallback => panic!("fresh index must serve"),
        }
    }

    #[test]
    fn merged_candidates_keep_the_global_newest_first_order() {
        let data = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        // Written first, so it is the older file once both exist.
        fs::write(
            root.path().join("old_hit.txt"),
            "the literal needle is here\n",
        )
        .unwrap();
        let store = IndexStore::open(data.path()).unwrap();
        store.rebuild(root.path(), IndexLimits::default()).unwrap();
        // Created after that build: newer than the indexed hit, and never
        // ingested because its size is past the cap. A second crawl records
        // its fresh mtime in the visible set — the same state a same-path
        // auto refresh leaves the store in — and the fallback walk would
        // read this file first.
        std::thread::sleep(std::time::Duration::from_millis(1100));
        let big = format!(
            "{}needle\n",
            "x".repeat(crate::index::MAX_FILE_BYTES as usize)
        );
        fs::write(root.path().join("new_big.txt"), big).unwrap();
        store.rebuild(root.path(), IndexLimits::default()).unwrap();

        match select_candidates(&store, root.path(), "needle", 20_000) {
            CandidateSelection::Ready(files) => {
                let names: Vec<String> = files
                    .iter()
                    .map(|path| path.file_name().unwrap().to_string_lossy().into_owned())
                    .collect();
                assert_eq!(names, vec!["new_big.txt", "old_hit.txt"]);
            }
            CandidateSelection::Fallback => panic!("fresh index must serve"),
        }
    }

    #[test]
    fn unknown_or_unindexed_root_falls_back() {
        let data = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("a.txt"), "needle\n").unwrap();
        let store = IndexStore::open(data.path()).unwrap();
        // No rebuild yet: the root is unknown, so nothing may be served.
        assert!(matches!(
            select_candidates(&store, root.path(), "needle", 20_000),
            CandidateSelection::Fallback
        ));
    }

    #[test]
    fn heavy_drift_falls_back_and_vanished_candidate_falls_back() {
        let data = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("a.txt"), "needle one\n").unwrap();
        fs::write(root.path().join("b.txt"), "needle two\n").unwrap();
        let store = IndexStore::open(data.path()).unwrap();
        store.rebuild(root.path(), IndexLimits::default()).unwrap();

        // Touch both files so 100% of candidates drift past the threshold.
        std::thread::sleep(std::time::Duration::from_millis(1100));
        fs::write(root.path().join("a.txt"), "needle one changed\n").unwrap();
        fs::write(root.path().join("b.txt"), "needle two changed\n").unwrap();
        assert!(matches!(
            select_candidates(&store, root.path(), "needle", 20_000),
            CandidateSelection::Fallback
        ));

        // A candidate that disappeared also falls back.
        let data2 = tempfile::tempdir().unwrap();
        let root2 = tempfile::tempdir().unwrap();
        fs::write(root2.path().join("a.txt"), "needle\n").unwrap();
        let store2 = IndexStore::open(data2.path()).unwrap();
        store2
            .rebuild(root2.path(), IndexLimits::default())
            .unwrap();
        fs::remove_file(root2.path().join("a.txt")).unwrap();
        assert!(matches!(
            select_candidates(&store2, root2.path(), "needle", 20_000),
            CandidateSelection::Fallback
        ));
    }

    #[test]
    fn over_cap_candidate_sets_fall_back() {
        let data = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        for index in 0..5 {
            fs::write(
                root.path().join(format!("f{index}.txt")),
                "common substring marker\n",
            )
            .unwrap();
        }
        let store = IndexStore::open(data.path()).unwrap();
        store.rebuild(root.path(), IndexLimits::default()).unwrap();
        assert!(matches!(
            select_candidates(&store, root.path(), "marker", 3),
            CandidateSelection::Fallback
        ));
    }

    #[test]
    fn metrics_record_served_and_fallback_outcomes() {
        let data = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("hit.txt"), "the literal needle is here\n").unwrap();
        fs::write(root.path().join("miss.txt"), "nothing to see\n").unwrap();
        let store = IndexStore::open(data.path()).unwrap();
        store.rebuild(root.path(), IndexLimits::default()).unwrap();

        // Served: one candidate out of two visible files.
        assert!(matches!(
            select_candidates(&store, root.path(), "needle", 20_000),
            CandidateSelection::Ready(_)
        ));
        // State gate: an unindexed root falls back.
        let other = tempfile::tempdir().unwrap();
        assert!(matches!(
            select_candidates(&store, other.path(), "needle", 20_000),
            CandidateSelection::Fallback
        ));
        // Too wide: the cap is smaller than the candidate set.
        assert!(matches!(
            select_candidates(&store, root.path(), "needle", 0),
            CandidateSelection::Fallback
        ));

        let snapshot = store.metrics().snapshot();
        assert_eq!(snapshot.fast_path_served, 1);
        assert_eq!(snapshot.fallback_count, 2);
        assert_eq!(snapshot.fallback_state_gate, 1);
        assert_eq!(snapshot.fallback_too_wide, 1);
        assert!((snapshot.candidate_ratio_avg - 0.5).abs() < 1e-9);
    }
}
