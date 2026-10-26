use super::{anyhow, bail, validation::require_permission, PluginManifest, Result, Value};

pub(crate) fn validate_declared_provider_oauth(
    id: &str,
    provider: &serde_json::Map<String, Value>,
    auth_kind: &str,
    manifest: &PluginManifest,
) -> Result<()> {
    if let Some(adapter) = provider.get("adapter") {
        require_permission(manifest, "provider.inference", "Provider adapters")?;
        let adapter = adapter
            .as_object()
            .ok_or_else(|| anyhow!("PLUGIN_INVALID: provider {id} adapter must be an object"))?;
        if adapter.get("version").and_then(Value::as_u64) != Some(1)
            || !["chat", "images"]
                .iter()
                .any(|key| adapter.get(*key).and_then(Value::as_bool) == Some(true))
            || ["chat", "images"]
                .iter()
                .any(|key| adapter.get(*key).is_some_and(|v| !v.is_boolean()))
            || adapter
                .keys()
                .any(|key| !["version", "chat", "images"].contains(&key.as_str()))
        {
            bail!("PLUGIN_INVALID: provider {id} adapter must declare version 1 and chat and/or images");
        }
    }
    if let Some(models) = provider.get("models").and_then(Value::as_array) {
        for model in models {
            if let Some(operations) = model.get("operations") {
                let operations = operations
                    .as_array()
                    .ok_or_else(|| anyhow!("PLUGIN_INVALID: model operations must be an array"))?;
                let adapter = provider.get("adapter").and_then(Value::as_object);
                if operations.is_empty()
                    || operations.len() > 2
                    || operations.iter().enumerate().any(|(i, operation)| {
                        let Some(operation) = operation.as_str() else {
                            return true;
                        };
                        !["chat", "images"].contains(&operation)
                            || adapter
                                .and_then(|a| a.get(operation))
                                .and_then(Value::as_bool)
                                != Some(true)
                            || operations[..i]
                                .iter()
                                .any(|other| other.as_str() == Some(operation))
                    })
                {
                    bail!("PLUGIN_INVALID: model operations must restrict declared adapter capabilities");
                }
            }
        }
    }
    if auth_kind == "oauth" {
        require_permission(manifest, "provider.oauth", "OAuth providers")?;
        if provider.get("baseUrl").and_then(Value::as_str).is_none() {
            bail!("PLUGIN_INVALID: provider {id} requires baseUrl for OAuth");
        }
    }

    let Some(oauth) = provider.get("oauth") else {
        return Ok(());
    };
    if auth_kind != "oauth" {
        bail!("PLUGIN_INVALID: provider {id} oauth metadata requires authKind oauth");
    }
    let oauth = oauth
        .as_object()
        .ok_or_else(|| anyhow!("PLUGIN_INVALID: provider {id} oauth must be an object"))?;
    if let Some(field) = oauth
        .keys()
        .find(|key| key.as_str() != "loginLabel" && key.as_str() != "isSubscription")
    {
        bail!("PLUGIN_INVALID: provider {id} oauth has unsupported field {field}");
    }
    if let Some(login_label) = oauth.get("loginLabel") {
        if login_label
            .as_str()
            .map(str::trim)
            .filter(|value| !value.is_empty() && value.encode_utf16().count() <= 128)
            .is_none()
        {
            bail!(
                "PLUGIN_INVALID: provider {id} oauth.loginLabel must be a non-empty string of at most 128 characters"
            );
        }
    }
    if oauth
        .get("isSubscription")
        .is_some_and(|value| !value.is_boolean())
    {
        bail!("PLUGIN_INVALID: provider {id} oauth.isSubscription must be a boolean");
    }
    Ok(())
}

#[cfg(test)]
mod inference_tests {
    use super::*;
    use serde_json::json;

    fn validate(adapter: Value, permissions: Value, operations: Option<Value>) -> Result<()> {
        let manifest: PluginManifest = serde_json::from_value(json!({
            "schemaVersion": 1, "id": "fixture.inference", "name": "Fixture",
            "version": "1.0.0", "main": "main.js", "permissions": permissions,
        }))?;
        let mut provider = serde_json::Map::new();
        provider.insert("adapter".into(), adapter);
        if let Some(operations) = operations {
            provider.insert(
                "models".into(),
                json!([{ "id": "image", "operations": operations }]),
            );
        }
        validate_declared_provider_oauth("gateway", &provider, "none", &manifest)
    }

    #[test]
    fn manifest_entry_point_requires_both_adapter_grants() -> Result<()> {
        let root = tempfile::tempdir()?;
        std::fs::write(
            root.path().join("main.js"),
            "export const providerAdapters = {};",
        )?;
        for permissions in [
            json!(["provider.register"]),
            json!(["provider.inference"]),
            json!(["provider.register", "provider.inference"]),
        ] {
            let expected = permissions
                .as_array()
                .is_some_and(|grants| grants.len() == 2);
            let manifest = json!({
                "schemaVersion": 1, "id": "fixture.inference", "name": "Fixture",
                "version": "1.0.0", "main": "main.js", "permissions": permissions,
                "contributes": { "providers": [{
                    "id": "gateway", "name": "Gateway", "authKind": "none",
                    "adapter": { "version": 1, "chat": true, "images": true },
                    "models": [{ "id": "image", "operations": ["images"] }],
                }] },
            });
            std::fs::write(root.path().join("manifest.json"), manifest.to_string())?;
            assert_eq!(
                super::super::PluginManager::read_manifest(root.path()).is_ok(),
                expected
            );
        }
        Ok(())
    }

    #[test]
    fn adapter_requires_explicit_inference_grant() {
        let result = validate(
            json!({"version": 1, "chat": true}),
            json!(["provider.register"]),
            None,
        );
        assert!(result.is_err_and(|error| error.to_string().contains("provider.inference")));
    }

    #[test]
    fn validates_version_operation_flags_and_model_restrictions() -> Result<()> {
        let permissions = json!(["provider.register", "provider.inference"]);
        validate(
            json!({"version": 1, "images": true}),
            permissions.clone(),
            Some(json!(["images"])),
        )?;
        for adapter in [
            json!({"version": 2, "chat": true}),
            json!({"version": 1}),
            json!({"version": 1, "chat": "yes"}),
            json!({"version": 1, "chat": true, "executeTools": true}),
        ] {
            assert!(validate(adapter, permissions.clone(), None).is_err());
        }
        assert!(validate(
            json!({"version": 1, "images": true}),
            permissions,
            Some(json!(["chat"]))
        )
        .is_err());
        Ok(())
    }
}
