use std::path::{Path, PathBuf};

use super::{shell, ToolRunnerStartConfig};
use crate::{sessions, state::AppState};

const PLUGIN_ID: &str = "pie.office-runtime";

pub(crate) fn for_session(state: &AppState, session_id: &str) -> anyhow::Result<Option<PathBuf>> {
    let Some(plugin) = state.plugins.get(PLUGIN_ID) else {
        return Ok(None);
    };
    if !plugin.enabled || !plugin.bundled || plugin.source != "builtin" {
        return Ok(None);
    }
    let session = sessions::session_summary(&state.db, session_id)?
        .ok_or_else(|| anyhow::anyhow!("session not found"))?;
    if !plugin.scope.matches(session.project_path.as_deref()) {
        return Ok(None);
    }
    let resources = plugin
        .path
        .as_deref()
        .map(Path::new)
        .filter(|path| path.is_absolute())
        .and_then(|path| path.parent()?.parent())
        .ok_or_else(|| anyhow::anyhow!("bundled Office Runtime has no resources directory"))?;
    Ok(Some(resources.join("office-runtime")))
}

pub(super) fn configure(
    config: &mut ToolRunnerStartConfig,
    runtime: &Path,
) -> Result<(), (String, String)> {
    let failed = |detail: &str| {
        (
            "TOOL_FAILED".into(),
            format!("Office Runtime is incomplete at {}: {detail}. Reinstall Pie Code or turn off Office Runtime in Extensions.", runtime.display()),
        )
    };
    for name in ["node/bin/node", "python/bin/python", "python/bin/python3"] {
        if !shell::is_executable(&runtime.join(name)) {
            return Err(failed(name));
        }
    }
    for name in [
        "node/lib/node_modules/docx/package.json",
        "python/lib/python3.12/site-packages/defusedxml/__init__.py",
        "python/lib/python3.12/site-packages/lxml/__init__.py",
    ] {
        if !runtime.join(name).is_file() {
            return Err(failed(name));
        }
    }
    let runtime = runtime
        .to_str()
        .ok_or_else(|| failed("invalid directory path"))?;
    if runtime.contains(':') {
        return Err(failed("directory path contains a PATH separator"));
    }
    config
        .extra_env
        .push(("PI_OFFICE_RUNTIME_ROOT".into(), runtime.into()));

    // A login profile may replace PATH. Apply the overlay after startup, in
    // this Bash invocation only. Pass the installed location as data.
    let [flag, command] = config.args.as_mut_slice() else {
        return Err(failed("unsupported Bash invocation"));
    };
    if flag != "-lc" {
        return Err(failed("unsupported Bash invocation"));
    }
    command.insert_str(0, concat!(
        "export PATH=\"$PI_OFFICE_RUNTIME_ROOT/node/bin:$PI_OFFICE_RUNTIME_ROOT/python/bin${PATH:+:$PATH}\"\n",
        "export NODE_PATH=\"$PI_OFFICE_RUNTIME_ROOT/node/lib/node_modules${NODE_PATH:+:$NODE_PATH}\"\n",
        "unset PI_OFFICE_RUNTIME_ROOT\n",
    ));
    Ok(())
}
