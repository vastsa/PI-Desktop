//! Per-session transcript files (D119).
//!
//! Message content lives on disk, one JSONL file per session, mirroring the
//! codex/claude-code layout; SQLite keeps only index rows (spec 04 §4.7).
//!
//! ```text
//! <data_dir>/sessions/<session_id>.jsonl            live transcript
//! <data_dir>/sessions/<session_id>.revisions.jsonl  regenerate branches
//! ```
//!
//! The transcript starts with a `{"type":"session",...}` header line followed
//! by one `{"type":"message",...}` line per message; `seq` is implied by line
//! order. The revisions file is append-only — one `{"type":"revision",...}`
//! line per archived branch; the active flag lives in the DB index only.
//! Readers skip unknown line types and a torn trailing line, so new line
//! kinds need no migration and a crash mid-append cannot poison the file.
//!
//! Unlike scratch dirs these files are user data: they are removed only with
//! their session, never by an age or orphan sweep.

use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, BufWriter, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Bumped when the line format changes shape incompatibly.
pub const TRANSCRIPT_SCHEMA: i64 = 1;

/// One persisted message: the canonical block array plus promoted fields,
/// not the flat UiMessage projection (spec 04 §1 "lossless transcripts").
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageRecord {
    pub id: String,
    pub role: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub is_error: bool,
    /// Canonical block array (text / thinking / tool_call / attachment, open set).
    pub blocks: Value,
    /// usage / modelId / providerId / status / error / revision metadata.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meta: Option<Value>,
    /// RFC3339; storage keeps the wire spelling so files stay human-readable.
    pub created_at: String,
}

/// Durable model-context checkpoint. The visible message transcript remains
/// untouched; this record only changes the context reconstructed for a model.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactionRecord {
    pub id: String,
    pub summary: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub first_kept_message_id: Option<String>,
    pub through_message_id: String,
    pub tokens_before: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retained_tail: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    pub created_at: String,
}

/// One archived regenerate branch rooted at a user turn.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RevisionRecord {
    pub root_user_id: String,
    pub revision_index: i64,
    pub created_at: String,
    pub messages: Vec<MessageRecord>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionHeader {
    schema: i64,
    session_id: String,
    created_at: String,
}

/// The portions of one transcript read that callers commonly need together.
/// Keeping this as one pass matters for long sessions: the old session loader
/// read the same JSONL file once for messages and once for compactions.
#[derive(Debug, Default)]
pub struct TranscriptRead {
    pub messages: Vec<MessageRecord>,
    pub compactions: Vec<CompactionRecord>,
}

/// Physical layout of one transcript file: the byte offset of every message and
/// compaction line, plus the file length it was built from.
///
/// A window read seeks straight to its first selected line instead of parsing
/// every earlier line, so opening a long session costs the window rather than
/// the whole history. `file_len` is the validity token: the transcript is
/// append-only between atomic rewrites, so a longer file is scanned
/// incrementally while a shorter or replaced file invalidates the layout.
#[derive(Debug, Default, Clone)]
pub struct TranscriptLayout {
    /// Byte offset of each message line, in file order.
    pub message_offsets: Vec<u64>,
    /// Byte offset of each compaction line, in file order.
    pub compaction_offsets: Vec<u64>,
    /// Byte length of the file prefix this layout describes.
    pub file_len: u64,
}

impl TranscriptLayout {
    /// Physical message-line count. Every window offset in this module is
    /// expressed in this coordinate space, not in deduplicated positions.
    pub fn message_count(&self) -> usize {
        self.message_offsets.len()
    }
}

/// Classify a JSONL line without building a `serde_json::Value`.
///
/// Every line written by this module carries `"type"` in the first object
/// level, so a bounded prefix scan decides the kind. Deserializing a `LineTag`
/// instead makes serde walk the entire line -- including a multi-megabyte tool
/// payload -- to read one short string, which dominates the cost of scanning a
/// long transcript.
fn sniff_line_kind(line: &str) -> Option<&'static str> {
    const SNIFF_LIMIT: usize = 512;
    let bytes = line.as_bytes();
    let head = &bytes[..bytes.len().min(SNIFF_LIMIT)];
    // Lines written before the discriminator moved to the front carry it after
    // their payload, so a bounded tail check keeps existing files readable
    // without parsing them.
    let tail = &bytes[bytes.len().saturating_sub(SNIFF_LIMIT)..];
    sniff_window(head).or_else(|| sniff_window(tail))
}

