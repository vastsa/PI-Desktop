//! Uninstall fault injection through real RPC, registry, SQLite and encrypted blobs.
use super::*;
use crate::secrets::{secret_ref_for_provider, secret_ref_for_provider_oauth};
use sha2::{Digest, Sha256};

async fn oauth_account(state: &Arc<Mutex<AppState>>) -> Value {
    let account = create(state, json!({})).await;
    call(state, "secrets.set", json!({"secretRef":secret_ref_for_provider_oauth(account["id"].as_str().unwrap()),"value":"synthetic-old-grant"})).await;
    call(
        state,
        "providers.completeTemplateOAuth",
        json!({"id":account["id"]}),
    )
    .await;
    account["id"].clone()
}
fn oauth_manifest(plugin: &Path) {
    let mut definition = template();
    definition["authKind"] = json!("oauth");
    write_manifest(plugin, Some(definition));
}
fn block_api_key(data: &Path, id: &Value) -> std::path::PathBuf {
    let hash = hex::encode(Sha256::digest(
        secret_ref_for_provider(id.as_str().unwrap()).as_bytes(),
    ));
    let path = data.join("secrets").join(format!("{hash}.bin"));
    std::fs::create_dir(&path).unwrap();
    path
}
async fn uninstall_result(state: &Arc<Mutex<AppState>>) -> Result<Value, JsonRpcError> {
    let (tx, _rx) = mpsc::unbounded_channel();
    handle_request(
        state.clone(),
        "plugins.uninstall",
        json!({"id":"fixture.templates"}),
        tx,
    )
    .await
}
fn safe_failure(error: &JsonRpcError) {
    assert_eq!(error.code, 1000);
    assert_eq!(error.data.as_ref().unwrap()["errorCode"], "INTERNAL");
    assert!(
        error.message.contains("retry uninstall"),
        "{}",
        error.message
    );
    for forbidden in [".bin", "secret:", "synthetic", "secrets/", "secrets\\"] {
        assert!(
            !error.message.contains(forbidden),
            "unsafe error: {}",
            error.message
        );
    }
}
async fn unavailable(state: &Arc<Mutex<AppState>>, id: &Value) {
    assert_eq!(
        get(state, id).await["enabled"],
        false,
        "cleanup must fail closed"
    );
    fails(state, "providers.update", json!({"id":id,"enabled":true})).await;
    fails(state, "providers.completeTemplateOAuth", json!({"id":id})).await;
    assert_eq!(get(state, id).await["enabled"], false);
}

