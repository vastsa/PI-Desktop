use super::remote::{revision_path, serialize_json};
use super::tests::{
    configure_test_device, configure_test_device_mode, pending_approvals, run_in_isolated_process,
};
use super::*;
use crate::config_sync::transport::tests::fixture;

fn theme(state: &AppState) -> Result<Value> {
    Ok(state.db.get_setting("app")?.unwrap_or_else(|| json!({}))["theme"].clone())
}

fn app_settings(state: &AppState) -> Result<Value> {
    Ok(state.db.get_setting("app")?.unwrap_or_else(|| json!({})))
}

async fn approve_all(
    state: &Arc<Mutex<AppState>>,
    tx: &mpsc::UnboundedSender<String>,
) -> Result<()> {
    let value = get_state(state.clone()).await?;
    for (id, digest, _) in pending_approvals(&value) {
        approve(
            state.clone(),
            json!({"approvalId":id,"digest":digest}),
            tx.clone(),
        )
        .await?;
    }
    assert!(pending_approvals(&get_state(state.clone()).await?).is_empty());
    Ok(())
}

#[test]
fn unconfigured_device_uses_s3_defaults() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let mut state = AppState::open(directory.path())?;
    let public = public_state(&mut state)?;
    assert_eq!(public["configured"], false);
    assert_eq!(public["mode"], "sync");
    assert_eq!(public["pathStyle"], true);
    assert!(load_config(&state)?.is_none());
    Ok(())
}

#[tokio::test]
async fn backup_does_not_apply_remote_settings_and_restore_is_local_only() -> Result<()> {
    if run_in_isolated_process(
        "config_sync::engine::s3_tests::backup_does_not_apply_remote_settings_and_restore_is_local_only",
    )? {
        return Ok(());
    }
    let fixture = fixture(false).await;
    let directory_a = tempfile::tempdir()?;
    let directory_b = tempfile::tempdir()?;
    let device_a = configure_test_device(directory_a.path(), &fixture.endpoint).await?;
    let device_b =
        configure_test_device_mode(directory_b.path(), &fixture.endpoint, "backup").await?;
    device_a
        .lock()
        .await
        .db
        .set_setting("app", &json!({"theme":"light"}))?;
    device_b
        .lock()
        .await
        .db
        .set_setting("app", &json!({"theme":"dark"}))?;
    let (tx, _rx) = mpsc::unbounded_channel();
    let sync_revision = sync_now(device_a.clone(), tx.clone()).await?["lastRevisionId"].clone();
    let first_backup = sync_now(device_b.clone(), tx.clone()).await?["lastRevisionId"].clone();
    assert_eq!(theme(&*device_b.lock().await)?, "dark");
    assert_eq!(
        list_history(device_a.clone()).await?[0]["revisionId"],
        sync_revision
    );
    assert_eq!(
        list_history(device_b.clone()).await?[0]["revisionId"],
        first_backup
    );
    device_b
        .lock()
        .await
        .db
        .set_setting("app", &json!({"theme":"system"}))?;
    let second_backup = sync_now(device_b.clone(), tx.clone()).await?["lastRevisionId"].clone();
    assert_ne!(first_backup, second_backup);
    restore(
        device_b.clone(),
        json!({"revisionId": first_backup}),
        tx.clone(),
    )
    .await?;
    assert_eq!(theme(&*device_b.lock().await)?, "dark");
    assert_eq!(
        list_history(device_b.clone()).await?[0]["revisionId"],
        second_backup
    );
    assert_eq!(
        list_history(device_a.clone()).await?[0]["revisionId"],
        sync_revision
    );
    sync_now(device_a.clone(), tx).await?;
    assert_eq!(theme(&*device_a.lock().await)?, "light");
    assert!(!load_config(&*device_b.lock().await)?
        .unwrap()
        .recovery_points
        .is_empty());
    Ok(())
}

