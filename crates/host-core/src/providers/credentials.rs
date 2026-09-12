use super::*;

pub(crate) fn config_value(raw: &str) -> Option<serde_json::Value> {
    serde_json::from_str::<serde_json::Value>(raw).ok()
}

pub(crate) fn config_reasoning_override(raw: &str) -> Option<bool> {
    config_value(raw).and_then(|v| v.get("compatibility")?.get("supportsReasoning")?.as_bool())
}

pub(crate) fn config_oauth_account_label(raw: &str) -> Option<String> {
    config_value(raw)
        .and_then(|v| Some(v.get("oauth")?.get("accountLabel")?.as_str()?.to_string()))
        .filter(|label| !label.is_empty())
}

pub(crate) fn config_headers(raw: &str) -> Option<BTreeMap<String, String>> {
    let config = config_value(raw)?;
    let mut collected = BTreeMap::new();
    if let Some(object) = config.get("headers").and_then(|value| value.as_object()) {
        for (key, value) in object {
            if let Some(text) = value.as_str() {
                collected.insert(key.clone(), text.to_string());
            }
        }
    }
    if let Some(user_agent) = config.get("userAgent").and_then(|value| value.as_str()) {
        let has_user_agent = collected
            .keys()
            .any(|key| key.eq_ignore_ascii_case("user-agent"));
        if !has_user_agent {
            collected.insert("User-Agent".into(), user_agent.to_string());
        }
    }
    let mut by_lower: BTreeMap<String, (String, String)> = BTreeMap::new();
    for (key, value) in collected {
        if let Ok(Some((normalized_key, normalized_value))) = normalize_one_header(&key, &value) {
            by_lower.insert(
                normalized_key.to_ascii_lowercase(),
                (normalized_key, normalized_value),
            );
        }
    }
    let out: BTreeMap<_, _> = by_lower
        .into_iter()
        .take(MAX_HEADERS)
        .map(|(_, pair)| pair)
        .collect();
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

/// Set or clear optional headers. An empty map clears them and drops leftover `userAgent`.
pub(crate) fn config_with_headers(raw: &str, headers: &BTreeMap<String, String>) -> Result<String> {
    let mut config = ensure_config_object(raw)?;
    let object = config
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("provider config_json must be a JSON object"))?;
    object.remove("userAgent");
    let normalized = normalize_headers_input(headers)?;
    if normalized.is_empty() {
        object.remove("headers");
    } else {
        object.insert("headers".into(), serde_json::to_value(normalized)?);
    }
    Ok(config.to_string())
}

pub(crate) fn ensure_config_object(raw: &str) -> Result<serde_json::Value> {
    let config: serde_json::Value = serde_json::from_str(raw)
        .map_err(|e| anyhow::anyhow!("provider config_json is invalid: {e}"))?;
    if !config.is_object() {
        return Err(anyhow::anyhow!(
            "provider config_json must be a JSON object"
        ));
    }
    Ok(config)
}

pub(crate) fn compatibility_object(
    config: &mut serde_json::Value,
) -> Result<&mut serde_json::Map<String, serde_json::Value>> {
    let object = config
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("provider config_json must be a JSON object"))?;
    let compatibility = object
        .entry("compatibility")
        .or_insert_with(|| serde_json::json!({}));
    compatibility
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("provider config_json.compatibility must be a JSON object"))
}

pub(crate) fn oauth_object(
    config: &mut serde_json::Value,
) -> Result<&mut serde_json::Map<String, serde_json::Value>> {
    let object = config
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("provider config_json must be a JSON object"))?;
    let oauth = object
        .entry("oauth")
        .or_insert_with(|| serde_json::json!({}));
    oauth
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("provider config_json.oauth must be a JSON object"))
}

/// Set or clear the non-secret signed-in account label. An empty string clears
/// it, which is what logout writes.
pub(crate) fn config_with_oauth_account_label(raw: &str, label: &str) -> Result<String> {
    let mut config = ensure_config_object(raw)?;
    let oauth = oauth_object(&mut config)?;
    if label.is_empty() {
        oauth.remove("accountLabel");
    } else {
        oauth.insert("accountLabel".into(), serde_json::json!(label));
    }
    Ok(config.to_string())
}

pub(crate) fn limits_object(
    config: &mut serde_json::Value,
) -> Result<&mut serde_json::Map<String, serde_json::Value>> {
    let object = config
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("provider config_json must be a JSON object"))?;
    let limits = object
        .entry("limits")
        .or_insert_with(|| serde_json::json!({}));
    limits
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("provider config_json.limits must be a JSON object"))
}

/// Set or clear a `limits.<key>` override. `None` removes the key so runtime
/// defaults apply again.
pub(crate) fn config_with_limit(
    raw: &str,
    key: &str,
    value: Option<serde_json::Value>,
) -> Result<String> {
    let mut config = ensure_config_object(raw)?;
    let limits = limits_object(&mut config)?;
    match value {
        Some(value) => {
            limits.insert(key.to_string(), value);
        }
        None => {
            limits.remove(key);
        }
    }
    Ok(config.to_string())
}

/// UI clear sentinel: zero context/output tokens or a non-positive temperature
/// drop the override instead of storing a meaningless value.
pub(crate) fn limit_u32_value(value: u32) -> Option<serde_json::Value> {
    (value > 0).then(|| serde_json::json!(value))
}

