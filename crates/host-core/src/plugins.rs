use anyhow::{anyhow, bail, Context, Result};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::cmp::Ordering;
use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::activation::ActivationScope;

const MAX_PACKAGE_BYTES: u64 = 50 * 1024 * 1024;
const MAX_PACKAGE_FILES: usize = 2000;

/// Official marketplace catalog, served from the dedicated GitHub repo.
pub const OFFICIAL_MARKET_CATALOG_URL: &str =
    "https://raw.githubusercontent.com/vastsa/pi-desktop-plugins/main/catalog.json";

/// Mirror for networks that cannot reach `raw.githubusercontent.com`.
///
/// The mirror serves a byte-identical catalog and packages, and catalog
/// package URLs are relative, so `resolve_package_url` keeps downloads on
/// whichever source the catalog came from and shasum verification is
/// unaffected by the switch.
pub const MIRROR_MARKET_CATALOG_URL: &str =
    "https://cnb.cool/aixk/pi-desktop-plugins/-/git/raw/main/catalog.json";

/// Resolve the catalog URL pinned by persisted app settings.
///
/// `pluginMarketSource` selects the provider; `custom` reads the URL from
/// `pluginMarketCustomUrl`. Returns `None` when settings do not pin a source
/// (or pin `custom` without a URL), which leaves the official default in
/// place.
pub fn market_source_from_settings(settings: Option<&Value>) -> Option<String> {
    let settings = settings?;
    match settings.get("pluginMarketSource").and_then(Value::as_str) {
        Some("mirror") => Some(MIRROR_MARKET_CATALOG_URL.to_string()),
        Some("custom") => settings
            .get("pluginMarketCustomUrl")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|url| !url.is_empty())
            .map(str::to_string),
        _ => None,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginSettingOption {
    pub label: String,
    pub value: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginSettingDefinition {
    pub key: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(rename = "type")]
    pub setting_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<Value>,
    #[serde(rename = "enum", default, skip_serializing_if = "Vec::is_empty")]
    pub enum_values: Vec<PluginSettingOption>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default = "plugin_setting_scope")]
    pub scope: String,
}

fn plugin_setting_scope() -> String {
    "plugin".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginSummary {
    pub id: String,
    pub name: String,
    pub version: String,
    pub enabled: bool,
    /// Where the plugin's contributions apply. Absent in registries written
    /// before scopes existed, and `default()` is global — which is what those
    /// installs already did.
    #[serde(default)]
    pub scope: ActivationScope,
    pub source: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
    pub permissions: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default)]
    pub capabilities: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub installed_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub marketplace: Option<PluginMarketplaceMeta>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_update: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub update_available: Option<PluginUpdateInfo>,
    /// Set when the catalog has withdrawn the exact version installed here.
    /// The host surfaces it and leaves the plugin running: withdrawal is a
    /// distribution signal, and silently disabling working software is a worse
    /// failure than a warning the user can act on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub yanked: Option<PluginYankNotice>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ui: Option<PluginUiMeta>,
    /// `manifest.fs`, passed through verbatim: which files each mode may touch.
    /// The desktop host enforces it; the registry carries it so the Plugins
    /// page can show the user what they granted. Absent in records written
    /// before scopes existed, which the host reads as the legacy minimum.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fs: Option<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub settings: Vec<PluginSettingDefinition>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginMarketplaceMeta {
    pub provider_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shasum: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub publisher_id: Option<String>,
    /// Trust tier recorded at install time. Kept with the install so the
    /// Plugins page can show what the user actually accepted, even after the
    /// catalog changes or becomes unreachable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trust: Option<String>,
    /// Source pin of the installed version (catalog v2).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provenance: Option<MarketProvenance>,
}

