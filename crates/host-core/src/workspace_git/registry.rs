//! The worktree registry: one `kv` record per `(installation, session)`.
//!
//! The fork does not change the SQLite schema (the next `user_version` belongs
//! to upstream), so durable state lives in the `kv` table under one namespace.
//! Records are keyed by the desktop's stable installation id rather than the
//! RACP device id, which is re-minted on every pairing and would orphan every
//! worktree on each host realignment.

use std::path::Path;

use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::layout::Repository;
use crate::db::Database;

pub const NAMESPACE: &str = "workspaceGitWorktrees";

/// One environment variable of a worktree. Plain configuration, stored
/// unencrypted; not for secrets.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Variable {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SetupStatus {
    None,
    Running,
    Ok,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeRecord {
    pub installation_id: String,
    pub session_id: String,
    pub repository: Repository,
    pub base_branch: String,
    pub work_branch: String,
    /// The worktree root.
    pub path: String,
    /// The repository's main checkout.
    pub main_path: String,
    /// The commit the worktree started at.
    pub base_commit: String,
    pub created_at: String,
    #[serde(default)]
    pub variables: Vec<Variable>,
    #[serde(default)]
    pub setup_script: Option<String>,
    pub setup_status: SetupStatus,
    #[serde(default)]
    pub setup_log_tail: Option<String>,
}

impl WorktreeRecord {
    /// The wire shape of `WorkspaceGitWorktree`. The installation id and the
    /// environment stay on the host: the first is the caller's own label, the
    /// second is configuration it already has.
    pub fn wire(&self) -> Value {
        let mut setup = json!({ "status": self.setup_status });
        if let Some(tail) = &self.setup_log_tail {
            setup["logTail"] = json!(tail);
        }
        json!({
            "sessionId": self.session_id,
            "repository": self.repository,
            "baseBranch": self.base_branch,
            "workBranch": self.work_branch,
            "path": self.path,
            "mainPath": self.main_path,
            "baseCommit": self.base_commit,
            "createdAt": self.created_at,
            "setup": setup,
        })
    }
}

/// Unambiguous because an installation id is a fixed-length UUID without `:`.
fn key(installation_id: &str, session_id: &str) -> String {
    format!("{installation_id}:{session_id}")
}

pub fn insert(db: &Database, record: &WorktreeRecord) -> Result<()> {
    db.kv_set(
        NAMESPACE,
        &key(&record.installation_id, &record.session_id),
        &serde_json::to_value(record)?,
    )
}

pub fn get(
    db: &Database,
    installation_id: &str,
    session_id: &str,
) -> Result<Option<WorktreeRecord>> {
    match db.kv_get(NAMESPACE, &key(installation_id, session_id))? {
        Some(value) => Ok(Some(serde_json::from_value(value)?)),
        None => Ok(None),
    }
}

pub fn remove(db: &Database, installation_id: &str, session_id: &str) -> Result<()> {
    db.kv_delete(NAMESPACE, &key(installation_id, session_id))
}

/// Every readable record, ordered by key. A value that no longer parses is
/// skipped rather than failing every other worktree on the host.
fn all(db: &Database) -> Result<Vec<WorktreeRecord>> {
    Ok(db
        .kv_entries(NAMESPACE)?
        .into_iter()
        .filter_map(
            |(key, value)| match serde_json::from_value::<WorktreeRecord>(value) {
                Ok(record) => Some(record),
                Err(error) => {
                    tracing::warn!(%key, %error, "skipping an unreadable workspace git record");
                    None
                }
            },
        )
        .collect())
}

/// One desktop's worktrees. Another installation's records are never returned,
/// so one desktop's reconcile cannot remove another's work.
pub fn list_for_installation(db: &Database, installation_id: &str) -> Result<Vec<WorktreeRecord>> {
    Ok(all(db)?
        .into_iter()
        .filter(|record| record.installation_id == installation_id)
        .collect())
}

/// The record whose worktree is `root` or contains it. The comparison is by
/// whole path components, so `…/abc` never matches `…/abcd`.
pub fn find_by_path(db: &Database, root: &Path) -> Result<Option<WorktreeRecord>> {
    if !root.is_absolute() {
        return Ok(None);
    }
    Ok(all(db)?
        .into_iter()
        .find(|record| root.starts_with(Path::new(&record.path))))
}

