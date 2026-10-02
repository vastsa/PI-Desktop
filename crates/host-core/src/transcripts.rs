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
use std::io::{BufRead, BufReader, BufWriter, Read, Seek, SeekFrom, Write};
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

/// Where a transcript's line layout is cached between processes.
///
/// A layout is derived data, and so is this: everything below validates a cache
/// against the file it claims to describe, and any mismatch -- missing, a
/// different file, a shorter file, a count that does not add up -- falls back to
/// the scan that always happened before it existed.
fn layout_cache_path(data_dir: &Path, session_id: &str) -> Result<PathBuf> {
    Ok(transcript_path(data_dir, session_id)?.with_extension("jsonl.layout"))
}

/// Transcripts below this are cheaper to scan than to cache, and no fixture grows
/// a cache file.
const LAYOUT_CACHE_MIN_LEN: u64 = 2 * 1024 * 1024;

/// Store again once the cached layout lags the file by this much, so a writer
/// that runs for hours does not leave the next process a large tail to scan.
const LAYOUT_CACHE_MAX_LAG: u64 = 4 * 1024 * 1024;

/// An identity that an append keeps and a rewrite through a temporary file
/// changes. Platforms without one never load a cache, which only means they scan
/// exactly as they did before.
#[cfg(unix)]
fn file_identity(meta: &fs::Metadata) -> u64 {
    use std::os::unix::fs::MetadataExt;
    meta.ino().wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ ((meta.dev() as u64) << 17)
}

#[cfg(not(unix))]
fn file_identity(_meta: &fs::Metadata) -> u64 {
    0
}

/// The layout a previous process cached beside this transcript, or `None` when it
/// cannot be shown to describe the file as it is now.
fn load_layout_cache(data_dir: &Path, session_id: &str) -> Result<Option<TranscriptLayout>> {
    let path = transcript_path(data_dir, session_id)?;
    let meta = match fs::metadata(&path) {
        Ok(meta) => meta,
        Err(_) => return Ok(None),
    };
    if meta.len() < LAYOUT_CACHE_MIN_LEN {
        return Ok(None);
    }
    let raw = match fs::read_to_string(layout_cache_path(data_dir, session_id)?) {
        Ok(raw) => raw,
        Err(_) => return Ok(None),
    };
    let mut tokens = raw.split_ascii_whitespace();
    let (Some(identity), Some(file_len)) = (tokens.next(), tokens.next()) else {
        return Ok(None);
    };
    if identity.parse::<u64>().ok() != Some(file_identity(&meta)) {
        return Ok(None);
    }
    let Some(file_len) = file_len.parse::<u64>().ok() else {
        return Ok(None);
    };
    if file_len < LAYOUT_CACHE_MIN_LEN || file_len > meta.len() {
        return Ok(None);
    }
    let (Some(messages), Some(compactions)) = (tokens.next(), tokens.next()) else {
        return Ok(None);
    };
    let (Some(messages), Some(compactions)) = (
        messages.parse::<usize>().ok(),
        compactions.parse::<usize>().ok(),
    ) else {
        return Ok(None);
    };
    let mut layout = TranscriptLayout {
        message_offsets: Vec::with_capacity(messages),
        compaction_offsets: Vec::with_capacity(compactions),
        file_len,
    };
    for _ in 0..messages + compactions {
        let Some(offset) = tokens.next().and_then(|token| token.parse::<u64>().ok()) else {
            return Ok(None);
        };
        if layout.message_offsets.len() < messages {
            layout.message_offsets.push(offset);
        } else {
            layout.compaction_offsets.push(offset);
        }
    }
    // The offsets have to be the ones a scan would have produced: ascending,
    // inside the file the cache describes, and pointing at lines the scan would
    // have classified the same way.
    if layout
        .message_offsets
        .windows(2)
        .any(|pair| pair[0] >= pair[1])
        || layout
            .compaction_offsets
            .windows(2)
            .any(|pair| pair[0] >= pair[1])
        || !offsets_look_like_a_scan(&path, &layout)?
    {
        return Ok(None);
    }
    Ok(Some(layout))
}

