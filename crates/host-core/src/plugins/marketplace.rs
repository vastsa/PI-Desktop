use super::*;

pub mod catalog;
pub(crate) use catalog::{built_in_catalog, bundled_package_bytes};

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

impl PluginManager {
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

    pub(crate) fn market_cache_meta_path(&self) -> PathBuf {
        self.data_dir.join("plugins/market/cache-meta.json")
    }

    pub(crate) fn ensure_default_catalog(&self) -> Result<()> {
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
    pub(crate) fn resolve_package_url(
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
                version.url = Self::resolve_package_url(catalog_url, base.as_deref(), &version.url);
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
    pub(crate) fn cached_catalog_matches_source(&self, catalog_url: &str) -> bool {
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

    pub(crate) fn market_download_info_from_catalog(
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

    pub(crate) fn to_market_summary(&self, entry: &MarketCatalogEntry) -> MarketPluginSummary {
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
    pub(crate) fn resolve_trust(&self, entry: &MarketCatalogEntry) -> String {
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

pub(crate) fn host_supports_version(version: &MarketVersion) -> bool {
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
pub(crate) fn has_package_metadata(version: &MarketVersion) -> bool {
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
pub(crate) fn latest_market_version<'a>(
    versions: &'a [MarketVersion],
) -> Option<&'a MarketVersion> {
    versions
        .iter()
        .filter(|version| !version.yanked)
        .max_by(|a, b| compare_plugin_versions(&a.version, &b.version))
}

pub(crate) fn compare_plugin_versions(left: &str, right: &str) -> Ordering {
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
