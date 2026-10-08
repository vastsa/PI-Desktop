use super::*;
use crate::db::SCHEMA_VERSION;
use serde_json::json;
use std::fs;

fn test_context() -> (tempfile::TempDir, Database, SecretStore) {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    let secrets = SecretStore::open(dir.path()).unwrap();
    (dir, db, secrets)
}

/// A manifest that declares one API-key provider with two models.
fn manifest() -> PluginManifest {
    serde_json::from_value(json!({
        "schemaVersion": 1,
        "id": "demo.provider",
        "name": "Demo provider",
        "version": "0.1.0",
        "main": "main.js",
        "permissions": ["provider.register"],
        "contributes": {
            "providers": [{
                "id": "demo",
                "name": "Demo",
                "baseUrl": "https://api.example.com/v1",
                "apiStyle": "chat_completions",
                "authKind": "api_key",
                "models": [
                    { "id": "demo-large", "name": "Demo Large", "contextWindow": 200000, "maxTokens": 8192 },
                    { "id": "demo-small" }
                ]
            }]
        }
    }))
    .unwrap()
}

/// The same declared provider under a different auth kind.
fn manifest_with_auth_kind(auth_kind: &str) -> PluginManifest {
    let mut value = serde_json::to_value(manifest()).unwrap();
    value["contributes"]["providers"][0]["authKind"] = json!(auth_kind);
    serde_json::from_value(value).unwrap()
}

/// Several declared providers, so a shrink can leave a survivor behind.
fn manifest_with_providers(ids: &[&str]) -> PluginManifest {
    let mut value = serde_json::to_value(manifest()).unwrap();
    let first = value["contributes"]["providers"][0].clone();
    let declared: Vec<Value> = ids
        .iter()
        .map(|id| {
            let mut entry = first.clone();
            entry["id"] = json!(id);
            entry["name"] = json!(id);
            entry
        })
        .collect();
    value["contributes"]["providers"] = json!(declared);
    serde_json::from_value(value).unwrap()
}

fn manifest_with_dynamic_provider() -> PluginManifest {
    let mut value = serde_json::to_value(manifest()).unwrap();
    value["contributes"]["providers"][0]["models"] = json!([]);
    serde_json::from_value(value).unwrap()
}

fn write_plugin(root: &std::path::Path, manifest: Value) {
    fs::create_dir_all(root).unwrap();
    fs::write(root.join("main.js"), "export function onLoad() {}").unwrap();
    fs::write(
        root.join("manifest.json"),
        serde_json::to_string_pretty(&manifest).unwrap(),
    )
    .unwrap();
}

fn read_manifest_err(root: &std::path::Path) -> String {
    PluginManager::read_manifest(root)
        .expect_err("manifest should be rejected")
        .to_string()
}

fn declaration_manifest(providers: Value, permissions: Value) -> Value {
    json!({
        "schemaVersion": 1,
        "id": "demo.declared",
        "name": "Declared",
        "version": "0.1.0",
        "main": "main.js",
        "contributes": { "providers": providers },
        "permissions": permissions,
    })
}

#[test]
fn a_new_database_carries_the_owner_column_at_the_current_schema_version() {
    let (_dir, db, _secrets) = test_context();
    // v17 added the owner column, v18 the turn-queue priority column,
    // v19 session omit, v21 the session Todo checklist, and v22 the
    // session-list index. A fresh database is stamped with the newest version,
    // so the column set is the current one.
    assert_eq!(SCHEMA_VERSION, 23);
    let version: i64 = db
        .conn()
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    assert_eq!(version, SCHEMA_VERSION);
    let has_owner: bool = db
        .conn()
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('providers') WHERE name = 'owner_plugin_id')",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(has_owner);
}

#[test]
fn declared_providers_reads_the_manifest() {
    let declared = declared_providers(&manifest());
    assert_eq!(declared.len(), 1);
    let provider = &declared[0];
    assert_eq!(provider.id, "demo");
    assert_eq!(provider.api_style, "chat_completions");
    assert_eq!(provider.auth_kind, "api_key");
    assert_eq!(
        provider.base_url.as_deref(),
        Some("https://api.example.com/v1")
    );
    assert_eq!(
        provider
            .models
            .iter()
            .map(|m| m.id.as_str())
            .collect::<Vec<_>>(),
        ["demo-large", "demo-small"]
    );
    assert_eq!(provider.models[0].context_window, 200_000);
    // A model that declares no limits falls back to the runtime default
    // instead of storing a zero window.
    assert_eq!(provider.models[1].context_window, 0);
}

