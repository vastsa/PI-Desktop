//! Per-session transcript files (D119).
//!
//! Message content lives on disk, one JSONL file per session, mirroring the
//! codex/claude-code layout; SQLite keeps only index rows (spec 04 §4.7).
//!
//! ```text
//! <data_dir>/sessions/<session_id>.jsonl            live transcript
//! <data_dir>/sessions/<session_id>.revisions.jsonl  regenerate branches
//! <data_dir>/sessions/<session_id>.inflight.json    streaming reply checkpoint
//! ```
//!
//! The transcript starts with a `{"type":"session",...}` header line followed
//! by one `{"type":"message",...}` line per message; `seq` is implied by line
//! order. The revisions file is append-only and holds one line per archived
//! branch. A branch that is still live needs no payload line — it already is
//! the transcript from its root — so `{"type":"revision_live",...}` records
//! its identity only, while `{"type":"revision",...}` stores the messages of
//! the branches that have left the transcript. The active flag lives in the
//! DB index only. Readers skip unknown line types and a torn trailing line, so
//! new line kinds need no migration and a crash mid-append cannot poison the
//! file.
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
    /// Occupancy the checkpoint itself believes the next request will carry,
    /// stamped when the checkpoint is installed (`persistCheckpoint`). The
    /// visible transcript is untouched by a compaction, so nothing else on disk
    /// records what the model context shrank to — without this the context ring
    /// keeps showing the pre-compaction request until the next one lands.
    /// Optional: a transcript written before this field existed loads with
    /// `None`, and a line carrying it stays readable by older readers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokens_after: Option<i64>,
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

/// A deterministic sleep-time digest of where the session stood when a
/// background compaction armed (ADR 0301). Deterministic means no model call is
/// involved: the runtime extracts it from the transcript.
///
/// The line is informational. Nothing reads it as recovery state, and a layout
/// scan never counts it as a message or a checkpoint.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SleepRecord {
    /// `sleep-<millis>-<short>` — unique per write.
    pub id: String,
    /// The deterministic goal/unresolved/progress text.
    pub digest: String,
    /// Newest message the digest covers.
    pub through_message_id: String,
    /// Message lines in the transcript when it was taken.
    pub message_count: usize,
    /// ISO-8601, same shape as other records.
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
    /// message id -> owning turn id, for the branch messages that had one.
    /// The turn lives only in the SQLite index row, which a revision switch
    /// deletes; carrying it here lets the switch back restore attribution.
    #[serde(default, skip_serializing_if = "std::collections::HashMap::is_empty")]
    pub turns: std::collections::HashMap<String, String>,
}

/// One `revision_live` line: a branch whose payload is still the live
/// transcript, so only its identity and turn attribution are stored.
///
/// A branch is the transcript suffix rooted at its user turn, so a live branch
/// is byte-identical to content the session already keeps on disk. Refreshing a
/// stored copy on every finished turn therefore copied that suffix once per
/// turn, and because the suffix grows with every turn the file grew
/// quadratically: one measured session wrote 107 MB to hold 16 MB of unique
/// content, 94% of it tool output copied over and over.
///
/// The line is written only while the branch is live, and it must stop being
/// the reader's answer the moment the branch leaves the transcript. Three
/// writers cover that: `archive_live_branch` (revision switch) and
/// `archive_discarded_regenerate_branch` (regenerate, edit) write the full
/// `revision` line before the rewrite that stops holding the branch, and
/// `archive_dropped_live_branches` does the same for a rewrite that deletes the
/// root turn itself (`session.replaceMessages`). A new path that drops a branch
/// from the transcript without archiving it first would strand its reference.
///
/// It carries no `turns` map, unlike a stored branch, and that is not an
/// omission. That map exists for the messages a restore has to re-attach after
/// the branch left the index; a live branch's messages *are* the session's own
/// index rows, so a restore reads their turns from the index directly. Carrying
/// a copy here would put one entry per branch message on every finished turn —
/// 197 bytes on the first turn of a measured session, 1943 bytes by the
/// fortieth — which is the same quadratic growth this line exists to remove.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveRevisionRecord {
    pub root_user_id: String,
    pub revision_index: i64,
    pub created_at: String,
}

/// The payload of one archived branch, as the revisions file records it.
#[derive(Debug, Clone)]
pub enum RevisionPayload {
    /// The branch messages are stored in the revisions file.
    Stored(RevisionRecord),
    /// The branch is the live transcript from its root. Resolve it against the
    /// transcript the caller already holds: it is the same suffix
    /// `live_branch_start` picks out for that root.
    Live(LiveRevisionRecord),
}

impl RevisionPayload {
    /// message id -> owning turn id, for a branch that has left the index.
    ///
    /// Empty for a live branch: its messages are still the session's own index
    /// rows, so a restore reads their turns from there. See
    /// [`LiveRevisionRecord`].
    pub fn turns(&self) -> &std::collections::HashMap<String, String> {
        static NONE: std::sync::OnceLock<std::collections::HashMap<String, String>> =
            std::sync::OnceLock::new();
        match self {
            RevisionPayload::Stored(record) => &record.turns,
            RevisionPayload::Live(_) => NONE.get_or_init(Default::default),
        }
    }
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

/// Resolve a stable ID without materializing historical message bodies. The
/// reverse scan agrees with last-write-wins transcript deduplication.
pub fn find_message_position(
    data_dir: &Path,
    session_id: &str,
    layout: &TranscriptLayout,
    message_id: &str,
) -> Result<Option<usize>> {
    #[derive(Deserialize)]
    struct Identity {
        id: String,
    }
    let mut reader = BufReader::new(File::open(transcript_path(data_dir, session_id)?)?);
    let mut line = String::new();
    for (position, offset) in layout.message_offsets.iter().enumerate().rev() {
        reader.seek(SeekFrom::Start(*offset))?;
        line.clear();
        reader.read_line(&mut line)?;
        if serde_json::from_str::<Identity>(&line).is_ok_and(|identity| identity.id == message_id) {
            return Ok(Some(position));
        }
    }
    Ok(None)
}

/// Read the owning tool row for a nested message, even outside its page.
/// Inspect only call identities while scanning; materialize just the parent.
pub fn read_tool_call(
    data_dir: &Path,
    session_id: &str,
    layout: &TranscriptLayout,
    call_id: &str,
) -> Result<Option<MessageRecord>> {
    #[derive(Deserialize)]
    struct CallIdentity {
        #[serde(rename = "callId")]
        call_id: Option<String>,
    }
    #[derive(Deserialize)]
    struct ToolIdentity {
        role: String,
        blocks: Vec<CallIdentity>,
    }
    let mut reader = BufReader::new(File::open(transcript_path(data_dir, session_id)?)?);
    let mut line = String::new();
    for offset in layout.message_offsets.iter().rev() {
        reader.seek(SeekFrom::Start(*offset))?;
        line.clear();
        reader.read_line(&mut line)?;
        if serde_json::from_str::<ToolIdentity>(&line).is_ok_and(|identity| {
            identity.role == "tool"
                && identity
                    .blocks
                    .iter()
                    .any(|block| block.call_id.as_deref() == Some(call_id))
        }) {
            return Ok(Some(serde_json::from_str(&line)?));
        }
    }
    Ok(None)
}

/// Classify a JSONL line by reading its top-level `type` value.
///
/// Deserializing a `LineTag` makes serde walk the entire line -- including a
/// multi-megabyte tool payload -- to read one short string, which dominates the
/// cost of scanning a long transcript. This finds the discriminator directly.
///
/// The scan is depth-aware on purpose. Tool results and checkpoint details are
/// open-ended JSON and can nest an object whose own key is `type` with a value
/// that happens to name a line kind, so matching the first `"type":"` in the
/// line would misclassify it. Only a key at the top level of the object counts.
///
/// Lines written before the discriminator moved to the front carry it after
/// their payload; those are found by the same scan, just later in the line. A
/// line in the current format is decided from its first key.
fn sniff_line_kind(line: &str) -> Option<&'static str> {
    let bytes = line.as_bytes();
    let mut index = 0usize;
    // Enter the object.
    while index < bytes.len() && bytes[index].is_ascii_whitespace() {
        index += 1;
    }
    if index >= bytes.len() || bytes[index] != b'{' {
        return None;
    }
    index += 1;
    let mut depth = 1usize;
    while index < bytes.len() {
        match bytes[index] {
            b'"' => {
                let (text, next) = scan_json_string(bytes, index)?;
                index = next;
                // A key at the top level is followed by ':'; anything else was a
                // value and needs no further attention.
                if depth != 1 || text != b"type" {
                    continue;
                }
                while index < bytes.len() && bytes[index].is_ascii_whitespace() {
                    index += 1;
                }
                if index >= bytes.len() || bytes[index] != b':' {
                    continue;
                }
                index += 1;
                while index < bytes.len() && bytes[index].is_ascii_whitespace() {
                    index += 1;
                }
                if index >= bytes.len() || bytes[index] != b'"' {
                    return None;
                }
                let (value, _) = scan_json_string(bytes, index)?;
                return match value {
                    b"message" => Some("message"),
                    b"compaction" => Some("compaction"),

                    b"sleep" => Some("sleep"),
                    b"session" => Some("session"),
                    b"revision" => Some("revision"),
                    b"revision_live" => Some("revision_live"),
                    _ => None,
                };
            }
            b'{' | b'[' => {
                depth += 1;
                index += 1;
            }
            b'}' | b']' => {
                depth -= 1;
                index += 1;
                if depth == 0 {
                    return None;
                }
            }
            _ => index += 1,
        }
    }
    None
}

