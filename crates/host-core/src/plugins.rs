#![allow(unused_imports)]

pub(crate) use anyhow::{anyhow, bail, Context, Result};
pub(crate) use chrono::Utc;
pub(crate) use serde::{Deserialize, Serialize};
pub(crate) use serde_json::{json, Value};
pub(crate) use sha2::{Digest, Sha256};
pub(crate) use std::cmp::Ordering;
pub(crate) use std::fs;
pub(crate) use std::io::{Read, Write};
pub(crate) use std::path::{Component, Path, PathBuf};
pub(crate) use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};
pub(crate) use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub(crate) use crate::activation::ActivationScope;

pub(crate) const MAX_PACKAGE_BYTES: u64 = 50 * 1024 * 1024;
pub(crate) const MAX_PACKAGE_FILES: usize = 2000;

mod device;
mod install;
mod manifest;
pub mod marketplace;
mod model;
mod permissions;
pub(crate) mod progress;
mod providers;
mod registry;
mod renderer;
mod resolve;
mod validation;

pub use manifest::PluginManifest;
pub use marketplace::{
    market_channel_from_settings, MarketChannel, GITHUB_BACKUP_CHANNEL_CATALOG_URL,
    MIRROR_MARKET_CATALOG_URL, OFFICIAL_CHANNEL_CATALOG_URL,
};
pub use model::{
    InstallOptions, InstallResult, MarketDownloadInfo, MarketPluginDetail, MarketPluginSummary,
    MarketProvenance, MarketReview, MarketVersion, PluginDisplayI18n, PluginI18nMap,
    PluginMarketplaceMeta, PluginSettingDefinition, PluginSettingOption, PluginSummary,
    PluginUiMeta, PluginUpdateInfo, PluginYankNotice,
};
pub(crate) use model::{MarketCatalogEntry, MarketCatalogFile};
pub(crate) use progress::{
    CancelToken, DownloadReport, InstallObserver, InstallPhase, InstallProgress, NoProgress,
    TriedMirror,
};

/// Locale resolution for plugin/catalog display strings, shared by the
/// registry and the marketplace readers.
pub(crate) use model::localized_field;
pub use registry::PluginManager;

// Domain modules share a small set of crate-private helpers. Re-exporting them
// here keeps cross-domain calls explicit without changing the public API.
pub(crate) use install::{
    copy_dir_filtered, crc32, decode_curl_output, download_url, download_url_guarded,
    extract_zip_bytes, find_plugin_root, read_u16, read_u32, safe_join, sha256_hex,
};
// The GBK fallback only exists on Windows, and so does the test that pins it.
#[cfg(windows)]
pub(crate) use install::decode_windows_code_page;
pub(crate) use marketplace::catalog::make_zip;
pub(crate) use marketplace::compare_plugin_versions;
pub(crate) use marketplace::{
    built_in_catalog_at, bundled_package_bytes, has_package_metadata, host_supports_version,
    latest_market_version,
};
pub(crate) use permissions::{derive_capabilities, derive_settings, permission_diff, sanitize_id};
pub(crate) use providers::{
    declared_providers, is_known_api_style, is_known_auth_kind, owned_provider_ids,
    plugin_provider_row_id, reconcile_all, reconcile_plugin, remove_plugin_providers,
    set_plugin_providers_enabled, sync_plugin_providers, MAX_PLUGIN_PROVIDERS,
    MAX_PLUGIN_PROVIDER_MODELS,
};
pub(crate) use renderer::validate_renderer;
pub(crate) use validation::{is_local_package_url, package_host_allowed, validate_contributions};

#[cfg(test)]
mod tests;
