use super::*;
use serde_json::json;
use std::collections::BTreeMap;

fn test_context() -> (tempfile::TempDir, Database, SecretStore) {
    let dir = tempfile::tempdir().unwrap();
    let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
    let secrets = SecretStore::open(dir.path()).unwrap();
    (dir, db, secrets)
}

#[test]
fn reasoning_override_roundtrips_and_preserves_provider_config() {
    let (_dir, db, secrets) = test_context();
    let provider = create_provider(
        &db,
        &secrets,
        ProviderCreateInput {
            name: "Custom".into(),
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
            context_window: None,
            max_output_tokens: None,
            temperature: None,
            supports_reasoning: Some(true),
            supported_thinking_levels: Some(vec!["off".into(), "high".into()]),
        },
    )
    .unwrap();
    assert_eq!(provider.supports_reasoning, Some(true));
    assert_eq!(
        provider.supported_thinking_levels.as_deref(),
        Some(["off".to_string(), "high".to_string()].as_slice())
    );

    db.conn()
        .execute(
            "UPDATE providers
                 SET config_json = ?1
                 WHERE id = ?2",
            params![
                json!({
                    "headers": { "x-demo": "keep" },
                    "compatibility": { "supportsTools": true },
                    "custom": { "nested": 42 }
                })
                .to_string(),
                provider.id
            ],
        )
        .unwrap();

    let updated = update_provider(
        &db,
        &secrets,
        ProviderUpdateInput {
            id: provider.id.clone(),
            name: None,
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
            context_window: None,
            max_output_tokens: None,
            temperature: None,
            supports_reasoning: Some(false),
            supported_thinking_levels: Some(vec!["off".into(), "low".into()]),
            enabled: None,
        },
    )
    .unwrap()
    .unwrap();
    assert_eq!(updated.supports_reasoning, Some(false));
    assert_eq!(
        updated.supported_thinking_levels.as_deref(),
        Some(["off".to_string(), "low".to_string()].as_slice())
    );

    let raw: String = db
        .conn()
        .query_row(
            "SELECT config_json FROM providers WHERE id = ?1",
            params![provider.id],
            |row| row.get(0),
        )
        .unwrap();
    let config: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(config["headers"]["x-demo"], "keep");
    assert_eq!(config["compatibility"]["supportsTools"], true);
    assert_eq!(config["compatibility"]["supportsReasoning"], false);
    assert_eq!(
        config["compatibility"]["supportedThinkingLevels"],
        json!(["off", "low"])
    );
    assert_eq!(config["custom"]["nested"], 42);

    // An update without the field leaves the explicit override intact.
    let unchanged = update_provider(
        &db,
        &secrets,
        ProviderUpdateInput {
            id: provider.id,
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
            context_window: None,
            max_output_tokens: None,
            temperature: None,
            supports_reasoning: None,
            supported_thinking_levels: None,
            enabled: None,
        },
    )
    .unwrap()
    .unwrap();
    assert_eq!(unchanged.supports_reasoning, Some(false));
    assert_eq!(
        unchanged.supported_thinking_levels.as_deref(),
        Some(["off".to_string(), "low".to_string()].as_slice())
    );
}

#[test]
fn model_bindings_roundtrip_and_legacy_model_migrates_on_read() {
    let (_dir, db, secrets) = test_context();
    let provider = create_provider(
        &db,
        &secrets,
        ProviderCreateInput {
            name: "Multi-model".into(),
            vendor_key: None,
            provider_type: None,
            protocol: None,
            base_url: Some("https://example.test/v1".into()),
            auth_kind: Some("none".into()),
            models: Some(vec![
                ModelBinding {
                    id: "reasoning-model".into(),
                    alias: Some("pro".into()),
                    context_window_source: None,
                    max_tokens_source: None,
                    context_window: 256_000,
                    max_tokens: 16_000,
                    thinking_levels: vec!["high".into(), "medium".into()],
                    default_thinking_level: Some("medium".into()),
                    supports_images: Some(true),
                    supports_documents: None,
                    available_for_subagents: Some(true),
                    native_web_search: None,
                },
                ModelBinding {
                    id: "plain-model".into(),
                    alias: None,
                    context_window_source: None,
                    max_tokens_source: None,
                    context_window: 128_000,
                    max_tokens: 8_192,
                    thinking_levels: vec![],
                    default_thinking_level: None,
                    supports_images: None,
                    supports_documents: Some(false),
                    available_for_subagents: None,
                    native_web_search: None,
                },
            ]),
            default_model_id: None,
            secret_value: None,
            api_style: Some("chat_completions".into()),
            oauth_account_label: None,
            headers: None,
            context_window: None,
            max_output_tokens: None,
            temperature: None,
            supports_reasoning: None,
            supported_thinking_levels: None,
        },
    )
    .unwrap();
    assert_eq!(
        provider.default_model_id.as_deref(),
        Some("reasoning-model")
    );
    assert_eq!(provider.models[0].context_window, 256_000);
    assert_eq!(
        provider.models[0].default_thinking_level.as_deref(),
        Some("medium")
    );
    assert_eq!(provider.models[1].default_thinking_level, None);
    assert_eq!(provider.models[0].available_for_subagents, Some(true));
    assert_eq!(provider.models[1].available_for_subagents, None);

    let raw: String = db
        .conn()
        .query_row(
            "SELECT config_json FROM providers WHERE id = ?1",
            params![provider.id],
            |row| row.get(0),
        )
        .unwrap();
    let config: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(config["models"][0]["maxTokens"], 16_000);
    assert_eq!(config["models"][0]["alias"], "pro");
    assert!(config["models"][1].get("alias").is_none());
    assert_eq!(provider.models[0].alias.as_deref(), Some("pro"));
    // Attachment overrides are explicit configuration: an answered switch is
    // persisted, while "follow the catalog" stays absent instead of being
    // frozen into a false that a later catalog fix could not correct.
    assert_eq!(config["models"][0]["supportsImages"], true);
    assert_eq!(config["models"][0]["availableForSubagents"], true);
    assert!(config["models"][0].get("supportsDocuments").is_none());
    assert_eq!(config["models"][1]["supportsDocuments"], false);
    assert!(config["models"][1].get("availableForSubagents").is_none());
    assert!(config["models"][1].get("supportsImages").is_none());
    assert_eq!(provider.models[0].supports_images, Some(true));
    assert_eq!(provider.models[1].supports_documents, Some(false));

    let legacy = create_provider(
        &db,
        &secrets,
        ProviderCreateInput {
            name: "Legacy".into(),
            vendor_key: None,
            provider_type: None,
            protocol: None,
            base_url: None,
            auth_kind: Some("none".into()),
            models: None,
            default_model_id: Some("legacy-model".into()),
            secret_value: None,
            api_style: None,
            oauth_account_label: None,
            headers: None,
            context_window: None,
            max_output_tokens: None,
            temperature: None,
            supports_reasoning: None,
            supported_thinking_levels: None,
        },
    )
    .unwrap();
    assert_eq!(legacy.models.len(), 1);
    assert_eq!(legacy.models[0].id, "legacy-model");
    assert_eq!(legacy.models[0].context_window, DEFAULT_CONTEXT_WINDOW);
    assert_eq!(legacy.models[0].max_tokens, DEFAULT_MAX_TOKENS);
    assert!(legacy.models[0].thinking_levels.is_empty());
    assert_eq!(legacy.models[0].default_thinking_level, None);
    assert_eq!(
        config_model_bindings(
            r#"{"modelId":"config-legacy"}"#,
            None,
            "provider-under-test"
        )[0]
        .id,
        "config-legacy"
    );
}

