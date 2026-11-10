use super::*;
use serde_json::json;

fn options(value: Value) -> ProjectGroupOptions {
    ProjectGroupOptions::from_json(&value).unwrap()
}

fn folder(dir: &Path, name: &str) -> String {
    let path = dir.join(name);
    std::fs::create_dir_all(&path).unwrap();
    path.to_string_lossy().into_owned()
}

fn snapshot(db: &Database) -> Value {
    let mut statement = db
        .conn()
        .prepare("SELECT ns,key,value_json FROM kv ORDER BY ns,key")
        .unwrap();
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    json!({"projects": db.list_projects().unwrap(), "kv": rows})
}

#[test]
fn project_group_options_validate_strict_json_and_utf8_bounds() {
    let invalid = [
        Value::Null,
        json!(false),
        json!("all"),
        json!([]),
        json!([[], []]),
        json!({"skills": []}),
        json!({"skillIds": null}),
        json!({"mcpServerIds": null}),
        json!({"skillIds": "skill"}),
        json!({"mcpServerIds": [1]}),
        json!({"skillIds": [""]}),
        json!({"skillIds": [" \u{2003}"]}),
        json!({"skillIds": ["a\nb"]}),
        json!({"mcpServerIds": ["a\u{0085}b"]}),
        json!({"skillIds": ["é".repeat(257)]}),
        json!({"mcpServerIds": vec!["same"; 513]}),
    ];
    for capabilities in invalid {
        assert!(
            ProjectGroupOptions::from_json(&json!({"capabilities": capabilities})).is_err(),
            "{capabilities}"
        );
    }
    for instructions in [Value::Null, json!(42), json!([]), json!("é".repeat(16_385))] {
        assert!(ProjectGroupOptions::from_json(&json!({"instructions": instructions})).is_err());
    }
    assert!(ProjectGroupOptions::from_json(&Value::Null).is_err());
    let accepted = options(
        json!({"capabilities": {"skillIds": ["Unknown", "unknown", "Unknown", " Unknown "]}, "instructions": "é".repeat(16_384)}),
    );
    assert_eq!(
        serde_json::to_value(accepted.capabilities).unwrap(),
        json!({"skillIds": ["Unknown", "unknown", " Unknown "]})
    );
    assert!(ProjectGroupOptions::from_json(
        &json!({"capabilities": {"mcpServerIds": vec!["é".repeat(256); 512]}})
    )
    .is_ok());
}

#[test]
fn project_group_options_roundtrip_reopen_preserve_omissions_and_reset() {
    let dir = tempfile::tempdir().unwrap();
    let root = folder(dir.path(), "root");
    let db = Database::open_in_dir(dir.path()).unwrap();
    let old = db
        .create_project_group("Old record", std::slice::from_ref(&root))
        .unwrap();
    assert!(db
        .kv_get("projectGroups", &old.id)
        .unwrap()
        .unwrap()
        .get("capabilities")
        .is_none());
    assert!(db
        .project_group_context_for_path(&root)
        .unwrap()
        .unwrap()
        .capabilities
        .is_none());
    let edited = db.update_project_group_with_options(&old.id, "Edited", std::slice::from_ref(&root), None, &options(json!({"capabilities": {"skillIds": [], "mcpServerIds": ["uninstalled", "uninstalled"]}, "instructions": "# App owned\n中文"}))).unwrap();
    assert_eq!(
        serde_json::to_value(&edited.capabilities).unwrap(),
        json!({"skillIds": [], "mcpServerIds": ["uninstalled"]})
    );
    db.rename_project_group(&old.id, "Renamed").unwrap();
    db.update_project_group(&old.id, "Renamed again", std::slice::from_ref(&root), None)
        .unwrap();
    drop(db);
    let db = Database::open_in_dir(dir.path()).unwrap();
    let context = db.project_group_context_for_path(&root).unwrap().unwrap();
    assert_eq!(context.capabilities, edited.capabilities);
    assert_eq!(context.instructions, "# App owned\n中文");
    assert_eq!(
        std::fs::read_dir(&root).unwrap().count(),
        0,
        "settings never create project files"
    );
    let cleared = db
        .rename_project_group_with_options(
            &old.id,
            "Reset",
            &options(json!({"capabilities": {}, "instructions": ""})),
        )
        .unwrap();
    assert_eq!(
        serde_json::to_value(cleared.capabilities).unwrap(),
        json!({})
    );
    assert_eq!(db.get_project_group_instructions(&old.id).unwrap(), "");
    assert!(db
        .kv_get("projectGroups", &old.id)
        .unwrap()
        .unwrap()
        .get("instructions")
        .is_none());
}