#[test]
fn provider_declarations_have_no_eight_row_cap() {
    let ids: Vec<String> = (0..18).map(|index| format!("site-{index}")).collect();
    let borrowed: Vec<&str> = ids.iter().map(String::as_str).collect();
    let declared = declared_providers(&manifest_with_providers(&borrowed));
    assert_eq!(declared.len(), 18);

    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("plugin");
    write_plugin(
        &root,
        serde_json::to_value(manifest_with_providers(&borrowed)).unwrap(),
    );
    assert!(PluginManager::read_manifest(&root).is_ok());
}

#[test]
fn empty_api_key_model_list_uses_the_cached_endpoint_discovery() {
    let (_dir, db, secrets) = test_context();
    let declared = declared_providers(&manifest_with_dynamic_provider());
    assert!(declared[0].models.is_empty());
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("plugin");
    write_plugin(
        &root,
        serde_json::to_value(manifest_with_dynamic_provider()).unwrap(),
    );
    assert!(PluginManager::read_manifest(&root).is_ok());
    sync_plugin_providers(&db, &secrets, "demo.provider", &declared, true).unwrap();
    providers::set_provider_secret(
        &db,
        &secrets,
        "plugin:demo.provider:demo",
        Some("fixture-key"),
    )
    .unwrap();
    providers::cache_discovered_models(
        &db,
        "plugin:demo.provider:demo",
        &[providers::DiscoveredModelInput {
            model_id: "demo-chat".to_string(),
            display_name: "Demo Chat".to_string(),
            capabilities: vec!["text".to_string()],
            context_window: Some(128_000),
        }],
    )
    .unwrap();

    let listed = providers::list_providers(&db, &secrets, true).unwrap();
    assert_eq!(listed[0].models.len(), 1);
    assert_eq!(listed[0].models[0].id, "demo-chat");
    assert_eq!(listed[0].models[0].alias.as_deref(), Some("Demo Chat"));
    assert_eq!(listed[0].default_model_id.as_deref(), Some("demo-chat"));
}

#[test]
fn sync_writes_rows_owned_by_the_plugin() {
    let (_dir, db, secrets) = test_context();
    let declared = declared_providers(&manifest());
    assert_eq!(
        sync_plugin_providers(&db, &secrets, "demo.provider", &declared, true).unwrap(),
        1
    );
    let listed = providers::list_providers(&db, &secrets, true).unwrap();
    assert_eq!(listed.len(), 1);
    let row = &listed[0];
    assert_eq!(row.id, "plugin:demo.provider:demo");
    assert_eq!(row.owner_plugin_id.as_deref(), Some("demo.provider"));
    assert_eq!(row.auth_kind, "api_key");
    assert_eq!(row.name, "Demo");
    assert!(row.enabled);
    assert_eq!(row.default_model_id.as_deref(), Some("demo-large"));
    assert_eq!(row.models.len(), 2);
    assert_eq!(row.models[0].id, "demo-large");
    // A plugin row carries no declared API key: the credential is the
    // user's, stored under the same provider-scoped refs as any other row.
    assert!(!row.has_secret);
}

#[test]
fn sync_is_declarative_and_drops_a_removed_declaration() {
    let (_dir, db, secrets) = test_context();
    let declared = declared_providers(&manifest());
    sync_plugin_providers(&db, &secrets, "demo.provider", &declared, true).unwrap();
    let key_ref = crate::secrets::secret_ref_for_provider("plugin:demo.provider:demo");
    secrets.set(&key_ref, "sk-demo").unwrap();
    // A plugin update that stops declaring the provider must not leave the
    // row (or its credential) behind.
    sync_plugin_providers(&db, &secrets, "demo.provider", &[], true).unwrap();
    assert!(
        providers::get_provider(&db, &secrets, "plugin:demo.provider:demo")
            .unwrap()
            .is_none()
    );
    assert!(!secrets.has(&key_ref));
}

