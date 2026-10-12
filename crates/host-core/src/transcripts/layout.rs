//! The derived physical index for a session transcript.
//!
//! Layout offsets are disposable. They are reused only while the transcript's
//! file identity still matches, and every cache failure falls back to a scan.

use std::{
    collections::HashMap,
    fs::{self, File},
    io::{BufRead, BufReader, BufWriter, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};

use anyhow::{Context, Result};
use sha2::{Digest, Sha256};

use super::{sniff_line_kind, swap_into_place, transcript_path};

const LAYOUT_CACHE_MIN_LEN: u64 = 2 * 1024 * 1024;
const LAYOUT_CACHE_MAX_LAG: u64 = 4 * 1024 * 1024;
const LAYOUT_CACHE_MAGIC: &str = "PI-DESKTOP-TRANSCRIPT-LAYOUT";
const LAYOUT_CACHE_VERSION: &str = "2";

/// A stable identity available on filesystems that expose one.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum FileIdentity {
    Available {
        platform: &'static str,
        volume_id: u64,
        file_id: [u8; 16],
    },
    #[default]
    Unavailable,
}

impl FileIdentity {
    fn is_available(&self) -> bool {
        matches!(self, Self::Available { .. })
    }

    fn write_tokens(&self, writer: &mut impl Write) -> std::io::Result<()> {
        match self {
            Self::Available {
                platform,
                volume_id,
                file_id,
            } => writeln!(writer, "{platform} {volume_id:x} {}", hex::encode(file_id)),
            Self::Unavailable => Err(std::io::Error::other("file identity is unavailable")),
        }
    }

    fn from_tokens(platform: &str, volume_id: &str, file_id: &str) -> Option<Self> {
        let expected_platform = if cfg!(unix) {
            "unix"
        } else if cfg!(windows) {
            "windows"
        } else {
            return None;
        };
        if platform != expected_platform {
            return None;
        }
        let volume_id = u64::from_str_radix(volume_id, 16).ok()?;
        let bytes = hex::decode(file_id).ok()?;
        let file_id: [u8; 16] = bytes.try_into().ok()?;
        Some(Self::Available {
            platform: expected_platform,
            volume_id,
            file_id,
        })
    }
}

/// Physical layout of one transcript file: the byte offset of every message
/// and compaction line, plus the file prefix those offsets describe.
#[derive(Debug, Default, Clone)]
pub struct TranscriptLayout {
    /// Byte offset of each message line, in file order.
    pub message_offsets: Vec<u64>,
    /// Byte offset of each compaction line, in file order.
    pub compaction_offsets: Vec<u64>,
    /// Byte length of the file prefix this layout describes.
    pub file_len: u64,
    pub(crate) identity: FileIdentity,
}

impl TranscriptLayout {
    /// Physical message-line count. Window offsets use this coordinate space,
    /// not the deduplicated message positions.
    pub fn message_count(&self) -> usize {
        self.message_offsets.len()
    }

    fn empty(identity: FileIdentity) -> Self {
        Self {
            identity,
            ..Self::default()
        }
    }
}

#[derive(Debug, Clone, Hash, PartialEq, Eq)]
struct LayoutKey {
    data_dir: PathBuf,
    session_id: String,
}

static TRANSCRIPT_LAYOUTS: OnceLock<Mutex<HashMap<LayoutKey, TranscriptLayout>>> = OnceLock::new();

fn layout_cache() -> &'static Mutex<HashMap<LayoutKey, TranscriptLayout>> {
    TRANSCRIPT_LAYOUTS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn layout_key(data_dir: &Path, session_id: &str) -> LayoutKey {
    LayoutKey {
        data_dir: data_dir.to_path_buf(),
        session_id: session_id.to_string(),
    }
}

fn layout_cache_path(data_dir: &Path, session_id: &str) -> Result<PathBuf> {
    Ok(transcript_path(data_dir, session_id)?.with_extension("jsonl.layout"))
}

/// Return an up-to-date layout, reusing the process cache or a validated disk
/// cache and scanning only the appended tail.
pub(crate) fn session_layout(data_dir: &Path, session_id: &str) -> Result<TranscriptLayout> {
    let key = layout_key(data_dir, session_id);
    let cached = layout_cache()
        .lock()
        .ok()
        .and_then(|guard| guard.get(&key).cloned())
        .unwrap_or_default();
    let layout = refresh_layout(data_dir, session_id, cached)?;
    if let Ok(mut guard) = layout_cache().lock() {
        guard.insert(key, layout.clone());
    }
    Ok(layout)
}

