//! Select lossless transcript rows by stable logical position.

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::Path;

use anyhow::{ensure, Context, Result};

use super::{
    apply_tool_review_states, binary_storage, layout, parse_tool_review_state, sniff_line_kind,
    transcript_path, MessageRecord, TranscriptLayout,
};

const PAGE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_REVIEW_UPDATES: usize = 8192;

#[derive(Debug, thiserror::Error)]
#[error("history page exceeds the transcript read budget")]
pub(crate) struct ReadLimit;

#[derive(Default)]
pub(crate) struct HistoryPage {
    pub messages: Vec<MessageRecord>,
    pub has_more_before: bool,
}

/// Each ID occupies its first physical position, but its latest row carries
/// the payload. Resolve the cursor in the same order used to select the page.
pub(crate) fn history_page(
    data_dir: &Path,
    session_id: &str,
    before: Option<&str>,
    limit: usize,
) -> Result<HistoryPage> {
    let path = transcript_path(data_dir, session_id)?;
    layout::with_layout_recovery(data_dir, session_id, |layout| {
        if layout.message_offsets.is_empty() {
            return Ok(HistoryPage::default());
        }
        let reader = File::open(&path)?;
        check_generation(&reader, &path, layout)?;
        let mut positions = HashMap::new();
        for (position, id) in layout.message_ids.iter().enumerate() {
            if let Some(id) = id.as_deref() {
                let entry = positions.entry(id).or_insert((position, position));
                entry.1 = position;
            }
        }
        let end = before
            .and_then(|id| positions.get(id).map(|entry| entry.0))
            .unwrap_or(layout.message_count());
        let mut read = PageRead {
            reader,
            remaining: PAGE_BYTES,
        };
        let mut page = HistoryPage::default();
        for position in (0..end).rev() {
            let id = layout.message_ids[position].as_deref();
            let payload = match id.and_then(|id| positions.get(id)) {
                Some(&(first, last)) if first == position => last,
                Some(_) => continue,
                None => position,
            };
            if page.messages.len() == limit {
                page.has_more_before = true;
                break;
            }
            let (line, invalid_utf8) =
                read.line(layout, layout.message_offsets[payload], "message")?;
            let record = match binary_storage::read::<MessageRecord>(line.trim_end()) {
                Ok(record) => record,
                Err(error)
                    if binary_storage::is_torn_eof(&error)
                        || (invalid_utf8 && !binary_storage::is_error(&error)) =>
                {
                    tracing::warn!(%error, "skipping torn history message");
                    continue;
                }
                Err(error) => return Err(error).context("decode indexed history message"),
            };
            if id != Some(record.id.as_str()) {
                return Err(layout::invalid_boundary());
            }
            page.messages.push(record);
        }
        page.messages.reverse();
        if page.messages.iter().any(|message| message.role == "tool") {
            // Keep the existing display projection for tool review states.
            // These append-only updates can occur on either side of a page.
            if layout.tool_review_state_offsets.len() > MAX_REVIEW_UPDATES {
                return Err(ReadLimit.into());
            }
            let mut states = Vec::new();
            for &offset in &layout.tool_review_state_offsets {
                let (line, invalid_utf8) = read.line(layout, offset, "tool_review_state")?;
                if let Some(state) = parse_tool_review_state(line.trim_end(), invalid_utf8)? {
                    states.push(state);
                }
            }
            apply_tool_review_states(&mut page.messages, &states);
        }
        check_generation(&read.reader, &path, layout)?;
        Ok(page)
    })
}

pub(super) fn check_generation(
    reader: &File,
    path: &Path,
    layout: &TranscriptLayout,
) -> Result<()> {
    let metadata = reader.metadata()?;
    let current = File::open(path)?;
    let live_metadata = current.metadata()?;
    ensure!(
        metadata.len() >= layout.file_len
            && layout::opened_file_identity(reader, &metadata) == layout.identity
            && layout::opened_file_identity(&current, &live_metadata) == layout.identity
            && layout::modification_stamp(path, &live_metadata) == layout.modification_stamp,
        "transcript changed during history read"
    );
    Ok(())
}