/// Record the setup script outcome. A record removed meanwhile stays removed.
pub fn set_setup(
    db: &Database,
    installation_id: &str,
    session_id: &str,
    status: SetupStatus,
    log_tail: Option<String>,
) -> Result<()> {
    let Some(mut record) = get(db, installation_id, session_id)? else {
        return Ok(());
    };
    record.setup_status = status;
    record.setup_log_tail = log_tail;
    insert(db, &record)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace_git::layout::Repository;

    const INSTALLATION_A: &str = "00000000-0000-4000-8000-000000000000";
    const INSTALLATION_B: &str = "11111111-1111-4111-8111-111111111111";

    fn database() -> (tempfile::TempDir, Database) {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
        (dir, db)
    }

    fn record(installation_id: &str, session_id: &str, path: &str) -> WorktreeRecord {
        WorktreeRecord {
            installation_id: installation_id.into(),
            session_id: session_id.into(),
            repository: Repository::parse("octo", "repo").unwrap(),
            base_branch: "main".into(),
            work_branch: "pi-desktop/8b54618f6bc1".into(),
            path: path.into(),
            main_path: "/w/repos/github.com/octo/repo".into(),
            base_commit: "a".repeat(40),
            created_at: "2026-11-20T00:00:00.000Z".into(),
            variables: vec![Variable {
                name: "MY_VAR".into(),
                value: "1".into(),
            }],
            setup_script: Some("true".into()),
            setup_status: SetupStatus::None,
            setup_log_tail: None,
        }
    }

    #[test]
    fn a_record_round_trips_in_camel_case() {
        let (_dir, db) = database();
        let stored = record(
            INSTALLATION_A,
            "s-1",
            "/w/worktrees/github.com/octo/repo/abc",
        );
        insert(&db, &stored).unwrap();
        assert_eq!(get(&db, INSTALLATION_A, "s-1").unwrap(), Some(stored));
        assert_eq!(get(&db, INSTALLATION_A, "s-2").unwrap(), None);
        assert_eq!(get(&db, INSTALLATION_B, "s-1").unwrap(), None);
        let raw = db
            .kv_get(NAMESPACE, &format!("{INSTALLATION_A}:s-1"))
            .unwrap()
            .unwrap();
        assert_eq!(raw["installationId"], INSTALLATION_A);
        assert_eq!(raw["sessionId"], "s-1");
        assert_eq!(raw["repository"]["owner"], "octo");
        assert_eq!(raw["baseBranch"], "main");
        assert_eq!(raw["workBranch"], "pi-desktop/8b54618f6bc1");
        assert_eq!(raw["mainPath"], "/w/repos/github.com/octo/repo");
        assert_eq!(raw["setupStatus"], "none");
        assert_eq!(raw["setupScript"], "true");
        assert_eq!(raw["variables"][0]["name"], "MY_VAR");
    }

    #[test]
    fn remove_and_set_setup_change_one_record() {
        let (_dir, db) = database();
        insert(&db, &record(INSTALLATION_A, "s-1", "/w/a")).unwrap();
        insert(&db, &record(INSTALLATION_A, "s-2", "/w/b")).unwrap();
        set_setup(
            &db,
            INSTALLATION_A,
            "s-1",
            SetupStatus::Failed,
            Some("boom".into()),
        )
        .unwrap();
        let first = get(&db, INSTALLATION_A, "s-1").unwrap().unwrap();
        assert_eq!(first.setup_status, SetupStatus::Failed);
        assert_eq!(first.setup_log_tail.as_deref(), Some("boom"));
        let second = get(&db, INSTALLATION_A, "s-2").unwrap().unwrap();
        assert_eq!(second.setup_status, SetupStatus::None);
        // A record that was removed meanwhile is not resurrected.
        remove(&db, INSTALLATION_A, "s-1").unwrap();
        set_setup(&db, INSTALLATION_A, "s-1", SetupStatus::Ok, None).unwrap();
        assert_eq!(get(&db, INSTALLATION_A, "s-1").unwrap(), None);
        assert!(get(&db, INSTALLATION_A, "s-2").unwrap().is_some());
        // Removing a missing record is not an error.
        remove(&db, INSTALLATION_A, "s-1").unwrap();
    }

    #[test]
    fn listing_is_scoped_to_one_installation() {
        let (_dir, db) = database();
        insert(&db, &record(INSTALLATION_A, "s-2", "/w/a2")).unwrap();
        insert(&db, &record(INSTALLATION_A, "s-1", "/w/a1")).unwrap();
        insert(&db, &record(INSTALLATION_B, "s-1", "/w/b1")).unwrap();
        // Another namespace and an unreadable value are both ignored.
        db.kv_set(
            "other",
            &format!("{INSTALLATION_A}:s-9"),
            &serde_json::json!({}),
        )
        .unwrap();
        db.kv_set(
            NAMESPACE,
            &format!("{INSTALLATION_A}:broken"),
            &serde_json::json!({ "installationId": INSTALLATION_A }),
        )
        .unwrap();
        let sessions = |installation: &str| -> Vec<String> {
            list_for_installation(&db, installation)
                .unwrap()
                .into_iter()
                .map(|record| record.session_id)
                .collect()
        };
        assert_eq!(sessions(INSTALLATION_A), ["s-1", "s-2"]);
        assert_eq!(sessions(INSTALLATION_B), ["s-1"]);
        assert!(sessions("22222222-2222-4222-8222-222222222222").is_empty());
    }

    #[test]
    fn find_by_path_matches_the_root_and_nested_directories_only() {
        let (_dir, db) = database();
        insert(&db, &record(INSTALLATION_A, "s-1", "/w/worktrees/abc")).unwrap();
        insert(&db, &record(INSTALLATION_B, "s-2", "/w/worktrees/abcd")).unwrap();
        let found = |path: &str| {
            find_by_path(&db, Path::new(path))
                .unwrap()
                .map(|record| record.session_id)
        };
        assert_eq!(found("/w/worktrees/abc").as_deref(), Some("s-1"));
        assert_eq!(found("/w/worktrees/abc/").as_deref(), Some("s-1"));
        assert_eq!(found("/w/worktrees/abc/src/deep").as_deref(), Some("s-1"));
        // A sibling that merely shares a name prefix is a different worktree.
        assert_eq!(found("/w/worktrees/abcd").as_deref(), Some("s-2"));
        assert_eq!(found("/w/worktrees/abcd/x").as_deref(), Some("s-2"));
        assert_eq!(found("/w/worktrees/abcde"), None);
        assert_eq!(found("/w/worktrees/ab"), None);
        // An ancestor of a worktree is not inside it.
        assert_eq!(found("/w/worktrees"), None);
        assert_eq!(found("/w/repos/github.com/octo/repo"), None);
        assert_eq!(found("w/worktrees/abc"), None);
    }
}
