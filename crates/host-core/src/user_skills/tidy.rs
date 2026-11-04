//! Skill-library consolidation: the pass that keeps a library readable over months.
//!
//! A skill library grows by accretion. Every session that taught something adds a
//! reference; nothing ever removes one. After a few hundred turns the library is
//! mostly noise — the same lesson written twice under two topics, empty files left
//! where a write was started and abandoned, documents that no longer fit in a
//! prompt. Nothing in the write path can fix that: it only ever adds.
//!
//! This pass only deletes what is provably redundant, and **reports** everything
//! it is not sure about:
//!
//! * an empty or whitespace-only reference is deleted — it carries nothing;
//! * byte-identical twins inside one skill collapse to the one the document
//!   links, or the first by name when the document links neither;
//! * a reference the document does not mention is **reported, never deleted**:
//!   "unlinked" is a hint about the document, not a verdict about the file;
//! * an oversized document is **reported, never truncated**: shortening someone
//!   else's prose is not a tidy operation.
//!
//! The pass is idempotent — a second run over the same library removes nothing —
//! and never touches a `SKILL.md`. That is what makes it safe to run unattended
//! after a review pass instead of behind a button.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use anyhow::{Context, Result};
use serde::Serialize;

/// A document longer than this no longer reads as an umbrella; detail belongs in
/// a reference. Reported only — see the module notes.
pub const MAX_DOCUMENT_CHARS: usize = 8_000;

/// What the pass is allowed to delete. Defaults are the conservative pair: an
/// empty file and an exact duplicate. Anything that requires judging content is
/// off, so an unattended run cannot lose something a person wanted.
#[derive(Debug, Clone, Serialize)]
pub struct SkillTidyPolicy {
    pub drop_empty_references: bool,
    pub drop_duplicate_references: bool,
    pub max_document_chars: usize,
    pub dry_run: bool,
}

impl Default for SkillTidyPolicy {
    fn default() -> Self {
        Self {
            drop_empty_references: true,
            drop_duplicate_references: true,
            max_document_chars: MAX_DOCUMENT_CHARS,
            dry_run: false,
        }
    }
}

/// One skill whose document is longer than the policy allows.
#[derive(Debug, Clone, Serialize)]
pub struct OversizedDocument {
    pub id: String,
    pub chars: usize,
}

/// What the pass did, or would do under `dry_run`.
#[derive(Debug, Clone, Default, Serialize)]
pub struct SkillTidyReport {
    pub skills_scanned: usize,
    pub references_scanned: usize,
    /// Relative `id/references/name.md` paths, sorted.
    pub references_removed: Vec<String>,
    pub bytes_freed: u64,
    /// References the document does not mention. Never removed by this pass.
    pub unlinked: Vec<String>,
    pub oversized: Vec<OversizedDocument>,
    pub dry_run: bool,
}