/// A declaration that stops naming a model forgets the row cached for it, the
/// same way a user save does: the cache must not keep describing a model this
/// provider no longer declares.
#[test]
fn dropping_a_declared_model_forgets_its_cached_row() {
    let (_dir, db, secrets) = test_context();
    let declared = declared_providers(&manifest());
    sync_plugin_providers(&db, &secrets, "demo.provider", &declared, true).unwrap();
    let row_id = "plugin:demo.provider:demo";
    providers::cache_discovered_models(
        &db,
        row_id,
        &[
            providers::DiscoveredModelInput {
                model_id: "demo-large".into(),
                display_name: "Demo Large".into(),
                capabilities: vec!["text".into()],
                context_window: Some(200_000),
            },
            providers::DiscoveredModelInput {
                model_id: "demo-small".into(),
                display_name: "Demo Small".into(),
                capabilities: vec!["text".into()],
                context_window: Some(32_000),
            },
            providers::DiscoveredModelInput {
                model_id: "demo-extra".into(),
                display_name: "Demo Extra".into(),
                capabilities: vec!["text".into()],
                context_window: None,
            },
        ],
    )
    .unwrap();
    assert_eq!(providers::list_models(&db, Some(row_id)).unwrap().len(), 3);

    let mut value = serde_json::to_value(manifest()).unwrap();
    value["contributes"]["providers"][0]["models"] = json!([{
        "id": "demo-large",
        "name": "Demo Large",
        "contextWindow": 200000,
        "maxTokens": 8192
    }]);
    let shrunk: PluginManifest = serde_json::from_value(value).unwrap();
    sync_plugin_providers(
        &db,
        &secrets,
        "demo.provider",
        &declared_providers(&shrunk),
        true,
    )
    .unwrap();

    let mut cached: Vec<String> = providers::list_models(&db, Some(row_id))
        .unwrap()
        .into_iter()
        .map(|model| model.model_id)
        .collect();
    cached.sort();
    assert_eq!(cached, vec!["demo-extra", "demo-large"]);
}

/// A declaration that moves its endpoint abandons the discovery answer the
/// previous one produced: those rows describe a service this provider no longer
/// points at.
#[test]
fn moving_a_declared_endpoint_forgets_the_discovered_answer() {
    let (_dir, db, secrets) = test_context();
    let declared = declared_providers(&manifest());
    sync_plugin_providers(&db, &secrets, "demo.provider", &declared, true).unwrap();
    let row_id = "plugin:demo.provider:demo";
    providers::cache_discovered_models(
        &db,
        row_id,
        &[
            providers::DiscoveredModelInput {
                model_id: "demo-large".into(),
                display_name: "Demo Large".into(),
                capabilities: vec!["text".into()],
                context_window: Some(200_000),
            },
            providers::DiscoveredModelInput {
                model_id: "demo-remote-only".into(),
                display_name: "Demo Remote Only".into(),
                capabilities: vec!["text".into()],
                context_window: Some(8_000),
            },
        ],
    )
    .unwrap();
    assert_eq!(providers::list_models(&db, Some(row_id)).unwrap().len(), 2);

    let mut value = serde_json::to_value(manifest()).unwrap();
    value["contributes"]["providers"][0]["baseUrl"] = json!("https://mirror.example.com/v1");
    let moved: PluginManifest = serde_json::from_value(value).unwrap();
    sync_plugin_providers(
        &db,
        &secrets,
        "demo.provider",
        &declared_providers(&moved),
        true,
    )
    .unwrap();

    let cached: Vec<String> = providers::list_models(&db, Some(row_id))
        .unwrap()
        .into_iter()
        .map(|model| model.model_id)
        .collect();
    assert_eq!(cached, vec!["demo-large"]);
}

#[test]
fn sync_keeps_provider_config_it_does_not_own() {
    let (_dir, db, secrets) = test_context();
    let declared = declared_providers(&manifest());
    sync_plugin_providers(&db, &secrets, "demo.provider", &declared, true).unwrap();
    db.conn()
        .execute(
            "UPDATE providers SET config_json = ?1 WHERE id = 'plugin:demo.provider:demo'",
            params![json!({ "oauth": { "accountLabel": "kept" } }).to_string()],
        )
        .unwrap();
    sync_plugin_providers(&db, &secrets, "demo.provider", &declared, true).unwrap();
    let row = providers::get_provider(&db, &secrets, "plugin:demo.provider:demo")
        .unwrap()
        .unwrap();
    // The merge replaces only the model bindings it owns, so a value the
    // plugin's own login flow stored survives the next load.
    assert_eq!(row.oauth_account_label.as_deref(), Some("kept"));
    assert_eq!(
        row.models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
        ["demo-large", "demo-small"]
    );
}