/// Find the line kind named anywhere in `window`.
///
/// Block payloads carry their own `type` ("text", "tool_call", ...), so the
/// first match is not necessarily the line's discriminator. Every occurrence is
/// examined and the first one naming a line kind wins; no block type shares a
/// name with a line type, so this cannot pick the wrong one.
fn sniff_window(window: &[u8]) -> Option<&'static str> {
    let needle = b"\"type\":\"";
    let mut offset = 0usize;
    while offset + needle.len() < window.len() {
        let Some(found) = window[offset..]
            .windows(needle.len())
            .position(|candidate| candidate == needle)
        else {
            return None;
        };
        let value_start = offset + found + needle.len();
        let rest = &window[value_start..];
        let Some(end) = rest.iter().position(|byte| *byte == b'"') else {
            return None;
        };
        match &rest[..end] {
            b"message" => return Some("message"),
            b"compaction" => return Some("compaction"),
            b"session" => return Some("session"),
            b"revision" => return Some("revision"),
            _ => {}
        }
        offset = value_start + end;
    }
    None
}

/// Extend `base` with any lines appended after `base.file_len`.
///
/// A transcript only grows between atomic rewrites, so the common case after a
/// new message is a short tail scan. A file that shrank or was replaced by a
/// rewrite of a different length is rescanned from the start, because offsets
/// recorded against the previous contents cannot be trusted.
pub fn refresh_layout(
    data_dir: &Path,
    session_id: &str,
    base: TranscriptLayout,
) -> Result<TranscriptLayout> {
    let path = transcript_path(data_dir, session_id)?;
    let len = match fs::metadata(&path) {
        Ok(meta) => meta.len(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(TranscriptLayout::default())
        }
        Err(e) => return Err(e).with_context(|| format!("stat {}", path.display())),
    };
    if len == base.file_len {
        return Ok(base);
    }
    if len < base.file_len {
        return scan_layout(&path, TranscriptLayout::default());
    }
    scan_layout(&path, base)
}

/// Scan from `layout.file_len` to the end of the file, appending offsets.
fn scan_layout(path: &Path, mut layout: TranscriptLayout) -> Result<TranscriptLayout> {
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(TranscriptLayout::default())
        }
        Err(e) => return Err(e).with_context(|| format!("read {}", path.display())),
    };
    let mut offset = layout.file_len;
    if offset > 0 {
        file.seek(SeekFrom::Start(offset))
            .with_context(|| format!("seek {}", path.display()))?;
    }
    let mut reader = BufReader::new(file);
    let mut line = String::new();
    loop {
        line.clear();
        let read = reader.read_line(&mut line)?;
        if read == 0 {
            break;
        }
        // A torn trailing line (crash mid-append) has no newline yet. Keeping it
        // out of both the offsets and `file_len` lets a later refresh pick it up
        // once the writer completes it.
        if !line.ends_with('\n') {
            break;
        }
        match sniff_line_kind(line.trim_end()) {
            Some("message") => layout.message_offsets.push(offset),
            Some("compaction") => layout.compaction_offsets.push(offset),
            _ => {}
        }
        offset += read as u64;
        // A skipped multi-megabyte line must not leave its capacity attached to
        // every following read.
        if line.capacity() > 1024 * 1024 {
            line = String::new();
        }
    }
    layout.file_len = offset;
    Ok(layout)
}

/// Serialize one JSONL line with its `type` discriminator first.
///
/// Position matters for reads: `serde_json`'s map is sorted, so inserting the
/// key would place it after the payload and force a reader to walk a whole
/// multi-megabyte tool result before it can tell what the line is. Writing it
/// first makes classification a fixed-cost prefix check.
fn tagged(tag: &str, body: &impl Serialize) -> Result<String> {
    let value = serde_json::to_value(body)?;
    let object = value
        .as_object()
        .ok_or_else(|| anyhow!("line body must be an object"))?;
    let body = Value::Object(object.clone()).to_string();
    let head = format!("{{\"type\":{}", Value::String(tag.into()));
    // `{}` has no fields to append after the discriminator.
    if object.is_empty() {
        return Ok(format!("{head}}}"));
    }
    Ok(format!("{head},{}", &body[1..]))
}

/// Session ids come from our own DB (UUIDs), but stay defensive: an id that
/// could traverse out of the sessions base gets no file at all.
fn safe_session_id(session_id: &str) -> bool {
    !session_id.is_empty()
        && session_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

pub fn base_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("sessions")
}

fn path_for(data_dir: &Path, session_id: &str, suffix: &str) -> Result<PathBuf> {
    if !safe_session_id(session_id) {
        return Err(anyhow!("invalid session id: {session_id:?}"));
    }
    Ok(base_dir(data_dir).join(format!("{session_id}{suffix}")))
}

pub fn transcript_path(data_dir: &Path, session_id: &str) -> Result<PathBuf> {
    path_for(data_dir, session_id, ".jsonl")
}

pub fn revisions_path(data_dir: &Path, session_id: &str) -> Result<PathBuf> {
    path_for(data_dir, session_id, ".revisions.jsonl")
}

