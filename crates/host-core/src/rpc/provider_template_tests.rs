//! User-path contract tests: real RPC dispatch, registry, database and encrypted
//! test secret store. No network, plugin execution or production credentials.
use super::*;
use std::path::Path;

fn template() -> Value {
    json!({"version":1,"id":"gateway","name":"Gateway","baseUrl":"https://api.example.test/v1","authKind":"api_key","models":[{"id":"large"},{"id":"small"}]})
}
fn write_manifest(root: &Path, definition: Option<Value>) {
    std::fs::create_dir_all(root).unwrap();
    std::fs::write(root.join("main.js"), "export function onLoad() {}").unwrap();
    let definitions: Vec<Value> = definition.into_iter().collect();
    std::fs::write(root.join("manifest.json"), json!({"schemaVersion":1,"id":"fixture.templates","name":"Templates","version":"1.0.0","main":"main.js","permissions":["provider.register","provider.oauth","provider.inference"],"contributes":{"providerTemplates":definitions,"providers":[{"id":"legacy","name":"Legacy","authKind":"none","models":[{"id":"old"}]}]}}).to_string()).unwrap();
}
fn state_at(root: &Path) -> Arc<Mutex<AppState>> {
    let mut state = AppState::open(root).unwrap();
    state.handshook = true;
    Arc::new(Mutex::new(state))
}
async fn call(state: &Arc<Mutex<AppState>>, method: &str, params: Value) -> Value {
    let (tx, _rx) = mpsc::unbounded_channel();
    handle_request(state.clone(), method, params, tx)
        .await
        .unwrap()
}
async fn fails(state: &Arc<Mutex<AppState>>, method: &str, params: Value) {
    let (tx, _rx) = mpsc::unbounded_channel();
    assert!(
        handle_request(state.clone(), method, params, tx)
            .await
            .is_err(),
        "accepted {method}"
    );
}
async fn load(state: &Arc<Mutex<AppState>>, path: &Path) {
    call(state, "plugins.loadDev", json!({"path":path})).await;
}
async fn create(state: &Arc<Mutex<AppState>>, extra: Value) -> Value {
    let mut input = json!({"pluginId":"fixture.templates","templateId":"gateway"});
    input
        .as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    call(state, "providers.createFromTemplate", input).await["provider"].clone()
}
async fn get(state: &Arc<Mutex<AppState>>, id: &Value) -> Value {
    call(state, "providers.get", json!({"id":id})).await["provider"].clone()
}

