//! Preserve session-owned inputs without inheriting arbitrary scratch outputs.

use std::fs::{self, OpenOptions};
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use serde_json::Value;

use crate::transcripts::{CompactionRecord, MessageRecord};
use crate::{scratch, visualizations};

#[derive(Clone, Copy)]
enum ForkDirectory {
    Scratch,
    Visualization,
}

/// Roll back copied inputs if transcript/index publication fails.
pub(super) struct ForkFiles {
    destination: PathBuf,
    kind: ForkDirectory,
    committed: bool,
}

impl ForkFiles {
    pub(super) fn commit(mut self) {
        self.committed = true;
    }
}

impl Drop for ForkFiles {
    fn drop(&mut self) {
        if self.committed {
            return;
        }
        match self.kind {
            ForkDirectory::Visualization => visualizations::remove_session_root(&self.destination),
            ForkDirectory::Scratch if self.destination.exists() => {
                if let Err(error) = fs::remove_dir_all(&self.destination) {
                    tracing::warn!(%error, "fork attachment rollback failed");
                }
            }
            ForkDirectory::Scratch => {}
        }
    }
}

// A file name must not match a prefix of another file name. Inline references
// may be quoted, Markdown links, or plain paths in model/context text.
fn reference_end(tail: &str) -> bool {
    tail.chars().next().is_none_or(|c| {
        c.is_whitespace() || matches!(c, '"' | '\'' | '`' | ')' | ']' | '}' | ',' | ';')
    })
}

fn reference_start(prefix: &str) -> bool {
    prefix.chars().next_back().is_none_or(|c| {
        c.is_whitespace() || matches!(c, '@' | '"' | '\'' | '`' | '(' | '[' | '{' | '=' | ':')
    })
}

fn replace_reference(text: &mut String, source: &str, target: &str) -> bool {
    let mut result = String::new();
    let mut start = 0;
    let mut changed = false;
    for (offset, _) in text.match_indices(source) {
        let end = offset + source.len();
        if reference_start(&text[..offset]) && reference_end(&text[end..]) {
            result.push_str(&text[start..offset]);
            result.push_str(target);
            start = end;
            changed = true;
        }
    }
    if changed {
        result.push_str(&text[start..]);
        *text = result;
    }
    changed
}

fn rewrite_value(value: &mut Value, source: &str, target: &str) -> bool {
    match value {
        Value::String(text) => replace_reference(text, source, target),
        Value::Array(values) => {
            let mut changed = false;
            for value in values {
                changed |= rewrite_value(value, source, target);
            }
            changed
        }
        Value::Object(values) => {
            let mut changed = false;
            for value in values.values_mut() {
                changed |= rewrite_value(value, source, target);
            }
            changed
        }
        _ => false,
    }
}

fn rewrite(
    records: &mut [MessageRecord],
    compactions: &mut [CompactionRecord],
    source: &str,
    target: &str,
) -> bool {
    let mut changed = false;
    for record in records {
        changed |= rewrite_value(&mut record.blocks, source, target);
        if let Some(meta) = &mut record.meta {
            changed |= rewrite_value(meta, source, target);
        }
    }
    for record in compactions {
        changed |= replace_reference(&mut record.summary, source, target);
        for value in [&mut record.retained_tail, &mut record.details]
            .into_iter()
            .flatten()
        {
            changed |= rewrite_value(value, source, target);
        }
    }
    changed
}

