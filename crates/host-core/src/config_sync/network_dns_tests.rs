use super::*;

#[test]
fn network_dns_is_not_exported_or_imported_and_retry_preferences_stay_portable() {
    let dir = tempfile::tempdir().unwrap();
    let mut source = AppState::open(&dir.path().join("source")).unwrap();
    let dns = json!({
        "mode": "doh", "serverUrl": "https://192.168.1.2/dns-query",
        "allowSystemFallback": false,
    });
    let portable = json!({
        "theme": "dark", "infiniteProviderRetry": false,
        "providerRetryMaxAttempts": 0, "providerRetryInitialDelayMs": 2500,
        "providerRetryFixedDelayMs": 0,
    });
    let mut source_settings = portable.clone();
    source_settings["networkDns"] = dns;
    source.db.set_setting("app", &source_settings).unwrap();
    let selection = domains::CategorySelection(
        domains::ALL_DOMAINS.iter().map(|domain| {
            ((*domain).to_string(), *domain == domains::DOMAIN_APPLICATION)
        }).collect(),
    );
    let snapshot = domains::capture(
        &mut source, &VaultKey([0; 32]), &selection, false,
        &BTreeMap::new(), &domains::ProjectIdentityOverrides::default(),
    ).unwrap();
    assert_eq!(snapshot.manifest.entities.len(), 1);
    assert_eq!(snapshot.manifest.entities[0].payload, portable);
    assert!(!domains::PORTABLE_APPLICATION_FIELDS.contains(&"networkDns"));
    assert!(domains::adapter_for(domains::DOMAIN_APPLICATION)
        .unwrap().local_overlays.contains(&"native DNS"));

    let target_path = dir.path().join("target");
    let mut target = AppState::open(&target_path).unwrap();
    let local_dns = json!({
        "mode": "system", "serverUrl": "https://10.0.0.2/dns-query",
        "allowSystemFallback": true,
    });
    target.db.set_setting("app", &json!({"networkDns": local_dns, "theme": "light"})).unwrap();
    let (header, _) = create_vault("dns-fixture-password", "dns-fixture-vault").unwrap();
    let mut config = config_from_input(None, &json!({
        "endpoint": "https://s3.example.test", "region": "us-east-1",
        "bucket": "dns-fixture", "accessKeyId": "fixture", "deviceLabel": "Fixture"
    }), header).unwrap();
    let bundle: PendingBundle = serde_json::from_value(json!({
        "manifest": {"format": REVISION_FORMAT, "version": 1, "revisionId": "dns-fixture",
            "parents": [], "createdAt": "", "entities": [], "resourceIds": []},
        "approvals": [], "remoteRevisionId": "dns-fixture"
    })).unwrap();
    let mut entity = snapshot.manifest.entities[0].clone();
    // An older or hostile peer cannot import even a syntactically valid DNS opt-in.
    entity.payload["networkDns"] = json!({"mode": "doh", "serverUrl": "https://203.0.113.2/query"});
    apply_entity(&mut target, &mut config, &bundle, &entity).unwrap();
    drop(target);
    let target = AppState::open(&target_path).unwrap();
    let saved = target.db.get_setting("app").unwrap().unwrap();
    assert_eq!(saved["networkDns"], local_dns);
    for (field, value) in portable.as_object().unwrap() {
        assert_eq!(&saved[field], value, "{field}");
    }
}
