use super::*;

pub(crate) const PROVIDER_SELECT: &str =
    "SELECT id, name, vendor_key, type, protocol, enabled, base_url, auth_kind, secret_ref,
            default_model_id, api_style, config_json, created_at, updated_at
     FROM providers";

pub(crate) const CANONICAL_THINKING_LEVELS: &[&str] =
    &["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const DEFAULT_CONTEXT_WINDOW: u32 = 128_000;
const DEFAULT_MAX_TOKENS: u32 = 8_192;

pub(crate) fn normalize_model_bindings(bindings: &[ModelBinding]) -> Vec<ModelBinding> {
    bindings
        .iter()
        .filter_map(|binding| {
            let id = binding.id.trim();
            if id.is_empty() {
                return None;
            }
            let thinking_levels = normalize_thinking_levels(&binding.thinking_levels);
            let default_thinking_level = binding
                .default_thinking_level
                .as_deref()
                .filter(|level| thinking_levels.iter().any(|item| item == level))
                .map(str::to_string)
                .or_else(|| thinking_levels.first().cloned());
            Some(ModelBinding {
                id: id.to_string(),
                alias: binding
                    .alias
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string),
                context_window: if binding.context_window == 0 {
                    DEFAULT_CONTEXT_WINDOW
                } else {
                    binding.context_window
                },
                max_tokens: if binding.max_tokens == 0 {
                    DEFAULT_MAX_TOKENS
                } else {
                    binding.max_tokens
                },
                thinking_levels,
                default_thinking_level,
                supports_images: binding.supports_images,
                supports_documents: binding.supports_documents,
                available_for_subagents: binding.available_for_subagents,
            })
        })
        .collect()
}

fn legacy_model_binding(model_id: Option<String>) -> Vec<ModelBinding> {
    model_id
        .filter(|id| !id.trim().is_empty())
        .map(|id| {
            vec![ModelBinding {
                id: id.trim().to_string(),
                alias: None,
                context_window: DEFAULT_CONTEXT_WINDOW,
                max_tokens: DEFAULT_MAX_TOKENS,
                thinking_levels: Vec::new(),
                default_thinking_level: None,
                supports_images: None,
                supports_documents: None,
                available_for_subagents: None,
            }]
        })
        .unwrap_or_default()
}

pub(crate) fn config_model_bindings(
    raw: &str,
    legacy_model_id: Option<String>,
) -> Vec<ModelBinding> {
    let legacy_model_id = legacy_model_id.or_else(|| {
        config_value(raw).and_then(|value| value.get("modelId")?.as_str().map(str::to_string))
    });
    let parsed = config_value(raw)
        .and_then(|value| value.get("models").cloned())
        .and_then(|value| serde_json::from_value::<Vec<ModelBinding>>(value).ok())
        .map(|bindings| normalize_model_bindings(&bindings))
        .unwrap_or_default();
    if parsed.is_empty() {
        legacy_model_binding(legacy_model_id)
    } else {
        parsed
    }
}

pub(crate) fn config_with_model_bindings(raw: &str, bindings: &[ModelBinding]) -> Result<String> {
    let mut config = ensure_config_object(raw)?;
    config["models"] = serde_json::to_value(normalize_model_bindings(bindings))?;
    Ok(config.to_string())
}

pub(crate) fn config_thinking_levels_override(raw: &str) -> Option<Vec<String>> {
    let levels = config_value(raw)?
        .get("compatibility")?
        .get("supportedThinkingLevels")?
        .as_array()
        .cloned()?;
    let parsed: Vec<String> = levels
        .into_iter()
        .filter_map(|value| value.as_str().map(str::to_string))
        .collect();
    let normalized = normalize_thinking_levels(&parsed);
    if normalized.is_empty() {
        None
    } else {
        Some(normalized)
    }
}

pub fn list_models(db: &Database, provider_id: Option<&str>) -> Result<Vec<ModelCatalogItem>> {
    let (sql, bind_provider) = match provider_id {
        Some(id) => (
            "SELECT provider_id, model_id, display_name, source,
                capabilities_json, context_window
         FROM models
         WHERE provider_id = ?1
         ORDER BY display_name COLLATE NOCASE, model_id",
            Some(id),
        ),
        None => (
            "SELECT provider_id, model_id, display_name, source,
                capabilities_json, context_window
         FROM models
         ORDER BY provider_id, display_name COLLATE NOCASE, model_id",
            None,
        ),
    };
    let mut stmt = db.conn().prepare_cached(sql)?;
    let parse = |row: &rusqlite::Row<'_>| -> rusqlite::Result<ModelCatalogItem> {
        let raw_capabilities: String = row.get(4)?;
        let capabilities = serde_json::from_str(&raw_capabilities).unwrap_or_default();
        Ok(ModelCatalogItem {
            provider_id: row.get(0)?,
            model_id: row.get(1)?,
            display_name: row.get(2)?,
            source: row.get(3)?,
            capabilities,
            context_window: row
                .get::<_, Option<i64>>(5)?
                .and_then(|value| u32::try_from(value).ok()),
        })
    };
    let rows = if let Some(id) = bind_provider {
        stmt.query_map(params![id], parse)?
    } else {
        stmt.query_map([], parse)?
    };
    Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
}

/// Merge live discovery results into the durable catalog cache. User-created
/// rows are authoritative and stale cache remains available if discovery fails.
pub fn cache_discovered_models(
    db: &Database,
    provider_id: &str,
    models: &[DiscoveredModelInput],
) -> Result<usize> {
    let tx = db.conn().unchecked_transaction()?;
    let now = now_ms();
    let mut changed = 0;
    {
        let mut stmt = tx.prepare_cached(
            "INSERT INTO models (
            provider_id, model_id, display_name, source,
            capabilities_json, context_window, updated_at
         ) VALUES (?1, ?2, ?3, 'discovered', ?4, ?5, ?6)
         ON CONFLICT(provider_id, model_id) DO UPDATE SET
            display_name = excluded.display_name,
            capabilities_json = excluded.capabilities_json,
            context_window = excluded.context_window,
            updated_at = excluded.updated_at
         WHERE models.source != 'user'",
        )?;
        for model in models {
            let model_id = model.model_id.trim();
            if model_id.is_empty() {
                continue;
            }
            let display_name = model.display_name.trim();
            let display_name = if display_name.is_empty() {
                model_id
            } else {
                display_name
            };
            changed += stmt.execute(params![
                provider_id,
                model_id,
                display_name,
                serde_json::to_string(&model.capabilities)?,
                model.context_window,
                now,
            ])?;
        }
    }
    tx.commit()?;
    Ok(changed)
}
