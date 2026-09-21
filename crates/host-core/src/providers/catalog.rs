use super::*;

pub(crate) const PROVIDER_SELECT: &str =
    "SELECT id, name, vendor_key, type, protocol, enabled, base_url, auth_kind, secret_ref,
            default_model_id, api_style, config_json, created_at, updated_at, owner_plugin_id
     FROM providers";

pub(crate) const CANONICAL_THINKING_LEVELS: &[&str] =
    &["off", "minimal", "low", "medium", "high", "xhigh", "max"];
/// Recognised context-window provenance markers. Anything else is dropped so a
/// row always falls back to the documented rule instead of a third state no
/// reader understands.
const CONTEXT_WINDOW_SOURCES: &[&str] = &["catalog", "user"];
pub(crate) const DEFAULT_CONTEXT_WINDOW: u32 = 128_000;
pub(crate) const DEFAULT_MAX_TOKENS: u32 = 8_192;

fn normalize_context_window_source(value: Option<&str>) -> Option<String> {
    let trimmed = value?.trim().to_ascii_lowercase();
    CONTEXT_WINDOW_SOURCES
        .contains(&trimmed.as_str())
        .then_some(trimmed)
}

fn default_thinking_level_allowed(level: &str, thinking_levels: &[String]) -> bool {
    if level == "omit" {
        return thinking_levels.iter().any(|item| item != "off");
    }
    thinking_levels.iter().any(|item| item == level)
}

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
                .map(str::trim)
                .filter(|level| default_thinking_level_allowed(level, &thinking_levels))
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
                context_window_source: normalize_context_window_source(
                    binding.context_window_source.as_deref(),
                ),
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
                native_web_search: binding.native_web_search,
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
                context_window_source: None,
                context_window: DEFAULT_CONTEXT_WINDOW,
                max_tokens: DEFAULT_MAX_TOKENS,
                thinking_levels: Vec::new(),
                default_thinking_level: None,
                supports_images: None,
                supports_documents: None,
                available_for_subagents: None,
                native_web_search: None,
            }]
        })
        .unwrap_or_default()
}

/// What `config_json.models` holds.
enum StoredModels {
    /// The key is absent — a record written before bindings existed.
    Absent,
    /// The key is present but is not an array, so there is nothing to decode.
    NotAnArray,
    /// The array, decoded one entry at a time.
    Entries {
        /// Entries that decoded, in stored order.
        bindings: Vec<ModelBinding>,
        /// `(index, reason)` for every entry that did not, so a reader can
        /// name the exact entry instead of only counting the loss.
        unreadable: Vec<(usize, String)>,
    },
}

/// Decode `config_json.models` one entry at a time.
///
/// The array is the only place a provider's model list lives and it is written
/// by more than one hand — a settings save, a plugin declaration, and an
/// external edit of the stored row. Decoding it as a single `Vec<ModelBinding>`
/// let one entry that no longer matched the schema discard every sibling, after
/// which the provider read back as one legacy default model with nothing said
/// about why (issue #784). Each entry is therefore decoded on its own and the
/// ones that fail are collected for the caller to report.
fn decode_stored_models(raw: &str) -> StoredModels {
    let Some(models) = config_value(raw).and_then(|value| value.get("models").cloned()) else {
        return StoredModels::Absent;
    };
    let Some(entries) = models.as_array() else {
        return StoredModels::NotAnArray;
    };
    let mut bindings = Vec::with_capacity(entries.len());
    let mut unreadable = Vec::new();
    for (index, entry) in entries.iter().enumerate() {
        match serde_json::from_value::<ModelBinding>(entry.clone()) {
            Ok(binding) => bindings.push(binding),
            Err(error) => unreadable.push((index, error.to_string())),
        }
    }
    StoredModels::Entries {
        bindings,
        unreadable,
    }
}