pub(super) struct PageRead {
    pub(super) reader: File,
    pub(super) remaining: u64,
}

impl PageRead {
    pub(super) fn line(
        &mut self,
        layout: &TranscriptLayout,
        offset: u64,
        kind: &str,
    ) -> Result<(String, bool)> {
        let next = [
            &layout.message_offsets,
            &layout.compaction_offsets,
            &layout.tool_review_state_offsets,
        ]
        .into_iter()
        .filter_map(|offsets| {
            offsets
                .get(offsets.partition_point(|&at| at <= offset))
                .copied()
        })
        .min()
        .unwrap_or(layout.file_len);
        let span = next
            .checked_sub(offset)
            .ok_or_else(layout::invalid_boundary)?;
        if span > self.remaining {
            return Err(ReadLimit.into());
        }
        self.reader.seek(SeekFrom::Start(offset))?;
        let mut raw = Vec::new();
        let mut reader = BufReader::new((&mut self.reader).take(span));
        reader.read_until(b'\n', &mut raw)?;
        self.remaining -= span - reader.into_inner().limit();
        let (line, invalid_utf8) = match String::from_utf8(raw) {
            Ok(line) => (line, false),
            Err(error) => (String::from_utf8_lossy(error.as_bytes()).into_owned(), true),
        };
        if !line.ends_with('\n') || sniff_line_kind(line.trim_end()) != Some(kind) {
            return Err(layout::invalid_boundary());
        }
        Ok((line, invalid_utf8))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transcripts::{append_message, write_transcript};
    use serde_json::json;

    #[test]
    fn history_cursor_uses_first_position_and_last_payload() {
        let dir = tempfile::tempdir().unwrap();
        let date = "2026-07-26T00:00:00Z";
        let records = [
            ("A", "A"),
            ("B", "old"),
            ("C", "C"),
            ("B", "new"),
            ("D", "D"),
        ];
        for (id, text) in records {
            append_message(
                dir.path(),
                "s1",
                date,
                &MessageRecord {
                    id: id.into(),
                    role: "assistant".into(),
                    tool_name: None,
                    is_error: false,
                    blocks: json!([{ "type": "text", "text": text }]),
                    meta: None,
                    created_at: date.into(),
                },
            )
            .unwrap();
        }
        let mut before = None;
        for (id, text) in [("D", "D"), ("C", "C"), ("B", "new"), ("A", "A")] {
            let page = history_page(dir.path(), "s1", before, 1).unwrap();
            assert_eq!(page.messages.len(), 1);
            assert_eq!(page.messages[0].id, id);
            assert_eq!(page.messages[0].blocks[0]["text"], text);
            assert_eq!(page.has_more_before, id != "A");
            before = Some(id);
        }
        assert!(history_page(dir.path(), "s1", before, 1)
            .unwrap()
            .messages
            .is_empty());
        let latest = history_page(dir.path(), "s1", None, 4).unwrap();
        write_transcript(dir.path(), "s1", date, &latest.messages[..2]).unwrap();
        let after_rewrite = history_page(dir.path(), "s1", Some("C"), 1).unwrap();
        assert_eq!(after_rewrite.messages[0].id, "B");
    }

    #[test]
    fn oversized_message_is_rejected_before_reading_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("transcript");
        std::fs::write(&path, b"sample").unwrap();
        let mut read = PageRead {
            reader: File::open(&path).unwrap(),
            remaining: 4,
        };
        let layout = TranscriptLayout {
            file_len: 6,
            ..Default::default()
        };
        assert!(read
            .line(&layout, 0, "message")
            .unwrap_err()
            .is::<ReadLimit>());
        assert_eq!(read.reader.stream_position().unwrap(), 0);
        assert_eq!(read.remaining, 4);
    }
}
