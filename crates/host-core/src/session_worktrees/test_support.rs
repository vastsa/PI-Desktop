//! Real temporary git repositories for worktree tests. Identity is set in the
//! repository config so tests never depend on the developer's global config.

use std::path::{Path, PathBuf};

pub fn git_cmd(dir: &Path, args: &[&str]) -> String {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C")
        .output()
        .expect("git runs");
    assert!(
        output.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).into_owned()
}

/// A repository on `main` with one commit.
pub fn init_repo(path: &Path) -> PathBuf {
    std::fs::create_dir_all(path).unwrap();
    git_cmd(path, &["init", "-q", "-b", "main"]);
    git_cmd(path, &["config", "user.name", "PI Test"]);
    git_cmd(path, &["config", "user.email", "pi-test@example.invalid"]);
    git_cmd(path, &["config", "commit.gpgsign", "false"]);
    std::fs::write(path.join("README.md"), "init\n").unwrap();
    git_cmd(path, &["add", "README.md"]);
    git_cmd(path, &["commit", "-q", "-m", "init"]);
    path.to_path_buf()
}

/// A directory link: a symbolic link on Unix, a junction on Windows. Junctions
/// need no privilege, and they are the link Git for Windows follows during
/// `git worktree remove --force`.
pub fn link_dir(target: &Path, link: &Path) {
    #[cfg(unix)]
    std::os::unix::fs::symlink(target, link).unwrap();
    #[cfg(windows)]
    {
        // `mklink` reads a `/` inside a path as a switch.
        let native = |path: &Path| path.to_string_lossy().replace('/', "\\");
        let output = std::process::Command::new("cmd.exe")
            .args(["/d", "/c", "mklink", "/J"])
            .arg(native(link))
            .arg(native(target))
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "junction creation failed: {output:?}"
        );
    }
}

/// A file symbolic link. Windows allows it only with Developer Mode or
/// elevation; without that privilege this returns false so the caller skips
/// just its file-link assertions.
pub fn try_link_file(target: &Path, link: &Path) -> bool {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(target, link).unwrap();
        true
    }
    #[cfg(windows)]
    {
        const ERROR_PRIVILEGE_NOT_HELD: i32 = 1314;
        match std::os::windows::fs::symlink_file(target, link) {
            Ok(()) => true,
            Err(error) if error.raw_os_error() == Some(ERROR_PRIVILEGE_NOT_HELD) => {
                eprintln!("file symlinks need Developer Mode; skipping that case");
                false
            }
            Err(error) => panic!("file symlink failed: {error}"),
        }
    }
}
