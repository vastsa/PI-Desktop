use super::*;
use serde_json::json;

fn definition() -> Value {
    json!({"version":1,"id":"gateway","name":"Gateway","baseUrl":"https://api.example.test/v1","authKind":"api_key","models":[{"id":"large"}]})
}
fn manifest(template: Value) -> PluginManifest {
    serde_json::from_value(json!({"schemaVersion":1,"id":"fixture.templates","name":"Templates","version":"1.0.0","main":"main.js","permissions":["provider.register"],"contributes":{"providerTemplates":[template]}})).unwrap()
}
#[test]
fn template_contract_rejects_untrusted_ownership_and_malformed_fields() {
    let root = tempfile::tempdir().unwrap();
    for (field, value) in [
        ("ownerPluginId", json!("attacker")),
        ("secretRef", json!("secret:other")),
        ("version", json!(2)),
        ("baseUrl", json!("https://")),
        ("models", json!([{"id":"x","maxTokens":-1}])),
    ] {
        let mut template = definition();
        template[field] = value;
        assert!(
            validate_contributions(root.path(), &manifest(template)).is_err(),
            "accepted {field}"
        );
    }
}

#[test]
fn template_contract_is_closed_at_each_nested_boundary_and_bounded() {
    let root = tempfile::tempdir().unwrap();
    validate_contributions(root.path(), &manifest(definition())).unwrap();
    for model in [
        json!({"id":"x","ownerPluginId":"other"}),
        json!({"id":"x","name":false}),
        json!({"id":"x","contextWindow":1.5}),
        json!({"id":"x","maxTokens":4294967296u64}),
        json!({"id":"x","supportsImages":"yes"}),
        json!({"id":"x","thinkingLevels":[1]}),
        json!({"id":"x","defaultThinkingLevel":false}),
        json!({"id":"x","operations":["chat"]}),
        json!({"id":"x","name":"n".repeat(129)}),
    ] {
        let mut template = definition();
        template["models"] = json!([model]);
        assert!(validate_contributions(root.path(), &manifest(template)).is_err());
    }
    for (key, value) in [
        ("version", Value::Null),
        ("authKind", json!(7)),
        ("apiStyle", json!("other")),
        ("name", json!("n".repeat(129))),
        ("baseUrl", json!("https://user:password@example.test")),
        ("baseUrl", json!("file:///private")),
        (
            "baseUrl",
            json!(format!("https://example.test/{}", "x".repeat(2048))),
        ),
        (
            "category",
            json!({"en":"Category","zh-CN":"Category","extra":"untrusted"}),
        ),
        ("adapter", json!({"version":1,"chat":true,"unknown":true})),
    ] {
        let mut template = definition();
        template[key] = value;
        assert!(
            validate_contributions(root.path(), &manifest(template)).is_err(),
            "accepted {key}"
        );
    }
    let mut duplicate = manifest(definition());
    duplicate.contributes.as_mut().unwrap()["providers"] =
        json!([{ "id":"gateway","name":"Legacy","models":[{"id":"x"}]}]);
    assert!(validate_contributions(root.path(), &duplicate).is_err());
    let mut duplicate = manifest(definition());
    duplicate.contributes.as_mut().unwrap()["providerTemplates"] =
        json!([definition(), definition()]);
    assert!(validate_contributions(root.path(), &duplicate).is_err());
}