pub(super) fn preserve(
    data_dir: &Path,
    source_id: &str,
    child_id: &str,
    records: &mut [MessageRecord],
    compactions: &mut [CompactionRecord],
) -> Result<ForkFiles> {
    let source = scratch::session_dir(data_dir, source_id)
        .ok_or_else(|| anyhow!("invalid source session id"))?;
    let destination = scratch::session_dir(data_dir, child_id)
        .ok_or_else(|| anyhow!("invalid child session id"))?;
    if destination.try_exists()? {
        return Err(anyhow!("fork scratch directory already exists"));
    }
    let guard = ForkFiles {
        destination,
        kind: ForkDirectory::Scratch,
        committed: false,
    };
    let pasted = source.join("pasted");
    // Scratch is disposable: historical inputs that have already expired do
    // not prevent branching. Never follow a link out of the owned input tree.
    for directory in [scratch::base_dir(data_dir), source, pasted.clone()] {
        match fs::symlink_metadata(&directory) {
            Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
            Ok(_) => return Err(anyhow!("fork input directory is not a regular directory")),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(guard),
            Err(error) => return Err(error.into()),
        }
    }
    for entry in fs::read_dir(&pasted)? {
        let entry = entry?;
        let path = entry.path();
        let target = guard.destination.join("pasted").join(entry.file_name());
        let source_path = path.to_string_lossy();
        let target_path = target.to_string_lossy();
        let mut referenced = rewrite(records, compactions, &source_path, &target_path);
        if entry.file_type()?.is_file() {
            let canonical = path.canonicalize()?;
            let canonical_path = canonical.to_string_lossy();
            if canonical_path != source_path {
                referenced |= rewrite(records, compactions, &canonical_path, &target_path);
            }
        }
        // Renderer path references may use forward slashes on Windows.
        #[cfg(windows)]
        {
            referenced |= rewrite(
                records,
                compactions,
                &source_path.replace('\\', "/"),
                &target_path.replace('\\', "/"),
            );
        }
        if !referenced {
            continue;
        }
        if !entry.file_type()?.is_file() {
            return Err(anyhow!("referenced fork input is not a regular file"));
        }
        fs::create_dir_all(guard.destination.join("pasted"))?;
        copy_regular_file(&path, &target)?;
    }
    Ok(guard)
}

/// Copy one regular file without following a symlink at the source and
/// without overwriting anything at the target.
fn copy_regular_file(path: &Path, target: &Path) -> Result<()> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let mut input = options.open(path).context("open fork input")?;
    let metadata = input.metadata()?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(anyhow!("referenced fork input is not a regular file"));
    }
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(target)
        .context("create fork input copy")?;
    std::io::copy(&mut input, &mut output).context("copy fork input")?;
    output.sync_all()?;
    Ok(())
}

// Only completed assistant text and model-context text can hold cards. Do
// not rewrite raw shell commands, tool results, thinking, or code examples.
fn rewrite_visualization_value(
    value: &mut Value,
    source_id: &str,
    file: &str,
    target: &str,
) -> bool {
    match value {
        Value::String(text) => visualizations::references::rewrite(text, source_id, file, target),
        Value::Array(values) => {
            let mut changed = false;
            for value in values {
                changed |= rewrite_visualization_value(value, source_id, file, target);
            }
            changed
        }
        Value::Object(values) => {
            if values
                .get("role")
                .and_then(Value::as_str)
                .is_some_and(|role| role != "assistant")
                || values
                    .get("type")
                    .and_then(Value::as_str)
                    .is_some_and(|kind| kind != "text")
            {
                return false;
            }
            let mut changed = false;
            for key in [
                "text",
                "content",
                "blocks",
                "summary",
                "messages",
                "retainedTail",
                "details",
            ] {
                if let Some(value) = values.get_mut(key) {
                    changed |= rewrite_visualization_value(value, source_id, file, target);
                }
            }
            changed
        }
        _ => false,
    }
}

fn rewrite_visualizations(
    records: &mut [MessageRecord],
    compactions: &mut [CompactionRecord],
    source_id: &str,
    file: &str,
    target: &str,
) -> bool {
    let mut changed = false;
    for record in records
        .iter_mut()
        .filter(|record| record.role == "assistant" && record.tool_name.is_none())
    {
        changed |= rewrite_visualization_value(&mut record.blocks, source_id, file, target);
    }
    for record in compactions {
        changed |=
            visualizations::references::rewrite(&mut record.summary, source_id, file, target);
        for value in [&mut record.retained_tail, &mut record.details]
            .into_iter()
            .flatten()
        {
            changed |= rewrite_visualization_value(value, source_id, file, target);
        }
    }
    changed
}