#[test]
fn disabling_and_removing_a_plugin_take_its_rows_with_it() {
    let (_dir, db, secrets) = test_context();
    let declared = declared_providers(&manifest());
    sync_plugin_providers(&db, &secrets, "demo.provider", &declared, true).unwrap();
    assert_eq!(
        set_plugin_providers_enabled(&db, "demo.provider", false).unwrap(),
        1
    );
    assert!(
        !providers::get_provider(&db, &secrets, "plugin:demo.provider:demo")
            .unwrap()
            .unwrap()
            .enabled
    );
    let key_ref = crate::secrets::secret_ref_for_provider("plugin:demo.provider:demo");
    secrets.set(&key_ref, "sk-demo").unwrap();
    assert_eq!(
        remove_plugin_providers(&db, &secrets, "demo.provider").unwrap(),
        1
    );
    assert!(
        providers::get_provider(&db, &secrets, "plugin:demo.provider:demo")
            .unwrap()
            .is_none()
    );
    assert!(!secrets.has(&key_ref));
}

#[test]
fn a_user_row_is_never_adopted_or_removed() {
    let (_dir, db, secrets) = test_context();
    let user = providers::create_provider(
        &db,
        &secrets,
        providers::ProviderCreateInput {
            name: "Mine".into(),
            vendor_key: None,
            provider_type: None,
            protocol: None,
            base_url: None,
            auth_kind: Some("none".into()),
            models: None,
            default_model_id: Some("model-1".into()),
            secret_value: None,
            api_style: None,
            oauth_account_label: None,
            headers: None,
            supports_reasoning: None,
            supported_thinking_levels: None,
            context_window: None,
            max_output_tokens: None,
            temperature: None,
        },
    )
    .unwrap();
    let declared = declared_providers(&manifest());
    sync_plugin_providers(&db, &secrets, "demo.provider", &declared, true).unwrap();
    assert_eq!(
        remove_plugin_providers(&db, &secrets, "demo.provider").unwrap(),
        1
    );
    assert!(providers::get_provider(&db, &secrets, &user.id)
        .unwrap()
        .is_some());
    assert_eq!(
        providers::list_providers(&db, &secrets, true)
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn the_user_path_refuses_a_plugin_owned_row() {
    let (_dir, db, secrets) = test_context();
    let declared = declared_providers(&manifest());
    sync_plugin_providers(&db, &secrets, "demo.provider", &declared, true).unwrap();
    let id = "plugin:demo.provider:demo";
    let delete_error = providers::delete_provider(&db, &secrets, id)
        .expect_err("the user path cannot delete a plugin row")
        .to_string();
    assert!(delete_error.contains("PROVIDER_OWNED_BY_PLUGIN"));
    let update_error = providers::update_provider(
        &db,
        &secrets,
        providers::ProviderUpdateInput {
            id: id.into(),
            name: Some("Renamed".into()),
            vendor_key: None,
            provider_type: None,
            protocol: None,
            base_url: None,
            auth_kind: None,
            models: None,
            default_model_id: None,
            secret_value: None,
            api_style: None,
            oauth_account_label: None,
            headers: None,
            supports_reasoning: None,
            supported_thinking_levels: None,
            context_window: None,
            max_output_tokens: None,
            temperature: None,
            enabled: None,
        },
    )
    .expect_err("the user path cannot edit a plugin row")
    .to_string();
    assert!(update_error.contains("PROVIDER_OWNED_BY_PLUGIN"));
    let row = providers::get_provider(&db, &secrets, id).unwrap().unwrap();
    assert_eq!(row.name, "Demo");
}

#[test]
fn the_declaration_requires_the_permission() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("plugin");
    let providers = json!([{
        "id": "demo",
        "name": "Demo",
        "baseUrl": "https://api.example.com/v1",
        "models": [{ "id": "demo-large" }]
    }]);
    write_plugin(&root, declaration_manifest(providers.clone(), json!([])));
    assert!(read_manifest_err(&root).contains("provider.register"));
    write_plugin(
        &root,
        declaration_manifest(providers, json!(["provider.register"])),
    );
    assert!(PluginManager::read_manifest(&root).is_ok());
}

#[test]
fn the_user_can_supply_the_key_a_plugin_row_asks_for() {
    let (_dir, db, secrets) = test_context();
    let declared = declared_providers(&manifest());
    sync_plugin_providers(&db, &secrets, "demo.provider", &declared, true).unwrap();
    let id = "plugin:demo.provider:demo";
    assert!(
        !providers::get_provider(&db, &secrets, id)
            .unwrap()
            .unwrap()
            .has_secret
    );

    let stored = providers::set_provider_secret(&db, &secrets, id, Some("sk-demo"))
        .unwrap()
        .unwrap();
    assert!(stored.has_secret);
    // The key lands under the same provider-scoped ref any other row uses,
    // so the runtime launch path resolves it without knowing about plugins.
    assert_eq!(
        providers::get_secret_for_provider(&db, &secrets, id)
            .unwrap()
            .as_deref(),
        Some("sk-demo")
    );
    // The declaration still owns the row: a reload refreshes the fields it
    // declares and keeps the credential.
    sync_plugin_providers(&db, &secrets, "demo.provider", &declared, true).unwrap();
    let reloaded = providers::get_provider(&db, &secrets, id).unwrap().unwrap();
    assert!(reloaded.has_secret);
    assert_eq!(reloaded.name, "Demo");

    // An empty value clears it, which is what the user's "remove key" sends.
    let cleared = providers::set_provider_secret(&db, &secrets, id, None)
        .unwrap()
        .unwrap();
    assert!(!cleared.has_secret);
    assert!(providers::get_secret_for_provider(&db, &secrets, id)
        .unwrap()
        .is_none());
    assert!(
        providers::set_provider_secret(&db, &secrets, "nope", Some("sk-x"))
            .unwrap()
            .is_none()
    );
}
#[test]
fn the_declaration_shape_is_validated() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("plugin");
    let permissions = json!(["provider.register"]);

    // An endpoint the runtime would reach must be an absolute http(s) URL.
    write_plugin(
        &root,
        declaration_manifest(
            json!([{ "id": "demo", "name": "Demo", "baseUrl": "file:///etc/passwd",
                     "models": [{ "id": "m" }] }]),
            permissions.clone(),
        ),
    );
    assert!(read_manifest_err(&root).contains("http(s) URL"));

    // Localized labels are bounded by characters, including full-width text.
    let long_localized_provider = json!([{
        "id": "demo",
        "name": "Demo",
        "category": { "en": "C".repeat(128), "zh-CN": "公".repeat(128) },
        "description": { "en": "A".repeat(280), "zh-CN": "公益".repeat(140) },
        "baseUrl": "https://api.example.com/v1",
        "models": [{ "id": "m" }]
    }]);
    write_plugin(
        &root,
        declaration_manifest(long_localized_provider, permissions.clone()),
    );
    assert!(PluginManager::read_manifest(&root).is_ok());

    write_plugin(
        &root,
        declaration_manifest(
            json!([{ "id": "demo", "name": "Demo", "category": { "en": "Community" },
                     "baseUrl": "https://api.example.com/v1", "models": [{ "id": "m" }] }]),
            permissions.clone(),
        ),
    );
    assert!(read_manifest_err(&root).contains("category must be a string or localized strings"));

    write_plugin(
        &root,
        declaration_manifest(
            json!([{ "id": "demo", "name": "Demo", "description": "公".repeat(281),
                     "baseUrl": "https://api.example.com/v1", "models": [{ "id": "m" }] }]),
            permissions.clone(),
        ),
    );
    assert!(read_manifest_err(&root).contains("description must be a string or localized strings"));

    // Dynamic discovery needs an endpoint when an API-key model list is empty.
    write_plugin(
        &root,
        declaration_manifest(
            json!([{ "id": "demo", "name": "Demo", "models": [] }]),
            permissions.clone(),
        ),
    );
    assert!(read_manifest_err(&root)
        .contains("may omit models only for an API-key provider with a baseUrl"));

    write_plugin(
        &root,
        declaration_manifest(
            json!([{ "id": "demo", "name": "Demo",
                     "models": [{ "id": "m" }, { "id": "m" }] }]),
            permissions.clone(),
        ),
    );
    assert!(read_manifest_err(&root).contains("declares model m twice"));

    // OAuth declarations require an explicit OAuth capability grant.
    write_plugin(
        &root,
        declaration_manifest(
            json!([{ "id": "demo", "name": "Demo", "authKind": "oauth",
                     "baseUrl": "https://api.example.com/v1", "models": [{ "id": "m" }] }]),
            permissions.clone(),
        ),
    );
    assert!(read_manifest_err(&root).contains("require the provider.oauth permission"));

    write_plugin(
        &root,
        declaration_manifest(
            json!([{ "id": "demo", "name": "Demo", "authKind": "oauth",
                     "baseUrl": "https://api.example.com/v1",
                     "oauth": { "loginLabel": "Continue in browser", "isSubscription": true },
                     "models": [{ "id": "m" }] }]),
            json!(["provider.register", "provider.oauth"]),
        ),
    );
    assert!(PluginManager::read_manifest(&root).is_ok());

    let oauth_permissions = json!(["provider.register", "provider.oauth"]);
    let invalid_oauth_providers = [
        (
            json!([{ "id": "demo", "name": "Demo", "authKind": "oauth",
                     "models": [{ "id": "m" }] }]),
            "requires baseUrl for OAuth",
        ),
        (
            json!([{ "id": "demo", "name": "Demo", "authKind": "api_key",
                     "baseUrl": "https://api.example.com/v1",
                     "oauth": { "loginLabel": "Continue" },
                     "models": [{ "id": "m" }] }]),
            "requires authKind oauth",
        ),
        (
            json!([{ "id": "demo", "name": "Demo", "authKind": "oauth",
                     "baseUrl": "https://api.example.com/v1", "oauth": "invalid",
                     "models": [{ "id": "m" }] }]),
            "oauth must be an object",
        ),
        (
            json!([{ "id": "demo", "name": "Demo", "authKind": "oauth",
                     "baseUrl": "https://api.example.com/v1",
                     "oauth": { "unexpected": true }, "models": [{ "id": "m" }] }]),
            "oauth has unsupported field unexpected",
        ),
        (
            json!([{ "id": "demo", "name": "Demo", "authKind": "oauth",
                     "baseUrl": "https://api.example.com/v1", "oauth": { "loginLabel": " " },
                     "models": [{ "id": "m" }] }]),
            "oauth.loginLabel must be a non-empty string",
        ),
        (
            json!([{ "id": "demo", "name": "Demo", "authKind": "oauth",
                     "baseUrl": "https://api.example.com/v1",
                     "oauth": { "isSubscription": "yes" }, "models": [{ "id": "m" }] }]),
            "oauth.isSubscription must be a boolean",
        ),
    ];
    for (providers, expected_error) in invalid_oauth_providers {
        write_plugin(
            &root,
            declaration_manifest(providers, oauth_permissions.clone()),
        );
        let error = read_manifest_err(&root);
        assert!(error.contains(expected_error), "{error}");
    }
}