#[tokio::test]
async fn application_show_thinking_roundtrips_and_keeps_local_only_settings() -> Result<()> {
    if run_in_isolated_process(
        "config_sync::engine::s3_tests::application_show_thinking_roundtrips_and_keeps_local_only_settings",
    )? {
        return Ok(());
    }
    let fixture = fixture(false).await;
    let directory_a = tempfile::tempdir()?;
    let directory_b = tempfile::tempdir()?;
    let device_a = configure_test_device(directory_a.path(), &fixture.endpoint).await?;
    let device_b = configure_test_device(directory_b.path(), &fixture.endpoint).await?;
    // The source device carries the explicit reasoning-display boolean (a
    // false value must stay false), the legacy display mode, and a device-local
    // permission mode that must never travel through a revision.
    device_a.lock().await.db.set_setting(
        "app",
        &json!({
            "theme": "light",
            "showThinking": false,
            "thinkingDisplayMode": "detailed",
            "defaultPermissionMode": "accept-edits",
        }),
    )?;
    let (tx, _rx) = mpsc::unbounded_channel();
    sync_now(device_a.clone(), tx.clone()).await?;
    let received = sync_now(device_b.clone(), tx.clone()).await?;
    assert!(pending_approvals(&received).is_empty());
    {
        let state = device_b.lock().await;
        let settings = app_settings(&state)?;
        assert_eq!(settings["theme"], "light");
        // A false boolean survives capture and apply instead of reading as absent.
        assert_eq!(settings["showThinking"], false);
        // The legacy field is still exported so older readers keep working.
        assert_eq!(settings["thinkingDisplayMode"], "detailed");
        // Local-only settings do not travel: the source value never appears.
        assert!(settings.get("defaultPermissionMode").is_none());
    }
    // The receiving device now adopts its own local-only value.
    device_b.lock().await.db.set_setting(
        "app",
        &json!({
            "theme": "light",
            "showThinking": false,
            "thinkingDisplayMode": "detailed",
            "defaultPermissionMode": "ask",
        }),
    )?;
    // A later portable edit still syncs while the device-local value is untouched.
    device_a.lock().await.db.set_setting(
        "app",
        &json!({
            "theme": "light",
            "showThinking": true,
            "thinkingDisplayMode": "detailed",
            "defaultPermissionMode": "accept-edits",
        }),
    )?;
    sync_now(device_a.clone(), tx.clone()).await?;
    sync_now(device_b.clone(), tx).await?;
    let state = device_b.lock().await;
    let settings = app_settings(&state)?;
    assert_eq!(settings["showThinking"], true);
    assert_eq!(settings["thinkingDisplayMode"], "detailed");
    assert_eq!(settings["defaultPermissionMode"], "ask");
    Ok(())
}

#[tokio::test]
async fn sync_restore_requires_acknowledgement_and_propagates_as_a_new_revision() -> Result<()> {
    if run_in_isolated_process(
        "config_sync::engine::s3_tests::sync_restore_requires_acknowledgement_and_propagates_as_a_new_revision",
    )? {
        return Ok(());
    }
    let fixture = fixture(false).await;
    let directory_a = tempfile::tempdir()?;
    let directory_b = tempfile::tempdir()?;
    let device_a = configure_test_device(directory_a.path(), &fixture.endpoint).await?;
    let device_b = configure_test_device(directory_b.path(), &fixture.endpoint).await?;
    let (tx, _rx) = mpsc::unbounded_channel();
    device_a
        .lock()
        .await
        .db
        .set_setting("app", &json!({"theme":"light"}))?;
    let first = sync_now(device_a.clone(), tx.clone()).await?["lastRevisionId"].clone();
    sync_now(device_b.clone(), tx.clone()).await?;
    device_a
        .lock()
        .await
        .db
        .set_setting("app", &json!({"theme":"dark"}))?;
    sync_now(device_a.clone(), tx.clone()).await?;
    sync_now(device_b.clone(), tx.clone()).await?;
    assert_eq!(theme(&*device_b.lock().await)?, "dark");
    assert!(
        restore(device_a.clone(), json!({"revisionId":first}), tx.clone())
            .await
            .is_err()
    );
    assert_eq!(theme(&*device_a.lock().await)?, "dark");
    let restored = restore(
        device_a.clone(),
        json!({"revisionId":first,"acknowledgePropagation":true}),
        tx.clone(),
    )
    .await?;
    assert_ne!(restored["lastRevisionId"], first);
    assert_eq!(theme(&*device_a.lock().await)?, "light");
    sync_now(device_b.clone(), tx).await?;
    assert_eq!(theme(&*device_b.lock().await)?, "light");
    Ok(())
}

