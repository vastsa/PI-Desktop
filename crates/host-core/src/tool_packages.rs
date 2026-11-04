//! Bundled tool packages (D681).
//!
//! A tool package is a directory under the build's `resources/tools` with a
//! `tool.json` manifest: one id, one display name, and the tools it offers the
//! agent. This build ships them inside the application image, so the directory
//! is read-only at runtime and the host owns both halves of the feature:
//!
//! * the scan (`list`) — Electron resolves the packaged location and passes it
//!   down through `PI_DESKTOP_BUILTIN_TOOLS_DIR`, because only it knows whether
//!   the app runs from `resources/` or a source checkout;
//! * the enabled set (`set_enabled`) — persisted in `<data>/tools/state.json`,
//!   because the renderer must never read or write the filesystem itself.
//!
//! A package that cannot be read still reports a row: dropping it silently
//! would leave the user with no way to see why their package does nothing.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

/// Manifest file name inside each package directory.
pub const MANIFEST_FILE: &str = "tool.json";
/// Relative path of the persisted enabled set inside the data directory.
const STATE_FILE: &str = "tools/state.json";
/// Manifest schema this build understands.
const SCHEMA_VERSION: u32 = 1;

/// Directory holding the tool packages this application build ships, if any.
///
/// Mirrors `plugins::builtin_plugins_dir`: Electron resolves the packaged
/// location and passes it down, because only it knows whether the app is
/// running from `resources/` or a source checkout.
pub fn builtin_tools_dir() -> Option<PathBuf> {
    let raw = std::env::var("PI_DESKTOP_BUILTIN_TOOLS_DIR").ok()?;
    let path = PathBuf::from(raw.trim());
    if path.as_os_str().is_empty() || !path.is_dir() {
        return None;
    }
    Some(path)
}

/// One tool a package declares, shaped like a plugin `agentTools` entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ToolPackageTool {
    pub name: String,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub risk: Option<String>,
}

/// One package as the tools page renders it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolPackageSummary {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    /// Directory under `resources/tools` the package was read from.
    pub dir_name: String,
    pub enabled: bool,
    pub tools: Vec<ToolPackageTool>,
    /// Why the manifest could not be read, when it could not.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ToolManifest {
    #[serde(default)]
    schema_version: u32,
    #[serde(default)]
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    version: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    author: Option<String>,
    #[serde(default)]
    tools: Vec<ManifestTool>,
}

#[derive(Debug, Default, Deserialize)]
struct ManifestTool {
    #[serde(default)]
    name: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    risk: Option<String>,
}

#[derive(Debug, Default, Deserialize, Serialize)]
struct ToolState {
    #[serde(default)]
    disabled: BTreeSet<String>,
}

fn state_path(data_dir: &Path) -> PathBuf {
    data_dir.join(STATE_FILE)
}

fn read_state(data_dir: &Path) -> Result<ToolState> {
    let path = state_path(data_dir);
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ToolState::default())
        }
        Err(error) => {
            return Err(error).with_context(|| format!("read {}", path.display()));
        }
    };
    serde_json::from_str(&text).with_context(|| format!("parse {}", path.display()))
}

fn write_state(data_dir: &Path, state: &ToolState) -> Result<()> {
    let path = state_path(data_dir);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    }
    let text = serde_json::to_string_pretty(state)?;
    // Write-then-rename: a crash mid-write must not leave an unparsable state
    // file behind, because that would take the whole tools page down.
    let staged = path.with_extension("json.tmp");
    std::fs::write(&staged, text).with_context(|| format!("write {}", staged.display()))?;
    std::fs::rename(&staged, &path).with_context(|| format!("replace {}", path.display()))
}

fn risk(value: Option<String>) -> Option<String> {
    match value.as_deref() {
        Some("low") | Some("medium") | Some("high") => value,
        // An unknown risk is treated as unstated rather than echoed to the UI.
        _ => None,
    }
}

