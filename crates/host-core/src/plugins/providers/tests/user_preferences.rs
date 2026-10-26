//! User-owned preferences and manifest-owned capabilities across reconciliation.
use super::*;

#[test]
fn plugin_model_and_name_overrides_survive_reconciliation_and_lifecycle() {
    let (_dir, db, secrets) = test_context();
    let id = "plugin:demo.provider:demo";
    sync_plugin_providers(
        &db,
        &secrets,
        "demo.provider",
        &declared_providers(&manifest()),
        true,
    )
    .unwrap();
    let mut update = plugin_update(id);
    update.vendor_key = Some("custom".into());
    update.provider_type = Some("openai_compatible".into());
    update.protocol = Some("openai_compatible".into());
    update.base_url = Some("https://api.example.com/v1".into());
    update.auth_kind = Some("api_key".into());
    update.api_style = Some("chat_completions".into());
    update.name = Some("My Demo".into());
    update.enabled = Some(false);
    update.models = Some(
        serde_json::from_value(json!([{
            "id": "mine/model", "alias": "My model", "contextWindow": 64000,
            "maxTokens": 4000, "thinkingLevels": ["high"], "defaultThinkingLevel": "high",
            "supportsImages": true, "supportsDocuments": false, "availableForSubagents": true
        }]))
        .unwrap(),
    );
    let saved = providers::update_provider(&db, &secrets, update)
        .unwrap()
        .unwrap();
    assert_eq!(saved.name, "My Demo");
    assert!(!saved.enabled);
    assert_eq!(saved.models[0].alias.as_deref(), Some("My model"));
    assert_eq!(saved.models[0].context_window, 64_000);
    assert_eq!(saved.models[0].available_for_subagents, Some(true));

    drop(secrets);
    drop(db);
    let db = Database::open(&_dir.path().join("pi.sqlite")).unwrap();
    let secrets = SecretStore::open(_dir.path()).unwrap();

    sync_plugin_providers(
        &db,
        &secrets,
        "demo.provider",
        &declared_providers(&manifest()),
        true,
    )
    .unwrap();
    let saved = providers::get_provider(&db, &secrets, id).unwrap().unwrap();
    assert_eq!(saved.name, "My Demo");
    assert_eq!(saved.models[0].id, "mine/model");
    assert!(!saved.enabled);
    set_plugin_providers_enabled(&db, "demo.provider", false).unwrap();
    set_plugin_providers_enabled(&db, "demo.provider", true).unwrap();
    assert!(
        !providers::get_provider(&db, &secrets, id)
            .unwrap()
            .unwrap()
            .enabled
    );

    let mut clear = plugin_update(id);
    clear.models = Some(Vec::new());
    providers::update_provider(&db, &secrets, clear).unwrap();
    sync_plugin_providers(
        &db,
        &secrets,
        "demo.provider",
        &declared_providers(&manifest()),
        true,
    )
    .unwrap();
    assert!(providers::get_provider(&db, &secrets, id)
        .unwrap()
        .unwrap()
        .models
        .is_empty());
}

#[test]
fn plugin_refresh_uses_new_manifest_defaults_without_user_overrides() {
    let (_dir, db, secrets) = test_context();
    let mut changed = serde_json::to_value(manifest()).unwrap();
    changed["contributes"]["providers"][0]["name"] = json!("Refreshed");
    changed["contributes"]["providers"][0]["models"] = json!([{"id": "fresh-model"}]);
    let changed: PluginManifest = serde_json::from_value(changed).unwrap();
    sync_plugin_providers(
        &db,
        &secrets,
        "demo.provider",
        &declared_providers(&manifest()),
        true,
    )
    .unwrap();
    sync_plugin_providers(
        &db,
        &secrets,
        "demo.provider",
        &declared_providers(&changed),
        true,
    )
    .unwrap();
    let row = providers::get_provider(&db, &secrets, "plugin:demo.provider:demo")
        .unwrap()
        .unwrap();
    assert_eq!(row.name, "Refreshed");
    assert_eq!(
        row.models
            .iter()
            .map(|model| model.id.as_str())
            .collect::<Vec<_>>(),
        ["fresh-model"]
    );
}

#[test]
fn plugin_endpoint_change_invalidates_api_key_oauth_and_catalog_binding() {
    let (_dir, db, secrets) = test_context();
    let id = "plugin:demo.provider:demo";
    sync_plugin_providers(
        &db,
        &secrets,
        "demo.provider",
        &declared_providers(&manifest()),
        true,
    )
    .unwrap();
    let mut preferences = plugin_update(id);
    preferences.headers = Some(std::collections::BTreeMap::from([(
        "X-Provider-Token".into(),
        "old-header-token".into(),
    )]));
    preferences.oauth_account_label = Some("old-account".into());
    providers::update_provider(&db, &secrets, preferences).unwrap();
    let key_ref = crate::secrets::secret_ref_for_provider(id);
    let oauth_ref = crate::secrets::secret_ref_for_provider_oauth(id);
    secrets.set(&key_ref, "old-key").unwrap();
    secrets.set(&oauth_ref, "old-oauth").unwrap();
    providers::cache_discovered_models(
        &db,
        id,
        &[providers::DiscoveredModelInput {
            model_id: "cached-old".into(),
            display_name: "Cached old".into(),
            capabilities: vec!["text".into()],
            context_window: Some(64000),
        }],
        true,
    )
    .unwrap();
    let mut changed = serde_json::to_value(manifest()).unwrap();
    changed["contributes"]["providers"][0]["baseUrl"] = json!("https://new.example.com/v1");
    let changed: PluginManifest = serde_json::from_value(changed).unwrap();
    sync_plugin_providers(
        &db,
        &secrets,
        "demo.provider",
        &declared_providers(&changed),
        true,
    )
    .unwrap();
    assert!(!providers::list_models(&db, Some(id))
        .unwrap()
        .iter()
        .any(|model| model.model_id == "cached-old"));
    assert!(!secrets.has(&key_ref));
    assert!(!secrets.has(&oauth_ref));
    let row = providers::get_provider(&db, &secrets, id).unwrap().unwrap();
    assert!(!row.has_secret);
    assert!(row
        .headers
        .as_ref()
        .is_none_or(|headers| headers.is_empty()));
    assert!(row.oauth_account_label.is_none());
    assert_eq!(row.base_url.as_deref(), Some("https://new.example.com/v1"));
}