/// Remove both derived cache layers after a rewrite or session deletion.
/// Cleanup failure is diagnostic only; file identity still prevents the stale
/// disk cache from being trusted on the next read.
pub(crate) fn invalidate(data_dir: &Path, session_id: &str) {
    if let Ok(mut guard) = layout_cache().lock() {
        guard.remove(&layout_key(data_dir, session_id));
    }
    let mut paths = Vec::new();
    if let Ok(cache) = layout_cache_path(data_dir, session_id) {
        paths.push(cache.with_extension("layout.tmp"));
        paths.push(cache);
    }
    for path in paths {
        if let Err(error) = fs::remove_file(&path) {
            if error.kind() != std::io::ErrorKind::NotFound {
                tracing::warn!(%error, "failed to invalidate transcript layout cache");
            }
        }
    }
}

/// A boundary failure means an indexed offset does not point at the expected
/// JSONL line. It is distinct from transcript I/O or decoding failures so the
/// common read path can rebuild once and retry.
#[derive(Debug, thiserror::Error)]
#[error("transcript layout boundary is invalid")]
pub(crate) struct InvalidLayoutBoundary;

pub(crate) fn invalid_boundary() -> anyhow::Error {
    InvalidLayoutBoundary.into()
}

/// Rebuild once after an indexed read detects a stale/corrupt boundary. The
/// retry always bypasses the disk cache and callers recompute their selection
/// from the rebuilt message count.
pub(crate) fn with_layout_recovery<T>(
    data_dir: &Path,
    session_id: &str,
    mut operation: impl FnMut(&TranscriptLayout) -> Result<T>,
) -> Result<T> {
    let first = session_layout(data_dir, session_id)?;
    match operation(&first) {
        Ok(value) => Ok(value),
        Err(error) if error.is::<InvalidLayoutBoundary>() => {
            invalidate(data_dir, session_id);
            let rebuilt = scan_current_file(data_dir, session_id)?;
            cache_rebuilt_layout(data_dir, session_id, &rebuilt);
            match operation(&rebuilt) {
                Err(error) if error.is::<InvalidLayoutBoundary>() => {
                    Err(error.context("transcript layout remained invalid after one full rebuild"))
                }
                result => result,
            }
        }
        Err(error) => Err(error),
    }
}

fn cache_rebuilt_layout(data_dir: &Path, session_id: &str, layout: &TranscriptLayout) {
    if let Ok(mut guard) = layout_cache().lock() {
        guard.insert(layout_key(data_dir, session_id), layout.clone());
    }
    if let Err(error) = store_layout_cache(data_dir, session_id, layout) {
        tracing::warn!(%error, "failed to persist rebuilt transcript layout cache");
    }
}

/// Refresh the supplied layout only after validating its file identity.
pub fn refresh_layout(
    data_dir: &Path,
    session_id: &str,
    base: TranscriptLayout,
) -> Result<TranscriptLayout> {
    let path = transcript_path(data_dir, session_id)?;
    let metadata = match fs::metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(TranscriptLayout::default())
        }
        Err(error) => return Err(error).with_context(|| format!("stat {}", path.display())),
    };
    refresh_with_identity(
        data_dir,
        session_id,
        base,
        metadata.len(),
        file_identity(&path, &metadata),
    )
}

fn refresh_with_identity(
    data_dir: &Path,
    session_id: &str,
    base: TranscriptLayout,
    length: u64,
    identity: FileIdentity,
) -> Result<TranscriptLayout> {
    let path = transcript_path(data_dir, session_id)?;
    let mut base =
        if identity.is_available() && base.identity == identity && base.file_len <= length {
            base
        } else {
            TranscriptLayout::empty(identity.clone())
        };

    if !identity.is_available() {
        // Without a reliable identity, no existing offsets can be trusted.
        base = TranscriptLayout::empty(identity);
    } else if base.file_len == 0 {
        base = load_layout_cache(data_dir, session_id, &identity, length)?
            .unwrap_or_else(|| TranscriptLayout::empty(identity.clone()));
    }

    if length == base.file_len {
        return Ok(base);
    }
    let base_len = base.file_len;
    let layout = scan_layout(&path, base)?;
    if base_len == 0 || layout.file_len.saturating_sub(base_len) >= LAYOUT_CACHE_MAX_LAG {
        if let Err(error) = store_layout_cache(data_dir, session_id, &layout) {
            tracing::warn!(%error, "failed to persist transcript layout cache");
        }
    }
    Ok(layout)
}

fn scan_current_file(data_dir: &Path, session_id: &str) -> Result<TranscriptLayout> {
    let path = transcript_path(data_dir, session_id)?;
    let metadata = match fs::metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(TranscriptLayout::default())
        }
        Err(error) => return Err(error).with_context(|| format!("stat {}", path.display())),
    };
    let identity = file_identity(&path, &metadata);
    scan_layout(&path, TranscriptLayout::empty(identity))
}