/// Durable single-line append shared by transcript and revision writers.
/// `header` is written first when the file does not exist yet.
fn append_line(path: &Path, header: Option<String>, line: String) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let fresh = !path.exists();
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    let mut buf = String::new();
    if fresh {
        if let Some(header) = header {
            buf.push_str(&header);
            buf.push('\n');
        }
    }
    buf.push_str(&line);
    buf.push('\n');
    file.write_all(buf.as_bytes())?;
    file.flush()?;
    // Message durability matches the DB's WAL synchronous=NORMAL guarantees.
    file.sync_data()?;
    Ok(())
}

fn header_line(session_id: &str, session_created_at: &str) -> Result<String> {
    tagged(
        "session",
        &SessionHeader {
            schema: TRANSCRIPT_SCHEMA,
            session_id: session_id.to_string(),
            created_at: session_created_at.to_string(),
        },
    )
}

/// Append one message to the live transcript, creating the file (with its
/// session header) on first write.
pub fn append_message(
    data_dir: &Path,
    session_id: &str,
    session_created_at: &str,
    record: &MessageRecord,
) -> Result<()> {
    let path = transcript_path(data_dir, session_id)?;
    append_line(
        &path,
        Some(header_line(session_id, session_created_at)?),
        tagged("message", record)?,
    )
    .with_context(|| format!("append transcript {}", path.display()))
}

/// Append a model-context checkpoint without rewriting visible messages.
pub fn append_compaction(
    data_dir: &Path,
    session_id: &str,
    session_created_at: &str,
    record: &CompactionRecord,
) -> Result<()> {
    let path = transcript_path(data_dir, session_id)?;
    append_line(
        &path,
        Some(header_line(session_id, session_created_at)?),
        tagged("compaction", record)?,
    )
    .with_context(|| format!("append compaction {}", path.display()))
}

/// Load the live transcript. A missing file is an empty transcript; unknown
/// line types and a torn trailing line are skipped, not errors.
pub fn read_transcript(data_dir: &Path, session_id: &str) -> Result<Vec<MessageRecord>> {
    Ok(read_transcript_window(data_dir, session_id, 0, None)?.messages)
}

/// Read a message window using a precomputed layout, seeking directly to the
/// first selected line.
///
/// `message_start` and `message_limit` are physical message-line positions,
/// the same coordinate space as [`TranscriptLayout::message_count`]. Unlike a
/// sequential scan, the cost here is proportional to the window, not to the
/// history in front of it. Compaction lines are always returned in full: the
/// chain is small and the newest element is required for model context.
pub fn read_transcript_window_with_layout(
    data_dir: &Path,
    session_id: &str,
    layout: &TranscriptLayout,
    message_start: usize,
    message_limit: Option<usize>,
) -> Result<TranscriptRead> {
    let path = transcript_path(data_dir, session_id)?;
    let mut out = TranscriptRead::default();
    let total = layout.message_count();
    let start = message_start.min(total);
    let end = message_limit
        .map(|limit| start.saturating_add(limit).min(total))
        .unwrap_or(total);

    // Every offset that has to be visited, in ascending file order, so one
    // forward-only reader can serve both kinds without seeking backwards.
    let mut wanted: Vec<(u64, bool)> = Vec::with_capacity(
        end.saturating_sub(start) + layout.compaction_offsets.len(),
    );
    wanted.extend(
        layout.message_offsets[start..end]
            .iter()
            .map(|offset| (*offset, true)),
    );
    wanted.extend(
        layout
            .compaction_offsets
            .iter()
            .map(|offset| (*offset, false)),
    );
    if wanted.is_empty() {
        return Ok(out);
    }
    wanted.sort_unstable_by_key(|(offset, _)| *offset);

    let file = match File::open(&path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
        Err(e) => return Err(e).with_context(|| format!("read {}", path.display())),
    };
    let mut reader = BufReader::new(file);
    let mut line = String::new();
    for (offset, is_message) in wanted {
        reader
            .seek(SeekFrom::Start(offset))
            .with_context(|| format!("seek {}", path.display()))?;
        line.clear();
        if reader.read_line(&mut line)? == 0 {
            continue;
        }
        let trimmed = line.trim();
        if is_message {
            match serde_json::from_str::<MessageRecord>(trimmed) {
                Ok(record) => out.messages.push(record),
                Err(error) => {
                    tracing::warn!(path = %path.display(), %error, "skipping invalid message line");
                }
            }
        } else {
            match serde_json::from_str::<CompactionRecord>(trimmed) {
                Ok(record) => out.compactions.push(record),
                Err(error) => {
                    tracing::warn!(path = %path.display(), %error, "skipping invalid compaction line");
                }
            }
        }
        if line.capacity() > 1024 * 1024 {
            line = String::new();
        }
    }
    Ok(out)
}

