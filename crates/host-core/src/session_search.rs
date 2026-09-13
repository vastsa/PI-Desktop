//! Desktop search projections. SQLite owns discovery; JSONL owns message content.

use anyhow::Result;
use rusqlite::{functions::FunctionFlags, params, OptionalExtension};
use serde::Serialize;

use crate::db::{ms_to_ts, Database};
use crate::sessions::{self, SessionSummary};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageMatch {
    pub message_id: String,
    pub role: String,
    pub created_at: String,
    pub snippet: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMatch {
    pub session: SessionSummary,
    pub project_name: Option<String>,
    pub metadata_match: bool,
    pub message_count: i64,
    pub matches: Vec<MessageMatch>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchPage {
    pub hits: Vec<SessionMatch>,
    pub next_offset: Option<i64>,
}

/// Unicode lowercase is shared with the renderer. A scalar function keeps
/// short and non-ASCII queries literal without relying on SQLite's ASCII LIKE.
fn register_contains(db: &Database) -> Result<()> {
    db.conn().create_scalar_function(
        "pi_search_contains",
        2,
        FunctionFlags::SQLITE_UTF8
            | FunctionFlags::SQLITE_DETERMINISTIC
            | FunctionFlags::SQLITE_INNOCUOUS,
        |ctx| {
            let text = ctx.get::<Option<String>>(0)?.unwrap_or_default();
            let query = ctx.get::<String>(1)?;
            Ok(text.to_lowercase().contains(&query.to_lowercase()))
        },
    )?;
    Ok(())
}

/// FTS is a prefilter for ASCII and uncased text such as CJK. Non-ASCII
/// case mappings use a literal scan to avoid the FTS tokenizer's older Unicode
/// tables dropping characters handled by the host/renderer lowercase rules.
pub fn search(db: &Database, query: &str, offset: i64) -> Result<SearchPage> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(SearchPage {
            hits: vec![],
            next_offset: None,
        });
    }
    let offset = offset.max(0);
    register_contains(db)?;
    let quoted = format!("\"{}\"", query.replace('"', "\"\""));
    let fts = if query.chars().count() >= 3
        && !query.contains('\u{0307}')
        && query
            .chars()
            .all(|ch| ch.is_ascii() || (!ch.is_lowercase() && !ch.is_uppercase()))
    {
        "AND m.mid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?2)"
    } else {
        "AND ?2 IS NOT NULL"
    };
    let sql = format!(
        "WITH matched AS (
           SELECT m.session_id, COUNT(*) AS count FROM messages m
           WHERE m.role IN ('user', 'assistant') AND pi_search_contains(m.text, ?1) {fts}
           GROUP BY m.session_id
         )
         SELECT s.id, s.title, s.last_seq, p.path, s.model_id, s.provider_id, s.mode,
                s.thinking_level, s.permission_mode, s.updated_at, s.created_at,
                p.name, COALESCE(matched.count, 0),
                (pi_search_contains(s.title, ?1) OR pi_search_contains(p.name, ?1)
                 OR pi_search_contains(p.path, ?1)) AS metadata_match
         FROM sessions s LEFT JOIN projects p ON p.id = s.project_id
         LEFT JOIN matched ON matched.session_id = s.id
         WHERE s.deleted_at IS NULL AND (matched.count > 0 OR metadata_match)
         ORDER BY s.updated_at DESC, s.id ASC LIMIT 31 OFFSET ?3"
    );
    let mut hits = db
        .conn()
        .prepare_cached(&sql)?
        .query_map(params![query, quoted, offset], |row| {
            Ok(SessionMatch {
                session: sessions::summary_from_row(row)?,
                project_name: row.get(11)?,
                message_count: row.get(12)?,
                metadata_match: row.get(13)?,
                matches: vec![],
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let next_offset = (hits.len() > 30).then(|| offset.saturating_add(30));
    hits.truncate(30);
    let mut snippets = db.conn().prepare_cached(
        "SELECT id, role, created_at, text FROM messages
         WHERE session_id = ?1 AND role IN ('user', 'assistant') AND pi_search_contains(text, ?2)
         ORDER BY created_at DESC, seq DESC, id ASC LIMIT 2",
    )?;
    for hit in &mut hits {
        if hit.message_count == 0 {
            continue;
        }
        hit.matches = snippets
            .query_map(params![hit.session.id, query], |row| {
                Ok(MessageMatch {
                    message_id: row.get(0)?,
                    role: row.get(1)?,
                    created_at: ms_to_ts(row.get(2)?),
                    snippet: sentence_excerpt(&row.get::<_, String>(3)?, query, 180),
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
    }
    Ok(SearchPage { hits, next_offset })
}

/// Map lowercase expansion offsets back to original Unicode characters.
fn match_range(text: &str, query: &str) -> Option<(usize, usize)> {
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return None;
    }
    let hit = text.to_lowercase().find(&needle)?;
    let mut folded_offset = 0;
    let mut position = 0;
    let mut found_start = false;
    for (index, ch) in text.chars().enumerate() {
        let next = folded_offset + ch.to_lowercase().map(char::len_utf8).sum::<usize>();
        if !found_start && next > hit {
            position = index;
            found_start = true;
        }
        if next >= hit + needle.len() {
            return Some((position, index + 1));
        }
        folded_offset = next;
    }
    None
}

/// Return the sentence or line containing the match. Long sentences retain a
/// bounded window around the complete query, rather than adjacent sentences.
fn sentence_excerpt(text: &str, query: &str, budget: usize) -> String {
    let Some((position, match_end)) = match_range(text, query) else {
        return excerpt(text, query, budget);
    };
    let chars: Vec<char> = text.chars().collect();
    let is_closing = |ch: char| matches!(ch, '"' | '\'' | '”' | '’' | '」' | '』' | ')' | '）');
    let mut start = 0;
    let mut end = chars.len();
    let mut index = 0;
    while index < chars.len() {
        let ch = chars[index];
        let newline = matches!(ch, '\n' | '\r' | '\u{2028}' | '\u{2029}');
        let boundary = newline
            || matches!(ch, '。' | '！' | '？' | '!' | '?')
            || (ch == '.'
                && chars
                    .get(index + 1)
                    .is_none_or(|next| next.is_whitespace() || is_closing(*next)));
        index += 1;
        if !boundary {
            continue;
        }
        if !newline {
            while index < chars.len()
                && (is_closing(chars[index])
                    || matches!(chars[index], '.' | '!' | '?' | '。' | '！' | '？'))
            {
                index += 1;
            }
        }
        if index <= position {
            start = index;
        } else if index >= match_end {
            end = index;
            break;
        }
    }
    let sentence: String = chars[start..end].iter().collect();
    let sentence = sentence.trim();
    if sentence.chars().count() <= budget {
        sentence.to_owned()
    } else {
        excerpt(sentence, query, budget)
    }
}

/// Center a bounded excerpt on the literal match without splitting Unicode.
pub fn excerpt(text: &str, query: &str, budget: usize) -> String {
    let (position, match_end) = match_range(text, query).unwrap_or((0, 0));
    let total = text.chars().count();
    let start = position.saturating_sub(budget / 3);
    let end = (start + budget).max(match_end).min(total);
    format!(
        "{}{}{}",
        if start > 0 { "…" } else { "" },
        text.chars()
            .skip(start)
            .take(end - start)
            .collect::<String>(),
        if end < total { "…" } else { "" }
    )
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextMessage {
    pub id: String,
    pub role: String,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    pub content: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchContext {
    pub messages: Vec<ContextMessage>,
    pub has_more_before: bool,
    pub has_more_after: bool,
    pub previous_match_id: Option<String>,
    pub next_match_id: Option<String>,
}

/// Keep historical search windows out of the live transcript cache. Resolve
/// stable message IDs against physical JSONL positions, never SQLite seq.
pub fn context(
    db: &Database,
    session_id: &str,
    message_id: &str,
    direction: &str,
    query: &str,
) -> Result<Option<SearchContext>> {
    register_contains(db)?;
    let exists = db
        .conn()
        .query_row(
            "SELECT 1 FROM sessions s JOIN messages m ON m.session_id = s.id
         WHERE s.id = ?1 AND m.id = ?2 AND s.deleted_at IS NULL",
            params![session_id, message_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if !exists {
        return Ok(None);
    }
    let layout = sessions::session_layout(db, session_id)?;
    let Some(position) =
        crate::transcripts::find_message_position(db.data_dir(), session_id, &layout, message_id)?
    else {
        return Ok(None);
    };
    let total = layout.message_count();
    let (start, end) = match direction {
        "before" => (position.saturating_sub(20), position),
        "after" => ((position + 1).min(total), (position + 21).min(total)),
        _ => (position.saturating_sub(10), (position + 11).min(total)),
    };
    let read = crate::transcripts::read_transcript_window_with_layout(
        db.data_dir(),
        session_id,
        &layout,
        start,
        Some(end - start),
    )?;
    let messages = sessions::dedupe_records(read.messages)
        .into_iter()
        .map(|record| {
            let text = sessions::record_index_text(&record).unwrap_or_default();
            let content = excerpt(
                &text,
                if record.id == message_id && direction == "around" {
                    query
                } else {
                    ""
                },
                64 * 1024,
            );
            ContextMessage {
                id: record.id,
                role: record.role,
                created_at: record.created_at,
                tool_name: record.tool_name,
                content,
            }
        })
        .collect();
    let adjacent_match = |comparison: &str, order: &str| -> Result<Option<String>> {
        if query.trim().is_empty() {
            return Ok(None);
        }
        Ok(db
            .conn()
            .query_row(
                &format!(
                    "SELECT id FROM messages WHERE session_id = ?1
                AND role IN ('user', 'assistant') AND pi_search_contains(text, ?2)
                AND seq {comparison} (SELECT seq FROM messages WHERE id = ?3)
                ORDER BY seq {order} LIMIT 1"
                ),
                params![session_id, query.trim(), message_id],
                |row| row.get(0),
            )
            .optional()?)
    };
    Ok(Some(SearchContext {
        messages,
        has_more_before: start > 0,
        has_more_after: end < total,
        previous_match_id: adjacent_match("<", "DESC")?,
        next_match_id: adjacent_match(">", "ASC")?,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sessions::UiMessage;
    use serde_json::json;

    fn message(id: &str, text: &str) -> UiMessage {
        serde_json::from_value(json!({ "id": id, "role": "user", "content": text,
            "createdAt": "2026-09-13T00:00:00Z" }))
        .unwrap()
    }

    #[test]
    fn search_counts_all_matches_and_pages_all_sessions() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("test.sqlite")).unwrap();
        let first = sessions::create_session(&db, None, None, None, None, None).unwrap();
        for n in 0..125 {
            sessions::append_message(&db, &first.id, &message(&format!("m{n}"), "needle"), None)
                .unwrap();
        }
        for n in 0..64 {
            let session = sessions::create_session(&db, None, None, None, None, None).unwrap();
            sessions::append_message(
                &db,
                &session.id,
                &message(&format!("other{n}"), "needle"),
                None,
            )
            .unwrap();
        }
        let mut ids = std::collections::HashSet::new();
        let mut offset = 0;
        loop {
            let page = search(&db, "needle", offset).unwrap();
            for hit in page.hits {
                assert!(ids.insert(hit.session.id.clone()));
                if hit.session.id == first.id {
                    assert_eq!(hit.message_count, 125);
                    assert_eq!(hit.matches.len(), 2);
                }
            }
            match page.next_offset {
                Some(next) => offset = next,
                None => break,
            }
        }
        assert_eq!(ids.len(), 65);
        assert!(search(&db, "needle", i64::MAX).unwrap().hits.is_empty());
    }

    #[test]
    fn search_literals_snippets_roles_and_deleted_sessions() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("test.sqlite")).unwrap();
        let session = sessions::create_session(&db, None, None, None, None, None).unwrap();
        let text = format!(
            "{} 中文 短 100% a_b C:\\path \"quote\" MiXeD WÖRTER İxx Key",
            "prefix ".repeat(100)
        );
        sessions::append_message(&db, &session.id, &message("one", &text), None).unwrap();
        for query in [
            "中文",
            "短",
            "%",
            "a_b",
            "C:\\path",
            "\"quote\"",
            "mixed",
            "wörter",
            "i\u{0307}xx",
            "key",
        ] {
            let page = search(&db, query, 0).unwrap();
            assert_eq!(page.hits.len(), 1, "query: {query}");
            assert!(page.hits[0].matches[0]
                .snippet
                .to_lowercase()
                .contains(&query.to_lowercase()));
        }
        let mut excluded = message("system", "exclusive");
        excluded.role = "system".into();
        sessions::append_message(&db, &session.id, &excluded, None).unwrap();
        assert!(search(&db, "exclusive", 0).unwrap().hits.is_empty());
        let mut assistant = message("assistant", "assistant-only");
        assistant.role = "assistant".into();
        assistant.thinking = Some("private-reasoning".into());
        sessions::append_message(&db, &session.id, &assistant, None).unwrap();
        assert_eq!(
            search(&db, "assistant-only", 0).unwrap().hits[0].matches[0].role,
            "assistant"
        );
        assert!(search(&db, "private-reasoning", 0).unwrap().hits.is_empty());
        db.conn()
            .execute(
                "UPDATE sessions SET title = 'metadata-only' WHERE id = ?1",
                params![session.id],
            )
            .unwrap();
        let metadata = search(&db, "metadata-only", 0).unwrap();
        assert!(metadata.hits[0].metadata_match);
        assert_eq!(metadata.hits[0].message_count, 0);
        assert_eq!(
            search(&db, "assistant-only", 0).unwrap().hits[0].message_count,
            1
        );
        db.conn()
            .execute(
                "UPDATE sessions SET deleted_at = 1 WHERE id = ?1",
                params![session.id],
            )
            .unwrap();
        assert!(search(&db, "中文", 0).unwrap().hits.is_empty());
        assert!(context(&db, &session.id, "one", "around", "中文")
            .unwrap()
            .is_none());
    }

    #[test]
    fn context_uses_physical_positions_and_finds_matches_beyond_display_cap() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("test.sqlite")).unwrap();
        let session = sessions::create_session(&db, None, None, None, None, None).unwrap();
        for n in 0..150 {
            let msg = message(&format!("m{n}"), "context");
            sessions::append_message(&db, &session.id, &msg, None).unwrap();
            if n < 30 {
                sessions::append_message(&db, &session.id, &msg, None).unwrap();
            }
        }
        let target = message("target", &format!("{}命中内容", "x".repeat(100_000)));
        sessions::append_message(&db, &session.id, &target, None).unwrap();
        let page = context(&db, &session.id, "m50", "around", "context")
            .unwrap()
            .unwrap();
        assert!(page.messages.iter().any(|m| m.id == "m50"));
        assert!(page.messages.len() <= 21);
        assert!(page.has_more_before && page.has_more_after);
        assert_eq!(page.previous_match_id.as_deref(), Some("m49"));
        assert_eq!(page.next_match_id.as_deref(), Some("m51"));
        let next = context(
            &db,
            &session.id,
            &page.messages.last().unwrap().id,
            "after",
            "context",
        )
        .unwrap()
        .unwrap();
        assert_eq!(next.messages.first().unwrap().id, "m61");
        let last = context(&db, &session.id, "target", "around", "命中")
            .unwrap()
            .unwrap();
        let found = last.messages.iter().find(|m| m.id == "target").unwrap();
        assert!(found.content.contains("命中"));
        assert!(found.content.chars().count() <= 65538);
        assert!(!last.has_more_after);
        assert!(context(&db, &session.id, "missing", "around", "")
            .unwrap()
            .is_none());
        db.conn()
            .execute(
                "UPDATE messages SET text = 'stale index' WHERE id = 'target'",
                [],
            )
            .unwrap();
        let canonical = context(&db, &session.id, "target", "around", "命中")
            .unwrap()
            .unwrap();
        assert!(canonical
            .messages
            .iter()
            .find(|m| m.id == "target")
            .unwrap()
            .content
            .contains("命中"));
        sessions::replace_messages(&db, &session.id, &[message("replacement", "other")]).unwrap();
        assert!(context(&db, &session.id, "target", "around", "命中")
            .unwrap()
            .is_none());
    }

    #[test]
    fn search_previews_show_the_matching_sentence() {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("test.sqlite")).unwrap();
        let session = sessions::create_session(&db, None, None, None, None, None).unwrap();
        for (text, query, expected) in [
            (
                "前一句。消息一直在排队，没有继续执行。后一句。",
                "排队",
                "消息一直在排队，没有继续执行。",
            ),
            (
                "Before. The NEEDLE is here! After.",
                "needle",
                "The NEEDLE is here!",
            ),
            (
                "Before. Open src/main.rs for the needle. After.",
                "needle",
                "Open src/main.rs for the needle.",
            ),
            (
                "Heading\n\nOne\nTwo\nThe needle is here\nUnrelated",
                "needle",
                "The needle is here",
            ),
            (
                "前一句。“消息还在排队！”后一句。",
                "排队",
                "“消息还在排队！”",
            ),
            (
                "Before. İSTANBUL is here. After.",
                "i\u{0307}stanbul",
                "İSTANBUL is here.",
            ),
        ] {
            sessions::replace_messages(&db, &session.id, &[message("target", text)]).unwrap();
            let result = search(&db, query, 0).unwrap();
            assert_eq!(result.hits[0].matches[0].snippet, expected);
        }
    }

    #[test]
    fn sentence_previews_preserve_long_and_multiline_matches() {
        assert_eq!(
            sentence_excerpt(
                &format!("{} The needle is here.", "!".repeat(100_000)),
                "needle",
                180
            ),
            "The needle is here."
        );
        let text = format!(
            "Before. {}needle{}. After.",
            "a".repeat(1000),
            "z".repeat(1000)
        );
        let snippet = sentence_excerpt(&text, "needle", 180);
        assert!(snippet.contains("needle"));
        assert!(snippet.chars().count() <= 182);
        assert!(!snippet.contains("Before") && !snippet.contains("After"));
        assert_eq!(
            sentence_excerpt("Before. One.\nTwo match! After.", "One.\nTwo", 180),
            "One.\nTwo match!"
        );
        let query = "中".repeat(300);
        let text = format!("Before. {}{} tail. After.", "İ".repeat(300), query);
        assert!(sentence_excerpt(&text, &query, 180).contains(&query));
    }

    #[test]
    fn excerpts_include_the_whole_query_when_it_exceeds_the_preview_budget() {
        let shifted = format!("{}命中", "İ".repeat(300));
        assert!(excerpt(&shifted, "命中", 180).contains("命中"));
        let query = "中".repeat(300);
        let text = format!("{}{} tail", "prefix ".repeat(50), query);
        assert!(excerpt(&text, &query, 180).contains(&query));
    }
}