#[tokio::test]
async fn credentials_opt_out_survives_approval_and_remote_deletion_converges() -> Result<()> {
    if run_in_isolated_process(
        "config_sync::engine::s3_tests::credentials_opt_out_survives_approval_and_remote_deletion_converges",
    )? {
        return Ok(());
    }
    let fixture = fixture(false).await;
    let directory_a = tempfile::tempdir()?;
    let directory_b = tempfile::tempdir()?;
    let device_a = configure_test_device(directory_a.path(), &fixture.endpoint).await?;
    let device_b = configure_test_device(directory_b.path(), &fixture.endpoint).await?;
    configure(device_b.clone(), json!({"includeSecrets":false})).await?;
    let provider_id =
        {
            let state = device_a.lock().await;
            providers::create_provider(&state.db, &state.secrets, serde_json::from_value(json!({
            "name":"S3 regression", "type":"openai_compatible", "protocol":"openai_compatible",
            "baseUrl":"https://provider.example.test/v1", "authKind":"api_key_and_base_url",
            "secretValue":"source-only-key", "models":[]
        }))?)?.id
        };
    let (tx, _rx) = mpsc::unbounded_channel();
    sync_now(device_a.clone(), tx.clone()).await?;
    let received = sync_now(device_b.clone(), tx.clone()).await?;
    assert!(!pending_approvals(&received).is_empty());
    {
        let state = device_b.lock().await;
        assert!(providers::get_provider(&state.db, &state.secrets, &provider_id)?.is_none());
    }
    approve_all(&device_b, &tx).await?;
    {
        let state = device_b.lock().await;
        let imported = providers::get_provider(&state.db, &state.secrets, &provider_id)?.unwrap();
        assert!(!imported.has_secret);
        assert!(!imported.enabled);
    }
    // The publishing device acknowledges the receiver's secret-free metadata
    // before deletion, without losing its own device-local credential.
    sync_now(device_a.clone(), tx.clone()).await?;
    approve_all(&device_a, &tx).await?;
    {
        let state = device_a.lock().await;
        assert!(
            providers::get_provider(&state.db, &state.secrets, &provider_id)?
                .unwrap()
                .has_secret
        );
        providers::delete_provider(&state.db, &state.secrets, &provider_id)?;
    }
    sync_now(device_a.clone(), tx.clone()).await?;
    sync_now(device_b.clone(), tx.clone()).await?;
    approve_all(&device_b, &tx).await?;
    for _ in 0..2 {
        sync_now(device_b.clone(), tx.clone()).await?;
        sync_now(device_a.clone(), tx.clone()).await?;
    }
    let state = device_b.lock().await;
    assert!(providers::get_provider(&state.db, &state.secrets, &provider_id)?.is_none());
    Ok(())
}

