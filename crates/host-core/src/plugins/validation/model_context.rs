use anyhow::{bail, Result};
use serde_json::{Map, Value};

use super::{require_permission, PluginManifest};

/// A model-context contribution is a grant, not a manifest-only capability:
/// declaring it without `agent.modelContext` would silently contribute nothing.
pub(super) fn validate(map: &Map<String, Value>, manifest: &PluginManifest) -> Result<()> {
    let Some(model_context) = map.get("modelContext") else {
        return Ok(());
    };
    if model_context.as_bool() != Some(true) {
        bail!("PLUGIN_INVALID: contributes.modelContext must be true");
    }
    require_permission(manifest, "agent.modelContext", "model context")
}
