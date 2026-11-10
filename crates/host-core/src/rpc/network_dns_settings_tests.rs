use super::*;

fn open_state(dir: &Path) -> Arc<Mutex<AppState>> {
    let mut state = AppState::open(dir).unwrap();
    state.handshook = true;
    Arc::new(Mutex::new(state))
}

#[tokio::test]
async fn network_dns_defaults_and_unreadable_saved_values_never_opt_in() {
    let dir = tempfile::tempdir().unwrap();
    let state = open_state(dir.path());
    let (tx, _rx) = mpsc::unbounded_channel();
    let settings = handle_request(state.clone(), "settings.get", json!({}), tx.clone())
        .await
        .unwrap();
    assert_eq!(settings["networkDns"], json!({"mode": "system"}));

    for dns in [
        json!(true),
        json!({"mode": "unknown"}),
        json!({"mode": "doh", "serverUrl": "http://resolver.invalid/query"}),
        json!({"mode": "doh", "allowSystemFallback": "true"}),
    ] {
        state
            .lock()
            .await
            .db
            .set_setting("app", &json!({"networkDns": dns, "theme": "dark"}))
            .unwrap();
        let settings = handle_request(state.clone(), "settings.get", json!({}), tx.clone())
            .await
            .unwrap();
        assert_eq!(settings["networkDns"], json!({"mode": "system"}));
        assert_eq!(settings["theme"], "dark");
    }
}

#[tokio::test]
async fn network_dns_settings_user_path_persists_disabling_preferences_and_partial_saves() {
    let dir = tempfile::tempdir().unwrap();
    let state = open_state(dir.path());
    let (tx, _rx) = mpsc::unbounded_channel();
    handle_request(
        state.clone(),
        "settings.set",
        json!({"networkDns": {"mode": "doh"}}),
        tx.clone(),
    )
    .await
    .unwrap();
    let enabled = handle_request(state.clone(), "settings.get", json!({}), tx.clone())
        .await
        .unwrap();
    assert_eq!(
        enabled["networkDns"],
        json!({
            "mode": "doh",
            "serverUrl": "https://1.1.1.1/dns-query",
            "allowSystemFallback": false,
        })
    );

    let disabled = json!({
        "mode": "system",
        "serverUrl": "https://192.168.1.2/dns-query",
        "allowSystemFallback": true,
    });
    handle_request(
        state.clone(),
        "settings.set",
        json!({"networkDns": disabled}),
        tx.clone(),
    )
    .await
    .unwrap();
    handle_request(
        state.clone(),
        "settings.set",
        json!({"theme": "light", "providerRetryFixedDelayMs": 0}),
        tx.clone(),
    )
    .await
    .unwrap();
    drop(state);

    let reopened = open_state(dir.path());
    let saved = handle_request(reopened.clone(), "settings.get", json!({}), tx.clone())
        .await
        .unwrap();
    assert_eq!(saved["networkDns"], disabled);
    assert_eq!(saved["theme"], "light");
    assert_eq!(saved["providerRetryFixedDelayMs"], 0);
    handle_request(
        reopened.clone(),
        "settings.set",
        json!({"networkDns": null}),
        tx.clone(),
    )
    .await
    .unwrap();
    let reset = handle_request(reopened, "settings.get", json!({}), tx)
        .await
        .unwrap();
    assert_eq!(reset["networkDns"], json!({"mode": "system"}));
}