/// Read the first cached offset of each kind out of the transcript and check that
/// it carries the kind of line the cache says it does. Two reads, and they are
/// what keeps offsets that survived a rewrite from being trusted.
fn offsets_look_like_a_scan(path: &Path, layout: &TranscriptLayout) -> Result<bool> {
    let head = layout
        .message_offsets
        .first()
        .map(|offset| (*offset, "message"))
        .into_iter()
        .chain(
            layout
                .compaction_offsets
                .first()
                .map(|offset| (*offset, "compaction")),
        );
    for (offset, kind) in head {
        if offset >= layout.file_len {
            return Ok(false);
        }
        let mut file = File::open(path)?;
        file.seek(SeekFrom::Start(offset))?;
        let mut buf = vec![0u8; 4096];
        let read = std::io::Read::read(&mut file, &mut buf)?;
        let text = String::from_utf8_lossy(&buf[..read]);
        if sniff_line_kind(text.lines().next().unwrap_or("").trim()) != Some(kind) {
            return Ok(false);
        }
    }
    Ok(true)
}

/// Cache the layout beside its transcript, through a temporary file that is
/// swapped in, so a reader never sees half of one. Failing to cache costs the
/// next process a scan and nothing else, so this never fails a read.
fn store_layout_cache(data_dir: &Path, session_id: &str, layout: &TranscriptLayout) -> Result<()> {
    if layout.file_len < LAYOUT_CACHE_MIN_LEN {
        return Ok(());
    }
    let path = transcript_path(data_dir, session_id)?;
    let Ok(meta) = fs::metadata(&path) else {
        return Ok(());
    };
    if meta.len() != layout.file_len {
        return Ok(());
    }
    let cache = layout_cache_path(data_dir, session_id)?;
    let tmp = cache.with_extension("layout.tmp");
    {
        let mut writer = BufWriter::new(File::create(&tmp)?);
        writeln!(writer, "{} {}", file_identity(&meta), layout.file_len)?;
        writeln!(
            writer,
            "{} {}",
            layout.message_offsets.len(),
            layout.compaction_offsets.len()
        )?;
        for offsets in [&layout.message_offsets, &layout.compaction_offsets] {
            for (index, offset) in offsets.iter().enumerate() {
                if index % 8 == 7 {
                    writeln!(writer, "{offset}")?;
                } else {
                    write!(writer, "{offset} ")?;
                }
            }
            if !offsets.is_empty() && offsets.len() % 8 != 0 {
                writeln!(writer)?;
            }
        }
        writer.flush()?;
    }
    swap_into_place(&tmp, &cache)
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
    // A provider tool-call id is an opaque token, so it appears verbatim in the
    // line that stores it. A byte scan rejects a line before serde walks its
    // payload, which for a tool result is the whole cost of this loop. An id
    // that JSON would escape keeps the unfiltered path.
    let verbatim = is_json_verbatim(call_id);
    for offset in layout.message_offsets.iter().rev() {
        reader.seek(SeekFrom::Start(*offset))?;
        line.clear();
        reader.read_line(&mut line)?;
        if verbatim && !line.contains(call_id) {
            continue;
        }
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

/// Whether a JSON string for this value is the value itself.
///
/// serde_json escapes only the quote, the backslash and the C0 controls, so a
/// value made of anything else is written verbatim between its quotes and can
/// be looked for with a byte scan. A value that would be escaped has to be
/// parsed instead.
fn is_json_verbatim(value: &str) -> bool {
    !value.is_empty()
        && !value.contains(['"', '\\', '\u{7f}'])
        && !value.chars().any(|ch| (ch as u32) < 0x20)
}

/// Whether a transcript file holds a message record with this id.
///
/// `read_transcript` parses every message line into a full `MessageRecord`,
/// block tree and metadata included, and the one caller only needs presence.
/// This walks the file once, classifies each line with the same bounded prefix
/// scan the window reader uses, and parses nothing but the id of a line whose
/// bytes already contain it.
pub fn transcript_contains_id(data_dir: &Path, session_id: &str, message_id: &str) -> Result<bool> {
    #[derive(Deserialize)]
    struct Identity {
        id: String,
    }
    let path = transcript_path(data_dir, session_id)?;
    let file = match File::open(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error).with_context(|| format!("read {}", path.display())),
    };
    let verbatim = is_json_verbatim(message_id);
    let mut reader = BufReader::new(file);
    let mut line = String::new();
    loop {
        line.clear();
        if reader.read_line(&mut line)? == 0 {
            return Ok(false);
        }
        let trimmed = line.trim();
        if sniff_line_kind(trimmed) != Some("message") {
            continue;
        }
        if verbatim && !line.contains(message_id) {
            continue;
        }
        if serde_json::from_str::<Identity>(trimmed).is_ok_and(|identity| identity.id == message_id)
        {
            return Ok(true);
        }
    }
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
    // A cold process reads the offsets the previous one cached beside the file
    // instead of scanning the transcript again -- 531 ms for a 406 MB transcript,
    // taken inside the state lock that serialises the RPC surface. A cache that
    // cannot be shown to describe this file is dropped, and the scan below is what
    // always happened before this existed.
    let base = if base.file_len == 0 {
        load_layout_cache(data_dir, session_id)?
            .filter(|cached| cached.file_len <= len)
            .unwrap_or_default()
    } else {
        base
    };
    if len == base.file_len {
        return Ok(base);
    }
    if len < base.file_len {
        return scan_layout(&path, TranscriptLayout::default());
    }
    let base_len = base.file_len;
    let layout = scan_layout(&path, base)?;
    if base_len == 0 || layout.file_len.saturating_sub(base_len) >= LAYOUT_CACHE_MAX_LAG {
        let _ = store_layout_cache(data_dir, session_id, &layout);
    }
    Ok(layout)
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
/// Position matters for reads: a line has to be classifiable — and, for a
/// message, its id readable — before a reader walks a multi-megabyte tool
/// result, so the discriminator is written first and the id immediately after
/// it. That makes both a fixed-cost prefix check.
///
/// This is a single serialization pass plus one splice. The shape it replaced
/// built a `serde_json::Value` tree, deep-cloned it (a `Value` cannot be
/// re-wrapped without an owned map) and serialized the clone, then formatted
/// the whole payload a second time — four passes over every byte written to a
/// transcript, and an allocation per JSON node.
fn tagged(tag: &str, body: &impl Serialize) -> Result<String> {
    let body = serde_json::to_string(body)?;
    let fields = body
        .strip_prefix('{')
        .and_then(|rest| rest.strip_suffix('}'))
        .ok_or_else(|| anyhow!("line body must be an object"))?;
    let head = format!("{{\"type\":{}", Value::String(tag.into()));
    // `{}` has no fields to append after the discriminator.
    if fields.is_empty() {
        return Ok(format!("{head}}}"));
    }
    Ok(format!("{head},{fields}}}"))
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
    durability::owe_checkpoint(&path, record)
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

/// The transcript durability contract, and where its device waits happen.
///
/// A write is acknowledged only once its bytes are on the device, and a failed
/// device flush fails the request that made the write. Both stay exactly as they
/// were when the `sync_data` sat inside the writing function.
///
/// What moves is *where* the caller waits. Making 321 new bytes durable costs
/// 3.57 ms on the ext4 volume the app data directory lives on (median of 40
/// appends, two runs; a commit with nothing new to write is 96 µs), and both
/// transcript appends and in-flight checkpoints ran inside the single
/// `Mutex<AppState>` that serializes the RPC surface — so one write held every
/// unrelated request for the length of a device commit.
///
/// Measured against the running host, with concurrent agent turns and an
/// unrelated session read probed every 5 ms, that lock — not the CPU — is the
/// wall. Four turns: 140 appends/s, read median 11.6 ms, host CPU 25%. Eight
/// turns: 148/s, 23.6 ms, 24%. With the wait of both writers moved out of the
/// lock: 339/s at 1.5 ms and 420/s at 4.1 ms, CPU 43-48%, and 8 sessions x 250
/// turns land every row exactly once with no torn content.
///
/// So a write records what it owes and the request that made it commits the debt
/// in order, once it has released the state lock and before its response goes
/// out. A caller that is not serving a request — startup recovery, a unit test —
/// has nowhere to record it and keeps the original inline work.
///
/// Two things the state lock used to order have to be kept explicitly:
///
/// * Checkpoints for one file keep the order of the *decisions* that produced
///   them, which is the order the state lock gave them. A checkpoint whose
///   decision is older than one already written is dropped, so a request that
///   reaches its commit late cannot put an older reply back.
/// * A checkpoint that lands after a terminal append removed it is discarded on
///   recovery: `recover_inflight_message` drops a checkpoint whose message id is
///   already indexed as a final row, so a stale snapshot cannot resurrect a
///   settled reply.
mod durability {
    use super::*;
    use std::cell::RefCell;
    use std::future::Future;
    use std::sync::atomic::{AtomicU64, Ordering};

    /// What one request owes the device before it may answer.
    enum Owed {
        /// Bytes already in the page cache; only the flush is left.
        Flush(PathBuf, File),
        /// A checkpoint still to write, flush and swap into place. `decided` is
        /// its place in the process-wide order of checkpoint decisions.
        Checkpoint {
            path: PathBuf,
            payload: String,
            decided: u64,
        },
    }

    tokio::task_local! {
        /// What the request being served owes the device, in the order it was
        /// recorded. Transcript bytes are in the page cache by the time they are
        /// recorded; a checkpoint is not written at all yet.
        static PENDING: RefCell<Vec<Owed>>;
    }

    /// Record the device debt of `file`, or flush it here when no request will.
    pub(super) fn owe(path: &Path, file: File) -> Result<()> {
        if PENDING.try_with(|_| ()).is_err() {
            return file
                .sync_data()
                .with_context(|| format!("flush {}", path.display()));
        }
        PENDING.with(|pending| {
            let mut pending = pending.borrow_mut();
            // The kernel buffer, not the descriptor, holds the bytes, so a newer
            // handle for the same file supersedes an older one.
            pending.retain(|owed| !matches!(owed, Owed::Flush(known, _) if known == path));
            pending.push(Owed::Flush(path.to_path_buf(), file));
        });
        Ok(())
    }

    /// Record a checkpoint the request owes, or write it here when no request
    /// will. The record is serialized now, so the commit only touches the file.
    pub(super) fn owe_checkpoint(path: &Path, record: &InflightRecord) -> Result<()> {
        let decided = decision_order();
        let payload = serde_json::to_string(record)?;
        if PENDING.try_with(|_| ()).is_err() {
            return write_checkpoint(path, &payload, decided);
        }
        PENDING.with(|pending| {
            pending.borrow_mut().push(Owed::Checkpoint {
                path: path.to_path_buf(),
                payload,
                decided,
            });
        });
        Ok(())
    }

    /// Serve one request: commit every write it made, in order, before it
    /// answers. The request's own outcome comes back untouched.
    pub async fn serving<F, T>(future: F) -> (T, Result<()>)
    where
        F: Future<Output = T>,
    {
        PENDING
            .scope(RefCell::new(Vec::new()), async move {
                let output = future.await;
                let pending = PENDING.with(|pending| std::mem::take(&mut *pending.borrow_mut()));
                // The work blocks, so it runs off the async worker.
                let committed = tokio::task::spawn_blocking(move || commit(pending))
                    .await
                    .unwrap_or_else(|error| Err(anyhow!("transcript commit did not run: {error}")));
                (output, committed)
            })
            .await
    }

    /// Commit each owed item in order, stopping at the first failure: work that
    /// could not reach the device is reported, never quietly dropped.
    fn commit(pending: Vec<Owed>) -> Result<()> {
        for owed in pending {
            match owed {
                Owed::Flush(path, file) => file
                    .sync_data()
                    .with_context(|| format!("flush {}", path.display()))?,
                Owed::Checkpoint {
                    path,
                    payload,
                    decided,
                } => write_checkpoint(&path, &payload, decided)?,
            }
        }
        Ok(())
    }

    /// Write one checkpoint: into a temporary file, to the device, and only then
    /// over the checkpoint it replaces.
    ///
    /// A checkpoint whose decision is older than one already written is dropped:
    /// the state lock that used to hold the decision and the write together is
    /// released before this runs, and the file keeps the later decision.
    fn write_checkpoint(path: &Path, payload: &str, decided: u64) -> Result<()> {
        let state = writer_state(path);
        let _per_file = state
            .lock
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if state.written.load(Ordering::SeqCst) >= decided {
            return Ok(());
        }
        let tmp = path.with_extension("json.tmp");
        {
            let mut file = File::create(&tmp)?;
            file.write_all(payload.as_bytes())?;
            file.write_all(b"\n")?;
            file.flush()?;
            file.sync_data()
                .with_context(|| format!("flush {}", tmp.display()))?;
        }
        swap_into_place(&tmp, path)?;
        state.written.store(decided, Ordering::SeqCst);
        Ok(())
    }

    /// Where a checkpoint decision sits in the process-wide decision order. The
    /// state lock used to be that order; it is released before the write now.
    fn decision_order() -> u64 {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        NEXT.fetch_add(1, Ordering::SeqCst) + 1
    }

    /// One checkpoint file's writer state: the lock that makes a decision and its
    /// swap atomic against another writer of the same file, and the decision that
    /// last landed there.
    ///
    /// One entry per checkpoint path ever written is kept for the life of the
    /// process. Evicting could hand two concurrent writers different state for one
    /// file, which is the interleaving this exists to prevent; sessions are
    /// long-lived and few, so the table stays small.
    struct WriterState {
        lock: std::sync::Mutex<()>,
        written: AtomicU64,
    }

    fn writer_state(path: &Path) -> &'static WriterState {
        type Registry = std::sync::Mutex<std::collections::HashMap<PathBuf, &'static WriterState>>;
        static WRITERS: std::sync::OnceLock<Registry> = std::sync::OnceLock::new();
        let registry =
            WRITERS.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()));
        let mut guard = registry.lock().unwrap_or_else(|poison| poison.into_inner());
        let state: &'static WriterState = guard.entry(path.to_path_buf()).or_insert_with(|| {
            Box::leak(Box::new(WriterState {
                lock: std::sync::Mutex::new(()),
                written: AtomicU64::new(0),
            }))
        });
        state
    }
}

