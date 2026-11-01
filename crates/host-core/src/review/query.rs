//! Durable review discovery and bounded transport projections.
use super::*;
use crate::db::Database;
use crate::sessions;
use crate::transcripts::{self, MessageRecord};
use serde_json::json;
use std::collections::{HashMap, HashSet};

const MAX_CHANGE_BYTES: usize = 16 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Request {
    pub session_id: String,
    before: Option<i64>,
    limit: Option<i64>,
    turn_id: Option<String>,
    snapshot_id: Option<String>,
    offset: Option<i64>,
    context: Option<i64>,
}

impl Request {
    pub fn parse(method: &str, params: Value) -> Result<Self> {
        let request: Self = serde_json::from_value(params)?;
        if !safe_component(&request.session_id)
            || request.before.is_some_and(|value| value < 0)
            || request.offset.is_some_and(|value| value < 0)
            || request
                .turn_id
                .as_ref()
                .is_some_and(|value| value.is_empty())
            || request
                .snapshot_id
                .as_ref()
                .is_some_and(|value| !safe_component(value))
        {
            return Err(anyhow!("invalid review parameters"));
        }
        if method == "review.context"
            && (request.snapshot_id.is_none() || !matches!(request.context, Some(1 | 3 | 5)))
        {
            return Err(anyhow!("snapshotId and context (1, 3, 5) required"));
        }
        Ok(request)
    }
}

struct Turn {
    position: usize,
    id: String,
    created_at: String,
    title: String,
    changes: Vec<Value>,
    snapshots: HashSet<String>,
    totals: Option<(u64, u64)>,
}

fn field<'a>(value: &'a Value, name: &str) -> Option<&'a str> {
    value.get(name).and_then(Value::as_str)
}

fn tool_block(record: &MessageRecord) -> Option<&Value> {
    record
        .blocks
        .as_array()?
        .iter()
        .find(|block| field(block, "type") == Some("tool_call"))
}

fn reviews(block: &Value) -> Vec<&Value> {
    let Some(review) = block.pointer("/result/details/review") else {
        return Vec::new();
    };
    match review {
        Value::Array(items) => items.iter().collect(),
        Value::Object(_) => vec![review],
        _ => Vec::new(),
    }
}

fn parent(record: &MessageRecord) -> Option<&str> {
    record
        .meta
        .as_ref()
        .and_then(|meta| field(meta, "parentToolCallId"))
}

// A parent Task owns its descendants even when their terminal results arrive
// after a new prompt, or the descendant has a separate runtime turn id.
fn owner(
    index: usize,
    records: &[MessageRecord],
    calls: &HashMap<String, usize>,
    indexed: &HashMap<String, String>,
    turn_users: &HashMap<String, usize>,
    fallback: &[Option<usize>],
) -> Option<usize> {
    let mut cursor = index;
    let mut visited = HashSet::new();
    while let Some(call) = parent(&records[cursor]) {
        if !visited.insert(cursor) {
            return None;
        }
        let Some(parent_index) = calls.get(call) else {
            // An incomplete legacy transcript can lack the spawning Task.
            // Preserve its evidence using the index/order fallback below.
            break;
        };
        cursor = *parent_index;
    }
    indexed
        .get(&records[cursor].id)
        .and_then(|turn| turn_users.get(turn).copied())
        .or(fallback[cursor])
}