/// Read one JSON string starting at the opening quote in `bytes[start]`.
///
/// Returns the raw (still-escaped) contents and the index just past the closing
/// quote. Escapes only need to be stepped over, never decoded: the keys and
/// values this scanner compares against contain no escapable characters.
fn scan_json_string(bytes: &[u8], start: usize) -> Option<(&[u8], usize)> {
    let mut index = start + 1;
    while index < bytes.len() {
        match bytes[index] {
            b'\\' => index += 2,
            b'"' => return Some((&bytes[start + 1..index], index + 1)),
            _ => index += 1,
        }
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

/// Bumped when the in-flight checkpoint shape changes incompatibly.
pub const INFLIGHT_SCHEMA: i64 = 1;

/// The assistant message currently streaming for one session, checkpointed
/// so a quit or crash mid-reply keeps the text the user already saw (D299).
///
/// One file per session, overwritten atomically on every checkpoint; it is
/// never appended to and never read by the sidecar. `turn_id` ties it to the
/// durable turn so recovery can tell a live reply from a stale leftover.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InflightRecord {
    pub schema: i64,
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    /// RFC3339 stamp of the checkpoint itself.
    pub saved_at: String,
    pub message: MessageRecord,
}

pub fn inflight_path(data_dir: &Path, session_id: &str) -> Result<PathBuf> {
    path_for(data_dir, session_id, ".inflight.json")
}

/// Atomically replace the session's in-flight checkpoint.
pub fn write_inflight(data_dir: &Path, session_id: &str, record: &InflightRecord) -> Result<()> {
    let path = inflight_path(data_dir, session_id)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("json.tmp");
    {
        let mut file = File::create(&tmp)?;
        file.write_all(serde_json::to_string(record)?.as_bytes())?;
        file.write_all(b"\n")?;
        file.flush()?;
        file.sync_data()?;
    }
    swap_into_place(&tmp, &path)
}

/// Load the session's in-flight checkpoint. A missing or unreadable file is
/// `None`: a torn checkpoint is worth less than the transcript it would sit in.
pub fn read_inflight(data_dir: &Path, session_id: &str) -> Result<Option<InflightRecord>> {
    let path = inflight_path(data_dir, session_id)?;
    let raw = match fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e).with_context(|| format!("read {}", path.display())),
    };
    match serde_json::from_str::<InflightRecord>(raw.trim()) {
        Ok(record) if record.schema == INFLIGHT_SCHEMA => Ok(Some(record)),
        Ok(_) => Ok(None),
        Err(error) => {
            tracing::warn!(path = %path.display(), %error, "skipping invalid inflight checkpoint");
            Ok(None)
        }
    }
}

/// Remove the session's in-flight checkpoint; a missing file is not an error.
pub fn remove_inflight(data_dir: &Path, session_id: &str) -> Result<()> {
    let path = inflight_path(data_dir, session_id)?;
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e).with_context(|| format!("remove {}", path.display())),
    }
}

/// Session ids that currently own an in-flight checkpoint file.
pub fn list_inflight_sessions(data_dir: &Path) -> Result<Vec<String>> {
    let dir = base_dir(data_dir);
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e).with_context(|| format!("read {}", dir.display())),
    };
    let mut ids = Vec::new();
    for entry in entries {
        let name = entry?.file_name();
        let Some(name) = name.to_str() else { continue };
        if let Some(id) = name.strip_suffix(".inflight.json") {
            if safe_session_id(id) {
                ids.push(id.to_string());
            }
        }
    }
    ids.sort();
    Ok(ids)
}

/// Session ids that still have a live transcript file. Used to restore a
/// missing SQLite sessions row after a WAL/index loss (D318).
pub fn list_transcript_sessions(data_dir: &Path) -> Result<Vec<String>> {
    let dir = base_dir(data_dir);
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e).with_context(|| format!("read {}", dir.display())),
    };
    let mut ids = Vec::new();
    for entry in entries {
        let name = entry?.file_name();
        let Some(name) = name.to_str() else { continue };
        if let Some(id) = name.strip_suffix(".jsonl") {
            if id.ends_with(".revisions") {
                continue;
            }
            if safe_session_id(id) {
                ids.push(id.to_string());
            }
        }
    }
    ids.sort();
    Ok(ids)
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
    } else if !ends_with_newline(path)? {
        // A crash mid-append left a torn tail. `scan_layout` tolerates it on
        // read, but appending straight after it would fuse the torn bytes and
        // this record into one invalid line and lose both. Terminate the torn
        // line first so this record starts on its own line.
        buf.push('\n');
    }
    buf.push_str(&line);
    buf.push('\n');
    file.write_all(buf.as_bytes())?;
    file.flush()?;
    // Message durability matches the DB's WAL synchronous=NORMAL guarantees.
    file.sync_data()?;
    Ok(())
}