pub(crate) fn limit_temperature_value(value: f64) -> Option<serde_json::Value> {
    (value > 0.0 && value.is_finite()).then(|| serde_json::json!(value))
}

pub(crate) fn config_with_reasoning_override(raw: &str, value: bool) -> Result<String> {
    let mut config = ensure_config_object(raw)?;
    compatibility_object(&mut config)?.insert("supportsReasoning".into(), serde_json::json!(value));
    Ok(config.to_string())
}

pub(crate) fn config_with_thinking_levels_override(
    raw: &str,
    levels: Option<&[String]>,
) -> Result<String> {
    let mut config = ensure_config_object(raw)?;
    let compatibility = compatibility_object(&mut config)?;
    match levels {
        Some(levels) => {
            let normalized = normalize_thinking_levels(levels);
            if normalized.is_empty() {
                compatibility.remove("supportedThinkingLevels");
            } else {
                compatibility.insert(
                    "supportedThinkingLevels".into(),
                    serde_json::json!(normalized),
                );
            }
        }
        None => {
            compatibility.remove("supportedThinkingLevels");
        }
    }
    Ok(config.to_string())
}

pub(crate) struct LimitOverrides {
    pub(crate) context_window: Option<u32>,
    pub(crate) max_output_tokens: Option<u32>,
    pub(crate) temperature: Option<f64>,
}

pub(crate) fn build_provider_config_json(
    supports_reasoning: Option<bool>,
    supported_thinking_levels: Option<&[String]>,
    models: Option<&[ModelBinding]>,
    limits: &LimitOverrides,
) -> Result<String> {
    let mut config = serde_json::json!({});
    if let Some(value) = supports_reasoning {
        compatibility_object(&mut config)?
            .insert("supportsReasoning".into(), serde_json::json!(value));
    }
    if let Some(levels) = supported_thinking_levels {
        let normalized = normalize_thinking_levels(levels);
        if !normalized.is_empty() {
            compatibility_object(&mut config)?.insert(
                "supportedThinkingLevels".into(),
                serde_json::json!(normalized),
            );
        }
    }
    if let Some(bindings) = models {
        config["models"] = serde_json::to_value(normalize_model_bindings(bindings))?;
    }
    if let Some(value) = limits.context_window.and_then(limit_u32_value) {
        limits_object(&mut config)?.insert("contextWindow".into(), value);
    }
    if let Some(value) = limits.max_output_tokens.and_then(limit_u32_value) {
        limits_object(&mut config)?.insert("maxOutputTokens".into(), value);
    }
    if let Some(value) = limits.temperature.and_then(limit_temperature_value) {
        limits_object(&mut config)?.insert("temperature".into(), value);
    }
    Ok(config.to_string())
}

pub(crate) fn merge_provider_config_overrides(
    raw: &str,
    supports_reasoning: Option<bool>,
    supported_thinking_levels: Option<Option<Vec<String>>>,
    models: Option<Option<Vec<ModelBinding>>>,
    limits: &LimitOverrides,
) -> Result<Option<String>> {
    if supports_reasoning.is_none()
        && supported_thinking_levels.is_none()
        && models.is_none()
        && limits.context_window.is_none()
        && limits.max_output_tokens.is_none()
        && limits.temperature.is_none()
    {
        return Ok(None);
    }
    let mut next = raw.to_string();
    if let Some(value) = supports_reasoning {
        next = config_with_reasoning_override(&next, value)?;
    }
    if let Some(levels) = supported_thinking_levels {
        next = config_with_thinking_levels_override(&next, levels.as_deref())?;
    }
    if let Some(bindings) = models {
        next = config_with_model_bindings(&next, bindings.as_deref().unwrap_or_default())?;
    }
    if let Some(value) = limits.context_window {
        next = config_with_limit(&next, "contextWindow", limit_u32_value(value))?;
    }
    if let Some(value) = limits.max_output_tokens {
        next = config_with_limit(&next, "maxOutputTokens", limit_u32_value(value))?;
    }
    if let Some(value) = limits.temperature {
        next = config_with_limit(&next, "temperature", limit_temperature_value(value))?;
    }
    Ok(Some(next))
}

pub(crate) fn upsert_secret_meta(
    db: &Database,
    secret_ref: &str,
    provider_id: &str,
    backend: &str,
) -> Result<()> {
    db.conn()
        .prepare_cached(
            "INSERT INTO secrets_meta (secret_ref, owner_kind, owner_id, kind, backend, updated_at)
             VALUES (?1, 'provider', ?2, 'api_key', ?3, ?4)
             ON CONFLICT(secret_ref) DO UPDATE SET
               updated_at = excluded.updated_at, backend = excluded.backend",
        )?
        .execute(params![secret_ref, provider_id, backend, now_ms()])?;
    Ok(())
}

pub fn get_secret_for_provider(
    db: &Database,
    secrets: &SecretStore,
    provider_id: &str,
) -> Result<Option<String>> {
    let secret_ref: Option<String> = db
        .conn()
        .prepare_cached("SELECT secret_ref FROM providers WHERE id = ?1")?
        .query_row(params![provider_id], |row| row.get(0))
        .optional()?
        .flatten();
    if let Some(sref) = secret_ref {
        secrets.get(&sref)
    } else {
        Ok(None)
    }
}