/// Read a message window without materializing the whole JSONL file. Message
/// positions are zero-based and count message lines in file order. A `None`
/// limit reads through the end, which is the full-history path used by the
/// sidecar when it reconstructs model context.
pub fn read_transcript_window(
    data_dir: &Path,
    session_id: &str,
    message_start: usize,
    message_limit: Option<usize>,
) -> Result<TranscriptRead> {
    let path = transcript_path(data_dir, session_id)?;
    let file = match File::open(&path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(TranscriptRead::default()),
        Err(e) => return Err(e).with_context(|| format!("read {}", path.display())),
    };
    let mut reader = BufReader::new(file);
    let mut line = String::new();
    let end = message_limit.map(|limit| message_start.saturating_add(limit));
    let mut message_index = 0usize;
    let mut out = TranscriptRead::default();
    loop {
        line.clear();
        if reader.read_line(&mut line)? == 0 {
            break;
        }
        // Classify by a bounded prefix scan: a full parse here walks every byte
        // of a large tool payload before the line is even selected.
        let Some(kind) = sniff_line_kind(line.trim_end()) else {
            tracing::warn!(path = %path.display(), "skipping unparseable transcript line");
            continue;
        };
        match kind {
            "message" => {
                let index = message_index;
                message_index += 1;
                let selected = index >= message_start && end.map_or(true, |limit| index < limit);
                if selected {
                    match serde_json::from_str::<MessageRecord>(line.trim()) {
                        Ok(record) => out.messages.push(record),
                        Err(error) => {
                            tracing::warn!(path = %path.display(), %error, "skipping invalid message line");
                        }
                    }
                }
            }
            "compaction" => match serde_json::from_str::<CompactionRecord>(line.trim()) {
                Ok(record) => out.compactions.push(record),
                Err(error) => {
                    tracing::warn!(path = %path.display(), %error, "skipping invalid compaction line");
                }
            },
            _ => {}
        }
        // A skipped 50 MB line must not leave its capacity attached to every
        // following read. The selected full-history path intentionally keeps
        // the buffer reusable because it is already paying for every record.
        if message_limit.is_some() && line.capacity() > 1024 * 1024 {
            line = String::new();
        }
    }
    Ok(out)
}

/// Read the full transcript and checkpoints in one pass. This is kept as a
/// separate helper so callers that need both do not accidentally regress to
/// two complete file reads.
pub fn read_transcript_with_compactions(
    data_dir: &Path,
    session_id: &str,
) -> Result<TranscriptRead> {
    read_transcript_window(data_dir, session_id, 0, None)
}

/// Return every valid compaction checkpoint in append order.
pub fn read_compactions(data_dir: &Path, session_id: &str) -> Result<Vec<CompactionRecord>> {
    Ok(read_transcript_with_compactions(data_dir, session_id)?.compactions)
}

/// Atomically replace the live transcript (compaction, revision switch,
/// import): write a sibling temp file, fsync, rename over the target.
pub fn write_transcript(
    data_dir: &Path,
    session_id: &str,
    session_created_at: &str,
    records: &[MessageRecord],
) -> Result<()> {
    write_transcript_with_compactions(data_dir, session_id, session_created_at, records, &[])
}

/// Atomically replace visible messages and retain the checkpoint chain, in
/// append order. A rewrite drops whichever records the caller filtered out,
/// which is how a truncated anchor invalidates a single checkpoint without
/// discarding the rest of the chain.
pub fn write_transcript_with_compactions(
    data_dir: &Path,
    session_id: &str,
    session_created_at: &str,
    records: &[MessageRecord],
    compactions: &[CompactionRecord],
) -> Result<()> {
    let path = transcript_path(data_dir, session_id)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("jsonl.tmp");
    {
        let file = File::create(&tmp)?;
        let mut writer = BufWriter::new(file);
        writer.write_all(header_line(session_id, session_created_at)?.as_bytes())?;
        writer.write_all(b"\n")?;
        for record in records {
            writer.write_all(tagged("message", record)?.as_bytes())?;
            writer.write_all(b"\n")?;
        }
        for record in compactions {
            writer.write_all(tagged("compaction", record)?.as_bytes())?;
            writer.write_all(b"\n")?;
        }
        writer.flush()?;
        writer.get_ref().sync_data()?;
    }
    swap_into_place(&tmp, &path)
}

/// Swap a fully written temp file over its target. Windows cannot rename over
/// an existing file (D010: Windows post-MVP); on POSIX the plain rename keeps
/// the replacement atomic.
fn swap_into_place(tmp: &Path, path: &Path) -> Result<()> {
    #[cfg(windows)]
    let _ = fs::remove_file(path);
    fs::rename(tmp, path).with_context(|| format!("replace {}", path.display()))?;
    Ok(())
}