/// Distribution-side withdrawal of the exact version a user has installed.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginYankNotice {
    pub version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginUpdateInfo {
    pub version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub changelog: Option<String>,
    pub shasum: String,
    pub url: String,
    #[serde(default)]
    pub permission_diff: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginUiMeta {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub panel: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginManifest {
    #[serde(rename = "schemaVersion")]
    pub schema_version: u32,
    pub id: String,
    pub name: String,
    pub version: String,
    pub main: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub permissions: Vec<String>,
    #[serde(default)]
    pub contributes: Option<Value>,
    #[serde(default)]
    pub ui: Option<PluginUiMeta>,
    #[serde(default)]
    pub fs: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketPluginSummary {
    pub id: String,
    pub name: String,
    pub description: String,
    pub author: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon_url: Option<String>,
    pub latest_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub downloads: Option<u64>,
    pub updated_at: String,
    #[serde(default)]
    pub categories: Vec<String>,
    pub permission_summary: Vec<String>,
    #[serde(default)]
    pub verified: bool,
    /// Catalog v2 trust tier as the client is willing to render it:
    /// `verified`, `community`, or `unknown`.
    #[serde(default = "unknown_trust")]
    pub trust: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub publisher_id: Option<String>,
    #[serde(default)]
    pub installed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub installed_version: Option<String>,
    #[serde(default)]
    pub update_available: bool,
    /// Whether `latest_version` carries the package metadata an install needs.
    /// A publisher can announce a version before uploading its package; the
    /// row stays visible for discovery but must not offer an install action.
    #[serde(default)]
    pub installable: bool,
    /// True when every catalog version of this plugin has been withdrawn.
    #[serde(default)]
    pub yanked: bool,
}

fn unknown_trust() -> String {
    "unknown".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketPluginDetail {
    #[serde(flatten)]
    pub summary: MarketPluginSummary,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub readme_markdown: Option<String>,
    pub versions: Vec<MarketVersion>,
    #[serde(default)]
    pub screenshots: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub homepage: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repository: Option<String>,
    pub permissions: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub safety_notes: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketVersion {
    pub version: String,
    pub published_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub changelog: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_pi_desktop: Option<String>,
    /// Package metadata is optional while a publisher is preparing a release.
    /// Such a version can be displayed and used for update discovery, but it
    /// cannot be installed until its checksum and URL are published.
    #[serde(default)]
    pub shasum: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub size_bytes: u64,
    pub permissions: Vec<String>,
    /// Catalog v2: the distribution side withdrew this version. It stays in
    /// version history so a user holding it can see why, and it is excluded
    /// from every install and update path.
    #[serde(default)]
    pub yanked: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub yanked_reason: Option<String>,
    /// Catalog v2: which source produced these bytes. Evidence for a human
    /// decision, never an integrity control — the checksum decides acceptance.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provenance: Option<MarketProvenance>,
    /// Catalog v2: the center's publish verdict for this version.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review: Option<MarketReview>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signature_alg: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_id: Option<String>,
}

/// Source pin recorded by the plugin center for a published version.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketProvenance {
    pub source_repository: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_commit: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub builder: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub built_at: Option<String>,
}

/// Publish verdict issued by the center's policy evaluator.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketReview {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decision: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub risk: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub policy_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reviewed_at: Option<String>,
}


#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketDownloadInfo {
    pub plugin_id: String,
    pub version: String,
    pub url: String,
    pub size_bytes: u64,
    pub shasum: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signature_alg: Option<String>,
    pub published_at: String,
    pub permissions: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub changelog: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provenance: Option<MarketProvenance>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trust: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub publisher_id: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct MarketCatalogEntry {
    id: String,
    name: String,
    description: String,
    author: String,
    #[serde(default)]
    icon_url: Option<String>,
    #[serde(default)]
    categories: Vec<String>,
    #[serde(default)]
    verified: bool,
    /// Catalog v2 trust tier, issued by the center. `verified` is only honoured
    /// from the official/mirror source; see `resolve_trust`.
    #[serde(default)]
    trust: Option<String>,
    #[serde(default)]
    publisher_id: Option<String>,
    #[serde(default)]
    downloads: Option<u64>,
    #[serde(default)]
    homepage: Option<String>,
    #[serde(default)]
    repository: Option<String>,
    #[serde(default)]
    readme_markdown: Option<String>,
    #[serde(default)]
    safety_notes: Option<String>,
    versions: Vec<MarketVersion>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct MarketCatalogFile {
    /// Absent or 1 means the v1 schema. v2 adds provenance, review verdicts,
    /// yank state, and a declared artifact base.
    #[serde(default = "default_schema_version")]
    schema_version: u32,
    #[serde(default = "default_provider_id")]
    provider_id: String,
    #[serde(default)]
    catalog_id: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    homepage: Option<String>,
    #[serde(default)]
    updated_at: Option<String>,
    #[serde(default)]
    generated_at: Option<String>,
    #[serde(default)]
    policy_version: Option<String>,
    /// Base a relative package URL resolves against. A mirror declares its own
    /// base, so switching source never sends a download to another provider.
    #[serde(default)]
    artifact_base_url: Option<String>,
    #[serde(default)]
    plugins: Vec<MarketCatalogEntry>,
}

fn default_provider_id() -> String {
    "official".into()
}

fn default_schema_version() -> u32 {
    1
}


#[derive(Debug, Clone)]
pub struct InstallOptions {
    pub source: String,
    pub enable: bool,
    pub marketplace: Option<PluginMarketplaceMeta>,
    pub expected_shasum: Option<String>,
    pub auto_update: bool,
    pub granted_permissions: Option<Vec<String>>,
}

impl Default for InstallOptions {
    fn default() -> Self {
        Self {
            source: "installed".into(),
            enable: true,
            marketplace: None,
            expected_shasum: None,
            auto_update: false,
            granted_permissions: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallResult {
    pub plugin: PluginSummary,
    pub upgraded: bool,
    #[serde(default)]
    pub permission_diff: Vec<String>,
}

/// Directory holding the plugins this application build ships, if any.
///
/// Electron resolves the packaged location and passes it down, because only it
/// knows whether the app is running from `resources/` or a source checkout.
fn builtin_plugins_dir() -> Option<PathBuf> {
    let raw = std::env::var("PI_DESKTOP_BUILTIN_PLUGINS_DIR").ok()?;
    let path = PathBuf::from(raw.trim());
    if path.as_os_str().is_empty() || !path.is_dir() {
        return None;
    }
    Some(path)
}

pub struct PluginManager {
    data_dir: PathBuf,
    runtime: Vec<PluginSummary>,
    /// Catalog URL pinned by app settings; `None` keeps the official default.
    market_source: Option<String>,
}

impl PluginManager {
    /// Build a manager against a specific catalog source.
    ///
    /// The source is applied before the first catalog fetch so a mirror
    /// configured in settings is honoured on the very first launch, not only
    /// after an explicit refresh.
    pub fn new(data_dir: &Path, market_source: Option<String>) -> Self {
        let mut mgr = Self {
            data_dir: data_dir.to_path_buf(),
            runtime: Vec::new(),
            market_source,
        };
        let _ = mgr.ensure_dirs();
        let _ = mgr.ensure_default_catalog();
        let _ = mgr.reload_from_disk();
        let _ = mgr.sync_builtin(builtin_plugins_dir().as_deref());
        mgr
    }

    /// Reconcile the registry with the plugins this application build ships.
    ///
    /// Bundled plugins are not installed by the user and cannot be uninstalled,
    /// but they are ordinary plugins in every other respect — the whole point of
    /// ADR 0104 is that first-party panel surfaces go through the same
    /// contribution channel third parties use. Their row is therefore rebuilt
    /// from the shipped manifest on every launch (so an app update refreshes the
    /// version and contributions), while the two pieces of state the *user*
    /// owns — whether it is enabled, and its activation scope — are carried
    /// across. A bundled plugin that disappears from a newer build leaves the
    /// registry with it.
    pub fn sync_builtin(&mut self, dir: Option<&Path>) -> Result<()> {
        let mut shipped: Vec<PluginSummary> = Vec::new();
        if let Some(dir) = dir {
            let entries = match fs::read_dir(dir) {
                Ok(entries) => entries,
                // A build without bundled plugins is valid, not an error.
                Err(_) => return self.drop_missing_builtin(&shipped),
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.join("manifest.json").exists() {
                    continue;
                }
                let manifest = match Self::read_manifest(&path) {
                    Ok(manifest) => manifest,
                    // A malformed bundled plugin is a build defect. Skip it
                    // rather than refusing to start the whole host.
                    Err(_) => continue,
                };
                let previous = self.runtime.iter().find(|p| p.id == manifest.id);
                let now = Utc::now().to_rfc3339();
                shipped.push(PluginSummary {
                    id: manifest.id.clone(),
                    name: manifest.name.clone(),
                    version: manifest.version.clone(),
                    enabled: previous.map(|p| p.enabled).unwrap_or(true),
                    scope: previous.map(|p| p.scope.clone()).unwrap_or_default(),
                    source: "builtin".into(),
                    status: if previous.map(|p| p.enabled).unwrap_or(true) {
                        "ready".into()
                    } else {
                        "disabled".into()
                    },
                    error_message: None,
                    permissions: manifest.permissions.clone(),
                    path: Some(path.to_string_lossy().to_string()),
                    capabilities: derive_capabilities(&manifest),
                    description: manifest.description.clone(),
                    author: manifest.author.clone(),
                    installed_at: previous
                        .and_then(|p| p.installed_at.clone())
                        .or(Some(now.clone())),
                    updated_at: Some(now),
                    marketplace: None,
                    auto_update: None,
                    update_available: None,
                    // A bundled plugin has no publisher to yank it; its
                    // lifecycle is the application's own release cycle.
                    yanked: None,
                    ui: manifest.ui.clone(),
                    fs: manifest.fs.clone(),
                    settings: derive_settings(&manifest),
                });
            }
        }

        self.drop_missing_builtin(&shipped)?;
        for summary in shipped {
            self.runtime.retain(|p| p.id != summary.id);
            self.runtime.push(summary);
        }
        self.save()
    }

    /// Forget bundled rows this build no longer ships.
    fn drop_missing_builtin(&mut self, shipped: &[PluginSummary]) -> Result<()> {
        let keep: Vec<&str> = shipped.iter().map(|p| p.id.as_str()).collect();
        self.runtime
            .retain(|p| p.source != "builtin" || keep.contains(&p.id.as_str()));
        Ok(())
    }


    fn ensure_dirs(&self) -> Result<()> {
        for rel in [
            "plugins/installed",
            "plugins/disabled",
            "plugins/data",
            "plugins/logs",
            "plugins/cache/download",
            "plugins/cache/backup",
            "plugins/market",
        ] {
            fs::create_dir_all(self.data_dir.join(rel))?;
        }
        Ok(())
    }

    fn registry_path(&self) -> PathBuf {
        self.data_dir.join("plugins/registry.json")
    }

    fn catalog_path(&self) -> PathBuf {
        self.data_dir.join("plugins/market/catalog.json")
    }

    fn installed_dir(&self, id: &str) -> PathBuf {
        self.data_dir
            .join("plugins/installed")
            .join(sanitize_id(id))
    }

    fn data_dir_for(&self, id: &str) -> PathBuf {
        self.data_dir.join("plugins/data").join(sanitize_id(id))
    }

    pub fn list(&self) -> Vec<PluginSummary> {
        self.runtime.clone()
    }

    pub fn get(&self, id: &str) -> Option<PluginSummary> {
        self.runtime.iter().find(|p| p.id == id).cloned()
    }

    pub fn reload_from_disk(&mut self) -> Result<()> {
        let path = self.registry_path();
        if !path.exists() {
            self.runtime.clear();
            return Ok(());
        }
        let raw = fs::read_to_string(path)?;
        self.runtime = serde_json::from_str(&raw).unwrap_or_default();
        for plugin in &mut self.runtime {
            let Some(plugin_path) = plugin.path.as_deref() else {
                continue;
            };
            let manifest_path = Path::new(plugin_path).join("manifest.json");
            let Ok(manifest_raw) = fs::read_to_string(manifest_path) else {
                continue;
            };
            let Ok(manifest) = serde_json::from_str::<PluginManifest>(&manifest_raw) else {
                continue;
            };
            plugin.settings = derive_settings(&manifest);
        }
        Ok(())
    }

    fn save(&self) -> Result<()> {
        let path = self.registry_path();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(path, serde_json::to_string_pretty(&self.runtime)?)?;
        Ok(())
    }

    fn read_manifest(path: &Path) -> Result<PluginManifest> {
        let manifest_path = path.join("manifest.json");
        if !manifest_path.exists() {
            bail!("PLUGIN_INVALID: manifest.json missing");
        }
        let raw = fs::read_to_string(&manifest_path)
            .with_context(|| format!("read manifest {}", manifest_path.display()))?;
        let manifest: PluginManifest =
            serde_json::from_str(&raw).map_err(|e| anyhow!("PLUGIN_INVALID: {e}"))?;
        if manifest.id.trim().is_empty() || manifest.main.trim().is_empty() {
            bail!("PLUGIN_INVALID: id/main required");
        }
        if manifest.name.trim().is_empty() || manifest.version.trim().is_empty() {
            bail!("PLUGIN_INVALID: name/version required");
        }
        let main_path = path.join(&manifest.main);
        if !main_path.exists() {
            bail!("PLUGIN_LOAD_FAILED: main entry missing");
        }
        if let Some(ui) = &manifest.ui {
            if let Some(panel) = &ui.panel {
                let panel_path = path.join(panel);
                if !panel_path.exists() {
                    bail!("PLUGIN_INVALID: ui.panel missing");
                }
            }
        }
        validate_contributions(path, &manifest)?;
        Ok(manifest)
    }

    fn upsert_summary(&mut self, summary: PluginSummary) -> Result<PluginSummary> {
        self.runtime.retain(|p| p.id != summary.id);
        self.runtime.push(summary.clone());
        self.save()?;
        Ok(summary)
    }

    pub fn load_dev(&mut self, plugin_path: &str) -> Result<PluginSummary> {
        let path = PathBuf::from(plugin_path);
        let manifest = Self::read_manifest(&path)?;
        let now = Utc::now().to_rfc3339();
        let summary = PluginSummary {
            id: manifest.id.clone(),
            name: manifest.name.clone(),
            version: manifest.version.clone(),
            enabled: true,
            scope: ActivationScope::default(),
            source: "dev".into(),
            status: "ready".into(),
            error_message: None,
            permissions: manifest.permissions.clone(),
            path: Some(path.to_string_lossy().to_string()),
            capabilities: derive_capabilities(&manifest),
            description: manifest.description.clone(),
            author: manifest.author.clone(),
            installed_at: Some(now.clone()),
            updated_at: Some(now),
            marketplace: None,
            auto_update: Some(false),
            update_available: None,
            yanked: None,
            ui: manifest.ui.clone(),
            fs: manifest.fs.clone(),
            settings: derive_settings(&manifest),
        };
        self.upsert_summary(summary)
    }

    pub fn install_from_path(
        &mut self,
        source_path: &str,
        opts: InstallOptions,
    ) -> Result<InstallResult> {
        let source = PathBuf::from(source_path);
        if !source.exists() {
            bail!("PLUGIN_INVALID: package path missing");
        }

        let stage = self
            .data_dir
            .join("plugins/cache/download")
            .join(format!("stage-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&stage)?;
        let cleanup_stage = stage.clone();
        let result = (|| -> Result<InstallResult> {
            let extracted_root = if source.is_dir() {
                copy_dir_filtered(&source, &stage.join("content"))?;
                stage.join("content")
            } else {
                let bytes = fs::read(&source)
                    .with_context(|| format!("read package {}", source.display()))?;
                if bytes.len() as u64 > MAX_PACKAGE_BYTES {
                    bail!("PLUGIN_INVALID: package exceeds 50MB limit");
                }
                if let Some(expected) = &opts.expected_shasum {
                    let actual = sha256_hex(&bytes);
                    if !actual.eq_ignore_ascii_case(expected) {
                        bail!("PLUGIN_INTEGRITY: checksum mismatch");
                    }
                }
                let extract_dir = stage.join("extract");
                fs::create_dir_all(&extract_dir)?;
                extract_zip_bytes(&bytes, &extract_dir)?;
                find_plugin_root(&extract_dir)?
            };

            let manifest = Self::read_manifest(&extracted_root)?;
            let existing = self.get(&manifest.id);
            let upgraded = existing
                .as_ref()
                .map(|p| p.version != manifest.version)
                .unwrap_or(false);
            let permission_diff = permission_diff(
                existing
                    .as_ref()
                    .map(|p| p.permissions.as_slice())
                    .unwrap_or(&[]),
                &manifest.permissions,
            );

            if upgraded {
                if let Some(prev) = &existing {
                    if let Some(prev_path) = prev.path.as_ref() {
                        let backup = self
                            .data_dir
                            .join("plugins/cache/backup")
                            .join(sanitize_id(&prev.id))
                            .join(&prev.version);
                        let _ = fs::remove_dir_all(&backup);
                        if PathBuf::from(prev_path).exists() {
                            copy_dir_filtered(Path::new(prev_path), &backup)?;
                        }
                    }
                }
            }

            let target = self.installed_dir(&manifest.id);
            if target.exists() {
                fs::remove_dir_all(&target)?;
            }
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)?;
            }
            copy_dir_filtered(&extracted_root, &target)?;
            fs::create_dir_all(self.data_dir_for(&manifest.id))?;

            let now = Utc::now().to_rfc3339();
            let granted = opts
                .granted_permissions
                .clone()
                .unwrap_or_else(|| manifest.permissions.clone());
            for required in &manifest.permissions {
                if !granted.iter().any(|g| g == required) {
                    bail!("PLUGIN_PERMISSION_DENIED: missing grant for {required}");
                }
            }

            let summary = PluginSummary {
                id: manifest.id.clone(),
                name: manifest.name.clone(),
                version: manifest.version.clone(),
                enabled: opts.enable,
                // An update must not silently widen a project-scoped plugin
                // back to every project.
                scope: existing
                    .as_ref()
                    .map(|p| p.scope.clone())
                    .unwrap_or_default(),
                source: opts.source.clone(),
                status: if opts.enable {
                    "ready".into()
                } else {
                    "disabled".into()
                },
                error_message: None,
                permissions: granted,
                path: Some(target.to_string_lossy().to_string()),
                capabilities: derive_capabilities(&manifest),
                description: manifest.description.clone(),
                author: manifest.author.clone(),
                installed_at: existing
                    .as_ref()
                    .and_then(|p| p.installed_at.clone())
                    .or_else(|| Some(now.clone())),
                updated_at: Some(now),
                marketplace: opts
                    .marketplace
                    .clone()
                    .or_else(|| existing.as_ref().and_then(|p| p.marketplace.clone())),
                auto_update: Some(
                    opts.auto_update
                        || existing
                            .as_ref()
                            .and_then(|p| p.auto_update)
                            .unwrap_or(false),
                ),
                update_available: None,
                yanked: None,
                ui: manifest.ui.clone(),
                fs: manifest.fs.clone(),
                settings: derive_settings(&manifest),
            };
            let plugin = self.upsert_summary(summary)?;
            Ok(InstallResult {
                plugin,
                upgraded,
                permission_diff,
            })
        })();

        let _ = fs::remove_dir_all(cleanup_stage);
        result
    }

    pub fn install_from_package(
        &mut self,
        package_path: &str,
        opts: InstallOptions,
    ) -> Result<InstallResult> {
        self.install_from_path(package_path, opts)
    }

    pub fn set_enabled(&mut self, id: &str, enabled: bool) -> Result<Option<PluginSummary>> {
        if let Some(plugin) = self.runtime.iter_mut().find(|p| p.id == id) {
            plugin.enabled = enabled;
            plugin.status = if enabled {
                "ready".into()
            } else {
                "disabled".into()
            };
            plugin.updated_at = Some(Utc::now().to_rfc3339());
            let out = plugin.clone();
            self.save()?;
            return Ok(Some(out));
        }
        Ok(None)
    }

    /// Move a plugin between "everywhere" and "these projects". Kept separate
    /// from `set_enabled` so switching a plugin off never discards its list.
    pub fn set_scope(&mut self, id: &str, scope: ActivationScope) -> Result<Option<PluginSummary>> {
        if let Some(plugin) = self.runtime.iter_mut().find(|p| p.id == id) {
            plugin.scope = scope.normalized();
            plugin.updated_at = Some(Utc::now().to_rfc3339());
            let out = plugin.clone();
            self.save()?;
            return Ok(Some(out));
        }
        Ok(None)
    }

    pub fn set_auto_update(&mut self, id: &str, enabled: bool) -> Result<Option<PluginSummary>> {
        if let Some(plugin) = self.runtime.iter_mut().find(|p| p.id == id) {
            plugin.auto_update = Some(enabled);
            plugin.updated_at = Some(Utc::now().to_rfc3339());
            let out = plugin.clone();
            self.save()?;
            return Ok(Some(out));
        }
        Ok(None)
    }

    pub fn uninstall(&mut self, id: &str) -> Result<bool> {
        let existing = self.get(id);
        // A bundled plugin is part of the application, so there is nothing to
        // remove and its files are not ours to delete. Disabling is the
        // supported way to turn one off (ADR 0104).
        if existing.as_ref().map(|p| p.source.as_str()) == Some("builtin") {
            bail!("PLUGIN_INVALID: a bundled plugin cannot be uninstalled; disable it instead");
        }
        let before = self.runtime.len();
        self.runtime.retain(|p| p.id != id);
        self.save()?;
        if let Some(plugin) = existing {
            if plugin.source != "dev" {
                let installed = self.installed_dir(id);
                if installed.exists() {
                    let _ = fs::remove_dir_all(installed);
                }
            }
            // Default policy: delete plugin private data on uninstall.
            let data = self.data_dir_for(id);
            if data.exists() {
                let _ = fs::remove_dir_all(data);
            }
            let log = self
                .data_dir
                .join("plugins/logs")
                .join(format!("{}.log", sanitize_id(id)));
            let _ = fs::remove_file(log);
        }
        Ok(self.runtime.len() < before)
    }

    pub fn grant_permissions(
        &mut self,
        id: &str,
        permissions: Vec<String>,
    ) -> Result<Option<PluginSummary>> {
        if let Some(plugin) = self.runtime.iter_mut().find(|p| p.id == id) {
            for perm in permissions {
                if !plugin.permissions.iter().any(|p| p == &perm) {
                    plugin.permissions.push(perm);
                }
            }
            plugin.updated_at = Some(Utc::now().to_rfc3339());
            let out = plugin.clone();
            self.save()?;
            return Ok(Some(out));
        }
        Ok(None)
    }

    pub fn revoke_permissions(
        &mut self,
        id: &str,
        permissions: Vec<String>,
    ) -> Result<Option<PluginSummary>> {
        if let Some(plugin) = self.runtime.iter_mut().find(|p| p.id == id) {
            plugin
                .permissions
                .retain(|p| !permissions.iter().any(|x| x == p));
            plugin.updated_at = Some(Utc::now().to_rfc3339());
            let out = plugin.clone();
            self.save()?;
            return Ok(Some(out));
        }
        Ok(None)
    }

    /// Catalog URL in effect, highest precedence first.
    ///
    /// The environment override stays on top so dev builds and tests can point
    /// at a local catalog without touching persisted settings.
    pub fn market_source_url(&self) -> String {
        if let Ok(url) = std::env::var("PI_DESKTOP_PLUGIN_MARKET_URL") {
            if !url.trim().is_empty() {
                return url;
            }
        }
        self.market_source
            .clone()
            .unwrap_or_else(|| OFFICIAL_MARKET_CATALOG_URL.to_string())
    }

    /// Re-pin the catalog source after the user switches providers.
    ///
    /// Cached snapshots are left on disk: they are keyed back to their source
    /// through `cache-meta.json`, so a snapshot from another provider is
    /// ignored rather than deleted and switching back keeps working offline.
    pub fn set_market_source(&mut self, market_source: Option<String>) {
        self.market_source = market_source;
    }

    fn market_cache_meta_path(&self) -> PathBuf {
        self.data_dir.join("plugins/market/cache-meta.json")
    }

    fn ensure_default_catalog(&self) -> Result<()> {
        let path = self.catalog_path();
        if path.exists() {
            return Ok(());
        }
        // Prefer the official remote marketplace repo; fall back to bundled demos.
        match self.refresh_catalog_from_remote(false) {
            Ok(_) => Ok(()),
            Err(remote_err) => {
                if let Some(parent) = path.parent() {
                    fs::create_dir_all(parent)?;
                }
                let catalog = built_in_catalog();
                fs::write(&path, serde_json::to_string_pretty(&catalog)?)?;
                self.materialize_local_package_urls(&catalog)?;
                let _ = remote_err;
                Ok(())
            }
        }
    }

    fn materialize_local_package_urls(&self, catalog: &MarketCatalogFile) -> Result<()> {
        for plugin in &catalog.plugins {
            for version in &plugin.versions {
                if let Some(local) = version.url.strip_prefix("file://") {
                    let target = PathBuf::from(local);
                    if let Some(parent) = target.parent() {
                        fs::create_dir_all(parent)?;
                    }
                    if !target.exists() {
                        if let Some(bytes) = bundled_package_bytes(&plugin.id, &version.version) {
                            fs::write(&target, bytes)?;
                        }
                    }
                }
            }
        }
        Ok(())
    }

    /// Turn a catalog package URL into the absolute URL the host will fetch.
    ///
    /// A relative path resolves against the catalog's declared
    /// `artifactBaseUrl` when it has one (catalog v2), and otherwise against
    /// the catalog URL's own directory (catalog v1). Keeping both anchored to
    /// the catalog that carried them is what makes a mirror switch safe: the
    /// mirror declares its own base, so a download never crosses back to the
    /// provider the user just switched away from, and the checksum being
    /// verified is unchanged.
    fn resolve_package_url(
        catalog_url: &str,
        artifact_base_url: Option<&str>,
        package_url: &str,
    ) -> String {
        if package_url.starts_with("http://")
            || package_url.starts_with("https://")
            || package_url.starts_with("file://")
        {
            return package_url.to_string();
        }
        let base = match artifact_base_url.map(str::trim).filter(|b| !b.is_empty()) {
            // A declared base is a prefix, not a directory: a trailing slash is
            // supplied here so `.../download` and `.../download/` agree.
            Some(base) => {
                if base.ends_with('/') {
                    base.to_string()
                } else {
                    format!("{base}/")
                }
            }
            None => match catalog_url.rfind('/') {
                Some(idx) => catalog_url[..=idx].to_string(),
                None => return package_url.to_string(),
            },
        };
        format!("{base}{}", package_url.trim_start_matches('/'))
    }

    fn rewrite_catalog_urls(
        catalog_url: &str,
        mut catalog: MarketCatalogFile,
    ) -> MarketCatalogFile {
        let base = catalog.artifact_base_url.clone();
        for plugin in &mut catalog.plugins {
            for version in &mut plugin.versions {
                version.url =
                    Self::resolve_package_url(catalog_url, base.as_deref(), &version.url);
            }
        }
        catalog
    }

    /// Source URL the on-disk snapshot was fetched from, when recorded.
    fn cached_catalog_source(&self) -> Option<String> {
        let raw = fs::read_to_string(self.market_cache_meta_path()).ok()?;
        let meta: Value = serde_json::from_str(&raw).ok()?;
        meta.get("sourceUrl")
            .and_then(Value::as_str)
            .map(str::to_string)
    }

    /// Whether the snapshot on disk came from the source currently in effect.
    ///
    /// Package URLs are rewritten to absolute form against the catalog they
    /// arrived with, so a snapshot from another provider would keep installs
    /// pointed at the source the user just switched away from.
    fn cached_catalog_matches_source(&self, catalog_url: &str) -> bool {
        match self.cached_catalog_source() {
            Some(cached) => cached == catalog_url,
            // No recorded source means the snapshot was never fetched from a
            // provider — it is the bundled offline fallback, which carries no
            // provider-specific URLs. Keep it instead of discarding what may
            // be the only catalog available.
            None => true,
        }
    }

    fn refresh_catalog_from_remote(&self, force: bool) -> Result<MarketCatalogFile> {
        let catalog_url = self.market_source_url();
        let cache_path = self.catalog_path();
        let meta_path = self.market_cache_meta_path();
        if !force && cache_path.exists() && self.cached_catalog_matches_source(&catalog_url) {
            if let Ok(meta_raw) = fs::read_to_string(&meta_path) {
                if let Ok(meta) = serde_json::from_str::<Value>(&meta_raw) {
                    let fetched_at = meta.get("fetchedAt").and_then(|v| v.as_str()).unwrap_or("");
                    if let Ok(ts) = chrono::DateTime::parse_from_rfc3339(fetched_at) {
                        let age = Utc::now().signed_duration_since(ts.with_timezone(&Utc));
                        if age.num_seconds() < 300 {
                            // Fresh enough; use cache.
                            let raw = fs::read_to_string(&cache_path)?;
                            let catalog: MarketCatalogFile = serde_json::from_str(&raw)
                                .map_err(|e| anyhow!("PLUGIN_MARKET_INVALID: {e}"))?;
                            return Ok(catalog);
                        }
                    }
                }
            }
        }

        let bytes = download_url(&catalog_url)
            .map_err(|e| anyhow!("PLUGIN_NETWORK: failed to fetch marketplace catalog: {e}"))?;
        let raw = String::from_utf8(bytes)
            .map_err(|_| anyhow!("PLUGIN_MARKET_INVALID: catalog is not utf8"))?;
        let parsed: MarketCatalogFile =
            serde_json::from_str(&raw).map_err(|e| anyhow!("PLUGIN_MARKET_INVALID: {e}"))?;
        if parsed.plugins.is_empty() {
            bail!("PLUGIN_MARKET_INVALID: remote catalog has no plugins");
        }
        let catalog = Self::rewrite_catalog_urls(&catalog_url, parsed);
        if let Some(parent) = cache_path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&cache_path, serde_json::to_string_pretty(&catalog)?)?;
        let meta = json!({
            "sourceUrl": catalog_url,
            "providerId": catalog.provider_id,
            "fetchedAt": Utc::now().to_rfc3339(),
            "pluginCount": catalog.plugins.len(),
        });
        fs::write(meta_path, serde_json::to_string_pretty(&meta)?)?;
        Ok(catalog)
    }

    pub fn refresh_market(&self, force: bool) -> Result<Value> {
        let catalog = self.refresh_catalog_from_remote(force)?;
        Ok(json!({
            "providerId": catalog.provider_id,
            "name": catalog.name,
            "homepage": catalog.homepage,
            "updatedAt": catalog.updated_at,
            "pluginCount": catalog.plugins.len(),
            "sourceUrl": self.market_source_url(),
        }))
    }

    fn load_catalog(&self) -> Result<MarketCatalogFile> {
        // Search, detail, and offline install fall back to the local snapshot.
        // Remote refresh is explicit so these RPCs never block the Extensions
        // surface behind a marketplace network timeout.
        self.load_cached_catalog()
    }

    /// Read the last valid catalog without attempting network access.
    ///
    /// Silent checks run while the Extensions surface is opening. They must
    /// never hold the host RPC state lock behind a remote timeout; an explicit
    /// refresh remains responsible for fetching the latest catalog.
    ///
    /// A snapshot left by a different source is skipped rather than deleted,
    /// so switching back to a previously used provider recovers its catalog
    /// without a round trip.
    fn load_cached_catalog(&self) -> Result<MarketCatalogFile> {
        if self.cached_catalog_matches_source(&self.market_source_url()) {
            if let Ok(raw) = fs::read_to_string(self.catalog_path()) {
                if let Ok(catalog) = serde_json::from_str::<MarketCatalogFile>(&raw) {
                    if !catalog.plugins.is_empty() {
                        return Ok(catalog);
                    }
                }
            }
        }

        let catalog = built_in_catalog();
        self.materialize_local_package_urls(&catalog)?;
        Ok(catalog)
    }

    /// Resolve install metadata from a fresh catalog snapshot whenever the
    /// marketplace is reachable. The package URL points at a mutable release
    /// channel such as `main`, so pairing it with a recently cached checksum
    /// can reject a valid package after the publisher replaces that release.
    /// Offline installs still use the last valid catalog through `load_catalog`.
    fn load_catalog_for_install(&self) -> Result<MarketCatalogFile> {
        match self.refresh_catalog_from_remote(true) {
            Ok(catalog) => Ok(catalog),
            Err(_) => self.load_catalog(),
        }
    }

    pub fn market_search(
        &self,
        query: Option<&str>,
        category: Option<&str>,
    ) -> Result<Vec<MarketPluginSummary>> {
        let catalog = self.load_catalog()?;
        let q = query.unwrap_or("").trim().to_lowercase();
        let mut out = Vec::new();
        for entry in catalog.plugins {
            if let Some(cat) = category {
                if !cat.is_empty() && !entry.categories.iter().any(|c| c.eq_ignore_ascii_case(cat))
                {
                    continue;
                }
            }
            if !q.is_empty() {
                let hay = format!(
                    "{} {} {} {}",
                    entry.id, entry.name, entry.description, entry.author
                )
                .to_lowercase();
                if !hay.contains(&q) {
                    continue;
                }
            }
            out.push(self.to_market_summary(&entry));
        }
        out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        Ok(out)
    }

    pub fn market_get(&self, plugin_id: &str) -> Result<MarketPluginDetail> {
        let catalog = self.load_catalog()?;
        let mut entry = catalog
            .plugins
            .into_iter()
            .find(|p| p.id == plugin_id)
            .ok_or_else(|| anyhow!("PLUGIN_NOT_FOUND: {plugin_id}"))?;
        entry
            .versions
            .sort_by(|a, b| compare_plugin_versions(&b.version, &a.version));
        let summary = self.to_market_summary(&entry);
        let permissions = latest_market_version(&entry.versions)
            .map(|v| v.permissions.clone())
            .unwrap_or_default();
        Ok(MarketPluginDetail {
            summary,
            readme_markdown: entry.readme_markdown,
            versions: entry.versions,
            screenshots: vec![],
            homepage: entry.homepage,
            repository: entry.repository,
            permissions,
            safety_notes: entry.safety_notes,
        })
    }

    pub fn market_download_info(
        &self,
        plugin_id: &str,
        version: Option<&str>,
    ) -> Result<MarketDownloadInfo> {
        // Keep the public download-info seam on the same freshness boundary as
        // `market.install`; callers must not receive a URL/checksum pair from
        // an old catalog when the marketplace is reachable.
        let catalog = self.load_catalog_for_install()?;
        self.market_download_info_from_catalog(&catalog, plugin_id, version)
    }

    fn market_download_info_from_catalog(
        &self,
        catalog: &MarketCatalogFile,
        plugin_id: &str,
        version: Option<&str>,
    ) -> Result<MarketDownloadInfo> {
        let entry = catalog
            .plugins
            .iter()
            .find(|p| p.id == plugin_id)
            .ok_or_else(|| anyhow!("PLUGIN_NOT_FOUND: {plugin_id}"))?;
        let selected = if let Some(version) = version {
            entry
                .versions
                .iter()
                .find(|v| v.version == version)
                .cloned()
        } else {
            latest_market_version(&entry.versions).cloned()
        }
        .ok_or_else(|| anyhow!("PLUGIN_NOT_FOUND: version missing"))?;
        // An explicit version pick reaches here without passing through
        // `latest_market_version`, so a withdrawn release has to be refused
        // again rather than relying on the selection helper.
        if selected.yanked {
            let reason = selected
                .yanked_reason
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or("withdrawn by the publisher");
            bail!(
                "PLUGIN_MARKET_YANKED: version {} was withdrawn: {reason}",
                selected.version
            );
        }
        if !has_package_metadata(&selected) {
            bail!(
                "PLUGIN_MARKET_INVALID: version {} is missing package download metadata",
                selected.version
            );
        }
        if !host_supports_version(&selected) {
            bail!(
                "PLUGIN_HOST_TOO_OLD: version {} requires PI-Desktop {} or newer, this host is {}",
                selected.version,
                selected.min_pi_desktop.as_deref().unwrap_or("newer"),
                crate::state::HOST_VERSION
            );
        }
        Ok(MarketDownloadInfo {
            plugin_id: plugin_id.to_string(),
            version: selected.version,
            url: selected.url,
            size_bytes: selected.size_bytes,
            shasum: selected.shasum,
            signature: selected.signature,
            signature_alg: selected.signature_alg,
            published_at: selected.published_at,
            permissions: selected.permissions,
            changelog: selected.changelog,
            provenance: selected.provenance,
            trust: Some(self.resolve_trust(entry)),
            publisher_id: entry.publisher_id.clone(),
        })
    }

    pub fn check_updates(&mut self, refresh_remote: bool) -> Result<Vec<PluginUpdateInfo>> {
        // An explicit update check must not reuse the short-lived marketplace
        // cache: a publisher may have released a plugin since the last search.
        // Silent checks use only the last valid catalog so opening Extensions
        // cannot block on a remote marketplace timeout.
        let catalog = if refresh_remote {
            match self.refresh_catalog_from_remote(true) {
                Ok(catalog) => catalog,
                Err(_) => self.load_cached_catalog()?,
            }
        } else {
            self.load_cached_catalog()?
        };
        let mut updates = Vec::new();
        for plugin in self.runtime.iter_mut() {
            let Some(entry) = catalog.plugins.iter().find(|p| p.id == plugin.id) else {
                plugin.update_available = None;
                plugin.yanked = None;
                continue;
            };
            // A withdrawal applies to the version the user is holding, not to
            // whether a newer one exists, so it is resolved independently of
            // the update decision below.
            plugin.yanked = entry
                .versions
                .iter()
                .find(|v| v.version == plugin.version && v.yanked)
                .map(|v| PluginYankNotice {
                    version: v.version.clone(),
                    reason: v.yanked_reason.clone(),
                });
            let Some(latest) = latest_market_version(&entry.versions) else {
                plugin.update_available = None;
                continue;
            };
            if compare_plugin_versions(&latest.version, &plugin.version) != Ordering::Greater {
                plugin.update_available = None;
                continue;
            }
            // Offering an update this host cannot install would turn every
            // update check into a failed download.
            if !host_supports_version(latest) {
                plugin.update_available = None;
                continue;
            }
            let diff = permission_diff(&plugin.permissions, &latest.permissions);
            let info = PluginUpdateInfo {
                version: latest.version.clone(),
                changelog: latest.changelog.clone(),
                shasum: latest.shasum.clone(),
                url: latest.url.clone(),
                permission_diff: diff,
            };
            plugin.update_available = Some(info.clone());
            updates.push(info);
        }
        self.save()?;
        Ok(updates)
    }

    pub fn install_from_market(
        &mut self,
        plugin_id: &str,
        version: Option<&str>,
        enable: bool,
        auto_update: bool,
        granted_permissions: Option<Vec<String>>,
    ) -> Result<InstallResult> {
        let info = self.market_download_info(plugin_id, version)?;
        let package_path = self.download_market_package(&info)?;
        let marketplace = PluginMarketplaceMeta {
            provider_id: "official".into(),
            shasum: Some(info.shasum.clone()),
            // Record the publisher the catalog named. Falling back to the
            // project keeps registries written before publisher-owned sources
            // readable, but a v2 entry must not be relabelled as ours.
            publisher_id: Some(
                info.publisher_id
                    .clone()
                    .unwrap_or_else(|| "pi-desktop".into()),
            ),
            trust: info.trust.clone(),
            provenance: info.provenance.clone(),
        };
        let result = self.install_from_path(
            &package_path.to_string_lossy(),
            InstallOptions {
                source: "marketplace".into(),
                enable,
                marketplace: Some(marketplace),
                expected_shasum: Some(info.shasum),
                auto_update,
                granted_permissions,
            },
        );
        let _ = fs::remove_file(package_path);
        result
    }

    pub fn apply_updates(&mut self, only_auto: bool) -> Result<Vec<InstallResult>> {
        let _ = self.check_updates(true)?;
        let pending: Vec<(String, PluginUpdateInfo, bool, Vec<String>)> = self
            .runtime
            .iter()
            .filter_map(|p| {
                let update = p.update_available.clone()?;
                // An announced-but-unpublished version stays visible as an
                // update, yet installing it can only fail. Skipping it here
                // keeps one incomplete catalog entry from aborting the batch.
                if update.shasum.trim().is_empty() || update.url.trim().is_empty() {
                    return None;
                }
                if only_auto && !p.auto_update.unwrap_or(false) {
                    return None;
                }
                // Auto-update refuses silent permission expansion.
                if only_auto && !update.permission_diff.is_empty() {
                    return None;
                }
                Some((
                    p.id.clone(),
                    update,
                    p.auto_update.unwrap_or(false),
                    p.permissions.clone(),
                ))
            })
            .collect();

        let mut results = Vec::new();
        for (id, update, auto_update, current_permissions) in pending {
            let mut granted = current_permissions;
            for perm in &update.permission_diff {
                if !granted.iter().any(|p| p == perm) {
                    granted.push(perm.clone());
                }
            }
            let installed = self.install_from_market(
                &id,
                Some(&update.version),
                true,
                auto_update,
                Some(granted),
            )?;
            results.push(installed);
        }
        Ok(results)
    }

    fn download_market_package(&self, info: &MarketDownloadInfo) -> Result<PathBuf> {
        let cache = self.data_dir.join("plugins/cache/download").join(format!(
            "{}-{}.piplug",
            sanitize_id(&info.plugin_id),
            sanitize_id(&info.version)
        ));
        if let Some(parent) = cache.parent() {
            fs::create_dir_all(parent)?;
        }
        let bytes = if let Some(path) = info.url.strip_prefix("file://") {
            fs::read(path).with_context(|| format!("read market package {path}"))?
        } else if info.url.starts_with("http://") || info.url.starts_with("https://") {
            // Refuse an off-allowlist host before any request leaves the
            // machine, then hold the redirect chain to the same rule.
            let catalog_url = self.market_source_url();
            package_host_allowed(&info.url, &catalog_url)?;
            download_url_guarded(&info.url, Some(&catalog_url))?
        } else {
            // Allow bare local paths in catalogs.
            fs::read(&info.url).with_context(|| format!("read market package {}", info.url))?
        };
        if bytes.len() as u64 > MAX_PACKAGE_BYTES {
            bail!("PLUGIN_INVALID: package exceeds 50MB limit");
        }
        let actual = sha256_hex(&bytes);
        if !actual.eq_ignore_ascii_case(&info.shasum) {
            bail!("PLUGIN_INTEGRITY: checksum mismatch");
        }
        fs::write(&cache, &bytes)?;
        Ok(cache)
    }

    fn to_market_summary(&self, entry: &MarketCatalogEntry) -> MarketPluginSummary {
        let latest_version = latest_market_version(&entry.versions);
        let latest = latest_version
            .map(|v| v.version.clone())
            .unwrap_or_else(|| "0.0.0".into());
        let installed = self.get(&entry.id);
        let catalog_url = self.market_source_url();
        MarketPluginSummary {
            id: entry.id.clone(),
            name: entry.name.clone(),
            description: entry.description.clone(),
            author: entry.author.clone(),
            icon_url: entry.icon_url.clone(),
            latest_version: latest.clone(),
            downloads: entry.downloads,
            updated_at: latest_version
                .map(|v| v.published_at.clone())
                .unwrap_or_else(|| Utc::now().to_rfc3339()),
            categories: entry.categories.clone(),
            permission_summary: latest_version
                .map(|v| v.permissions.clone())
                .unwrap_or_default(),
            verified: entry.verified,
            trust: self.resolve_trust(entry),
            publisher_id: entry.publisher_id.clone(),
            installed: installed.is_some(),
            installed_version: installed.as_ref().map(|p| p.version.clone()),
            update_available: installed
                .as_ref()
                .map(|p| p.version != latest)
                .unwrap_or(false),
            // An install the host would refuse must not be offered. That
            // covers an announced-but-unpublished version, a version pinned to
            // a newer app, and a package URL on a host the host will not fetch.
            installable: latest_version
                .map(|version| {
                    has_package_metadata(version)
                        && host_supports_version(version)
                        && (is_local_package_url(&version.url)
                            || package_host_allowed(&version.url, &catalog_url).is_ok())
                })
                .unwrap_or(false),
            // Every version withdrawn leaves nothing to offer, which is worth
            // showing as a withdrawal rather than as an empty version list.
            yanked: !entry.versions.is_empty() && latest_version.is_none(),
        }
    }

    /// Trust tier the client is willing to render for a catalog entry.
    ///
    /// `verified` is a claim about a publisher that only the plugin center can
    /// make, so it is honoured only from the source the user has configured as
    /// official or its mirror. A custom or enterprise catalog can describe its
    /// own plugins but cannot promote itself, and an entry that asserts an
    /// unrecognised tier falls back to `unknown` rather than being trusted.
    fn resolve_trust(&self, entry: &MarketCatalogEntry) -> String {
        let declared = entry
            .trust
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_ascii_lowercase)
            // A v1 catalog has no tier; its boolean is maintainer-written and
            // keeps its existing meaning.
            .unwrap_or_else(|| {
                if entry.verified {
                    "verified".into()
                } else {
                    "community".into()
                }
            });
        match declared.as_str() {
            "verified" if self.is_official_market_source() => "verified".into(),
            "verified" => "community".into(),
            "community" => "community".into(),
            _ => "unknown".into(),
        }
    }

    /// Whether the catalog in effect is the project's own source or its mirror.
    fn is_official_market_source(&self) -> bool {
        let url = self.market_source_url();
        url == OFFICIAL_MARKET_CATALOG_URL || url == MIRROR_MARKET_CATALOG_URL
    }
}

/// Whether the running host is new enough for a catalog version.
///
/// `minPiDesktop` is a publisher statement that older hosts cannot run the
/// release. Enforcing it before download turns "installed and immediately
/// broken" into a refusal the user can act on. An unparseable bound is ignored
/// rather than treated as blocking: a malformed catalog field should not make
/// a plugin uninstallable.
fn host_supports_version(version: &MarketVersion) -> bool {
    let Some(required) = version.min_pi_desktop.as_deref().map(str::trim) else {
        return true;
    };
    if required.is_empty() || ParsedPluginVersion::parse(required).is_none() {
        return true;
    }
    compare_plugin_versions(crate::state::HOST_VERSION, required) != Ordering::Less
}

/// Whether a catalog version carries everything an install needs.
///
/// A publisher can announce a version before its package is uploaded, so the
/// checksum and URL are optional in the catalog schema. Every surface that
/// offers an install decides against this predicate rather than assuming the
/// fields are present.
fn has_package_metadata(version: &MarketVersion) -> bool {
    !version.shasum.trim().is_empty() && !version.url.trim().is_empty()
}

/// Return the highest offerable semantic version in a marketplace entry.
///
/// Catalog producers are not required to preserve ordering, and older
/// catalogs did not consistently put the newest release first. Keep the
/// ordering rule in the host so search, detail, install, and update checks all
/// agree on the same release.
///
/// Yanked versions are skipped here rather than at each call site: every
/// caller of this function is choosing a version to offer, and a withdrawn
/// release must not be presented as the latest, downloaded, or applied as an
/// update. Detail responses keep the unfiltered list so version history still
/// shows what was withdrawn and why.
fn latest_market_version<'a>(versions: &'a [MarketVersion]) -> Option<&'a MarketVersion> {
    versions
        .iter()
        .filter(|version| !version.yanked)
        .max_by(|a, b| compare_plugin_versions(&a.version, &b.version))
}

fn compare_plugin_versions(left: &str, right: &str) -> Ordering {
    let parsed_left = ParsedPluginVersion::parse(left);
    let parsed_right = ParsedPluginVersion::parse(right);
    match (parsed_left, parsed_right) {
        (Some(left), Some(right)) => left.cmp(&right),
        (Some(_), None) => Ordering::Greater,
        (None, Some(_)) => Ordering::Less,
        (None, None) => left.cmp(right),
    }
}

#[derive(Debug, Eq, PartialEq)]
struct ParsedPluginVersion<'a> {
    core: Vec<u64>,
    prerelease: Vec<&'a str>,
}

impl<'a> ParsedPluginVersion<'a> {
    fn parse(version: &'a str) -> Option<Self> {
        let version = version.trim().strip_prefix('v').unwrap_or(version.trim());
        let version = version.split_once('+').map(|(v, _)| v).unwrap_or(version);
        let (core, prerelease) = version.split_once('-').unwrap_or((version, ""));
        let core = core
            .split('.')
            .map(|part| part.parse::<u64>().ok())
            .collect::<Option<Vec<_>>>()?;
        if core.is_empty()
            || core.len() > 3
            || (!prerelease.is_empty() && prerelease.split('.').any(|part| part.is_empty()))
        {
            return None;
        }
        Some(Self {
            core,
            prerelease: if prerelease.is_empty() {
                Vec::new()
            } else {
                prerelease.split('.').collect()
            },
        })
    }
}

impl Ord for ParsedPluginVersion<'_> {
    fn cmp(&self, other: &Self) -> Ordering {
        for (left, right) in self
            .core
            .iter()
            .copied()
            .chain(std::iter::repeat(0))
            .zip(other.core.iter().copied().chain(std::iter::repeat(0)))
            .take(3)
        {
            match left.cmp(&right) {
                Ordering::Equal => continue,
                order => return order,
            }
        }
        match (self.prerelease.is_empty(), other.prerelease.is_empty()) {
            (true, true) => Ordering::Equal,
            (true, false) => Ordering::Greater,
            (false, true) => Ordering::Less,
            (false, false) => {
                for (left, right) in self.prerelease.iter().zip(&other.prerelease) {
                    let order = match (left.parse::<u64>(), right.parse::<u64>()) {
                        (Ok(left), Ok(right)) => left.cmp(&right),
                        (Ok(_), Err(_)) => Ordering::Less,
                        (Err(_), Ok(_)) => Ordering::Greater,
                        (Err(_), Err(_)) => left.cmp(right),
                    };
                    if order != Ordering::Equal {
                        return order;
                    }
                }
                self.prerelease.len().cmp(&other.prerelease.len())
            }
        }
    }
}

impl PartialOrd for ParsedPluginVersion<'_> {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

fn built_in_catalog() -> MarketCatalogFile {
    let data_dir = std::env::var("PI_DESKTOP_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            dirs::home_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join(".pi-desktop")
        });
    let package_dir = data_dir.join("plugins/market/packages");
    let hello_path = package_dir.join("demo.hello-0.2.0.piplug");
    let notes_path = package_dir.join("demo.workspace-notes-0.1.0.piplug");
    let hello_bytes = bundled_package_bytes("demo.hello", "0.2.0").unwrap_or_default();
    let notes_bytes = bundled_package_bytes("demo.workspace-notes", "0.1.0").unwrap_or_default();
    MarketCatalogFile {
        schema_version: 1,
        provider_id: "official".into(),
        catalog_id: None,
        name: Some("PI-Desktop Official Plugins (bundled fallback)".into()),
        homepage: Some("https://github.com/vastsa/pi-desktop-plugins".into()),
        updated_at: Some("2026-07-28T00:00:00Z".into()),
        generated_at: None,
        policy_version: None,
        // The bundled fallback materializes packages next to the catalog, so
        // its URLs are already absolute `file://` paths.
        artifact_base_url: None,
        plugins: vec![
            MarketCatalogEntry {
                id: "demo.hello".into(),
                name: "Hello".into(),
                description: "Official sample plugin with panel, command, and echo tool.".into(),
                author: "PI-Desktop".into(),
                icon_url: None,
                categories: vec!["demo".into(), "official".into()],
                verified: true,
                downloads: Some(1280),
                homepage: Some("https://github.com/vastsa/PI-Desktop".into()),
                repository: Some("https://github.com/vastsa/PI-Desktop".into()),
                readme_markdown: Some(
                    "# Hello\n\nOfficial demo plugin used by the local marketplace provider.".into(),
                ),
                safety_notes: Some("Low risk demo. Registers one agent tool and one panel.".into()),
                versions: vec![MarketVersion {
                    version: "0.2.0".into(),
                    published_at: "2026-07-28T00:00:00Z".into(),
                    changelog: Some("Marketplace package with isolated panel bridge.".into()),
                    min_pi_desktop: Some(">=0.2.0".into()),
                    shasum: sha256_hex(&hello_bytes),
                    url: format!("file://{}", hello_path.to_string_lossy()),
                    size_bytes: hello_bytes.len() as u64,
                    permissions: vec![
                        "ui.panel".into(),
                        "agent.tool.register".into(),
                        "notify".into(),
                    ],
                    ..Default::default()
                }],
                ..Default::default()
            },
            MarketCatalogEntry {
                id: "demo.workspace-notes".into(),
                name: "Workspace Notes".into(),
                description: "Read/write a notes file in the current workspace and fetch optional snippets.".into(),
                author: "PI-Desktop".into(),
                icon_url: None,
                categories: vec!["productivity".into(), "official".into()],
                verified: true,
                downloads: Some(420),
                homepage: None,
                repository: None,
                readme_markdown: Some(
                    "# Workspace Notes\n\nDemonstrates high-risk plugin capabilities with explicit grants.".into(),
                ),
                safety_notes: Some(
                    "Requests workspace write and network access. Review permissions before install.".into(),
                ),
                versions: vec![MarketVersion {
                    version: "0.1.0".into(),
                    published_at: "2026-07-28T00:00:00Z".into(),
                    changelog: Some("Initial marketplace release.".into()),
                    min_pi_desktop: Some(">=0.2.0".into()),
                    shasum: sha256_hex(&notes_bytes),
                    url: format!("file://{}", notes_path.to_string_lossy()),
                    size_bytes: notes_bytes.len() as u64,
                    permissions: vec![
                        "ui.panel".into(),
                        "fs.read.workspace".into(),
                        "fs.write.workspace".into(),
                        "net.fetch".into(),
                        "shell.openExternal".into(),
                        "clipboard.read".into(),
                        "clipboard.write".into(),
                        "notify".into(),
                        "agent.tool.register".into(),
                    ],
                    ..Default::default()
                }],
                ..Default::default()
            },
        ],
    }
}

