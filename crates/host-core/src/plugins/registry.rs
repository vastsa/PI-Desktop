use super::*;
use std::collections::BTreeSet;

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
    pub(crate) data_dir: PathBuf,
    pub(crate) runtime: Vec<PluginSummary>,
    /// Ids this build ships from `resources/plugins` (ADR 0241).
    ///
    /// Recomputed from disk on every launch and never persisted: a plugin this
    /// build stops shipping must stop being protected immediately, whatever the
    /// row that survives it looks like.
    pub(crate) bundled_ids: BTreeSet<String>,
    /// Catalog channel pinned by app settings, and the URL for `custom`.
    pub(crate) market_channel: MarketChannel,
    pub(crate) market_custom_url: Option<String>,
    /// Cancel token of the install currently running, when one is.
    ///
    /// The renderer's cancel action flips it and the download loop reads it.
    /// Only one install runs at a time — the RPC that starts one holds the
    /// state lock — so a single slot is enough.
    pub(crate) install_cancel: Option<CancelToken>,
    /// Locale a row's display fields are resolved against.
    ///
    /// The desktop shell owns the app language — `settings.language`, or the
    /// OS locale while it is `auto` — and pushes it here. Until it does, rows
    /// read English, which is the source language of the plugin contract.
    pub(crate) locale: String,
}

