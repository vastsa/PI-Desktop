//! Platform shell catalog, resolution, and invocation construction.
//!
//! The catalog is intentionally uncached. Shell installations and operator
//! overrides can change while the host is running, and execution must resolve
//! the configured shell again immediately before a Bash call starts.

use std::env;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[cfg(windows)]
use std::ffi::OsStr;
#[cfg(unix)]
use std::process::Stdio;
#[cfg(unix)]
use std::sync::OnceLock;
#[cfg(unix)]
use std::time::Duration;

pub const WINDOWS_POWERSHELL_ID: &str = "windows-powershell";
pub const CMD_ID: &str = "cmd";
pub const GIT_BASH_ID: &str = "git-bash";
pub const BASH_ID: &str = "bash";

pub const SHELL_MISSING_GUIDANCE: &str =
    "No usable command shell was found. Install or enable a supported shell and try again.";

/// Windows CreateProcess accepts at most 32,767 UTF-16 code units in its
/// command line. Keep the builder below that limit, including executable and
/// argument overhead, instead of relying on platform-specific truncation.
pub const MAX_WINDOWS_COMMAND_LINE_UNITS: usize = 32_767;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellPlatform {
    Windows,
    Unix,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShellOption {
    pub id: String,
    pub label: String,
    pub dialect: String,
    pub available: bool,
    pub is_default: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShellCatalog {
    pub configured_id: String,
    pub effective: Option<ShellOption>,
    pub fallback: bool,
    pub choices: Vec<ShellOption>,
}

#[derive(Debug, Clone)]
pub struct ResolvedShell {
    pub program: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellInvocation {
    pub program: PathBuf,
    pub args: Vec<String>,
}

pub fn current_platform() -> ShellPlatform {
    if cfg!(windows) {
        ShellPlatform::Windows
    } else {
        ShellPlatform::Unix
    }
}

pub fn default_shell_id() -> &'static str {
    match current_platform() {
        ShellPlatform::Windows => WINDOWS_POWERSHELL_ID,
        ShellPlatform::Unix => BASH_ID,
    }
}

pub fn is_known_shell_id(id: &str) -> bool {
    matches!(id, WINDOWS_POWERSHELL_ID | CMD_ID | GIT_BASH_ID | BASH_ID)
}

pub fn dialect_for_id(id: &str) -> Option<&'static str> {
    match id {
        WINDOWS_POWERSHELL_ID => Some("powershell"),
        CMD_ID => Some("cmd"),
        GIT_BASH_ID | BASH_ID => Some("posix"),
        _ => None,
    }
}

/// Build a public catalog using a caller-supplied availability probe. This
/// pure seam keeps catalog/default/fallback tests independent of the host OS.
pub fn catalog_for_platform(
    platform: ShellPlatform,
    configured_id: Option<&str>,
    mut available: impl FnMut(&str) -> bool,
) -> ShellCatalog {
    let configured_id = configured_id
        .filter(|id| is_known_shell_id(id))
        .unwrap_or_else(|| default_for_platform(platform))
        .to_string();

    let mut choices = choices_for_platform(platform);
    for choice in &mut choices {
        choice.available = available(&choice.id);
    }

    let effective = choices
        .iter()
        .find(|choice| choice.id == configured_id && choice.available)
        .or_else(|| choices.iter().find(|choice| choice.available))
        .cloned();
    let fallback = effective
        .as_ref()
        .is_some_and(|choice| choice.id != configured_id);

    ShellCatalog {
        configured_id,
        effective,
        fallback,
        choices,
    }
}

/// Resolve the current platform's catalog. Every call probes the environment
/// again; no executable path or invocation argument is part of the catalog.
pub fn catalog(configured_id: Option<&str>) -> ShellCatalog {
    let platform = current_platform();
    catalog_for_platform(platform, configured_id, |id| {
        resolve_shell_for_platform(platform, id).is_ok()
    })
}

pub fn resolve_shell(id: &str) -> Result<ResolvedShell, String> {
    resolve_shell_for_platform(current_platform(), id)
}

pub fn resolve_shell_for_platform(
    platform: ShellPlatform,
    id: &str,
) -> Result<ResolvedShell, String> {
    dialect_for_id(id).ok_or_else(|| format!("unknown command shell id '{id}'"))?;

    match platform {
        ShellPlatform::Windows => match id {
            WINDOWS_POWERSHELL_ID => {
                find_windows_powershell().map(|program| ResolvedShell { program })
            }
            CMD_ID => find_cmd().map(|program| ResolvedShell { program }),
            GIT_BASH_ID => find_bash().map(|program| ResolvedShell { program }),
            _ => Err(format!("command shell '{id}' is not available on Windows")),
        },
        ShellPlatform::Unix => match id {
            BASH_ID => find_bash().map(|program| ResolvedShell { program }),
            _ => Err(format!(
                "command shell '{id}' is not available on this platform"
            )),
        },
    }
}

/// Pure invocation builder used by runtime code and cross-platform tests.
pub fn build_invocation_for_platform(
    platform: ShellPlatform,
    shell_id: &str,
    program: PathBuf,
    command: &str,
) -> Result<ShellInvocation, String> {
    if command.contains('\0') {
        return Err("command contains an embedded NUL".into());
    }

    let args = match platform {
        ShellPlatform::Windows => match shell_id {
            WINDOWS_POWERSHELL_ID => {
                let script = format!(
                    "$OutputEncoding = New-Object System.Text.UTF8Encoding($false); [Console]::OutputEncoding = $OutputEncoding; $ErrorActionPreference = 'Continue'; $ProgressPreference = 'SilentlyContinue'; $global:LASTEXITCODE = 0; $script:piPowerShellError = $false; & {{ {command} }} 2>&1 | ForEach-Object {{ if ($_ -is [System.Management.Automation.ErrorRecord]) {{ $script:piPowerShellError = $true; [Console]::Error.WriteLine($_.Exception.Message) }} else {{ [Console]::Out.WriteLine([string]$_) }} }}; $piNativeExitCode = $LASTEXITCODE; if ($script:piPowerShellError) {{ exit 1 }}; exit $piNativeExitCode"
                );
                vec![
                    "-NoLogo".into(),
                    "-NoProfile".into(),
                    "-NonInteractive".into(),
                    "-InputFormat".into(),
                    "Text".into(),
                    "-OutputFormat".into(),
                    "Text".into(),
                    "-Command".into(),
                    script,
                ]
            }
            CMD_ID => vec![
                "/D".into(),
                "/Q".into(),
                "/V:OFF".into(),
                "/S".into(),
                "/C".into(),
                format!("chcp 65001>nul && {command}"),
            ],
            GIT_BASH_ID => vec![
                "--noprofile".into(),
                "--norc".into(),
                "-c".into(),
                command.to_string(),
            ],
            _ => {
                return Err(format!(
                    "command shell '{shell_id}' is not available on Windows"
                ))
            }
        },
        ShellPlatform::Unix => match shell_id {
            BASH_ID => vec!["-lc".into(), command.to_string()],
            _ => {
                return Err(format!(
                    "command shell '{shell_id}' is not available on this platform"
                ))
            }
        },
    };

    if platform == ShellPlatform::Windows {
        let units = program.to_string_lossy().encode_utf16().count()
            + args
                .iter()
                .map(|arg| arg.encode_utf16().count())
                .sum::<usize>()
            + args.len();
        if units > MAX_WINDOWS_COMMAND_LINE_UNITS {
            return Err(format!(
                "command line is too long for Windows ({units} UTF-16 code units; maximum is {MAX_WINDOWS_COMMAND_LINE_UNITS})"
            ));
        }
    }

    Ok(ShellInvocation { program, args })
}

fn default_for_platform(platform: ShellPlatform) -> &'static str {
    match platform {
        ShellPlatform::Windows => WINDOWS_POWERSHELL_ID,
        ShellPlatform::Unix => BASH_ID,
    }
}