fn summary_from_manifest(dir_name: &str, manifest: ToolManifest) -> ToolPackageSummary {
    let id = if manifest.id.trim().is_empty() {
        dir_name.to_string()
    } else {
        manifest.id.trim().to_string()
    };
    let name = if manifest.name.trim().is_empty() {
        id.clone()
    } else {
        manifest.name.trim().to_string()
    };
    ToolPackageSummary {
        id,
        name,
        version: manifest.version.trim().to_string(),
        description: manifest.description.trim().to_string(),
        author: manifest.author.filter(|author| !author.trim().is_empty()),
        dir_name: dir_name.to_string(),
        enabled: true,
        tools: manifest
            .tools
            .into_iter()
            .filter(|tool| !tool.name.trim().is_empty())
            .map(|tool| ToolPackageTool {
                name: tool.name.trim().to_string(),
                description: tool.description.trim().to_string(),
                risk: risk(tool.risk),
            })
            .collect(),
        error: None,
    }
}

fn read_package(dir: &Path, dir_name: &str) -> ToolPackageSummary {
    let broken = |message: String| ToolPackageSummary {
        id: dir_name.to_string(),
        name: dir_name.to_string(),
        version: String::new(),
        description: String::new(),
        author: None,
        dir_name: dir_name.to_string(),
        enabled: true,
        tools: Vec::new(),
        error: Some(message),
    };
    let path = dir.join(MANIFEST_FILE);
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) => return broken(format!("{}: {error}", path.display())),
    };
    let manifest: ToolManifest = match serde_json::from_str(&text) {
        Ok(manifest) => manifest,
        Err(error) => return broken(format!("{MANIFEST_FILE}: {error}")),
    };
    if manifest.schema_version != SCHEMA_VERSION {
        return broken(format!(
            "{MANIFEST_FILE}: unsupported schemaVersion {} (this build reads {SCHEMA_VERSION})",
            manifest.schema_version
        ));
    }
    summary_from_manifest(dir_name, manifest)
}

/// Every tool package this build ships, ordered by display name.
///
/// `builtin` is the resolved `resources/tools` directory; a build without one
/// ships no packages and reports an empty list rather than an error.
pub fn list(builtin: Option<&Path>, data_dir: &Path) -> Result<Vec<ToolPackageSummary>> {
    let disabled = read_state(data_dir)?.disabled;
    let Some(root) = builtin else {
        return Ok(Vec::new());
    };
    let entries = std::fs::read_dir(root).with_context(|| format!("read {}", root.display()))?;
    let mut packages: Vec<ToolPackageSummary> = Vec::new();
    let mut seen: BTreeSet<String> = BTreeSet::new();
    for entry in entries {
        let entry = entry.with_context(|| format!("read {}", root.display()))?;
        if !entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
            continue;
        }
        let dir_name = entry.file_name().to_string_lossy().to_string();
        let mut package = read_package(&entry.path(), &dir_name);
        // The enabled set keys on the manifest id, which need not match the
        // directory name; compare only once the manifest has been read.
        package.enabled = !disabled.contains(&package.id);
        // Two directories claiming one id would render as one row twice; keep
        // the first and let the second still show as broken so it is fixable.
        if !seen.insert(package.id.clone()) {
            packages.push(ToolPackageSummary {
                error: Some(format!("duplicate id {}", package.id)),
                ..package
            });
            continue;
        }
        packages.push(package);
    }
    packages.sort_by(|left, right| {
        left.name
            .to_lowercase()
            .cmp(&right.name.to_lowercase())
            .then_with(|| left.id.cmp(&right.id))
    });
    Ok(packages)
}