impl PluginManager {
    /// Build a manager against a specific catalog channel.
    ///
    /// The channel is applied before the first catalog fetch so a non-default
    /// source configured in settings is honoured on the very first launch, not
    /// only after an explicit refresh.
    pub fn new(
        data_dir: &Path,
        market_channel: MarketChannel,
        market_custom_url: Option<String>,
    ) -> Self {
        let mut mgr = Self {
            data_dir: data_dir.to_path_buf(),
            runtime: Vec::new(),
            bundled_ids: BTreeSet::new(),
            market_channel,
            market_custom_url,
            install_cancel: None,
            locale: "en".into(),
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
    ///
    /// The user *may* update a bundled plugin from the marketplace (ADR 0241).
    /// Their copy is not state to discard: it stays registered for as long as
    /// this build does not ship something newer, so an update survives the next
    /// launch while a stale install cannot hold an app update back.
    pub fn sync_builtin(&mut self, dir: Option<&Path>) -> Result<()> {
        let mut shipped: Vec<PluginSummary> = Vec::new();
        if let Some(dir) = dir {
            let entries = match fs::read_dir(dir) {
                Ok(entries) => entries,
                // A build without bundled plugins is valid, not an error.
                Err(_) => {
                    self.bundled_ids.clear();
                    for plugin in &mut self.runtime {
                        plugin.bundled = false;
                    }
                    return self.drop_missing_builtin(&shipped);
                }
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
                let enabled = previous
                    .map(|p| p.enabled)
                    .unwrap_or(manifest.enabled_by_default.unwrap_or(true));
                shipped.push(PluginSummary {
                    id: manifest.id.clone(),
                    name: manifest.name.clone(),
                    version: manifest.version.clone(),
                    enabled,
                    scope: previous.map(|p| p.scope.clone()).unwrap_or_default(),
                    source: "builtin".into(),
                    bundled: true,
                    status: if enabled {
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
                    i18n: manifest.i18n.clone(),
                });
            }
        }

        self.bundled_ids = shipped.iter().map(|p| p.id.clone()).collect();
        self.drop_missing_builtin(&shipped)?;
        for summary in shipped {
            // An install the user made over a bundled plugin is theirs to keep:
            // it stays registered unless this build ships something newer.
            let user_copy = self
                .runtime
                .iter()
                .find(|p| p.id == summary.id && p.source != "builtin")
                .filter(|p| compare_plugin_versions(&p.version, &summary.version) != Ordering::Less)
                .cloned();
            self.runtime.retain(|p| p.id != summary.id);
            self.runtime.push(match user_copy {
                Some(existing) => PluginSummary {
                    bundled: true,
                    ..existing
                },
                None => summary,
            });
        }
        // What this build ships decides the flag, not what the row says: a
        // plugin dropped from a newer build stops being bundled on the same
        // launch that drops it.
        let bundled_ids = self.bundled_ids.clone();
        for plugin in &mut self.runtime {
            plugin.bundled = bundled_ids.contains(&plugin.id);
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

    pub(crate) fn ensure_dirs(&self) -> Result<()> {
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

    pub(crate) fn registry_path(&self) -> PathBuf {
        self.data_dir.join("plugins/registry.json")
    }

    pub(crate) fn catalog_path(&self) -> PathBuf {
        self.data_dir.join("plugins/market/catalog.json")
    }

    pub(crate) fn installed_dir(&self, id: &str) -> PathBuf {
        self.data_dir
            .join("plugins/installed")
            .join(sanitize_id(id))
    }

    pub(crate) fn data_dir_for(&self, id: &str) -> PathBuf {
        self.data_dir.join("plugins/data").join(sanitize_id(id))
    }

    pub fn list(&self) -> Vec<PluginSummary> {
        self.runtime
            .iter()
            .map(|plugin| plugin.localized(&self.locale))
            .collect()
    }

    pub fn get(&self, id: &str) -> Option<PluginSummary> {
        self.runtime
            .iter()
            .find(|p| p.id == id)
            .map(|plugin| plugin.localized(&self.locale))
    }

    /// Follow the app language pushed down by the desktop shell.
    ///
    /// Stored rows keep the author's own strings; only reads are resolved, so
    /// switching language never rewrites the registry.
    pub fn set_locale(&mut self, locale: &str) {
        let next = locale.trim();
        // `auto` is a setting, not a locale: the desktop shell resolves it
        // before pushing. Storing it would only make every lookup read English.
        if next.is_empty() || next.eq_ignore_ascii_case("auto") {
            return;
        }
        if next != self.locale {
            self.locale = next.to_string();
        }
    }

    /// Locale a row's display text is resolved against.
    pub fn locale(&self) -> &str {
        &self.locale
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
            plugin.i18n = manifest.i18n.clone();
        }
        Ok(())
    }

    pub(crate) fn save(&self) -> Result<()> {
        let path = self.registry_path();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(path, serde_json::to_string_pretty(&self.runtime)?)?;
        Ok(())
    }

    pub(crate) fn upsert_summary(&mut self, summary: PluginSummary) -> Result<PluginSummary> {
        self.runtime.retain(|p| p.id != summary.id);
        // The row is stored as the author wrote it and localized on the way
        // out, so every reader of this summary gets the same treatment as
        // `list()` and `get()`.
        let response = summary.localized(&self.locale);
        self.runtime.push(summary);
        self.save()?;
        Ok(response)
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
            bundled: false,
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
            i18n: manifest.i18n.clone(),
        };
        self.upsert_summary(summary)
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
            let out = plugin.localized(&self.locale);
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
            let out = plugin.localized(&self.locale);
            self.save()?;
            return Ok(Some(out));
        }
        Ok(None)
    }

    pub fn set_auto_update(&mut self, id: &str, enabled: bool) -> Result<Option<PluginSummary>> {
        if let Some(plugin) = self.runtime.iter_mut().find(|p| p.id == id) {
            plugin.auto_update = Some(enabled);
            plugin.updated_at = Some(Utc::now().to_rfc3339());
            let out = plugin.localized(&self.locale);
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
        //
        // The id decides this, not the row: a bundled plugin the user updated
        // from the marketplace stays uninstallable even though it now lives
        // under `plugins/installed` and carries a marketplace source (ADR 0241).
        if self.bundled_ids.contains(id) {
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
            let out = plugin.localized(&self.locale);
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
            let out = plugin.localized(&self.locale);
            self.save()?;
            return Ok(Some(out));
        }
        Ok(None)
    }
}