/// Whether a non-empty file ends in a newline; an empty file counts as
/// terminated so the header path above stays untouched.
fn ends_with_newline(path: &Path) -> Result<bool> {
    let mut file = File::open(path)?;
    let len = file.metadata()?.len();
    if len == 0 {
        return Ok(true);
    }
    file.seek(SeekFrom::End(-1))?;
    let mut last = [0u8; 1];
    std::io::Read::read_exact(&mut file, &mut last)?;
    Ok(last[0] == b'\n')
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

/// Append a sleep-time digest without rewriting visible messages. It is
/// informational only: the layout skips it, and no reader treats it as recovery
/// state (ADR 0301).
pub fn append_sleep(data_dir: &Path, session_id: &str, record: &SleepRecord) -> Result<()> {
    let path = transcript_path(data_dir, session_id)?;
    append_line(
        &path,
        Some(header_line(session_id, "1970-01-01T00:00:00Z")?),
        tagged("sleep", record)?,
    )
    .with_context(|| format!("append sleep {}", path.display()))
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
    let mut wanted: Vec<(u64, bool)> =
        Vec::with_capacity(end.saturating_sub(start) + layout.compaction_offsets.len());
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
                let selected = index >= message_start && end.is_none_or(|limit| index < limit);
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

/// Swap a fully written temp file over its target, atomically.
///
/// Both platforms replace the target in place: POSIX `rename(2)`, and on
/// Windows `std::fs::rename` is `MoveFileExW(..., MOVEFILE_REPLACE_EXISTING)`.
/// The Windows arm used to `remove_file` first ("Windows cannot rename over an
/// existing file", D010) — but it can, and between that delete and the rename
/// the live transcript did not exist: a failure there lost the whole history
/// while its replacement sat in the temp file. Without the delete, a failed
/// swap leaves the old transcript untouched and keeps the temp file, so the
/// caller can still recover the newest content by hand.
fn swap_into_place(tmp: &Path, path: &Path) -> Result<()> {
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

/// Append the reference line for a branch that is still live. Cheap by
/// construction: this is the line every finished turn writes, so it must not
/// scale with the branch it names.
pub fn append_live_revision(
    data_dir: &Path,
    session_id: &str,
    record: &LiveRevisionRecord,
) -> Result<()> {
    let path = revisions_path(data_dir, session_id)?;
    append_line(&path, None, tagged("revision_live", record)?)
        .with_context(|| format!("append revisions {}", path.display()))
}
/// The kind and the family keys at the top level of one revisions line, read
/// without decoding the line.
///
/// `serde_json` sorts the object it serializes, so `messages` sits between
/// `type` and the family keys and a decoder has to walk the whole payload to
/// reach them. This walks the object's top level and skips each value by depth
/// instead, so a multi-megabyte snapshot belonging to another branch costs a
/// byte scan and no allocation.
///
/// It reads the keys the record itself would carry, nested keys and strings
/// that only look like keys are never considered, so the caller can decide a
/// match on this alone. A line that is not a `revision` / `revision_live`
/// record — including one torn before its last key, which cannot be read at all
/// — returns `None`.
fn revision_line_head(line: &str) -> Option<(&'static str, &str, i64)> {
    let bytes = line.as_bytes();
    let mut index = 0usize;
    while index < bytes.len() && bytes[index].is_ascii_whitespace() {
        index += 1;
    }
    if index >= bytes.len() || bytes[index] != b'{' {
        return None;
    }
    index += 1;
    let mut depth = 1usize;
    let mut kind: Option<&'static str> = None;
    let mut root: Option<&str> = None;
    let mut revision: Option<i64> = None;
    while index < bytes.len() {
        match bytes[index] {
            b'"' => {
                let (key, next) = scan_json_string(bytes, index)?;
                index = next;
                // A top-level member is a key only when ':' follows it; a string
                // in value position is stepped over by the next iteration.
                if depth != 1 {
                    continue;
                }
                let mut colon = index;
                while colon < bytes.len() && bytes[colon].is_ascii_whitespace() {
                    colon += 1;
                }
                if colon >= bytes.len() || bytes[colon] != b':' {
                    continue;
                }
                index = colon + 1;
                while index < bytes.len() && bytes[index].is_ascii_whitespace() {
                    index += 1;
                }
                match key {
                    b"type" => {
                        if bytes.get(index) != Some(&b'"') {
                            return None;
                        }
                        let (value, next) = scan_json_string(bytes, index)?;
                        kind = match value {
                            b"revision" => Some("revision"),
                            b"revision_live" => Some("revision_live"),
                            _ => return None,
                        };
                        index = next;
                    }
                    b"rootUserId" => {
                        if bytes.get(index) != Some(&b'"') {
                            return None;
                        }
                        let (value, next) = scan_json_string(bytes, index)?;
                        root = Some(std::str::from_utf8(value).ok()?);
                        index = next;
                    }
                    b"revisionIndex" => {
                        let start = index;
                        while index < bytes.len()
                            && (bytes[index].is_ascii_digit() || bytes[index] == b'-')
                        {
                            index += 1;
                        }
                        revision = Some(
                            std::str::from_utf8(&bytes[start..index])
                                .ok()?
                                .parse::<i64>()
                                .ok()?,
                        );
                    }
                    _ => {}
                }
                if let (Some(kind), Some(root), Some(revision)) = (kind, root, revision) {
                    return Some((kind, root, revision));
                }
            }
            b'{' | b'[' => {
                depth += 1;
                index += 1;
            }
            b'}' | b']' => {
                depth -= 1;
                index += 1;
                if depth == 0 {
                    return None;
                }
            }
            _ => index += 1,
        }
    }
    None
}

/// Find one archived branch by its family key and index. The LAST matching line
/// that decodes wins: a crash between file append and index commit can leave a
/// duplicate on disk, the newest line is the one the DB accepted, and a line
/// torn mid-append must not answer for the copy behind it.
///
/// The file is streamed once to record where its matching lines are, and only
/// the newest of them is decoded. Both halves matter for size. `serde_json`
/// sorts the object it serializes, so `messages` sits *before* the family keys
/// and a decoder has to walk the whole payload to reach them; and every refresh
/// of one branch repeats that branch's key, so matching alone would decode the
/// branch once per refresh. A real 107 MB file of eleven snapshots decoded ten
/// of them — 102 MB — to answer with the eleventh.
///
/// `revision_line_head` reads the top level instead of decoding it, so the
/// match decision is the record's own keys and nothing else: text inside a tool
/// result that happens to be spelled like a family key is not a key, and cannot
/// answer for a family it does not belong to.
///
/// A live reference resolves against the transcript, so a branch that is still
/// live is returned without the file holding a second copy of it.
pub fn read_revision(
    data_dir: &Path,
    session_id: &str,
    root_user_id: &str,
    revision_index: i64,
) -> Result<Option<RevisionPayload>> {
    let path = revisions_path(data_dir, session_id)?;
    let file = match File::open(&path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e).with_context(|| format!("read {}", path.display())),
    };
    // (byte offset, line kind) of every matching line, oldest first.
    let mut matches: Vec<(u64, &'static str)> = Vec::new();
    let mut reader = BufReader::new(file);
    let mut line = String::new();
    let mut offset = 0u64;
    loop {
        // A rejected snapshot must not leave its capacity attached to every
        // following read.
        if line.capacity() > 1024 * 1024 {
            line = String::new();
        }
        line.clear();
        let read = reader.read_line(&mut line)?;
        if read == 0 {
            break;
        }
        // A torn trailing line has no newline yet. `append_line` terminates it
        // before the next record, which turns it into a complete line that this
        // head read rejects on its own; until then there is nothing after it to
        // find, so the scan is done.
        if !line.ends_with('\n') {
            break;
        }
        if let Some((kind, root, index)) = revision_line_head(line.trim()) {
            if root == root_user_id && index == revision_index {
                matches.push((offset, kind));
            }
        }
        offset += read as u64;
    }
    for (offset, kind) in matches.iter().rev() {
        if line.capacity() > 1024 * 1024 {
            line = String::new();
        }
        line.clear();
        reader.seek(SeekFrom::Start(*offset))?;
        if reader.read_line(&mut line)? == 0 {
            continue;
        }
        let body = line.trim();
        let decoded = if *kind == "revision_live" {
            serde_json::from_str::<LiveRevisionRecord>(body)
                .ok()
                .map(RevisionPayload::Live)
        } else {
            serde_json::from_str::<RevisionRecord>(body)
                .ok()
                .map(RevisionPayload::Stored)
        };
        if decoded.is_some() {
            return Ok(decoded);
        }
    }
    Ok(None)
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
    let Ok(inflight) = inflight_path(data_dir, session_id) else {
        return;
    };
    for path in [
        transcript.with_extension("jsonl.tmp"),
        transcript,
        revisions,
        inflight.with_extension("json.tmp"),
        inflight,
    ] {
        if let Err(error) = fs::remove_file(&path) {
            if error.kind() != std::io::ErrorKind::NotFound {
                tracing::warn!(path = %path.display(), %error, "transcript cleanup failed");
            }
        }
    }
}

/// One recall hit: a message whose text matched the query.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecallHit {
    pub id: String,
    pub role: String,
    pub created_at: String,
    /// Zero-based position of the message in transcript file order.
    pub index: usize,
    /// Bounded window around the first match (search), or leading text (tail).
    pub snippet: String,
}

/// Recall result plus the session's total message count, so a model can
/// tell when it has seen the whole history.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecallResult {
    pub hits: Vec<RecallHit>,
    pub total_messages: usize,
}

/// A message's searchable text: the top-level `text` fields of its canonical
/// blocks. Thinking and tool payloads are out of scope for P1 recall.
fn recall_text(blocks: &Value) -> String {
    let mut out = String::new();
    if let Some(items) = blocks.as_array() {
        for block in items {
            if let Some(text) = block.get("text").and_then(Value::as_str) {
                if !out.is_empty() {
                    out.push('\n');
                }
                out.push_str(text);
            }
        }
    }
    out
}

/// Query words: whitespace-separated, case-folded (ASCII bytes for ASCII words,
/// Unicode for the rest), de-duplicated in the order written. Empty input means
/// "no query", which reads the tail.
fn recall_terms(query: &str) -> Vec<String> {
    let mut terms: Vec<String> = Vec::new();
    for word in query.split_whitespace() {
        // ASCII words keep the byte-level fold they always had; a non-ASCII
        // word folds through Unicode, because ASCII folding cannot see that
        // `ПРИВЕТ` and `привет` are the same word.
        let term = if word.is_ascii() {
            word.to_ascii_lowercase()
        } else {
            word.to_lowercase()
        };
        if !terms.contains(&term) {
            terms.push(term);
        }
    }
    terms
}

/// ASCII case-insensitive substring search that copies nothing.
///
/// The previous path lowercased the whole message before searching, which
/// allocated a copy of every message examined on every query — transcripts are
/// dominated by tool output and reach tens of megabytes. Folding case per
/// candidate byte is the same comparison (ASCII-only, exactly as before)
/// without the copy: case never folds across a multi-byte character, so a
/// byte-wise scan is equivalent for ASCII and non-ASCII needles alike.
fn find_ignore_ascii_case(haystack: &str, needle: &str) -> Option<usize> {
    if needle.is_empty() {
        return Some(0);
    }
    let hay = haystack.as_bytes();
    let nee = needle.as_bytes();
    if nee.len() > hay.len() {
        return None;
    }
    (0..=hay.len() - nee.len())
        .find(|start| hay[*start..*start + nee.len()].eq_ignore_ascii_case(nee))
}

/// One query word against one line of text: the ASCII path stays the byte scan
/// every ASCII query already took; a non-ASCII word folds per character on both
/// sides, because ASCII folding cannot see a Cyrillic or accented case pair.
fn find_ignore_case(haystack: &str, needle: &str) -> Option<usize> {
    if needle.is_ascii() {
        find_ignore_ascii_case(haystack, needle)
    } else {
        find_ignore_case_unicode(haystack, needle)
    }
}

/// Char-wise case-insensitive search for non-ASCII needles, returning the byte
/// offset of the first matched character.
///
/// Folding is per `char`, not per byte: `to_lowercase` can map one character to
/// several (`İ` → `i̇`) or to a different byte length, so the folded streams are
/// compared character by character. This path allocates the folded needle and
/// re-slices the haystack per start position — the price of correct folding for
/// the non-ASCII queries that need it, which ASCII queries never take.
fn find_ignore_case_unicode(haystack: &str, needle: &str) -> Option<usize> {
    let folded_needle: Vec<char> = needle.chars().flat_map(char::to_lowercase).collect();
    if folded_needle.is_empty() {
        return Some(0);
    }
    for (start, _) in haystack.char_indices() {
        let mut matched = 0usize;
        let mut mismatched = false;
        for character in haystack[start..].chars() {
            for folded in character.to_lowercase() {
                if matched >= folded_needle.len() || folded_needle[matched] != folded {
                    mismatched = true;
                    break;
                }
                matched += 1;
            }
            if mismatched || matched == folded_needle.len() {
                break;
            }
        }
        if !mismatched && matched == folded_needle.len() {
            return Some(start);
        }
    }
    None
}

/// True when a term must appear literally in the raw JSON line, so a line that
/// does not contain it can be skipped without parsing (and without a copy).
///
/// A term carrying a JSON escape (`"`, `\`) or a control character is written
/// into the line in its escaped form, where the raw bytes differ from the term
/// itself; the pre-filter would then report a false negative, so it is disabled
/// for the whole query when any term is like that.
fn raw_scan_is_conclusive(terms: &[String]) -> bool {
    terms.iter().all(|term| {
        // Raw-byte matching is ASCII-only: a non-ASCII term folds in a way the
        // bytes do not show, so the whole query gives up the pre-filter instead
        // of reporting a false negative.
        term.is_ascii()
            && !term.is_empty()
            && !term.contains(['"', '\\'])
            && !term.chars().any(char::is_control)
    })
}

/// Case-insensitive search over a session's full transcript.
///
/// Session isolation is host-enforced: the transcript path derives from
/// `session_id` alone, so a caller can only recall its own session. An empty or
/// blank query reads the tail: the newest `limit` messages, oldest-first, with
/// leading-text snippets. A query returns the newest `limit` hits first, each
/// with a bounded snippet around its first match.
///
/// A query is read as **words**: a message matches when every word appears in
/// it, so `retry budget` finds a message that says "the retry spent its budget"
/// even though the phrase never appears. A single word behaves exactly as the
/// old substring search did, and hit order stays newest-first either way.
///
/// Two costs were paid on every call before and are not any more: the tail read
/// now seeks to the newest messages through the layout instead of parsing the
/// whole file, and a query skips JSON parsing for any line whose raw bytes
/// cannot contain the words.
pub fn recall_transcript(
    data_dir: &Path,
    session_id: &str,
    query: Option<&str>,
    limit: usize,
) -> Result<RecallResult> {
    let terms = query.map(recall_terms).unwrap_or_default();
    if terms.is_empty() {
        return recall_tail(data_dir, session_id, limit);
    }
    recall_matches(data_dir, session_id, &terms, limit)
}

/// Read the trimmed line at a known message offset, or `None` at end of file.
///
/// Shared by the two recall walks so both report the same coordinate space:
/// an index is a position among message *lines*, and a line that cannot be
/// parsed drops out of the hits without shifting the indexes around it.
fn read_message_line_at<'a>(
    reader: &mut BufReader<File>,
    offset: u64,
    line: &'a mut String,
    path: &Path,
) -> Result<Option<&'a str>> {
    reader
        .seek(SeekFrom::Start(offset))
        .with_context(|| format!("seek {}", path.display()))?;
    line.clear();
    if reader
        .read_line(line)
        .with_context(|| format!("read {}", path.display()))?
        == 0
    {
        return Ok(None);
    }
    let trimmed = line.trim();
    Ok(if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    })
}