/// Serve one RPC, committing the transcript writes it made before it answers.
///
/// Returns the request's own outcome together with the device outcome, so the
/// caller decides which of the two a response carries — and so a device failure
/// cannot be answered with success.
pub use durability::serving as commit_writes_of;

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
    // The bytes are in the kernel. Whether they reach the device before this
    // caller is answered belongs to the request that made the write (see
    // `commit_writes_of`); a caller outside one flushes them here.
    durability::owe(path, file)
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

    // Compaction lines are merged in full only for a read with no message window:
    // the model context needs the whole chain, while a renderer window needs the
    // divider that is in force at it and the dividers inside it.
    //
    // "The chain is small" was the assumption here, and a real 406 MB session
    // falsified it: 44 compactions, 2.0 MB. A window that asked for one message
    // returned 2014 KB, of which 2012 KB was that chain -- parsed and
    // re-serialized per window read, 85-103 ms of the read path, for one message.
    let active_compactions: Vec<u64> = if message_limit.is_some() {
        let mut picked = Vec::new();
        if let Some(&window_start) = layout.message_offsets.get(start) {
            if let Some(active) = layout
                .compaction_offsets
                .iter()
                .copied()
                .filter(|offset| *offset < window_start)
                .next_back()
            {
                picked.push(active);
            }
            let window_end = layout
                .message_offsets
                .get(end.saturating_sub(1))
                .copied()
                .unwrap_or(window_start);
            picked.extend(
                layout
                    .compaction_offsets
                    .iter()
                    .copied()
                    .filter(|offset| *offset >= window_start && *offset <= window_end),
            );
        }
        picked
    } else {
        layout.compaction_offsets.clone()
    };
    // Every offset that has to be visited, in ascending file order, so one
    // forward-only reader can serve both kinds without seeking backwards.
    let mut wanted: Vec<(u64, bool)> =
        Vec::with_capacity(end.saturating_sub(start) + active_compactions.len());
    wanted.extend(
        layout.message_offsets[start..end]
            .iter()
            .map(|offset| (*offset, true)),
    );
    wanted.extend(active_compactions.iter().map(|offset| (*offset, false)));
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
///
/// Still O(history), deliberately. Appending the replacement instead — which the
/// reader's last-write-wins dedupe resolves correctly for *content* — moves the
/// message's line to the end of the file, and every window in the read path is
/// expressed in physical line coordinates: `find_message_position` returns the
/// last physical occurrence and `get_session_with_options` centres
/// `messageAround` on it. A search jump to an updated message would then open on
/// the tail of the session instead of its neighbourhood. Making the replace
/// cheap needs the window coordinates to become deduplicated-logical first; that
/// is a read-path change, not a write-path one. It costs 4.5 ms at 1.3 MB,
/// 27.1 ms at 21 MB and about 1.3 s at 1 GB.
///
/// One pass is skipped because it only ever costs work: a replacement identical
/// to the line already stored leaves the file untouched instead of rewriting the
/// whole transcript. That is the shape of a retried metadata stamp, and it turns
/// a 3.9 ms rewrite into a 1.0 ms read at 1.3 MB and a 25 ms one into 19 ms at
/// 21 MB, measured against the always-rewrite splice on the same fixture.
pub fn update_message(data_dir: &Path, session_id: &str, record: &MessageRecord) -> Result<bool> {
    let path = transcript_path(data_dir, session_id)?;
    let replacement = tagged("message", record)?;
    // Fast path. A message is decided by the *last* occurrence of its id, so
    // when that occurrence is already the file's last line, appending the
    // replacement is indistinguishable from replacing it in place: same id, same
    // new content, same position at the end of the file. It replaces the
    // whole-file rewrite below, which measured 4.5 ms at 1.3 MB and 27 ms at
    // 21 MB — about 1.3 s at 1 GB by the same arithmetic — and that rewrite, not
    // the device, is what bounds a reply in a session holding hundreds of MB.
    if let Some(last) = read_last_line(&path)? {
        if last != replacement && line_carries(&last, &record.id) {
            append_line(&path, None, replacement)?;
            return Ok(true);
        }
    }
    // The rewrite below moves line contents, so the cached line offsets are stale
    // from here on. The append above only grew the file, which the incremental
    // layout refresh handles by itself — and dropping that invalidation is what
    // keeps the next read of a long session from scanning all of it again.
    crate::sessions::invalidate_transcript_layout(session_id);
    let raw = match fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e).with_context(|| format!("read {}", path.display())),
    };
    let tmp = path.with_extension("jsonl.tmp");
    let mut rewrote = false;
    let mut carries_target = false;
    {
        let file = File::create(&tmp)?;
        let mut writer = BufWriter::new(file);
        for line in raw.lines() {
            let trimmed = line.trim();
            let is_target = !trimmed.is_empty()
                && serde_json::from_str::<Value>(trimmed).is_ok_and(|value| {
                    value.get("type").and_then(Value::as_str) == Some("message")
                        && value.get("id").and_then(Value::as_str) == Some(record.id.as_str())
                });
            if is_target {
                carries_target = true;
            }
            if is_target && line != replacement {
                // A retried append can leave the same id on two lines; keep-last
                // dedupe means every copy has to carry the new metadata.
                writer.write_all(replacement.as_bytes())?;
                rewrote = true;
            } else {
                writer.write_all(line.as_bytes())?;
            }
            writer.write_all(b"\n")?;
        }
        writer.flush()?;
        if !rewrote {
            // Nothing to swap in: the id is absent, or every copy already
            // carries exactly this metadata. Leave the live transcript alone.
            drop(writer);
            let _ = fs::remove_file(&tmp);
            return Ok(carries_target);
        }
        writer.get_ref().sync_data()?;
    }
    swap_into_place(&tmp, &path)?;
    Ok(true)
}