fn bundled_package_bytes(plugin_id: &str, version: &str) -> Option<Vec<u8>> {
    match (plugin_id, version) {
        ("demo.hello", "0.2.0") => Some(make_zip(&[
            (
                "manifest.json",
                br#"{
  "schemaVersion": 1,
  "id": "demo.hello",
  "name": "Hello",
  "version": "0.2.0",
  "description": "Official sample plugin with panel, command, and echo tool.",
  "author": "PI-Desktop",
  "main": "main.js",
  "ui": {
    "panel": "renderer/index.html",
    "width": 420,
    "height": 320,
    "title": "Hello Plugin"
  },
  "contributes": {
    "commands": [
      {
        "id": "hello.open",
        "title": "Hello: Open Panel",
        "keywords": ["hello", "demo"],
        "category": "Demo"
      }
    ],
    "agentTools": [
      {
        "name": "echo_text",
        "description": "Echo text back to the agent",
        "risk": "low",
        "schema": {
          "type": "object",
          "properties": { "text": { "type": "string" } },
          "required": ["text"]
        }
      }
    ],
    "settings": [
      {
        "key": "greeting",
        "type": "string",
        "default": "Hello from marketplace",
        "title": "Greeting"
      }
    ]
  },
  "permissions": ["ui.panel", "agent.tool.register", "notify"]
}"#,
            ),
            (
                "main.js",
                br#"async function onLoad() {
  const settings = await pi.plugin.getSettings();
  await pi.commands.register({
    id: "hello.open",
    title: "Hello: Open Panel",
    keywords: ["hello", "demo"],
    run: async () => {
      await pi.ui.openPanel({ title: "Hello Plugin" });
      await pi.ui.showToast(settings.greeting || "Hello from marketplace");
    },
  });
  await pi.agent.registerTool({
    name: "echo_text",
    description: "Echo text back to the agent",
    risk: "low",
    schema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
    execute: async (args) => ({
      ok: true,
      echo: String(args?.text ?? ""),
      pluginId: pi.plugin.getId(),
    }),
  });
}
async function onUnload() {
  await pi.commands.unregister("hello.open");
  await pi.agent.unregisterTool("echo_text");
}
module.exports = { onLoad, onUnload };
"#,
            ),
            (
                "renderer/index.html",
                br#"<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="pi-plugin-chrome" content="v2" />
    <title>Hello Plugin</title>
    <style>
      :root { color-scheme: dark; --bg: #181818; --surface: #212121; --fg: #ffffff; --muted: color-mix(in oklab, #ffffff 52%, transparent); --border: color-mix(in oklab, #ffffff 10%, transparent); --accent: #ffffff; }
      :root[data-base="light"] { color-scheme: light; --bg: #ffffff; --surface: #f9f9f9; --fg: #1a1c1f; --muted: #5d5d5d; --border: color-mix(in oklab, #1a1c1f 10%, transparent); --accent: #1a1c1f; }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; padding: var(--pi-plugin-titlebar-height, 0px) 16px 16px; overflow: auto; background: var(--bg); color: var(--fg); }
      /* PI-Desktop reserves exactly a transparent 46px drag band. Normal-flow
         content is offset automatically; fixed/sticky top UI starts at
         top: var(--pi-plugin-titlebar-height, 46px). */
      .card { border: 1px solid var(--border); border-radius: 12px; padding: 16px; background: var(--surface); }
      h2 { margin: 0 0 4px; font-size: 16px; font-weight: 560; letter-spacing: -0.02em; }
      p { margin: 0; color: var(--muted); }
      button { margin-top: 12px; border: 1px solid var(--border); border-radius: 8px; padding: 8px 12px; background: var(--accent); color: var(--bg); cursor: pointer; font: inherit; }
      button:focus-visible { outline: 2px solid color-mix(in oklab, var(--accent) 58%, transparent); outline-offset: 2px; }
    </style>
  </head>
  <body>
    <div class="card">
      <h2>Hello Plugin</h2>
      <p>Isolated marketplace panel with host bridge.</p>
      <button id="ping">Toast Ping</button>
    </div>
    <script>
      const applyAppearance = (appearance) => {
        const base = appearance?.base;
        document.documentElement.dataset.base = base === "light" || base === "dark"
          ? base
          : window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
      };
      window.pluginBridge?.on("appearance:changed", applyAppearance);
      window.pluginBridge?.invoke("app.getAppearance").then(applyAppearance).catch(() => applyAppearance(null));
      document.getElementById("ping").addEventListener("click", async () => {
        if (window.pluginBridge?.invoke) {
          await window.pluginBridge.invoke("ui.showToast", { message: "Hello panel bridge" });
        }
      });
    </script>
  </body>
</html>
"#,
            ),
        ])),
        ("demo.workspace-notes", "0.1.0") => Some(make_zip(&[
            (
                "manifest.json",
                br#"{
  "schemaVersion": 1,
  "id": "demo.workspace-notes",
  "name": "Workspace Notes",
  "version": "0.1.0",
  "description": "Read/write workspace notes and fetch remote snippets with explicit high-risk grants.",
  "author": "PI-Desktop",
  "main": "main.js",
  "ui": {
    "panel": "renderer/index.html",
    "width": 480,
    "height": 420,
    "title": "Workspace Notes"
  },
  "contributes": {
    "commands": [
      {
        "id": "notes.open",
        "title": "Notes: Open Panel",
        "keywords": ["notes", "workspace"],
        "category": "Productivity"
      }
    ],
    "agentTools": [
      {
        "name": "save_note",
        "description": "Append a note to NOTES.md in the workspace",
        "risk": "high",
        "schema": {
          "type": "object",
          "properties": { "text": { "type": "string" } },
          "required": ["text"]
        }
      }
    ]
  },
  "permissions": [
    "ui.panel",
    "fs.read.workspace",
    "fs.write.workspace",
    "net.fetch",
    "shell.openExternal",
    "clipboard.read",
    "clipboard.write",
    "notify",
    "agent.tool.register"
  ]
}"#,
            ),
            (
                "main.js",
                br#"const NOTE_FILE = "NOTES.md";
async function onLoad() {
  await pi.commands.register({
    id: "notes.open",
    title: "Notes: Open Panel",
    keywords: ["notes", "workspace"],
    run: async () => {
      await pi.ui.openPanel({ title: "Workspace Notes" });
    },
  });
  await pi.agent.registerTool({
    name: "save_note",
    description: "Append a note to NOTES.md in the workspace",
    risk: "high",
    schema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
    execute: async (args) => {
      const text = String(args?.text ?? "").trim();
      let current = "";
      try { current = await pi.fs.readText(NOTE_FILE); } catch {}
      const next = current ? `${current.trimEnd()}\n- ${text}\n` : `# Notes\n\n- ${text}\n`;
      await pi.fs.writeText(NOTE_FILE, next);
      await pi.ui.notify({ title: "Note saved", body: text.slice(0, 80) });
      return { ok: true, path: NOTE_FILE, bytes: next.length };
    },
  });
}
async function onUnload() {
  await pi.commands.unregister("notes.open");
  await pi.agent.unregisterTool("save_note");
}
module.exports = { onLoad, onUnload };
"#,
            ),
            (
                "renderer/index.html",
                br#"<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="pi-plugin-chrome" content="v2" />
  <title>Workspace Notes</title>
  <style>
    :root { color-scheme: dark; --bg: #181818; --surface: #212121; --fg: #ffffff; --muted: color-mix(in oklab, #ffffff 52%, transparent); --border: color-mix(in oklab, #ffffff 10%, transparent); --accent: #ffffff; }
    :root[data-base="light"] { color-scheme: light; --bg: #ffffff; --surface: #f9f9f9; --fg: #1a1c1f; --muted: #5d5d5d; --border: color-mix(in oklab, #1a1c1f 10%, transparent); --accent: #1a1c1f; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--fg); padding: var(--pi-plugin-titlebar-height, 0px) 16px 16px; overflow: auto; }
    /* PI-Desktop reserves exactly a transparent 46px drag band. Normal-flow
       content is offset automatically; fixed/sticky top UI starts at
       top: var(--pi-plugin-titlebar-height, 46px). */
    textarea { width: 100%; min-height: 180px; border-radius: 10px; border: 1px solid var(--border); background: var(--surface); color: inherit; padding: 10px; box-sizing: border-box; font: inherit; }
    .row { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
    button { border: 1px solid var(--border); border-radius: 8px; padding: 8px 12px; background: var(--accent); color: var(--bg); cursor: pointer; font: inherit; }
    button.secondary { background: var(--surface); color: var(--fg); }
    .meta { color: var(--muted); font-size: 12px; margin-bottom: 8px; }
  </style>
</head>
<body>
  <div class="meta">High-risk demo: workspace files, clipboard, network, external links.</div>
  <textarea id="notes" placeholder="Workspace NOTES.md"></textarea>
  <div class="row">
    <button id="reload">Reload</button>
    <button id="save">Save</button>
    <button class="secondary" id="clip">Copy</button>
    <button class="secondary" id="fetch">Fetch sample</button>
    <button class="secondary" id="docs">Open docs</button>
  </div>
  <script>
    const applyAppearance = (appearance) => {
      const base = appearance?.base;
      document.documentElement.dataset.base = base === "light" || base === "dark"
        ? base
        : window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
    };
    window.pluginBridge?.on("appearance:changed", applyAppearance);
    window.pluginBridge?.invoke("app.getAppearance").then(applyAppearance).catch(() => applyAppearance(null));
    const notes = document.getElementById('notes');
    async function reload() {
      try { notes.value = await window.pluginBridge.invoke('fs.readText', { path: 'NOTES.md' }); }
      catch { notes.value = '# Notes\n\n'; }
    }
    document.getElementById('reload').onclick = reload;
    document.getElementById('save').onclick = async () => {
      await window.pluginBridge.invoke('fs.writeText', { path: 'NOTES.md', content: notes.value });
      await window.pluginBridge.invoke('ui.showToast', { message: 'Saved NOTES.md' });
    };
    document.getElementById('clip').onclick = async () => {
      await window.pluginBridge.invoke('clipboard.writeText', { text: notes.value });
      await window.pluginBridge.invoke('ui.showToast', { message: 'Copied to clipboard' });
    };
    document.getElementById('fetch').onclick = async () => {
      const res = await window.pluginBridge.invoke('net.fetch', {
        url: 'https://example.com',
        method: 'GET',
        timeoutMs: 8000,
      });
      notes.value = `${notes.value.trim()}\n\n<!-- fetched status ${res.status} -->\n`;
    };
    document.getElementById('docs').onclick = async () => {
      await window.pluginBridge.invoke('shell.openExternal', { url: 'https://example.com' });
    };
    reload();
  </script>
</body>
</html>
"#,
            ),
        ])),
        _ => None,
    }
}

fn make_zip(files: &[(&str, &[u8])]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut offset: u32 = 0;
    let mut central = Vec::new();
    let mut entries = 0u16;
    for (name, data) in files {
        let name_bytes = name.as_bytes();
        let crc = crc32(data);
        let mut local = Vec::new();
        local.extend_from_slice(&0x04034b50u32.to_le_bytes());
        local.extend_from_slice(&20u16.to_le_bytes()); // version needed
        local.extend_from_slice(&0u16.to_le_bytes()); // flags
        local.extend_from_slice(&0u16.to_le_bytes()); // method store
        local.extend_from_slice(&0u16.to_le_bytes()); // time
        local.extend_from_slice(&0u16.to_le_bytes()); // date
        local.extend_from_slice(&crc.to_le_bytes());
        local.extend_from_slice(&(data.len() as u32).to_le_bytes());
        local.extend_from_slice(&(data.len() as u32).to_le_bytes());
        local.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
        local.extend_from_slice(&0u16.to_le_bytes()); // extra
        local.extend_from_slice(name_bytes);
        local.extend_from_slice(data);
        out.extend_from_slice(&local);

        let mut cen = Vec::new();
        cen.extend_from_slice(&0x02014b50u32.to_le_bytes());
        cen.extend_from_slice(&20u16.to_le_bytes());
        cen.extend_from_slice(&20u16.to_le_bytes());
        cen.extend_from_slice(&0u16.to_le_bytes());
        cen.extend_from_slice(&0u16.to_le_bytes());
        cen.extend_from_slice(&0u16.to_le_bytes());
        cen.extend_from_slice(&0u16.to_le_bytes());
        cen.extend_from_slice(&crc.to_le_bytes());
        cen.extend_from_slice(&(data.len() as u32).to_le_bytes());
        cen.extend_from_slice(&(data.len() as u32).to_le_bytes());
        cen.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
        cen.extend_from_slice(&0u16.to_le_bytes());
        cen.extend_from_slice(&0u16.to_le_bytes());
        cen.extend_from_slice(&0u16.to_le_bytes());
        cen.extend_from_slice(&0u16.to_le_bytes());
        cen.extend_from_slice(&0u32.to_le_bytes());
        cen.extend_from_slice(&offset.to_le_bytes());
        cen.extend_from_slice(name_bytes);
        central.extend_from_slice(&cen);
        offset += local.len() as u32;
        entries += 1;
    }
    let central_offset = out.len() as u32;
    out.extend_from_slice(&central);
    let central_size = central.len() as u32;
    out.extend_from_slice(&0x06054b50u32.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&entries.to_le_bytes());
    out.extend_from_slice(&entries.to_le_bytes());
    out.extend_from_slice(&central_size.to_le_bytes());
    out.extend_from_slice(&central_offset.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out
}

fn extract_zip_bytes(bytes: &[u8], dest: &Path) -> Result<()> {
    if bytes.len() < 22 {
        bail!("PLUGIN_INVALID: zip too small");
    }
    let mut file_count = 0usize;
    let mut total_bytes = 0u64;
    let mut offset = 0usize;
    while offset + 30 <= bytes.len() {
        let sig = read_u32(bytes, offset)?;
        if sig == 0x02014b50 || sig == 0x06054b50 {
            break;
        }
        if sig != 0x04034b50 {
            bail!("PLUGIN_INVALID: bad zip local header");
        }
        let method = read_u16(bytes, offset + 8)?;
        let comp_size = read_u32(bytes, offset + 18)? as usize;
        let uncomp_size = read_u32(bytes, offset + 22)? as u64;
        let name_len = read_u16(bytes, offset + 26)? as usize;
        let extra_len = read_u16(bytes, offset + 28)? as usize;
        let name_start = offset + 30;
        let name_end = name_start + name_len;
        if name_end + extra_len + comp_size > bytes.len() {
            bail!("PLUGIN_INVALID: zip entry truncated");
        }
        let name = std::str::from_utf8(&bytes[name_start..name_end])
            .map_err(|_| anyhow!("PLUGIN_INVALID: zip name not utf8"))?;
        if method != 0 {
            bail!("PLUGIN_INVALID: only store-compressed piplug supported");
        }
        let data_start = name_end + extra_len;
        let data_end = data_start + comp_size;
        let data = &bytes[data_start..data_end];
        total_bytes += uncomp_size;
        if total_bytes > MAX_PACKAGE_BYTES {
            bail!("PLUGIN_INVALID: package exceeds 50MB limit");
        }
        file_count += 1;
        if file_count > MAX_PACKAGE_FILES {
            bail!("PLUGIN_INVALID: too many files in package");
        }
        if name.ends_with('/') {
            let dir = safe_join(dest, name)?;
            fs::create_dir_all(dir)?;
        } else {
            let path = safe_join(dest, name)?;
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::write(path, data)?;
        }
        offset = data_end;
    }
    Ok(())
}

fn find_plugin_root(extract_dir: &Path) -> Result<PathBuf> {
    let direct = extract_dir.join("manifest.json");
    if direct.exists() {
        return Ok(extract_dir.to_path_buf());
    }
    for entry in fs::read_dir(extract_dir)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            let candidate = entry.path();
            if candidate.join("manifest.json").exists() {
                return Ok(candidate);
            }
        }
    }
    bail!("PLUGIN_INVALID: manifest.json missing in package")
}

fn copy_dir_filtered(src: &Path, dest: &Path) -> Result<()> {
    fs::create_dir_all(dest)?;
    let mut file_count = 0usize;
    let mut total_bytes = 0u64;
    fn walk(from: &Path, to: &Path, file_count: &mut usize, total_bytes: &mut u64) -> Result<()> {
        for entry in fs::read_dir(from)? {
            let entry = entry?;
            let file_type = entry.file_type()?;
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if name_str == ".git" || name_str == "node_modules" {
                continue;
            }
            let target = to.join(&name);
            if file_type.is_symlink() {
                bail!("PLUGIN_INVALID: symlinks are not allowed");
            } else if file_type.is_dir() {
                fs::create_dir_all(&target)?;
                walk(&entry.path(), &target, file_count, total_bytes)?;
            } else if file_type.is_file() {
                *file_count += 1;
                if *file_count > MAX_PACKAGE_FILES {
                    bail!("PLUGIN_INVALID: too many files in package");
                }
                let meta = entry.metadata()?;
                *total_bytes += meta.len();
                if *total_bytes > MAX_PACKAGE_BYTES {
                    bail!("PLUGIN_INVALID: package exceeds 50MB limit");
                }
                if let Some(parent) = target.parent() {
                    fs::create_dir_all(parent)?;
                }
                fs::copy(entry.path(), &target)?;
            }
        }
        Ok(())
    }
    walk(src, dest, &mut file_count, &mut total_bytes)
}

fn safe_join(base: &Path, rel: &str) -> Result<PathBuf> {
    let rel = rel.replace('\\', "/");
    if rel.starts_with('/') || rel.contains(':') {
        bail!("PLUGIN_INVALID: absolute paths are not allowed");
    }
    let mut out = base.to_path_buf();
    for comp in Path::new(&rel).components() {
        match comp {
            Component::Normal(p) => out.push(p),
            Component::CurDir => {}
            Component::ParentDir => bail!("PLUGIN_INVALID: path traversal is not allowed"),
            _ => bail!("PLUGIN_INVALID: unsupported path component"),
        }
    }
    if !out.starts_with(base) {
        bail!("PLUGIN_INVALID: path escaped package root");
    }
    Ok(out)
}

/// Validate the contribution kinds the host activates.
///
/// Paths must stay inside the plugin directory and exist, MCP endpoints must be
/// launchable/reachable without shell interpretation, and every new capability
/// must be backed by its declared permission. `skills` predates the permission
/// gate, so a missing `agent.prompt.inject` only stops activation at runtime.
fn validate_contributions(root: &Path, manifest: &PluginManifest) -> Result<()> {
    let Some(contributes) = manifest.contributes.as_ref() else {
        return Ok(());
    };
    if contributes.is_null() {
        return Ok(());
    }
    let Some(map) = contributes.as_object() else {
        bail!("PLUGIN_INVALID: contributes must be an object");
    };

    if let Some(settings) = map.get("settings") {
        let entries = array_of(settings, "contributes.settings")?;
        let mut seen: Vec<&str> = Vec::new();
        let command_ids: Vec<&str> = map
            .get("commands")
            .and_then(Value::as_array)
            .map(|commands| {
                commands
                    .iter()
                    .filter_map(|command| command.get("id").and_then(Value::as_str))
                    .collect()
            })
            .unwrap_or_default();
        for entry in entries {
            let obj = entry.as_object().ok_or_else(|| {
                anyhow!("PLUGIN_INVALID: contributes.settings entry must be an object")
            })?;
            let key = obj
                .get("key")
                .and_then(Value::as_str)
                .filter(|key| is_setting_key(key))
                .ok_or_else(|| anyhow!("PLUGIN_INVALID: setting key is missing or invalid"))?;
            if seen.contains(&key) {
                bail!("PLUGIN_INVALID: duplicate setting key {key}");
            }
            seen.push(key);
            if obj
                .get("title")
                .and_then(Value::as_str)
                .map(|title| title.trim().is_empty())
                .unwrap_or(true)
            {
                bail!("PLUGIN_INVALID: setting {key} requires a title");
            }
            let setting_type = obj
                .get("type")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow!("PLUGIN_INVALID: setting {key} requires a type"))?;
            if !matches!(setting_type, "string" | "number" | "boolean" | "select" | "json" | "shortcut") {
                bail!("PLUGIN_INVALID: setting {key} has unsupported type {setting_type}");
            }
            if obj.get("secret").and_then(Value::as_bool) == Some(true) {
                bail!("PLUGIN_INVALID: setting {key} cannot be secret in this release");
            }
            if setting_type == "shortcut" {
                if let Some(scope) = obj.get("scope").and_then(Value::as_str) {
                    if scope != "plugin" {
                        bail!("PLUGIN_INVALID: setting {key} only supports the plugin shortcut scope");
                    }
                }
                if obj
                    .get("command")
                    .and_then(Value::as_str)
                    .map(|command| command.trim().is_empty())
                    .unwrap_or(true)
                {
                    bail!("PLUGIN_INVALID: shortcut setting {key} requires a command");
                }
                let command = obj.get("command").and_then(Value::as_str).unwrap_or_default();
                if !command_ids.contains(&command) {
                    bail!("PLUGIN_INVALID: shortcut setting {key} references an undeclared command");
                }
                if let Some(default) = obj.get("default") {
                    if !is_shortcut_shape(default) {
                        bail!("PLUGIN_INVALID: shortcut setting {key} has an invalid default");
                    }
                }
            }
            if setting_type == "select" {
                let options = obj
                    .get("enum")
                    .and_then(Value::as_array)
                    .filter(|options| !options.is_empty())
                    .ok_or_else(|| anyhow!("PLUGIN_INVALID: select setting {key} requires enum options"))?;
                for option in options {
                    let option = option.as_object().ok_or_else(|| {
                        anyhow!("PLUGIN_INVALID: select setting {key} has an invalid enum option")
                    })?;
                    if option.get("label").and_then(Value::as_str).is_none()
                        || !option
                            .get("value")
                            .map(|value| value.is_string() || value.is_number() || value.is_boolean())
                            .unwrap_or(false)
                    {
                        bail!("PLUGIN_INVALID: select setting {key} has an invalid enum option");
                    }
                }
            }
        }
    }

    if let Some(skills) = map.get("skills") {
        let entries = array_of(skills, "contributes.skills")?;
        for entry in entries {
            let path = match entry {
                Value::String(s) => s.as_str(),
                Value::Object(obj) => obj.get("path").and_then(Value::as_str).ok_or_else(|| {
                    anyhow!("PLUGIN_INVALID: contributes.skills entry needs path")
                })?,
                _ => bail!("PLUGIN_INVALID: contributes.skills entry must be a string or object"),
            };
            let resolved = safe_join(root, path)?;
            if !resolved.exists() {
                bail!("PLUGIN_INVALID: skill file missing: {path}");
            }
        }
    }

    if let Some(themes) = map.get("themes") {
        let entries = array_of(themes, "contributes.themes")?;
        if !entries.is_empty() {
            require_permission(manifest, "ui.theme", "themes")?;
        }
        let mut seen: Vec<&str> = Vec::new();
        for entry in entries {
            let obj = entry.as_object().ok_or_else(|| {
                anyhow!("PLUGIN_INVALID: contributes.themes entry must be an object")
            })?;
            let id = obj
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| is_contrib_id(id))
                .ok_or_else(|| anyhow!("PLUGIN_INVALID: theme id is missing or invalid"))?;
            if seen.contains(&id) {
                bail!("PLUGIN_INVALID: duplicate theme id {id}");
            }
            seen.push(id);
            if obj
                .get("label")
                .and_then(Value::as_str)
                .map(|l| l.trim().is_empty())
                .unwrap_or(true)
            {
                bail!("PLUGIN_INVALID: theme {id} requires a label");
            }
            let path = obj
                .get("path")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow!("PLUGIN_INVALID: theme {id} requires a path"))?;
            if !path.to_ascii_lowercase().ends_with(".css") {
                bail!("PLUGIN_INVALID: theme {id} path must be a .css file");
            }
            let resolved = safe_join(root, path)?;
            if !resolved.exists() {
                bail!("PLUGIN_INVALID: theme css missing: {path}");
            }
            match obj.get("base").and_then(Value::as_str) {
                None | Some("light") | Some("dark") => {}
                Some(other) => bail!("PLUGIN_INVALID: theme {id} base {other} is not supported"),
            }
        }
    }

    if let Some(views) = map.get("views") {
        let entries = array_of(views, "contributes.views")?;
        if !entries.is_empty() {
            require_permission(manifest, "ui.view", "views")?;
        }
        let mut seen: Vec<&str> = Vec::new();
        for entry in entries {
            let obj = entry.as_object().ok_or_else(|| {
                anyhow!("PLUGIN_INVALID: contributes.views entry must be an object")
            })?;
            let id = obj
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| is_contrib_id(id))
                .ok_or_else(|| anyhow!("PLUGIN_INVALID: view id is missing or invalid"))?;
            if seen.contains(&id) {
                bail!("PLUGIN_INVALID: duplicate view id {id}");
            }
            seen.push(id);
            // A title may be a plain string or a { en, "zh-CN" } object; the
            // per-locale completeness check belongs to the SDK validator, which
            // the packaging tool runs. Here we only require something rendered.
            let has_title = match obj.get("title") {
                Some(Value::String(s)) => !s.trim().is_empty(),
                Some(Value::Object(map)) => map
                    .values()
                    .any(|v| v.as_str().map(|s| !s.trim().is_empty()).unwrap_or(false)),
                _ => false,
            };
            if !has_title {
                bail!("PLUGIN_INVALID: view {id} requires a title");
            }
            let entry_path = obj
                .get("entry")
                .and_then(Value::as_str)
                .filter(|entry| !entry.trim().is_empty())
                .ok_or_else(|| anyhow!("PLUGIN_INVALID: view {id} requires an entry"))?;
            let resolved = safe_join(root, entry_path)?;
            if !resolved.exists() {
                bail!("PLUGIN_INVALID: view entry missing: {entry_path}");
            }
        }
    }

    if let Some(servers) = map.get("mcpServers") {
        let entries = array_of(servers, "contributes.mcpServers")?;
        let mut seen: Vec<&str> = Vec::new();
        for entry in entries {
            let obj = entry.as_object().ok_or_else(|| {
                anyhow!("PLUGIN_INVALID: contributes.mcpServers entry must be an object")
            })?;
            let id = obj
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| is_contrib_id(id))
                .ok_or_else(|| anyhow!("PLUGIN_INVALID: mcp server id is missing or invalid"))?;
            if seen.contains(&id) {
                bail!("PLUGIN_INVALID: duplicate mcp server id {id}");
            }
            seen.push(id);
            match obj.get("transport").and_then(Value::as_str) {
                Some("stdio") => {
                    require_permission(manifest, "mcp.server.local", "stdio mcp servers")?;
                    if obj.contains_key("url") || obj.contains_key("headers") {
                        bail!("PLUGIN_INVALID: mcp server {id} must not set url or headers");
                    }
                    let command = obj
                        .get("command")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|c| !c.is_empty())
                        .ok_or_else(|| {
                            anyhow!("PLUGIN_INVALID: mcp server {id} requires command")
                        })?;
                    if command.contains('/') || command.contains('\\') {
                        let resolved = safe_join(root, command)?;
                        if !resolved.exists() {
                            bail!("PLUGIN_INVALID: mcp server {id} command missing: {command}");
                        }
                    } else if !command
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '+' | '-'))
                    {
                        bail!("PLUGIN_INVALID: mcp server {id} command is not an executable name");
                    }
                    if let Some(args) = obj.get("args") {
                        for arg in array_of(args, "mcp server args")? {
                            if !arg.is_string() {
                                bail!("PLUGIN_INVALID: mcp server {id} args must be strings");
                            }
                        }
                    }
                }
                Some("http") => {
                    require_permission(manifest, "mcp.server.remote", "remote mcp servers")?;
                    if obj.contains_key("command")
                        || obj.contains_key("args")
                        || obj.contains_key("env")
                    {
                        bail!("PLUGIN_INVALID: mcp server {id} must not set command, args or env");
                    }
                    let url = obj
                        .get("url")
                        .and_then(Value::as_str)
                        .ok_or_else(|| anyhow!("PLUGIN_INVALID: mcp server {id} requires url"))?;
                    validate_mcp_url(id, url)?;
                }
                _ => bail!("PLUGIN_INVALID: mcp server {id} transport must be stdio or http"),
            }
        }
    }

    if let Some(services) = map.get("services") {
        let entries = array_of(services, "contributes.services")?;
        if !entries.is_empty() {
            require_permission(manifest, "background.service", "background services")?;
        }
        let mut seen: Vec<&str> = Vec::new();
        for entry in entries {
            let obj = entry.as_object().ok_or_else(|| {
                anyhow!("PLUGIN_INVALID: contributes.services entry must be an object")
            })?;
            let id = obj
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| is_contrib_id(id))
                .ok_or_else(|| anyhow!("PLUGIN_INVALID: service id is missing or invalid"))?;
            if seen.contains(&id) {
                bail!("PLUGIN_INVALID: duplicate service id {id}");
            }
            seen.push(id);
        }
    }

    if let Some(bus) = map.get("bus") {
        let obj = bus
            .as_object()
            .ok_or_else(|| anyhow!("PLUGIN_INVALID: contributes.bus must be an object"))?;
        let publish = obj
            .get("publish")
            .map(|v| array_of(v, "contributes.bus.publish"))
            .transpose()?;
        let subscribe = obj
            .get("subscribe")
            .map(|v| array_of(v, "contributes.bus.subscribe"))
            .transpose()?;
        if publish.map(|p| !p.is_empty()).unwrap_or(false) {
            require_permission(manifest, "bus.publish", "bus publishing")?;
        }
        if subscribe.map(|s| !s.is_empty()).unwrap_or(false) {
            require_permission(manifest, "bus.subscribe", "bus subscriptions")?;
        }
        for topic in publish.unwrap_or(&[]) {
            let topic = topic
                .as_str()
                .ok_or_else(|| anyhow!("PLUGIN_INVALID: bus publish topics must be strings"))?;
            if !is_bus_topic(topic, false) {
                bail!("PLUGIN_INVALID: bus publish topic {topic} is not a valid topic");
            }
        }
        for pattern in subscribe.unwrap_or(&[]) {
            let pattern = pattern
                .as_str()
                .ok_or_else(|| anyhow!("PLUGIN_INVALID: bus subscribe patterns must be strings"))?;
            if !is_bus_topic(pattern, true) {
                bail!("PLUGIN_INVALID: bus subscribe pattern {pattern} is not valid");
            }
        }
    }

    Ok(())
}