fn choices_for_platform(platform: ShellPlatform) -> Vec<ShellOption> {
    match platform {
        ShellPlatform::Windows => vec![
            ShellOption {
                id: WINDOWS_POWERSHELL_ID.into(),
                label: "Windows PowerShell".into(),
                dialect: "powershell".into(),
                available: false,
                is_default: true,
            },
            ShellOption {
                id: CMD_ID.into(),
                label: "Command Prompt".into(),
                dialect: "cmd".into(),
                available: false,
                is_default: false,
            },
            ShellOption {
                id: GIT_BASH_ID.into(),
                label: "Git Bash".into(),
                dialect: "posix".into(),
                available: false,
                is_default: false,
            },
        ],
        ShellPlatform::Unix => vec![ShellOption {
            id: BASH_ID.into(),
            label: "Bash".into(),
            dialect: "posix".into(),
            available: false,
            is_default: true,
        }],
    }
}

fn find_bash() -> Result<PathBuf, String> {
    if let Some(overridden) = env::var_os("PI_DESKTOP_BASH") {
        let path = PathBuf::from(&overridden);
        if is_executable(&path) {
            return Ok(path);
        }
        return Err(format!(
            "PI_DESKTOP_BASH points to '{}', which is not an executable file",
            path.display()
        ));
    }
    platform_bash().ok_or_else(|| SHELL_MISSING_GUIDANCE.to_string())
}