fn binding_with_alias(id: &str, alias: Option<&str>) -> ModelBinding {
    ModelBinding {
        id: id.into(),
        alias: alias.map(str::to_string),
        context_window_source: None,
        max_tokens_source: None,
        context_window: DEFAULT_CONTEXT_WINDOW,
        max_tokens: DEFAULT_MAX_TOKENS,
        thinking_levels: Vec::new(),
        default_thinking_level: None,
        supports_images: None,
        supports_documents: None,
        available_for_subagents: None,
        native_web_search: None,
    }
}

#[test]
fn normalize_model_bindings_trims_aliases_and_drops_blank_ones() {
    let normalized = normalize_model_bindings(&[
        binding_with_alias("pro-model", Some("  pro  ")),
        binding_with_alias("empty-alias", Some("")),
        binding_with_alias("blank-alias", Some("   ")),
        binding_with_alias("no-alias", None),
    ]);
    assert_eq!(normalized[0].alias.as_deref(), Some("pro"));
    assert_eq!(normalized[1].alias, None);
    assert_eq!(normalized[2].alias, None);
    assert_eq!(normalized[3].alias, None);
}

#[test]
fn alias_survives_the_provider_config_round_trip() {
    let bindings = vec![
        binding_with_alias("pro-model", Some("  pro  ")),
        binding_with_alias("plain-model", None),
    ];
    let config = build_provider_config_json(
        None,
        None,
        Some(&bindings),
        &LimitOverrides {
            context_window: None,
            max_output_tokens: None,
            temperature: None,
        },
    )
    .unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&config).unwrap();
    assert_eq!(parsed["models"][0]["alias"], "pro");
    assert!(parsed["models"][1].get("alias").is_none());
    let restored: Vec<ModelBinding> = serde_json::from_value(parsed["models"].clone()).unwrap();
    assert_eq!(restored[0].alias.as_deref(), Some("pro"));
    assert_eq!(restored[1].alias, None);
}

#[test]
fn alias_survives_provider_create_and_update() {
    let (_dir, db, secrets) = test_context();
    let provider = create_provider(
        &db,
        &secrets,
        ProviderCreateInput {
            name: "Aliased".into(),
            vendor_key: None,
            provider_type: None,
            protocol: None,
            base_url: None,
            auth_kind: Some("none".into()),
            models: Some(vec![binding_with_alias("pro-model", Some("  pro  "))]),
            default_model_id: None,
            secret_value: None,
            api_style: None,
            oauth_account_label: None,
            headers: None,
            context_window: None,
            max_output_tokens: None,
            temperature: None,
            supports_reasoning: None,
            supported_thinking_levels: None,
        },
    )
    .unwrap();
    assert_eq!(provider.models[0].alias.as_deref(), Some("pro"));

    let updated = update_provider(
        &db,
        &secrets,
        ProviderUpdateInput {
            id: provider.id.clone(),
            name: None,
            vendor_key: None,
            provider_type: None,
            protocol: None,
            base_url: None,
            auth_kind: None,
            models: Some(vec![binding_with_alias("pro-model", Some("fast"))]),
            default_model_id: None,
            secret_value: None,
            api_style: None,
            oauth_account_label: None,
            headers: None,
            context_window: None,
            max_output_tokens: None,
            temperature: None,
            supports_reasoning: None,
            supported_thinking_levels: None,
            enabled: None,
        },
    )
    .unwrap()
    .unwrap();
    assert_eq!(updated.models[0].alias.as_deref(), Some("fast"));

    let reloaded = get_provider(&db, &secrets, &provider.id).unwrap().unwrap();
    assert_eq!(reloaded.models[0].alias.as_deref(), Some("fast"));
}

