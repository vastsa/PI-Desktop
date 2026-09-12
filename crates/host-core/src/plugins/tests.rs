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
fn curl_diagnostic_decoding_preserves_utf8() {
    let diagnostic = "curl: (35) TLS handshake failed\n";
    assert_eq!(decode_curl_output(diagnostic.as_bytes()), diagnostic);
}

#[cfg(windows)]
#[test]
fn curl_diagnostic_decoding_handles_gbk() {
    // "你好" encoded as GBK, representative of localized curl output on
    // a Simplified Chinese Windows installation.
    let gbk = [0xC4, 0xE3, 0xBA, 0xC3];
    assert_eq!(decode_windows_code_page(&gbk, 936).as_deref(), Some("你好"));
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
        assert_eq!(
            compare_plugin_versions("0.5.1", "0.5.1-beta.1"),
            Ordering::Greater
        );
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
        assert!(mgr
            .market_get("demo.hello")
            .unwrap()
            .versions
            .iter()
            .any(|v| v.version == "0.9.0"));

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
        fs::write(mgr.catalog_path(), serde_json::to_string(&foreign).unwrap()).unwrap();
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
    assert!(mgr
        .uninstall("pi.files")
        .unwrap_err()
        .to_string()
        .contains("cannot be uninstalled"),);

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
fn bundled_plugin_can_default_to_disabled_without_overwriting_user_state() {
    let ship = tempdir().unwrap();
    let root = ship.path().join("pi.opt-in");
    write_plugin(
        &root,
        json!({
            "schemaVersion": 1,
            "id": "pi.opt-in",
            "name": "Opt In",
            "version": "1.0.0",
            "main": "main.js",
            "enabledByDefault": false,
            "permissions": ["ui.panel"],
        }),
        &[],
    );

    let data = tempdir().unwrap();
    let mut mgr = PluginManager::new(data.path(), None);
    mgr.sync_builtin(Some(ship.path())).unwrap();
    let listed = mgr.get("pi.opt-in").expect("bundled plugin is registered");
    assert!(!listed.enabled, "opt-in bundled plugins start disabled");
    assert_eq!(listed.status, "disabled");
    assert!(mgr
        .uninstall("pi.opt-in")
        .unwrap_err()
        .to_string()
        .contains("cannot be uninstalled"),);

    mgr.set_enabled("pi.opt-in", true).unwrap();
    mgr.sync_builtin(Some(ship.path())).unwrap();
    let after = mgr.get("pi.opt-in").unwrap();
    assert!(after.enabled, "an explicit enable survives the next launch");
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
    package_host_allowed(
        "http://127.0.0.1:8080/a.piplug",
        "http://127.0.0.1:8080/catalog.json",
    )
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
        PluginManager::resolve_package_url(
            catalog,
            Some("https://base.test/"),
            "https://cnb.cool/x.piplug"
        ),
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

    let github = PluginManager::resolve_package_url(OFFICIAL_MARKET_CATALOG_URL, None, relative);
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
            latest_market_version(&entry.versions)
                .expect("live version")
                .version,
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
        std::env::set_var(
            "PI_DESKTOP_PLUGIN_MARKET_URL",
            "https://plugins.company.local/catalog.json",
        );
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