/// Give a fork its own copies of the visualization fragments its transcript
/// references (D671), so deleting the source session cannot break the
/// child's cards. Unreferenced fragments stay behind.
pub(super) fn preserve_visualizations(
    data_dir: &Path,
    source_id: &str,
    child_id: &str,
    records: &mut [MessageRecord],
    compactions: &mut [CompactionRecord],
) -> Result<ForkFiles> {
    let source = visualizations::session_dir(data_dir, source_id)
        .ok_or_else(|| anyhow!("invalid source session id"))?;
    let destination = visualizations::session_dir(data_dir, child_id)
        .ok_or_else(|| anyhow!("invalid child session id"))?;
    // A missing or redirected source remains unavailable, like an expired
    // scratch input. An empty guard owns nothing and must not clean up paths.
    let source = match visualizations::validate_session_root(&source) {
        Ok(source) => source,
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::PermissionDenied
            ) =>
        {
            tracing::warn!(%error, "fork visualization source unavailable");
            return Ok(ForkFiles {
                destination,
                kind: ForkDirectory::Visualization,
                committed: true,
            });
        }
        Err(error) => return Err(error.into()),
    };
    let canonical_destination = visualizations::validate_session_root(&destination)?;
    if canonical_destination.try_exists()? {
        return Err(anyhow!("fork visualization directory already exists"));
    }
    let guard = ForkFiles {
        destination: canonical_destination,
        kind: ForkDirectory::Visualization,
        committed: false,
    };
    visualizations::validate_session_root(&source)?;
    let entries = match fs::read_dir(&source) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(guard),
        Err(error) => return Err(error.into()),
    };
    for entry in entries {
        let entry = entry?;
        let path = entry.path();
        if !visualizations::is_regular_fragment_file(&path)? {
            continue;
        }
        let name = entry.file_name();
        let Some(file_name) = name.to_str() else {
            continue;
        };
        let target_reference = destination.join(&name);
        if !rewrite_visualizations(
            records,
            compactions,
            source_id,
            file_name,
            &target_reference.to_string_lossy(),
        ) {
            continue;
        }
        // Use the canonical data-parent spelling chosen at the start, but
        // advertise the child's original data-directory spelling.
        visualizations::ensure_session_root(&guard.destination)?;
        visualizations::validate_session_root(&source)?;
        copy_regular_file(&path, &guard.destination.join(&name))?;
    }
    Ok(guard)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn message(blocks: Value) -> MessageRecord {
        MessageRecord {
            id: "message".into(),
            role: "user".into(),
            tool_name: None,
            is_error: false,
            blocks,
            meta: None,
            created_at: "2026-09-21T00:00:00Z".into(),
        }
    }

    #[test]
    fn copies_structured_and_compacted_inputs_and_rolls_back_until_committed() {
        let dir = tempfile::tempdir().unwrap();
        let pasted = dir.path().join("scratch").join("source").join("pasted");
        fs::create_dir_all(&pasted).unwrap();
        let file = pasted.join("input.txt");
        fs::write(&file, "bytes").unwrap();
        let canonical = file.canonicalize().unwrap();
        let mut records = vec![message(json!([{"type":"attachment", "ref": file}]))];
        let mut compactions: Vec<CompactionRecord> = vec![serde_json::from_value(json!({
            "id":"checkpoint", "summary":format!("Read @\"{}\"", canonical.display()),
            "throughMessageId":"message", "tokensBefore":10, "createdAt":"now",
            "retainedTail":[{"blocks":[{"ref": file}]}], "details":{"file": file}
        }))
        .unwrap()];
        let guard = preserve(
            dir.path(),
            "source",
            "child",
            &mut records,
            &mut compactions,
        )
        .unwrap();
        let target = dir
            .path()
            .join("scratch")
            .join("child")
            .join("pasted")
            .join("input.txt");
        assert_eq!(fs::read_to_string(&target).unwrap(), "bytes");
        assert_eq!(
            records[0].blocks[0]["ref"],
            target.to_string_lossy().as_ref()
        );
        assert_eq!(
            compactions[0].summary,
            format!("Read @\"{}\"", target.display())
        );
        assert_eq!(
            compactions[0].retained_tail.as_ref().unwrap()[0]["blocks"][0]["ref"],
            target.to_string_lossy().as_ref()
        );
        assert_eq!(
            compactions[0].details.as_ref().unwrap()["file"],
            target.to_string_lossy().as_ref()
        );
        drop(guard);
        assert!(!dir.path().join("scratch/child").exists());
        assert_eq!(fs::read_to_string(file).unwrap(), "bytes");
    }

    #[test]
    fn expired_inputs_do_not_prevent_forking() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("scratch/source/pasted/missing.txt");
        let mut records = vec![message(json!([{"ref":missing}]))];
        preserve(dir.path(), "source", "child", &mut records, &mut [])
            .unwrap()
            .commit();
        assert_eq!(
            records[0].blocks[0]["ref"],
            missing.to_string_lossy().as_ref()
        );
        assert!(!dir.path().join("scratch/child").exists());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_referenced_symlinks_and_symlinked_input_directories() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let pasted = dir.path().join("scratch/source/pasted");
        fs::create_dir_all(&pasted).unwrap();
        let external = dir.path().join("private.txt");
        fs::write(&external, "private").unwrap();
        let link = pasted.join("link.txt");
        symlink(&external, &link).unwrap();
        let mut records = vec![message(json!([{"ref":link}]))];
        assert!(preserve(dir.path(), "source", "child", &mut records, &mut []).is_err());
        assert!(!dir.path().join("scratch/child").exists());
        fs::remove_file(link).unwrap();
        fs::remove_dir(&pasted).unwrap();
        symlink(dir.path(), &pasted).unwrap();
        assert!(preserve(dir.path(), "source", "child", &mut [], &mut []).is_err());
    }

    #[test]
    fn rewrites_nested_paths_without_matching_file_name_prefixes() {
        let mut value = json!({"blocks": [
            {"path": "/scratch/source/pasted/note.txt"},
            {"text": "Read @\"/scratch/source/pasted/note.txt\" twice /scratch/source/pasted/note.txt"},
            {"text": "/scratch/source/pasted/note.txt.bak"}
        ]});
        assert!(rewrite_value(
            &mut value,
            "/scratch/source/pasted/note.txt",
            "/child/note.txt"
        ));
        assert_eq!(value["blocks"][0]["path"], "/child/note.txt");
        assert_eq!(
            value["blocks"][1]["text"],
            "Read @\"/child/note.txt\" twice /child/note.txt"
        );
        assert_eq!(
            value["blocks"][2]["text"],
            "/scratch/source/pasted/note.txt.bak"
        );
    }

    fn visualization_text(path: &str) -> String {
        format!("::visualize{}", json!({"path": path, "title": "Chart"}))
    }

    fn assistant(text: &str) -> MessageRecord {
        let mut record = message(json!([{"type": "text", "text": text}]));
        record.role = "assistant".into();
        record
    }

    #[test]
    fn visualization_fork_correlates_relocated_paths_and_compaction_json() {
        let data = tempfile::tempdir().unwrap();
        let source = visualizations::session_dir(data.path(), "source").unwrap();
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("chart.html"), "chart bytes").unwrap();
        fs::write(source.join("checkpoint.html"), "checkpoint bytes").unwrap();
        fs::write(source.join("unused.html"), "unused").unwrap();
        let old = "/retired profile/visualizations/source/chart.html";
        let windows = r"C:\retired profile\visualizations\source\checkpoint.html";
        let mut records = vec![assistant(&visualization_text(old))];
        let mut compactions: Vec<CompactionRecord> = vec![serde_json::from_value(json!({
            "id": "checkpoint", "summary": visualization_text(windows),
            "throughMessageId": "message", "tokensBefore": 10, "createdAt": "now",
            "retainedTail": [{"role": "assistant", "content": visualization_text(old)}],
            "details": {"summary": visualization_text(windows)}
        }))
        .unwrap()];
        let guard = preserve_visualizations(
            data.path(),
            "source",
            "child",
            &mut records,
            &mut compactions,
        )
        .unwrap();
        let child = visualizations::session_dir(data.path(), "child").unwrap();
        assert_eq!(
            fs::read_to_string(child.join("chart.html")).unwrap(),
            "chart bytes"
        );
        assert_eq!(
            fs::read_to_string(child.join("checkpoint.html")).unwrap(),
            "checkpoint bytes"
        );
        assert!(!child.join("unused.html").exists());
        assert_eq!(
            records[0].blocks[0]["text"],
            visualization_text(&child.join("chart.html").to_string_lossy())
        );
        assert_eq!(
            compactions[0].summary,
            visualization_text(&child.join("checkpoint.html").to_string_lossy())
        );
        assert_eq!(
            compactions[0].retained_tail.as_ref().unwrap()[0]["content"],
            records[0].blocks[0]["text"]
        );
        assert_eq!(
            compactions[0].details.as_ref().unwrap()["summary"],
            compactions[0].summary
        );
        drop(guard);
        assert!(!child.exists());
        assert!(source.join("chart.html").exists());
    }

    #[test]
    fn visualization_fork_accepts_canonical_references_with_a_data_directory_alias() {
        let data = tempfile::tempdir().unwrap();
        let alias_parent = tempfile::tempdir().unwrap();
        let alias = alias_parent.path().join("profile");
        crate::session_worktrees::test_support::link_dir(data.path(), &alias);
        let source = visualizations::session_dir(&alias, "source").unwrap();
        fs::create_dir_all(&source).unwrap();
        let file = source.join("chart.html");
        fs::write(&file, "chart bytes").unwrap();
        let canonical = crate::workspace::simple_canonicalize(&file).unwrap();
        let mut records = vec![assistant(&visualization_text(&canonical.to_string_lossy()))];
        preserve_visualizations(&alias, "source", "child", &mut records, &mut [])
            .unwrap()
            .commit();
        let child = visualizations::session_dir(&alias, "child").unwrap();
        assert_eq!(
            fs::read_to_string(child.join("chart.html")).unwrap(),
            "chart bytes"
        );
        assert_eq!(
            records[0].blocks[0]["text"],
            visualization_text(&child.join("chart.html").to_string_lossy())
        );
    }

    #[test]
    fn visualization_fork_leaves_code_examples_tool_strings_and_foreign_references_untouched() {
        let data = tempfile::tempdir().unwrap();
        let source = visualizations::session_dir(data.path(), "source").unwrap();
        fs::create_dir_all(&source).unwrap();
        for name in ["code.html", "raw.html", "chart.html"] {
            fs::write(source.join(name), name).unwrap();
        }
        let code = visualization_text(&source.join("code.html").to_string_lossy());
        let raw = visualization_text(&source.join("raw.html").to_string_lossy());
        let foreign = visualization_text("/old/visualizations/other/chart.html");
        let text = format!("Example:\n```json\n{code}\n```\nNot a card.\n    {code}\n{foreign}");
        let mut tool = message(json!([{"type": "text", "text": raw}]));
        tool.role = "tool".into();
        let mut caller = assistant("");
        caller.blocks = json!([
            {"type": "tool_call", "name": "Bash", "args": {"command": raw, "content": raw}},
            {"type": "thinking", "text": raw}
        ]);
        let mut records = vec![assistant(&text), tool, caller];
        let before = records
            .iter()
            .map(|record| record.blocks.clone())
            .collect::<Vec<_>>();
        let mut compactions: Vec<CompactionRecord> = vec![serde_json::from_value(json!({
            "id": "checkpoint", "summary": "No cards", "throughMessageId": "message", "tokensBefore": 10, "createdAt": "now",
            "retainedTail": [{"role": "tool", "content": raw}, {"role": "assistant", "blocks": records[2].blocks}],
            "details": {"raw": raw, "summary": text}
        })).unwrap()];
        let compactions_before = serde_json::to_value(&compactions).unwrap();
        preserve_visualizations(
            data.path(),
            "source",
            "child",
            &mut records,
            &mut compactions,
        )
        .unwrap()
        .commit();
        assert_eq!(
            records
                .iter()
                .map(|record| record.blocks.clone())
                .collect::<Vec<_>>(),
            before
        );
        assert_eq!(
            serde_json::to_value(&compactions).unwrap(),
            compactions_before
        );
        assert!(!visualizations::session_dir(data.path(), "child")
            .unwrap()
            .exists());
    }

    #[test]
    fn visualization_rollback_does_not_follow_a_replaced_base() {
        let data = tempfile::tempdir().unwrap();
        let source = visualizations::session_dir(data.path(), "source").unwrap();
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("chart.html"), "chart bytes").unwrap();
        let mut records = vec![assistant(&visualization_text(
            &source.join("chart.html").to_string_lossy(),
        ))];
        let guard =
            preserve_visualizations(data.path(), "source", "child", &mut records, &mut []).unwrap();
        let external = tempfile::tempdir().unwrap();
        let keep = external.path().join("child/keep.html");
        fs::create_dir_all(keep.parent().unwrap()).unwrap();
        fs::write(&keep, "irreplaceable").unwrap();
        fs::rename(
            visualizations::base_dir(data.path()),
            data.path().join("old-visualizations"),
        )
        .unwrap();
        crate::session_worktrees::test_support::link_dir(
            external.path(),
            &visualizations::base_dir(data.path()),
        );
        drop(guard);
        assert_eq!(fs::read_to_string(keep).unwrap(), "irreplaceable");
    }

    #[test]
    fn visualization_fork_copies_only_referenced_regular_safe_html_files() {
        let data = tempfile::tempdir().unwrap();
        let source = visualizations::session_dir(data.path(), "source").unwrap();
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("chart.html"), "chart bytes").unwrap();
        for name in ["unused.html", "a..b.html", ".hidden.html", "code.js"] {
            fs::write(source.join(name), "not a card").unwrap();
        }
        let external = tempfile::tempdir().unwrap();
        let important = external.path().join("important.html");
        fs::write(&important, "irreplaceable").unwrap();
        crate::session_worktrees::test_support::link_dir(
            external.path(),
            &source.join("directory.html"),
        );
        crate::session_worktrees::test_support::try_link_file(
            &important,
            &source.join("linked.html"),
        );
        let rejected = [
            "directory.html",
            "linked.html",
            "a..b.html",
            ".hidden.html",
            "code.js",
            "missing.html",
        ]
        .map(|name| visualization_text(&source.join(name).to_string_lossy()));
        let text = format!(
            "{}\n{}",
            visualization_text(&source.join("chart.html").to_string_lossy()),
            rejected.join("\n")
        );
        let mut records = vec![assistant(&text)];
        preserve_visualizations(data.path(), "source", "child", &mut records, &mut [])
            .unwrap()
            .commit();
        let child = visualizations::session_dir(data.path(), "child").unwrap();
        assert_eq!(fs::read_dir(&child).unwrap().count(), 1);
        assert_eq!(
            fs::read_to_string(child.join("chart.html")).unwrap(),
            "chart bytes"
        );
        assert_eq!(
            records[0].blocks[0]["text"],
            format!(
                "{}\n{}",
                visualization_text(&child.join("chart.html").to_string_lossy()),
                rejected.join("\n")
            )
        );
        assert_eq!(fs::read_to_string(important).unwrap(), "irreplaceable");
    }
}