/// A row id already in use by something other than this plugin cannot arise
/// through the sync itself — the id embeds the plugin id — but it can exist in
/// a database that was edited by hand or written by an older scheme. The upsert
/// would skip such a row silently, so the sync refuses instead.
#[test]
fn a_row_another_owner_holds_makes_the_sync_fail_rather_than_no_op() {
    let (_dir, db, secrets) = test_context();
    let declared = declared_providers(&manifest());
    sync_plugin_providers(&db, &secrets, "demo.provider", &declared, true).unwrap();
    let row_id = "plugin:demo.provider:demo";

    db.conn()
        .execute(
            "UPDATE providers SET owner_plugin_id = 'other.plugin' WHERE id = ?1",
            params![row_id],
        )
        .unwrap();
    let error = sync_plugin_providers(&db, &secrets, "demo.provider", &declared, true)
        .expect_err("a foreign owner must fail the sync")
        .to_string();
    assert!(error.contains("owned by plugin other.plugin"), "{error}");

    db.conn()
        .execute(
            "UPDATE providers SET owner_plugin_id = NULL WHERE id = ?1",
            params![row_id],
        )
        .unwrap();
    let error = sync_plugin_providers(&db, &secrets, "demo.provider", &declared, true)
        .expect_err("an unowned row must fail the sync")
        .to_string();
    assert!(error.contains("is not owned by"), "{error}");
    // The refused sync left the row alone rather than half-written.
    let row = providers::get_provider(&db, &secrets, row_id)
        .unwrap()
        .unwrap();
    assert_eq!(row.name, "Demo");
}