#[test]
fn project_group_options_local_remote_contexts_remain_isolated() {
    let dir = tempfile::tempdir().unwrap();
    let first = folder(dir.path(), "first");
    let second = folder(dir.path(), "second");
    let db = Database::open_in_dir(dir.path()).unwrap();
    let local = db
        .create_project_group_with_options(
            "Local",
            std::slice::from_ref(&first),
            &options(json!({"capabilities": {"skillIds": []}, "instructions": "local only"})),
        )
        .unwrap();
    let other = db
        .create_project_group("Other", std::slice::from_ref(&second))
        .unwrap();
    let remote = db
        .create_remote_project_group_with_options(
            "Remote",
            RemoteWorkspace {
                host_key: "server-a".into(),
                path: "/srv/unavailable".into(),
            },
            &options(json!({"capabilities": {"mcpServerIds": []}, "instructions": "remote only"})),
        )
        .unwrap();
    let renamed = db
        .rename_project_group_with_options(
            &remote.id,
            "Remote renamed",
            &options(json!({"capabilities": {"skillIds": ["A"]}})),
        )
        .unwrap();
    assert_eq!(renamed.remote, remote.remote);
    assert_eq!(renamed.primary_path, remote.primary_path);
    let context = db
        .project_group_context_for_path(&remote.primary_path)
        .unwrap()
        .unwrap();
    assert_eq!(context.instructions, "remote only");
    assert_eq!(
        serde_json::to_value(context.capabilities).unwrap(),
        json!({"skillIds": ["A"]})
    );
    assert_eq!(
        db.project_group_context_for_path(&first)
            .unwrap()
            .unwrap()
            .instructions,
        "local only"
    );
    let context = db.project_group_context_for_path(&second).unwrap().unwrap();
    assert_eq!(context.group_id, other.id);
    assert!(context.capabilities.is_none());
    assert!(context.instructions.is_empty());
    assert!(db
        .rename_project_group_with_options("absent", "Bad", &options(json!({"instructions": "no"})))
        .is_err());
    assert!(db.get_project_group_instructions("absent").is_err());
    assert!(db.set_project_group_instructions("absent", "no").is_err());
    db.delete_project_group_record(&local.id).unwrap();
    assert!(db
        .kv_get("projectGroupInstructions", &local.id)
        .unwrap()
        .is_none());
}

#[test]
fn project_group_options_legacy_instructions_promote_with_memory_and_never_change_agents() {
    let dir = tempfile::tempdir().unwrap();
    let first = folder(dir.path(), "first");
    let second = folder(dir.path(), "second");
    let agents = Path::new(&first).join("AGENTS.md");
    std::fs::write(&agents, "Repository instructions\r\n").unwrap();
    let db = Database::open_in_dir(dir.path()).unwrap();
    db.ensure_project(&first, false).unwrap();
    let legacy = db.project_group_for_path(&first).unwrap().unwrap();
    assert!(db.project_group_context_for_path(&first).unwrap().is_none());
    db.set_project_group_instructions(&legacy.id, "App instructions")
        .unwrap();
    db.set_project_memory(&first, "Retained memory").unwrap();
    assert_eq!(
        db.project_group_context_for_path(&first)
            .unwrap()
            .unwrap()
            .instructions,
        "App instructions"
    );
    let group = db
        .update_project_group_with_options(
            &legacy.id,
            "Promoted",
            std::slice::from_ref(&first),
            None,
            &options(json!({"capabilities": {"skillIds": []}})),
        )
        .unwrap();
    assert!(!group.legacy);
    assert_ne!(group.id, legacy.id);
    assert!(db
        .kv_get("projectGroupInstructions", &legacy.id)
        .unwrap()
        .is_none());
    assert_eq!(
        db.get_project_group_instructions(&group.id).unwrap(),
        "App instructions"
    );
    assert!(db
        .get_project_group_memory(&group.id)
        .unwrap()
        .content
        .contains("Retained memory"));
    let updated = db
        .update_project_group(
            &group.id,
            "Expanded",
            &[first.clone(), second.clone()],
            Some(&second),
        )
        .unwrap();
    assert_eq!(updated.id, group.id);
    assert_eq!(updated.capabilities, group.capabilities);
    assert_eq!(
        db.project_group_context_for_path(&second)
            .unwrap()
            .unwrap()
            .instructions,
        "App instructions"
    );
    assert_eq!(
        std::fs::read_to_string(&agents).unwrap(),
        "Repository instructions\r\n"
    );
    db.rename_project_group_with_options(
        &group.id,
        "Cleared",
        &options(json!({"instructions": ""})),
    )
    .unwrap();
    assert_eq!(
        std::fs::read_to_string(&agents).unwrap(),
        "Repository instructions\r\n"
    );
}