/// Tail read: the newest `limit` messages, oldest-first, by seeking to their
/// offsets instead of parsing the whole file.
fn recall_tail(data_dir: &Path, session_id: &str, limit: usize) -> Result<RecallResult> {
    let layout = refresh_layout(data_dir, session_id, TranscriptLayout::default())?;
    let total = layout.message_count();
    if total == 0 || limit == 0 {
        return Ok(RecallResult {
            hits: Vec::new(),
            total_messages: total,
        });
    }
    let path = transcript_path(data_dir, session_id)?;
    let file = match File::open(&path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(RecallResult {
                hits: Vec::new(),
                total_messages: 0,
            })
        }
        Err(e) => return Err(e).with_context(|| format!("read {}", path.display())),
    };
    let mut reader = BufReader::new(file);
    let mut line = String::new();
    let mut hits: Vec<RecallHit> = Vec::new();
    for index in total.saturating_sub(limit)..total {
        if line.capacity() > 1024 * 1024 {
            line = String::new();
        }
        let Some(trimmed) =
            read_message_line_at(&mut reader, layout.message_offsets[index], &mut line, &path)?
        else {
            continue;
        };
        let Ok(record) = serde_json::from_str::<MessageRecord>(trimmed) else {
            tracing::warn!(path = %path.display(), index, "skipping invalid message line");
            continue;
        };
        hits.push(RecallHit {
            id: record.id.clone(),
            role: record.role.clone(),
            created_at: record.created_at.clone(),
            index,
            snippet: recall_text(&record.blocks).chars().take(400).collect(),
        });
    }
    Ok(RecallResult {
        hits,
        total_messages: total,
    })
}

