//! Rows of the `worktrees` table (schema v24, ADR 0329).

use anyhow::{anyhow, Result};
use rusqlite::{params, OptionalExtension, Row};
use serde::Serialize;

use crate::db::{now_ms, Database};

/// Each worktree owns `PORT_BLOCK` consecutive ports starting at its base.
pub const PORT_BLOCK: i64 = 10;
pub const PORT_RANGE_START: i64 = 41_000;
/// Base of the last block; the range ends at `PORT_RANGE_LAST_BASE + 9`.
pub const PORT_RANGE_LAST_BASE: i64 = 48_990;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorktreeStatus {
    Creating,
    Active,
    Conflict,
    Merged,
    Missing,
}

impl WorktreeStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            WorktreeStatus::Creating => "creating",
            WorktreeStatus::Active => "active",
            WorktreeStatus::Conflict => "conflict",
            WorktreeStatus::Merged => "merged",
            WorktreeStatus::Missing => "missing",
        }
    }

    pub(crate) fn parse(value: &str) -> Result<Self> {
        Ok(match value {
            "creating" => WorktreeStatus::Creating,
            "active" => WorktreeStatus::Active,
            "conflict" => WorktreeStatus::Conflict,
            "merged" => WorktreeStatus::Merged,
            "missing" => WorktreeStatus::Missing,
            other => return Err(anyhow!("unknown worktree status {other}")),
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SetupStatus {
    None,
    Running,
    Ok,
    Failed,
}

impl SetupStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            SetupStatus::None => "none",
            SetupStatus::Running => "running",
            SetupStatus::Ok => "ok",
            SetupStatus::Failed => "failed",
        }
    }

    pub(crate) fn parse(value: &str) -> Result<Self> {
        Ok(match value {
            "none" => SetupStatus::None,
            "running" => SetupStatus::Running,
            "ok" => SetupStatus::Ok,
            "failed" => SetupStatus::Failed,
            other => return Err(anyhow!("unknown worktree setup status {other}")),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeRow {
    pub id: String,
    /// `None` once the owning session was deleted (orphan awaiting cleanup).
    pub session_id: Option<String>,
    /// `None` for the session's own worktree.
    pub delegation_id: Option<String>,
    /// Worktree root (the directory `git worktree add` created).
    pub path: String,
    pub common_dir: String,
    /// Project directory relative to the repository top level.
    pub prefix: String,
    pub branch: String,
    pub owner_branch: String,
    pub status: WorktreeStatus,
    pub setup_status: Option<SetupStatus>,
    /// Bounded tail of the setup command output.
    pub setup_log: Option<String>,
    pub port_base: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

impl WorktreeRow {
    /// The tool root: the worktree plus the project's repository prefix, so an
    /// isolated session sees the same scope as a non-isolated one.
    pub fn workspace_root(&self) -> std::path::PathBuf {
        let root = std::path::Path::new(&self.path);
        if self.prefix.is_empty() {
            root.to_path_buf()
        } else {
            root.join(self.prefix.trim_end_matches('/'))
        }
    }
}

pub struct NewWorktree<'a> {
    pub session_id: &'a str,
    pub delegation_id: Option<&'a str>,
    pub path: &'a str,
    pub common_dir: &'a str,
    pub prefix: &'a str,
    pub branch: &'a str,
    pub owner_branch: &'a str,
    pub port_base: Option<i64>,
}

const COLUMNS: &str = "id, session_id, delegation_id, path, common_dir, prefix, branch,
                       owner_branch, status, setup_status, setup_log, port_base,
                       created_at, updated_at";

fn from_row(row: &Row<'_>) -> rusqlite::Result<(WorktreeRow, String, Option<String>)> {
    Ok((
        WorktreeRow {
            id: row.get(0)?,
            session_id: row.get(1)?,
            delegation_id: row.get(2)?,
            path: row.get(3)?,
            common_dir: row.get(4)?,
            prefix: row.get(5)?,
            branch: row.get(6)?,
            owner_branch: row.get(7)?,
            status: WorktreeStatus::Creating,
            setup_status: None,
            setup_log: row.get(10)?,
            port_base: row.get(11)?,
            created_at: row.get(12)?,
            updated_at: row.get(13)?,
        },
        row.get(8)?,
        row.get(9)?,
    ))
}

fn finish(raw: (WorktreeRow, String, Option<String>)) -> Result<WorktreeRow> {
    let (mut row, status, setup) = raw;
    row.status = WorktreeStatus::parse(&status)?;
    row.setup_status = setup.as_deref().map(SetupStatus::parse).transpose()?;
    Ok(row)
}

fn query_many(db: &Database, sql: &str, args: impl rusqlite::Params) -> Result<Vec<WorktreeRow>> {
    let mut statement = db.conn().prepare_cached(sql)?;
    let rows = statement
        .query_map(args, from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.into_iter().map(finish).collect()
}

/// Insert a row in `creating` state. The unique indexes reject a second
/// worktree for the same owner and a port block already held by another row.
pub fn insert(db: &Database, new: &NewWorktree<'_>) -> Result<WorktreeRow> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_ms();
    db.conn().execute(
        "INSERT INTO worktrees (id, session_id, delegation_id, path, common_dir, prefix,
                                branch, owner_branch, status, setup_status, port_base,
                                created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'creating', NULL, ?9, ?10, ?10)",
        params![
            id,
            new.session_id,
            new.delegation_id,
            new.path,
            new.common_dir,
            new.prefix,
            new.branch,
            new.owner_branch,
            new.port_base,
            now
        ],
    )?;
    get(db, &id)?.ok_or_else(|| anyhow!("inserted worktree {id} not found"))
}

pub fn get(db: &Database, id: &str) -> Result<Option<WorktreeRow>> {
    let raw = db
        .conn()
        .prepare_cached(&format!("SELECT {COLUMNS} FROM worktrees WHERE id = ?1"))?
        .query_row(params![id], from_row)
        .optional()?;
    raw.map(finish).transpose()
}

/// The worktree of a session (`delegation_id = None`) or of one delegation.
pub fn for_owner(
    db: &Database,
    session_id: &str,
    delegation_id: Option<&str>,
) -> Result<Option<WorktreeRow>> {
    let raw = db
        .conn()
        .prepare_cached(&format!(
            "SELECT {COLUMNS} FROM worktrees
             WHERE session_id = ?1 AND IFNULL(delegation_id, '') = IFNULL(?2, '')"
        ))?
        .query_row(params![session_id, delegation_id], from_row)
        .optional()?;
    raw.map(finish).transpose()
}

/// Every worktree of a session, its own first, then delegations by age.
pub fn for_session(db: &Database, session_id: &str) -> Result<Vec<WorktreeRow>> {
    query_many(
        db,
        &format!(
            "SELECT {COLUMNS} FROM worktrees WHERE session_id = ?1
             ORDER BY delegation_id IS NOT NULL, created_at"
        ),
        params![session_id],
    )
}

/// Rows whose session was deleted by any path; awaiting link-safe removal.
pub fn orphans(db: &Database) -> Result<Vec<WorktreeRow>> {
    query_many(
        db,
        &format!("SELECT {COLUMNS} FROM worktrees WHERE session_id IS NULL ORDER BY updated_at"),
        [],
    )
}

pub fn set_status(db: &Database, id: &str, status: WorktreeStatus) -> Result<bool> {
    Ok(db.conn().execute(
        "UPDATE worktrees SET status = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, status.as_str(), now_ms()],
    )? > 0)
}

/// Clear a `conflict` status back to `active`, only if it is still
/// `conflict`: a check that ran without the repo lock never overwrites a
/// status a concurrent merge or sync set meanwhile.
pub fn clear_conflict(db: &Database, id: &str) -> Result<bool> {
    Ok(db.conn().execute(
        "UPDATE worktrees SET status = 'active', updated_at = ?2
         WHERE id = ?1 AND status = 'conflict'",
        params![id, now_ms()],
    )? > 0)
}

pub fn set_setup_status(
    db: &Database,
    id: &str,
    status: SetupStatus,
    log: Option<&str>,
) -> Result<bool> {
    Ok(db.conn().execute(
        "UPDATE worktrees SET setup_status = ?2, setup_log = COALESCE(?3, setup_log),
                              updated_at = ?4
         WHERE id = ?1",
        params![id, status.as_str(), log, now_ms()],
    )? > 0)
}

/// Every row, for startup reconciliation.
pub fn all(db: &Database) -> Result<Vec<WorktreeRow>> {
    query_many(
        db,
        &format!("SELECT {COLUMNS} FROM worktrees ORDER BY created_at"),
        [],
    )
}

pub fn remove(db: &Database, id: &str) -> Result<bool> {
    Ok(db
        .conn()
        .execute("DELETE FROM worktrees WHERE id = ?1", params![id])?
        > 0)
}

/// Lowest port block not held by any row whose every port `is_free` accepts:
/// the agent may use any port of its block, so one busy port rules the block
/// out. The unique index on `port_base` still guards the insert against a
/// race.
pub fn next_port_base(db: &Database, is_free: impl Fn(u16) -> bool) -> Result<Option<i64>> {
    let used: std::collections::HashSet<i64> = db
        .conn()
        .prepare_cached("SELECT port_base FROM worktrees WHERE port_base IS NOT NULL")?
        .query_map([], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    let block_is_free =
        |base: i64| (base..base + PORT_BLOCK).all(|port| u16::try_from(port).is_ok_and(&is_free));
    let mut base = PORT_RANGE_START;
    while base <= PORT_RANGE_LAST_BASE {
        if !used.contains(&base) && block_is_free(base) {
            return Ok(Some(base));
        }
        base += PORT_BLOCK;
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db_with_session() -> (tempfile::TempDir, Database, String) {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
        let session = crate::sessions::create_session(&db, None, None, None, None, None).unwrap();
        (dir, db, session.id)
    }

    fn new<'a>(session: &'a str, delegation: Option<&'a str>, path: &'a str) -> NewWorktree<'a> {
        NewWorktree {
            session_id: session,
            delegation_id: delegation,
            path,
            common_dir: "/repo/.git",
            prefix: "",
            branch: "pi-desktop/x",
            owner_branch: "main",
            port_base: None,
        }
    }

    #[test]
    fn rows_round_trip_by_owner_and_status() {
        let (_dir, db, session) = db_with_session();
        let own = insert(&db, &new(&session, None, "/w/own")).unwrap();
        let delegate = insert(&db, &new(&session, Some("d1"), "/w/d1")).unwrap();
        assert_eq!(own.status, WorktreeStatus::Creating);
        assert_eq!(for_owner(&db, &session, None).unwrap().unwrap().id, own.id);
        assert_eq!(
            for_owner(&db, &session, Some("d1")).unwrap().unwrap().id,
            delegate.id
        );
        assert!(set_status(&db, &own.id, WorktreeStatus::Conflict).unwrap());
        assert!(set_setup_status(&db, &own.id, SetupStatus::Failed, Some("boom")).unwrap());
        let reloaded = get(&db, &own.id).unwrap().unwrap();
        assert_eq!(reloaded.status, WorktreeStatus::Conflict);
        assert_eq!(reloaded.setup_status, Some(SetupStatus::Failed));
        assert_eq!(reloaded.setup_log.as_deref(), Some("boom"));
        let listed: Vec<_> = for_session(&db, &session)
            .unwrap()
            .into_iter()
            .map(|row| row.id)
            .collect();
        assert_eq!(listed, vec![own.id.clone(), delegate.id]);
        assert!(remove(&db, &own.id).unwrap());
        assert!(get(&db, &own.id).unwrap().is_none());
    }

    #[test]
    fn deleted_sessions_leave_listed_orphans() {
        let (_dir, db, session) = db_with_session();
        let row = insert(&db, &new(&session, None, "/w/own")).unwrap();
        assert!(orphans(&db).unwrap().is_empty());
        crate::sessions::delete_session(&db, &session).unwrap();
        let orphaned = orphans(&db).unwrap();
        assert_eq!(orphaned.len(), 1);
        assert_eq!(orphaned[0].id, row.id);
        assert_eq!(orphaned[0].session_id, None);
    }

    /// The conflict check runs without the repo lock: clearing a conflict
    /// never overwrites a status a merge or sync set in the meantime.
    #[test]
    fn clearing_a_conflict_leaves_any_newer_status_alone() {
        let (_dir, db, session) = db_with_session();
        let row = insert(&db, &new(&session, None, "/w/own")).unwrap();
        set_status(&db, &row.id, WorktreeStatus::Conflict).unwrap();
        assert!(clear_conflict(&db, &row.id).unwrap());
        assert_eq!(
            get(&db, &row.id).unwrap().unwrap().status,
            WorktreeStatus::Active
        );

        set_status(&db, &row.id, WorktreeStatus::Merged).unwrap();
        assert!(!clear_conflict(&db, &row.id).unwrap());
        assert_eq!(
            get(&db, &row.id).unwrap().unwrap().status,
            WorktreeStatus::Merged
        );
    }

    #[test]
    fn port_blocks_skip_held_and_busy_bases() {
        let (_dir, db, session) = db_with_session();
        assert_eq!(
            next_port_base(&db, |_| true).unwrap(),
            Some(PORT_RANGE_START)
        );
        let mut held = new(&session, None, "/w/own");
        held.port_base = Some(PORT_RANGE_START);
        insert(&db, &held).unwrap();
        // The second block is held by another program right now.
        let busy = (PORT_RANGE_START + PORT_BLOCK) as u16;
        assert_eq!(
            next_port_base(&db, |port| port != busy).unwrap(),
            Some(PORT_RANGE_START + 2 * PORT_BLOCK)
        );
        assert_eq!(next_port_base(&db, |_| false).unwrap(), None);
    }

    /// A block whose base is free but whose fifth port another program
    /// holds is skipped: the agent may use any port of its block.
    #[test]
    fn a_busy_port_inside_a_block_skips_the_whole_block() {
        let (_dir, db, _session) = db_with_session();
        let busy = (PORT_RANGE_START + 5) as u16;
        assert_eq!(
            next_port_base(&db, |port| port != busy).unwrap(),
            Some(PORT_RANGE_START + PORT_BLOCK)
        );
        let last = (PORT_RANGE_START + PORT_BLOCK - 1) as u16;
        assert_eq!(
            next_port_base(&db, |port| port != last).unwrap(),
            Some(PORT_RANGE_START + PORT_BLOCK)
        );
    }
}