#[test]
fn startup_reconciliation_removes_a_row_whose_plugin_is_gone() {
    let (dir, db, secrets) = test_context();
    let declared = declared_providers(&manifest());
    sync_plugin_providers(&db, &secrets, "demo.provider", &declared, true).unwrap();
    let key_ref = crate::secrets::secret_ref_for_provider("plugin:demo.provider:demo");
    secrets.set(&key_ref, "sk-demo").unwrap();
    // No plugin is registered in this data directory, so the row has no owner
    // to answer for it.
    let plugins = PluginManager::new(dir.path(), MarketChannel::Official, None);
    assert_eq!(
        crate::plugins::reconcile_all(&db, &secrets, &plugins).unwrap(),
        1
    );
    assert!(
        providers::get_provider(&db, &secrets, "plugin:demo.provider:demo")
            .unwrap()
            .is_none()
    );
    assert!(!secrets.has(&key_ref));
}

#[test]
fn a_disabled_plugin_writes_its_rows_off() {
    let (_dir, db, secrets) = test_context();
    let declared = declared_providers(&manifest());
    assert_eq!(
        sync_plugin_providers(&db, &secrets, "demo.provider", &declared, false).unwrap(),
        1
    );
    assert!(
        !providers::get_provider(&db, &secrets, "plugin:demo.provider:demo")
            .unwrap()
            .unwrap()
            .enabled
    );
    // Re-enabling restores it, and is the transition no other test exercises.
    assert_eq!(
        set_plugin_providers_enabled(&db, "demo.provider", true).unwrap(),
        1
    );
    assert!(
        providers::get_provider(&db, &secrets, "plugin:demo.provider:demo")
            .unwrap()
            .unwrap()
            .enabled
    );
}