/// How many candidate messages the ranked walk collects before ordering: a
/// small multiple of `limit` with a floor and a ceiling, so a broad query pays
/// a bounded amount of extra parsing and a narrow one pays almost nothing.
const RECALL_RANK_WINDOW_PER_HIT: usize = 6;
const RECALL_RANK_WINDOW_MIN: usize = 40;
const RECALL_RANK_WINDOW_MAX: usize = 200;
/// Occurrences counted per query word; a message repeating one word forever
/// must not outrank one that covers the whole query.
const RECALL_RANK_MAX_TERM_HITS: u32 = 8;

/// Match strength of one message: how many occurrences of how many query words
/// it carries, counted with the same case folding the match itself uses. The
/// score ranks candidates against each other; it is never returned to the
/// model, so its scale is private.
fn match_score(text: &str, terms: &[String]) -> u32 {
    let mut score = 0u32;
    for term in terms {
        let mut from = 0usize;
        let mut seen = 0u32;
        while seen < RECALL_RANK_MAX_TERM_HITS {
            let Some(at) = text
                .get(from..)
                .and_then(|rest| find_ignore_case(rest, term))
            else {
                break;
            };
            seen += 1;
            // Advance past the first character of the match: a folded match can
            // differ from the term in bytes, but it always starts on a
            // character boundary.
            let step = text[from + at..]
                .chars()
                .next()
                .map(char::len_utf8)
                .unwrap_or(1);
            from += at + step;
        }
        score += seen;
    }
    score
}

/// Message-line search: every match inside the ranking window, best first.
///
/// The reverse walk goes through the layout's offsets, so the peak cost is the
/// snippets it returns plus the layout — not a vector of every hit. Candidates
/// are collected newest-first up to `window`, then ordered by match strength
/// with recency as the tie-break, so the model reads the most relevant message
/// first without the walk having to scan the whole transcript. One deliberate
/// difference from the old path: `total_messages` and every hit's `index` count
/// message *lines* (the layout's coordinate space) rather than successfully
/// parsed records, so a corrupt line is counted, keeps its slot, and never
/// matches where it used to shift everything after it.
fn recall_matches(
    data_dir: &Path,
    session_id: &str,
    terms: &[String],
    limit: usize,
) -> Result<RecallResult> {
    let layout = refresh_layout(data_dir, session_id, TranscriptLayout::default())?;
    let total = layout.message_count();
    let path = transcript_path(data_dir, session_id)?;
    let file = match File::open(&path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(RecallResult {
                hits: Vec::new(),
                total_messages: 0,
            })
        }
        Err(e) => return Err(e).with_context(|| format!("read {}", path.display())),
    };
    let conclusive = raw_scan_is_conclusive(terms);
    let mut reader = BufReader::new(file);
    let mut line = String::new();
    let window = limit
        .saturating_mul(RECALL_RANK_WINDOW_PER_HIT)
        .max(RECALL_RANK_WINDOW_MIN)
        .min(RECALL_RANK_WINDOW_MAX);
    let mut hits: Vec<RecallHit> = Vec::new();
    let mut scores: Vec<u32> = Vec::new();
    for index in (0..total).rev() {
        if line.capacity() > 1024 * 1024 {
            line = String::new();
        }
        let Some(trimmed) =
            read_message_line_at(&mut reader, layout.message_offsets[index], &mut line, &path)?
        else {
            continue;
        };
        if conclusive
            && !terms
                .iter()
                .all(|term| find_ignore_case(trimmed, term).is_some())
        {
            continue;
        }
        let Ok(record) = serde_json::from_str::<MessageRecord>(trimmed) else {
            tracing::warn!(path = %path.display(), index, "skipping invalid message line");
            continue;
        };
        let text = recall_text(&record.blocks);
        // The pre-filter above is an optimization on the raw line; the
        // authoritative check runs on the parsed text, because a term carrying
        // a non-ASCII character (or one JSON escapes) cannot be matched
        // against raw bytes — and a query means every word, not any word.
        if !terms
            .iter()
            .all(|term| find_ignore_case(&text, term).is_some())
        {
            continue;
        }
        let Some((pos, len)) = terms
            .iter()
            .filter_map(|term| find_ignore_case(&text, term).map(|at| (at, term.len())))
            .min_by_key(|(at, _)| *at)
        else {
            continue;
        };
        let start = text.floor_char_boundary(pos.saturating_sub(120));
        let end = text.ceil_char_boundary((pos + len).saturating_add(280).min(text.len()));
        hits.push(RecallHit {
            id: record.id.clone(),
            role: record.role.clone(),
            created_at: record.created_at.clone(),
            index,
            snippet: text[start..end].to_string(),
        });
        scores.push(match_score(&text, terms));
        if hits.len() >= window {
            break;
        }
    }
    // Order without cloning: take the collected hits, then move each one out of
    // its slot in ranked order (match strength first, then recency).
    if hits.len() > 1 {
        let mut order: Vec<usize> = (0..hits.len()).collect();
        order.sort_by(|left, right| {
            scores[*right]
                .cmp(&scores[*left])
                .then(hits[*right].index.cmp(&hits[*left].index))
        });
        let mut slots: Vec<Option<RecallHit>> =
            std::mem::take(&mut hits).into_iter().map(Some).collect();
        hits = order
            .into_iter()
            .map(|slot| slots[slot].take().expect("each ordered index appears once"))
            .collect();
    }
    hits.truncate(limit);
    Ok(RecallResult {
        hits,
        total_messages: total,
    })
}

