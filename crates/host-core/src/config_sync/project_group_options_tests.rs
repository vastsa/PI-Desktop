use super::*;
use crate::db::ProjectGroupOptions;

fn options(value: Value) -> ProjectGroupOptions {
    ProjectGroupOptions::from_json(&value).unwrap()
}

fn folder(dir: &Path, name: &str) -> String {
    let path = dir.join(name);
    fs::create_dir_all(&path).unwrap();
    crate::db::canonical_project_path(&path.to_string_lossy()).unwrap()
}

fn config(paths: &[String]) -> StoredConfig {
    let (header, _) = create_vault("fixture-password", "fixture-vault").unwrap();
    let mut config = config_from_input(None, &json!({
        "endpoint": "https://s3.example.test", "region": "us-east-1", "bucket": "fixture-bucket",
        "accessKeyId": "fixture-access", "deviceLabel": "Fixture"
    }), header).unwrap();
    config
        .project_group_mappings
        .insert("logical-group".into(), paths.to_vec());
    config
}

fn bundle() -> PendingBundle {
    serde_json::from_value(json!({
        "manifest": {"format": REVISION_FORMAT, "version": 1, "revisionId": "fixture", "parents": [], "createdAt": "", "entities": [], "resourceIds": []},
        "approvals": [], "remoteRevisionId": "fixture"
    })).unwrap()
}

fn entity(settings: Value) -> PortableEntity {
    let mut payload =
        json!({"projectGroupLogicalId": "logical-group", "projectGroupName": "Imported"});
    payload
        .as_object_mut()
        .unwrap()
        .extend(settings.as_object().unwrap().clone());
    PortableEntity {
        domain: domains::DOMAIN_INSTRUCTIONS.into(),
        entity_id: "project-group:fixture".into(),
        label: "Fixture".into(),
        deleted: false,
        requires_approval: true,
        secret_bearing: false,
        mapping_required: true,
        digest: "fixture".into(),
        payload,
        resource_ids: vec![],
    }
}

fn snapshot(st: &AppState) -> Value {
    let mut statement = st
        .db
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
    json!({"projects": st.db.list_projects().unwrap(), "kv": rows})
}

#[test]
fn project_group_options_sync_capture_apply_reopen_and_reset() {
    let dir = tempfile::tempdir().unwrap();
    let source_root = folder(dir.path(), "source-root");
    let target_root = folder(dir.path(), "target-root");
    fs::write(Path::new(&target_root).join("AGENTS.md"), "Repository\r\n").unwrap();
    let mut source = AppState::open(&dir.path().join("source-profile")).unwrap();
    let group = source.db.create_project_group_with_options("Source", std::slice::from_ref(&source_root), &options(json!({
        "capabilities": {"skillIds": [], "mcpServerIds": ["Unavailable", "unavailable"]}, "instructions": "# App\r\n中文"
    }))).unwrap();
    let identities = domains::ProjectIdentityOverrides {
        group_ids: BTreeMap::from([(source_root, "logical-group".into())]),
        ..Default::default()
    };
    let captured = domains::capture_project_group_instructions(&mut source, &identities).unwrap();
    assert_eq!(captured.len(), 1);
    assert_eq!(
        captured[0].payload["capabilities"],
        json!({"skillIds": [], "mcpServerIds": ["Unavailable", "unavailable"]})
    );
    let mut target = AppState::open(&dir.path().join("target-profile")).unwrap();
    let mut cfg = config(std::slice::from_ref(&target_root));
    apply_entity(&mut target, &mut cfg, &bundle(), &captured[0]).unwrap();
    let imported = target
        .db
        .project_group_for_path(&target_root)
        .unwrap()
        .unwrap();
    assert_eq!(imported.capabilities, group.capabilities);
    drop(target);
    let mut target = AppState::open(&dir.path().join("target-profile")).unwrap();
    assert_eq!(
        target
            .db
            .get_project_group_instructions(&imported.id)
            .unwrap(),
        "# App\r\n中文"
    );
    // An older device's instructions-only payload leaves local selections alone.
    apply_entity(
        &mut target,
        &mut cfg,
        &bundle(),
        &entity(json!({"content": "Old client"})),
    )
    .unwrap();
    assert_eq!(
        target
            .db
            .project_group_for_path(&target_root)
            .unwrap()
            .unwrap()
            .capabilities,
        group.capabilities
    );
    source
        .db
        .rename_project_group_with_options(
            &group.id,
            "Reset",
            &options(json!({"capabilities": {}, "instructions": ""})),
        )
        .unwrap();
    let reset = domains::capture_project_group_instructions(&mut source, &identities).unwrap();
    assert_eq!(reset[0].payload["capabilities"], json!({}));
    assert_eq!(reset[0].payload["content"], "");
    apply_entity(&mut target, &mut cfg, &bundle(), &reset[0]).unwrap();
    let context = target
        .db
        .project_group_context_for_path(&target_root)
        .unwrap()
        .unwrap();
    assert_eq!(
        serde_json::to_value(context.capabilities).unwrap(),
        json!({})
    );
    assert_eq!(context.instructions, "");
    assert_eq!(
        fs::read_to_string(Path::new(&target_root).join("AGENTS.md")).unwrap(),
        "Repository\r\n"
    );
}