#[test]
fn template_contract_oauth_flows_require_only_the_correct_grants() {
    let root = tempfile::tempdir().unwrap();
    let mut template = definition();
    template["authKind"] = json!("oauth");
    assert!(
        validate_contributions(root.path(), &manifest(template.clone())).is_err(),
        "custom default requires provider.oauth"
    );
    let mut custom = manifest(template.clone());
    custom.permissions.push("provider.oauth".into());
    validate_contributions(root.path(), &custom).unwrap();
    for flow in ["authorization_code", "device_code"] {
        template["oauth"] = declarative_oauth(flow);
        validate_contributions(root.path(), &manifest(template.clone())).unwrap();
        for (key, value) in [
            ("clientSecret", json!("not-allowed")),
            ("flow", json!("unknown")),
            ("clientId", json!(false)),
            ("tokenUrl", json!("https://")),
            ("scopes", json!([false])),
            ("redirectPath", json!("//evil.test")),
            ("redirectPath", json!("/../escape")),
            ("redirectPath", json!("/callback?evil")),
            ("isSubscription", json!("true")),
            ("loginLabel", json!("x".repeat(129))),
        ] {
            let mut invalid = template.clone();
            invalid["oauth"][key] = value;
            assert!(
                validate_contributions(root.path(), &manifest(invalid)).is_err(),
                "accepted oauth.{key}"
            );
        }
        let mut missing = template.clone();
        missing["oauth"].as_object_mut().unwrap().remove("tokenUrl");
        assert!(validate_contributions(root.path(), &manifest(missing)).is_err());
    }
    template["authKind"] = json!("none");
    assert!(validate_contributions(root.path(), &manifest(template)).is_err());
    let mut no_grants = manifest(definition());
    no_grants.permissions.clear();
    assert!(validate_contributions(root.path(), &no_grants).is_err());
    let mut adapter = definition();
    adapter["adapter"] = json!({"version":1,"chat":true});
    assert!(validate_contributions(root.path(), &manifest(adapter.clone())).is_err());
    let mut granted = manifest(adapter);
    granted.permissions.push("provider.inference".into());
    validate_contributions(root.path(), &granted).unwrap();
}

fn declarative_oauth(flow: &str) -> Value {
    let mut oauth = json!({"flow":flow,"clientId":"fixture","tokenUrl":"https://example.test/token","scopes":["openid"]});
    let endpoint = if flow == "authorization_code" {
        "authorizationUrl"
    } else {
        "deviceAuthorizationUrl"
    };
    oauth[endpoint] = json!("https://example.test/authorize");
    oauth
}

fn validate_oauth_template(oauth: Value) -> Result<()> {
    let root = tempfile::tempdir().unwrap();
    let mut template = definition();
    template["authKind"] = json!("oauth");
    template["oauth"] = oauth;
    let mut manifest = manifest(template);
    manifest.permissions.push("provider.oauth".into());
    validate_contributions(root.path(), &manifest)
}

#[test]
fn template_sdk_parity_raw_urls_reject_parser_normalization_and_empty_userinfo() {
    let root = tempfile::tempdir().unwrap();
    for raw in [
        "https://@example.test/v1",
        "https://example.test/a b",
        "https://example.test/a\u{feff}b",
        "https://example.test/a\\b",
        "https:example.test/v1",
        "https:///example.test/v1",
        "https://example.test/#",
        "https://example.test/\t",
    ] {
        let mut template = definition();
        template["baseUrl"] = json!(raw);
        assert!(
            validate_contributions(root.path(), &manifest(template)).is_err(),
            "accepted baseUrl {raw:?}"
        );
    }
    for raw in [
        "http://localhost:8080/v1",
        "HTTPS://example.test/v1?key=value",
        "https://example.test/a%20b",
        "https://[::1]/v1",
    ] {
        let mut template = definition();
        template["baseUrl"] = json!(raw);
        validate_contributions(root.path(), &manifest(template)).unwrap();
    }
}

#[test]
fn template_sdk_parity_oauth_endpoints_require_https() {
    for flow in ["authorization_code", "device_code"] {
        for field in [
            "tokenUrl",
            if flow == "authorization_code" {
                "authorizationUrl"
            } else {
                "deviceAuthorizationUrl"
            },
        ] {
            for raw in [
                "http://example.test/oauth",
                "https://@example.test/oauth",
                "https://example.test/a b",
                "https://example.test/a\\b",
                "https:example.test/oauth",
            ] {
                let mut oauth = declarative_oauth(flow);
                oauth[field] = json!(raw);
                assert!(
                    validate_oauth_template(oauth).is_err(),
                    "accepted {flow}.{field} {raw:?}"
                );
            }
        }
    }
}