#[test]
fn a_shrinking_declaration_keeps_the_survivors() {
    let (_dir, db, secrets) = test_context();
    let two = manifest_with_providers(&["demo", "extra"]);
    sync_plugin_providers(
        &db,
        &secrets,
        "demo.provider",
        &declared_providers(&two),
        true,
    )
    .unwrap();
    let extra_key = crate::secrets::secret_ref_for_provider("plugin:demo.provider:extra");
    let demo_key = crate::secrets::secret_ref_for_provider("plugin:demo.provider:demo");
    secrets.set(&extra_key, "sk-extra").unwrap();
    secrets.set(&demo_key, "sk-demo").unwrap();

    let one = declared_providers(&manifest());
    sync_plugin_providers(&db, &secrets, "demo.provider", &one, true).unwrap();
    // Only the dropped declaration goes, with its own credential.
    assert!(
        providers::get_provider(&db, &secrets, "plugin:demo.provider:extra")
            .unwrap()
            .is_none()
    );
    assert!(!secrets.has(&extra_key));
    assert!(
        providers::get_provider(&db, &secrets, "plugin:demo.provider:demo")
            .unwrap()
            .is_some()
    );
    assert!(secrets.has(&demo_key));
}

#[test]
fn dropping_the_api_key_auth_kind_clears_the_stored_key() {
    let (_dir, db, secrets) = test_context();
    let declared = declared_providers(&manifest());
    sync_plugin_providers(&db, &secrets, "demo.provider", &declared, true).unwrap();
    let id = "plugin:demo.provider:demo";
    providers::set_provider_secret(&db, &secrets, id, Some("sk-demo")).unwrap();
    assert!(
        providers::get_provider(&db, &secrets, id)
            .unwrap()
            .unwrap()
            .has_secret
    );

    // The plugin update stops asking for a key, so the runtime must stop
    // signing with one.
    let keyless = manifest_with_auth_kind("none");
    sync_plugin_providers(
        &db,
        &secrets,
        "demo.provider",
        &declared_providers(&keyless),
        true,
    )
    .unwrap();
    let row = providers::get_provider(&db, &secrets, id).unwrap().unwrap();
    assert!(!row.has_secret);
    assert!(!secrets.has(&crate::secrets::secret_ref_for_provider(id)));
    assert!(providers::get_secret_for_provider(&db, &secrets, id)
        .unwrap()
        .is_none());
}