fn is_setting_key(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .chars()
            .next()
            .map(|ch| ch.is_ascii_alphabetic())
            .unwrap_or(false)
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
}

fn is_shortcut_shape(value: &Value) -> bool {
    let Some(value) = value.as_str() else {
        return false;
    };
    let parts: Vec<&str> = value.split('+').filter(|part| !part.is_empty()).collect();
    if parts.len() < 2 && !matches!(parts.first(), Some(key) if key.starts_with('F') && key[1..].parse::<u8>().map(|n| (1..=12).contains(&n)).unwrap_or(false)) {
        return false;
    }
    let Some(key) = parts.last() else {
        return false;
    };
    let named = matches!(
        *key,
        "Enter" | "Space" | "Tab" | "Backspace" | "Delete" | "Insert" | "Home" | "End"
            | "PageUp" | "PageDown" | "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight"
            | "Comma" | "Period" | "Equal" | "Minus" | "Slash" | "Backslash" | "Semicolon"
            | "Quote" | "BracketLeft" | "BracketRight" | "Backquote"
    );
    let alpha_numeric = key.len() == 1 && key.chars().all(|ch| ch.is_ascii_alphanumeric());
    let function_key = key.starts_with('F')
        && key[1..]
            .parse::<u8>()
            .map(|number| (1..=12).contains(&number))
            .unwrap_or(false);
    if !(named || alpha_numeric || function_key) {
        return false;
    }
    parts[..parts.len().saturating_sub(1)]
        .iter()
        .all(|part| matches!(*part, "Mod" | "Ctrl" | "Alt" | "Shift"))
}