/// The file's last line, if it can be read on its own. `None` means the file is
/// empty, ends without a record, or its last line is longer than the window this
/// reads — the caller then has to read the whole file.
///
/// Reading the last line instead of the whole transcript is what keeps an update
/// on a long session O(1): the transcript of a session that has been running for
/// months holds hundreds of MB, and every updated message used to be answered by
/// copying all of it.
fn read_last_line(path: &Path) -> Result<Option<String>> {
    const WINDOW: u64 = 64 * 1024;
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e).with_context(|| format!("read {}", path.display())),
    };
    let len = file.metadata()?.len();
    if len == 0 {
        return Ok(None);
    }
    let from = len.saturating_sub(WINDOW);
    file.seek(SeekFrom::Start(from))?;
    let mut buf = vec![0u8; (len - from) as usize];
    file.read_exact(&mut buf)?;
    // A line boundary is ASCII, so everything after the last newline in the
    // window is a whole line even when the window itself split a character.
    let (start, end) = match buf.iter().rposition(|byte| *byte == b'\n') {
        Some(nl) if nl + 1 < buf.len() => (nl + 1, buf.len()),
        Some(nl) => match buf[..nl].iter().rposition(|byte| *byte == b'\n') {
            Some(previous) => (previous + 1, nl),
            None if from == 0 => (0, nl),
            None => return Ok(None),
        },
        None => return Ok(None),
    };
    match std::str::from_utf8(&buf[start..end]) {
        Ok(line) if line.trim().is_empty() => Ok(None),
        Ok(line) => Ok(Some(line.to_string())),
        // The window started inside a record: that line reaches back further.
        Err(_) => Ok(None),
    }
}

