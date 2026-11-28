//! Bounded model-context restoration, independent of retained historical bodies.
use std::collections::HashMap;
use std::fs::File;
use std::path::Path;

use anyhow::{Context, Result};
use serde::Serialize;

use super::restore::{check_generation, PageRead, ReadLimit};
use super::{
    binary_storage, layout, transcript_path, CompactionRecord, MessageRecord, TranscriptLayout,
};

const CONTEXT_BYTES: u64 = 8 * 1024 * 1024;
const CONTEXT_ROWS: usize = 2048;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ContextRead {
    pub messages: Vec<MessageRecord>,
    pub compaction: Option<CompactionRecord>,
    pub overflow: bool,
    pub omitted_messages: usize,
    pub read_bytes: u64,
}

fn span(layout: &TranscriptLayout, offset: u64) -> u64 {
    [
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
    .unwrap_or(layout.file_len)
    .saturating_sub(offset)
}

pub(crate) fn read_context(
    data_dir: &Path,
    session_id: &str,
    excluded: &[String],
) -> Result<ContextRead> {
    let path = transcript_path(data_dir, session_id)?;
    layout::with_layout_recovery(data_dir, session_id, |layout| {
        if layout.message_offsets.is_empty() {
            return Ok(ContextRead {
                messages: vec![],
                compaction: None,
                overflow: false,
                omitted_messages: 0,
                read_bytes: 0,
            });
        }
        let reader = File::open(&path)?;
        check_generation(&reader, &path, layout)?;
        let mut read = PageRead {
            reader,
            remaining: CONTEXT_BYTES,
        };
        let checkpoint = if let Some(&offset) = layout.compaction_offsets.last() {
            let (line, invalid) = read.line(layout, offset, "compaction")?;
            if invalid {
                return Err(anyhow::anyhow!("invalid checkpoint UTF-8"));
            }
            Some(
                binary_storage::read::<CompactionRecord>(line.trim_end())
                    .context("decode active checkpoint")?,
            )
        } else {
            None
        };
        let mut index = HashMap::new();
        for (position, id) in layout.message_ids.iter().enumerate() {
            let Some(id) = id.as_deref() else {
                return Err(layout::invalid_boundary());
            };
            let entry = index.entry(id).or_insert((position, position));
            entry.1 = position;
        }
        let mut ordered: Vec<_> = index
            .iter()
            .map(|(&id, &(first, last))| (first, last, id))
            .collect();
        ordered.sort_unstable_by_key(|entry| entry.0);
        let boundary = checkpoint.as_ref().and_then(|checkpoint| {
            ordered
                .iter()
                .position(|entry| entry.2 == checkpoint.through_message_id)
        });
        // An invalid checkpoint must never suppress otherwise intact history.
        let checkpoint = if boundary.is_some() { checkpoint } else { None };
        let start = boundary.map(|position| position + 1).unwrap_or(0);
        let mut selected = Vec::new();
        let mut planned = 0;
        let mut first = ordered.len();
        for position in (start..ordered.len()).rev() {
            let (_, payload, id) = ordered[position];
            if excluded.iter().any(|excluded| excluded == id) {
                first = position;
                continue;
            }
            let bytes = span(layout, layout.message_offsets[payload]);
            if selected.len() == CONTEXT_ROWS || bytes > read.remaining.saturating_sub(planned) {
                break;
            }
            planned += bytes;
            selected.push(position);
            first = position;
        }
        let mut overflow = first > start;
        let mut records = Vec::new();
        // Keep the real checkpoint boundary and its nearest assistant carrier.
        // This preserves thought signatures when a tool group crosses it.
        if !overflow {
            if let Some(boundary) = boundary {
                let mut prefix = Vec::new();
                let mut position = boundary;
                loop {
                    let offset = layout.message_offsets[ordered[position].1];
                    if span(layout, offset) > read.remaining.saturating_sub(planned) {
                        overflow = true;
                        break;
                    }
                    let (line, invalid) = read.line(layout, offset, "message")?;
                    if invalid {
                        return Err(anyhow::anyhow!("invalid context boundary UTF-8"));
                    }
                    let record = binary_storage::read::<MessageRecord>(line.trim_end())?;
                    if record.id != ordered[position].2 {
                        return Err(layout::invalid_boundary());
                    }
                    let carrier = record.role == "assistant"
                        && !record
                            .meta
                            .as_ref()
                            .is_some_and(|meta| meta.get("parentToolCallId").is_some());
                    prefix.push(record);
                    if carrier || position == 0 {
                        break;
                    }
                    position -= 1;
                }
                if !overflow {
                    prefix.reverse();
                    records = prefix;
                }
            }
        }
        if overflow {
            records.clear();
        }
        selected.reverse();
        for position in selected {
            let offset = layout.message_offsets[ordered[position].1];
            let (line, invalid) = read.line(layout, offset, "message")?;
            if invalid {
                return Err(anyhow::anyhow!("invalid active context UTF-8"));
            }
            let record = binary_storage::read::<MessageRecord>(line.trim_end())?;
            if record.id != ordered[position].2 {
                return Err(layout::invalid_boundary());
            }
            records.push(record);
        }
        if records.is_empty() && overflow {
            return Err(ReadLimit.into());
        }
        check_generation(&read.reader, &path, layout)?;
        Ok(ContextRead {
            messages: records,
            compaction: checkpoint,
            overflow,
            omitted_messages: if overflow { first } else { start },
            read_bytes: CONTEXT_BYTES - read.remaining,
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transcripts::{append_compaction, append_message};
    use serde_json::json;

    #[test]
    fn increasing_compacted_prefix_does_not_increase_context_body_reads() {
        let root = tempfile::tempdir().unwrap();
        let date = "2026-11-26T00:00:00Z";
        let row = |id: String, text: String| MessageRecord {
            id,
            role: "assistant".into(),
            tool_name: None,
            is_error: false,
            blocks: json!([{ "type":"text", "text":text }]),
            meta: None,
            created_at: date.into(),
        };
        let mut sizes = Vec::new();
        for (session, count) in [("short", 8), ("long", 80)] {
            for i in 0..count {
                append_message(
                    root.path(),
                    session,
                    date,
                    &row(format!("old-{i}"), "x".repeat(128 * 1024)),
                )
                .unwrap();
            }
            append_compaction(
                root.path(),
                session,
                date,
                &CompactionRecord {
                    id: "cp".into(),
                    summary: "summary".into(),
                    first_kept_message_id: None,
                    through_message_id: format!("old-{}", count - 1),
                    tokens_before: 100000,
                    usage: None,
                    retained_tail: None,
                    details: None,
                    provider_id: None,
                    model_id: None,
                    created_at: date.into(),
                },
            )
            .unwrap();
            append_message(
                root.path(),
                session,
                date,
                &row("recent".into(), "recent".into()),
            )
            .unwrap();
            let context = read_context(root.path(), session, &[]).unwrap();
            assert!(!context.overflow);
            assert_eq!(context.messages.len(), 2);
            assert_eq!(
                context.messages[0].blocks[0]["text"]
                    .as_str()
                    .unwrap()
                    .len(),
                128 * 1024
            );
            assert_eq!(context.messages[1].id, "recent");
            sizes.push(context.read_bytes);
        }
        assert!(sizes[0].abs_diff(sizes[1]) < 128);
    }
}