#[test]
fn project_group_options_sync_captures_capabilities_only_and_legacy_app_instructions() {
    let dir = tempfile::tempdir().unwrap();
    let root = folder(dir.path(), "selected");
    let legacy_root = folder(dir.path(), "legacy");
    let untouched_root = folder(dir.path(), "untouched");
    let mut st = AppState::open(&dir.path().join("profile")).unwrap();
    let group = st
        .db
        .create_project_group_with_options(
            "Selected",
            &[root],
            &options(json!({"capabilities": {"mcpServerIds": []}})),
        )
        .unwrap();
    st.db.ensure_project(&legacy_root, false).unwrap();
    st.db.ensure_project(&untouched_root, false).unwrap();
    let legacy = st.db.project_group_for_path(&legacy_root).unwrap().unwrap();
    st.db
        .set_project_group_instructions(&legacy.id, " \r\n")
        .unwrap();
    let captured =
        domains::capture_project_group_instructions(&mut st, &Default::default()).unwrap();
    assert_eq!(captured.len(), 2);
    let selected = captured
        .iter()
        .find(|entity| entity.entity_id == format!("project-group:{}", group.id))
        .unwrap();
    assert_eq!(
        selected.payload["capabilities"],
        json!({"mcpServerIds": []})
    );
    assert_eq!(selected.payload["content"], "");
    let app = captured
        .iter()
        .find(|entity| entity.entity_id == format!("project-group:{}", legacy.id))
        .unwrap();
    assert!(app.payload.get("capabilities").is_none());
    assert_eq!(app.payload["content"], " \r\n");
}

#[test]
fn project_group_options_sync_invalid_payload_and_storage_failure_are_atomic() {
    let dir = tempfile::tempdir().unwrap();
    let root = folder(dir.path(), "root");
    let mut st = AppState::open(&dir.path().join("profile")).unwrap();
    let mut cfg = config(std::slice::from_ref(&root));
    let before = snapshot(&st);
    for settings in [
        json!({"capabilities": null}),
        json!({"capabilities": {"mcpServerIds": null}}),
        json!({"capabilities": {"extra": []}}),
        json!({"content": null}),
        json!({"content": "é".repeat(16_385)}),
    ] {
        assert!(
            apply_entity(&mut st, &mut cfg, &bundle(), &entity(settings))
                .unwrap_err()
                .to_string()
                .starts_with("CONFIG_SYNC_INVALID:")
        );
        assert_eq!(snapshot(&st), before);
    }
    st.db.conn().execute_batch("CREATE TEMP TRIGGER reject_instructions BEFORE INSERT ON kv WHEN NEW.ns='projectGroupInstructions' BEGIN SELECT RAISE(ABORT, 'injected instruction failure'); END;").unwrap();
    let incoming = entity(json!({"capabilities": {"skillIds": []}, "content": "App owned"}));
    assert!(apply_entity(&mut st, &mut cfg, &bundle(), &incoming).is_err());
    assert_eq!(snapshot(&st), before);
    st.db.ensure_project(&root, false).unwrap();
    let legacy_before = snapshot(&st);
    assert!(apply_entity(&mut st, &mut cfg, &bundle(), &incoming).is_err());
    assert_eq!(snapshot(&st), legacy_before);
    st.db
        .conn()
        .execute_batch("DROP TRIGGER reject_instructions")
        .unwrap();
    apply_entity(&mut st, &mut cfg, &bundle(), &incoming).unwrap();
    assert!(!st.db.project_group_for_path(&root).unwrap().unwrap().legacy);
    let mut deleted = incoming;
    deleted.deleted = true;
    apply_entity(&mut st, &mut cfg, &bundle(), &deleted).unwrap();
    let context = st
        .db
        .project_group_context_for_path(&root)
        .unwrap()
        .unwrap();
    assert_eq!(context.instructions, "");
    assert_eq!(
        serde_json::to_value(context.capabilities).unwrap(),
        json!({})
    );
}