/// Default and maximum size of one [`read_message_text`] page.
pub const MESSAGE_TEXT_DEFAULT_CHARS: usize = 8_000;
pub const MESSAGE_TEXT_MAX_CHARS: usize = 20_000;

/// One bounded page of a single message's text, read from the transcript.
///
/// `recall` answers "where does this string appear"; this answers "what does
/// this message say". Both read the append-only transcript — the only place
/// tool text lives, since the index row deliberately stores none for tool rows
/// — so a message the working window narrowed away stays readable page by page
/// (ADR 0300). Offsets are in characters, never bytes, so a page boundary can
/// never split a multi-byte character.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageTextWindow {
    pub message_id: String,
    pub role: String,
    pub created_at: String,
    /// Zero-based position of the message in transcript file order.
    pub index: usize,
    /// Characters in the whole message, so a caller can page until it has all.
    pub total_chars: usize,
    /// Character offset this page starts at (clamped to `total_chars`).
    pub offset: usize,
    pub text: String,
    pub has_more: bool,
    /// Where the next page starts, in characters. Returned rather than derived
    /// by the caller: the host counts characters while JavaScript string
    /// lengths count UTF-16 units, and the two disagree on astral characters.
    pub next_offset: usize,
}

/// Read one page of one message's text. `None` means the session or the
/// message id is not in this transcript (a missing session reads as empty,
/// exactly like `recall_transcript`).
pub fn read_message_text(
    data_dir: &Path,
    session_id: &str,
    message_id: &str,
    offset: usize,
    max_chars: usize,
) -> Result<Option<MessageTextWindow>> {
    let read = read_transcript_window(data_dir, session_id, 0, None)?;
    let Some((index, record)) = read
        .messages
        .iter()
        .enumerate()
        .find(|(_, record)| record.id == message_id)
    else {
        return Ok(None);
    };
    let text = recall_text(&record.blocks);
    let total_chars = text.chars().count();
    let offset = offset.min(total_chars);
    let page: String = text.chars().skip(offset).take(max_chars).collect();
    let page_chars = page.chars().count();
    Ok(Some(MessageTextWindow {
        message_id: record.id.clone(),
        role: record.role.clone(),
        created_at: record.created_at.clone(),
        index,
        total_chars,
        offset,
        text: page,
        has_more: offset + page_chars < total_chars,
        next_offset: offset + page_chars,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::tempdir;

    #[test]
    fn sleep_append_is_append_only_and_never_counts_as_a_message() {
        let dir = tempdir().unwrap();
        append_message(
            dir.path(),
            "s1",
            "2026-07-26T00:00:00Z",
            &record("m1", "one"),
        )
        .unwrap();
        let record = SleepRecord {
            id: "sleep-1".into(),
            digest: "## Goal\nthe ask".into(),
            through_message_id: "m1".into(),
            message_count: 1,
            created_at: "2026-07-26T00:00:02Z".into(),
        };
        append_sleep(dir.path(), "s1", &record).unwrap();

        // A digest append must not rewrite earlier lines...
        let layout = refresh_layout(dir.path(), "s1", TranscriptLayout::default()).unwrap();
        assert_eq!(layout.message_count(), 1, "a sleep line is not a message");
        // ...and the line classifies as its own kind, not as unknown noise.
        let path = transcript_path(dir.path(), "s1").unwrap();
        let last = std::fs::read_to_string(path)
            .unwrap()
            .lines()
            .last()
            .unwrap()
            .to_string();
        assert_eq!(sniff_line_kind(&last), Some("sleep"));
        assert_eq!(read_transcript(dir.path(), "s1").unwrap().len(), 1);
    }

    #[test]
    fn recall_matches_every_word_and_ranks_by_strength() {
        let dir = tempdir().unwrap();
        append_message(
            dir.path(),
            "s1",
            "2026-07-26T00:00:00Z",
            &record("m1", "the retry spent its budget"),
        )
        .unwrap();
        append_message(
            dir.path(),
            "s1",
            "2026-07-26T00:00:01Z",
            &record("m2", "unrelated talk"),
        )
        .unwrap();
        append_message(
            dir.path(),
            "s1",
            "2026-07-26T00:00:02Z",
            &record("m3", "retry budget retry budget retry"),
        )
        .unwrap();

        let result = recall_transcript(dir.path(), "s1", Some("retry budget"), 10).unwrap();
        assert_eq!(result.total_messages, 3);
        // m3 carries the query words most often, so it ranks first despite being newest-tied.
        assert_eq!(result.hits[0].id, "m3");
        assert_eq!(result.hits.len(), 2, "m2 matches neither word");
    }

    #[test]
    fn recall_reads_a_non_ascii_word_without_ascii_folding() {
        let dir = tempdir().unwrap();
        append_message(
            dir.path(),
            "s1",
            "2026-07-26T00:00:00Z",
            &record("m1", "код вернулся"),
        )
        .unwrap();
        let upper = recall_transcript(dir.path(), "s1", Some("КОД"), 10).unwrap();
        assert_eq!(
            upper.hits.len(),
            1,
            "a Cyrillic case pair must fold through Unicode"
        );
    }

    #[test]
    fn read_message_text_pages_forward_in_characters() {
        let dir = tempdir().unwrap();
        let long = "д".repeat(50);
        append_message(
            dir.path(),
            "s1",
            "2026-07-26T00:00:00Z",
            &record("m1", &long),
        )
        .unwrap();
        let page = read_message_text(dir.path(), "s1", "m1", 10, 20)
            .unwrap()
            .expect("found");
        assert_eq!(page.offset, 10);
        assert_eq!(page.text.chars().count(), 20);
        assert!(page.has_more);
        assert_eq!(page.next_offset, 30);
        let rest = read_message_text(dir.path(), "s1", "m1", 30, 100)
            .unwrap()
            .expect("found");
        assert_eq!(rest.text.chars().count(), 20);
        assert!(!rest.has_more);
        assert!(read_message_text(dir.path(), "s1", "nope", 0, 10)
            .unwrap()
            .is_none());
    }
    #[test]
    fn append_after_torn_tail_terminates_the_torn_line_first() {
        let dir = tempdir().unwrap();
        append_message(
            dir.path(),
            "s1",
            "2026-07-26T00:00:00Z",
            &record("m1", "one"),
        )
        .unwrap();
        let path = dir.path().join("sessions").join("s1.jsonl");
        // Simulate a crash mid-append: a partial record without its newline.
        {
            let mut file = OpenOptions::new().append(true).open(&path).unwrap();
            file.write_all(br#"{"type":"message","id":"torn""#).unwrap();
        }
        append_message(
            dir.path(),
            "s1",
            "2026-07-26T00:00:00Z",
            &record("m2", "two"),
        )
        .unwrap();
        let read = read_transcript(dir.path(), "s1").unwrap();
        let ids: Vec<&str> = read.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["m1", "m2"],
            "the record after a torn tail must survive"
        );
    }

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
            tokens_after: Some(21_000),
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
        append_message(
            dir.path(),
            "s1",
            "2026-07-26T00:00:00Z",
            &record("m4", "m4"),
        )
        .unwrap();
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
        let sequential_ids: Vec<&str> = sequential.messages.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, sequential_ids);
    }

    #[test]
    fn layout_window_always_returns_the_whole_compaction_chain() {
        let dir = tempdir().unwrap();
        append_message(
            dir.path(),
            "s1",
            "2026-07-26T00:00:00Z",
            &record("m1", "one"),
        )
        .unwrap();
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
        fs::write(&path, format!("{legacy_header}\n{legacy_message}\n")).unwrap();

        assert_eq!(
            sniff_line_kind(&legacy_message.to_string()),
            Some("message")
        );
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
    fn nested_type_keys_never_decide_a_line_kind() {
        // Tool results and checkpoint details are open-ended JSON. A nested
        // object can carry its own `type` naming a line kind, and in the legacy
        // key order it appears before the real discriminator. Only the top-level
        // key may decide the line.
        let legacy_compaction = json!({
            "createdAt": "2026-07-26T00:00:00Z",
            "details": { "echo": { "type": "message" } },
            "id": "c1",
            "summary": "s",
            "throughMessageId": "m1",
            "tokensBefore": 1,
            "type": "compaction",
        });
        assert_eq!(
            sniff_line_kind(&legacy_compaction.to_string()),
            Some("compaction"),
        );

        // A nested `type` inside a tool payload does not turn a message into
        // something else, and an escaped one inside a string is inert.
        let message = json!({
            "type": "message",
            "id": "m1",
            "role": "tool",
            "blocks": [{ "type": "tool_call", "result": { "text": "{\"type\":\"session\"}" } }],
            "createdAt": "2026-07-26T00:00:00Z",
        });
        assert_eq!(sniff_line_kind(&message.to_string()), Some("message"));

        // An object with no top-level discriminator is not a transcript line,
        // however many nested ones it contains.
        assert_eq!(
            sniff_line_kind(&json!({ "blocks": [{ "type": "message" }] }).to_string()),
            None,
        );
        // Nor is a bare array, a truncated object, or a non-object.
        assert_eq!(sniff_line_kind("[{\"type\":\"message\"}]"), None);
        assert_eq!(sniff_line_kind("{\"type\":\"mess"), None);
        assert_eq!(sniff_line_kind("null"), None);
        // A line whose payload is bigger than any bounded prefix is still
        // classified from its real key.
        let huge = json!({
            "blocks": [{ "type": "text", "text": "x".repeat(200_000) }],
            "createdAt": "2026-07-26T00:00:00Z",
            "id": "m2",
            "isError": false,
            "role": "assistant",
            "type": "message",
        });
        assert_eq!(sniff_line_kind(&huge.to_string()), Some("message"));
    }

    #[test]
    fn sniffing_classifies_lines_without_full_parsing() {
        assert_eq!(
            sniff_line_kind(r#"{"type":"message","id":"m1"}"#),
            Some("message")
        );
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
        // The post-compaction estimate rides the record so the context ring can
        // report the new window without waiting for the next provider request.
        assert_eq!(restored[0].tokens_after, Some(21_000));
    }

    /// A checkpoint written before the post-compaction estimate existed must
    /// keep loading. The field is optional on the wire, so an old line has no
    /// `tokensAfter` and readers that predate it ignore the new one.
    #[test]
    fn a_checkpoint_without_a_post_compaction_estimate_still_loads() {
        let dir = tempdir().unwrap();
        let path = transcript_path(dir.path(), "s1").unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let header = header_line("s1", "2026-07-26T00:00:00Z").unwrap();
        let legacy = json!({
            "type": "compaction",
            "id": "legacy-1",
            "summary": "summary",
            "throughMessageId": "m1",
            "tokensBefore": 42_000,
            "createdAt": "2026-07-26T00:00:02Z"
        })
        .to_string();
        std::fs::write(&path, format!("{header}\n{legacy}\n")).unwrap();

        let restored = read_compactions(dir.path(), "s1").unwrap();
        assert_eq!(restored.len(), 1);
        assert_eq!(restored[0].id, "legacy-1");
        assert_eq!(restored[0].tokens_before, 42_000);
        assert_eq!(restored[0].tokens_after, None);
    }

    #[test]
    fn every_appended_compaction_survives_a_reload() {
        let dir = tempdir().unwrap();
        append_message(
            dir.path(),
            "s1",
            "2026-07-26T00:00:00Z",
            &record("m1", "one"),
        )
        .unwrap();
        append_compaction(dir.path(), "s1", "2026-07-26T00:00:00Z", &compaction()).unwrap();
        append_message(
            dir.path(),
            "s1",
            "2026-07-26T00:00:00Z",
            &record("m2", "two"),
        )
        .unwrap();
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
    fn swap_replaces_an_existing_target_with_the_temp_content() {
        let dir = tempdir().unwrap();
        let target = dir.path().join("s1.jsonl");
        std::fs::write(&target, b"old content").unwrap();
        let tmp = dir.path().join("s1.jsonl.tmp");
        std::fs::write(&tmp, b"new content").unwrap();
        swap_into_place(&tmp, &target).unwrap();
        assert_eq!(
            std::fs::read(&target).unwrap(),
            b"new content",
            "the replacement must be byte-identical to the temp file"
        );
        assert!(!tmp.exists(), "a successful swap consumes the temp file");
    }

    #[test]
    fn swap_creates_the_target_when_it_does_not_exist() {
        let dir = tempdir().unwrap();
        let target = dir.path().join("s1.jsonl");
        let tmp = dir.path().join("s1.jsonl.tmp");
        std::fs::write(&tmp, b"first").unwrap();
        swap_into_place(&tmp, &target).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"first");
    }

    #[test]
    fn swap_failure_keeps_the_target_and_the_temp_file() {
        let dir = tempdir().unwrap();
        // A directory cannot be replaced by a file, so the swap fails
        // deterministically on every platform.
        let target = dir.path().join("occupied");
        std::fs::create_dir(&target).unwrap();
        let tmp = dir.path().join("s1.jsonl.tmp");
        std::fs::write(&tmp, b"new content").unwrap();

        let error = swap_into_place(&tmp, &target).unwrap_err();

        assert!(!error.to_string().is_empty(), "the failure must surface");
        assert!(
            target.is_dir(),
            "the original target must survive a failed swap"
        );
        assert!(
            tmp.exists(),
            "the temp file must be kept so the caller can recover"
        );
        assert_eq!(
            std::fs::read(&tmp).unwrap(),
            b"new content",
            "the kept temp file still carries the full replacement"
        );
    }

    /// The regression this file exists for: the old Windows arm deleted the live
    /// transcript *before* renaming, so a rename that then failed left no
    /// transcript at all. A locked temp file is how an external scanner makes it
    /// fail, and the swap must keep the old file instead.
    #[cfg(windows)]
    #[test]
    fn swap_failure_on_a_locked_temp_keeps_the_live_transcript() {
        use std::os::windows::fs::OpenOptionsExt;

        let dir = tempdir().unwrap();
        let target = dir.path().join("s1.jsonl");
        std::fs::write(&target, b"precious transcript").unwrap();
        let tmp = dir.path().join("s1.jsonl.tmp");
        std::fs::write(&tmp, b"replacement").unwrap();

        // Hold the temp file the way an external scanner does: readable by
        // others, but without FILE_SHARE_DELETE (0x0000_0001 is
        // FILE_SHARE_READ), so no replacing move can proceed.
        let lock = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0x0000_0001)
            .open(&tmp)
            .unwrap();

        let result = swap_into_place(&tmp, &target);
        drop(lock);

        assert!(result.is_err(), "a locked temp file must fail the swap");
        assert_eq!(
            std::fs::read(&target).unwrap(),
            b"precious transcript",
            "a failed swap must never lose the live transcript"
        );
        assert!(
            tmp.exists(),
            "the temp file must be kept so the caller can recover"
        );
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
            turns: Default::default(),
            root_user_id: "u1".into(),
            revision_index: i,
            created_at: "2026-07-26T00:00:00Z".into(),
            messages: vec![record("m", text)],
        };
        append_revision(dir.path(), "s1", &rev(1, "first")).unwrap();
        append_revision(dir.path(), "s1", &rev(2, "second")).unwrap();

        let found = read_revision(dir.path(), "s1", "u1", 2).unwrap().unwrap();
        let RevisionPayload::Stored(found) = found else {
            panic!("a stored line must read back as a stored payload");
        };
        assert_eq!(found.messages[0].blocks[0]["text"], "second");
        assert!(read_revision(dir.path(), "s1", "u9", 1).unwrap().is_none());
        assert!(read_revision(dir.path(), "s1", "u1", 3).unwrap().is_none());
    }

    /// The two line kinds coexist in one file and the last matching line is the
    /// answer whichever kind it is: a snapshot written by an older build stays
    /// readable, the reference written after it takes over while the branch is
    /// live, and the full copy written when the branch leaves takes over again
    /// without the reference ever having to be removed.
    #[test]
    fn revisions_resolve_the_newest_line_across_kinds() {
        let dir = tempdir().unwrap();
        let stored = |text: &str| RevisionRecord {
            turns: Default::default(),
            root_user_id: "u1".into(),
            revision_index: 1,
            created_at: "2026-07-26T00:00:00Z".into(),
            messages: vec![record("m", text)],
        };
        let live = LiveRevisionRecord {
            root_user_id: "u1".into(),
            revision_index: 1,
            created_at: "2026-07-26T00:00:00Z".into(),
        };

        append_revision(dir.path(), "s1", &stored("archived")).unwrap();
        append_live_revision(dir.path(), "s1", &live).unwrap();
        assert!(
            matches!(
                read_revision(dir.path(), "s1", "u1", 1).unwrap().unwrap(),
                RevisionPayload::Live(_)
            ),
            "the reference written last is the answer"
        );

        append_revision(dir.path(), "s1", &stored("materialized")).unwrap();
        let found = read_revision(dir.path(), "s1", "u1", 1).unwrap().unwrap();
        let RevisionPayload::Stored(found) = found else {
            panic!("the stored line written last is the answer");
        };
        assert_eq!(found.messages[0].blocks[0]["text"], "materialized");
    }

    /// A branch's messages are arbitrary text, and a transcript prints files. A
    /// tool result that happens to contain the compact spelling of another
    /// family's keys must not be that family's answer: the match is decided on
    /// the line's own top-level keys, not on the bytes somewhere inside it.
    #[test]
    fn a_payload_that_spells_another_family_is_not_an_answer() {
        let dir = tempdir().unwrap();
        let decoy = RevisionRecord {
            turns: Default::default(),
            root_user_id: "u1".into(),
            revision_index: 1,
            created_at: "2026-07-26T00:00:00Z".into(),
            messages: vec![record(
                "m",
                "{\"rootUserId\":\"u2\",\"revisionIndex\":7,\"messages\":[]}",
            )],
        };
        append_revision(dir.path(), "s1", &decoy).unwrap();

        assert!(
            read_revision(dir.path(), "s1", "u2", 7).unwrap().is_none(),
            "text inside a payload is not a family key"
        );
        let RevisionPayload::Stored(found) =
            read_revision(dir.path(), "s1", "u1", 1).unwrap().unwrap()
        else {
            panic!("the family the line actually names is still readable");
        };
        assert_eq!(found.messages.len(), 1);
    }

    /// A crash mid-append is terminated by the next append rather than repaired,
    /// so the fragment becomes a complete line whose head reads and whose body
    /// does not. The newest match has to fall back to the copy behind it instead
    /// of answering with nothing.
    #[test]
    fn a_torn_newest_match_falls_back_to_the_stored_copy() {
        let dir = tempdir().unwrap();
        append_revision(
            dir.path(),
            "s1",
            &RevisionRecord {
                turns: Default::default(),
                root_user_id: "u1".into(),
                revision_index: 1,
                created_at: "2026-07-26T00:00:00Z".into(),
                messages: vec![record("m", "intact")],
            },
        )
        .unwrap();
        let path = revisions_path(dir.path(), "s1").unwrap();

        // The bytes a write that died before its final brace leaves behind, after
        // the next append terminated them and added its own record.
        let torn = tagged(
            "revision",
            &RevisionRecord {
                turns: Default::default(),
                root_user_id: "u1".into(),
                revision_index: 1,
                created_at: "2026-07-26T00:00:00Z".into(),
                messages: vec![record("m", "torn")],
            },
        )
        .unwrap();
        assert!(torn.ends_with('}'));
        {
            let mut file = OpenOptions::new().append(true).open(&path).unwrap();
            file.write_all(&torn.as_bytes()[..torn.len() - 1]).unwrap();
            file.write_all(b"\n").unwrap();
        }
        append_revision(
            dir.path(),
            "s1",
            &RevisionRecord {
                turns: Default::default(),
                root_user_id: "u9".into(),
                revision_index: 1,
                created_at: "2026-07-26T00:00:01Z".into(),
                messages: vec![record("m", "other family")],
            },
        )
        .unwrap();

        let RevisionPayload::Stored(found) =
            read_revision(dir.path(), "s1", "u1", 1).unwrap().unwrap()
        else {
            panic!("the intact copy behind the fragment answers");
        };
        assert_eq!(found.messages[0].blocks[0]["text"], "intact");
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
                turns: Default::default(),
            },
        )
        .unwrap();

        remove_session_files(dir.path(), "s1");
        assert!(!transcript_path(dir.path(), "s1").unwrap().exists());
        assert!(!revisions_path(dir.path(), "s1").unwrap().exists());
        remove_session_files(dir.path(), "s1");
    }
}
