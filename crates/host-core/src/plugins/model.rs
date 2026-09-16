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
    /// True while this application build ships the plugin from
    /// `resources/plugins` (ADR 0241).
    ///
    /// A bundled plugin cannot be uninstalled, but the user may update it from
    /// the marketplace. The flag follows that update, so the panel keeps
    /// offering the actions that stay valid for the plugin.
    #[serde(default)]
    pub bundled: bool,
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
    /// `manifest.i18n`, held in memory only.
    ///
    /// Display metadata that the host resolves before a row leaves the
    /// process, so it is neither persisted in the registry nor sent over RPC:
    /// the renderer keeps reading finished strings (ADR 0160 §4). Every path
    /// that rebuilds a row from a manifest refills it.
    #[serde(default, skip_serializing)]
    pub i18n: Option<PluginI18nMap>,
}

/// One locale's display strings for a plugin (`manifest.i18n`, catalog `i18n`).
///
/// Every field is optional so a partially translated block still falls back
/// per field instead of losing the author's own language.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginDisplayI18n {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub safety_notes: Option<String>,
}

/// Locale id → display strings. Plugins ship `en` plus `zh-CN`; other keys are
/// kept but never selected, so a manifest may carry more than the contract
/// requires without the host having to understand them.
pub type PluginI18nMap = std::collections::BTreeMap<String, PluginDisplayI18n>;

/// Which entry of a [`PluginI18nMap`] a shell locale reads.
///
/// Mirrors `resolvePluginLocalizedString` in `@pi-desktop/plugin-sdk`: every
/// Chinese shell locale reads `zh-CN`, everything else reads `en`. Plugins are
/// not required to translate themselves into every shipped shell locale, so
/// `zh-TW` deliberately reads English rather than half a `zh-CN` guess
/// (ADR 0182).
pub(crate) fn plugin_display_locale(locale: &str) -> &'static str {
    let lower = locale.trim().replace('_', "-").to_lowercase();
    let simplified_chinese = lower == "zh"
        || lower == "zh-cn"
        || lower.starts_with("zh-cn-")
        || lower == "zh-hans"
        || lower.starts_with("zh-hans-")
        || lower == "zh-sg"
        || lower.starts_with("zh-sg-");
    if simplified_chinese {
        "zh-CN"
    } else {
        "en"
    }
}

/// One localized field: the locale's entry, else English, else whichever block
/// is there. An empty string counts as missing — a half-filled translation
/// must not blank out a row that has a usable author-written name.
pub(crate) fn localized_field<'a>(
    map: Option<&'a PluginI18nMap>,
    locale: &str,
    pick: impl Fn(&'a PluginDisplayI18n) -> Option<&'a String>,
) -> Option<&'a String> {
    let map = map?;
    let mut order = vec![plugin_display_locale(locale)];
    for key in ["en", "zh-CN"] {
        if !order.contains(&key) {
            order.push(key);
        }
    }
    for key in order {
        if let Some(value) = map.get(key).and_then(&pick) {
            if !value.trim().is_empty() {
                return Some(value);
            }
        }
    }
    None
}

impl PluginSummary {
    /// The row as the active locale should read it.
    ///
    /// Only display text moves: ids, versions, permissions and state are
    /// language-independent, and a plugin without an `i18n` block keeps the
    /// strings its author wrote.
    pub(crate) fn localized(&self, locale: &str) -> PluginSummary {
        let mut out = self.clone();
        if let Some(name) = localized_field(self.i18n.as_ref(), locale, |entry| entry.name.as_ref())
        {
            out.name = name.clone();
        }
        if let Some(description) = localized_field(self.i18n.as_ref(), locale, |entry| {
            entry.description.as_ref()
        }) {
            out.description = Some(description.clone());
        }
        out
    }
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
    /// Display strings per locale, resolved against the app language before a
    /// card or detail view is built.
    #[serde(default)]
    pub(crate) i18n: Option<PluginI18nMap>,
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
