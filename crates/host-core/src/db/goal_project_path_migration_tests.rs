use super::*;

fn version(conn: &Connection) -> i64 {
    conn.query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap()
}

fn main_v28(path: &Path) -> Connection {
    let conn = Connection::open(path).unwrap();
    conn.execute_batch(SCHEMA_LATEST).unwrap();
    conn.execute_batch(PLAN_APPROVALS_SCHEMA).unwrap();
    conn.execute_batch(crate::session_collaboration::SCHEMA)
        .unwrap();
    conn.execute_batch(WORKTREE_DDL).unwrap();
    conn.execute("INSERT INTO projects(id,path,name,created_at,last_opened_at) VALUES(1,'/fixture','Original',1,2)", []).unwrap();
    conn.execute(
        "INSERT INTO sessions(id,project_id,created_at,updated_at) VALUES('kept',1,1,2)",
        [],
    )
    .unwrap();
    conn.pragma_update(None, "user_version", 28).unwrap();
    conn
}

#[test]
fn main_v28_without_goal_tables_upgrades_with_original_backup_and_owner() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pi.sqlite");
    drop(main_v28(&path));
    let db = Database::open(&path).unwrap();
    assert_eq!(version(db.conn()), SCHEMA_VERSION);
    assert_eq!(
        db.conn()
            .query_row(
                "SELECT project_id FROM sessions WHERE id='kept'",
                [],
                |row| row.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
    for (table, column) in [
        ("session_goals", "rounds_completed"),
        ("goal_turns", "settled"),
        ("turn_execution", "mode"),
    ] {
        assert!(
            db.conn()
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM pragma_table_info(?1) WHERE name=?2)",
                    params![table, column],
                    |row| row.get::<_, bool>(0)
                )
                .unwrap(),
            "{table}.{column}"
        );
    }
    let backup = Connection::open(migration_backup_path(&path, 28)).unwrap();
    assert_eq!(version(&backup), 28);
    assert!(!backup
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='session_goals')",
            [],
            |row| row.get::<_, bool>(0)
        )
        .unwrap());
    assert_eq!(
        backup
            .query_row("SELECT count(*) FROM sessions WHERE id='kept'", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap(),
        1
    );
}

#[test]
fn main_v28_backup_failure_leaves_schema_and_user_data_unchanged() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("pi.sqlite");
    drop(main_v28(&path));
    std::fs::create_dir(migration_backup_path(&path, 28)).unwrap();
    assert!(Database::open(&path).is_err());
    let conn = Connection::open(&path).unwrap();
    assert_eq!(version(&conn), 28);
    assert!(!conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='session_goals')",
            [],
            |row| row.get::<_, bool>(0)
        )
        .unwrap());
    assert_eq!(
        conn.query_row(
            "SELECT project_id FROM sessions WHERE id='kept'",
            [],
            |row| row.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
}

#[test]
fn goal_v33_reconciles_project_aliases_without_changing_goal_state_or_backup() {
    let dir = tempfile::tempdir().unwrap();
    let workspace = dir.path().join("Workspace");
    std::fs::create_dir(&workspace).unwrap();
    let canonical = canonical_project_path(workspace.to_str().unwrap()).unwrap();
    let alias = format!("{canonical}/");
    let path = dir.path().join("pi.sqlite");
    {
        let db = Database::open(&path).unwrap();
        let first = db.ensure_project(&canonical, false).unwrap();
        db.conn()
            .execute(
                "INSERT INTO projects(path,name,created_at,last_opened_at) VALUES(?1,'Alias',1,2)",
                params![alias],
            )
            .unwrap();
        let second = db.conn().last_insert_rowid();
        for (session, project) in [("canonical", first), ("alias", second)] {
            db.conn()
                .execute(
                    "INSERT INTO sessions(id,project_id,created_at,updated_at) VALUES(?1,?2,1,2)",
                    params![session, project],
                )
                .unwrap();
        }
        db.conn().execute("INSERT INTO session_goals(id,session_id,revision,status,objective,criteria_json,progress_summary,rounds_started,rounds_completed,token_usage,budget_json,outcomes_json) VALUES('goal','alias',7,'paused','Keep the objective','[\"Keep data\"]','Kept progress',3,2,45,'{\"maxTurns\":20}','[]')", []).unwrap();
        db.conn().pragma_update(None, "user_version", 33).unwrap();
    }
    let db = Database::open(&path).unwrap();
    assert_eq!(version(db.conn()), SCHEMA_VERSION);
    assert_eq!(
        db.conn()
            .query_row("SELECT count(*) FROM projects", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
    let owners: Vec<i64> = db
        .conn()
        .prepare("SELECT project_id FROM sessions ORDER BY id")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(owners.len(), 2);
    assert_eq!(owners[0], owners[1]);
    let state: (i64, String, String, i64, i64) = db.conn().query_row("SELECT revision,status,objective,rounds_completed,token_usage FROM session_goals WHERE id='goal'", [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?))).unwrap();
    assert_eq!(
        state,
        (7, "paused".into(), "Keep the objective".into(), 2, 45)
    );
    let backup_path = migration_backup_path(&path, 33);
    assert!(backup_path.is_file());
    let backup = Connection::open(&backup_path).unwrap();
    assert_eq!(version(&backup), 33);
    assert_eq!(
        backup
            .query_row("SELECT count(*) FROM projects", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        2
    );
    drop(backup);
    drop(db);
    let original = std::fs::read(&backup_path).unwrap();
    drop(Database::open(&path).unwrap());
    assert_eq!(std::fs::read(&backup_path).unwrap(), original);
}