#[test]
fn project_group_options_promote_legacy_on_rename_and_existing_multi_root_update() {
    let dir = tempfile::tempdir().unwrap();
    let root = folder(dir.path(), "root");
    let extra = folder(dir.path(), "extra");
    let db = Database::open_in_dir(dir.path()).unwrap();
    db.ensure_project(&root, false).unwrap();
    let legacy = db.project_group_for_path(&root).unwrap().unwrap();
    let group = db
        .rename_project_group_with_options(
            &legacy.id,
            "Edited",
            &options(json!({"instructions": "owned", "capabilities": {}})),
        )
        .unwrap();
    assert!(!group.legacy);
    assert_eq!(
        db.get_project_group_instructions(&group.id).unwrap(),
        "owned"
    );
    db.ensure_project(&extra, false).unwrap();
    let legacy = db.project_group_for_path(&extra).unwrap().unwrap();
    db.set_project_group_instructions(&legacy.id, "transfer")
        .unwrap();
    let third = folder(dir.path(), "third");
    let promoted = db
        .update_project_group(&legacy.id, "Two roots", &[extra, third], None)
        .unwrap();
    assert_eq!(
        db.get_project_group_instructions(&promoted.id).unwrap(),
        "transfer"
    );
}

#[test]
fn project_group_options_reject_malformed_persisted_capabilities_without_inheritance() {
    let dir = tempfile::tempdir().unwrap();
    let root = folder(dir.path(), "root");
    let db = Database::open_in_dir(dir.path()).unwrap();
    let group = db
        .create_project_group("Project", std::slice::from_ref(&root))
        .unwrap();
    let mut value = serde_json::to_value(&group).unwrap();
    for invalid in [
        Value::Null,
        json!({"skillIds": null}),
        json!({"unexpected": []}),
        json!({"mcpServerIds": [false]}),
    ] {
        value["capabilities"] = invalid;
        db.kv_set("projectGroups", &group.id, &value).unwrap();
        assert!(db.list_project_groups().is_err());
        assert!(db.project_group_context_for_path(&root).is_err());
    }
}