/// Tidy the library rooted at `root` (the directory holding `<id>/SKILL.md`).
pub fn tidy_library(root: &Path, policy: &SkillTidyPolicy) -> Result<SkillTidyReport> {
    let mut report = SkillTidyReport {
        dry_run: policy.dry_run,
        ..SkillTidyReport::default()
    };
    if !root.is_dir() {
        return Ok(report);
    }

    let mut skills: Vec<_> = fs::read_dir(root)
        .with_context(|| format!("read {}", root.display()))?
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.path().is_dir())
        .collect();
    skills.sort_by_key(|entry| entry.file_name());

    for skill in skills {
        let id = skill.file_name().to_string_lossy().to_string();
        let document = skill.path().join("SKILL.md");
        if !document.is_file() {
            continue;
        }
        report.skills_scanned += 1;

        let body = fs::read_to_string(&document)
            .with_context(|| format!("read {}", document.display()))?;
        let chars = body.chars().count();
        if chars > policy.max_document_chars {
            report.oversized.push(OversizedDocument { id: id.clone(), chars });
        }

        let references_dir = skill.path().join("references");
        if !references_dir.is_dir() {
            continue;
        }

        let mut references: Vec<_> = fs::read_dir(&references_dir)
            .with_context(|| format!("read {}", references_dir.display()))?
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.path())
            .filter(|path| path.is_file())
            .filter(|path| {
                path.extension()
                    .and_then(|extension| extension.to_str())
                    .is_some_and(|extension| extension.eq_ignore_ascii_case("md"))
            })
            .collect();
        references.sort();

        // Read every reference once: both the empty check and the duplicate
        // grouping need the bytes, and a library can hold a few thousand files.
        let mut contents: BTreeMap<String, String> = BTreeMap::new();
        for path in &references {
            report.references_scanned += 1;
            let relative = relative_reference(&id, path);
            match fs::read_to_string(path) {
                Ok(text) => {
                    contents.insert(relative, text);
                }
                Err(error) => {
                    // A reference we cannot read is not a reference we may delete.
                    eprintln!("[skills.tidy] skip unreadable {}: {error}", path.display());
                }
            }
        }

        let mut doomed: BTreeMap<String, &'static str> = BTreeMap::new();

        if policy.drop_empty_references {
            for (relative, text) in &contents {
                if text.trim().is_empty() {
                    doomed.insert(relative.clone(), "empty");
                }
            }
        }

        if policy.drop_duplicate_references {
            for duplicate in duplicate_twins(&contents, &body) {
                doomed.entry(duplicate).or_insert("duplicate");
            }
        }

        for (relative, _) in &contents {
            if doomed.contains_key(relative) {
                continue;
            }
            if !mentions_reference(&body, relative) {
                report.unlinked.push(relative.clone());
            }
        }

        for (relative, reason) in &doomed {
            let path = root.join(relative);
            let bytes = contents.get(relative).map(|text| text.len() as u64).unwrap_or(0);
            if !policy.dry_run {
                match fs::remove_file(&path) {
                    Ok(()) => {}
                    Err(error) => {
                        eprintln!(
                            "[skills.tidy] could not remove {} ({reason}): {error}",
                            path.display()
                        );
                        continue;
                    }
                }
            }
            report.references_removed.push(relative.clone());
            report.bytes_freed += bytes;
        }

        if !policy.dry_run && references_dir.is_dir() && is_empty_dir(&references_dir) {
            let _ = fs::remove_dir(&references_dir);
        }
    }

    report.references_removed.sort();
    report.unlinked.sort();
    report.oversized.sort_by(|left, right| right.chars.cmp(&left.chars));
    Ok(report)
}

/// `id/references/name.md` — the path as a caller would name it, so a report
/// line can be pasted straight into `skills.removeFile`.
fn relative_reference(id: &str, path: &Path) -> String {
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_default();
    format!("{id}/references/{name}")
}

/// Byte-identical references inside one skill, minus the one worth keeping.
///
/// The keeper is the file the document actually names: a document that links
/// `references/pitfalls.md` should keep that name even if `references/notes.md`
/// happens to sort first. With no link on either side the choice is arbitrary,
/// so it is deterministic instead — first by name.
fn duplicate_twins(contents: &BTreeMap<String, String>, body: &str) -> Vec<String> {
    let mut groups: BTreeMap<&str, Vec<&String>> = BTreeMap::new();
    for (relative, text) in contents {
        if text.trim().is_empty() {
            continue; // empty files are the other rule's business
        }
        groups.entry(text.as_str()).or_default().push(relative);
    }

    let mut doomed = Vec::new();
    for members in groups.values() {
        if members.len() < 2 {
            continue;
        }
        let keeper = members
            .iter()
            .find(|relative| mentions_reference(body, relative))
            .copied()
            .unwrap_or(members[0]);
        doomed.extend(
            members
                .iter()
                .filter(|relative| **relative != keeper)
                .map(|relative| (*relative).clone()),
        );
    }
    doomed
}

/// Does the document name this reference, by path or by topic?
fn mentions_reference(body: &str, relative: &str) -> bool {
    let haystack = body.to_lowercase();
    if haystack.contains(&relative.to_lowercase()) {
        return true;
    }
    let stem = relative
        .rsplit('/')
        .next()
        .unwrap_or(relative)
        .trim_end_matches(".md")
        .to_lowercase();
    !stem.is_empty() && haystack.contains(&stem)
}