#[cfg(unix)]
fn platform_bash() -> Option<PathBuf> {
    const CANDIDATES: &[&str] = &[
        "/bin/bash",
        "/usr/bin/bash",
        "/usr/local/bin/bash",
        "/opt/homebrew/bin/bash",
    ];
    CANDIDATES
        .iter()
        .map(PathBuf::from)
        .find(|path| is_executable(path))
        .or_else(|| search_path("bash", |_| true))
}

#[cfg(not(unix))]
fn platform_bash() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        // Prefer Git for Windows relative to the git.exe on PATH.
        if let Some(git) = search_path("git.exe", |_| true) {
            if let Some(root) = git.parent().and_then(Path::parent) {
                for rel in ["bin\\bash.exe", "usr\\bin\\bash.exe"] {
                    let candidate = root.join(rel);
                    if is_executable(&candidate) {
                        return Some(candidate);
                    }
                }
            }
        }

        for base in ["ProgramFiles", "ProgramFiles(x86)", "LocalAppData"] {
            if let Some(dir) = env::var_os(base) {
                let mut root = PathBuf::from(dir);
                if base == "LocalAppData" {
                    root.push("Programs");
                }
                let candidate = root.join("Git").join("bin").join("bash.exe");
                if is_executable(&candidate) {
                    return Some(candidate);
                }
            }
        }

        // Exclude the WSL launcher, which is not a Win32 bash executable.
        search_path("bash.exe", |path| {
            !path
                .components()
                .any(|component| component.as_os_str().eq_ignore_ascii_case("System32"))
        })
    }
    #[cfg(not(windows))]
    {
        None
    }
}

#[cfg(windows)]
fn find_windows_powershell() -> Result<PathBuf, String> {
    let system_root = env::var_os("SystemRoot").map(PathBuf::from);
    let well_known = system_root
        .as_ref()
        .map(|root| root.join("System32\\WindowsPowerShell\\v1.0\\powershell.exe"));
    well_known
        .filter(|path| is_executable(path))
        .or_else(|| search_path("powershell.exe", |_| true))
        .ok_or_else(|| "Windows PowerShell (powershell.exe) was not found".into())
}

#[cfg(not(windows))]
fn find_windows_powershell() -> Result<PathBuf, String> {
    Err("Windows PowerShell is not available on this platform".into())
}

#[cfg(windows)]
fn find_cmd() -> Result<PathBuf, String> {
    env::var_os("ComSpec")
        .map(PathBuf::from)
        .filter(|path| is_executable(path))
        .or_else(|| {
            env::var_os("SystemRoot")
                .map(PathBuf::from)
                .map(|root| root.join("System32\\cmd.exe"))
                .filter(|path| is_executable(path))
        })
        .or_else(|| search_path("cmd.exe", |_| true))
        .ok_or_else(|| "Command Prompt (cmd.exe) was not found".into())
}

#[cfg(not(windows))]
fn find_cmd() -> Result<PathBuf, String> {
    Err("Command Prompt is not available on this platform".into())
}

/// Best-effort PATH exported by the user's own login shell, so the Bash tool
/// resolves the same toolchain a fresh terminal would (nvm, Homebrew, conda,
/// ...). The app may be launched from Finder/Dock with a minimal GUI
/// environment, and `bash -lc` alone only sources the *bash* profile — on
/// macOS the default shell is zsh, whose `.zshrc`/`.zprofile` (where nvm and
/// friends usually live) bash never reads. Probed once per process and cached;
/// returns `None` when no login shell can be probed, so callers fall back to
/// the host environment unchanged.
/// Windows keeps `bash -c` with the host environment (D084 unchanged):
/// no login-shell probe, so the Bash tool behaves exactly as before.
#[cfg(windows)]
pub fn user_login_path() -> Option<&'static str> {
    None
}