/// A manifest whose first model declares a reasoning menu.
fn manifest_with_thinking_levels() -> PluginManifest {
    let mut value = serde_json::to_value(manifest()).unwrap();
    value["contributes"]["providers"][0]["models"][0]["thinkingLevels"] =
        json!(["off", "low", "high"]);
    value["contributes"]["providers"][0]["models"][0]["defaultThinkingLevel"] = json!("high");
    serde_json::from_value(value).unwrap()
}

#[test]
fn declared_thinking_levels_survive_into_the_row() {
    let (_dir, db, secrets) = test_context();
    let declared = declared_providers(&manifest_with_thinking_levels());
    assert_eq!(
        declared[0].models[0].thinking_levels,
        ["off", "low", "high"]
    );
    assert_eq!(
        declared[0].models[0].default_thinking_level.as_deref(),
        Some("high")
    );
    // The second model declares nothing, so it keeps offering no menu.
    assert!(declared[0].models[1].thinking_levels.is_empty());
    assert!(declared[0].models[1].default_thinking_level.is_none());

    sync_plugin_providers(&db, &secrets, "demo.provider", &declared, true).unwrap();
    let row = &providers::list_providers(&db, &secrets, true).unwrap()[0];
    assert_eq!(row.models[0].thinking_levels, ["off", "low", "high"]);
    assert_eq!(
        row.models[0].default_thinking_level.as_deref(),
        Some("high")
    );
}

#[test]
fn declared_thinking_levels_are_normalized() {
    let mut value = serde_json::to_value(manifest()).unwrap();
    // "ultra" is not a canonical level and "low" repeats, so the stored list
    // must come back canonical and deduplicated rather than as declared.
    value["contributes"]["providers"][0]["models"][0]["thinkingLevels"] =
        json!(["low", "ultra", "low", "  high  ", 7]);
    let manifest: PluginManifest = serde_json::from_value(value).unwrap();
    let declared = declared_providers(&manifest);
    assert_eq!(declared[0].models[0].thinking_levels, ["low", "high"]);
}

#[test]
fn a_default_outside_the_declared_list_is_dropped() {
    let mut value = serde_json::to_value(manifest_with_thinking_levels()).unwrap();
    // Naming a level the model does not offer must not be stored: the runtime
    // would silently open on a different one while the row claimed otherwise.
    value["contributes"]["providers"][0]["models"][0]["defaultThinkingLevel"] = json!("max");
    let manifest: PluginManifest = serde_json::from_value(value).unwrap();
    let declared = declared_providers(&manifest);
    assert_eq!(
        declared[0].models[0].thinking_levels,
        ["off", "low", "high"]
    );
    assert!(declared[0].models[0].default_thinking_level.is_none());
}

#[test]
fn malformed_thinking_level_fields_are_rejected_by_manifest_validation() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("plugin");
    let mut value = serde_json::to_value(manifest()).unwrap();

    value["contributes"]["providers"][0]["models"][0]["thinkingLevels"] = json!("high");
    write_plugin(&root, value.clone());
    assert!(read_manifest_err(&root).contains("thinkingLevels must be an array of strings"));

    value["contributes"]["providers"][0]["models"][0]["thinkingLevels"] = json!(["high", 7]);
    write_plugin(&root, value.clone());
    assert!(read_manifest_err(&root).contains("thinkingLevels must be an array of strings"));

    value["contributes"]["providers"][0]["models"][0]["thinkingLevels"] = json!(["high"]);
    value["contributes"]["providers"][0]["models"][0]["defaultThinkingLevel"] = json!(7);
    write_plugin(&root, value);
    assert!(read_manifest_err(&root).contains("defaultThinkingLevel must be a string"));
}
