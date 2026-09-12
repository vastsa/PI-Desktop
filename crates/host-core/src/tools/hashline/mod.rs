//! Line-anchored Edit contract (ADR 0087).
//!
//! Tags, the session snapshot store, the op parser, and apply live here so
//! `tools::mod` can keep Read/Write/Grep/Edit as thin adapters.

mod apply;
mod parse;
mod store;
mod tag;

pub use apply::{apply_edit, canonical_key, encode_success, record_post_write, ToolError};
#[allow(unused_imports)]
pub use parse::mv_dest;
pub use store::HashlineStore;
pub use tag::{
    looks_binary_bytes, normalize_file, section_header, split_lines, strip_write_markup,
    tag_of_lf_text, NormalizedFile,
};

use serde_json::{json, Map, Value};
use std::collections::BTreeSet;
use std::path::Path;

pub struct HashlineContext<'a> {
    pub session_id: &'a str,
    pub store: &'a HashlineStore,
}

pub struct ReadWindow {
    pub content: String,
    #[allow(dead_code)]
    pub tag: String,
    pub line_count: usize,
    pub clipped_lines: usize,
    pub budget_capped: bool,
    pub has_more: bool,
    pub seen_lines: BTreeSet<u32>,
}

pub fn format_read_window(
    display_path: &str,
    file: &NormalizedFile,
    tag: &str,
    offset: usize,
    limit: usize,
    max_line_chars: usize,
    max_bytes: usize,
) -> ReadWindow {
    let lines = split_lines(&file.text);
    let total = lines.len();
    let mut kept: Vec<String> = Vec::new();
    let mut seen = BTreeSet::new();
    let mut clipped_lines = 0usize;
    let mut bytes = 0usize;
    let mut budget_capped = false;
    let header = section_header(display_path, tag);
    bytes += header.len() + 1;

    let start = offset.min(total);
    let mut idx = start;
    while idx < total && kept.len() < limit {
        let line_no = idx + 1;
        let (text, clipped) = clip_chars(&lines[idx], max_line_chars);
        let rendered = format!("{line_no}:{text}");
        let size = rendered.len() + usize::from(!kept.is_empty());
        if bytes + size > max_bytes {
            budget_capped = true;
            break;
        }
        bytes += size;
        if clipped {
            clipped_lines += 1;
        } else {
            seen.insert(line_no as u32);
        }
        kept.push(rendered);
        idx += 1;
    }
    let has_more = budget_capped || idx < total;
    let mut content = header;
    content.push('\n');
    content.push_str(&kept.join("\n"));
    ReadWindow {
        content,
        tag: tag.to_string(),
        line_count: kept.len(),
        clipped_lines,
        budget_capped,
        has_more,
        seen_lines: seen,
    }
}

fn clip_chars(text: &str, max_chars: usize) -> (String, bool) {
    match text.char_indices().nth(max_chars) {
        Some((idx, _)) => (text[..idx].to_string(), true),
        None => (text.to_string(), false),
    }
}

pub fn record_read(
    ctx: Option<&HashlineContext<'_>>,
    canonical_path: &str,
    file: &NormalizedFile,
    tag: &str,
    seen_lines: BTreeSet<u32>,
) {
    if let Some(ctx) = ctx {
        ctx.store
            .record(ctx.session_id, canonical_path, file, tag, Some(seen_lines));
    }
}

pub fn record_write(
    ctx: Option<&HashlineContext<'_>>,
    canonical_path: &str,
    file: &NormalizedFile,
    tag: &str,
) {
    record_post_write(
        ctx.map(|c| c.store),
        ctx.map(|c| c.session_id),
        canonical_path,
        file,
        tag,
    );
}

pub fn record_grep_file(
    ctx: Option<&HashlineContext<'_>>,
    canonical_path: &Path,
    display_path: &str,
    matched_lines: Option<&[u64]>,
) -> Option<(String, String)> {
    let bytes = std::fs::read(canonical_path).ok()?;
    if looks_binary_bytes(&bytes) {
        return None;
    }
    let file = normalize_file(&bytes);
    let tag = tag_of_lf_text(&file.text);
    if let Some(ctx) = ctx {
        let seen = match matched_lines {
            Some(lines) => Some(lines.iter().map(|n| *n as u32).collect()),
            None => Some(BTreeSet::new()),
        };
        ctx.store.record(
            ctx.session_id,
            &canonical_key(canonical_path),
            &file,
            &tag,
            seen,
        );
    }
    Some((display_path.to_string(), tag))
}

pub fn attach_tags(mut out: Value, tags: Map<String, Value>) -> Value {
    if !tags.is_empty() {
        out["tags"] = json!(tags);
    }
    out
}

pub fn invalidate_path(ctx: Option<&HashlineContext<'_>>, canonical_path: &str) {
    if let Some(ctx) = ctx {
        ctx.store.invalidate_path(ctx.session_id, canonical_path);
    }
}