#[tokio::test]
async fn network_dns_invalid_writes_are_rejected_before_persistence() {
    let dir = tempfile::tempdir().unwrap();
    let state = open_state(dir.path());
    let (tx, _rx) = mpsc::unbounded_channel();
    let stored = json!({"networkDns": {"mode": "system"}, "theme": "dark"});
    state.lock().await.db.set_setting("app", &stored).unwrap();
    for dns in [
        json!(true),
        json!([]),
        json!({"mode": "unknown"}),
        json!({"serverUrl": 123}),
        json!({"serverUrl": "http://resolver.invalid/dns-query"}),
        json!({"serverUrl": "https://user:secret@resolver.invalid/dns-query"}),
        json!({"serverUrl": "https://resolver.invalid/dns-query#"}),
        json!({"serverUrl": "https://resolver.invalid/dns query"}),
        json!({"serverUrl": "https://resolver.invalid/{?dns}"}),
        json!({"serverUrl": "https://resolver.invalid/\\query"}),
        json!({"serverUrl": format!("https://resolver.invalid/{}", "a".repeat(2048))}),
        json!({"allowSystemFallback": "yes"}),
        json!({"mode": false}),
        json!({"serverUrl": null}),
        json!({"serverUrl": "https://resolver.invalid/\u{feff}query"}),
        json!({"allowSystemFallback": null}),
        json!({"allowSystemFallback": 1}),
    ] {
        let error = handle_request(
            state.clone(),
            "settings.set",
            json!({"networkDns": dns}),
            tx.clone(),
        )
        .await
        .expect_err("invalid DNS write must fail");
        assert_eq!(error.data.unwrap()["errorCode"], "INVALID_PARAMS");
        assert_eq!(
            state.lock().await.db.get_setting("app").unwrap(),
            Some(stored.clone())
        );
    }
}

#[tokio::test]
async fn network_dns_runtime_relay_flag_rejects_nonboolean_values() {
    let dir = tempfile::tempdir().unwrap();
    let state = open_state(dir.path());
    let (tx, _rx) = mpsc::unbounded_channel();
    let url = format!("socks5://system-auto:{}@127.0.0.1:43210", "a".repeat(64));
    for flag in [json!(null), json!("true"), json!(1), json!({})] {
        let error = handle_request(
            state.clone(),
            "network.configureSystemProxyRelay",
            json!({"url": url, "desktopDnsEnabled": flag}),
            tx.clone(),
        )
        .await
        .expect_err("runtime DNS flag must be boolean");
        assert_eq!(error.message, "desktopDnsEnabled must be a boolean");
        assert_eq!(error.data.unwrap()["errorCode"], "INVALID_PARAMS");
    }
}

#[tokio::test]
async fn network_dns_valid_writes_normalize_to_the_shared_contract() {
    let dir = tempfile::tempdir().unwrap();
    let state = open_state(dir.path());
    let (tx, _rx) = mpsc::unbounded_channel();
    for (input, expected) in [
        (json!({}), json!({"mode": "system"})),
        (json!({"mode": null}), json!({"mode": "system"})),
        (
            json!({"mode": "doh", "unrecognized": true}),
            json!({
                "mode": "doh",
                "serverUrl": "https://1.1.1.1/dns-query",
                "allowSystemFallback": false,
            }),
        ),
        (
            json!({"mode": "system", "serverUrl": " HTTPS://Resolver.Example:443 "}),
            json!({"mode": "system", "serverUrl": "https://resolver.example/"}),
        ),
        (
            json!({"mode": "doh", "serverUrl": "https://192.168.1.2/dns-query"}),
            json!({
                "mode": "doh", "serverUrl": "https://192.168.1.2/dns-query",
                "allowSystemFallback": false,
            }),
        ),
        (
            json!({"mode": "system", "allowSystemFallback": false}),
            json!({"mode": "system", "allowSystemFallback": false}),
        ),
        (
            json!({"mode": "doh", "allowSystemFallback": true}),
            json!({
                "mode": "doh", "serverUrl": "https://1.1.1.1/dns-query",
                "allowSystemFallback": true,
            }),
        ),
        (
            json!({"serverUrl": "\u{feff}https://resolver.example/dns-query\u{feff}"}),
            json!({"mode": "system", "serverUrl": "https://resolver.example/dns-query"}),
        ),
    ] {
        handle_request(
            state.clone(),
            "settings.set",
            json!({"networkDns": input}),
            tx.clone(),
        )
        .await
        .unwrap();
        let settings = handle_request(state.clone(), "settings.get", json!({}), tx.clone())
            .await
            .unwrap();
        assert_eq!(settings["networkDns"], expected, "input: {input}");
        assert_eq!(
            state.lock().await.db.get_setting("app").unwrap().unwrap()["networkDns"],
            expected
        );
    }
}