#[tokio::test]
async fn uninstall_cleanup_rpc_reports_failure_and_attempts_all_accounts() {
    let root = tempfile::tempdir().unwrap();
    let plugin = root.path().join("fixture");
    oauth_manifest(&plugin);
    let data = root.path().join("data");
    let state = state_at(&data);
    load(&state, &plugin).await;
    let mut ids = vec![
        oauth_account(&state).await,
        oauth_account(&state).await,
        oauth_account(&state).await,
    ];
    ids.sort_by(|a, b| a.as_str().cmp(&b.as_str()));
    let blocks = [block_api_key(&data, &ids[0]), block_api_key(&data, &ids[1])];
    let native = call(
        &state,
        "providers.create",
        json!({"name":"Official native","vendorKey":"openai","secretValue":"synthetic-native-key"}),
    )
    .await["provider"]
        .clone();
    let peer = root.path().join("peer");
    write_manifest(&peer, Some(template()));
    let manifest_path = peer.join("manifest.json");
    let mut manifest: Value =
        serde_json::from_str(&std::fs::read_to_string(&manifest_path).unwrap()).unwrap();
    manifest["id"] = json!("fixture.peer");
    std::fs::write(manifest_path, manifest.to_string()).unwrap();
    load(&state, &peer).await;
    let peer_account = call(&state, "providers.createFromTemplate", json!({"pluginId":"fixture.peer","templateId":"gateway","secretValue":"synthetic-peer-key"})).await["provider"].clone();
    {
        let st = state.lock().await;
        st.db.conn().execute("INSERT INTO sessions(id,title,mode,provider_id,created_at,updated_at) VALUES('cleanup-history','Keep','agent',?1,1,1)",[ids[0].as_str().unwrap()]).unwrap();
        // Observe every owned row already disabled before the first DELETE.
        st.db.conn().execute_batch("CREATE TRIGGER assert_cleanup_disabled BEFORE DELETE ON providers WHEN OLD.owner_plugin_id='fixture.templates' AND EXISTS(SELECT 1 FROM providers WHERE owner_plugin_id='fixture.templates' AND enabled<>0) BEGIN SELECT RAISE(ABORT,'owned account still enabled'); END;").unwrap();
    }
    safe_failure(
        &uninstall_result(&state)
            .await
            .expect_err("uninstall must not acknowledge failed erasure"),
    );
    for id in &ids[..2] {
        unavailable(&state, id).await;
        // A failed API-key channel must not prevent erasure of the OAuth channel.
        assert!(!state
            .lock()
            .await
            .secrets
            .has(&secret_ref_for_provider_oauth(id.as_str().unwrap())));
    }
    assert!(
        get(&state, &ids[2]).await.is_null(),
        "later accounts must still be cleaned"
    );
    assert!(get(&state, &json!("plugin:fixture.templates:legacy"))
        .await
        .is_null());
    for (account, key) in [
        (&native, "synthetic-native-key"),
        (&peer_account, "synthetic-peer-key"),
    ] {
        assert_eq!(get(&state, &account["id"]).await["enabled"], true);
        assert_eq!(
            call(&state, "providers.getSecret", json!({"id":account["id"]})).await["value"],
            key
        );
    }
    drop(state);
    let state = state_at(&data);
    for id in &ids[..2] {
        unavailable(&state, id).await;
    }
    for account in [&native, &peer_account] {
        assert_eq!(
            get(&state, &account["id"]).await["enabled"],
            true,
            "a cleanup fault must not stop peer reconciliation"
        );
    }
    for block in blocks {
        std::fs::remove_dir(block).unwrap();
    }
    assert_eq!(
        uninstall_result(&state).await.unwrap()["ok"],
        true,
        "repeat uninstall retries even without a registry row"
    );
    for id in &ids {
        assert!(get(&state, id).await.is_null());
    }
    assert_eq!(
        state
            .lock()
            .await
            .db
            .conn()
            .query_row(
                "SELECT count(*) FROM sessions WHERE id='cleanup-history'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
}

#[tokio::test]
async fn uninstall_cleanup_same_id_reload_restart_and_recovery_never_reuse_grants() {
    let root = tempfile::tempdir().unwrap();
    let plugin = root.path().join("fixture");
    oauth_manifest(&plugin);
    let data = root.path().join("data");
    let state = state_at(&data);
    load(&state, &plugin).await;
    let id = oauth_account(&state).await;
    let block = block_api_key(&data, &id);
    let _ = uninstall_result(&state).await;
    unavailable(&state, &id).await;
    // A late login/refresh result cannot turn an uninstall tombstone into a login.
    call(&state, "secrets.set", json!({"secretRef":secret_ref_for_provider_oauth(id.as_str().unwrap()),"value":"synthetic-late-grant"})).await;
    load(&state, &plugin).await;
    call(&state, "secrets.set", json!({"secretRef":secret_ref_for_provider_oauth(id.as_str().unwrap()),"value":"synthetic-late-grant"})).await;
    unavailable(&state, &id).await;
    call(&state, "plugins.enable", json!({"id":"fixture.templates"})).await;
    unavailable(&state, &id).await;
    drop(state);
    let state = state_at(&data);
    unavailable(&state, &id).await;
    safe_failure(&uninstall_result(&state).await.unwrap_err());
    drop(state);
    // Still absent from the registry: startup must retry the durable intent.
    let state = state_at(&data);
    unavailable(&state, &id).await;
    std::fs::remove_dir(block).unwrap();
    // Same-ID registration must finish cleanup before reconciling declarations.
    load(&state, &plugin).await;
    assert!(get(&state, &id).await.is_null());
    assert!(!state
        .lock()
        .await
        .secrets
        .has(&secret_ref_for_provider_oauth(id.as_str().unwrap())));
    fails(&state, "providers.completeTemplateOAuth", json!({"id":id})).await;
    let fresh = create(&state, json!({})).await;
    assert_ne!(fresh["id"], id);
    assert_eq!(fresh["enabled"], false);
    assert_eq!(fresh["hasOauth"], false);
    fails(
        &state,
        "providers.completeTemplateOAuth",
        json!({"id":fresh["id"]}),
    )
    .await;
    call(&state, "providers.delete", json!({"id":fresh["id"]})).await;
    let id = oauth_account(&state).await;
    let block = block_api_key(&data, &id);
    let _ = uninstall_result(&state).await;
    drop(state);
    std::fs::remove_dir(block).unwrap();
    let state = state_at(&data);
    assert!(
        get(&state, &id).await.is_null(),
        "startup retries after recovery"
    );
    assert!(!state
        .lock()
        .await
        .secrets
        .has(&secret_ref_for_provider_oauth(id.as_str().unwrap())));
}

#[tokio::test]
async fn uninstall_cleanup_registry_failure_also_leaves_durable_unavailable_intent() {
    let root = tempfile::tempdir().unwrap();
    let plugin = root.path().join("fixture");
    oauth_manifest(&plugin);
    let data = root.path().join("data");
    let state = state_at(&data);
    load(&state, &plugin).await;
    let id = oauth_account(&state).await;
    let healthy = oauth_account(&state).await;
    let block = block_api_key(&data, &id);
    let registry = data.join("plugins/registry.json");
    let saved = std::fs::read(&registry).unwrap();
    std::fs::remove_file(&registry).unwrap();
    std::fs::create_dir(&registry).unwrap();
    let error = uninstall_result(&state).await.unwrap_err();
    unavailable(&state, &id).await;
    safe_failure(&error);
    assert!(
        get(&state, &healthy).await.is_null(),
        "registry failure must not skip credential cleanup"
    );
    std::fs::remove_dir(&registry).unwrap();
    std::fs::write(&registry, saved).unwrap();
    drop(state);
    let state = state_at(&data);
    unavailable(&state, &id).await;
    assert!(get(&state, &healthy).await.is_null());
    std::fs::remove_dir(block).unwrap();
    assert_eq!(uninstall_result(&state).await.unwrap()["ok"], true);
    assert!(get(&state, &id).await.is_null());
}

#[tokio::test]
async fn uninstall_cleanup_legacy_credentials_are_not_adopted_on_reinstall() {
    let root = tempfile::tempdir().unwrap();
    let plugin = root.path().join("fixture");
    write_manifest(&plugin, Some(template()));
    let data = root.path().join("data");
    let state = state_at(&data);
    load(&state, &plugin).await;
    let id = json!("plugin:fixture.templates:legacy");
    call(
        &state,
        "providers.setSecret",
        json!({"id":id,"secretValue":"synthetic-legacy-key"}),
    )
    .await;
    let block = data.join("secrets").join(format!(
        "{}.bin",
        hex::encode(Sha256::digest(
            secret_ref_for_provider_oauth(id.as_str().unwrap()).as_bytes()
        ))
    ));
    std::fs::create_dir(&block).unwrap();
    safe_failure(&uninstall_result(&state).await.unwrap_err());
    load(&state, &plugin).await;
    unavailable(&state, &id).await;
    {
        let st = state.lock().await;
        // Even the low-level enable path must leave tombstones off.
        crate::plugins::set_plugin_providers_enabled(&st.db, "fixture.templates", true).unwrap();
    }
    unavailable(&state, &id).await;
    drop(state);
    let state = state_at(&data);
    unavailable(&state, &id).await;
    std::fs::remove_dir(block).unwrap();
    load(&state, &plugin).await;
    // Legacy declarations retain their fixed identity, but this is a fresh row.
    assert_eq!(get(&state, &id).await["enabled"], true);
    assert_eq!(get(&state, &id).await["hasSecret"], false);
    assert!(call(&state, "providers.getSecret", json!({"id":id})).await["value"].is_null());
}

#[tokio::test]
async fn uninstall_cleanup_intent_commit_failure_aborts_before_registry_or_secrets() {
    let root = tempfile::tempdir().unwrap();
    let plugin = root.path().join("fixture");
    oauth_manifest(&plugin);
    let state = state_at(&root.path().join("data"));
    load(&state, &plugin).await;
    let id = oauth_account(&state).await;
    let other = oauth_account(&state).await;
    {
        let st = state.lock().await;
        st.db.conn().execute_batch("CREATE TRIGGER fail_cleanup_intent BEFORE UPDATE ON providers WHEN NEW.id='plugin:fixture.templates:legacy' BEGIN SELECT RAISE(ABORT,'synthetic private storage diagnostic'); END;").unwrap();
    }
    safe_failure(&uninstall_result(&state).await.unwrap_err());
    {
        let st = state.lock().await;
        assert!(
            st.plugins.get("fixture.templates").is_some(),
            "failed intent persistence must not unregister"
        );
        for id in [&id, &other] {
            let raw: String = st
                .db
                .conn()
                .query_row(
                    "SELECT config_json FROM providers WHERE id=?1",
                    [id.as_str().unwrap()],
                    |r| r.get(0),
                )
                .unwrap();
            assert!(
                serde_json::from_str::<Value>(&raw)
                    .unwrap()
                    .get("pluginCleanupPending")
                    .is_none(),
                "intent must be atomic"
            );
            assert!(st
                .secrets
                .has(&secret_ref_for_provider_oauth(id.as_str().unwrap())));
        }
        st.db
            .conn()
            .execute_batch("DROP TRIGGER fail_cleanup_intent;")
            .unwrap();
    }
    assert_eq!(uninstall_result(&state).await.unwrap()["ok"], true);
    for id in [&id, &other] {
        assert!(get(&state, id).await.is_null());
    }
}
