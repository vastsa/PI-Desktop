//! Recoverable diagnostics for tool paths that look like a clean path plus
//! trailing conversational junk (issue #2552).
//!
//! These checks run before path resolution so the model can retry with the
//! intended path instead of an opaque I/O error. They must not leak whether a
//! sensitive or out-of-scope file exists, and they must not treat a legitimate
//! missing filename as malformed.
use super::ignore_rules;
use super::write_scope::BoundWriteScope;
use crate::workspace::simple_canonicalize;
use std::path::Path;

/// Reject a Read/Edit path that looks like a real file plus trailing junk.
///
/// Write (`creation`) is left alone: a path that does not exist is the normal
/// shape of a create call, including names with surrounding whitespace.
///
/// A literal path that already names an existing, allowed file is never
/// rejected — even when the name has leading or trailing spaces. Surrounding
/// whitespace is only treated as recoverable junk when the trimmed form points
/// at an allowed file and the literal path does not.
///
/// Prefix cuts at whitespace or `:` (except a Windows drive-letter colon) are
/// only used when the remainder looks like junk (`imma?`, `:{`), not like a
/// missing filename (`foo bar.ts`).
pub(crate) fn malformed_tool_path(
    root: &Path,
    path: &str,
    creation: bool,
) -> Option<(String, String)> {
    malformed_tool_path_in_scope(root, path, creation, None)
}

pub(crate) fn malformed_tool_path_in_scope(
    root: &Path,
    path: &str,
    creation: bool,
    scope: Option<&BoundWriteScope>,
) -> Option<(String, String)> {
    if creation {
        return None;
    }
    // A literal path — including one with leading/trailing spaces — is legal
    // whenever it names something that actually exists and is allowed.
    if hint_target_exists(root, path, scope) {
        return None;
    }
    let trimmed = path.trim();
    if trimmed != path {
        // Surrounding whitespace is recoverable junk only when the trimmed
        // path points at something real and allowed; otherwise the literal
        // path is just a (missing) file with whitespace in its name.
        if trimmed.is_empty() || !hint_target_exists(root, trimmed, scope) {
            return None;
        }
        return Some((
            "INVALID_ARGUMENT".into(),
            format!(
                "path has surrounding whitespace; re-issue the tool call with the bare path, e.g. {}",
                serde_json::to_string(trimmed).unwrap_or_default()
            ),
        ));
    }
    if !has_junk_boundary(path) {
        return None;
    }
    for head in junk_prefixes(path) {
        let suffix = &path[head.len()..];
        if head.is_empty() || !is_junk_suffix(suffix) || !hint_target_exists(root, head, scope) {
            continue;
        }
        return Some((
            "INVALID_ARGUMENT".into(),
            format!(
                "path looks malformed: {path:?} does not exist but {head:?} does; re-issue the tool call with only the file path"
            ),
        ));
    }
    None
}

/// Existence probe for suggested-path heuristics. Canonicalizes and requires
/// the result to stay inside `root`, so `..` or symlink escapes never leak
/// information from outside the workspace and never suggest a denied path.
/// Sensitive and out-of-scope files are treated as absent, so a hint cannot
/// reveal that they exist.
fn hint_target_exists(root: &Path, rel: &str, scope: Option<&BoundWriteScope>) -> bool {
    let Ok(root_canonical) = simple_canonicalize(root) else {
        return false;
    };
    let candidate = root.join(rel);
    let Ok(canonical) = simple_canonicalize(&candidate) else {
        return false;
    };
    if !canonical.starts_with(&root_canonical) || !canonical.exists() {
        return false;
    }
    if ignore_rules::is_sensitive_path(&canonical) {
        return false;
    }
    scope.is_none_or(|scope| scope.contains_resolved(&canonical))
}

/// Whether `path` has a cut point that might be trailing junk, ignoring the
/// colon in a Windows drive letter (`C:`), which is not junk.
fn has_junk_boundary(path: &str) -> bool {
    path.char_indices()
        .any(|(i, c)| is_junk_boundary(path, i, c))
}

/// Prefixes of `path` cut at each whitespace or `:` character, except a
/// Windows drive-letter colon. These are the candidate "clean paths" a model
/// may have appended junk to.
fn junk_prefixes(path: &str) -> impl Iterator<Item = &str> {
    path.char_indices()
        .filter_map(move |(i, c)| is_junk_boundary(path, i, c).then_some(&path[..i]))
}

fn is_junk_boundary(path: &str, index: usize, c: char) -> bool {
    c.is_whitespace() || (c == ':' && !is_drive_letter_colon(path, index))
}