#[test]
fn template_sdk_parity_custom_and_cross_flow_fields_are_rejected() {
    for flow in [None, Some("custom")] {
        let mut oauth = json!({"loginLabel":"Login", "isSubscription":true});
        if let Some(flow) = flow {
            oauth["flow"] = json!(flow);
        }
        validate_oauth_template(oauth.clone()).unwrap();
        for (field, value) in [
            ("clientId", json!("fixture")),
            ("tokenUrl", json!("https://example.test/token")),
            ("authorizationUrl", json!("https://example.test/auth")),
            (
                "deviceAuthorizationUrl",
                json!("https://example.test/device"),
            ),
            ("scopes", json!([])),
            ("redirectPath", json!("/callback")),
        ] {
            let mut invalid = oauth.clone();
            invalid[field] = value;
            assert!(
                validate_oauth_template(invalid).is_err(),
                "accepted custom.{field}"
            );
        }
    }
    for (flow, field, value) in [
        (
            "authorization_code",
            "deviceAuthorizationUrl",
            json!("https://example.test/device"),
        ),
        (
            "device_code",
            "authorizationUrl",
            json!("https://example.test/auth"),
        ),
        ("device_code", "redirectPath", json!("/callback")),
    ] {
        let mut oauth = declarative_oauth(flow);
        oauth[field] = value;
        assert!(
            validate_oauth_template(oauth).is_err(),
            "accepted {flow}.{field}"
        );
    }
}

#[test]
fn template_sdk_parity_scopes_are_unique_rfc6749_tokens() {
    for scopes in [
        json!(["openid", "openid"]),
        json!(["two words"]),
        json!(["quote\""]),
        json!(["slash\\"]),
        json!(["中文"]),
        json!([""]),
        json!(["x".repeat(257)]),
        json!(["\u{7f}"]),
    ] {
        let mut oauth = declarative_oauth("authorization_code");
        oauth["scopes"] = scopes;
        assert!(validate_oauth_template(oauth).is_err());
    }
    for scopes in [
        json!([]),
        json!(["!", "#[]~", "https://example.test/scope", "x".repeat(256)]),
    ] {
        let mut oauth = declarative_oauth("device_code");
        oauth["scopes"] = scopes;
        validate_oauth_template(oauth).unwrap();
    }
}

#[test]
fn template_sdk_parity_callback_paths_allow_only_safe_ascii_pathnames() {
    for path in [
        "/callback%2fescape",
        "/callback.html",
        "/callback space",
        "/中文",
        "/callback:other",
        "//callback",
        "/./callback",
        "/callback#fragment",
        "/callback?query",
        "/callback\\path",
    ] {
        let mut oauth = declarative_oauth("authorization_code");
        oauth["redirectPath"] = json!(path);
        assert!(validate_oauth_template(oauth).is_err(), "accepted {path:?}");
    }
    for path in [
        "/",
        "/callback",
        "/nested/callback_1-2/",
        "/nested//callback",
    ] {
        let mut oauth = declarative_oauth("authorization_code");
        oauth["redirectPath"] = json!(path);
        validate_oauth_template(oauth).unwrap();
    }
}

#[test]
fn template_sdk_parity_model_limits_are_positive_and_ids_trim_unique() {
    let root = tempfile::tempdir().unwrap();
    for field in ["contextWindow", "maxTokens"] {
        let mut template = definition();
        template["models"][0][field] = json!(0);
        assert!(
            validate_contributions(root.path(), &manifest(template)).is_err(),
            "accepted zero {field}"
        );
        for limit in [1u64, u32::MAX as u64] {
            let mut template = definition();
            template["models"][0][field] = json!(limit);
            validate_contributions(root.path(), &manifest(template)).unwrap();
        }
    }
    let mut template = definition();
    template["models"] = json!([{"id":" large "},{"id":"large"}]);
    assert!(validate_contributions(root.path(), &manifest(template)).is_err());
    let mut template = definition();
    template["models"] = json!([{"id":"Large"},{"id":"large"}]);
    validate_contributions(root.path(), &manifest(template)).unwrap();
}

#[test]
fn template_sdk_parity_does_not_tighten_legacy_providers() {
    let root = tempfile::tempdir().unwrap();
    let mut manifest = manifest(definition());
    let mut legacy = definition();
    legacy.as_object_mut().unwrap().remove("version");
    legacy["baseUrl"] = json!("http://example.test/path with spaces");
    legacy["models"] = json!([{"id":"model", "contextWindow":0, "maxTokens":0}]);
    manifest.contributes = Some(json!({"providers":[legacy]}));
    validate_contributions(root.path(), &manifest).unwrap();
}