#[test]
fn alias_length_is_limited_to_sixty_characters() {
    let at_limit = binding_with_alias("model", Some(&"a".repeat(MAX_MODEL_ALIAS_CHARS)));
    assert!(validate_model_aliases(&[at_limit]).is_ok());

    let over_limit = binding_with_alias("model", Some(&"a".repeat(MAX_MODEL_ALIAS_CHARS + 1)));
    let error = validate_model_aliases(&[over_limit])
        .unwrap_err()
        .to_string();
    assert!(error.contains("MODEL_ALIAS_TOO_LONG"), "{error}");

    // Multi-byte aliases are counted in characters, not bytes.
    let multi_byte = binding_with_alias("model", Some(&"あ".repeat(MAX_MODEL_ALIAS_CHARS)));
    assert!(validate_model_aliases(&[multi_byte]).is_ok());
    let multi_byte_over =
        binding_with_alias("model", Some(&"あ".repeat(MAX_MODEL_ALIAS_CHARS + 1)));
    let error = validate_model_aliases(&[multi_byte_over])
        .unwrap_err()
        .to_string();
    assert!(error.contains("MODEL_ALIAS_TOO_LONG"), "{error}");
}

#[test]
fn over_long_alias_leaves_stored_secrets_untouched() {
    let (dir, db, secrets) = test_context();
    let over_limit = binding_with_alias("model", Some(&"a".repeat(MAX_MODEL_ALIAS_CHARS + 1)));
    let stored_bins = || {
        std::fs::read_dir(dir.path().join("secrets"))
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "bin"))
            .count()
    };

    // A rejected create must not leave a secret behind.
    let before = stored_bins();
    let error = create_provider(
        &db,
        &secrets,
        ProviderCreateInput {
            name: "Too long".into(),
            vendor_key: None,
            provider_type: None,
            protocol: None,
            base_url: None,
            auth_kind: Some("api_key_and_base_url".into()),
            models: Some(vec![over_limit.clone()]),
            default_model_id: None,
            secret_value: Some("new-secret".into()),
            api_style: None,
            oauth_account_label: None,
            headers: None,
            context_window: None,
            max_output_tokens: None,
            temperature: None,
            supports_reasoning: None,
            supported_thinking_levels: None,
        },
    )
    .unwrap_err()
    .to_string();
    assert!(error.contains("MODEL_ALIAS_TOO_LONG"), "{error}");
    assert_eq!(stored_bins(), before, "rejected create stored a secret");

    // A rejected update must not replace the stored secret.
    let provider = create_provider(
        &db,
        &secrets,
        ProviderCreateInput {
            name: "Aliased".into(),
            vendor_key: None,
            provider_type: None,
            protocol: None,
            base_url: None,
            auth_kind: Some("api_key_and_base_url".into()),
            models: None,
            default_model_id: Some("model".into()),
            secret_value: Some("old-secret".into()),
            api_style: None,
            oauth_account_label: None,
            headers: None,
            context_window: None,
            max_output_tokens: None,
            temperature: None,
            supports_reasoning: None,
            supported_thinking_levels: None,
        },
    )
    .unwrap();
    let api_key_ref = secret_ref_for_provider(&provider.id);
    assert_eq!(
        secrets.get(&api_key_ref).unwrap().as_deref(),
        Some("old-secret")
    );

    let error = update_provider(
        &db,
        &secrets,
        ProviderUpdateInput {
            id: provider.id.clone(),
            name: None,
            vendor_key: None,
            provider_type: None,
            protocol: None,
            base_url: None,
            auth_kind: None,
            models: Some(vec![over_limit]),
            default_model_id: None,
            secret_value: Some("new-secret".into()),
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
    .unwrap_err()
    .to_string();
    assert!(error.contains("MODEL_ALIAS_TOO_LONG"), "{error}");
    assert_eq!(
        secrets.get(&api_key_ref).unwrap().as_deref(),
        Some("old-secret"),
        "rejected update replaced the stored secret"
    );
}

#[test]
fn over_long_alias_is_rejected_by_the_write_paths() {
    let (_dir, db, secrets) = test_context();
    let over_limit = binding_with_alias("model", Some(&"a".repeat(MAX_MODEL_ALIAS_CHARS + 1)));
    let error = create_provider(
        &db,
        &secrets,
        ProviderCreateInput {
            name: "Too long".into(),
            vendor_key: None,
            provider_type: None,
            protocol: None,
            base_url: None,
            auth_kind: Some("none".into()),
            models: Some(vec![over_limit.clone()]),
            default_model_id: None,
            secret_value: None,
            api_style: None,
            oauth_account_label: None,
            headers: None,
            context_window: None,
            max_output_tokens: None,
            temperature: None,
            supports_reasoning: None,
            supported_thinking_levels: None,
        },
    )
    .unwrap_err()
    .to_string();
    assert!(error.contains("MODEL_ALIAS_TOO_LONG"), "{error}");

    let provider = create_provider(
        &db,
        &secrets,
        ProviderCreateInput {
            name: "Aliased".into(),
            vendor_key: None,
            provider_type: None,
            protocol: None,
            base_url: None,
            auth_kind: Some("none".into()),
            models: None,
            default_model_id: Some("model".into()),
            secret_value: None,
            api_style: None,
            oauth_account_label: None,
            headers: None,
            context_window: None,
            max_output_tokens: None,
            temperature: None,
            supports_reasoning: None,
            supported_thinking_levels: None,
        },
    )
    .unwrap();
    let error = update_provider(
        &db,
        &secrets,
        ProviderUpdateInput {
            id: provider.id,
            name: None,
            vendor_key: None,
            provider_type: None,
            protocol: None,
            base_url: None,
            auth_kind: None,
            models: Some(vec![over_limit]),
            default_model_id: None,
            secret_value: None,
            api_style: None,
            oauth_account_label: None,
            headers: None,
            context_window: None,
            max_output_tokens: None,
            temperature: None,
            supports_reasoning: None,
            supported_thinking_levels: None,
            enabled: None,
        },
    )
    .unwrap_err()
    .to_string();
    assert!(error.contains("MODEL_ALIAS_TOO_LONG"), "{error}");
}

#[test]
fn limit_overrides_roundtrip_and_clear_with_zero() {
    let (_dir, db, secrets) = test_context();
    let provider = create_provider(
        &db,
        &secrets,
        ProviderCreateInput {
            name: "Limits".into(),
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
            context_window: Some(200_000),
            max_output_tokens: Some(32_000),
            temperature: Some(0.7),
            supports_reasoning: None,
            supported_thinking_levels: None,
        },
    )
    .unwrap();
    assert_eq!(provider.context_window, Some(200_000));
    assert_eq!(provider.max_output_tokens, Some(32_000));
    assert_eq!(provider.temperature, Some(0.7));

    // Absent fields leave overrides intact; zero / non-positive clears.
    let updated = update_provider(
        &db,
        &secrets,
        ProviderUpdateInput {
            id: provider.id.clone(),
            name: None,
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
            context_window: Some(131_072),
            max_output_tokens: None,
            temperature: Some(0.0),
            supports_reasoning: None,
            supported_thinking_levels: None,
            enabled: None,
        },
    )
    .unwrap()
    .unwrap();
    assert_eq!(updated.context_window, Some(131_072));
    assert_eq!(updated.max_output_tokens, Some(32_000));
    assert_eq!(updated.temperature, None);
}

#[test]
fn provider_without_override_omits_reasoning_capability() {
    let (_dir, db, secrets) = test_context();
    let provider = create_provider(
        &db,
        &secrets,
        ProviderCreateInput {
            name: "No override".into(),
            vendor_key: None,
            provider_type: None,
            protocol: None,
            base_url: None,
            auth_kind: Some("none".into()),
            models: None,
            default_model_id: None,
            secret_value: None,
            api_style: None,
            oauth_account_label: None,
            headers: None,
            context_window: None,
            max_output_tokens: None,
            temperature: None,
            supports_reasoning: None,
            supported_thinking_levels: None,
        },
    )
    .unwrap();
    assert_eq!(provider.supports_reasoning, None);
    assert_eq!(provider.supported_thinking_levels, None);
    let wire = serde_json::to_value(provider).unwrap();
    assert!(wire.get("supportsReasoning").is_none());
    assert!(wire.get("supportedThinkingLevels").is_none());
}

#[test]
fn thinking_levels_override_normalizes_and_can_clear() {
    let (_dir, db, secrets) = test_context();
    let provider = create_provider(
        &db,
        &secrets,
        ProviderCreateInput {
            name: "Sparse".into(),
            vendor_key: None,
            provider_type: None,
            protocol: None,
            base_url: None,
            auth_kind: Some("none".into()),
            models: None,
            default_model_id: Some("mimo-v2.5".into()),
            secret_value: None,
            api_style: None,
            oauth_account_label: None,
            headers: None,
            context_window: None,
            max_output_tokens: None,
            temperature: None,
            supports_reasoning: Some(true),
            supported_thinking_levels: Some(vec![
                "high".into(),
                "off".into(),
                "bogus".into(),
                "high".into(),
            ]),
        },
    )
    .unwrap();
    // Keep first-seen order after filtering invalid entries.
    assert_eq!(
        provider.supported_thinking_levels.as_deref(),
        Some(["high".to_string(), "off".to_string()].as_slice())
    );

    let cleared = update_provider(
        &db,
        &secrets,
        ProviderUpdateInput {
            id: provider.id.clone(),
            name: None,
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
            context_window: None,
            max_output_tokens: None,
            temperature: None,
            supports_reasoning: None,
            supported_thinking_levels: Some(vec![]),
            enabled: None,
        },
    )
    .unwrap()
    .unwrap();
    assert_eq!(cleared.supported_thinking_levels, None);

    let raw: String = db
        .conn()
        .query_row(
            "SELECT config_json FROM providers WHERE id = ?1",
            params![provider.id],
            |row| row.get(0),
        )
        .unwrap();
    let config: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert!(config["compatibility"]
        .get("supportedThinkingLevels")
        .is_none());
}

#[test]
fn discovered_models_are_cached_without_overwriting_user_rows() {
    let (_dir, db, secrets) = test_context();
    let provider = create_provider(
        &db,
        &secrets,
        ProviderCreateInput {
            name: "Catalog".into(),
            vendor_key: None,
            provider_type: None,
            protocol: None,
            base_url: Some("http://localhost:11434/v1".into()),
            auth_kind: Some("none".into()),
            models: None,
            default_model_id: Some("model-a".into()),
            secret_value: None,
            api_style: Some("chat_completions".into()),
            oauth_account_label: None,
            headers: None,
            context_window: None,
            max_output_tokens: None,
            temperature: None,
            supports_reasoning: None,
            supported_thinking_levels: None,
        },
    )
    .unwrap();
    db.conn()
        .execute(
            "INSERT INTO models (
                    provider_id, model_id, display_name, source,
                    capabilities_json, updated_at
                 ) VALUES (?1, 'user-model', 'Custom label', 'user', '[\"tools\"]', ?2)",
            params![provider.id, now_ms()],
        )
        .unwrap();

    let changed = cache_discovered_models(
        &db,
        &provider.id,
        &[
            DiscoveredModelInput {
                model_id: "model-b".into(),
                display_name: "Beta".into(),
                capabilities: vec!["text".into()],
                context_window: None,
            },
            DiscoveredModelInput {
                model_id: "model-a".into(),
                display_name: "Alpha".into(),
                capabilities: vec!["text".into()],
                context_window: Some(128_000),
            },
        ],
    )
    .unwrap();
    assert_eq!(changed, 2);

    cache_discovered_models(
        &db,
        &provider.id,
        &[
            DiscoveredModelInput {
                model_id: "model-a".into(),
                display_name: "Alpha updated".into(),
                capabilities: vec!["text".into(), "reasoning".into()],
                context_window: Some(256_000),
            },
            DiscoveredModelInput {
                model_id: "user-model".into(),
                display_name: "Remote label".into(),
                capabilities: vec!["text".into()],
                context_window: None,
            },
        ],
    )
    .unwrap();

    let models = list_models(&db, Some(&provider.id)).unwrap();
    assert_eq!(models.len(), 3);
    let alpha = models
        .iter()
        .find(|model| model.model_id == "model-a")
        .unwrap();
    assert_eq!(alpha.display_name, "Alpha updated");
    assert_eq!(alpha.capabilities, vec!["text", "reasoning"]);
    assert_eq!(alpha.context_window, Some(256_000));
    assert!(models.iter().any(|model| model.model_id == "model-b"));
    let custom = models
        .iter()
        .find(|model| model.model_id == "user-model")
        .unwrap();
    assert_eq!(custom.display_name, "Custom label");
    assert_eq!(custom.source, "user");
    assert_eq!(custom.capabilities, vec!["tools"]);
}