#[cfg(unix)]
pub fn user_login_path() -> Option<&'static str> {
    static CACHE: OnceLock<Option<String>> = OnceLock::new();
    CACHE.get_or_init(probe_user_login_path).as_deref()
}

#[cfg(unix)]
fn probe_user_login_path() -> Option<String> {
    let shell = env::var_os("SHELL")
        .map(PathBuf::from)
        .filter(|p| is_executable(p))
        .or_else(|| {
            ["/bin/zsh", "/bin/bash", "/bin/sh"]
                .iter()
                .map(PathBuf::from)
                .find(|p| is_executable(p))
        })?;
    // `-l` sources login files (.zprofile / .bash_profile), `-i` sources the
    // interactive rc (.zshrc / .bashrc): together they reproduce a terminal's
    // PATH. stderr is discarded — shells complain about the missing tty/job
    // control — and only the last stdout line is taken, so rc banners cannot
    // contaminate the result.
    let (tx, rx) = std::sync::mpsc::channel();
    let _probe = std::thread::Builder::new()
        .name("pi-host-login-path".into())
        .spawn(move || {
            let output = std::process::Command::new(&shell)
                .args(["-lic", "printf %s \"$PATH\""])
                .stderr(Stdio::null())
                .output();
            let _ = tx.send(output);
        })
        .ok()?;
    // A wedged rc (waiting on input/network) must not stall the first Bash
    // call; probing is best-effort and the host PATH remains the fallback.
    let output = rx.recv_timeout(Duration::from_secs(5)).ok()?.ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8(output.stdout).ok()?;
    let path = stdout.lines().next_back().unwrap_or_default().trim();
    (!path.is_empty()).then(|| path.to_string())
}

/// Locate a user-installed program the way a login shell would: process PATH
/// first, then the Unix login PATH probe. Windows stays on the host PATH.
/// Used by Grep to prefer a system `rg` without assuming it exists.
pub fn find_user_program(name: &str) -> Option<PathBuf> {
    for candidate in program_names(name) {
        if let Some(path) = search_path(&candidate, |_| true) {
            return Some(path);
        }
    }
    #[cfg(unix)]
    if let Some(login) = user_login_path() {
        for candidate in program_names(name) {
            if let Some(path) = search_in_path_value(&candidate, login) {
                return Some(path);
            }
        }
    }
    None
}

fn program_names(name: &str) -> Vec<String> {
    #[cfg(windows)]
    {
        if Path::new(name)
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case(OsStr::new("exe")))
        {
            vec![name.to_string()]
        } else {
            vec![format!("{name}.exe"), name.to_string()]
        }
    }
    #[cfg(not(windows))]
    {
        vec![name.to_string()]
    }
}

#[cfg(unix)]
fn search_in_path_value(name: &str, path_var: &str) -> Option<PathBuf> {
    env::split_paths(path_var)
        .filter(|dir| !dir.as_os_str().is_empty())
        .map(|dir| dir.join(name))
        .find(|path| is_executable(path))
}

