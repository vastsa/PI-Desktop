//! Read the end of a transcript without reading the whole file.
//!
//! A reader that only needs the newest records still has to see them as the
//! full read would: deduplicated keep-last by id, each id at the position of
//! its *first* line. A suffix gives that answer only when no id in it also
//! appears before it, so the suffix is widened until it is closed under ids.
//! Then the full deduplicated list is the prefix's list followed by the
//! suffix's, and anything the caller derives from the suffix matches the full
//! read exactly.

use std::collections::HashMap;
use std::path::Path;

use anyhow::Result;

use super::layout::{self, InvalidLayoutBoundary, TranscriptLayout};
use super::{read_transcript_window_with_layout, MessageRecord};

/// First chunk read from the end. Each further step doubles, so a reader whose
/// answer sits N lines from the end reads O(N) lines in O(log N) steps.
const FIRST_CHUNK: usize = 8;

/// The message records (in file order, not deduplicated) of the shortest
/// id-closed suffix for which `enough` answers true, or of the whole
/// transcript when no suffix does.
///
/// `None` means the layout cannot prove closure — an unreadable identity, or a
/// line the indexed reader rejects where the full reader would skip it — and
/// the caller must use the full read instead.
pub fn read_closed_message_suffix(
    data_dir: &Path,
    session_id: &str,
    mut enough: impl FnMut(&[MessageRecord]) -> bool,
) -> Result<Option<Vec<MessageRecord>>> {
    layout::with_layout_recovery(data_dir, session_id, |layout| {
        read_suffix_with_layout(data_dir, session_id, layout, &mut enough)
    })
}

fn read_suffix_with_layout(
    data_dir: &Path,
    session_id: &str,
    layout: &TranscriptLayout,
    enough: &mut impl FnMut(&[MessageRecord]) -> bool,
) -> Result<Option<Vec<MessageRecord>>> {
    let Some(first_line) = first_line_by_id(layout) else {
        return Ok(None);
    };
    let total = layout.message_count();
    // Chunks are read newest-first; `suffix` is kept in file order.
    let mut suffix: Vec<MessageRecord> = Vec::new();
    let mut start = total;
    let mut chunk = FIRST_CHUNK;
    while start > 0 {
        let wanted = start.saturating_sub(chunk);
        let next = close_under_ids(layout, &first_line, wanted, start);
        let read = match read_transcript_window_with_layout(
            data_dir,
            session_id,
            layout,
            next,
            Some(start - next),
        ) {
            Ok(read) => read,
            // A stale layout is rebuilt by the caller's recovery and retried.
            Err(error) if error.is::<InvalidLayoutBoundary>() => return Err(error),
            Err(error) => {
                tracing::debug!(%error, "transcript suffix read fell back to the full read");
                return Ok(None);
            }
        };
        if read.messages.len() != start - next {
            // The indexed reader skipped a line (torn UTF-8). The full reader
            // decides those differently, so do not guess.
            return Ok(None);
        }
        let mut widened = read.messages;
        widened.append(&mut suffix);
        suffix = widened;
        start = next;
        if enough(&suffix) {
            break;
        }
        chunk = chunk.saturating_mul(2);
    }
    Ok(Some(suffix))
}

/// Physical line of each id's first occurrence; `None` when any message line
/// has no readable identity, because closure cannot be proven for it.
fn first_line_by_id(layout: &TranscriptLayout) -> Option<HashMap<&str, usize>> {
    let mut first = HashMap::with_capacity(layout.message_ids.len());
    for (line, id) in layout.message_ids.iter().enumerate() {
        first.entry(id.as_deref()?).or_insert(line);
    }
    Some(first)
}

/// Lowest start `<= wanted` such that every id on lines `[start, total)` first
/// occurs at or after `start`. Lines `[old_start, total)` are already closed,
/// so only the newly added lines can pull the start earlier.
fn close_under_ids(
    layout: &TranscriptLayout,
    first_line: &HashMap<&str, usize>,
    wanted: usize,
    old_start: usize,
) -> usize {
    let mut start = wanted;
    let mut scanned_from = old_start;
    while scanned_from > start {
        let lowest = layout.message_ids[start..scanned_from]
            .iter()
            .filter_map(|id| id.as_deref().and_then(|id| first_line.get(id)))
            .copied()
            .min()
            .unwrap_or(start);
        scanned_from = start;
        start = start.min(lowest);
    }
    start
}
