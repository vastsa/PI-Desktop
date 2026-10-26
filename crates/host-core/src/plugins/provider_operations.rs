use super::*;
use crate::providers::ModelBinding;
use std::collections::BTreeMap;

/// Only validated manifest metadata enters this Host-owned configuration.
pub(super) fn declared_provider_operations(
    provider: &serde_json::Map<String, Value>,
) -> Option<Value> {
    let adapter = provider.get("adapter")?;
    let restrictions: BTreeMap<String, Value> = provider
        .get("models")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|model| {
            Some((
                model.get("id")?.as_str()?.trim().to_lowercase(),
                model.get("operations")?.clone(),
            ))
        })
        .collect();
    Some(json!({
        "version": 1,
        "chat": adapter.get("chat").and_then(Value::as_bool).unwrap_or(false),
        "images": adapter.get("images").and_then(Value::as_bool).unwrap_or(false),
        "models": restrictions,
    }))
}

pub(super) fn config_with_provider_operations(
    raw: &str,
    declaration: Option<&Value>,
) -> Result<String> {
    let mut config: Value = serde_json::from_str(raw)?;
    let object = config
        .as_object_mut()
        .ok_or_else(|| anyhow!("PROVIDER_CONFIG_INVALID"))?;
    if let Some(declaration) = declaration {
        object.insert("pluginAdapter".into(), declaration.clone());
    } else {
        object.remove("pluginAdapter");
    }
    Ok(serde_json::to_string(&config)?)
}

/// Project operations only for the effective bindings. Preferences cannot expand
/// manifest capabilities; newly selected ids inherit provider-wide operations.
pub(crate) fn plugin_model_operations(
    raw: &str,
    models: &[ModelBinding],
) -> Option<BTreeMap<String, Vec<String>>> {
    let config: Value = serde_json::from_str(raw).ok()?;
    let adapter = config.get("pluginAdapter")?;
    if adapter.get("version")?.as_u64()? != 1 {
        return None;
    }
    let defaults: Vec<String> = ["chat", "images"]
        .into_iter()
        .filter(|operation| adapter.get(*operation).and_then(Value::as_bool) == Some(true))
        .map(str::to_owned)
        .collect();
    Some(
        models
            .iter()
            .map(|model| {
                let restriction = adapter
                    .get("models")
                    .and_then(|entries| entries.get(model.id.trim().to_lowercase()));
                let operations = defaults
                    .iter()
                    .filter(|operation| {
                        restriction.is_none_or(|value| {
                            value.as_array().is_some_and(|items| {
                                items
                                    .iter()
                                    .any(|item| item.as_str() == Some(operation.as_str()))
                            })
                        })
                    })
                    .cloned()
                    .collect();
                (model.id.clone(), operations)
            })
            .collect(),
    )
}