#[test]
fn an_oauth_credential_alone_makes_the_provider_ready() {
    let (_dir, db, secrets) = test_context();
    let provider = create_provider(
        &db,
        &secrets,
        ProviderCreateInput {
            name: "Claude".into(),
            vendor_key: Some("anthropic".into()),
            provider_type: None,
            protocol: None,
            base_url: None,
            auth_kind: Some("oauth".into()),
            models: None,
            default_model_id: Some("claude-sonnet-4-5".into()),
            secret_value: None,
            api_style: Some("anthropic_messages".into()),
            oauth_account_label: Some("dev@example.com".into()),
            headers: None,
            context_window: None,
            max_output_tokens: None,
            temperature: None,
            supports_reasoning: None,
            supported_thinking_levels: None,
        },
    )
    .unwrap();
    // No API key was ever pasted, so the row is not ready yet.
    assert!(!provider.has_secret);
    assert!(!provider.has_oauth);
    assert_eq!(
        provider.oauth_account_label.as_deref(),
        Some("dev@example.com")
    );

    let oauth_ref = secret_ref_for_provider_oauth(&provider.id);
    secrets.set(&oauth_ref, "{\"type\":\"oauth\"}").unwrap();

    // Every readiness check in the app keys off `has_secret`, so a vendor
    // account must light it up exactly like a pasted key would.
    let stored = get_provider(&db, &secrets, &provider.id).unwrap().unwrap();
    assert!(stored.has_secret);
    assert!(stored.has_oauth);

    // Updating an OAuth-only row must not stamp an api_key ref onto it.
    let renamed = update_provider(
        &db,
        &secrets,
        ProviderUpdateInput {
            id: provider.id.clone(),
            name: Some("Claude Max".into()),
            vendor_key: None,
            provider_type: None,
            protocol: None,
            base_url: None,
            auth_kind: None,
            models: None,
            default_model_id: None,
            secret_value: None,
            api_style: None,
            oauth_account_label: Some(String::new()),
            headers: None,
            context_window: None,
            max_output_tokens: None,
            temperature: None,
            supports_reasoning: None,
            supported_thinking_levels: None,
            enabled: None,
        },
    )
    .unwrap()
    .unwrap();
    // An empty label clears the badge, which is what logout sends.
    assert_eq!(renamed.oauth_account_label, None);
    assert!(renamed.has_oauth);
    let stored_ref: Option<String> = db
        .conn()
        .query_row(
            "SELECT secret_ref FROM providers WHERE id = ?1",
            params![provider.id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(stored_ref, None);

    // Deleting the row takes the OAuth credential with it, or a re-created
    // provider could inherit the previous account's refresh token.
    assert!(delete_provider(&db, &secrets, &provider.id).unwrap());
    assert!(!secrets.has(&oauth_ref));
    let meta: i64 = db
        .conn()
        .query_row(
            "SELECT COUNT(*) FROM secrets_meta WHERE secret_ref = ?1",
            params![oauth_ref],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(meta, 0);
}

#[test]
fn a_provider_can_hold_both_an_api_key_and_a_vendor_account() {
    let (_dir, db, secrets) = test_context();
    let provider = create_provider(
        &db,
        &secrets,
        ProviderCreateInput {
            name: "Both".into(),
            vendor_key: Some("anthropic".into()),
            provider_type: None,
            protocol: None,
            base_url: None,
            auth_kind: Some("api_key_and_base_url".into()),
            models: None,
            default_model_id: None,
            secret_value: Some("sk-ant-api".into()),
            api_style: None,
            oauth_account_label: None,
            headers: None,
            context_window: None,
            max_output_tokens: None,
            temperature: None,
            supports_reasoning: None,
            supported_thinking_levels: None,
        },
    )
    .unwrap();
    assert!(provider.has_secret);
    assert!(!provider.has_oauth);

    secrets
        .set(&secret_ref_for_provider_oauth(&provider.id), "{}")
        .unwrap();
    let stored = get_provider(&db, &secrets, &provider.id).unwrap().unwrap();
    assert!(stored.has_oauth);
    // The API key read path must keep returning the key, never the OAuth blob.
    assert_eq!(
        get_secret_for_provider(&db, &secrets, &provider.id).unwrap(),
        Some("sk-ant-api".to_string())
    );
}

fn header_map(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
    pairs
        .iter()
        .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
        .collect()
}

fn blank_update(id: String) -> ProviderUpdateInput {
    ProviderUpdateInput {
        id,
        name: None,
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
        context_window: None,
        max_output_tokens: None,
        temperature: None,
        supports_reasoning: None,
        supported_thinking_levels: None,
        enabled: None,
    }
}

#[test]
fn headers_roundtrip_migrate_user_agent_clear_and_reject() {
    let (_dir, db, secrets) = test_context();
    let provider = create_provider(
        &db,
        &secrets,
        ProviderCreateInput {
            name: "Headers".into(),
            vendor_key: None,
            provider_type: None,
            protocol: None,
            base_url: Some("https://example.test/v1".into()),
            auth_kind: Some("none".into()),
            models: None,
            default_model_id: Some("model-1".into()),
            secret_value: None,
            api_style: None,
            oauth_account_label: None,
            headers: Some(header_map(&[
                ("  User-Agent  ", "  CustomAgent/1.0  "),
                ("X-Gateway", "alpha"),
            ])),
            context_window: None,
            max_output_tokens: None,
            temperature: None,
            supports_reasoning: None,
            supported_thinking_levels: None,
        },
    )
    .unwrap();
    assert_eq!(
        provider.headers,
        Some(header_map(&[
            ("User-Agent", "CustomAgent/1.0"),
            ("X-Gateway", "alpha")
        ]))
    );

    let raw: String = db
        .conn()
        .query_row(
            "SELECT config_json FROM providers WHERE id = ?1",
            params![provider.id],
            |row| row.get(0),
        )
        .unwrap();
    let config: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(config["headers"]["User-Agent"], "CustomAgent/1.0");
    assert_eq!(config["headers"]["X-Gateway"], "alpha");
    assert!(config.get("userAgent").is_none());

    db.conn()
        .execute(
            "UPDATE providers SET config_json = ?1 WHERE id = ?2",
            params![
                json!({ "userAgent": "  Legacy/2  ", "headers": { "X-Keep": "1" } }).to_string(),
                provider.id
            ],
        )
        .unwrap();
    let migrated = get_provider(&db, &secrets, &provider.id).unwrap().unwrap();
    assert_eq!(
        migrated.headers,
        Some(header_map(&[("User-Agent", "Legacy/2"), ("X-Keep", "1")]))
    );

    let cleared = update_provider(
        &db,
        &secrets,
        ProviderUpdateInput {
            headers: Some(BTreeMap::new()),
            ..blank_update(provider.id.clone())
        },
    )
    .unwrap()
    .unwrap();
    assert_eq!(cleared.headers, None);
    let cleared_raw: String = db
        .conn()
        .query_row(
            "SELECT config_json FROM providers WHERE id = ?1",
            params![provider.id],
            |row| row.get(0),
        )
        .unwrap();
    let cleared_config: serde_json::Value = serde_json::from_str(&cleared_raw).unwrap();
    assert!(cleared_config.get("headers").is_none());
    assert!(cleared_config.get("userAgent").is_none());

    let injected = update_provider(
        &db,
        &secrets,
        ProviderUpdateInput {
            headers: Some(header_map(&[("X-Custom", "bad\r\nX-Injected: 1")])),
            ..blank_update(provider.id.clone())
        },
    );
    assert!(injected.is_err());
    assert!(injected
        .unwrap_err()
        .to_string()
        .contains("HEADERS_INVALID"));

    let reserved = update_provider(
        &db,
        &secrets,
        ProviderUpdateInput {
            headers: Some(header_map(&[("Authorization", "Bearer secret")])),
            ..blank_update(provider.id)
        },
    );
    assert!(reserved.is_err());
    assert!(reserved.unwrap_err().to_string().contains("reserved"));
}

fn binding_with_limits(id: &str, context_window: u32, max_tokens: u32) -> ModelBinding {
    ModelBinding {
        id: id.into(),
        alias: None,
        context_window_source: None,
        max_tokens_source: None,
        context_window,
        max_tokens,
        thinking_levels: Vec::new(),
        default_thinking_level: None,
        supports_images: None,
        supports_documents: None,
        available_for_subagents: None,
        native_web_search: None,
    }
}

/// The stored array is the only place a provider's model list lives, and an
/// external edit of the row is one of its writers. Reading it must cost the
/// entry that no longer parses, never its siblings: the reported failure was a
/// record whose second binding had lost `maxTokens`, after which the whole
/// array was discarded and the provider read back as one legacy default model
/// (issue #784).
#[test]
fn a_stored_array_survives_an_entry_that_lost_a_field() {
    let (_dir, db, secrets) = test_context();
    let provider = create_provider(
        &db,
        &secrets,
        ProviderCreateInput {
            name: "Stored array".into(),
            vendor_key: None,
            provider_type: None,
            protocol: None,
            base_url: None,
            auth_kind: Some("none".into()),
            models: Some(vec![
                binding_with_limits("alpha", 128_000, 8_192),
                binding_with_limits("beta", 256_000, 16_000),
                binding_with_limits("gamma", 64_000, 4_096),
            ]),
            default_model_id: Some("alpha".into()),
            secret_value: None,
            api_style: None,
            oauth_account_label: None,
            headers: None,
            context_window: None,
            max_output_tokens: None,
            temperature: None,
            supports_reasoning: None,
            supported_thinking_levels: None,
        },
    )
    .unwrap();
    assert_eq!(provider.models.len(), 3);

    let stored_config = |db: &Database, id: &str| -> serde_json::Value {
        let raw: String = db
            .conn()
            .query_row(
                "SELECT config_json FROM providers WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .unwrap();
        serde_json::from_str(&raw).unwrap()
    };
    let write_config = |db: &Database, id: &str, config: &serde_json::Value| {
        db.conn()
            .execute(
                "UPDATE providers SET config_json = ?1 WHERE id = ?2",
                params![config.to_string(), id],
            )
            .unwrap();
    };
    let model_ids = |provider: &ProviderPublic| -> Vec<String> {
        provider.models.iter().map(|m| m.id.clone()).collect()
    };

    // The report's own step: delete one binding's `maxTokens` and read again.
    let mut config = stored_config(&db, &provider.id);
    config["models"][1]
        .as_object_mut()
        .unwrap()
        .remove("maxTokens");
    write_config(&db, &provider.id, &config);
    let read_back = get_provider(&db, &secrets, &provider.id).unwrap().unwrap();
    assert_eq!(model_ids(&read_back), ["alpha", "beta", "gamma"]);
    // The absent key reads as zero, which the existing normalisation seeds.
    assert_eq!(read_back.models[1].max_tokens, DEFAULT_MAX_TOKENS);
    assert_eq!(read_back.models[1].context_window, 256_000);

    // Restoring the field restores the value, as the report's last row says.
    config["models"][1]["maxTokens"] = json!(16_000);
    write_config(&db, &provider.id, &config);
    let restored = get_provider(&db, &secrets, &provider.id).unwrap().unwrap();
    assert_eq!(model_ids(&restored), ["alpha", "beta", "gamma"]);
    assert_eq!(restored.models[1].max_tokens, 16_000);

    // An entry that no longer matches the schema costs itself, not the array.
    config["models"][2] = json!({
        "id": "gamma",
        "contextWindow": "not-a-number",
        "maxTokens": 4_096,
    });
    write_config(&db, &provider.id, &config);
    let damaged = get_provider(&db, &secrets, &provider.id).unwrap().unwrap();
    assert_eq!(model_ids(&damaged), ["alpha", "beta"]);
}
#[test]
fn degraded_model_array_cannot_be_overwritten_by_update() {
    let (_dir, db, secrets) = test_context();
    let provider = create_provider(
        &db,
        &secrets,
        ProviderCreateInput {
            name: "Protected array".into(),
            vendor_key: None,
            provider_type: None,
            protocol: None,
            base_url: Some("https://example.test/v1".into()),
            auth_kind: Some("api_key_and_base_url".into()),
            models: Some(vec![binding_with_limits("alpha", 128_000, 8_192)]),
            default_model_id: Some("alpha".into()),
            secret_value: Some("old-secret".into()),
            api_style: None,
            oauth_account_label: None,
            headers: None,
            context_window: None,
            max_output_tokens: None,
            temperature: None,
            supports_reasoning: None,
            supported_thinking_levels: None,
        },
    )
    .unwrap();
    let mut config: serde_json::Value = db
        .conn()
        .query_row(
            "SELECT config_json FROM providers WHERE id = ?1",
            params![provider.id],
            |row| row.get::<_, String>(0),
        )
        .map(|raw| serde_json::from_str(&raw).unwrap())
        .unwrap();
    config["models"][0]["contextWindow"] = json!("not-a-number");
    db.conn()
        .execute(
            "UPDATE providers SET config_json = ?1 WHERE id = ?2",
            params![config.to_string(), provider.id],
        )
        .unwrap();
    let before: String = db
        .conn()
        .query_row(
            "SELECT config_json FROM providers WHERE id = ?1",
            params![provider.id],
            |row| row.get(0),
        )
        .unwrap();

    let error = update_provider(
        &db,
        &secrets,
        ProviderUpdateInput {
            models: Some(vec![binding_with_limits("alpha", 128_000, 8_192)]),
            secret_value: Some("new-secret".into()),
            ..blank_update(provider.id.clone())
        },
    )
    .unwrap_err()
    .to_string();
    assert!(error.starts_with("MODEL_BINDINGS_DEGRADED:"), "{error}");

    let after: String = db
        .conn()
        .query_row(
            "SELECT config_json FROM providers WHERE id = ?1",
            params![provider.id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(after, before);
    assert_eq!(
        secrets
            .get(&secret_ref_for_provider(&provider.id))
            .unwrap()
            .as_deref(),
        Some("old-secret")
    );
}

#[test]
fn header_values_fold_fullwidth_and_reject_non_latin1() {
    let (_dir, db, secrets) = test_context();
    let headers = BTreeMap::from([
        ("X-Title".to_string(), "PI\u{3000}Desktop".to_string()),
        ("X-Key".to_string(), "1234567\u{FF10}".to_string()),
    ]);
    let provider = create_provider(
        &db,
        &secrets,
        ProviderCreateInput {
            name: "Custom".into(),
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
            headers: Some(headers),
            context_window: None,
            max_output_tokens: None,
            temperature: None,
            supports_reasoning: None,
            supported_thinking_levels: None,
        },
    )
    .unwrap();
    let stored = provider.headers.unwrap();
    assert_eq!(stored["X-Title"], "PI Desktop");
    assert_eq!(stored["X-Key"], "12345670");

    // A value with no ASCII counterpart is refused at the boundary and names
    // the character undici would have thrown on.
    let err = create_provider(
        &db,
        &secrets,
        ProviderCreateInput {
            name: "Star".into(),
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
            headers: Some(BTreeMap::from([(
                "X-Title".to_string(),
                "abc\u{661F}".to_string(),
            )])),
            context_window: None,
            max_output_tokens: None,
            temperature: None,
            supports_reasoning: None,
            supported_thinking_levels: None,
        },
    )
    .unwrap_err()
    .to_string();
    assert!(err.contains("HEADERS_INVALID"), "{err}");
    assert!(err.contains("U+661F"), "{err}");
    assert!(err.contains("character index 3"), "{err}");

    // A control character is the same class of failure — it never reaches a
    // header either — so it is named too.
    let err = normalize_one_header("X-Title", "ab\u{0}cd")
        .unwrap_err()
        .to_string();
    assert!(err.contains("U+0000 at character index 2"), "{err}");

    // A character above U+00FF is the fault wherever it sits, and the reported
    // index counts code units exactly as undici would: a surrogate pair can
    // never sit before the first fault, because it is one.
    let err = normalize_one_header("X-Title", "\u{1F44D}abc")
        .unwrap_err()
        .to_string();
    assert!(err.contains("character index 0"), "{err}");

    // Trim matches what JavaScript trims, so the host accepts a value the
    // editor showed as clean: a pasted byte-order mark is whitespace to both,
    // and U+0085 is whitespace to neither (it travels as Latin-1).
    assert_eq!(
        normalize_one_header("X-Title", "\u{FEFF}pi-desktop\u{FEFF}").unwrap(),
        Some(("X-Title".to_string(), "pi-desktop".to_string()))
    );
    assert_eq!(
        normalize_one_header("X-Title", "\u{85}abc").unwrap(),
        Some(("X-Title".to_string(), "\u{85}abc".to_string()))
    );

    // A value that is only the ideographic space folds to nothing, and an
    // unnamed row is still absent rather than a missing-name error.
    assert_eq!(normalize_one_header("X-Title", "\u{3000}").unwrap(), None);
    assert_eq!(normalize_one_header("", "\u{3000}").unwrap(), None);
    assert_eq!(
        normalize_one_header("X-Title", "\u{FF10}").unwrap(),
        Some(("X-Title".to_string(), "0".to_string()))
    );

    // Folding shrinks bytes, so a fullwidth value that was over the bound
    // (4096 bytes, `MAX_HEADER_VALUE_BYTES`) becomes storable — the one input
    // class this change newly accepts.
    let long_fullwidth = "\u{FF41}".repeat(4096);
    assert!(normalize_one_header("X-Title", &long_fullwidth)
        .unwrap()
        .is_some());
    let long_ascii = "a".repeat(4097);
    let err = normalize_one_header("X-Title", &long_ascii)
        .unwrap_err()
        .to_string();
    assert!(err.contains("header value is too long"), "{err}");

    // A store written before the rule existed is sanitized on read: fullwidth
    // folds, and the row that cannot travel is dropped rather than thrown.
    db.conn()
        .execute(
            "UPDATE providers SET config_json = ?1 WHERE id = ?2",
            params![
                json!({ "headers": { "x-legacy": "\u{FF11}\u{FF12}\u{FF13}", "x-cjk": "星" } })
                    .to_string(),
                provider.id
            ],
        )
        .unwrap();
    let read = get_provider(&db, &secrets, &provider.id).unwrap().unwrap();
    let read = read.headers.unwrap();
    assert_eq!(read["x-legacy"], "123");
    assert!(!read.contains_key("x-cjk"));
}

#[test]
fn provider_api_keys_fold_fullwidth_on_write_and_read() {
    let (_dir, db, secrets) = test_context();
    let provider = create_provider(
        &db,
        &secrets,
        ProviderCreateInput {
            name: "Custom".into(),
            vendor_key: None,
            provider_type: None,
            protocol: None,
            base_url: None,
            auth_kind: Some("api_key".into()),
            models: None,
            default_model_id: Some("model-1".into()),
            secret_value: Some("sk-\u{FF10}\u{FF11}".into()),
            api_style: None,
            oauth_account_label: None,
            headers: None,
            context_window: None,
            max_output_tokens: None,
            temperature: None,
            supports_reasoning: None,
            supported_thinking_levels: None,
        },
    )
    .unwrap();

    // create/update store what they were handed (config-sync and the renderer
    // both rely on that), so the fold has to hold on the read accessor — which
    // is the only path outbound requests take.
    assert_eq!(
        secrets
            .get(&secret_ref_for_provider(&provider.id))
            .unwrap()
            .as_deref(),
        Some("sk-\u{FF10}\u{FF11}")
    );
    assert_eq!(
        get_secret_for_provider(&db, &secrets, &provider.id)
            .unwrap()
            .as_deref(),
        Some("sk-01")
    );

    // The settings save path folds on write too.
    set_provider_secret(
        &db,
        &secrets,
        &provider.id,
        Some("\u{FF53}\u{FF4B}-\u{FF11}"),
    )
    .unwrap();
    assert_eq!(
        get_secret_for_provider(&db, &secrets, &provider.id)
            .unwrap()
            .as_deref(),
        Some("sk-1")
    );
}

#[test]
fn sync_payloads_keep_only_storable_headers() {
    // A peer on an older build, or a backup taken before the header rule was
    // tightened, can hand us rows this build refuses. Dropping them at the sync
    // boundary is what keeps one stale row from failing a whole revision, and
    // it is the same set `config_headers` drops when a store is read.
    let mut payload = json!({
        "name": "Custom",
        "headers": {
            "X-Title": "PI\u{3000}Desktop",
            "X-Key": "1234567\u{FF10}",
            "X-CJK": "星",
            "Authorization": "Bearer secret"
        }
    });
    retain_storable_headers(&mut payload);
    assert_eq!(payload["headers"]["X-Title"], "PI Desktop");
    assert_eq!(payload["headers"]["X-Key"], "12345670");
    assert!(payload["headers"].get("X-CJK").is_none());
    assert!(payload["headers"].get("Authorization").is_none());
    // The write path that aborted the revision can no longer refuse it.
    let headers: BTreeMap<String, String> =
        serde_json::from_value(payload["headers"].clone()).unwrap();
    assert!(normalize_headers_input(&headers).is_ok());

    // Every row unusable: the key goes away instead of storing an empty map.
    let mut payload = json!({ "headers": { "X-CJK": "星" } });
    retain_storable_headers(&mut payload);
    assert!(payload.get("headers").is_none());

    // A payload without headers, and one that is not an object, are untouched.
    let mut payload = json!({ "name": "Custom" });
    retain_storable_headers(&mut payload);
    assert_eq!(payload, json!({ "name": "Custom" }));
    let mut payload = json!("not an object");
    retain_storable_headers(&mut payload);
    assert_eq!(payload, json!("not an object"));

    // A row dropped here is also invisible to the read path, so a local store
    // holding it behaves the same before and after this runs.
    let raw = BTreeMap::from([("x-cjk".to_string(), "星".to_string())]);
    assert!(storable_headers(&raw).is_empty());
}