/// Read the provider's model bindings out of `config_json`.
///
/// An absent array, an empty one, and one whose every entry was unreadable all
/// leave the single legacy binding, so a provider stays selectable whatever its
/// stored shape. Only the third case is reported: an empty array is a legal
/// state, and an absent one is a record that predates bindings.
pub(crate) fn config_model_bindings(
    raw: &str,
    legacy_model_id: Option<String>,
    provider_id: &str,
) -> Vec<ModelBinding> {
    let legacy_model_id = legacy_model_id.or_else(|| {
        config_value(raw).and_then(|value| value.get("modelId")?.as_str().map(str::to_string))
    });
    match decode_stored_models(raw) {
        StoredModels::Entries {
            bindings,
            unreadable,
        } => {
            for (index, reason) in &unreadable {
                tracing::warn!(
                    %provider_id,
                    index,
                    %reason,
                    "skipping an unreadable model binding"
                );
            }
            let bindings = normalize_model_bindings(&bindings);
            if bindings.is_empty() {
                legacy_model_binding(legacy_model_id)
            } else {
                bindings
            }
        }
        StoredModels::NotAnArray => {
            tracing::warn!(
                %provider_id,
                "config_json.models is not an array; reading the legacy binding"
            );
            legacy_model_binding(legacy_model_id)
        }
        StoredModels::Absent => legacy_model_binding(legacy_model_id),
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

#[cfg(test)]
mod tests {
    use super::*;

    fn binding(id: &str, context_window: u32) -> ModelBinding {
        ModelBinding {
            id: id.to_string(),
            alias: None,
            context_window,
            context_window_source: None,
            max_tokens: DEFAULT_MAX_TOKENS,
            thinking_levels: Vec::new(),
            default_thinking_level: None,
            supports_images: None,
            supports_documents: None,
            available_for_subagents: None,
            native_web_search: None,
        }
    }

    /// Every read names the provider it came from: a warning that does not is
    /// not locatable, which is half of what issue #784 reports.
    fn read(raw: &str) -> Vec<ModelBinding> {
        config_model_bindings(raw, None, "provider-under-test")
    }

    /// The settings surface round-trips a provider through `config_json`, so a
    /// marker the store drops would silently turn an inherited catalog value
    /// into a frozen snapshot of its own.
    #[test]
    fn a_catalog_sourced_binding_survives_the_config_round_trip() {
        let raw = r#"{"models":[{"id":"terra","contextWindow":1048576,"maxTokens":64000,
            "contextWindowSource":"catalog"}]}"#;
        let saved = config_with_model_bindings("{}", &read(raw)).unwrap();
        let value: serde_json::Value = serde_json::from_str(&saved).unwrap();
        assert_eq!(value["models"][0]["contextWindowSource"], "catalog");
        assert_eq!(
            read(&saved)[0].context_window_source.as_deref(),
            Some("catalog")
        );

        let mut user_binding = binding("terra", 128_000);
        user_binding.context_window_source = Some("user".to_string());
        let saved = config_with_model_bindings("{}", &[user_binding]).unwrap();
        assert_eq!(
            read(&saved)[0].context_window_source.as_deref(),
            Some("user")
        );
    }

    /// Records written before the marker name no source. They stay `None` so
    /// every reader applies one documented rule instead of guessing.
    #[test]
    fn a_binding_without_a_source_stays_unmarked() {
        let bindings =
            read(r#"{"models":[{"id":"legacy","contextWindow":128000,"maxTokens":8192}]}"#);
        assert_eq!(bindings[0].context_window_source, None);
        let saved = config_with_model_bindings("{}", &bindings).unwrap();
        let value: serde_json::Value = serde_json::from_str(&saved).unwrap();
        assert!(value["models"][0].get("contextWindowSource").is_none());
    }

    /// An unrecognised marker is not a third state: it is dropped so the
    /// historical rule keeps applying to that row.
    #[test]
    fn an_unknown_source_is_dropped_instead_of_persisted() {
        let bindings = read(
            r#"{"models":[{"id":"odd","contextWindow":256000,"maxTokens":8192,
                "contextWindowSource":"derived"}]}"#,
        );
        assert_eq!(bindings[0].context_window_source, None);
    }

    /// The zero-value normalisation is what keeps a freshly added model from
    /// persisting a window of `0`; the source marker must not disturb it.
    #[test]
    fn zero_limits_still_fall_back_to_the_generic_defaults() {
        let normalized = normalize_model_bindings(&[binding("terra", 0)]);
        assert_eq!(normalized[0].context_window, DEFAULT_CONTEXT_WINDOW);
        assert_eq!(normalized[0].max_tokens, DEFAULT_MAX_TOKENS);
    }

    #[test]
    fn omit_default_survives_on_reasoning_bindings_only() {
        let mut reasoning = binding("r", DEFAULT_CONTEXT_WINDOW);
        reasoning.thinking_levels = vec!["high".into(), "medium".into()];
        reasoning.default_thinking_level = Some("omit".into());
        let mut off_only = binding("plain", DEFAULT_CONTEXT_WINDOW);
        off_only.thinking_levels = vec!["off".into()];
        off_only.default_thinking_level = Some("omit".into());
        let normalized = normalize_model_bindings(&[reasoning, off_only]);
        assert_eq!(
            normalized[0].default_thinking_level.as_deref(),
            Some("omit")
        );
        assert_eq!(normalized[1].default_thinking_level.as_deref(), Some("off"));
    }

    /// A binding that omits its limits is one binding, not a broken array: the
    /// absent key reads as zero and the zero normalisation already in place
    /// seeds the generic default. This is the reported failure — a stored array
    /// whose second entry lost `maxTokens` used to read back as one legacy
    /// default model (issue #784).
    #[test]
    fn a_binding_without_limits_keeps_its_siblings() {
        let bindings = read(
            r#"{"models":[
                {"id":"no-limits"},
                {"id":"explicit","contextWindow":200000,"maxTokens":4096}
            ]}"#,
        );
        assert_eq!(bindings.len(), 2);
        assert_eq!(bindings[0].id, "no-limits");
        assert_eq!(bindings[0].context_window, DEFAULT_CONTEXT_WINDOW);
        assert_eq!(bindings[0].max_tokens, DEFAULT_MAX_TOKENS);
        assert_eq!(bindings[1].id, "explicit");
        assert_eq!(bindings[1].context_window, 200_000);
        assert_eq!(bindings[1].max_tokens, 4_096);
    }

    /// An entry that no longer matches the schema costs itself, not the array:
    /// the readable entries survive in their stored order.
    #[test]
    fn an_unreadable_binding_costs_only_itself() {
        let bindings = read(
            r#"{"models":[
                {"id":"first","contextWindow":1000,"maxTokens":100},
                {"id":"second","maxTokens":"not-a-number"},
                {"id":"third","contextWindow":3000,"maxTokens":300}
            ]}"#,
        );
        assert_eq!(
            bindings
                .iter()
                .map(|binding| binding.id.as_str())
                .collect::<Vec<_>>(),
            ["first", "third"]
        );
    }

    /// Every entry unreadable still leaves the legacy binding, so the provider
    /// stays selectable; the loss is reported per entry rather than being
    /// silent.
    #[test]
    fn an_all_unreadable_array_still_reads_the_legacy_binding() {
        let bindings = config_model_bindings(
            r#"{"models":[{"id":"a","maxTokens":"x"},{"id":"b","contextWindow":"y"}]}"#,
            Some("fallback".into()),
            "provider-under-test",
        );
        assert_eq!(bindings.len(), 1);
        assert_eq!(bindings[0].id, "fallback");
    }

    /// An empty array is a legal state, not a damaged one, so it reads the
    /// legacy binding without being reported as corruption.
    #[test]
    fn an_empty_models_array_reads_the_legacy_binding() {
        let bindings = config_model_bindings(
            r#"{"models":[],"modelId":"config-legacy"}"#,
            None,
            "provider-under-test",
        );
        assert_eq!(bindings.len(), 1);
        assert_eq!(bindings[0].id, "config-legacy");
    }

    /// A `models` value that is not an array is reported rather than silently
    /// read as the legacy binding.
    #[test]
    fn a_non_array_models_value_reads_the_legacy_binding() {
        let bindings = config_model_bindings(
            r#"{"models":{"id":"wrapped"},"modelId":"config-legacy"}"#,
            None,
            "provider-under-test",
        );
        assert_eq!(bindings.len(), 1);
        assert_eq!(bindings[0].id, "config-legacy");
    }
}
