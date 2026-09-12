use super::*;

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
pub(crate) struct MarketCatalogEntry {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) description: String,
    pub(crate) author: String,
    #[serde(default)]
    pub(crate) icon_url: Option<String>,
    #[serde(default)]
    pub(crate) categories: Vec<String>,
    #[serde(default)]
    pub(crate) verified: bool,
    /// Catalog v2 trust tier, issued by the center. `verified` is only honoured
    /// from the official/mirror source; see `resolve_trust`.
    #[serde(default)]
    pub(crate) trust: Option<String>,
    #[serde(default)]
    pub(crate) publisher_id: Option<String>,
    #[serde(default)]
    pub(crate) downloads: Option<u64>,
    #[serde(default)]
    pub(crate) homepage: Option<String>,
    #[serde(default)]
    pub(crate) repository: Option<String>,
    #[serde(default)]
    pub(crate) readme_markdown: Option<String>,
    #[serde(default)]
    pub(crate) safety_notes: Option<String>,
    pub(crate) versions: Vec<MarketVersion>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(crate) struct MarketCatalogFile {
    /// Absent or 1 means the v1 schema. v2 adds provenance, review verdicts,
    /// yank state, and a declared artifact base.
    #[serde(default = "default_schema_version")]
    pub(crate) schema_version: u32,
    #[serde(default = "default_provider_id")]
    pub(crate) provider_id: String,
    #[serde(default)]
    pub(crate) catalog_id: Option<String>,
    #[serde(default)]
    pub(crate) name: Option<String>,
    #[serde(default)]
    pub(crate) homepage: Option<String>,
    #[serde(default)]
    pub(crate) updated_at: Option<String>,
    #[serde(default)]
    pub(crate) generated_at: Option<String>,
    #[serde(default)]
    pub(crate) policy_version: Option<String>,
    /// Base a relative package URL resolves against. A mirror declares its own
    /// base, so switching source never sends a download to another provider.
    #[serde(default)]
    pub(crate) artifact_base_url: Option<String>,
    #[serde(default)]
    pub(crate) plugins: Vec<MarketCatalogEntry>,
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