/// Scan from the known complete-line prefix to EOF, extending the offsets.
fn scan_layout(path: &Path, mut layout: TranscriptLayout) -> Result<TranscriptLayout> {
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(TranscriptLayout::default())
        }
        Err(error) => return Err(error).with_context(|| format!("read {}", path.display())),
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
        // A torn append is excluded until its newline arrives.
        if !line.ends_with('\n') {
            break;
        }
        match sniff_line_kind(line.trim_end()) {
            Some("message") => layout.message_offsets.push(offset),
            Some("compaction") => layout.compaction_offsets.push(offset),
            _ => {}
        }
        offset += read as u64;
        if line.capacity() > 1024 * 1024 {
            line = String::new();
        }
    }
    layout.file_len = offset;
    Ok(layout)
}

fn load_layout_cache(
    data_dir: &Path,
    session_id: &str,
    identity: &FileIdentity,
    current_len: u64,
) -> Result<Option<TranscriptLayout>> {
    if current_len < LAYOUT_CACHE_MIN_LEN {
        return Ok(None);
    }
    let cache_path = layout_cache_path(data_dir, session_id)?;
    let raw = match fs::read_to_string(&cache_path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            tracing::warn!(%error, "failed to read transcript layout cache");
            return Ok(None);
        }
    };
    let mut tokens = raw.split_ascii_whitespace();
    if tokens.next() != Some(LAYOUT_CACHE_MAGIC) || tokens.next() != Some(LAYOUT_CACHE_VERSION) {
        return Ok(None);
    }
    let (Some(platform), Some(volume), Some(file_id)) =
        (tokens.next(), tokens.next(), tokens.next())
    else {
        return Ok(None);
    };
    let Some(cached_identity) = FileIdentity::from_tokens(platform, volume, file_id) else {
        return Ok(None);
    };
    if &cached_identity != identity {
        return Ok(None);
    }
    let Some(file_len) = tokens.next().and_then(|token| token.parse::<u64>().ok()) else {
        return Ok(None);
    };
    if file_len < LAYOUT_CACHE_MIN_LEN || file_len > current_len {
        return Ok(None);
    }
    let (Some(message_count), Some(compaction_count)) = (tokens.next(), tokens.next()) else {
        return Ok(None);
    };
    let (Some(message_count), Some(compaction_count)) = (
        message_count.parse::<usize>().ok(),
        compaction_count.parse::<usize>().ok(),
    ) else {
        return Ok(None);
    };
    let Some(offset_count) = message_count.checked_add(compaction_count) else {
        return Ok(None);
    };
    let Ok(file_len_usize) = usize::try_from(file_len) else {
        return Ok(None);
    };
    // A classified JSONL record needs at least `{"type":"message"}\n`;
    // reject impossible counts before reserving memory from cache input.
    if offset_count > file_len_usize / 19 || offset_count > tokens.clone().count() {
        return Ok(None);
    }
    let mut layout = TranscriptLayout {
        message_offsets: Vec::with_capacity(message_count),
        compaction_offsets: Vec::with_capacity(compaction_count),
        file_len,
        identity: cached_identity,
    };
    for index in 0..offset_count {
        let Some(offset) = tokens.next().and_then(|token| token.parse::<u64>().ok()) else {
            return Ok(None);
        };
        if index < message_count {
            layout.message_offsets.push(offset);
        } else {
            layout.compaction_offsets.push(offset);
        }
    }
    let transcript = transcript_path(data_dir, session_id)?;
    let (Some(checksum_label), Some(checksum)) = (tokens.next(), tokens.next()) else {
        return Ok(None);
    };
    if checksum_label != "checksum"
        || checksum != layout_cache_digest(&layout)
        || tokens.next().is_some()
        || !offsets_are_valid(&layout)
        || !prefix_ends_on_line_boundary(&transcript, file_len)?
    {
        return Ok(None);
    }
    if !offsets_look_like_scan(&transcript, &layout)? {
        return Ok(None);
    }
    Ok(Some(layout))
}

fn offsets_are_valid(layout: &TranscriptLayout) -> bool {
    if layout
        .message_offsets
        .windows(2)
        .any(|pair| pair[0] >= pair[1])
        || layout
            .compaction_offsets
            .windows(2)
            .any(|pair| pair[0] >= pair[1])
    {
        return false;
    }
    let mut messages = layout.message_offsets.iter().copied().peekable();
    let mut compactions = layout.compaction_offsets.iter().copied().peekable();
    let mut previous = None;
    loop {
        let next_message = messages.peek().copied();
        let next_compaction = compactions.peek().copied();
        let next = match (next_message, next_compaction) {
            (None, None) => break,
            (Some(message), Some(compaction)) if message == compaction => return false,
            (Some(message), Some(compaction)) if message < compaction => {
                messages.next();
                message
            }
            (Some(_), Some(compaction)) => {
                compactions.next();
                compaction
            }
            (Some(message), None) => {
                messages.next();
                message
            }
            (None, Some(compaction)) => {
                compactions.next();
                compaction
            }
        };
        if next >= layout.file_len || previous.is_some_and(|offset| offset >= next) {
            return false;
        }
        previous = Some(next);
    }
    true
}