/// Whether one transcript line is a `message` record carrying `id`.
fn line_carries(line: &str, id: &str) -> bool {
    serde_json::from_str::<Value>(line.trim()).is_ok_and(|value| {
        value.get("type").and_then(Value::as_str) == Some("message")
            && value.get("id").and_then(Value::as_str) == Some(id)
    })
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::tempdir;

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

    /// A tool row whose block array names a provider call id.
    fn tool_record(id: &str, call_id: &str) -> MessageRecord {
        MessageRecord {
            id: id.into(),
            role: "tool".into(),
            tool_name: Some("bash".into()),
            is_error: false,
            blocks: json!([{ "type": "tool_result", "callId": call_id, "text": "x" }]),
            meta: None,
            created_at: "2026-07-26T00:00:00.000Z".into(),
        }
    }

    /// Byte offset of every line start, which is all `read_tool_call` needs.
    fn line_offsets(dir: &Path, session_id: &str) -> TranscriptLayout {
        let raw = fs::read(transcript_path(dir, session_id).unwrap()).unwrap();
        let mut message_offsets = Vec::new();
        let mut at = 0usize;
        for line in raw.split_inclusive(|byte| *byte == b'\n') {
            message_offsets.push(at as u64);
            at += line.len();
        }
        TranscriptLayout {
            message_offsets,
            compaction_offsets: Vec::new(),
            file_len: raw.len() as u64,
        }
    }

    /// Presence is answered from the id field, and the byte pre-filter must not
    /// hide an id that JSON writes in escaped form.
    #[test]
    fn transcript_contains_id_answers_from_the_id_field_alone() {
        let dir = tempdir().unwrap();
        let escaped = "quote\"and\\slash";
        for id in ["m1", "middle", escaped] {
            append_message(dir.path(), "s1", "2026-07-26T00:00:00Z", &record(id, "x")).unwrap();
        }
        for id in ["m1", "middle", escaped] {
            assert!(
                transcript_contains_id(dir.path(), "s1", id).unwrap(),
                "{id:?} should be present"
            );
        }
        assert!(!transcript_contains_id(dir.path(), "s1", "absent").unwrap());
        // A prefix of a stored id is not a stored id.
        assert!(!transcript_contains_id(dir.path(), "s1", "mid").unwrap());
        // A session with no transcript answers false rather than failing.
        assert!(!transcript_contains_id(dir.path(), "other", "m1").unwrap());
    }

    /// The byte pre-filter in `read_tool_call` must not hide a call id that JSON
    /// writes in escaped form.
    #[test]
    fn read_tool_call_finds_ids_that_json_escapes() {
        let dir = tempdir().unwrap();
        append_message(dir.path(), "s1", "2026-07-26T00:00:00Z", &record("m1", "x")).unwrap();
        let call_ids = ["call-1", "quote\"and\\slash"];
        for (index, call_id) in call_ids.iter().enumerate() {
            append_message(
                dir.path(),
                "s1",
                "2026-07-26T00:00:00Z",
                &tool_record(&format!("tool-{index}"), call_id),
            )
            .unwrap();
        }
        let layout = line_offsets(dir.path(), "s1");
        for call_id in call_ids {
            assert!(
                read_tool_call(dir.path(), "s1", &layout, call_id)
                    .unwrap()
                    .is_some(),
                "{call_id:?} should be found"
            );
        }
        assert!(read_tool_call(dir.path(), "s1", &layout, "absent")
            .unwrap()
            .is_none());
    }

    /// Concurrent appends from several sessions must not cost a line, fuse two
    /// lines, or leak across files: writes are ordered by the state lock and
    /// each append flushes its own file. Guards the append shape the durability
    /// contract rests on.
    #[test]
    fn concurrent_appends_keep_every_line_intact_and_in_its_own_session() {
        const SESSIONS: usize = 8;
        const PER_SESSION: usize = 25;
        let dir = tempdir().unwrap();
        let mut handles = Vec::new();
        for session in 0..SESSIONS {
            let root = dir.path().to_path_buf();
            handles.push(std::thread::spawn(move || {
                let id = format!("sess-{session}");
                for index in 0..PER_SESSION {
                    let record = record(&format!("msg-{:06}", session * PER_SESSION + index), "x");
                    append_message(&root, &id, "2026-07-26T00:00:00Z", &record).unwrap();
                }
            }));
        }
        for handle in handles {
            handle.join().unwrap();
        }
        for session in 0..SESSIONS {
            let id = format!("sess-{session}");
            let expected: Vec<String> = (session * PER_SESSION..(session + 1) * PER_SESSION)
                .map(|index| format!("msg-{index:06}"))
                .collect();
            let ids: Vec<String> = read_transcript(dir.path(), &id)
                .unwrap()
                .iter()
                .map(|record| record.id.clone())
                .collect();
            assert_eq!(
                ids, expected,
                "every line survives, in order, in its own session"
            );
        }
    }

    /// Point one session's transcript at a file that takes writes and refuses
    /// the device flush. `/dev/null` accepts the bytes and fails `fdatasync`
    /// with EINVAL, which is how a broken device behaves, on any machine.
    #[cfg(unix)]
    fn transcript_that_cannot_be_flushed(dir: &Path) -> PathBuf {
        let path = transcript_path(dir, "s1").unwrap();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink("/dev/null", &path).unwrap();
        path
    }

    /// A caller that is not serving a request has nowhere to defer to, so it
    /// must not report an append whose bytes never reached the device as a
    /// success.
    #[cfg(unix)]
    #[test]
    fn an_append_outside_a_request_reports_a_failed_device_flush() {
        let dir = tempdir().unwrap();
        transcript_that_cannot_be_flushed(dir.path());
        let error = append_message(dir.path(), "s1", "2026-07-26T00:00:00Z", &record("m1", "x"))
            .expect_err("a failed device flush is not a successful append");
        assert!(format!("{error:#}").contains("flush"), "{error:#}");
    }

    /// The request that owns the write owns the device wait: it commits the
    /// lines it wrote before it answers, and a failed flush comes back to it
    /// instead of being logged and forgotten.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_request_only_answers_after_its_lines_reached_the_device() {
        let dir = tempdir().unwrap();
        transcript_that_cannot_be_flushed(dir.path());
        let (written, committed) = commit_writes_of(async {
            append_message(dir.path(), "s1", "2026-07-26T00:00:00Z", &record("m1", "x"))
        })
        .await;
        assert!(written.is_ok(), "the write itself succeeds: {written:?}");
        let error =
            committed.expect_err("the flush failed, so the request must not answer success");
        assert!(format!("{error:#}").contains("flush"), "{error:#}");
    }

    /// The same scope on a healthy file commits the write and reports nothing.
    #[tokio::test]
    async fn a_request_commits_the_transcript_lines_it_wrote() {
        let dir = tempdir().unwrap();
        let (written, committed) = commit_writes_of(async {
            append_message(dir.path(), "s1", "2026-07-26T00:00:00Z", &record("m1", "x"))
        })
        .await;
        written.unwrap();
        committed.expect("a synced write commits");
        let ids: Vec<String> = read_transcript(dir.path(), "s1")
            .unwrap()
            .iter()
            .map(|record| record.id.clone())
            .collect();
        assert_eq!(ids, vec!["m1".to_string()]);
    }

    /// An in-flight checkpoint for `message_id`, stamped `created_at`.
    fn inflight(session_id: &str, message_id: &str, created_at: &str) -> InflightRecord {
        let mut message = record(message_id, "partial");
        message.created_at = created_at.into();
        InflightRecord {
            schema: INFLIGHT_SCHEMA,
            session_id: session_id.into(),
            turn_id: Some("turn-1".into()),
            saved_at: created_at.into(),
            message,
        }
    }

    /// A checkpoint is part of what a request owes the device, so one that cannot
    /// reach it fails the request instead of answering success.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_request_whose_checkpoint_cannot_be_flushed_fails() {
        let dir = tempdir().unwrap();
        let path = inflight_path(dir.path(), "s1").unwrap();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        // The temporary the writer creates, flushes and renames into place.
        std::os::unix::fs::symlink("/dev/null", path.with_extension("json.tmp")).unwrap();
        let record = inflight("s1", "m1", "2026-07-26T00:00:01.000Z");
        let (written, committed) =
            commit_writes_of(async { write_inflight(dir.path(), "s1", &record) }).await;
        assert!(written.is_ok(), "the write itself succeeds: {written:?}");
        let error = committed.expect_err("an unflushed checkpoint is not a saved checkpoint");
        assert!(format!("{error:#}").contains("flush"), "{error:#}");
    }

    /// Checkpoints of one file keep the order of the decisions that produced
    /// them, including when the earlier decision reaches its commit last: the
    /// state lock used to give that order and the commit no longer holds it.
    #[tokio::test]
    async fn a_checkpoint_decided_later_always_wins() {
        let dir = tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let first = inflight("s1", "m1", "2026-07-26T00:00:01.000Z");
        let second = inflight("s1", "m1", "2026-07-26T00:00:02.000Z");
        let (written, committed) = commit_writes_of(async {
            // Decided first, and it reaches its commit only after the second
            // decision has already replaced the file.
            write_inflight(&root, "s1", &first).unwrap();
            let later = {
                let (root, second) = (root.clone(), second.clone());
                // No request scope on this thread, so this one is written inline,
                // exactly as every checkpoint was before the wait moved.
                tokio::task::spawn_blocking(move || write_inflight(&root, "s1", &second))
            };
            later.await.unwrap().unwrap();
            Ok::<(), anyhow::Error>(())
        })
        .await;
        written.unwrap();
        committed.unwrap();
        let stored = read_inflight(&root, "s1").unwrap().unwrap();
        assert_eq!(
            stored.message.created_at, second.message.created_at,
            "a checkpoint decided earlier must not land on top of a later one"
        );
    }
}