fn is_empty_dir(path: &Path) -> bool {
    fs::read_dir(path)
        .map(|mut entries| entries.next().is_none())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn library() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().join("skills");
        fs::create_dir_all(&root).expect("root");
        (dir, root)
    }

    fn skill(root: &Path, id: &str, body: &str) -> PathBuf {
        let directory = root.join(id);
        fs::create_dir_all(&directory).expect("skill dir");
        fs::write(directory.join("SKILL.md"), body).expect("document");
        directory
    }

    fn reference(directory: &Path, name: &str, content: &str) {
        fs::create_dir_all(directory.join("references")).expect("references");
        fs::write(directory.join("references").join(name), content).expect("reference");
    }

    #[test]
    fn removes_an_empty_reference_and_keeps_a_real_one() {
        let (_tmp, root) = library();
        let dir = skill(&root, "review", "# Review\nsee pitfalls\n");
        reference(&dir, "pitfalls.md", "a real lesson\n");
        reference(&dir, "scratch.md", "   \n\n");

        let report = tidy_library(&root, &SkillTidyPolicy::default()).expect("tidy");

        assert_eq!(report.references_removed, vec!["review/references/scratch.md"]);
        assert!(dir.join("references/pitfalls.md").is_file());
        assert!(!dir.join("references/scratch.md").exists());
    }

    #[test]
    fn collapses_identical_twins_and_keeps_the_one_the_document_names() {
        let (_tmp, root) = library();
        // `notes.md` sorts before `pitfalls.md`, so name order alone would keep
        // the wrong twin: the document is what decides.
        let dir = skill(&root, "review", "# Review\nsee references/pitfalls.md\n");
        reference(&dir, "notes.md", "same lesson\n");
        reference(&dir, "pitfalls.md", "same lesson\n");

        let report = tidy_library(&root, &SkillTidyPolicy::default()).expect("tidy");

        assert_eq!(report.references_removed, vec!["review/references/notes.md"]);
        assert!(dir.join("references/pitfalls.md").is_file());
        assert!(!dir.join("references/notes.md").exists());
        assert_eq!(report.bytes_freed, "same lesson\n".len() as u64);
    }

    #[test]
    fn reports_an_unlinked_reference_without_deleting_it() {
        let (_tmp, root) = library();
        let dir = skill(&root, "review", "# Review\nnothing linked here\n");
        reference(&dir, "orphan.md", "still useful, just not linked\n");

        let report = tidy_library(&root, &SkillTidyPolicy::default()).expect("tidy");

        assert_eq!(report.unlinked, vec!["review/references/orphan.md"]);
        assert!(dir.join("references/orphan.md").is_file());
        assert!(report.references_removed.is_empty());
    }

    #[test]
    fn reports_an_oversized_document_without_touching_it() {
        let (_tmp, root) = library();
        let body = format!("# Big\n{}\n", "x".repeat(200));
        let dir = skill(&root, "big", &body);
        reference(&dir, "topic.md", "linked: big\n"); // mentions "big" via body? no

        let policy = SkillTidyPolicy { max_document_chars: 50, ..Default::default() };
        let report = tidy_library(&root, &policy).expect("tidy");

        assert_eq!(report.oversized.len(), 1);
        assert_eq!(report.oversized[0].id, "big");
        assert_eq!(
            fs::read_to_string(dir.join("SKILL.md")).expect("document"),
            body,
            "an oversized document is reported, never rewritten"
        );
    }

    #[test]
    fn dry_run_reports_everything_and_removes_nothing() {
        let (_tmp, root) = library();
        let dir = skill(&root, "review", "# Review\nsee pitfalls\n");
        reference(&dir, "pitfalls.md", "lesson\n");
        reference(&dir, "scratch.md", "");

        let policy = SkillTidyPolicy { dry_run: true, ..Default::default() };
        let report = tidy_library(&root, &policy).expect("tidy");

        assert_eq!(report.references_removed, vec!["review/references/scratch.md"]);
        assert!(dir.join("references/scratch.md").is_file(), "dry run keeps the file");
    }

    #[test]
    fn a_second_run_removes_nothing() {
        let (_tmp, root) = library();
        let dir = skill(&root, "review", "# Review\nsee pitfalls\n");
        reference(&dir, "pitfalls.md", "lesson\n");
        reference(&dir, "scratch.md", "");
        reference(&dir, "copy.md", "lesson\n");

        let first = tidy_library(&root, &SkillTidyPolicy::default()).expect("tidy");
        assert_eq!(first.references_removed.len(), 2, "empty plus duplicate");

        let second = tidy_library(&root, &SkillTidyPolicy::default()).expect("tidy");
        assert_eq!(second.references_removed.len(), 0);
        assert_eq!(second.bytes_freed, 0);
        assert!(dir.join("references/pitfalls.md").is_file());
    }

    #[test]
    fn an_empty_library_is_not_an_error() {
        let (_tmp, root) = library();
        let report = tidy_library(&root, &SkillTidyPolicy::default()).expect("tidy");
        assert_eq!(report.skills_scanned, 0);
        assert!(report.references_removed.is_empty());
    }
}