fn project(
    db: &Database,
    session_id: &str,
    record: &MessageRecord,
    block: &Value,
    raw: &Value,
    workspace_root: Option<&Path>,
) -> Result<Option<(String, Value)>> {
    let Ok(mut review) = serde_json::from_value::<ReviewChange>(raw.clone()) else {
        return Ok(None);
    };
    if review.version != 1 || !safe_component(&review.snapshot_id) || review.path.is_empty() {
        return Ok(None);
    }
    // The native snapshot's execution root wins over transcript annotations.
    match read_meta(db.data_dir(), session_id, &review.snapshot_id) {
        Ok(meta) => {
            review.root = meta.root.or(review.root);
            review.reversible &= meta.reversible;
            review.state = meta.state;
        }
        Err(error)
            if error
                .downcast_ref::<std::io::Error>()
                .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound) =>
        {
            // Forked transcripts retain evidence, not ownership of snapshots.
            review.reversible = false;
        }
        Err(error) => return Err(error),
    }
    if let Some(root) = &review.root {
        if workspace_root
            .and_then(|path| path.canonicalize().ok())
            .as_deref()
            != Some(Path::new(root))
        {
            review.reversible = false;
        }
    } else if parent(record).is_some() {
        review.reversible = false;
    }
    // Keep every change, including oversized individual hunks. Truncation is
    // explicit and only removes the tail of the preview, not the whole card.
    while serde_json::to_vec(&review)?.len() > MAX_CHANGE_BYTES && !review.hunks.is_empty() {
        review.truncated = true;
        let last = review
            .hunks
            .last_mut()
            .ok_or_else(|| anyhow!("missing review hunk"))?;
        if last.lines.len() > 1 {
            last.lines.truncate(last.lines.len() / 2);
        } else {
            review.hunks.pop();
        }
    }
    // Host-generated identity/path metadata is naturally bounded by filesystem
    // limits. Corrupt oversized metadata is an error, never a silent omission.
    if serde_json::to_vec(&review)?.len() > MAX_CHANGE_BYTES {
        return Err(anyhow!("review metadata exceeds transport budget"));
    }
    let snapshot = review.snapshot_id.clone();
    let root = review.root.clone();
    let mut message = json!({
        "id": record.id, "role": "tool", "content": "", "createdAt": record.created_at,
        "toolName": record.tool_name.as_deref().or_else(|| field(block, "name")),
        "toolCallId": field(block, "callId"), "status": "complete", "toolStatus": "success",
        "toolResult": { "details": { "root": block.pointer("/result/details/root"), "review": review } }
    });
    for key in ["parentToolCallId", "nestedParentToolCallId", "agentName"] {
        if let Some(value) = record.meta.as_ref().and_then(|meta| meta.get(key)) {
            message[key] = value.clone();
        }
    }
    let mut result = json!({ "message": message });
    if let Some(root) = root {
        result["root"] = json!(root);
    }
    if serde_json::to_vec(&result)?.len() > 2 * MAX_CHANGE_BYTES {
        return Err(anyhow!("review message exceeds transport budget"));
    }
    Ok(Some((snapshot, result)))
}