fn prefix_ends_on_line_boundary(path: &Path, file_len: u64) -> Result<bool> {
    if file_len == 0 {
        return Ok(true);
    }
    let mut file = File::open(path)?;
    file.seek(SeekFrom::Start(file_len - 1))?;
    let mut byte = [0u8; 1];
    Ok(file.read_exact(&mut byte).is_ok() && byte[0] == b'\n')
}

fn offsets_look_like_scan(path: &Path, layout: &TranscriptLayout) -> Result<bool> {
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
        let mut prefix = [0u8; 4096];
        let read = BufReader::new(file).read(&mut prefix)?;
        let text = String::from_utf8_lossy(&prefix[..read]);
        if sniff_line_kind(text.trim_end()) != Some(kind) {
            return Ok(false);
        }
    }
    Ok(true)
}

fn layout_cache_digest(layout: &TranscriptLayout) -> String {
    let mut digest = Sha256::new();
    digest.update(LAYOUT_CACHE_MAGIC.as_bytes());
    digest.update(LAYOUT_CACHE_VERSION.as_bytes());
    match &layout.identity {
        FileIdentity::Available {
            platform,
            volume_id,
            file_id,
        } => {
            digest.update(platform.as_bytes());
            digest.update(volume_id.to_le_bytes());
            digest.update(file_id);
        }
        FileIdentity::Unavailable => digest.update(b"unavailable"),
    }
    digest.update(layout.file_len.to_le_bytes());
    digest.update((layout.message_offsets.len() as u64).to_le_bytes());
    digest.update((layout.compaction_offsets.len() as u64).to_le_bytes());
    for offset in layout
        .message_offsets
        .iter()
        .chain(&layout.compaction_offsets)
    {
        digest.update(offset.to_le_bytes());
    }
    hex::encode(digest.finalize())
}

fn store_layout_cache(data_dir: &Path, session_id: &str, layout: &TranscriptLayout) -> Result<()> {
    if layout.file_len < LAYOUT_CACHE_MIN_LEN || !layout.identity.is_available() {
        return Ok(());
    }
    let path = transcript_path(data_dir, session_id)?;
    let metadata = fs::metadata(&path)?;
    if metadata.len() != layout.file_len || file_identity(&path, &metadata) != layout.identity {
        return Ok(());
    }
    let cache = layout_cache_path(data_dir, session_id)?;
    let tmp = cache.with_extension("layout.tmp");
    {
        let mut writer = BufWriter::new(File::create(&tmp)?);
        writeln!(writer, "{LAYOUT_CACHE_MAGIC} {LAYOUT_CACHE_VERSION}")?;
        layout.identity.write_tokens(&mut writer)?;
        writeln!(writer, "{}", layout.file_len)?;
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
        writeln!(writer, "checksum {}", layout_cache_digest(layout))?;
        writer.flush()?;
        writer.get_ref().sync_data()?;
    }
    swap_into_place(&tmp, &cache)
}

#[cfg(unix)]
fn file_identity(_path: &Path, metadata: &fs::Metadata) -> FileIdentity {
    use std::os::unix::fs::MetadataExt;
    let mut file_id = [0u8; 16];
    file_id[..8].copy_from_slice(&metadata.ino().to_be_bytes());
    FileIdentity::Available {
        platform: "unix",
        volume_id: metadata.dev(),
        file_id,
    }
}

#[cfg(windows)]
fn file_identity(path: &Path, _metadata: &fs::Metadata) -> FileIdentity {
    use std::{mem::size_of, os::windows::io::AsRawHandle};
    use windows_sys::Win32::{
        Foundation::HANDLE,
        Storage::FileSystem::{FileIdInfo, GetFileInformationByHandleEx, FILE_ID_INFO},
    };

    let Ok(file) = File::open(path) else {
        return FileIdentity::Unavailable;
    };
    let mut info = FILE_ID_INFO::default();
    let result = unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle() as HANDLE,
            FileIdInfo,
            (&mut info as *mut FILE_ID_INFO).cast(),
            size_of::<FILE_ID_INFO>() as u32,
        )
    };
    if result == 0 {
        return FileIdentity::Unavailable;
    }
    FileIdentity::Available {
        platform: "windows",
        volume_id: info.VolumeSerialNumber,
        file_id: info.FileId.Identifier,
    }
}

#[cfg(not(any(unix, windows)))]
fn file_identity(_path: &Path, _metadata: &fs::Metadata) -> FileIdentity {
    FileIdentity::Unavailable
}

#[cfg(test)]
#[path = "../transcripts_layout_tests.rs"]
mod tests;