#[tokio::test]
async fn resource_updates_and_packaged_skill_deletion_reach_the_other_device() -> Result<()> {
    if run_in_isolated_process(
        "config_sync::engine::s3_tests::resource_updates_and_packaged_skill_deletion_reach_the_other_device",
    )? {
        return Ok(());
    }
    let fixture = fixture(false).await;
    let directory_a = tempfile::tempdir()?;
    let directory_b = tempfile::tempdir()?;
    let device_a = configure_test_device(directory_a.path(), &fixture.endpoint).await?;
    let device_b = configure_test_device(directory_b.path(), &fixture.endpoint).await?;
    let project_a = directory_a.path().join("project");
    let project_b = directory_b.path().join("project");
    fs::create_dir_all(&project_a)?;
    fs::create_dir_all(&project_b)?;
    let project_a = project_a.canonicalize()?.to_string_lossy().into_owned();
    let project_b = project_b.canonicalize()?.to_string_lossy().into_owned();
    // Project registration is device-local; scoped capability capture requires
    // the receiving device to have registered its own mapped project.
    device_b.lock().await.db.ensure_project(&project_b, false)?;
    {
        let mut state = device_a.lock().await;
        state.db.ensure_project(&project_a, false)?;
        state
            .user_skills
            .create(crate::user_skills::UserSkillInput {
                id: Some("changing-skill".into()),
                name: Some("Changing skill".into()),
                level: Some("project".into()),
                project_path: Some(project_a.clone()),
                body: Some("Fixture instructions".into()),
                shape: Some("dir".into()),
                ..Default::default()
            })?;
        state.user_skills.write_package_files(
            "changing-skill",
            CapabilityLevel::Project,
            Some(&project_a),
            &[("data.txt".into(), b"first".to_vec())],
        )?;
    }
    let (tx, _rx) = mpsc::unbounded_channel();
    sync_now(device_a.clone(), tx.clone()).await?;
    let received = sync_now(device_b.clone(), tx.clone()).await?;
    let mapping = received["pendingApprovals"]
        .as_array()
        .unwrap()
        .iter()
        .find_map(|item| item["mappingKey"].as_str())
        .unwrap();
    map_project(
        device_b.clone(),
        json!({"logicalId":mapping,"paths":[project_b]}),
    )
    .await?;
    approve_all(&device_b, &tx).await?;
    {
        let mut state = device_a.lock().await;
        let skill = state
            .user_skills
            .list(CapabilityLevel::Project, Some(&project_a))?
            .remove(0);
        fs::write(
            Path::new(&skill.path).parent().unwrap().join("data.txt"),
            b"updated",
        )?;
    }
    sync_now(device_a.clone(), tx.clone()).await?;
    sync_now(device_b.clone(), tx.clone()).await?;
    approve_all(&device_b, &tx).await?;
    {
        let mut state = device_b.lock().await;
        assert_eq!(
            state.user_skills.package_files(
                "changing-skill",
                CapabilityLevel::Project,
                Some(&project_b)
            )?,
            vec![("data.txt".into(), b"updated".to_vec())]
        );
    }
    device_a.lock().await.user_skills.remove(
        "changing-skill",
        Some(CapabilityLevel::Project),
        Some(&project_a),
    )?;
    sync_now(device_a.clone(), tx.clone()).await?;
    sync_now(device_b.clone(), tx.clone()).await?;
    approve_all(&device_b, &tx).await?;
    assert!(device_b
        .lock()
        .await
        .user_skills
        .list(CapabilityLevel::Project, Some(&project_b))?
        .is_empty());
    sync_now(device_b.clone(), tx).await?;
    Ok(())
}

#[tokio::test]
async fn chosen_conflict_is_published_without_reopening_old_candidates() -> Result<()> {
    if run_in_isolated_process(
        "config_sync::engine::s3_tests::chosen_conflict_is_published_without_reopening_old_candidates",
    )? {
        return Ok(());
    }
    let fixture = fixture(false).await;
    let directory_a = tempfile::tempdir()?;
    let directory_b = tempfile::tempdir()?;
    let a = configure_test_device(directory_a.path(), &fixture.endpoint).await?;
    let b = configure_test_device(directory_b.path(), &fixture.endpoint).await?;
    let (tx, _rx) = mpsc::unbounded_channel();
    a.lock()
        .await
        .db
        .set_setting("app", &json!({"theme":"dark"}))?;
    sync_now(a.clone(), tx.clone()).await?;
    sync_now(b.clone(), tx.clone()).await?;
    a.lock()
        .await
        .db
        .set_setting("app", &json!({"theme":"light"}))?;
    b.lock()
        .await
        .db
        .set_setting("app", &json!({"theme":"system"}))?;
    sync_now(a.clone(), tx.clone()).await?;
    let conflict = sync_now(b.clone(), tx.clone()).await?;
    let item = conflict["pendingApprovals"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["entityId"].as_str().unwrap().ends_with(":local"))
        .unwrap();
    approve(
        b.clone(),
        json!({"approvalId":item["id"],"digest":item["digest"]}),
        tx.clone(),
    )
    .await?;
    assert_eq!(theme(&*b.lock().await)?, "system");
    assert!(pending_approvals(&sync_now(b.clone(), tx.clone()).await?).is_empty());
    let received = sync_now(a.clone(), tx.clone()).await?;
    assert!(pending_approvals(&received).is_empty());
    assert_eq!(theme(&*a.lock().await)?, "system");
    for _ in 0..2 {
        assert!(pending_approvals(&sync_now(b.clone(), tx.clone()).await?).is_empty());
        assert!(pending_approvals(&sync_now(a.clone(), tx.clone()).await?).is_empty());
    }
    Ok(())
}

