//! Publish an independent copy of a complete or bounded transcript.
use super::*;

/// Create an independent session from the source transcript, optionally
/// stopping after one message. Message-scoped forks use this to keep later
/// turns out of the child while preserving the same cache/runtime isolation as
/// a full session fork.
pub fn fork_session_through(
    db: &Database,
    source_id: &str,
    title: Option<&str>,
    through_message_id: Option<&str>,
) -> Result<ForkSessionResult> {
    fork_session(db, source_id, title, through_message_id, false, false)
}

pub(super) fn fork_side_question(
    db: &Database,
    source_id: &str,
    title: Option<&str>,
    reference_only: bool,
) -> Result<ForkSessionResult> {
    fork_session(db, source_id, title, None, true, reference_only)
}

fn fork_session(
    db: &Database,
    source_id: &str,
    title: Option<&str>,
    through_message_id: Option<&str>,
    side_question: bool,
    reference_only: bool,
) -> Result<ForkSessionResult> {
    let Some(source) = session_summary(db, source_id)? else {
        return Ok(ForkSessionResult::NotFound);
    };
    let running = session_has_running_turn(db, source_id)?;
    let mut source_records = if reference_only {
        Vec::new()
    } else {
        dedupe_records(transcripts::read_transcript(db.data_dir(), source_id)?)
    };
    let settled_anchor = if side_question {
        if source.scheduled_run || source.side_question.is_some() {
            return Err(anyhow!("Only main conversations can own side questions"));
        }
        let mut settled = None;
        for record in source_records.iter().rev() {
            if record.role != "assistant"
                || record.is_error
                || record
                    .meta
                    .as_ref()
                    .and_then(|meta| meta.get("error"))
                    .is_some_and(|error| !error.is_null())
                || record
                    .meta
                    .as_ref()
                    .and_then(|m| m.get("status"))
                    .and_then(Value::as_str)
                    .is_some_and(|status| status != "complete")
            {
                continue;
            }
            let safe: bool = db.conn().query_row("SELECT EXISTS (SELECT 1 FROM messages anchor WHERE anchor.session_id = ?1 AND anchor.id = ?2 AND NOT EXISTS (SELECT 1 FROM messages m JOIN turns t ON t.id = m.turn_id WHERE m.session_id = ?1 AND t.status = 'running' AND m.seq <= anchor.seq))", params![source_id, record.id], |row| row.get(0))?;
            if safe {
                settled = Some(record.id.clone());
                break;
            }
        }
        settled
    } else {
        None
    };
    let anchor = if side_question {
        settled_anchor.as_deref()
    } else {
        through_message_id
    }
    .map(str::trim)
    .filter(|id| !id.is_empty());
    if running && anchor.is_none() && !side_question {
        return Ok(ForkSessionResult::Busy);
    }
    if side_question && anchor.is_none() {
        source_records.clear();
    }
    if let Some(message_id) = anchor {
        let Some(position) = source_records
            .iter()
            .position(|record| record.id == message_id)
        else {
            return Ok(ForkSessionResult::NotFound);
        };
        if running {
            let record = &source_records[position];
            // An assistant message can be complete while its tool loop is still
            // running. Reject any prefix containing rows owned by a live turn,
            // not merely a streaming anchor. The RPC holds the host state lock
            // across this check and publication, including transcript appends.
            let settled_prefix: bool = db.conn().query_row(
                "SELECT EXISTS (
                    SELECT 1 FROM messages anchor
                    WHERE anchor.session_id = ?1 AND anchor.id = ?2
                    AND NOT EXISTS (
                        SELECT 1 FROM messages m JOIN turns t ON t.id = m.turn_id
                        WHERE m.session_id = ?1 AND t.status = 'running'
                          AND m.seq <= anchor.seq
                    )
                 )",
                params![source_id, message_id],
                |row| row.get(0),
            )?;
            if record.role != "assistant"
                || record.is_error
                || !matches!(
                    record
                        .meta
                        .as_ref()
                        .and_then(|meta| meta.get("status"))
                        .and_then(Value::as_str),
                    None | Some("complete")
                )
                || record
                    .meta
                    .as_ref()
                    .and_then(|meta| meta.get("error"))
                    .is_some_and(|error| !error.is_null())
                || !settled_prefix
            {
                return Ok(ForkSessionResult::Busy);
            }
        }
        source_records.truncate(position + 1);
    }
    let side_origin = side_question.then(|| side_questions::SideQuestionOrigin {
        parent_session_id: source_id.to_string(),
        parent_title: source.title.clone(),
        through_message_id: anchor.map(str::to_string),
        anchor_label: source_records
            .last()
            .and_then(record_index_text)
            .unwrap_or_default()
            .chars()
            .take(120)
            .collect(),
        inherited_message_count: source_records.len() as i64,
        archived: false,
    });
    let source_compactions = if side_question && anchor.is_none() {
        Vec::new()
    } else {
        transcripts::read_compactions(db.data_dir(), source_id)?
    };
    let (mut records, message_ids, tool_call_ids) = clone_records_for_fork(source_records);
    // Each checkpoint is remapped on its own: a message-scoped fork can cut the
    // anchor of a later checkpoint while the earlier ones stay intact.
    let mut compactions: Vec<CompactionRecord> = source_compactions
        .into_iter()
        .filter_map(|record| clone_compaction_for_fork(record, &message_ids, &tool_call_ids))
        .collect();
    let id = Uuid::new_v4().to_string();
    let files = fork_files::preserve(
        db.data_dir(),
        source_id,
        &id,
        &mut records,
        &mut compactions,
    )?;
    let visualization_files = fork_files::preserve_visualizations(
        db.data_dir(),
        source_id,
        &id,
        &mut records,
        &mut compactions,
    )?;
    let texts = records.iter().map(record_index_text).collect::<Vec<_>>();
    let now = now_ms();
    let created_at = ms_to_ts(now);
    let requested_title = title.map(str::trim).filter(|value| !value.is_empty());
    let title = requested_title
        .map(|value| value.chars().take(100).collect::<String>())
        .unwrap_or_else(|| format!("{} (branch)", source.title));

    if let Err(error) = transcripts::write_transcript_with_compactions(
        db.data_dir(),
        &id,
        &created_at,
        &records,
        &compactions,
    ) {
        transcripts::remove_session_files(db.data_dir(), &id);
        return Err(error);
    }
    let indexed = (|| -> Result<()> {
        let tx = db.conn().unchecked_transaction()?;
        let inserted = tx
            .prepare_cached(
                "INSERT INTO sessions (
                    id, title, project_id, provider_id, model_id, mode, thinking_level,
                    permission_mode, fast_mode, mode_snapshot_hash, source, pinned, last_seq,
                    created_at, updated_at
                 )
                 SELECT ?1, ?2, project_id, provider_id, model_id, mode, thinking_level,
                        permission_mode, fast_mode, mode_snapshot_hash, NULL, 0, ?3, ?4, ?4
                 FROM sessions WHERE id = ?5",
            )?
            .execute(params![id, title, records.len() as i64, now, source_id])?;
        if inserted == 0 {
            return Err(anyhow!("session not found: {source_id}"));
        }
        if let Some(origin) = &side_origin {
            tx.execute(
                "UPDATE sessions SET mode = 'agent', mode_snapshot_hash = NULL WHERE id = ?1",
                [&id],
            )?;
            tx.execute(
                "INSERT INTO kv (ns, key, value_json, updated_at) VALUES (?1, ?2, ?3, ?4)",
                params![
                    side_questions::NAMESPACE,
                    id,
                    serde_json::to_string(origin)?,
                    now
                ],
            )?;
        }
        for (seq, record) in records.iter().enumerate() {
            insert_index_row(&tx, &id, seq as i64, None, record, texts[seq].as_deref())?;
        }
        tx.commit()?;
        Ok(())
    })();
    if let Err(error) = indexed {
        transcripts::remove_session_files(db.data_dir(), &id);
        return Err(error);
    }
    files.commit();
    visualization_files.commit();

    let summary = SessionSummary {
        side_question: side_origin,
        scheduled_run: false,
        id,
        title,
        message_count: records.len() as i64,
        project_path: source.project_path,
        model_id: source.model_id,
        provider_id: source.provider_id,
        mode: if side_question {
            "agent".into()
        } else {
            source.mode
        },
        thinking_level: source.thinking_level,
        permission_mode: source.permission_mode,
        worktree: None,
        fast_mode: source.fast_mode,
        updated_at: created_at.clone(),
        created_at,
    };
    let messages = records.into_iter().map(record_to_ui).collect();
    Ok(ForkSessionResult::Created(Box::new(SessionDetail {
        summary,
        plan_history: Vec::new(),
        navigation_parent: None,
        message_start: None,
        message_end: None,
        has_more_after: None,
        has_more_before: None,
        messages,
        compaction: compactions.last().cloned(),
        compactions,
    })))
}