#[test]
fn user_cannot_enable_provider_of_disabled_plugin() {
    let (_dir, db, secrets) = test_context();
    let id = "plugin:demo.provider:demo";
    let declared = declared_providers(&manifest());
    sync_plugin_providers(&db, &secrets, "demo.provider", &declared, true).unwrap();
    set_plugin_providers_enabled(&db, "demo.provider", false).unwrap();
    let mut update = plugin_update(id);
    update.enabled = Some(true);
    update.secret_value = Some("must-not-be-written".into());
    let error = providers::update_provider(&db, &secrets, update)
        .unwrap_err()
        .to_string();
    assert!(error.contains("PLUGIN_DISABLED"));
    assert!(
        !providers::get_provider(&db, &secrets, id)
            .unwrap()
            .unwrap()
            .enabled
    );
    assert!(!secrets.has(&crate::secrets::secret_ref_for_provider(id)));
    sync_plugin_providers(&db, &secrets, "demo.provider", &declared, false).unwrap();
    let mut update = plugin_update(id);
    update.enabled = Some(true);
    assert!(providers::update_provider(&db, &secrets, update)
        .unwrap_err()
        .to_string()
        .contains("PLUGIN_DISABLED"));
}

#[test]
fn adapter_model_operations_are_manifest_owned_and_projected_for_selected_models() {
    let (_dir, db, secrets) = test_context();
    let id = "plugin:demo.provider:demo";
    let mut raw = serde_json::to_value(manifest()).unwrap();
    raw["permissions"] = json!(["provider.register", "provider.oauth", "provider.inference"]);
    raw["contributes"]["providers"][0]["authKind"] = json!("oauth");
    raw["contributes"]["providers"][0]["adapter"] =
        json!({"version": 1, "chat": true, "images": true});
    raw["contributes"]["providers"][0]["models"] = json!([
        {"id": "chat", "operations": ["chat"]},
        {"id": "image", "operations": ["images"]}
    ]);
    let declaration: PluginManifest = serde_json::from_value(raw.clone()).unwrap();
    sync_plugin_providers(
        &db,
        &secrets,
        "demo.provider",
        &declared_providers(&declaration),
        true,
    )
    .unwrap();
    let row = providers::get_provider(&db, &secrets, id).unwrap().unwrap();
    assert_eq!(
        serde_json::to_value(&row).unwrap()["pluginModelOperations"],
        json!({"chat": ["chat"], "image": ["images"]})
    );
    let mut update = plugin_update(id);
    update.models = Some(row.models);
    providers::update_provider(&db, &secrets, update).unwrap();
    raw["contributes"]["providers"][0]["adapter"] = json!({"version": 1, "chat": true});
    raw["contributes"]["providers"][0]["models"] = json!([{"id": "chat"}, {"id": "image"}]);
    let changed: PluginManifest = serde_json::from_value(raw).unwrap();
    sync_plugin_providers(
        &db,
        &secrets,
        "demo.provider",
        &declared_providers(&changed),
        true,
    )
    .unwrap();
    let row = providers::get_provider(&db, &secrets, id).unwrap().unwrap();
    assert_eq!(
        serde_json::to_value(&row).unwrap()["pluginModelOperations"],
        json!({"chat": ["chat"], "image": ["chat"]})
    );
}

#[test]
fn adapter_without_manifest_models_projects_operations_for_later_selection() {
    let (_dir, db, secrets) = test_context();
    let id = "plugin:demo.provider:demo";
    let mut raw = serde_json::to_value(manifest()).unwrap();
    raw["permissions"] = json!(["provider.register", "provider.oauth", "provider.inference"]);
    let provider = raw["contributes"]["providers"][0].as_object_mut().unwrap();
    provider.insert("authKind".into(), json!("oauth"));
    provider.insert("adapter".into(), json!({"version": 1, "images": true}));
    provider.remove("models");
    let declaration: PluginManifest = serde_json::from_value(raw).unwrap();
    sync_plugin_providers(
        &db,
        &secrets,
        "demo.provider",
        &declared_providers(&declaration),
        true,
    )
    .unwrap();
    let mut update = plugin_update(id);
    update.models = Some(vec![serde_json::from_value(
        json!({"id": "discovered-image", "thinkingLevels": []}),
    )
    .unwrap()]);
    providers::update_provider(&db, &secrets, update).unwrap();
    let row = providers::get_provider(&db, &secrets, id).unwrap().unwrap();
    assert_eq!(
        serde_json::to_value(&row).unwrap()["pluginModelOperations"],
        json!({"discovered-image": ["images"]})
    );
}
