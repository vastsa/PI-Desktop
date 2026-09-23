//! Renderer-slot declarations: `manifest.renderer` and its two whitelists.
//!
//! The desktop host evaluates the renderer entry inside its own window, so
//! the install-time checks here keep the declaration well formed and the entry
//! a real module file inside the package. The whitelists themselves are
//! enforced by the desktop host at runtime (`docs/plugin-plan/slot-contract.html`).

use super::*;

/// Mirrors `MAX_RENDERER_ACTIONS_PER_PLUGIN` in the plugin SDK.
const MAX_RENDERER_ACTIONS: usize = 16;
/// Mirrors `MAX_RENDERER_CALL_METHODS_PER_PLUGIN` in the plugin SDK.
const MAX_RENDERER_CALL_METHODS: usize = 32;

/// `manifest.renderer` gate: the permission coupling, the whitelist shapes,
/// and an entry that is a `.js`/`.mjs` file inside the package, also after
/// symlinks are resolved.
pub(crate) fn validate_renderer(root: &Path, manifest: &PluginManifest) -> Result<()> {
    let declares_whitelist =
        !manifest.renderer_actions.is_empty() || !manifest.renderer_call_methods.is_empty();
    if manifest.renderer.is_none() && !declares_whitelist {
        return Ok(());
    }
    if !manifest
        .permissions
        .iter()
        .any(|p| p == "renderer.extension")
    {
        bail!("PLUGIN_INVALID: renderer modules require the renderer.extension permission");
    }
    for (field, values, max) in [
        (
            "rendererActions",
            &manifest.renderer_actions,
            MAX_RENDERER_ACTIONS,
        ),
        (
            "rendererCallMethods",
            &manifest.renderer_call_methods,
            MAX_RENDERER_CALL_METHODS,
        ),
    ] {
        if values.iter().any(|value| value.trim().is_empty()) {
            bail!("PLUGIN_INVALID: manifest.{field} entries must be non-empty strings");
        }
        if values.len() > max {
            bail!("PLUGIN_INVALID: manifest.{field} allows at most {max} entries");
        }
    }
    let Some(entry) = manifest.renderer.as_deref() else {
        bail!("PLUGIN_INVALID: renderer whitelists require manifest.renderer");
    };
    if entry.trim().is_empty() {
        bail!("PLUGIN_INVALID: manifest.renderer must be a non-empty string");
    }
    if !(entry.ends_with(".js") || entry.ends_with(".mjs")) {
        bail!("PLUGIN_INVALID: manifest.renderer must be a .js or .mjs module");
    }
    let joined = safe_join(root, entry)?;
    let package_root = root
        .canonicalize()
        .map_err(|_| anyhow!("PLUGIN_INVALID: plugin package root cannot be resolved"))?;
    let resolved = joined
        .canonicalize()
        .map_err(|_| anyhow!("PLUGIN_INVALID: renderer entry missing: {entry}"))?;
    if !resolved.starts_with(&package_root) {
        bail!("PLUGIN_INVALID: renderer entry {entry} resolves outside the plugin package");
    }
    if !resolved.is_file() {
        bail!("PLUGIN_INVALID: renderer entry missing: {entry}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn manifest(extra: Value) -> Value {
        let mut value = json!({
            "schemaVersion": 1,
            "id": "demo.renderer",
            "name": "Renderer",
            "version": "0.1.0",
            "main": "main.js",
        });
        let object = value.as_object_mut().unwrap();
        for (key, field) in extra.as_object().unwrap() {
            object.insert(key.clone(), field.clone());
        }
        value
    }

    fn write(root: &Path, manifest: &Value, files: &[&str]) {
        fs::create_dir_all(root).unwrap();
        fs::write(root.join("main.js"), "export function onLoad() {}").unwrap();
        fs::write(root.join("manifest.json"), manifest.to_string()).unwrap();
        for rel in files {
            let path = root.join(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, "export function onLoad() {}").unwrap();
        }
    }

    fn rejection(root: &Path) -> String {
        PluginManager::read_manifest(root)
            .expect_err("manifest should be rejected")
            .to_string()
    }

    #[test]
    fn a_granted_module_entry_inside_the_package_is_accepted() {
        let dir = tempdir().unwrap();
        let root = dir.path().join("plugin");
        let value = manifest(json!({
            "renderer": "renderer/index.mjs",
            "rendererActions": ["plugin.call"],
            "rendererCallMethods": ["stats.summary"],
            "permissions": ["renderer.extension"],
        }));
        write(&root, &value, &["renderer/index.mjs"]);
        let parsed = PluginManager::read_manifest(&root).unwrap();
        assert_eq!(parsed.renderer.as_deref(), Some("renderer/index.mjs"));
        assert_eq!(parsed.renderer_actions, vec!["plugin.call".to_string()]);
    }

    #[test]
    fn the_renderer_surface_requires_its_permission_and_an_entry() {
        let dir = tempdir().unwrap();
        let root = dir.path().join("plugin");
        write(
            &root,
            &manifest(json!({ "renderer": "renderer.js" })),
            &["renderer.js"],
        );
        assert!(
            rejection(&root).contains("require the renderer.extension permission"),
            "{}",
            rejection(&root)
        );

        write(
            &root,
            &manifest(json!({
                "rendererActions": ["plugin.call"],
                "permissions": ["renderer.extension"],
            })),
            &[],
        );
        assert!(
            rejection(&root).contains("require manifest.renderer"),
            "{}",
            rejection(&root)
        );
    }

    #[test]
    fn the_entry_must_be_an_existing_module_file() {
        let dir = tempdir().unwrap();
        let root = dir.path().join("plugin");
        let granted = |entry: &str| {
            manifest(json!({
                "renderer": entry,
                "permissions": ["renderer.extension"],
            }))
        };
        write(&root, &granted("renderer.css"), &["renderer.css"]);
        assert!(rejection(&root).contains(".js or .mjs module"));

        write(&root, &granted("missing.js"), &[]);
        assert!(rejection(&root).contains("renderer entry missing: missing.js"));

        write(&root, &granted("../outside.js"), &[]);
        assert!(rejection(&root).contains("path traversal is not allowed"));

        fs::create_dir_all(root.join("folder.js")).unwrap();
        write(&root, &granted("folder.js"), &[]);
        assert!(rejection(&root).contains("renderer entry missing: folder.js"));
    }

    #[test]
    fn whitelists_are_bounded_and_non_empty() {
        let dir = tempdir().unwrap();
        let root = dir.path().join("plugin");
        let actions: Vec<String> = (0..=MAX_RENDERER_ACTIONS)
            .map(|index| format!("demo.action{index}"))
            .collect();
        write(
            &root,
            &manifest(json!({
                "renderer": "renderer.js",
                "rendererActions": actions,
                "permissions": ["renderer.extension"],
            })),
            &["renderer.js"],
        );
        assert!(rejection(&root).contains("rendererActions allows at most 16 entries"));

        let methods: Vec<String> = (0..=MAX_RENDERER_CALL_METHODS)
            .map(|index| format!("method{index}"))
            .collect();
        write(
            &root,
            &manifest(json!({
                "renderer": "renderer.js",
                "rendererCallMethods": methods,
                "permissions": ["renderer.extension"],
            })),
            &["renderer.js"],
        );
        assert!(rejection(&root).contains("rendererCallMethods allows at most 32 entries"));

        write(
            &root,
            &manifest(json!({
                "renderer": "renderer.js",
                "rendererCallMethods": [" "],
                "permissions": ["renderer.extension"],
            })),
            &["renderer.js"],
        );
        assert!(rejection(&root).contains("rendererCallMethods entries must be non-empty"));
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_entry_cannot_escape_the_package() {
        let dir = tempdir().unwrap();
        let root = dir.path().join("plugin");
        let outside = dir.path().join("outside.js");
        fs::write(&outside, "export function onLoad() {}").unwrap();
        write(
            &root,
            &manifest(json!({
                "renderer": "renderer.js",
                "permissions": ["renderer.extension"],
            })),
            &[],
        );
        std::os::unix::fs::symlink(&outside, root.join("renderer.js")).unwrap();
        assert!(
            rejection(&root).contains("resolves outside the plugin package"),
            "{}",
            rejection(&root)
        );
    }
}