fn search_path(name: &str, accept: impl Fn(&Path) -> bool) -> Option<PathBuf> {
    let path_var = env::var_os("PATH")?;
    env::split_paths(&path_var)
        .filter(|dir| !dir.as_os_str().is_empty())
        .map(|dir| dir.join(name))
        .find(|path| is_executable(path) && accept(path))
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;

    path.is_file()
        && std::fs::metadata(path)
            .map(|metadata| metadata.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
}

#[cfg(windows)]
fn is_executable(path: &Path) -> bool {
    path.is_file()
        && path
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case(OsStr::new("exe")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_defaults_and_fallback_are_platform_specific() {
        let unix = catalog_for_platform(ShellPlatform::Unix, None, |_| true);
        assert_eq!(unix.configured_id, BASH_ID);
        assert_eq!(
            unix.effective.as_ref().map(|option| option.id.as_str()),
            Some(BASH_ID)
        );
        assert!(!unix.fallback);
        assert_eq!(unix.choices.len(), 1);

        let windows = catalog_for_platform(ShellPlatform::Windows, None, |_| true);
        assert_eq!(windows.configured_id, WINDOWS_POWERSHELL_ID);
        assert_eq!(windows.choices.len(), 3);
        assert_eq!(windows.choices[0].label, "Windows PowerShell");
        assert!(windows.choices[0].is_default);

        let fallback =
            catalog_for_platform(ShellPlatform::Windows, Some(WINDOWS_POWERSHELL_ID), |id| {
                id != WINDOWS_POWERSHELL_ID
            });
        assert_eq!(
            fallback.effective.as_ref().map(|option| option.id.as_str()),
            Some(CMD_ID)
        );
        assert!(fallback.fallback);
    }

    #[test]
    fn unknown_configured_id_normalizes_to_platform_default() {
        let catalog =
            catalog_for_platform(ShellPlatform::Unix, Some("C:\\custom\\shell.exe"), |_| true);
        assert_eq!(catalog.configured_id, BASH_ID);
        assert_eq!(
            catalog.effective.as_ref().map(|option| option.id.as_str()),
            Some(BASH_ID)
        );
    }

    #[test]
    fn user_login_path_probes_a_real_path() {
        // On any machine with a login shell the probe yields a non-empty
        // PATH of absolute directories; when no shell can be probed the
        // function must degrade to None rather than panic.
        if let Some(path) = user_login_path() {
            assert!(!path.is_empty(), "probed PATH is non-empty");
            assert!(path.starts_with('/'), "PATH entries stay absolute");
            assert!(path.contains('/'), "PATH looks like directories");
        }
    }

    #[cfg(unix)]
    #[test]
    fn non_executable_file_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let plain = dir.path().join("not-a-shell");
        std::fs::write(&plain, "text").unwrap();
        assert!(!is_executable(&plain));
    }

    #[test]
    fn invocation_builder_uses_each_dialect_contract() {
        let powershell = build_invocation_for_platform(
            ShellPlatform::Windows,
            WINDOWS_POWERSHELL_ID,
            PathBuf::from("powershell.exe"),
            "Write-Output 'hello'",
        )
        .unwrap();
        assert_eq!(
            powershell.args[..7],
            [
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-InputFormat",
                "Text",
                "-OutputFormat",
                "Text"
            ]
        );
        assert_eq!(powershell.args[7], "-Command");
        let script = &powershell.args[8];
        assert!(script.contains("UTF8Encoding"));
        assert!(script.contains("$LASTEXITCODE"));
        assert!(script.contains("Write-Output 'hello'"));

        let cmd = build_invocation_for_platform(
            ShellPlatform::Windows,
            CMD_ID,
            PathBuf::from("cmd.exe"),
            "echo hello",
        )
        .unwrap();
        assert_eq!(
            cmd.args,
            [
                "/D",
                "/Q",
                "/V:OFF",
                "/S",
                "/C",
                "chcp 65001>nul && echo hello"
            ]
        );

        let git_bash = build_invocation_for_platform(
            ShellPlatform::Windows,
            GIT_BASH_ID,
            PathBuf::from("bash.exe"),
            "printf hello",
        )
        .unwrap();
        assert_eq!(
            git_bash.args,
            ["--noprofile", "--norc", "-c", "printf hello"]
        );

        let bash = build_invocation_for_platform(
            ShellPlatform::Unix,
            BASH_ID,
            PathBuf::from("/bin/bash"),
            "printf hello",
        )
        .unwrap();
        assert_eq!(bash.args, ["-lc", "printf hello"]);
    }

    #[test]
    fn invocation_builder_rejects_nul_and_long_windows_commands() {
        let nul = build_invocation_for_platform(
            ShellPlatform::Windows,
            CMD_ID,
            PathBuf::from("cmd.exe"),
            "echo\0bad",
        );
        assert!(nul.is_err());

        let long_command = "x".repeat(MAX_WINDOWS_COMMAND_LINE_UNITS);
        let too_long = build_invocation_for_platform(
            ShellPlatform::Windows,
            CMD_ID,
            PathBuf::from("cmd.exe"),
            &long_command,
        );
        assert!(too_long.is_err());
    }
}