/// `C:` at the start of a path is a Windows drive letter, not a junk suffix
/// (`Wizard.tsx:{`).
fn is_drive_letter_colon(path: &str, colon_index: usize) -> bool {
    colon_index == 1 && path.as_bytes().first().is_some_and(u8::is_ascii_alphabetic)
}

/// The text after a prefix cut looks like trailing conversational junk
/// (`imma?`, `:{`), not like the rest of a missing filename (` bar.ts`).
fn is_junk_suffix(suffix: &str) -> bool {
    let rest = suffix.trim();
    if rest.is_empty() {
        return false;
    }
    if rest
        .chars()
        .any(|c| matches!(c, '?' | '{' | '}' | '<' | '>' | '|'))
    {
        return true;
    }
    !rest.chars().any(char::is_alphanumeric)
}

#[cfg(test)]
mod tests {
    use super::super::execute_tool;
    use super::{has_junk_boundary, is_junk_suffix, junk_prefixes, malformed_tool_path};

    #[test]
    fn drive_letter_colons_are_not_junk_boundaries() {
        assert!(!has_junk_boundary(r"C:\ext\a.txt"));
        assert!(!has_junk_boundary("C:/ext/a.txt"));
        assert!(!has_junk_boundary("c:foo"));
        assert!(has_junk_boundary(r"C:\ext\a.txt imma?"));
        assert!(has_junk_boundary("src/pages/Wizard.tsx:{"));
        assert_eq!(
            junk_prefixes(r"C:\ext\a.txt imma?").collect::<Vec<_>>(),
            vec![r"C:\ext\a.txt"]
        );
        assert_eq!(
            junk_prefixes("src/pages/Wizard.tsx:{").collect::<Vec<_>>(),
            vec!["src/pages/Wizard.tsx"]
        );
    }

    #[test]
    fn suffix_after_a_space_is_junk_only_when_it_looks_conversational() {
        assert!(is_junk_suffix(" imma?"));
        assert!(is_junk_suffix(":{"));
        assert!(is_junk_suffix(" here?"));
        assert!(!is_junk_suffix(" bar.ts"));
        assert!(!is_junk_suffix(" draft.md"));
    }

    #[tokio::test]
    async fn malformed_tool_paths_get_a_recoverable_diagnostic() {
        let ws = tempfile::tempdir().unwrap();
        std::fs::write(ws.path().join("Wizard.tsx"), "hi\n").unwrap();

        // Trailing conversational junk after the path (#2552): the tool names
        // the intended file instead of failing with an opaque IO error.
        let result = execute_tool(
            Some(ws.path()),
            None,
            "Edit",
            &serde_json::json!({
                "path": "Wizard.tsx imma?",
                "tag": "abcd",
                "ops": "..."
            }),
            5_000,
        )
        .await;
        assert!(!result.ok);
        assert_eq!(result.error_code.as_deref(), Some("INVALID_ARGUMENT"));
        let msg = result.content["error"].as_str().unwrap_or_default();
        assert!(
            msg.contains("\"Wizard.tsx\""),
            "diagnostic should point at the intended path: {msg}"
        );

        // Surrounding whitespace is rejected before any resolution.
        let result = execute_tool(
            Some(ws.path()),
            None,
            "Read",
            &serde_json::json!({ "path": " Wizard.tsx " }),
            5_000,
        )
        .await;
        assert!(!result.ok);
        assert_eq!(result.error_code.as_deref(), Some("INVALID_ARGUMENT"));

        // A legitimate path with internal whitespace still works.
        let spaced = ws.path().join("my notes.txt");
        std::fs::write(&spaced, "body\n").unwrap();
        let result = execute_tool(
            Some(ws.path()),
            None,
            "Read",
            &serde_json::json!({ "path": "my notes.txt" }),
            5_000,
        )
        .await;
        assert!(result.ok, "spaced path must be accepted: {result:?}");
    }