fn derive_settings(manifest: &PluginManifest) -> Vec<PluginSettingDefinition> {
    let Some(entries) = manifest
        .contributes
        .as_ref()
        .and_then(Value::as_object)
        .and_then(|map| map.get("settings"))
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };
    entries
        .iter()
        .filter_map(|entry| {
            let obj = entry.as_object()?;
            Some(PluginSettingDefinition {
                key: obj.get("key")?.as_str()?.to_string(),
                title: obj.get("title")?.as_str()?.to_string(),
                description: obj
                    .get("description")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                setting_type: obj.get("type")?.as_str()?.to_string(),
                default: obj.get("default").cloned(),
                enum_values: obj
                    .get("enum")
                    .and_then(Value::as_array)
                    .map(|values| {
                        values
                            .iter()
                            .filter_map(|value| {
                                let option = value.as_object()?;
                                Some(PluginSettingOption {
                                    label: option.get("label")?.as_str()?.to_string(),
                                    value: option.get("value")?.clone(),
                                })
                            })
                            .collect()
                    })
                    .unwrap_or_default(),
                command: obj
                    .get("command")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                scope: "plugin".into(),
            })
        })
        .collect()
}

/// Capability tokens the UI renders as badges.
fn derive_capabilities(manifest: &PluginManifest) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    if manifest
        .ui
        .as_ref()
        .and_then(|ui| ui.panel.as_ref())
        .is_some()
    {
        out.push("panel".into());
    }
    let map = manifest.contributes.as_ref().and_then(Value::as_object);
    let has = |key: &str| -> bool {
        map.and_then(|m| m.get(key))
            .and_then(Value::as_array)
            .map(|a| !a.is_empty())
            .unwrap_or(false)
    };
    if has("commands") {
        out.push("commands".into());
    }
    if has("views") {
        out.push("views".into());
    }
    if has("agentTools") {
        out.push("tools".into());
    }
    if has("skills") {
        out.push("skills".into());
    }
    if has("themes") {
        out.push("themes".into());
    }
    if has("mcpServers") {
        out.push("mcp".into());
    }
    if has("services") {
        out.push("services".into());
    }
    let bus_declared = map
        .and_then(|m| m.get("bus"))
        .and_then(Value::as_object)
        .map(|bus| {
            ["publish", "subscribe"].iter().any(|key| {
                bus.get(*key)
                    .and_then(Value::as_array)
                    .map(|a| !a.is_empty())
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false);
    if bus_declared {
        out.push("bus".into());
    }
    out
}

fn array_of<'a>(value: &'a Value, field: &str) -> Result<&'a [Value]> {
    value
        .as_array()
        .map(|a| a.as_slice())
        .ok_or_else(|| anyhow!("PLUGIN_INVALID: {field} must be an array"))
}

fn require_permission(manifest: &PluginManifest, permission: &str, what: &str) -> Result<()> {
    if manifest.permissions.iter().any(|p| p == permission) {
        return Ok(());
    }
    bail!("PLUGIN_INVALID: {what} require the {permission} permission")
}