/// Rewrite exactly one message line, copying every other line through
/// verbatim. Returns false when the id is not in the file.
///
/// The file is re-read here instead of being handed in by the caller, so a line
/// appended between the caller's own read and this write survives. That is the
/// difference that matters: a metadata stamp must never cost the transcript its
/// newest messages the way a full `write_transcript` from a stale snapshot does.
pub fn update_message(data_dir: &Path, session_id: &str, record: &MessageRecord) -> Result<bool> {
    let path = transcript_path(data_dir, session_id)?;
    let raw = match fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e).with_context(|| format!("read {}", path.display())),
    };
    let replacement = tagged("message", record)?;
    let mut body = String::with_capacity(raw.len() + replacement.len());
    let mut replaced = false;
    for line in raw.lines() {
        let trimmed = line.trim();
        let is_target = !trimmed.is_empty()
            && serde_json::from_str::<Value>(trimmed).is_ok_and(|value| {
                value.get("type").and_then(Value::as_str) == Some("message")
                    && value.get("id").and_then(Value::as_str) == Some(record.id.as_str())
            });
        // A retried append can leave the same id on two lines; keep-last dedupe
        // means every copy has to carry the new metadata.
        if is_target {
            body.push_str(&replacement);
            replaced = true;
        } else {
            body.push_str(line);
        }
        body.push('\n');
    }
    if !replaced {
        return Ok(false);
    }
    let tmp = path.with_extension("jsonl.tmp");
    {
        let file = File::create(&tmp)?;
        let mut writer = BufWriter::new(file);
        writer.write_all(body.as_bytes())?;
        writer.flush()?;
        writer.get_ref().sync_data()?;
    }
    swap_into_place(&tmp, &path)?;
    Ok(true)
}

/// Append one archived branch. The file is append-only: the active revision
/// flag lives in the DB index, so switching revisions never rewrites it.
pub fn append_revision(data_dir: &Path, session_id: &str, record: &RevisionRecord) -> Result<()> {
    let path = revisions_path(data_dir, session_id)?;
    append_line(&path, None, tagged("revision", record)?)
        .with_context(|| format!("append revisions {}", path.display()))
}

/// Find one archived branch by its family key and index (linear scan; the
/// file holds at most a handful of branches per root). The LAST match wins:
/// a crash between file append and index commit can leave a duplicate index
/// on disk, and the newest line is the one the DB accepted.
pub fn read_revision(
    data_dir: &Path,
    session_id: &str,
    root_user_id: &str,
    revision_index: i64,
) -> Result<Option<RevisionRecord>> {
    let path = revisions_path(data_dir, session_id)?;
    let raw = match fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e).with_context(|| format!("read {}", path.display())),
    };
    let mut found = None;
    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if value.get("type").and_then(|t| t.as_str()) != Some("revision") {
            continue;
        }
        let Ok(record) = serde_json::from_value::<RevisionRecord>(value) else {
            continue;
        };
        if record.root_user_id == root_user_id && record.revision_index == revision_index {
            found = Some(record);
        }
    }
    Ok(found)
}