    #[tokio::test]
    async fn spaced_filenames_and_punctuation_suffixes_stay_correct() {
        let ws = tempfile::tempdir().unwrap();
        std::fs::create_dir(ws.path().join("notes")).unwrap();

        // Write creating a new file next to a same-named directory must keep
        // working: a non-existent path is the normal shape of a creation call.
        let result = execute_tool(
            Some(ws.path()),
            None,
            "Write",
            &serde_json::json!({ "path": "notes draft.md", "content": "draft\n" }),
            5_000,
        )
        .await;
        assert!(
            result.ok,
            "Write to a spaced filename must not be rejected: {result:?}"
        );
        assert!(ws.path().join("notes draft.md").is_file());

        // Reading a file whose literal name starts with a space still works.
        std::fs::write(ws.path().join(" leading space.md"), "body\n").unwrap();
        let result = execute_tool(
            Some(ws.path()),
            None,
            "Read",
            &serde_json::json!({ "path": " leading space.md" }),
            5_000,
        )
        .await;
        assert!(
            result.ok,
            "literal leading-space filename must read fine: {result:?}"
        );

        // Punctuation-only junk suffix (#2552): the full path does not exist
        // but the prefix before the junk does, so it gets the diagnostic
        // instead of an opaque IO error.
        std::fs::create_dir_all(ws.path().join("src/pages")).unwrap();
        std::fs::write(ws.path().join("src/pages/Wizard.tsx"), "hi\n").unwrap();
        let result = execute_tool(
            Some(ws.path()),
            None,
            "Read",
            &serde_json::json!({ "path": "src/pages/Wizard.tsx:{" }),
            5_000,
        )
        .await;
        assert!(!result.ok);
        assert_eq!(result.error_code.as_deref(), Some("INVALID_ARGUMENT"));
        let msg = result.content["error"].as_str().unwrap_or_default();
        assert!(
            msg.contains("\"src/pages/Wizard.tsx\""),
            "diagnostic should name the intended path: {msg}"
        );

        // Malformed Edit tags from #2552 stay blocked, now with the received
        // tag echoed for diagnosability.
        for tag in ["9DA2 nope?", "410F:{"] {
            let result = execute_tool(
                Some(ws.path()),
                None,
                "Edit",
                &serde_json::json!({
                    "path": "src/pages/Wizard.tsx",
                    "tag": tag,
                    "ops": "..."
                }),
                5_000,
            )
            .await;
            assert!(!result.ok);
            assert_eq!(
                result.error_code.as_deref(),
                Some("EDIT_TAG_REQUIRED"),
                "malformed tag {tag:?} must not pass"
            );
            let msg = result.content["error"].as_str().unwrap_or_default();
            assert!(
                msg.contains(tag),
                "diagnostic should echo the malformed tag: {msg}"
            );
        }
    }

    #[tokio::test]
    async fn hint_checks_do_not_leak_or_misdiagnose_allowed_paths() {
        let ws = tempfile::tempdir().unwrap();
        std::fs::write(ws.path().join("Wizard.tsx"), "hi\n").unwrap();
        std::fs::write(ws.path().join(".env"), "SECRET=1\n").unwrap();
        std::fs::write(ws.path().join("foo"), "x\n").unwrap();
        std::fs::write(ws.path().join("C"), "drive-name\n").unwrap();

        // A sensitive file's existence must not be revealed by the whitespace
        // hint; the call should not say that ".env" exists.
        let result = execute_tool(
            Some(ws.path()),
            None,
            "Read",
            &serde_json::json!({ "path": " .env " }),
            5_000,
        )
        .await;
        assert!(!result.ok);
        assert_ne!(result.error_code.as_deref(), Some("INVALID_ARGUMENT"));
        let msg = result.content["error"].as_str().unwrap_or_default();
        assert!(
            !msg.to_ascii_lowercase().contains("surrounding whitespace"),
            "must not hint that the sensitive path exists: {msg}"
        );

        // A missing spaced filename is FILE_NOT_FOUND, even when a prefix
        // entry exists.
        let result = execute_tool(
            Some(ws.path()),
            None,
            "Read",
            &serde_json::json!({ "path": "foo bar.ts" }),
            5_000,
        )
        .await;
        assert!(!result.ok);
        assert_eq!(result.error_code.as_deref(), Some("FILE_NOT_FOUND"));

        // Write of a leading-space name is a create, even when the trimmed
        // name already exists.
        let result = execute_tool(
            Some(ws.path()),
            None,
            "Write",
            &serde_json::json!({ "path": " Wizard.tsx", "content": "new\n" }),
            5_000,
        )
        .await;
        assert!(
            result.ok,
            "Write to a leading-space filename must succeed: {result:?}"
        );
        assert_eq!(
            std::fs::read_to_string(ws.path().join(" Wizard.tsx")).unwrap(),
            "new\n"
        );
        assert_eq!(
            std::fs::read_to_string(ws.path().join("Wizard.tsx")).unwrap(),
            "hi\n"
        );

        // A Windows absolute path must not treat the drive letter as a junk
        // prefix, even when a workspace entry is named `C`.
        assert_eq!(malformed_tool_path(ws.path(), r"C:\ext\a.txt", false), None);
        let result = execute_tool(
            Some(ws.path()),
            None,
            "Read",
            &serde_json::json!({ "path": r"C:\ext\a.txt" }),
            5_000,
        )
        .await;
        assert!(!result.ok);
        assert_ne!(
            result.error_code.as_deref(),
            Some("INVALID_ARGUMENT"),
            "drive-letter path must not be reported as malformed: {result:?}"
        );
    }
}
