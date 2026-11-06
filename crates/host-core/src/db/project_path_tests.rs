use super::*;

#[test]
fn unicode_case_aliases_use_the_same_native_project_identity() {
    for (name, alias) in [("Älpha", "älpha"), ("Σ", "ς")] {
        let root = tempfile::tempdir().unwrap();
        let root = root.path().canonicalize().unwrap();
        let folder = root.join(name);
        let alias = root.join(alias);
        let db = Database::open(&root.join("pi.sqlite")).unwrap();
        let first = db.ensure_project(alias.to_str().unwrap(), false).unwrap();
        std::fs::create_dir(&folder).unwrap();
        if !alias.exists() {
            continue;
        }
        assert_eq!(
            db.ensure_project(folder.to_str().unwrap(), false).unwrap(),
            first
        );
        assert_eq!(db.list_projects().unwrap().len(), 1);
    }
}

#[test]
fn project_path_upgrade_preserves_every_owner_and_reuses_the_project() {
    let root = tempfile::tempdir().unwrap();
    let root = root.path().canonicalize().unwrap();
    let folder = root.join("Alpha");
    let alias = root.join("alpha").to_string_lossy().replace('\\', "/");
    std::fs::create_dir(&folder).unwrap();
    if !std::path::Path::new(&alias).exists() {
        return; // Distinct directories on a case-sensitive filesystem.
    }
    let canonical = canonical_project_path(folder.to_str().unwrap()).unwrap();
    let file = root.join("pi.sqlite");
    let (first, second);
    {
        let db = Database::open(&file).unwrap();
        first = db.ensure_project(&canonical, false).unwrap();
        db.conn().execute(
            "INSERT INTO projects(path,name,pinned,created_at,last_opened_at) VALUES(?1,'Keep this name',1,1,2)",
            params![alias],
        ).unwrap();
        second = db.conn().last_insert_rowid();
        for (id, project) in [("canonical", first), ("alias", second)] {
            db.conn()
                .execute(
                    "INSERT INTO sessions(id,project_id,created_at,updated_at) VALUES(?1,?2,1,1)",
                    params![id, project],
                )
                .unwrap();
            db.conn().execute("INSERT INTO scheduled_tasks(id,title,prompt,project_id,created_at,updated_at) VALUES(?1,'Task','Prompt',?2,1,1)", params![id, project]).unwrap();
        }
        db.kv_set("app", "currentProjectId", &serde_json::json!(second))
            .unwrap();
        db.conn().pragma_update(None, "user_version", 27).unwrap();
    }
    let db = Database::open(&file).unwrap();
    assert_eq!(db.list_projects().unwrap().len(), 1);
    let keep = db.ensure_project(&alias, false).unwrap();
    assert_eq!(db.ensure_project(&canonical, false).unwrap(), keep);
    let owners: Vec<i64> = db
        .conn()
        .prepare("SELECT project_id FROM sessions ORDER BY id")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(owners, vec![keep, keep]);
    let tasks: i64 = db
        .conn()
        .query_row(
            "SELECT count(*) FROM scheduled_tasks WHERE project_id=?1",
            params![keep],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(tasks, 2);
    assert!(db.get_project(keep).unwrap().unwrap().pinned);
    assert_eq!(
        db.kv_get("app", "currentProjectId").unwrap(),
        Some(serde_json::json!(keep))
    );
    assert!(migration_backup_path(&file, 27).exists());
}

#[test]
fn project_created_before_directory_exists_is_not_duplicated_when_it_appears() {
    let root = tempfile::tempdir().unwrap();
    let root = root.path().canonicalize().unwrap();
    let folder = root.join("Alpha");
    let alias = root.join("alpha");
    let db = Database::open(&root.join("pi.sqlite")).unwrap();
    let first = db.ensure_project(alias.to_str().unwrap(), false).unwrap();
    std::fs::create_dir(&folder).unwrap();
    if !alias.exists() {
        return;
    }
    let second = db.ensure_project(folder.to_str().unwrap(), false).unwrap();
    assert_eq!(first, second);
    assert_eq!(db.list_projects().unwrap().len(), 1);
}

#[test]
fn case_sensitive_project_identities_stay_distinct() {
    let root = tempfile::tempdir().unwrap();
    let upper = root.path().join("Alpha");
    let lower = root.path().join("alpha");
    std::fs::create_dir(&upper).unwrap();
    if lower.exists() {
        return;
    }
    std::fs::create_dir(&lower).unwrap();
    let db = Database::open(&root.path().join("pi.sqlite")).unwrap();
    assert_ne!(
        db.ensure_project(upper.to_str().unwrap(), false).unwrap(),
        db.ensure_project(lower.to_str().unwrap(), false).unwrap()
    );
    assert_eq!(db.list_projects().unwrap().len(), 2);
}

#[test]
fn opaque_remote_project_identities_are_not_case_folded() {
    let root = tempfile::tempdir().unwrap();
    let db = Database::open(&root.path().join("pi.sqlite")).unwrap();
    for path in ["remote-project:Alpha", "remote-project:alpha"] {
        db.conn()
            .execute(
                "INSERT INTO projects(path,name,created_at,last_opened_at) VALUES(?1,'Remote',1,1)",
                params![path],
            )
            .unwrap();
    }
    assert_eq!(db.list_projects().unwrap().len(), 2);
}

#[test]
fn historical_group_case_alias_keeps_its_context_and_remains_addressable() {
    let root = tempfile::tempdir().unwrap();
    let root = root.path().canonicalize().unwrap();
    let folder = root.join("Alpha");
    let alias = root.join("alpha");
    std::fs::create_dir(&folder).unwrap();
    if !alias.exists() {
        return;
    }
    let db = Database::open(&root.join("pi.sqlite")).unwrap();
    let mut group = db
        .create_project_group("Kept group", &[folder.to_string_lossy().into_owned()])
        .unwrap();
    group.primary_path = alias.to_string_lossy().replace('\\', "/");
    group.roots[0].path = group.primary_path.clone();
    db.kv_set(
        "projectGroups",
        &group.id,
        &serde_json::to_value(&group).unwrap(),
    )
    .unwrap();
    db.set_project_group_instructions(&group.id, "Preserve group instructions")
        .unwrap();
    let canonical = canonical_project_path(folder.to_str().unwrap()).unwrap();
    let restored = db
        .stored_project_group_for_path(&canonical)
        .unwrap()
        .unwrap();
    assert_eq!(restored.id, group.id);
    assert_eq!(restored.primary_path, canonical);
    assert_eq!(
        db.get_project_group_instructions(&group.id).unwrap(),
        "Preserve group instructions"
    );
}

#[cfg(unix)]
#[test]
fn deleting_a_stored_symlink_path_does_not_retarget_to_another_project() {
    let root = tempfile::tempdir().unwrap();
    let target = root.path().join("unrelated");
    let link = root.path().join("old-link");
    std::fs::create_dir(&target).unwrap();
    std::os::unix::fs::symlink(&target, &link).unwrap();
    let db = Database::open(&root.path().join("pi.sqlite")).unwrap();
    let unrelated = db.ensure_project(target.to_str().unwrap(), false).unwrap();
    db.conn()
        .execute(
            "INSERT INTO projects(path,name,created_at,last_opened_at) VALUES(?1,'Stored',1,1)",
            params![link.to_str()],
        )
        .unwrap();
    assert!(db.delete_project(link.to_str().unwrap()).unwrap());
    assert!(db.get_project(unrelated).unwrap().is_some());
}

#[test]
fn path_repair_is_atomic_and_can_run_inside_an_import_transaction() {
    let root = tempfile::tempdir().unwrap();
    let root = root.path().canonicalize().unwrap();
    let folder = root.join("Alpha");
    let alias = root.join("alpha");
    let db = Database::open(&root.join("pi.sqlite")).unwrap();
    let first = db.ensure_project(alias.to_str().unwrap(), false).unwrap();
    std::fs::create_dir(&folder).unwrap();
    if !alias.exists() {
        return;
    }
    let tx = db.conn().unchecked_transaction().unwrap();
    assert_eq!(
        db.ensure_project(folder.to_str().unwrap(), false).unwrap(),
        first
    );
    tx.rollback().unwrap();
    assert_eq!(
        db.project_path(first).unwrap().unwrap(),
        alias.to_string_lossy().replace('\\', "/")
    );
    let canonical = canonical_project_path(folder.to_str().unwrap()).unwrap();
    db.conn()
        .execute(
            "INSERT INTO projects(path,name,created_at,last_opened_at) VALUES(?1,'Duplicate',1,1)",
            params![canonical],
        )
        .unwrap();
    db.conn().execute_batch("CREATE TRIGGER reject_merge BEFORE DELETE ON projects BEGIN SELECT RAISE(ABORT,'blocked'); END;").unwrap();
    assert!(db.list_projects().is_err());
    let count: i64 = db
        .conn()
        .query_row("SELECT count(*) FROM projects", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 2);
    assert_eq!(
        db.project_path(first).unwrap().unwrap(),
        alias.to_string_lossy().replace('\\', "/")
    );
    db.conn()
        .execute_batch("DROP TRIGGER reject_merge")
        .unwrap();
    assert_eq!(db.list_projects().unwrap().len(), 1);
}