/// Remove a session's transcript, revisions, and any temp leftover
/// (idempotent, best-effort). Called only from session deletion — transcript
/// files are user data and have no age/orphan sweep.
pub fn remove_session_files(data_dir: &Path, session_id: &str) {
    let Ok(transcript) = transcript_path(data_dir, session_id) else {
        return;
    };
    let Ok(revisions) = revisions_path(data_dir, session_id) else {
        return;
    };
    for path in [
        transcript.with_extension("jsonl.tmp"),
        transcript,
        revisions,
    ] {
        if let Err(error) = fs::remove_file(&path) {
            if error.kind() != std::io::ErrorKind::NotFound {
                tracing::warn!(path = %path.display(), %error, "transcript cleanup failed");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::tempdir;

    fn record(id: &str, text: &str) -> MessageRecord {
        MessageRecord {
            id: id.into(),
            role: "user".into(),
            tool_name: None,
            is_error: false,
            blocks: json!([{ "type": "text", "text": text }]),
            meta: None,
            created_at: "2026-07-26T00:00:00.000Z".into(),
        }
    }

    fn compaction() -> CompactionRecord {
        CompactionRecord {
            id: "compact-1".into(),
            summary: "summary".into(),
            first_kept_message_id: Some("m1".into()),
            through_message_id: "m2".into(),
            tokens_before: 42_000,
            usage: Some(json!({ "input": 100, "output": 20 })),
            retained_tail: Some(json!([{ "role": "user", "content": "again", "timestamp": 1 }])),
            details: None,
            provider_id: Some("provider-1".into()),
            model_id: Some("model-1".into()),
            created_at: "2026-07-26T00:00:02Z".into(),
        }
    }


    #[test]
    fn layout_records_message_offsets_and_grows_incrementally() {
        let dir = tempdir().unwrap();
        for id in ["m1", "m2", "m3"] {
            append_message(dir.path(), "s1", "2026-07-26T00:00:00Z", &record(id, id)).unwrap();
        }
        let layout = refresh_layout(dir.path(), "s1", TranscriptLayout::default()).unwrap();
        assert_eq!(layout.message_count(), 3);

        // An unchanged file reuses the cached layout without rescanning.
        let same = refresh_layout(dir.path(), "s1", layout.clone()).unwrap();
        assert_eq!(same.file_len, layout.file_len);
        assert_eq!(same.message_count(), 3);

        // A later append extends the same layout.
        append_message(dir.path(), "s1", "2026-07-26T00:00:00Z", &record("m4", "m4")).unwrap();
        let grown = refresh_layout(dir.path(), "s1", same).unwrap();
        assert_eq!(grown.message_count(), 4);
        assert!(grown.file_len > layout.file_len);
        assert_eq!(&grown.message_offsets[..3], &layout.message_offsets[..3]);
    }

    #[test]
    fn layout_window_reads_only_the_requested_tail() {
        let dir = tempdir().unwrap();
        for index in 0..10 {
            append_message(
                dir.path(),
                "s1",
                "2026-07-26T00:00:00Z",
                &record(&format!("m{index}"), &format!("body {index}")),
            )
            .unwrap();
        }
        let layout = refresh_layout(dir.path(), "s1", TranscriptLayout::default()).unwrap();
        let read =
            read_transcript_window_with_layout(dir.path(), "s1", &layout, 7, Some(3)).unwrap();
        let ids: Vec<&str> = read.messages.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, ["m7", "m8", "m9"]);

        // The same window is produced by the sequential reader.
        let sequential = read_transcript_window(dir.path(), "s1", 7, Some(3)).unwrap();
        let sequential_ids: Vec<&str> =
            sequential.messages.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, sequential_ids);
    }

    #[test]
    fn layout_window_always_returns_the_whole_compaction_chain() {
        let dir = tempdir().unwrap();
        append_message(dir.path(), "s1", "2026-07-26T00:00:00Z", &record("m1", "one")).unwrap();
        append_compaction(dir.path(), "s1", "2026-07-26T00:00:00Z", &compaction()).unwrap();
        for id in ["m2", "m3"] {
            append_message(dir.path(), "s1", "2026-07-26T00:00:00Z", &record(id, id)).unwrap();
        }
        let layout = refresh_layout(dir.path(), "s1", TranscriptLayout::default()).unwrap();
        assert_eq!(layout.message_count(), 3);
        // A tail window that excludes the compaction's neighbourhood still needs
        // the checkpoint chain, because the newest element drives model context.
        let read =
            read_transcript_window_with_layout(dir.path(), "s1", &layout, 2, Some(1)).unwrap();
        assert_eq!(read.messages.len(), 1);
        assert_eq!(read.messages[0].id, "m3");
        assert_eq!(read.compactions.len(), 1);
    }

    #[test]
    fn layout_is_rebuilt_after_a_shorter_rewrite() {
        let dir = tempdir().unwrap();
        for id in ["m1", "m2", "m3"] {
            append_message(dir.path(), "s1", "2026-07-26T00:00:00Z", &record(id, id)).unwrap();
        }
        let layout = refresh_layout(dir.path(), "s1", TranscriptLayout::default()).unwrap();
        write_transcript(
            dir.path(),
            "s1",
            "2026-07-26T00:00:00Z",
            &[record("m1", "one")],
        )
        .unwrap();
        let rebuilt = refresh_layout(dir.path(), "s1", layout).unwrap();
        assert_eq!(rebuilt.message_count(), 1);
        let read =
            read_transcript_window_with_layout(dir.path(), "s1", &rebuilt, 0, Some(50)).unwrap();
        assert_eq!(read.messages.len(), 1);
        assert_eq!(read.messages[0].id, "m1");
    }

    #[test]
    fn reads_legacy_lines_whose_type_follows_their_blocks() {
        // Before the discriminator moved to the front, `tagged()` inserted it
        // into a sorted map, so it landed after `blocks` - whose entries carry a
        // nested `"type"` of their own. A reader that trusts the first match
        // classifies such a line as its first block and skips it.
        let dir = tempdir().unwrap();
        let path = transcript_path(dir.path(), "legacy").unwrap();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let legacy_message = json!({
            "blocks": [{ "type": "text", "text": "kept" }],
            "createdAt": "2026-07-26T00:00:00Z",
            "id": "m1",
            "isError": false,
            "role": "user",
            "type": "message",
        });
        let legacy_header = json!({
            "createdAt": "2026-07-26T00:00:00Z",
            "schema": 1,
            "sessionId": "legacy",
            "type": "session",
        });
        fs::write(
            &path,
            format!("{legacy_header}\n{legacy_message}\n"),
        )
        .unwrap();

        assert_eq!(sniff_line_kind(&legacy_message.to_string()), Some("message"));
        let sequential = read_transcript(dir.path(), "legacy").unwrap();
        assert_eq!(sequential.len(), 1);
        assert_eq!(sequential[0].id, "m1");

        let layout = refresh_layout(dir.path(), "legacy", TranscriptLayout::default()).unwrap();
        assert_eq!(layout.message_count(), 1);
        let windowed =
            read_transcript_window_with_layout(dir.path(), "legacy", &layout, 0, Some(10)).unwrap();
        assert_eq!(windowed.messages.len(), 1);
        assert_eq!(windowed.messages[0].id, "m1");

        // A line carrying no line-level discriminator is still rejected.
        assert_eq!(
            sniff_line_kind(&json!({ "blocks": [{ "type": "text" }] }).to_string()),
            None,
        );
    }

    #[test]
    fn sniffing_classifies_lines_without_full_parsing() {
        assert_eq!(sniff_line_kind(r#"{"type":"message","id":"m1"}"#), Some("message"));
        assert_eq!(
            sniff_line_kind(r#"{"schema":1,"type":"session"}"#),
            Some("session")
        );
        assert_eq!(
            sniff_line_kind(r#"{"type":"compaction","id":"c1"}"#),
            Some("compaction")
        );
        assert_eq!(sniff_line_kind(r#"{"type":"unknown"}"#), None);
        assert_eq!(sniff_line_kind("not json"), None);
    }

    #[test]
    fn rejects_unsafe_session_ids() {
        let dir = tempdir().unwrap();
        assert!(transcript_path(dir.path(), "../evil").is_err());
        assert!(transcript_path(dir.path(), "a/b").is_err());
        assert!(transcript_path(dir.path(), "").is_err());
        assert!(transcript_path(dir.path(), "0b0e9a52-1_ok").is_ok());
    }

    #[test]
    fn append_creates_header_then_lines() {
        let dir = tempdir().unwrap();
        append_message(
            dir.path(),
            "s1",
            "2026-07-26T00:00:00Z",
            &record("m1", "hi"),
        )
        .unwrap();
        append_message(
            dir.path(),
            "s1",
            "2026-07-26T00:00:00Z",
            &record("m2", "again"),
        )
        .unwrap();

        let raw = fs::read_to_string(transcript_path(dir.path(), "s1").unwrap()).unwrap();
        let lines: Vec<&str> = raw.lines().collect();
        assert_eq!(lines.len(), 3);
        let header: Value = serde_json::from_str(lines[0]).unwrap();
        assert_eq!(header["type"], "session");
        assert_eq!(header["schema"], TRANSCRIPT_SCHEMA);
        assert_eq!(header["sessionId"], "s1");

        let loaded = read_transcript(dir.path(), "s1").unwrap();
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[0].id, "m1");
        assert_eq!(loaded[1].id, "m2");
    }

    #[test]
    fn read_skips_torn_tail_and_unknown_lines() {
        let dir = tempdir().unwrap();
        append_message(
            dir.path(),
            "s1",
            "2026-07-26T00:00:00Z",
            &record("m1", "ok"),
        )
        .unwrap();
        let path = transcript_path(dir.path(), "s1").unwrap();
        let mut raw = fs::read_to_string(&path).unwrap();
        raw.push_str("{\"type\":\"future-kind\",\"x\":1}\n");
        raw.push_str("{\"type\":\"message\",\"id\":\"torn"); // crash mid-append
        fs::write(&path, raw).unwrap();

        let loaded = read_transcript(dir.path(), "s1").unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].id, "m1");
    }

    #[test]
    fn window_read_keeps_only_requested_messages_but_returns_checkpoints() {
        let dir = tempdir().unwrap();
        append_message(
            dir.path(),
            "s1",
            "2026-07-26T00:00:00Z",
            &record("m1", "one"),
        )
        .unwrap();
        append_message(
            dir.path(),
            "s1",
            "2026-07-26T00:00:00Z",
            &record("m2", "two"),
        )
        .unwrap();
        append_compaction(dir.path(), "s1", "2026-07-26T00:00:00Z", &compaction()).unwrap();
        append_message(
            dir.path(),
            "s1",
            "2026-07-26T00:00:00Z",
            &record("m3", "three"),
        )
        .unwrap();

        let window = read_transcript_window(dir.path(), "s1", 1, Some(1)).unwrap();
        assert_eq!(
            window
                .messages
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            vec!["m2"]
        );
        assert_eq!(window.compactions.len(), 1);
    }

    #[test]
    fn compaction_roundtrips_without_hiding_messages() {
        let dir = tempdir().unwrap();
        append_message(
            dir.path(),
            "s1",
            "2026-07-26T00:00:00Z",
            &record("m1", "hi"),
        )
        .unwrap();
        append_message(
            dir.path(),
            "s1",
            "2026-07-26T00:00:00Z",
            &record("m2", "again"),
        )
        .unwrap();
        append_compaction(dir.path(), "s1", "2026-07-26T00:00:00Z", &compaction()).unwrap();

        assert_eq!(read_transcript(dir.path(), "s1").unwrap().len(), 2);
        let restored = read_compactions(dir.path(), "s1").unwrap();
        assert_eq!(restored.len(), 1);
        assert_eq!(restored[0].id, "compact-1");
        assert_eq!(restored[0].through_message_id, "m2");
        assert_eq!(restored[0].tokens_before, 42_000);
    }

    #[test]
    fn every_appended_compaction_survives_a_reload() {
        let dir = tempdir().unwrap();
        append_message(dir.path(), "s1", "2026-07-26T00:00:00Z", &record("m1", "one")).unwrap();
        append_compaction(dir.path(), "s1", "2026-07-26T00:00:00Z", &compaction()).unwrap();
        append_message(dir.path(), "s1", "2026-07-26T00:00:00Z", &record("m2", "two")).unwrap();
        let second = CompactionRecord {
            id: "compact-2".into(),
            summary: "later summary".into(),
            first_kept_message_id: Some("m2".into()),
            ..compaction()
        };
        append_compaction(dir.path(), "s1", "2026-07-26T00:00:00Z", &second).unwrap();

        // One transcript row per compaction needs the whole chain, in order.
        let restored = read_compactions(dir.path(), "s1").unwrap();
        assert_eq!(
            restored.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
            vec!["compact-1", "compact-2"]
        );
    }

    #[test]
    fn missing_file_is_empty_transcript() {
        let dir = tempdir().unwrap();
        assert!(read_transcript(dir.path(), "nope").unwrap().is_empty());
        assert!(read_revision(dir.path(), "nope", "u1", 1)
            .unwrap()
            .is_none());
    }

    #[test]
    fn write_transcript_replaces_content() {
        let dir = tempdir().unwrap();
        append_message(
            dir.path(),
            "s1",
            "2026-07-26T00:00:00Z",
            &record("old", "gone"),
        )
        .unwrap();
        write_transcript(
            dir.path(),
            "s1",
            "2026-07-26T00:00:00Z",
            &[record("a", "one"), record("b", "two")],
        )
        .unwrap();

        let loaded = read_transcript(dir.path(), "s1").unwrap();
        assert_eq!(
            loaded.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
            vec!["a", "b"]
        );
        let raw = fs::read_to_string(transcript_path(dir.path(), "s1").unwrap()).unwrap();
        assert!(raw.starts_with("{\""));
        assert!(!raw.contains("gone"));
        assert!(!transcript_path(dir.path(), "s1")
            .unwrap()
            .with_extension("jsonl.tmp")
            .exists());
    }

    #[test]
    fn rewrite_preserves_the_whole_compaction_chain() {
        let dir = tempdir().unwrap();
        let second = CompactionRecord {
            id: "compact-2".into(),
            summary: "later summary".into(),
            ..compaction()
        };
        write_transcript_with_compactions(
            dir.path(),
            "s1",
            "2026-07-26T00:00:00Z",
            &[record("m1", "one"), record("m2", "two")],
            &[compaction(), second],
        )
        .unwrap();

        assert_eq!(read_transcript(dir.path(), "s1").unwrap().len(), 2);
        assert_eq!(
            read_compactions(dir.path(), "s1")
                .unwrap()
                .iter()
                .map(|r| r.summary.as_str())
                .collect::<Vec<_>>(),
            vec!["summary", "later summary"]
        );
    }

    #[test]
    fn revisions_roundtrip_by_root_and_index() {
        let dir = tempdir().unwrap();
        let rev = |i: i64, text: &str| RevisionRecord {
            root_user_id: "u1".into(),
            revision_index: i,
            created_at: "2026-07-26T00:00:00Z".into(),
            messages: vec![record("m", text)],
        };
        append_revision(dir.path(), "s1", &rev(1, "first")).unwrap();
        append_revision(dir.path(), "s1", &rev(2, "second")).unwrap();

        let found = read_revision(dir.path(), "s1", "u1", 2).unwrap().unwrap();
        assert_eq!(found.messages[0].blocks[0]["text"], "second");
        assert!(read_revision(dir.path(), "s1", "u9", 1).unwrap().is_none());
        assert!(read_revision(dir.path(), "s1", "u1", 3).unwrap().is_none());
    }

    #[test]
    fn remove_is_idempotent_and_clears_both_files() {
        let dir = tempdir().unwrap();
        append_message(dir.path(), "s1", "2026-07-26T00:00:00Z", &record("m1", "x")).unwrap();
        append_revision(
            dir.path(),
            "s1",
            &RevisionRecord {
                root_user_id: "u1".into(),
                revision_index: 1,
                created_at: "2026-07-26T00:00:00Z".into(),
                messages: vec![record("m", "x")],
            },
        )
        .unwrap();

        remove_session_files(dir.path(), "s1");
        assert!(!transcript_path(dir.path(), "s1").unwrap().exists());
        assert!(!revisions_path(dir.path(), "s1").unwrap().exists());
        remove_session_files(dir.path(), "s1");
    }
}