fn collect(db: &Database, session_id: &str, workspace_root: Option<&Path>) -> Result<Vec<Turn>> {
    let records =
        sessions::dedupe_records(transcripts::read_transcript(db.data_dir(), session_id)?);
    let mut stmt = db.conn().prepare(
        "SELECT id, turn_id FROM messages WHERE session_id = ?1 AND turn_id IS NOT NULL",
    )?;
    let indexed: HashMap<String, String> = stmt
        .query_map([session_id], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let mut turns: Vec<Turn> = Vec::new();
    let mut turn_users = HashMap::new();
    let mut fallback = Vec::with_capacity(records.len());
    let mut current = None;
    let mut calls = HashMap::new();
    for (index, record) in records.iter().enumerate() {
        let meta = record.meta.as_ref();
        if record.role == "user"
            && parent(record).is_none()
            && meta.and_then(|value| value.get("modelSystem")).is_none()
            && meta.and_then(|value| value.get("sessionMessage")).is_none()
        {
            current = Some(turns.len());
            let title: String = record
                .blocks
                .as_array()
                .into_iter()
                .flatten()
                .filter(|block| field(block, "type") == Some("text"))
                .filter_map(|block| field(block, "text"))
                .flat_map(str::chars)
                .take(80)
                .collect();
            turns.push(Turn {
                position: index,
                id: record.id.clone(),
                created_at: record.created_at.clone(),
                title,
                changes: Vec::new(),
                snapshots: HashSet::new(),
                totals: Some((0, 0)),
            });
            if let Some(turn) = indexed.get(&record.id) {
                turn_users.entry(turn.clone()).or_insert(turns.len() - 1);
            }
        }
        fallback.push(current);
        if let Some(call) = tool_block(record).and_then(|block| field(block, "callId")) {
            calls.entry(call.to_owned()).or_insert(index);
        }
    }
    let mut seen = HashSet::new();
    for (index, record) in records.iter().enumerate() {
        if record.role != "tool" || record.is_error {
            continue;
        }
        let Some(block) = tool_block(record) else {
            continue;
        };
        if !matches!(
            record.tool_name.as_deref().or_else(|| field(block, "name")),
            Some("Write" | "Edit")
        ) || field(block, "status") != Some("success")
            || block.get("isError").and_then(Value::as_bool) == Some(true)
            || block.pointer("/result/isError").and_then(Value::as_bool) == Some(true)
            || block
                .pointer("/result/details/root")
                .and_then(Value::as_str)
                .is_none_or(|root| {
                    !matches!(root, "workspace" | "scratch" | "external" | "visualization")
                })
        {
            continue;
        }
        let Some(turn) = owner(index, &records, &calls, &indexed, &turn_users, &fallback) else {
            continue;
        };
        for raw in reviews(block) {
            if let Some((snapshot, projected)) =
                project(db, session_id, record, block, raw, workspace_root)?
            {
                if seen.insert(snapshot.clone()) {
                    // Sum only deduplicated successful evidence. Original preview limits
                    // mean unknown counts; transport-only hunk trimming does not.
                    turns[turn].totals = turns[turn].totals.and_then(|(adds, dels)| {
                        if raw.get("binary").and_then(Value::as_bool) == Some(true)
                            || raw.get("truncated").and_then(Value::as_bool) == Some(true)
                        {
                            return None;
                        }
                        let additions = adds.checked_add(raw.get("additions")?.as_u64()?)?;
                        let deletions = dels.checked_add(raw.get("deletions")?.as_u64()?)?;
                        (additions <= 9_007_199_254_740_991 && deletions <= 9_007_199_254_740_991)
                            .then_some((additions, deletions))
                    });
                    turns[turn].snapshots.insert(snapshot);
                    turns[turn].changes.push(projected);
                }
            }
        }
    }
    Ok(turns
        .into_iter()
        .filter(|turn| !turn.changes.is_empty())
        .collect())
}

pub(crate) fn execute(
    db: &Database,
    method: &str,
    request: Request,
    workspace_root: Option<&Path>,
) -> Result<Value> {
    if method == "review.context" {
        return context::load(
            db.data_dir(),
            &request.session_id,
            request
                .snapshot_id
                .as_deref()
                .ok_or_else(|| anyhow!("snapshotId required"))?,
            request.context.ok_or_else(|| anyhow!("context required"))?,
        );
    }
    let turns = collect(db, &request.session_id, workspace_root)?;
    let limit = request.limit.unwrap_or(50).clamp(1, 100) as usize;
    if method == "review.turns" {
        let eligible: Vec<_> = turns
            .iter()
            .rev()
            .filter(|turn| {
                request
                    .before
                    .is_none_or(|before| (turn.position as i64) < before)
            })
            .collect();
        let page: Vec<_> = eligible
            .iter()
            .take(limit)
            .map(|turn| {
                json!({
                    "id": turn.id, "userMessageId": turn.id, "createdAt": turn.created_at,
                    "title": turn.title, "changeCount": turn.changes.len(),
                    "additions": turn.totals.map(|totals| totals.0),
                    "deletions": turn.totals.map(|totals| totals.1)
                })
            })
            .collect();
        let mut result = json!({ "turns": page });
        if eligible.len() > limit {
            result["nextBefore"] = json!(eligible[limit - 1].position);
        }
        return Ok(result);
    }
    let selected = turns.iter().rev().find(|turn| {
        request.turn_id.as_ref().is_none_or(|id| id == &turn.id)
            && request
                .snapshot_id
                .as_ref()
                .is_none_or(|id| turn.snapshots.contains(id))
    });
    let Some(turn) = selected else {
        return Ok(json!({ "turnId": null, "changes": [] }));
    };
    let offset = request.offset.unwrap_or(0) as usize;
    let changes: Vec<_> = turn.changes.iter().skip(offset).take(limit).collect();
    let mut result = json!({ "turnId": turn.id, "changes": changes });
    if offset.saturating_add(limit) < turn.changes.len() {
        result["nextOffset"] = json!(offset + limit);
    }
    Ok(result)
}

/// Select an entire file from the anchor's owning round using authoritative evidence.
pub(super) fn file_evidence(
    db: &Database,
    session_id: &str,
    snapshot: &str,
    workspace_root: Option<&Path>,
) -> Result<Vec<ReviewChange>> {
    for turn in collect(db, session_id, workspace_root)? {
        let reviews: Vec<ReviewChange> = turn
            .changes
            .iter()
            .map(|row| {
                serde_json::from_value(
                    row.pointer("/message/toolResult/details/review")
                        .cloned()
                        .unwrap_or(Value::Null),
                )
            })
            .collect::<std::result::Result<_, _>>()?;
        if let Some(anchor) = reviews.iter().find(|change| change.snapshot_id == snapshot) {
            let path = anchor.path.clone();
            let root = anchor.root.clone();
            return Ok(reviews
                .into_iter()
                .filter(|change| change.path == path && change.root == root)
                .collect());
        }
    }
    Err(anyhow!("review snapshot is not in the session transcript"))
}

/// Legacy delegate records have no trustworthy execution root. Keep the card
/// readable, but never restore those bytes into the parent session workspace.
pub(crate) fn rollback(
    db: &Database,
    session_id: &str,
    snapshot_id: &str,
    workspace_root: Option<&Path>,
) -> Result<RollbackOutcome> {
    let meta = read_meta(db.data_dir(), session_id, snapshot_id)?;
    if meta.root.is_none() {
        let records = transcripts::read_transcript(db.data_dir(), session_id)?;
        if records
            .iter()
            .filter(|record| parent(record).is_some())
            .any(|record| {
                tool_block(record).is_some_and(|block| {
                    reviews(block)
                        .iter()
                        .any(|review| field(review, "snapshotId") == Some(snapshot_id))
                })
            })
        {
            return Ok(RollbackOutcome {
                status: "unavailable",
                snapshot_id: snapshot_id.into(),
                message_id: meta.message_id,
                path: meta.path,
            });
        }
    }
    rollback_change(db.data_dir(), session_id, snapshot_id, workspace_root)
}