#[test]
fn project_group_options_create_and_edit_roll_back_all_writes_on_storage_failure() {
    let dir = tempfile::tempdir().unwrap();
    let root = folder(dir.path(), "root");
    let extra = folder(dir.path(), "extra");
    let db = Database::open_in_dir(dir.path()).unwrap();
    let baseline = snapshot(&db);
    let settings = options(json!({"capabilities": {"skillIds": []}, "instructions": "fail"}));
    db.conn().execute_batch("CREATE TEMP TRIGGER reject_instructions BEFORE INSERT ON kv WHEN NEW.ns='projectGroupInstructions' BEGIN SELECT RAISE(ABORT, 'injected instruction failure'); END;").unwrap();
    assert!(db
        .create_project_group_with_options("Local", std::slice::from_ref(&root), &settings)
        .is_err());
    assert_eq!(snapshot(&db), baseline);
    assert!(db
        .create_remote_project_group_with_options(
            "Remote",
            RemoteWorkspace {
                host_key: "server".into(),
                path: "/srv/work".into()
            },
            &settings
        )
        .is_err());
    assert_eq!(snapshot(&db), baseline);
    let group = db
        .create_project_group("Existing", std::slice::from_ref(&root))
        .unwrap();
    let baseline = snapshot(&db);
    assert!(db
        .update_project_group_with_options(&group.id, "Changed", &[root, extra], None, &settings)
        .is_err());
    assert_eq!(snapshot(&db), baseline);
    assert!(db
        .rename_project_group_with_options(&group.id, "Changed", &settings)
        .is_err());
    assert_eq!(snapshot(&db), baseline);
    let remote = db
        .create_remote_project_group(
            "Remote",
            RemoteWorkspace {
                host_key: "server".into(),
                path: "/srv/work".into(),
            },
        )
        .unwrap();
    let baseline = snapshot(&db);
    assert!(db
        .rename_project_group_with_options(&remote.id, "Changed", &settings)
        .is_err());
    assert_eq!(snapshot(&db), baseline);
}

#[test]
fn project_group_options_validation_precedes_mutation_even_for_typed_callers() {
    let dir = tempfile::tempdir().unwrap();
    let root = folder(dir.path(), "root");
    let db = Database::open_in_dir(dir.path()).unwrap();
    let invalid = ProjectGroupOptions {
        capabilities: None,
        instructions: Some("é".repeat(16_385)),
    };
    let baseline = snapshot(&db);
    assert!(db
        .create_project_group_with_options("Local", std::slice::from_ref(&root), &invalid)
        .is_err());
    assert!(db
        .create_remote_project_group_with_options(
            "Remote",
            RemoteWorkspace {
                host_key: "server".into(),
                path: "/srv/work".into()
            },
            &invalid
        )
        .is_err());
    assert_eq!(snapshot(&db), baseline);
    let group = db
        .create_project_group("Existing", std::slice::from_ref(&root))
        .unwrap();
    let baseline = snapshot(&db);
    assert!(db
        .update_project_group_with_options(
            &group.id,
            "Changed",
            std::slice::from_ref(&root),
            None,
            &invalid
        )
        .is_err());
    assert!(db
        .rename_project_group_with_options(&group.id, "Changed", &invalid)
        .is_err());
    assert!(db
        .set_project_group_instructions(&group.id, &"é".repeat(16_385))
        .is_err());
    assert_eq!(snapshot(&db), baseline);
}

#[test]
fn project_group_options_root_move_preserves_group_identity_and_app_context() {
    let dir = tempfile::tempdir().unwrap();
    let original = folder(dir.path(), "original");
    let moved = dir.path().join("moved").to_string_lossy().into_owned();
    let db = Database::open_in_dir(dir.path()).unwrap();
    std::fs::write(Path::new(&original).join("AGENTS.md"), "Repository\r\n").unwrap();
    let group = db.create_project_group_with_options("Project", std::slice::from_ref(&original), &options(json!({
        "capabilities": {"skillIds": [], "mcpServerIds": ["unavailable"]}, "instructions": "App\r\n中文"
    }))).unwrap();
    std::fs::rename(&original, &moved).unwrap();
    let updated = db
        .update_project_group(
            &group.id,
            "Moved",
            std::slice::from_ref(&moved),
            Some(&moved),
        )
        .unwrap();
    assert_eq!(updated.id, group.id);
    assert_eq!(updated.capabilities, group.capabilities);
    let context = db.project_group_context_for_path(&moved).unwrap().unwrap();
    assert_eq!(context.group_id, group.id);
    assert_eq!(context.capabilities, group.capabilities);
    assert_eq!(context.instructions, "App\r\n中文");
    assert!(db
        .project_group_context_for_path(&original)
        .unwrap()
        .is_none());
    assert_eq!(
        std::fs::read_to_string(Path::new(&moved).join("AGENTS.md")).unwrap(),
        "Repository\r\n"
    );
}
