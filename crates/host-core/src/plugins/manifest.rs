use super::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginManifest {
    #[serde(rename = "schemaVersion")]
    pub schema_version: u32,
    pub id: String,
    pub name: String,
    pub version: String,
    pub main: String,
    /// Renderer entry module (relative path). Declaring it requires the
    /// `renderer.extension` permission; the module registers UI slot
    /// components in the host renderer (`docs/plugin-plan/ui/`).
    #[serde(default, rename = "renderer")]
    pub renderer: Option<String>,
    /// Outbound actions the renderer components may dispatch; the desktop
    /// host refuses anything outside this list.
    #[serde(default, rename = "rendererActions")]
    pub renderer_actions: Vec<String>,
    /// Methods the plugin's `onRendererCall` answers for `plugin.call`.
    #[serde(default, rename = "rendererCallMethods")]
    pub renderer_call_methods: Vec<String>,
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
        let manifest: PluginManifest =
            serde_json::from_str(&raw).map_err(|e| anyhow!("PLUGIN_INVALID: {e}"))?;
        if manifest.id.trim().is_empty() || manifest.main.trim().is_empty() {
            bail!("PLUGIN_INVALID: id/main required");
        }
        validate_plugin_id(&manifest.id)?;
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
        validate_renderer(path, &manifest)?;
        Ok(manifest)
    }
}

/// A plugin id names the plugin's install directory, data directory, log
/// file, and browser session partition. Each of those maps characters
/// outside `[A-Za-z0-9._-]` to `_`, so only ids already made of those
/// characters keep distinct plugins in distinct places, and `.` / `..`
/// would name a parent or current directory instead of the plugin's own.
/// Windows also drops a trailing `.` from a path segment and resolves
/// device names (`con`, `nul.x`, ...) to devices, so those ids could not
/// name a directory of their own either. Ids that share a storage name with
/// another registered plugin (letter case, or a legacy row stored under its
/// sanitized name) are a registry-level conflict, see
/// `ensure_storage_identity_free`.
fn validate_plugin_id(id: &str) -> Result<()> {
    let allowed = id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'));
    if !allowed || id == "." || id == ".." {
        bail!("PLUGIN_INVALID: id may only contain letters, digits, '.', '-' and '_'");
    }
    if id.ends_with('.') {
        bail!("PLUGIN_INVALID: id must not end with '.'");
    }
    let stem = id.split('.').next().unwrap_or(id).to_ascii_lowercase();
    let reserved = matches!(stem.as_str(), "con" | "prn" | "aux" | "nul")
        || ((stem.starts_with("com") || stem.starts_with("lpt"))
            && stem.len() == 4
            && matches!(stem.as_bytes()[3], b'1'..=b'9'));
    if reserved {
        bail!("PLUGIN_INVALID: id must not start with a Windows device name");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn write_manifest(root: &Path, manifest: Value) {
        fs::create_dir_all(root).unwrap();
        fs::write(root.join("manifest.json"), manifest.to_string()).unwrap();
    }

    fn base() -> Value {
        json!({
            "schemaVersion": 1,
            "id": "demo.entries",
            "name": "Entries",
            "version": "0.1.0",
            "main": "main.js",
        })
    }

    #[test]
    fn a_missing_main_entry_fails_the_load() {
        let dir = tempdir().unwrap();
        write_manifest(dir.path(), base());
        let error = PluginManager::read_manifest(dir.path()).unwrap_err();
        assert_eq!(error.to_string(), "PLUGIN_LOAD_FAILED: main entry missing");
    }

    #[test]
    fn a_declared_panel_must_exist() {
        let dir = tempdir().unwrap();
        let mut manifest = base();
        manifest["ui"] = json!({ "panel": "ui/index.html" });
        write_manifest(dir.path(), manifest);
        fs::write(dir.path().join("main.js"), "export function onLoad() {}").unwrap();
        let error = PluginManager::read_manifest(dir.path()).unwrap_err();
        assert_eq!(error.to_string(), "PLUGIN_INVALID: ui.panel missing");

        fs::create_dir_all(dir.path().join("ui")).unwrap();
        fs::write(dir.path().join("ui/index.html"), "<!doctype html>").unwrap();
        assert!(PluginManager::read_manifest(dir.path()).is_ok());
    }

    fn read_with_id(id: &str) -> Result<PluginManifest> {
        let dir = tempdir().unwrap();
        let mut manifest = base();
        manifest["id"] = json!(id);
        write_manifest(dir.path(), manifest);
        fs::write(dir.path().join("main.js"), "export function onLoad() {}").unwrap();
        PluginManager::read_manifest(dir.path())
    }

    #[test]
    fn ids_that_would_share_a_directory_or_partition_are_rejected() {
        for id in ["foo!bar", "foo/bar", "foo bar", "插件", "..", "."] {
            let error = read_with_id(id).unwrap_err();
            assert_eq!(
                error.to_string(),
                "PLUGIN_INVALID: id may only contain letters, digits, '.', '-' and '_'",
                "{id}"
            );
        }
        for (id, message) in [
            ("e2e.foo.", "PLUGIN_INVALID: id must not end with '.'"),
            (
                "con",
                "PLUGIN_INVALID: id must not start with a Windows device name",
            ),
            (
                "NUL.plugin",
                "PLUGIN_INVALID: id must not start with a Windows device name",
            ),
            (
                "com1.x",
                "PLUGIN_INVALID: id must not start with a Windows device name",
            ),
        ] {
            assert_eq!(read_with_id(id).unwrap_err().to_string(), message, "{id}");
        }
        for id in [
            "foo_bar",
            "pi.browser",
            "io.github.b1eight.pi-desktop-claude-theme",
            "a..b",
            "console.tools",
            "com.example.x",
            "com10.x",
        ] {
            assert_eq!(read_with_id(id).unwrap().id, id);
        }
    }

    #[test]
    fn every_accepted_id_keeps_its_own_install_and_data_directory() {
        let dir = tempdir().unwrap();
        let manager = PluginManager::new(dir.path(), MarketChannel::Official, None);
        let accepted: Vec<String> = ["foo_bar", "foo!bar", "foo/bar", "foo-bar", "foo.bar"]
            .into_iter()
            .filter_map(|id| read_with_id(id).ok().map(|m| m.id))
            .collect();
        assert_eq!(accepted, ["foo_bar", "foo-bar", "foo.bar"]);
        let installed: std::collections::HashSet<_> = accepted
            .iter()
            .map(|id| manager.installed_dir(id))
            .collect();
        let data: std::collections::HashSet<_> =
            accepted.iter().map(|id| manager.data_dir_for(id)).collect();
        assert_eq!(installed.len(), accepted.len());
        assert_eq!(data.len(), accepted.len());
        for path in installed {
            assert!(path.starts_with(dir.path().join("plugins/installed")));
        }
    }
}