fn legacy_project(entity_id: &str, payload: Value, deleted: bool) -> PortableEntity {
    PortableEntity {
        domain: "projects".into(),
        entity_id: entity_id.into(),
        label: "Legacy project".into(),
        deleted,
        requires_approval: true,
        secret_bearing: false,
        mapping_required: true,
        digest: format!("legacy-{entity_id}-{deleted}"),
        payload,
        resource_ids: Vec::new(),
    }
}

#[tokio::test]
async fn legacy_project_revision_sync_and_restore_preserve_local_projects() -> Result<()> {
    if run_in_isolated_process(
        "config_sync::engine::s3_tests::legacy_project_revision_sync_and_restore_preserve_local_projects",
    )? {
        return Ok(());
    }
    let fixture = fixture(false).await;
    let directory_a = tempfile::tempdir()?;
    let directory_b = tempfile::tempdir()?;
    let device_a = configure_test_device(directory_a.path(), &fixture.endpoint).await?;
    let device_b = configure_test_device(directory_b.path(), &fixture.endpoint).await?;
    let project_path = directory_b.path().join("existing-project");
    fs::create_dir_all(&project_path)?;
    let project_path = project_path.canonicalize()?.to_string_lossy().into_owned();
    let (projects_before, groups_before) = {
        let state = device_b.lock().await;
        state.db.ensure_project(&project_path, false)?;
        state
            .db
            .create_project_group("Local group", std::slice::from_ref(&project_path))?;
        let mut config = load_config(&state)?.expect("configured device");
        config
            .project_mappings
            .insert("existing".into(), project_path.clone());
        config
            .project_mappings
            .insert("removed".into(), project_path.clone());
        config.project_group_mappings.insert(
            "project-group:existing-group".into(),
            vec![project_path.clone()],
        );
        save_config(&state, &config)?;
        (
            serde_json::to_value(state.db.list_projects()?)?,
            serde_json::to_value(state.db.list_project_groups()?)?,
        )
    };
    let legacy_revision = {
        let mut state = device_a.lock().await;
        state.db.set_setting("app", &json!({"theme":"light"}))?;
        let config = load_config(&state)?.expect("configured device");
        let key = local_vault_key(&state, &config)?.expect("unlocked device");
        let transport = configured_transport(&state, &config)?;
        let mut snapshot = domains::capture(
            &mut state,
            &key,
            &selection(&config),
            config.include_secrets,
            &config.plugin_intents,
            &identity_overrides(&config),
        )?;
        snapshot.manifest.entities.extend([
            legacy_project("project:existing", json!({"logicalId":"existing","name":"Remote name","pinned":true}), false),
            legacy_project("project:removed", json!({"logicalId":"removed"}), true),
            legacy_project("project:new", json!({"logicalId":"new","name":"New remote project"}), false),
            legacy_project("project-group:existing-group", json!({"logicalId":"project-group:existing-group","name":"Remote group","roots":[{"name":"Remote root","position":0}]}), false),
        ]);
        // Write authenticated historical bytes directly: the current exporter
        // must never produce the retired domain, even for compatibility tests.
        let revision_id = snapshot.manifest.revision_id.clone();
        let encrypted = encrypt_object(
            &key,
            &format!("manifest/{revision_id}"),
            &config.vault_id,
            &serialize_json(&snapshot.manifest)?,
        )?;
        assert!(
            transport
                .put_if_none(&revision_path(&config, &revision_id)?, encrypted)
                .await?
        );
        assert!(
            publish_head(
                &transport,
                &config,
                &key,
                &next_head(&revision_id, None),
                None
            )
            .await?
        );
        revision_id
    };
    let (tx, _rx) = mpsc::unbounded_channel();
    let received = sync_now(device_b.clone(), tx.clone()).await?;
    assert!(pending_approvals(&received).is_empty());
    assert_eq!(theme(&*device_b.lock().await)?, "light");
    assert!(list_history(device_b.clone()).await?.as_array().is_some());
    {
        let state = device_b.lock().await;
        assert_eq!(
            serde_json::to_value(state.db.list_projects()?)?,
            projects_before
        );
        assert_eq!(
            serde_json::to_value(state.db.list_project_groups()?)?,
            groups_before
        );
        state.db.set_setting("app", &json!({"theme":"dark"}))?;
    }
    sync_now(device_b.clone(), tx.clone()).await?;
    let restored = restore(
        device_b.clone(),
        json!({"revisionId":legacy_revision,"acknowledgePropagation":true}),
        tx,
    )
    .await?;
    assert!(pending_approvals(&restored).is_empty());
    let state = device_b.lock().await;
    assert_eq!(theme(&state)?, "light");
    assert_eq!(
        serde_json::to_value(state.db.list_projects()?)?,
        projects_before
    );
    assert_eq!(
        serde_json::to_value(state.db.list_project_groups()?)?,
        groups_before
    );
    Ok(())
}