fn is_contrib_id(value: &str) -> bool {
    if value.is_empty() || value.len() > 64 {
        return false;
    }
    let mut chars = value.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// Shares the topic grammar with `matchesBusTopic` in the plugin SDK.
fn is_bus_topic(value: &str, allow_wildcards: bool) -> bool {
    if value.is_empty() || value.len() > 128 {
        return false;
    }
    let segments: Vec<&str> = value.split('.').collect();
    if segments.len() > 8 {
        return false;
    }
    segments.iter().enumerate().all(|(index, segment)| {
        if allow_wildcards && *segment == "*" {
            return true;
        }
        if allow_wildcards && *segment == "**" {
            return index == segments.len() - 1;
        }
        let mut chars = segment.chars();
        match chars.next() {
            Some(c) if c.is_ascii_alphanumeric() => {}
            _ => return false,
        }
        chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    })
}

fn validate_mcp_url(id: &str, url: &str) -> Result<()> {
    let lower = url.trim().to_ascii_lowercase();
    let rest = if let Some(rest) = lower.strip_prefix("https://") {
        rest
    } else if let Some(rest) = lower.strip_prefix("http://") {
        rest
    } else {
        bail!("PLUGIN_INVALID: mcp server {id} url must use http or https");
    };
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..authority_end];
    if authority.is_empty() {
        bail!("PLUGIN_INVALID: mcp server {id} url is missing a host");
    }
    if authority.contains('@') {
        bail!("PLUGIN_INVALID: mcp server {id} url must not embed credentials");
    }
    let host = if let Some(stripped) = authority.strip_prefix('[') {
        match stripped.find(']') {
            Some(close) => &stripped[..close],
            None => bail!("PLUGIN_INVALID: mcp server {id} url host is malformed"),
        }
    } else {
        authority.split(':').next().unwrap_or(authority)
    };
    if host.is_empty() {
        bail!("PLUGIN_INVALID: mcp server {id} url is missing a host");
    }
    Ok(())
}

fn is_loopback_host(host: &str) -> bool {
    host == "localhost" || host == "::1" || host == "0:0:0:0:0:0:0:1" || host.starts_with("127.")
}

/// Hosts a marketplace package may be downloaded from.
///
/// A v1 catalog kept every package under one repository, so the checksum was
/// the only control that mattered. Catalog v2 package URLs describe a
/// publisher-influenced release, so the host also has to constrain where the
/// request goes. Matching is exact or dot-suffix, which covers
/// `objects.githubusercontent.com`, `release-assets.githubusercontent.com`,
/// and `codeload.github.com` without needing a client release each time
/// GitHub rotates a release-asset host.
const PACKAGE_HOST_ALLOWLIST: &[&str] = &["github.com", "githubusercontent.com", "cnb.cool"];

fn host_matches_allowlist_entry(host: &str, allowed: &str) -> bool {
    host == allowed || host.ends_with(&format!(".{allowed}"))
}

/// Lowercase host of an `http(s)` URL, rejecting embedded credentials.
///
/// Credentials in a package URL would let a catalog entry aim an
/// authenticated request at a host the user never chose, so they are refused
/// rather than stripped.
fn package_url_host(url: &str) -> Result<(String, bool)> {
    let trimmed = url.trim();
    let lower = trimmed.to_ascii_lowercase();
    let (rest, plain_http) = if let Some(rest) = lower.strip_prefix("https://") {
        (rest, false)
    } else if let Some(rest) = lower.strip_prefix("http://") {
        (rest, true)
    } else {
        bail!("PLUGIN_MARKET_UNTRUSTED_HOST: package url must use https");
    };
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..authority_end];
    if authority.contains('@') {
        bail!("PLUGIN_MARKET_UNTRUSTED_HOST: package url must not embed credentials");
    }
    let host = if let Some(stripped) = authority.strip_prefix('[') {
        match stripped.find(']') {
            Some(close) => &stripped[..close],
            None => bail!("PLUGIN_MARKET_UNTRUSTED_HOST: package url host is malformed"),
        }
    } else {
        authority.split(':').next().unwrap_or(authority)
    };
    if host.is_empty() {
        bail!("PLUGIN_MARKET_UNTRUSTED_HOST: package url is missing a host");
    }
    Ok((host.to_string(), plain_http))
}

/// Whether a package URL is one the host is willing to fetch.
///
/// Allowed: the distribution hosts above, and the host that served the
/// catalog currently in effect — a private or enterprise catalog is trusted
/// for its own packages, and pointing the client at one does not widen the
/// allowlist for third-party hosts. Plain `http` is refused outside loopback,
/// which keeps local development catalogs working.
fn package_host_allowed(package_url: &str, catalog_url: &str) -> Result<()> {
    let (host, plain_http) = package_url_host(package_url)?;
    if plain_http && !is_loopback_host(&host) {
        bail!("PLUGIN_MARKET_UNTRUSTED_HOST: {host} must be reached over https");
    }
    if PACKAGE_HOST_ALLOWLIST
        .iter()
        .any(|allowed| host_matches_allowlist_entry(&host, allowed))
    {
        return Ok(());
    }
    if let Ok((catalog_host, _)) = package_url_host(catalog_url) {
        if host == catalog_host {
            return Ok(());
        }
    }
    bail!("PLUGIN_MARKET_UNTRUSTED_HOST: {host} is not an allowed package host")
}

/// Whether a package URL needs the network at all.
///
/// `file://` and bare local paths serve the built-in offline catalog and local
/// development catalogs. They cannot reach another host, so the allowlist does
/// not apply to them.
fn is_local_package_url(url: &str) -> bool {
    !url.starts_with("http://") && !url.starts_with("https://")
}

fn permission_diff(old: &[String], new: &[String]) -> Vec<String> {
    new.iter()
        .filter(|p| !old.iter().any(|o| o == *p))
        .cloned()
        .collect()
}

