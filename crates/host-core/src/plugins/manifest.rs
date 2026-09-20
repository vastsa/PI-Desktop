use super::*;

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
    /// Display strings per locale — `{ "en": { name, description, safetyNotes },
    /// "zh-CN": { … } }` — resolved against the application locale whenever a
    /// row is read. The flat `name`/`description` above stay the author's own
    /// language and are the last-resort fallback.
    #[serde(default)]
    pub i18n: Option<PluginI18nMap>,
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
    /// First-registration default for bundled plugins. Marketplace/dev
    /// installs still enable after the user grants permissions.
    #[serde(default, rename = "enabledByDefault")]
    pub enabled_by_default: Option<bool>,
}

impl PluginManager {
    pub(crate) fn read_manifest(path: &Path) -> Result<PluginManifest> {
        let manifest_path = path.join("manifest.json");
        if !manifest_path.exists() {
            bail!("PLUGIN_INVALID: manifest.json missing");
        }
        let raw = fs::read_to_string(&manifest_path)
            .with_context(|| format!("read manifest {}", manifest_path.display()))?;
        let mut manifest: PluginManifest =
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
        let fields: Value = serde_json::from_str(&raw)?;
        if let Some(renderer) = fields.get("renderer") {
            let entry = renderer
                .as_str()
                .filter(|entry| !entry.trim().is_empty())
                .ok_or_else(|| anyhow!("PLUGIN_INVALID: renderer must be a non-empty string"))?;
            if std::path::Path::new(entry).is_absolute()
                || entry.contains('\\')
                || entry.split('/').any(|part| part == "..")
            {
                bail!("PLUGIN_INVALID: renderer entry must be a relative path without traversal");
            }
            let root = path.canonicalize()?;
            let target = path
                .join(entry)
                .canonicalize()
                .context("PLUGIN_INVALID: renderer entry missing")?;
            if !target.starts_with(&root) || !target.is_file() {
                bail!("PLUGIN_INVALID: renderer entry must stay inside the plugin directory");
            }
            if !manifest
                .permissions
                .iter()
                .any(|permission| permission == "ui.renderer")
            {
                manifest.permissions.push("ui.renderer".into());
            }
        }
        validate_contributions(path, &manifest)?;
        Ok(manifest)
    }
}