#[tokio::test]
async fn legacy_project_config_and_pending_approval_do_not_block_sync() -> Result<()> {
    if run_in_isolated_process(
        "config_sync::engine::s3_tests::legacy_project_config_and_pending_approval_do_not_block_sync",
    )? {
        return Ok(());
    }
    let fixture = fixture(false).await;
    let directory = tempfile::tempdir()?;
    let device = configure_test_device(directory.path(), &fixture.endpoint).await?;
    {
        let mut state = device.lock().await;
        let config = load_config(&state)?.expect("configured device");
        let key = local_vault_key(&state, &config)?.expect("unlocked device");
        let mut raw_config = serde_json::to_value(&config)?;
        raw_config["categories"]["projects"] = json!(true);
        state.db.kv_set(CONFIG_NS, CONFIG_KEY, &raw_config)?;
        assert!(!load_config(&state)?
            .expect("configured device")
            .categories
            .contains_key("projects"));
        let snapshot = domains::capture(
            &mut state,
            &key,
            &selection(&config),
            config.include_secrets,
            &config.plugin_intents,
            &identity_overrides(&config),
        )?;
        let entity = legacy_project("project:obsolete", json!({"logicalId":"obsolete"}), false);
        let mut manifest = snapshot.manifest;
        manifest.entities.push(entity.clone());
        store_pending(
            &state,
            &key,
            &PendingBundle {
                remote_revision_id: manifest.revision_id.clone(),
                local_before: Some(manifest.clone()),
                manifest,
                resources: BTreeMap::new(),
                approvals: vec![PendingApproval {
                    approval_id: "legacy-approval".into(),
                    entity,
                    reason: "mapping".into(),
                    approved: false,
                }],
                conflicts: Vec::new(),
                journal_state: "staged".into(),
            },
        )?;
        let pending = load_pending(&state, &key)?.expect("pending journal");
        assert!(pending.approvals.is_empty());
        assert!(pending
            .manifest
            .entities
            .iter()
            .all(|entity| entity.domain != "projects"));
        assert!(pending
            .local_before
            .as_ref()
            .expect("local snapshot")
            .entities
            .iter()
            .all(|entity| entity.domain != "projects"));
    }
    let (tx, _rx) = mpsc::unbounded_channel();
    assert!(pending_approvals(&get_state(device.clone()).await?).is_empty());
    let synced = sync_now(device.clone(), tx).await?;
    assert!(pending_approvals(&synced).is_empty());
    assert!(synced["lastRevisionId"].as_str().is_some());
    assert!(device.lock().await.db.list_projects()?.is_empty());
    Ok(())
}
