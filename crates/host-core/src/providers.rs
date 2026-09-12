#![allow(unused_imports)]

pub(crate) use anyhow::{anyhow, bail, Result};
pub(crate) use rusqlite::{params, OptionalExtension};
pub(crate) use serde::{Deserialize, Serialize};
pub(crate) use std::collections::BTreeMap;
pub(crate) use uuid::Uuid;

pub(crate) use crate::db::{ms_to_ts, now_ms, Database};
pub(crate) use crate::secrets::{
    secret_ref_for_provider, secret_ref_for_provider_oauth, SecretStore,
};

mod catalog;
mod credentials;
mod model;
mod repository;
mod validation;

pub use catalog::{cache_discovered_models, list_models};
pub use credentials::get_secret_for_provider;
pub use model::{
    DiscoveredModelInput, ModelBinding, ModelCatalogItem, ProviderCreateInput, ProviderPublic,
    ProviderUpdateInput,
};
pub use repository::{
    create_provider, delete_provider, get_provider, list_providers, update_provider,
};

pub(crate) use catalog::{
    config_model_bindings, config_thinking_levels_override, config_with_model_bindings,
    normalize_model_bindings, CANONICAL_THINKING_LEVELS, PROVIDER_SELECT,
};
pub(crate) use credentials::{
    build_provider_config_json, config_headers, config_oauth_account_label,
    config_reasoning_override, config_value, config_with_headers, config_with_limit,
    config_with_oauth_account_label, config_with_reasoning_override,
    config_with_thinking_levels_override, ensure_config_object, limit_temperature_value,
    limit_u32_value, limits_object, merge_provider_config_overrides, upsert_secret_meta,
    LimitOverrides,
};
pub(crate) use validation::{
    config_limit_f64, config_limit_u32, normalize_headers_input, normalize_one_header,
    normalize_thinking_levels, valid_header_key, validate_model_aliases, MAX_HEADERS,
};
