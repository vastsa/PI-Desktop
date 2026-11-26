use std::{fs, io, path::{Path, PathBuf}};

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

pub(crate) struct RenderProfiles(PathBuf);

impl RenderProfiles {
    #[cfg(unix)]
    fn create() -> io::Result<Self> {
        use std::os::unix::fs::DirBuilderExt;

        let path = Path::new("/tmp").join(format!("pie-office-{}", uuid::Uuid::new_v4()));
        fs::DirBuilder::new().mode(0o700).create(&path)?;
        Ok(Self(path))
    }

    #[cfg(not(unix))]
    fn create() -> io::Result<Self> {
        Err(io::Error::new(io::ErrorKind::Unsupported, "Office rendering requires Unix"))
    }
}

impl Drop for RenderProfiles {
    fn drop(&mut self) {
        if let Err(error) = fs::remove_dir_all(&self.0) {
            if error.kind() != io::ErrorKind::NotFound {
                tracing::warn!(%error, "could not clean up Office rendering profiles");
            }
        }
    }
}

pub(super) fn configure(
    config: &mut ToolRunnerStartConfig,
    runtime: &Path,
) -> Result<RenderProfiles, (String, String)> {
    let failed = |detail: &str| {
        (
            "TOOL_FAILED".into(),
            format!("Office Runtime is incomplete at {}: {detail}. Reinstall Pie Code or turn off Office Runtime in Extensions.", runtime.display()),
        )
    };
    for name in [
        "node/bin/node",
        "python/bin/python",
        "python/bin/python3",
        "bin/soffice",
        "bin/pdftoppm",
        "libreoffice/program/oosplash",
        "poppler/bin/pdftoppm",
    ] {
        if !shell::is_executable(&runtime.join(name)) {
            return Err(failed(name));
        }
    }
    for name in [
        "node/lib/node_modules/docx/package.json",
        "node/lib/node_modules/pptxgenjs/package.json",
        "python/lib/python3.12/site-packages/PIL/__init__.py",
        "python/lib/python3.12/site-packages/defusedxml/__init__.py",
        "python/lib/python3.12/site-packages/lxml/__init__.py",
        "python/lib/python3.12/site-packages/markitdown/__init__.py",
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
    let profiles = RenderProfiles::create().map_err(|error| {
        ("TOOL_FAILED".into(), format!("Could not create a temporary Office rendering directory: {error}"))
    })?;
    config.extra_env.push((
        "PI_OFFICE_RUNTIME_PROFILES".into(),
        profiles.0.to_string_lossy().into_owned(),
    ));
    command.insert_str(0, concat!(
        "export PATH=\"$PI_OFFICE_RUNTIME_ROOT/node/bin:$PI_OFFICE_RUNTIME_ROOT/python/bin:$PI_OFFICE_RUNTIME_ROOT/bin${PATH:+:$PATH}\"\n",
        "export NODE_PATH=\"$PI_OFFICE_RUNTIME_ROOT/node/lib/node_modules${NODE_PATH:+:$NODE_PATH}\"\n",
        // Importing scripts from the user's Skill must not write beside them.
        "export PYTHONDONTWRITEBYTECODE=1\n",
        "unset PI_OFFICE_RUNTIME_ROOT\n",
    ));
    Ok(profiles)
}