fn sanitize_id(id: &str) -> String {
    id.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

fn crc32(data: &[u8]) -> u32 {
    let mut crc: u32 = 0xFFFF_FFFF;
    for b in data {
        crc ^= u32::from(*b);
        for _ in 0..8 {
            let mask = (!(crc & 1)).wrapping_add(1);
            crc = (crc >> 1) ^ (0xEDB8_8320 & mask);
        }
    }
    !crc
}

fn read_u16(bytes: &[u8], offset: usize) -> Result<u16> {
    let slice = bytes
        .get(offset..offset + 2)
        .ok_or_else(|| anyhow!("PLUGIN_INVALID: zip truncated"))?;
    Ok(u16::from_le_bytes([slice[0], slice[1]]))
}

fn read_u32(bytes: &[u8], offset: usize) -> Result<u32> {
    let slice = bytes
        .get(offset..offset + 4)
        .ok_or_else(|| anyhow!("PLUGIN_INVALID: zip truncated"))?;
    Ok(u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

fn download_url(url: &str) -> Result<Vec<u8>> {
    download_url_guarded(url, None)
}

/// Unique scratch path for one guarded download.
///
/// curl writes the body to a file so stdout can carry only the effective URL;
/// mixing them would corrupt a binary package.
fn download_scratch_path() -> PathBuf {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let seq = COUNTER.fetch_add(1, AtomicOrdering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir().join(format!(
        "pi-desktop-download-{}-{seq}-{nanos}.bin",
        std::process::id()
    ))
}

/// Fetch a URL, optionally holding every redirect hop inside the package host
/// allowlist.
///
/// `package_guard` carries the catalog URL in effect when the download is a
/// marketplace package. A GitHub release asset always redirects to a storage
/// host, so the initial URL passing the allowlist is not sufficient on its
/// own: redirects are restricted to HTTPS and the effective URL is re-checked
/// under the same rule before the bytes are accepted.
fn download_url_guarded(url: &str, package_guard: Option<&str>) -> Result<Vec<u8>> {
    if let Some(path) = url.strip_prefix("file://") {
        return fs::read(path).with_context(|| format!("read local url {path}"));
    }

    // Prefer curl for robust HTTPS support on developer and CI machines.
    let scratch = package_guard.map(|_| download_scratch_path());
    let max_filesize = MAX_PACKAGE_BYTES.to_string();
    let mut args: Vec<String> = vec![
        "--silent".into(),
        "--show-error".into(),
        "--location".into(),
        "--fail".into(),
        "--max-time".into(),
        "30".into(),
        "--max-redirs".into(),
        "5".into(),
        "--max-filesize".into(),
        max_filesize,
        "--user-agent".into(),
        "pi-desktop-host-core".into(),
    ];
    if package_guard.is_some() && url.starts_with("https://") {
        // Downgrading to plain HTTP mid-redirect would take the request off
        // the host the allowlist approved.
        args.push("--proto".into());
        args.push("=https".into());
        args.push("--proto-redir".into());
        args.push("=https".into());
    }
    if let Some(scratch) = scratch.as_ref() {
        args.push("--output".into());
        args.push(scratch.to_string_lossy().into_owned());
        args.push("--write-out".into());
        args.push("%{url_effective}".into());
    }
    args.push(url.to_string());

    let outcome = std::process::Command::new("curl").args(&args).output();
    if let Ok(output) = outcome {
        if output.status.success() {
            let body = match scratch.as_ref() {
                Some(scratch) => {
                    let effective = String::from_utf8_lossy(&output.stdout).trim().to_string();
                    let guard_result = match package_guard {
                        Some(catalog_url) if !effective.is_empty() => {
                            package_host_allowed(&effective, catalog_url)
                        }
                        _ => Ok(()),
                    };
                    let body = guard_result.and_then(|()| {
                        fs::read(scratch).with_context(|| format!("read download {url}"))
                    });
                    let _ = fs::remove_file(scratch);
                    body?
                }
                None => output.stdout,
            };
            if body.len() as u64 > MAX_PACKAGE_BYTES {
                bail!("PLUGIN_INVALID: package exceeds 50MB limit");
            }
            return Ok(body);
        }
        if let Some(scratch) = scratch.as_ref() {
            let _ = fs::remove_file(scratch);
        }
        let err = String::from_utf8_lossy(&output.stderr);
        // Fall through to raw HTTP only for http:// URLs.
        if url.starts_with("https://") {
            bail!("PLUGIN_NETWORK: curl failed for {url}: {err}");
        }
    } else if url.starts_with("https://") {
        bail!("PLUGIN_NETWORK: curl is required to fetch https marketplace urls");
    }

    if let Some(rest) = url.strip_prefix("http://") {
        let (host_port, path) = rest.split_once('/').unwrap_or((rest, ""));
        let path = if path.is_empty() {
            "/".to_string()
        } else {
            format!("/{path}")
        };
        let host = host_port.split(':').next().unwrap_or(host_port);
        let port: u16 = host_port
            .split(':')
            .nth(1)
            .and_then(|p| p.parse().ok())
            .unwrap_or(80);
        let mut stream = std::net::TcpStream::connect((host, port))
            .with_context(|| format!("connect {host}:{port}"))?;
        stream.set_read_timeout(Some(Duration::from_secs(15)))?;
        stream.set_write_timeout(Some(Duration::from_secs(15)))?;
        let req = format!(
            "GET {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\nUser-Agent: pi-desktop-host-core\r\nAccept: */*\r\n\r\n"
        );
        stream.write_all(req.as_bytes())?;
        let mut buf = Vec::new();
        stream.read_to_end(&mut buf)?;
        let text = String::from_utf8_lossy(&buf);
        let Some(idx) = text.find("\r\n\r\n") else {
            bail!("PLUGIN_NETWORK: invalid HTTP response");
        };
        let body = buf[idx + 4..].to_vec();
        if body.len() as u64 > MAX_PACKAGE_BYTES {
            bail!("PLUGIN_INVALID: package exceeds 50MB limit");
        }
        return Ok(body);
    }

    bail!("PLUGIN_NETWORK: unsupported marketplace url: {url}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::activation::ActivationMode;
    use tempfile::tempdir;

    /// Serializes tests that repoint `PI_DESKTOP_PLUGIN_MARKET_URL`.
    ///
    /// The marketplace source is process-global, so two tests pointing it at
    /// different catalogs — or one clearing it while another is mid-fetch —
    /// read each other's value.
    static MARKET_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn lock_market_env() -> std::sync::MutexGuard<'static, ()> {
        MARKET_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn with_local_market<T>(f: impl FnOnce() -> T) -> T {
        let _guard = lock_market_env();
        // Force offline/local fallback path for deterministic unit tests.
        // Safety: test-only process env mutation.
        unsafe {
            std::env::set_var(
                "PI_DESKTOP_PLUGIN_MARKET_URL",
                "file:///nope/does-not-exist-catalog.json",
            );
        }
        let out = f();
        unsafe {
            std::env::remove_var("PI_DESKTOP_PLUGIN_MARKET_URL");
        }
        out
    }

    #[test]
    fn install_market_package_and_check_update_metadata() {
        with_local_market(|| {
            let dir = tempdir().unwrap();
            unsafe {
                std::env::set_var("PI_DESKTOP_DATA_DIR", dir.path());
            }
            let mut mgr = PluginManager::new(dir.path(), None);
            let search = mgr.market_search(Some("hello"), None).unwrap();
            assert!(!search.is_empty());
            let installed = mgr
                .install_from_market("demo.hello", None, true, true, None)
                .unwrap();
            assert_eq!(installed.plugin.id, "demo.hello");
            assert!(installed.plugin.path.unwrap().contains("installed"));
            assert_eq!(installed.plugin.source, "marketplace");
            let listed = mgr.list();
            assert!(
                listed.iter().any(|plugin| plugin.id == "demo.hello"),
                "installed marketplace plugin must be present in the registry"
            );
        });
    }

    #[test]
    fn marketplace_install_refreshes_catalog_before_checksum_verification() {
        with_local_market(|| {
            let dir = tempdir().unwrap();
            unsafe {
                std::env::set_var("PI_DESKTOP_DATA_DIR", dir.path());
            }
            let mut mgr = PluginManager::new(dir.path(), None);
            let package_bytes = bundled_package_bytes("demo.hello", "0.2.0").unwrap();
            let package_path = dir.path().join("fresh-demo.hello.piplug");
            fs::write(&package_path, &package_bytes).unwrap();

            let mut remote = built_in_catalog();
            let remote_version = &mut remote.plugins[0].versions[0];
            remote_version.url = format!("file://{}", package_path.to_string_lossy());
            remote_version.shasum = sha256_hex(&package_bytes);
            let remote_catalog_path = dir.path().join("remote-catalog.json");
            fs::write(
                &remote_catalog_path,
                serde_json::to_string_pretty(&remote).unwrap(),
            )
            .unwrap();

            // Simulate the UI's still-fresh cache from before the publisher
            // replaced the package at the mutable marketplace URL.
            let mut cached = remote.clone();
            cached.plugins[0].versions[0].shasum = "stale-checksum".into();
            fs::write(
                mgr.catalog_path(),
                serde_json::to_string_pretty(&cached).unwrap(),
            )
            .unwrap();
            fs::write(
                mgr.market_cache_meta_path(),
                serde_json::to_string(&json!({
                    "fetchedAt": Utc::now().to_rfc3339()
                }))
                .unwrap(),
            )
            .unwrap();
            unsafe {
                std::env::set_var(
                    "PI_DESKTOP_PLUGIN_MARKET_URL",
                    format!("file://{}", remote_catalog_path.to_string_lossy()),
                );
            }

            let installed = mgr
                .install_from_market("demo.hello", None, true, false, None)
                .expect("install should use the refreshed checksum");
            assert_eq!(installed.plugin.id, "demo.hello");
            assert_eq!(installed.plugin.version, "0.2.0");

        });
    }

    #[test]
    fn marketplace_uses_highest_semver_when_catalog_versions_are_unsorted() {
        with_local_market(|| {
            let dir = tempdir().unwrap();
            unsafe {
                std::env::set_var("PI_DESKTOP_DATA_DIR", dir.path());
            }
            let mgr = PluginManager::new(dir.path(), None);
            let entry = MarketCatalogEntry {
                id: "pi.todo".into(),
                name: "Fresh Todo".into(),
                description: "Todo plugin".into(),
                author: "PI-Desktop".into(),
                icon_url: None,
                categories: vec![],
                verified: true,
                downloads: None,
                homepage: None,
                repository: None,
                readme_markdown: None,
                safety_notes: None,
                versions: vec![
                    MarketVersion {
                        version: "0.5.0".into(),
                        published_at: "2026-08-12T00:00:00Z".into(),
                        changelog: None,
                        min_pi_desktop: None,
                        shasum: "old".into(),
                        url: "old.piplug".into(),
                        size_bytes: 1,
                        permissions: vec!["ui.panel".into()],
                        ..Default::default()
                    },
                    MarketVersion {
                        version: "0.5.1".into(),
                        published_at: "2026-08-13T00:00:00Z".into(),
                        changelog: None,
                        min_pi_desktop: None,
                        shasum: "new".into(),
                        url: "new.piplug".into(),
                        size_bytes: 1,
                        permissions: vec!["ui.panel".into(), "notify".into()],
                        ..Default::default()
                    },
                ],
                ..Default::default()
            };

            let summary = mgr.to_market_summary(&entry);
            assert_eq!(summary.latest_version, "0.5.1");
            assert!(!summary.update_available);
            assert_eq!(
                latest_market_version(&entry.versions)
                    .expect("latest version")
                    .version,
                "0.5.1"
            );
            assert_eq!(compare_plugin_versions("0.5.1", "0.5.0"), Ordering::Greater);
            assert_eq!(compare_plugin_versions("0.5.1", "0.5.1-beta.1"), Ordering::Greater);
        });
    }

    #[test]
    fn announced_version_without_a_package_is_visible_but_not_installable() {
        with_local_market(|| {
            let dir = tempdir().unwrap();
            unsafe {
                std::env::set_var("PI_DESKTOP_DATA_DIR", dir.path());
            }
            let mut mgr = PluginManager::new(dir.path(), None);
            mgr.install_from_market("demo.hello", None, true, true, None)
                .unwrap();

            // The publisher announced 0.9.0 but has not uploaded its package.
            let mut catalog = built_in_catalog();
            let announced = MarketVersion {
                version: "0.9.0".into(),
                published_at: "2026-08-13T00:00:00Z".into(),
                changelog: None,
                min_pi_desktop: None,
                shasum: String::new(),
                url: String::new(),
                size_bytes: 0,
                permissions: catalog.plugins[0].versions[0].permissions.clone(),
                ..Default::default()
            };
            catalog.plugins[0].versions.push(announced);
            fs::write(
                mgr.catalog_path(),
                serde_json::to_string_pretty(&catalog).unwrap(),
            )
            .unwrap();

            // Discovery still shows the newest version, flagged as unbuyable.
            let summary = &mgr.market_search(Some("Hello"), None).unwrap()[0];
            assert_eq!(summary.latest_version, "0.9.0");
            assert!(!summary.installable);
            assert!(
                mgr.market_get("demo.hello")
                    .unwrap()
                    .versions
                    .iter()
                    .any(|v| v.version == "0.9.0")
            );

            // The install seam refuses it, and a batch update skips it instead
            // of failing the whole run.
            let err = mgr
                .market_download_info("demo.hello", Some("0.9.0"))
                .unwrap_err()
                .to_string();
            assert!(err.contains("PLUGIN_MARKET_INVALID"), "{err}");
            let updates = mgr.check_updates(false).unwrap();
            assert_eq!(updates.len(), 1);
            assert_eq!(updates[0].version, "0.9.0");
            assert!(mgr.apply_updates(false).unwrap().is_empty());
            assert_eq!(mgr.get("demo.hello").unwrap().version, "0.2.0");

        });
    }

    #[test]
    fn silent_update_check_uses_cached_catalog_without_refreshing_remote() {
        with_local_market(|| {
            let dir = tempdir().unwrap();
            unsafe {
                std::env::set_var("PI_DESKTOP_DATA_DIR", dir.path());
            }
            let mut mgr = PluginManager::new(dir.path(), None);
            mgr.install_from_market("demo.hello", None, true, false, None)
                .unwrap();

            let mut cached = built_in_catalog();
            cached.plugins[0].versions[0].version = "0.3.0".into();
            fs::write(
                mgr.catalog_path(),
                serde_json::to_string_pretty(&cached).unwrap(),
            )
            .unwrap();

            let mut remote = cached.clone();
            remote.plugins[0].versions[0].version = "0.9.0".into();
            let remote_path = dir.path().join("remote-catalog.json");
            fs::write(&remote_path, serde_json::to_string_pretty(&remote).unwrap()).unwrap();
            unsafe {
                std::env::set_var(
                    "PI_DESKTOP_PLUGIN_MARKET_URL",
                    format!("file://{}", remote_path.to_string_lossy()),
                );
            }

            let updates = mgr.check_updates(false).unwrap();
            assert_eq!(updates.len(), 1);
            assert_eq!(updates[0].version, "0.3.0");
            assert_eq!(
                mgr.market_search(Some("Hello"), None).unwrap()[0].latest_version,
                "0.3.0"
            );
            assert_eq!(
                mgr.market_get("demo.hello").unwrap().summary.latest_version,
                "0.3.0"
            );

            unsafe {
                std::env::remove_var("PI_DESKTOP_DATA_DIR");
                std::env::remove_var("PI_DESKTOP_PLUGIN_MARKET_URL");
            }
        });
    }

    #[test]
    fn package_path_traversal_rejected() {
        // PI_DESKTOP_DATA_DIR is process-wide; hold the same lock the market
        // tests use so two tests cannot point it at each other's directory.
        let _env = lock_market_env();
        let dir = tempdir().unwrap();
        unsafe {
            std::env::set_var("PI_DESKTOP_DATA_DIR", dir.path());
        }
        let bad = make_zip(&[("../evil.js", b"alert(1)")]);
        let pkg = dir.path().join("bad.piplug");
        fs::write(&pkg, bad).unwrap();
        let mut mgr = PluginManager::new(dir.path(), None);
        let err = mgr
            .install_from_package(
                pkg.to_str().unwrap(),
                InstallOptions {
                    source: "installed".into(),
                    enable: true,
                    marketplace: None,
                    expected_shasum: None,
                    auto_update: false,
                    granted_permissions: None,
                },
            )
            .unwrap_err()
            .to_string();
        assert!(err.contains("path traversal") || err.contains("PLUGIN_INVALID"));
        unsafe {
            std::env::remove_var("PI_DESKTOP_DATA_DIR");
        }
    }

    #[test]
    fn high_risk_permissions_roundtrip_on_notes_plugin() {
        with_local_market(|| {
            let dir = tempdir().unwrap();
            unsafe {
                std::env::set_var("PI_DESKTOP_DATA_DIR", dir.path());
            }
            // Clean up any existing packages to ensure fresh generation
            let packages_dir = dir.path().join("plugins/market/packages");
            if packages_dir.exists() {
                let _ = fs::remove_dir_all(&packages_dir);
            }
            let mut mgr = PluginManager::new(dir.path(), None);
            let installed = mgr
                .install_from_market("demo.workspace-notes", None, true, false, None)
                .unwrap();
            assert!(installed
                .plugin
                .permissions
                .iter()
                .any(|p| p == "fs.write.workspace"));
            assert!(installed
                .plugin
                .permissions
                .iter()
                .any(|p| p == "net.fetch"));
        });
    }

    #[test]
    fn resolve_relative_package_urls_against_catalog() {
        let resolved = PluginManager::resolve_package_url(
            "https://raw.githubusercontent.com/vastsa/pi-desktop-plugins/main/catalog.json",
            None,
            "packages/demo.hello-0.2.0.piplug",
        );
        assert_eq!(
            resolved,
            "https://raw.githubusercontent.com/vastsa/pi-desktop-plugins/main/packages/demo.hello-0.2.0.piplug"
        );
    }

    #[test]
    fn refresh_catalog_from_official_repo_when_network_available() {
        let _guard = lock_market_env();
        // Skip cleanly if offline / rate-limited.
        let url = "https://raw.githubusercontent.com/vastsa/pi-desktop-plugins/main/catalog.json";
        if download_url(url).is_err() {
            return;
        }
        let dir = tempdir().unwrap();
        unsafe {
            std::env::set_var("PI_DESKTOP_DATA_DIR", dir.path());
            std::env::set_var("PI_DESKTOP_PLUGIN_MARKET_URL", url);
        }
        let mgr = PluginManager::new(dir.path(), None);
        let meta = mgr.refresh_market(true).expect("remote catalog");
        assert_eq!(meta["providerId"], "official");
        assert!(meta["pluginCount"].as_u64().unwrap_or(0) >= 1);
        assert!(meta["sourceUrl"]
            .as_str()
            .unwrap_or("")
            .contains("pi-desktop-plugins"));
        let search = mgr.market_search(Some("hello"), None).unwrap();
        assert!(search.iter().any(|p| p.id == "demo.hello"));
        unsafe {
            std::env::remove_var("PI_DESKTOP_DATA_DIR");
            std::env::remove_var("PI_DESKTOP_PLUGIN_MARKET_URL");
        }
    }

    #[test]
    fn market_source_from_settings_selects_the_configured_provider() {
        assert_eq!(market_source_from_settings(None), None);
        assert_eq!(market_source_from_settings(Some(&json!({}))), None);
        // `official` stays on the built-in default rather than pinning a URL,
        // so a later default change reaches users who never switched.
        assert_eq!(
            market_source_from_settings(Some(&json!({"pluginMarketSource": "official"}))),
            None
        );
        assert_eq!(
            market_source_from_settings(Some(&json!({"pluginMarketSource": "mirror"}))).as_deref(),
            Some(MIRROR_MARKET_CATALOG_URL)
        );
        assert_eq!(
            market_source_from_settings(Some(&json!({
                "pluginMarketSource": "custom",
                "pluginMarketCustomUrl": "  https://example.test/catalog.json  ",
            })))
            .as_deref(),
            Some("https://example.test/catalog.json")
        );
        // A custom source with no URL must not strand the marketplace on an
        // empty endpoint.
        assert_eq!(
            market_source_from_settings(Some(&json!({
                "pluginMarketSource": "custom",
                "pluginMarketCustomUrl": "   ",
            }))),
            None
        );
    }

    #[test]
    fn cached_catalog_is_scoped_to_the_source_that_fetched_it() {
        with_local_market(|| {
            let dir = tempdir().unwrap();
            unsafe {
                std::env::set_var("PI_DESKTOP_DATA_DIR", dir.path());
            }
            let mgr = PluginManager::new(dir.path(), None);
            // A bundled offline snapshot records no source and stays usable
            // whichever provider is selected.
            let _ = fs::remove_file(mgr.market_cache_meta_path());
            assert!(mgr.cached_catalog_matches_source(OFFICIAL_MARKET_CATALOG_URL));
            assert!(mgr.cached_catalog_matches_source(MIRROR_MARKET_CATALOG_URL));

            fs::create_dir_all(dir.path().join("plugins/market")).unwrap();
            fs::write(
                mgr.market_cache_meta_path(),
                serde_json::to_string(&json!({"sourceUrl": MIRROR_MARKET_CATALOG_URL})).unwrap(),
            )
            .unwrap();
            assert!(mgr.cached_catalog_matches_source(MIRROR_MARKET_CATALOG_URL));
            assert!(!mgr.cached_catalog_matches_source(OFFICIAL_MARKET_CATALOG_URL));
        });
    }

    #[test]
    fn switching_source_ignores_the_previous_providers_snapshot() {
        with_local_market(|| {
            let local_source = std::env::var("PI_DESKTOP_PLUGIN_MARKET_URL").unwrap();
            let dir = tempdir().unwrap();
            unsafe {
                std::env::set_var("PI_DESKTOP_DATA_DIR", dir.path());
            }
            let mgr = PluginManager::new(dir.path(), None);

            // A snapshot carrying a plugin the built-in catalog does not have,
            // written while a different provider was selected.
            let mut foreign = built_in_catalog();
            foreign.provider_id = "mirror".into();
            foreign.plugins.truncate(1);
            foreign.plugins[0].id = "mirror.only".into();
            foreign.plugins[0].name = "Mirror Only".into();
            fs::create_dir_all(dir.path().join("plugins/market")).unwrap();
            fs::write(
                mgr.catalog_path(),
                serde_json::to_string(&foreign).unwrap(),
            )
            .unwrap();
            fs::write(
                mgr.market_cache_meta_path(),
                serde_json::to_string(&json!({"sourceUrl": MIRROR_MARKET_CATALOG_URL})).unwrap(),
            )
            .unwrap();

            // Package URLs in that snapshot resolve against the provider that
            // served it, so search must fall back to the built-in catalog.
            let results = mgr.market_search(None, None).unwrap();
            assert!(!results.iter().any(|p| p.id == "mirror.only"));
            assert!(results.iter().any(|p| p.id == "demo.hello"));

            // Re-record the snapshot against the active source and it is used.
            fs::write(
                mgr.market_cache_meta_path(),
                serde_json::to_string(&json!({"sourceUrl": local_source})).unwrap(),
            )
            .unwrap();
            let results = mgr.market_search(None, None).unwrap();
            assert!(results.iter().any(|p| p.id == "mirror.only"));
        });
    }

    fn write_plugin(root: &Path, manifest: Value, extra: &[(&str, &str)]) {
        fs::create_dir_all(root).unwrap();
        fs::write(root.join("main.js"), "export function onLoad() {}").unwrap();
        fs::write(
            root.join("manifest.json"),
            serde_json::to_string_pretty(&manifest).unwrap(),
        )
        .unwrap();
        for (rel, contents) in extra {
            let path = root.join(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, contents).unwrap();
        }
    }

    fn capability_manifest(contributes: Value, permissions: Value) -> Value {
        json!({
            "schemaVersion": 1,
            "id": "demo.caps",
            "name": "Caps",
            "version": "0.1.0",
            "main": "main.js",
            "contributes": contributes,
            "permissions": permissions,
        })
    }

    fn read_manifest_err(root: &Path) -> String {
        PluginManager::read_manifest(root)
            .expect_err("manifest should be rejected")
            .to_string()
    }

    #[test]
    fn accepts_and_summarizes_new_contributions() {
        // PI_DESKTOP_DATA_DIR is process-wide; hold the same lock the market
        // tests use so two tests cannot point it at each other's directory.
        let _env = lock_market_env();
        let dir = tempdir().unwrap();
        let root = dir.path().join("plugin");
        write_plugin(
            &root,
            json!({
                "schemaVersion": 1,
                "id": "demo.caps",
                "name": "Caps",
                "version": "0.1.0",
                "main": "main.js",
                "ui": { "panel": "renderer/index.html" },
                "contributes": {
                    "commands": [{ "id": "a", "title": "A" }],
                    "views": [{ "id": "changes", "title": "Changes", "entry": "views/changes.html" }],
                    "settings": [{
                        "key": "openShortcut",
                        "title": "Open shortcut",
                        "type": "shortcut",
                        "default": "Mod+Shift+A",
                        "command": "a",
                        "scope": "plugin"
                    }],
                    "agentTools": [{ "name": "t", "description": "d" }],
                    "skills": ["./skills/a.md", { "path": "skills/b.md", "id": "b" }],
                    "themes": [{ "id": "midnight", "label": "Midnight", "path": "themes/m.css", "base": "dark" }],
                    "mcpServers": [
                        { "id": "local", "transport": "stdio", "command": "mcp-files", "args": ["--root", "."] },
                        { "id": "remote", "transport": "http", "url": "https://example.com/mcp" }
                    ],
                    "services": [{ "id": "watcher" }],
                    "bus": { "publish": ["notes.created"], "subscribe": ["notes.**"] }
                },
                "permissions": [
                    "ui.panel",
                    "ui.view",
                    "ui.theme",
                    "agent.tool.register",
                    "mcp.server.local",
                    "mcp.server.remote",
                    "background.service",
                    "bus.publish",
                    "bus.subscribe"
                ],
            }),
            &[
                ("renderer/index.html", "<html></html>"),
                ("views/changes.html", "<html></html>"),
                ("skills/a.md", "---\nname: A\n---\nbody"),
                ("skills/b.md", "body"),
                ("themes/m.css", ":root { --ds-bg: #000; }"),
            ],
        );
        let manifest = PluginManager::read_manifest(&root).unwrap();
        assert_eq!(
            derive_capabilities(&manifest),
            vec!["panel", "commands", "views", "tools", "skills", "themes", "mcp", "services", "bus"]
        );

        let data = tempdir().unwrap();
        unsafe {
            std::env::set_var("PI_DESKTOP_DATA_DIR", data.path());
        }
        let mut mgr = PluginManager::new(data.path(), None);
        let summary = mgr.load_dev(root.to_str().unwrap()).unwrap();
        assert!(summary.capabilities.contains(&"mcp".to_string()));
        assert!(summary.capabilities.contains(&"bus".to_string()));
        assert_eq!(summary.settings.len(), 1);
        assert_eq!(summary.settings[0].scope, "plugin");
        unsafe {
            std::env::remove_var("PI_DESKTOP_DATA_DIR");
        }
    }

    #[test]
    fn missing_contributed_files_are_rejected() {
        let dir = tempdir().unwrap();
        let skill_root = dir.path().join("skill");
        write_plugin(
            &skill_root,
            capability_manifest(json!({ "skills": ["skills/gone.md"] }), json!([])),
            &[],
        );
        assert!(read_manifest_err(&skill_root).contains("skill file missing"));

        let theme_root = dir.path().join("theme");
        write_plugin(
            &theme_root,
            capability_manifest(
                json!({ "themes": [{ "id": "a", "label": "A", "path": "themes/gone.css" }] }),
                json!(["ui.theme"]),
            ),
            &[],
        );
        assert!(read_manifest_err(&theme_root).contains("theme css missing"));
    }

    #[test]
    fn contributed_paths_must_stay_inside_the_plugin() {
        let dir = tempdir().unwrap();
        let root = dir.path().join("plugin");
        write_plugin(
            &root,
            capability_manifest(json!({ "skills": ["../outside.md"] }), json!([])),
            &[],
        );
        assert!(read_manifest_err(&root).contains("traversal"));
    }

    #[test]
    fn theme_contributions_require_permission_and_css() {
        let dir = tempdir().unwrap();
        let no_perm = dir.path().join("no-perm");
        write_plugin(
            &no_perm,
            capability_manifest(
                json!({ "themes": [{ "id": "a", "label": "A", "path": "themes/a.css" }] }),
                json!([]),
            ),
            &[("themes/a.css", ":root {}")],
        );
        assert!(read_manifest_err(&no_perm).contains("ui.theme permission"));

        let wrong_ext = dir.path().join("wrong-ext");
        write_plugin(
            &wrong_ext,
            capability_manifest(
                json!({ "themes": [{ "id": "a", "label": "A", "path": "themes/a.json" }] }),
                json!(["ui.theme"]),
            ),
            &[("themes/a.json", "{}")],
        );
        assert!(read_manifest_err(&wrong_ext).contains(".css file"));
    }

    #[test]
    fn view_contributions_require_permission_and_an_existing_entry() {
        let dir = tempdir().unwrap();
        let view = |extra: Value| json!({ "views": [extra] });

        let no_perm = dir.path().join("no-perm");
        write_plugin(
            &no_perm,
            capability_manifest(
                view(json!({ "id": "a", "title": "A", "entry": "views/a.html" })),
                json!([]),
            ),
            &[("views/a.html", "<html></html>")],
        );
        assert!(read_manifest_err(&no_perm).contains("ui.view permission"));

        let missing_entry = dir.path().join("missing-entry");
        write_plugin(
            &missing_entry,
            capability_manifest(
                view(json!({ "id": "a", "title": "A", "entry": "views/a.html" })),
                json!(["ui.view"]),
            ),
            &[],
        );
        assert!(read_manifest_err(&missing_entry).contains("view entry missing"));

        let no_title = dir.path().join("no-title");
        write_plugin(
            &no_title,
            capability_manifest(
                view(json!({ "id": "a", "title": "  ", "entry": "views/a.html" })),
                json!(["ui.view"]),
            ),
            &[("views/a.html", "<html></html>")],
        );
        assert!(read_manifest_err(&no_title).contains("requires a title"));

        // A localized title is accepted, and the entry may not escape the root.
        let escaping = dir.path().join("escaping");
        write_plugin(
            &escaping,
            capability_manifest(
                view(json!({
                    "id": "a",
                    "title": { "en": "A", "zh-CN": "甲" },
                    "entry": "../outside.html"
                })),
                json!(["ui.view"]),
            ),
            &[],
        );
        assert!(read_manifest_err(&escaping).contains("traversal"));
    }

    #[test]
    fn bundled_plugins_refresh_from_disk_but_keep_user_state() {
        let ship = tempdir().unwrap();
        let plugin_manifest = |version: &str| {
            json!({
                "schemaVersion": 1,
                "id": "pi.files",
                "name": "Files",
                "version": version,
                "main": "main.js",
                "contributes": {
                    "views": [{ "id": "tree", "title": "Files", "entry": "views/tree.html" }]
                },
                "permissions": ["ui.view"],
            })
        };
        let root = ship.path().join("pi.files");
        write_plugin(
            &root,
            plugin_manifest("1.0.0"),
            &[("views/tree.html", "<html></html>")],
        );

        let data = tempdir().unwrap();
        let mut mgr = PluginManager::new(data.path(), None);
        mgr.sync_builtin(Some(ship.path())).unwrap();

        let listed = mgr.get("pi.files").expect("bundled plugin is registered");
        assert_eq!(listed.source, "builtin");
        assert_eq!(listed.version, "1.0.0");
        assert!(listed.enabled, "a bundled plugin is on by default");
        assert!(listed.capabilities.contains(&"views".to_string()));

        // A bundled plugin is part of the app, so it cannot be uninstalled.
        assert!(
            mgr.uninstall("pi.files")
                .unwrap_err()
                .to_string()
                .contains("cannot be uninstalled"),
        );

        // The user turning it off must survive the next launch, even though the
        // rest of the row is rebuilt from the shipped manifest.
        mgr.set_enabled("pi.files", false).unwrap();
        write_plugin(
            &root,
            plugin_manifest("2.0.0"),
            &[("views/tree.html", "<html></html>")],
        );
        mgr.sync_builtin(Some(ship.path())).unwrap();
        let after = mgr.get("pi.files").unwrap();
        assert_eq!(after.version, "2.0.0", "an app update refreshes the row");
        assert!(!after.enabled, "the user's choice is not overwritten");

        // A build that stops shipping it leaves no orphan row behind.
        fs::remove_dir_all(&root).unwrap();
        mgr.sync_builtin(Some(ship.path())).unwrap();
        assert!(mgr.get("pi.files").is_none());
    }

    #[test]
    fn stdio_mcp_commands_may_not_escape_the_plugin() {
        let dir = tempdir().unwrap();
        for (name, command, expected) in [
            ("absolute", "/usr/bin/evil", "absolute"),
            ("traversal", "../evil.js", "traversal"),
            ("shell", "sh -c evil", "executable name"),
        ] {
            let root = dir.path().join(name);
            write_plugin(
                &root,
                capability_manifest(
                    json!({ "mcpServers": [{ "id": "s", "transport": "stdio", "command": command }] }),
                    json!(["mcp.server.local"]),
                ),
                &[],
            );
            assert!(
                read_manifest_err(&root).contains(expected),
                "command {command} should be rejected"
            );
        }
    }

    #[test]
    fn remote_mcp_urls_accept_non_loopback_http() {
        let dir = tempdir().unwrap();
        let remote = dir.path().join("remote");
        write_plugin(
            &remote,
            capability_manifest(
                json!({ "mcpServers": [{ "id": "s", "transport": "http", "url": "http://example.com/mcp" }] }),
                json!(["mcp.server.remote"]),
            ),
            &[],
        );
        assert!(PluginManager::read_manifest(&remote).is_ok());

        let credentials = dir.path().join("credentials");
        write_plugin(
            &credentials,
            capability_manifest(
                json!({ "mcpServers": [{ "id": "s", "transport": "http", "url": "https://u:p@example.com/mcp" }] }),
                json!(["mcp.server.remote"]),
            ),
            &[],
        );
        assert!(read_manifest_err(&credentials).contains("credentials"));

        let loopback = dir.path().join("loopback");
        write_plugin(
            &loopback,
            capability_manifest(
                json!({ "mcpServers": [{ "id": "s", "transport": "http", "url": "http://127.0.0.1:8931/mcp" }] }),
                json!(["mcp.server.remote"]),
            ),
            &[],
        );
        assert!(PluginManager::read_manifest(&loopback).is_ok());
    }

    #[test]
    fn services_and_bus_declarations_are_checked() {
        let dir = tempdir().unwrap();
        let service = dir.path().join("service");
        write_plugin(
            &service,
            capability_manifest(json!({ "services": [{ "id": "watcher" }] }), json!([])),
            &[],
        );
        assert!(read_manifest_err(&service).contains("background.service permission"));

        let topic = dir.path().join("topic");
        write_plugin(
            &topic,
            capability_manifest(
                json!({ "bus": { "publish": ["notes.*"] } }),
                json!(["bus.publish"]),
            ),
            &[],
        );
        assert!(read_manifest_err(&topic).contains("not a valid topic"));

        let pattern = dir.path().join("pattern");
        write_plugin(
            &pattern,
            capability_manifest(
                json!({ "bus": { "subscribe": ["notes.**.x"] } }),
                json!(["bus.subscribe"]),
            ),
            &[],
        );
        assert!(read_manifest_err(&pattern).contains("not valid"));
    }

    /// A scope is a user decision about reach, so it has to survive the two
    /// things that rewrite a plugin record: a restart and a reinstall.
    #[test]
    fn a_project_scope_survives_a_reload_and_a_reinstall() {
        // PI_DESKTOP_DATA_DIR is process-wide; hold the same lock the market
        // tests use so two tests cannot point it at each other's directory.
        let _env = lock_market_env();
        let dir = tempdir().unwrap();
        unsafe {
            std::env::set_var("PI_DESKTOP_DATA_DIR", dir.path());
        }

        let source = dir.path().join("src");
        write_plugin(
            &source,
            json!({
                "schemaVersion": 1,
                "id": "demo.scoped",
                "name": "Scoped",
                "version": "0.1.0",
                "main": "main.js",
            }),
            &[],
        );

        let mut mgr = PluginManager::new(dir.path(), None);
        let installed = mgr
            .install_from_path(
                source.to_str().unwrap(),
                InstallOptions {
                    source: "installed".into(),
                    enable: true,
                    ..Default::default()
                },
            )
            .unwrap();
        // Anything installed before scopes existed reads as global, so that is
        // also what a fresh install has to be.
        assert_eq!(installed.plugin.scope.mode, ActivationMode::Global);

        let scoped = mgr
            .set_scope(
                "demo.scoped",
                ActivationScope {
                    mode: ActivationMode::Projects,
                    projects: vec!["/work/api".into()],
                },
            )
            .unwrap()
            .expect("plugin missing");
        assert_eq!(scoped.scope.projects, vec!["/work/api".to_string()]);

        // Off is a separate switch: it must not consume the project list.
        let disabled = mgr.set_enabled("demo.scoped", false).unwrap().unwrap();
        assert!(!disabled.enabled);
        assert_eq!(disabled.scope.projects, vec!["/work/api".to_string()]);

        let reloaded = PluginManager::new(dir.path(), None);
        let after = reloaded.get("demo.scoped").expect("plugin missing");
        assert_eq!(after.scope.mode, ActivationMode::Projects);
        assert_eq!(after.scope.projects, vec!["/work/api".to_string()]);

        // Reinstalling over the top is an update, not a reset: widening a
        // project-scoped plugin back to everywhere would hand it reach the user
        // never granted.
        let mut mgr = PluginManager::new(dir.path(), None);
        let again = mgr
            .install_from_path(
                source.to_str().unwrap(),
                InstallOptions {
                    source: "installed".into(),
                    enable: true,
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(again.plugin.scope.mode, ActivationMode::Projects);
        assert_eq!(again.plugin.scope.projects, vec!["/work/api".to_string()]);

        unsafe {
            std::env::remove_var("PI_DESKTOP_DATA_DIR");
        }
    }

    /// Build a manager whose catalog is already on disk.
    ///
    /// `PluginManager::new` falls back to `built_in_catalog` when no catalog
    /// exists, and that helper reads the process-wide `PI_DESKTOP_DATA_DIR` and
    /// materializes packages under it. A test that triggers the fallback
    /// therefore writes into whichever directory another test happens to have
    /// set, which is how this suite becomes order-dependent. Pre-writing the
    /// catalog keeps these tests off that path entirely.
    fn offline_manager(dir: &Path) -> PluginManager {
        let catalog_path = dir.join("plugins/market/catalog.json");
        fs::create_dir_all(catalog_path.parent().unwrap()).unwrap();
        fs::write(
            &catalog_path,
            serde_json::to_string(&json!({
                "schemaVersion": 2,
                "providerId": "official",
                "plugins": [],
            }))
            .unwrap(),
        )
        .unwrap();
        PluginManager::new(dir, None)
    }

    /// Build a catalog v2 entry with one live and one withdrawn version.
    fn v2_entry() -> MarketCatalogEntry {
        MarketCatalogEntry {
            id: "acme.todo".into(),
            name: "Todo".into(),
            description: "Publisher-owned plugin".into(),
            author: "acme".into(),
            publisher_id: Some("acme".into()),
            trust: Some("verified".into()),
            repository: Some("https://github.com/acme/pi-plugin-todo".into()),
            versions: vec![
                MarketVersion {
                    version: "1.0.0".into(),
                    published_at: "2026-08-01T00:00:00Z".into(),
                    shasum: "a".repeat(64),
                    url: "acme.todo@1.0.0/acme.todo-1.0.0.piplug".into(),
                    size_bytes: 2048,
                    permissions: vec!["ui.panel".into()],
                    ..Default::default()
                },
                MarketVersion {
                    version: "1.1.0".into(),
                    published_at: "2026-08-10T00:00:00Z".into(),
                    shasum: "b".repeat(64),
                    url: "acme.todo@1.1.0/acme.todo-1.1.0.piplug".into(),
                    size_bytes: 2048,
                    permissions: vec!["ui.panel".into()],
                    yanked: true,
                    yanked_reason: Some("leaked a token in the bundle".into()),
                    ..Default::default()
                },
            ],
            ..Default::default()
        }
    }

    fn v2_catalog(entry: MarketCatalogEntry) -> MarketCatalogFile {
        MarketCatalogFile {
            schema_version: 2,
            provider_id: "official".into(),
            artifact_base_url: Some(
                "https://github.com/vastsa/pi-plugin-center/releases/download".into(),
            ),
            plugins: vec![entry],
            ..Default::default()
        }
    }

    #[test]
    fn package_downloads_are_restricted_to_distribution_hosts() {
        let catalog = "https://raw.githubusercontent.com/vastsa/pi-plugin-center/main/catalog.json";
        // GitHub release entry point and the storage hosts it redirects to.
        for url in [
            "https://github.com/vastsa/pi-plugin-center/releases/download/acme.todo@1.0.0/acme.todo-1.0.0.piplug",
            "https://objects.githubusercontent.com/github-production-release-asset/1",
            "https://release-assets.githubusercontent.com/github-production-release-asset/1",
            "https://codeload.github.com/acme/pi-plugin-todo/zip/refs/tags/v1.0.0",
            "https://cnb.cool/aixk/pi-plugin-center/-/releases/download/x.piplug",
        ] {
            package_host_allowed(url, catalog).unwrap_or_else(|e| panic!("{url}: {e}"));
        }

        // A publisher-supplied URL cannot send the request anywhere else, and a
        // near-miss domain must not satisfy the suffix rule.
        for url in [
            "https://evil.test/acme.todo-1.0.0.piplug",
            "https://notgithub.com/x.piplug",
            "https://github.com.evil.test/x.piplug",
            "https://cnb.cool.evil.test/x.piplug",
        ] {
            let err = package_host_allowed(url, catalog).unwrap_err().to_string();
            assert!(err.contains("PLUGIN_MARKET_UNTRUSTED_HOST"), "{url}: {err}");
        }
    }

    #[test]
    fn a_private_catalog_is_trusted_only_for_its_own_host() {
        let catalog = "https://plugins.company.local/catalog.json";
        package_host_allowed("https://plugins.company.local/a.piplug", catalog).unwrap();
        assert!(package_host_allowed("https://other.company.local/a.piplug", catalog).is_err());
    }

    #[test]
    fn package_urls_reject_credentials_and_plain_http() {
        let catalog = "https://raw.githubusercontent.com/vastsa/pi-plugin-center/main/catalog.json";
        let err = package_host_allowed("https://user:pass@github.com/a.piplug", catalog)
            .unwrap_err()
            .to_string();
        assert!(err.contains("must not embed credentials"), "{err}");

        assert!(package_host_allowed("http://github.com/a.piplug", catalog).is_err());
        // A loopback development catalog stays usable.
        package_host_allowed("http://127.0.0.1:8080/a.piplug", "http://127.0.0.1:8080/catalog.json")
            .unwrap();
    }

    #[test]
    fn relative_package_urls_resolve_against_the_declared_artifact_base() {
        let catalog = "https://raw.githubusercontent.com/vastsa/pi-plugin-center/main/catalog.json";
        // v2: the declared base wins, so a release asset is reachable even
        // though it does not live under the catalog directory.
        assert_eq!(
            PluginManager::resolve_package_url(
                catalog,
                Some("https://github.com/vastsa/pi-plugin-center/releases/download"),
                "acme.todo@1.0.0/acme.todo-1.0.0.piplug",
            ),
            "https://github.com/vastsa/pi-plugin-center/releases/download/acme.todo@1.0.0/acme.todo-1.0.0.piplug"
        );
        // v1: no declared base, so the catalog directory still anchors it.
        assert_eq!(
            PluginManager::resolve_package_url(catalog, None, "packages/x.piplug"),
            "https://raw.githubusercontent.com/vastsa/pi-plugin-center/main/packages/x.piplug"
        );
        // An absolute URL is passed through for the host allowlist to judge.
        assert_eq!(
            PluginManager::resolve_package_url(catalog, Some("https://base.test/"), "https://cnb.cool/x.piplug"),
            "https://cnb.cool/x.piplug"
        );
    }

    /// The distribution repository serves `catalog.json` from its root and
    /// packages from `packages/`, and the CNB copy is a Git mirror of it. Both
    /// therefore work with a relative URL and no declared base, which is the
    /// reason moving publishing into the plugin center needs no client change.
    #[test]
    fn official_and_mirror_sources_each_resolve_their_own_packages() {
        let relative = "packages/acme.todo-1.0.0.piplug";

        let github =
            PluginManager::resolve_package_url(OFFICIAL_MARKET_CATALOG_URL, None, relative);
        assert_eq!(
            github,
            "https://raw.githubusercontent.com/vastsa/pi-desktop-plugins/main/packages/acme.todo-1.0.0.piplug"
        );

        let mirror = PluginManager::resolve_package_url(MIRROR_MARKET_CATALOG_URL, None, relative);
        assert_eq!(
            mirror,
            "https://cnb.cool/aixk/pi-desktop-plugins/-/git/raw/main/packages/acme.todo-1.0.0.piplug"
        );

        // Neither resolution leaves the source the user picked, and both hosts
        // are ones the download boundary already accepts.
        package_host_allowed(&github, OFFICIAL_MARKET_CATALOG_URL).unwrap();
        package_host_allowed(&mirror, MIRROR_MARKET_CATALOG_URL).unwrap();
        assert!(github.starts_with("https://raw.githubusercontent.com/"));
        assert!(mirror.starts_with("https://cnb.cool/"));
    }

    #[test]
    fn a_yanked_version_is_never_offered_or_installed() {
        with_local_market(|| {
            let dir = tempdir().unwrap();
            let mgr = offline_manager(dir.path());
            let entry = v2_entry();

            // 1.1.0 is newer but withdrawn, so the offered version is 1.0.0.
            assert_eq!(
                latest_market_version(&entry.versions).expect("live version").version,
                "1.0.0"
            );
            let summary = mgr.to_market_summary(&entry);
            assert_eq!(summary.latest_version, "1.0.0");

            // An explicit pick of the withdrawn version is refused with its reason.
            let catalog = v2_catalog(entry);
            let err = mgr
                .market_download_info_from_catalog(&catalog, "acme.todo", Some("1.1.0"))
                .unwrap_err()
                .to_string();
            assert!(err.contains("PLUGIN_MARKET_YANKED"), "{err}");
            assert!(err.contains("leaked a token"), "{err}");

            // The live version still resolves, carrying its source pin.
            let info = mgr
                .market_download_info_from_catalog(&catalog, "acme.todo", None)
                .unwrap();
            assert_eq!(info.version, "1.0.0");
            assert_eq!(info.publisher_id.as_deref(), Some("acme"));
        });
    }

    #[test]
    fn a_version_requiring_a_newer_host_is_not_installable() {
        with_local_market(|| {
            let dir = tempdir().unwrap();
            let mgr = offline_manager(dir.path());
            let mut entry = v2_entry();
            entry.versions.retain(|v| !v.yanked);
            entry.versions[0].min_pi_desktop = Some("999.0.0".into());

            assert!(!mgr.to_market_summary(&entry).installable);
            let catalog = v2_catalog(entry.clone());
            let err = mgr
                .market_download_info_from_catalog(&catalog, "acme.todo", None)
                .unwrap_err()
                .to_string();
            assert!(err.contains("PLUGIN_HOST_TOO_OLD"), "{err}");

            // A range expression is not a version bound this host can evaluate,
            // and an unreadable bound must not make a plugin uninstallable.
            entry.versions[0].min_pi_desktop = Some(">=0.2.0".into());
            assert!(mgr.to_market_summary(&entry).installable);
        });
    }

    #[test]
    fn a_package_url_off_the_allowlist_is_not_offered_for_install() {
        with_local_market(|| {
            let dir = tempdir().unwrap();
            let mgr = offline_manager(dir.path());
            let mut entry = v2_entry();
            entry.versions.retain(|v| !v.yanked);
            entry.versions[0].url = "https://evil.test/acme.todo-1.0.0.piplug".into();
            assert!(!mgr.to_market_summary(&entry).installable);
        });
    }

    #[test]
    fn verified_trust_is_honoured_only_from_the_official_source() {
        let _guard = lock_market_env();
        let dir = tempdir().unwrap();

        // A catalog already on disk keeps manager construction offline. It is
        // written literally rather than from `built_in_catalog`, which reads
        // the process-wide PI_DESKTOP_DATA_DIR: borrowing another test's data
        // directory is exactly the kind of shared state that makes a suite
        // flaky.
        // Safety: test-only process env mutation, serialized by the market lock.
        unsafe {
            std::env::set_var("PI_DESKTOP_PLUGIN_MARKET_URL", OFFICIAL_MARKET_CATALOG_URL);
        }
        let official = offline_manager(dir.path());
        assert_eq!(official.resolve_trust(&v2_entry()), "verified");

        // The same claim from a source the user pointed at themselves cannot
        // promote itself past community.
        unsafe {
            std::env::set_var("PI_DESKTOP_PLUGIN_MARKET_URL", "https://plugins.company.local/catalog.json");
        }
        let custom = offline_manager(dir.path());
        assert_eq!(custom.resolve_trust(&v2_entry()), "community");

        // An unrecognised tier is not trusted, and a v1 entry keeps its meaning.
        let mut odd = v2_entry();
        odd.trust = Some("platinum".into());
        assert_eq!(custom.resolve_trust(&odd), "unknown");
        let mut v1 = v2_entry();
        v1.trust = None;
        v1.verified = false;
        assert_eq!(custom.resolve_trust(&v1), "community");

        unsafe {
            std::env::remove_var("PI_DESKTOP_PLUGIN_MARKET_URL");
        }
    }
}