/// Enable or disable one package, then hand the fresh list back.
pub fn set_enabled(data_dir: &Path, id: &str, enabled: bool) -> Result<Vec<ToolPackageSummary>> {
    let id = id.trim();
    anyhow::ensure!(!id.is_empty(), "id is required");
    let mut state = read_state(data_dir)?;
    if enabled {
        state.disabled.remove(id);
    } else {
        state.disabled.insert(id.to_string());
    }
    write_state(data_dir, &state)?;
    list(builtin_tools_dir().as_deref(), data_dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn package(root: &Path, dir: &str, manifest: &str) {
        let path = root.join(dir);
        std::fs::create_dir_all(&path).unwrap();
        std::fs::write(path.join(MANIFEST_FILE), manifest).unwrap();
    }

    #[test]
    fn lists_packages_and_reports_a_broken_manifest() {
        let temp = tempfile::tempdir().unwrap();
        let tools = temp.path().join("tools");
        let data = temp.path().join("data");
        package(
            &tools,
            "local.alpha",
            r#"{"schemaVersion":1,"id":"local.alpha","name":"Alpha","version":"0.1.0",
                "description":"First","author":"me","tools":[
                  {"name":"inspect","description":"Inspect","risk":"low"},
                  {"name":"write","description":"Write","risk":"extreme"},
                  {"description":"no name"}]}"#,
        );
        package(&tools, "local.broken", r#"{"schemaVersion":1,"#);
        package(
            &tools,
            "local.old",
            r#"{"schemaVersion":99,"id":"local.old","name":"Old"}"#,
        );

        let packages = list(Some(&tools), &data).unwrap();
        assert_eq!(packages.len(), 3);

        let alpha = packages.iter().find(|p| p.id == "local.alpha").unwrap();
        assert_eq!(alpha.name, "Alpha");
        assert_eq!(alpha.version, "0.1.0");
        assert!(alpha.enabled);
        assert_eq!(alpha.tools.len(), 2, "nameless tools are dropped");
        assert_eq!(alpha.tools[0].risk.as_deref(), Some("low"));
        assert_eq!(alpha.tools[1].risk, None, "unknown risk is not echoed");

        for id in ["local.broken", "local.old"] {
            let broken = packages.iter().find(|p| p.id == id).unwrap();
            assert!(broken.error.is_some(), "{id} must report why it failed");
            assert_eq!(
                broken.name, id,
                "a broken package still names its directory"
            );
        }
    }

    #[test]
    fn toggle_persists_in_the_data_directory() {
        let temp = tempfile::tempdir().unwrap();
        let tools = temp.path().join("tools");
        let data = temp.path().join("data");
        package(
            &tools,
            "local.alpha",
            r#"{"schemaVersion":1,"id":"local.alpha","name":"Alpha"}"#,
        );

        set_enabled(&data, "local.alpha", false).unwrap();
        let after_disable = list(Some(&tools), &data).unwrap();
        assert!(!after_disable[0].enabled);
        let state = std::fs::read_to_string(data.join(STATE_FILE)).unwrap();
        assert!(
            state.contains("local.alpha"),
            "state file records the id: {state}"
        );

        set_enabled(&data, "local.alpha", true).unwrap();
        assert!(list(Some(&tools), &data).unwrap()[0].enabled);
    }

    #[test]
    fn the_enabled_set_keys_on_the_manifest_id_not_the_directory() {
        let temp = tempfile::tempdir().unwrap();
        let tools = temp.path().join("tools");
        let data = temp.path().join("data");
        // Directory `folder-name`, manifest id `local.alpha`: a toggle must
        // follow the id the page shows, not the folder.
        package(
            &tools,
            "folder-name",
            r#"{"schemaVersion":1,"id":"local.alpha","name":"Alpha"}"#,
        );
        set_enabled(&data, "local.alpha", false).unwrap();
        assert!(!list(Some(&tools), &data).unwrap()[0].enabled);
    }

    #[test]
    fn a_build_without_packages_lists_nothing() {
        let temp = tempfile::tempdir().unwrap();
        assert!(list(None, temp.path()).unwrap().is_empty());
    }

    #[test]
    fn duplicate_ids_are_flagged_rather_than_rendered_twice() {
        let temp = tempfile::tempdir().unwrap();
        let tools = temp.path().join("tools");
        package(
            &tools,
            "a",
            r#"{"schemaVersion":1,"id":"local.same","name":"Same"}"#,
        );
        package(
            &tools,
            "b",
            r#"{"schemaVersion":1,"id":"local.same","name":"Same"}"#,
        );
        let packages = list(Some(&tools), temp.path()).unwrap();
        assert_eq!(packages.len(), 2);
        assert!(packages[0].error.is_none());
        assert!(packages[1]
            .error
            .as_deref()
            .unwrap_or("")
            .contains("duplicate"));
    }
}