#[tokio::test]
async fn template_accounts_rpc_credentials_models_delete_and_restart_are_isolated() {
    let root = tempfile::tempdir().unwrap();
    let plugin = root.path().join("fixture");
    write_manifest(&plugin, Some(template()));
    let data = root.path().join("data");
    let state = state_at(&data);
    load(&state, &plugin).await;
    let legacy_id = json!("plugin:fixture.templates:legacy");
    let old = get(&state, &legacy_id).await;
    assert!(old.get("pluginTemplateId").is_none());
    assert_eq!(
        call(&state, "providers.list", json!({})).await["providers"]
            .as_array()
            .unwrap()
            .len(),
        1,
        "install must not create template accounts"
    );
    let lookup = call(
        &state,
        "providers.getTemplate",
        json!({"pluginId":"fixture.templates","templateId":"gateway"}),
    )
    .await;
    assert_eq!(lookup["template"], template());
    let first = create(
        &state,
        json!({"name":"First","secretValue":"fixture-key-one"}),
    )
    .await;
    let second = create(
        &state,
        json!({"name":"Second","secretValue":"fixture-key-two"}),
    )
    .await;
    assert_ne!(first["id"], second["id"]);
    assert!(!first["id"].as_str().unwrap().starts_with("plugin:"));
    assert_eq!(first["ownerPluginId"], "fixture.templates");
    assert_eq!(first["pluginTemplateId"], "gateway");
    assert_eq!(first["pluginTemplateVersion"], 1);
    call(&state,"providers.update",json!({"id":first["id"],"name":"Personal","models":[{"id":"small","alias":"Mine","contextWindow":9000}],"enabled":false})).await;
    call(&state,"providers.cacheModels",json!({"providerId":first["id"],"models":[{"modelId":"only-first","displayName":"First discovered"}]})).await;
    call(&state,"providers.cacheModels",json!({"providerId":second["id"],"models":[{"modelId":"only-second","displayName":"Second discovered"}]})).await;
    assert_eq!(
        call(&state, "providers.getSecret", json!({"id":first["id"]})).await["value"],
        "fixture-key-one"
    );
    assert_eq!(
        call(&state, "providers.getSecret", json!({"id":second["id"]})).await["value"],
        "fixture-key-two"
    );
    load(&state, &plugin).await;
    let edited = get(&state, &first["id"]).await;
    assert_eq!(edited["name"], "Personal");
    assert_eq!(edited["models"][0]["alias"], "Mine");
    assert_eq!(edited["enabled"], false);
    assert_eq!(
        get(&state, &second["id"]).await["models"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    let models = call(
        &state,
        "providers.listModels",
        json!({"providerId":second["id"]}),
    )
    .await;
    assert!(models["models"]
        .as_array()
        .unwrap()
        .iter()
        .all(|m| m["modelId"] != "only-first"));
    call(&state, "providers.delete", json!({"id":first["id"]})).await;
    fails(&state, "providers.delete", json!({"id":legacy_id})).await;
    load(&state, &plugin).await;
    assert!(get(&state, &first["id"]).await.is_null());
    assert_eq!(
        call(&state, "providers.getSecret", json!({"id":second["id"]})).await["value"],
        "fixture-key-two"
    );
    drop(state);
    let state = state_at(&data);
    assert!(get(&state, &first["id"]).await.is_null());
    assert_eq!(get(&state, &second["id"]).await["name"], "Second");
    assert_eq!(get(&state, &legacy_id).await["models"], old["models"]);
    assert_eq!(get(&state, &legacy_id).await["createdAt"], old["createdAt"]);
    let st = state.lock().await;
    assert!(!st.secrets.has(&crate::secrets::secret_ref_for_provider(
        first["id"].as_str().unwrap()
    )));
}

#[tokio::test]
async fn template_accounts_rpc_lifecycle_revocation_removal_transport_and_uninstall() {
    let root = tempfile::tempdir().unwrap();
    let plugin = root.path().join("fixture");
    write_manifest(&plugin, Some(template()));
    let state = state_at(&root.path().join("data"));
    load(&state, &plugin).await;
    let first = create(&state, json!({"secretValue":"fixture-key"})).await;
    call(
        &state,
        "providers.update",
        json!({"id":first["id"],"name":"Remember","models":[],"enabled":false}),
    )
    .await;
    call(&state, "plugins.disable", json!({"id":"fixture.templates"})).await;
    assert_eq!(get(&state, &first["id"]).await["hasSecret"], true);
    fails(
        &state,
        "providers.createFromTemplate",
        json!({"pluginId":"fixture.templates","templateId":"gateway"}),
    )
    .await;
    fails(
        &state,
        "providers.update",
        json!({"id":first["id"],"enabled":true}),
    )
    .await;
    call(&state, "plugins.enable", json!({"id":"fixture.templates"})).await;
    assert_eq!(get(&state, &first["id"]).await["enabled"], false);
    call(
        &state,
        "providers.update",
        json!({"id":first["id"],"enabled":true}),
    )
    .await;
    call(
        &state,
        "plugins.revokePermissions",
        json!({"id":"fixture.templates","permissions":["provider.register"]}),
    )
    .await;
    let revoked = get(&state, &first["id"]).await;
    assert_eq!(revoked["enabled"], false);
    assert_eq!(revoked["hasSecret"], true);
    fails(
        &state,
        "providers.getTemplate",
        json!({"pluginId":"fixture.templates","templateId":"gateway"}),
    )
    .await;
    fails(
        &state,
        "providers.update",
        json!({"id":first["id"],"enabled":true}),
    )
    .await;
    call(
        &state,
        "plugins.grantPermissions",
        json!({"id":"fixture.templates","permissions":["provider.register"]}),
    )
    .await;
    assert_eq!(get(&state, &first["id"]).await["enabled"], true);
    write_manifest(&plugin, None);
    load(&state, &plugin).await;
    let removed = get(&state, &first["id"]).await;
    assert_eq!(removed["enabled"], false);
    assert_eq!(removed["hasSecret"], true);
    assert_eq!(removed["models"], json!([]));
    fails(
        &state,
        "providers.update",
        json!({"id":first["id"],"enabled":true}),
    )
    .await;
    let mut changed = template();
    changed["baseUrl"] = json!("https://new.example.test/v1");
    call(&state, "providers.cacheModels", json!({"providerId":first["id"],"models":[{"modelId":"old-discovered","displayName":"Old endpoint"}]})).await;
    write_manifest(&plugin, Some(changed));
    load(&state, &plugin).await;
    let changed = get(&state, &first["id"]).await;
    assert_eq!(changed["hasSecret"], false);
    assert_eq!(changed["name"], "Remember");
    assert_eq!(changed["models"], json!([]));
    assert_eq!(
        call(
            &state,
            "providers.listModels",
            json!({"providerId":first["id"]})
        )
        .await["models"],
        json!([])
    );
    call(
        &state,
        "providers.setSecret",
        json!({"id":first["id"],"secretValue":"replacement-fixture"}),
    )
    .await;
    {
        let st = state.lock().await;
        st.db.conn().execute("INSERT INTO sessions(id,title,mode,provider_id,created_at,updated_at) VALUES('kept-conversation','Keep','agent',?1,1,1)",[first["id"].as_str().unwrap()]).unwrap();
    }
    call(
        &state,
        "plugins.uninstall",
        json!({"id":"fixture.templates"}),
    )
    .await;
    assert!(get(&state, &first["id"]).await.is_null());
    let st = state.lock().await;
    assert!(!st.secrets.has(&crate::secrets::secret_ref_for_provider(
        first["id"].as_str().unwrap()
    )));
    assert_eq!(
        st.db
            .conn()
            .query_row(
                "SELECT count(*) FROM sessions WHERE id='kept-conversation'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
}

#[tokio::test]
async fn template_accounts_rpc_oauth_completion_reauth_and_abandoned_startup_cleanup() {
    let root = tempfile::tempdir().unwrap();
    let plugin = root.path().join("fixture");
    let mut oauth = template();
    oauth["authKind"] = json!("oauth");
    oauth["oauth"] = json!({"flow":"authorization_code","clientId":"fixture-client","authorizationUrl":"https://auth.example.test/authorize","tokenUrl":"https://auth.example.test/token"});
    write_manifest(&plugin, Some(oauth.clone()));
    let data = root.path().join("data");
    let state = state_at(&data);
    load(&state, &plugin).await;
    call(
        &state,
        "plugins.revokePermissions",
        json!({"id":"fixture.templates","permissions":["provider.oauth"]}),
    )
    .await;
    // Declarative login never needs the custom plugin callback grant.
    let first = create(&state, json!({})).await;
    assert_eq!(first["enabled"], false);
    fails(
        &state,
        "providers.completeTemplateOAuth",
        json!({"id":first["id"]}),
    )
    .await;
    fails(
        &state,
        "providers.update",
        json!({"id":first["id"],"enabled":true}),
    )
    .await;
    call(
        &state,
        "providers.update",
        json!({"id":first["id"],"enabled":false,"name":"OAuth personal"}),
    )
    .await;
    let oauth_ref = crate::secrets::secret_ref_for_provider_oauth(first["id"].as_str().unwrap());
    call(
        &state,
        "secrets.set",
        json!({"secretRef":oauth_ref,"value":"fixture-oauth-one"}),
    )
    .await;
    let completed = call(
        &state,
        "providers.completeTemplateOAuth",
        json!({"id":first["id"]}),
    )
    .await;
    assert_eq!(
        completed["provider"]["enabled"], false,
        "completion preserves explicit disable preference"
    );
    call(
        &state,
        "providers.update",
        json!({"id":first["id"],"enabled":true}),
    )
    .await;
    let abandoned = create(&state, json!({})).await;
    let abandoned_ref =
        crate::secrets::secret_ref_for_provider_oauth(abandoned["id"].as_str().unwrap());
    call(
        &state,
        "secrets.set",
        json!({"secretRef":abandoned_ref,"value":"fixture-abandoned-oauth"}),
    )
    .await;
    drop(state);
    let state = state_at(&data);
    assert!(get(&state, &abandoned["id"]).await.is_null());
    assert_eq!(get(&state, &first["id"]).await["enabled"], true);
    {
        let st = state.lock().await;
        assert!(!st.secrets.has(&abandoned_ref));
    }
    // Display changes keep auth; OAuth transport changes require fresh auth.
    oauth["oauth"]["loginLabel"] = json!("Sign in again");
    write_manifest(&plugin, Some(oauth.clone()));
    load(&state, &plugin).await;
    assert_eq!(get(&state, &first["id"]).await["hasOauth"], true);
    oauth["oauth"]["clientId"] = json!("different-client");
    write_manifest(&plugin, Some(oauth.clone()));
    load(&state, &plugin).await;
    let stale = get(&state, &first["id"]).await;
    assert_eq!(stale["enabled"], false);
    assert_eq!(stale["hasOauth"], false);
    fails(
        &state,
        "providers.completeTemplateOAuth",
        json!({"id":first["id"]}),
    )
    .await;
    drop(state);
    let state = state_at(&data);
    assert_eq!(
        get(&state, &first["id"]).await["name"],
        "OAuth personal",
        "reauth accounts are not abandoned creations"
    );
    call(
        &state,
        "secrets.set",
        json!({"secretRef":oauth_ref,"value":"fixture-stale-login"}),
    )
    .await;
    oauth["oauth"]["tokenUrl"] = json!("https://changed.example.test/token");
    write_manifest(&plugin, Some(oauth));
    // No plugin reload: completion itself must re-read the authoritative manifest.
    fails(
        &state,
        "providers.completeTemplateOAuth",
        json!({"id":first["id"]}),
    )
    .await;
    assert_eq!(get(&state, &first["id"]).await["hasOauth"], false);
    call(
        &state,
        "secrets.set",
        json!({"secretRef":oauth_ref,"value":"fixture-oauth-new"}),
    )
    .await;
    assert_eq!(
        call(
            &state,
            "providers.completeTemplateOAuth",
            json!({"id":first["id"]})
        )
        .await["provider"]["enabled"],
        true
    );
    call(
        &state,
        "plugins.uninstall",
        json!({"id":"fixture.templates"}),
    )
    .await;
    assert!(get(&state, &first["id"]).await.is_null());
    assert!(!state.lock().await.secrets.has(&oauth_ref));
}

#[tokio::test]
async fn template_accounts_rpc_rejects_caller_binding_and_secret_reference_fields() {
    let root = tempfile::tempdir().unwrap();
    let plugin = root.path().join("fixture");
    write_manifest(&plugin, Some(template()));
    let state = state_at(&root.path().join("data"));
    load(&state, &plugin).await;
    for (key, value) in [
        ("id", json!("caller-chosen")),
        ("ownerPluginId", json!("other")),
        ("secretRef", json!("secret:other")),
        ("pluginTemplateId", json!("other")),
        ("pluginTemplateVersion", json!(1)),
        ("baseUrl", json!("https://other.test")),
    ] {
        let mut input = json!({"pluginId":"fixture.templates","templateId":"gateway"});
        input[key] = value;
        fails(&state, "providers.createFromTemplate", input).await;
    }
    fails(
        &state,
        "providers.create",
        json!({"name":"Forged","ownerPluginId":"fixture.templates"}),
    )
    .await;
    let first = create(&state, json!({})).await;
    fails(
        &state,
        "providers.update",
        json!({"id":first["id"],"ownerPluginId":"other","secretValue":"do-not-write"}),
    )
    .await;
    fails(
        &state,
        "providers.completeTemplateOAuth",
        json!({"id":first["id"],"secretRef":"secret:other"}),
    )
    .await;
    assert_eq!(get(&state, &first["id"]).await["hasSecret"], false);
}

#[tokio::test]
async fn template_accounts_cleanup_failure_is_observable_and_retried_on_restart() {
    let root = tempfile::tempdir().unwrap();
    let plugin = root.path().join("fixture");
    let mut oauth = template();
    oauth["authKind"] = json!("oauth");
    write_manifest(&plugin, Some(oauth));
    let data = root.path().join("data");
    let state = state_at(&data);
    load(&state, &plugin).await;
    let pending = create(&state, json!({})).await;
    {
        let st = state.lock().await;
        st.db.conn().execute_batch("CREATE TRIGGER fail_pending_cleanup BEFORE DELETE ON providers BEGIN SELECT RAISE(ABORT, 'fixture cleanup blocked'); END;").unwrap();
        let error =
            crate::plugins::provider_templates::cleanup_pending(&st.db, &st.secrets).unwrap_err();
        assert!(error
            .to_string()
            .contains("pending template OAuth account cleanup failed"));
        assert!(
            !providers::get_provider(&st.db, &st.secrets, pending["id"].as_str().unwrap())
                .unwrap()
                .unwrap()
                .enabled
        );
        st.db
            .conn()
            .execute_batch("DROP TRIGGER fail_pending_cleanup;")
            .unwrap();
    }
    drop(state);
    let state = state_at(&data);
    assert!(get(&state, &pending["id"]).await.is_null());
}

mod cleanup;
