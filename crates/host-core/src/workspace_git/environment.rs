//! The environment a tool gets when it runs inside a registered worktree.
//!
//! `workspace/toolExecute` is unchanged on the wire. host-core looks the tool
//! root up in the worktree registry and, for a registered worktree only, adds
//! the worktree's variables, its roots, and the git proxy rewrite. Any other
//! root gets exactly what it got before: nothing.

use std::path::Path;

use serde_json::Value;

use super::layout::{validate_variable_name, Layout, Repository};
use super::{registry, WorkspaceGitError};
use crate::db::Database;

/// The one git configuration pair that sends a repository's traffic through
/// the credential proxy: `url.<proxy><owner>/<repo>.git.insteadOf` set to the
/// repository's GitHub URL. It is scoped to that repository, so every other
/// URL behaves as if there were no proxy.
pub fn proxy_rewrite(proxy_url: &str, repository: &Repository) -> (String, String) {
    (
        format!(
            "url.{proxy_url}{}/{}.git.insteadOf",
            repository.owner, repository.name
        ),
        Layout::github_url(repository),
    )
}

/// The git configuration for traffic to GitHub from this host, as key and
/// value pairs for `GIT_CONFIG_COUNT`. host-run git and the Agent's Bash get
/// the same pairs:
///
/// - the proxy rewrite for the session's repository;
/// - an empty `credential.helper` and `core.askPass`, so git neither asks the
///   host user's own helpers for a credential nor offers them one to store.
///   The only credential in play is the one the proxy adds;
/// - an empty proxy for the credential proxy's own address, so loopback
///   traffic to it is never handed to a configured HTTP proxy.
///
/// Without a proxy address only the two credential pairs apply.
pub fn network_config(proxy_url: Option<&str>, repository: &Repository) -> Vec<(String, String)> {
    let mut config = Vec::with_capacity(4);
    if let Some(proxy_url) = proxy_url {
        config.push(proxy_rewrite(proxy_url, repository));
    }
    config.push(("credential.helper".to_string(), String::new()));
    config.push(("core.askPass".to_string(), String::new()));
    if let Some(proxy_url) = proxy_url {
        config.push((format!("http.{proxy_url}.proxy"), String::new()));
    }
    config
}

/// Read an optional `gitProxyUrl` / `gitProxy.url` value. Only the shape
/// `pi-host` produces is accepted, `http://127.0.0.1:<port>/<64 hex>/`, so the
/// rewrite can never point git at another machine.
pub fn parse_proxy_url(value: Option<&Value>) -> Result<Option<String>, WorkspaceGitError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let invalid = || WorkspaceGitError::invalid("git proxy URL is not a loopback proxy URL");
    let url = value.as_str().ok_or_else(invalid)?;
    let rest = url.strip_prefix("http://127.0.0.1:").ok_or_else(invalid)?;
    let (port, handle) = rest
        .strip_suffix('/')
        .and_then(|rest| rest.split_once('/'))
        .ok_or_else(invalid)?;
    let port_ok = (1..=5).contains(&port.len())
        && port.bytes().all(|byte| byte.is_ascii_digit())
        && port.parse::<u16>().is_ok_and(|port| port != 0);
    let handle_ok = handle.len() == 64
        && handle
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
    if port_ok && handle_ok {
        Ok(Some(url.to_string()))
    } else {
        Err(invalid())
    }
}

/// Environment for a tool rooted at `root`.
///
/// Inside a registered worktree, in order: the record's variables,
/// `PI_WORKTREE_ROOT`, `PI_PROJECT_ROOT` (the main checkout), and, only when a
/// proxy URL is given, `GIT_TERMINAL_PROMPT=0` and `network_config` as
/// environment-carried git configuration. For any other root the result is
/// empty, whatever `git_proxy_url` says.
pub fn for_tool(db: &Database, root: &Path, git_proxy_url: Option<&str>) -> Vec<(String, String)> {
    let record = match registry::find_by_path(db, root) {
        Ok(Some(record)) => record,
        Ok(None) => return Vec::new(),
        Err(error) => {
            tracing::warn!(%error, "could not read the workspace git registry");
            return Vec::new();
        }
    };
    let mut env: Vec<(String, String)> = record
        .variables
        .iter()
        // A name that is refused today may have been stored by an older build.
        .filter(|variable| validate_variable_name(&variable.name).is_ok())
        .map(|variable| (variable.name.clone(), variable.value.clone()))
        .collect();
    env.push(("PI_WORKTREE_ROOT".to_string(), record.path.clone()));
    env.push(("PI_PROJECT_ROOT".to_string(), record.main_path.clone()));
    if let (Some(proxy_url), Ok(repository)) = (git_proxy_url, record.repository.validated()) {
        let config = network_config(Some(proxy_url), &repository);
        env.push(("GIT_TERMINAL_PROMPT".to_string(), "0".to_string()));
        env.push(("GIT_CONFIG_COUNT".to_string(), config.len().to_string()));
        for (index, (key, value)) in config.into_iter().enumerate() {
            env.push((format!("GIT_CONFIG_KEY_{index}"), key));
            env.push((format!("GIT_CONFIG_VALUE_{index}"), value));
        }
    }
    env
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace_git::layout::Repository;
    use crate::workspace_git::registry::{self, SetupStatus, Variable, WorktreeRecord};

    const INSTALLATION: &str = "00000000-0000-4000-8000-000000000000";

    fn proxy() -> String {
        format!("http://127.0.0.1:4321/{}/", "ab".repeat(32))
    }

    fn database() -> (tempfile::TempDir, Database) {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
        (dir, db)
    }

    fn register(db: &Database, path: &str, variables: &[(&str, &str)]) {
        registry::insert(
            db,
            &WorktreeRecord {
                installation_id: INSTALLATION.into(),
                session_id: "s-1".into(),
                repository: Repository::parse("octo", "repo.js").unwrap(),
                base_branch: "main".into(),
                work_branch: "pi-desktop/8b54618f6bc1".into(),
                path: path.into(),
                main_path: "/w/repos/github.com/octo/repo.js".into(),
                base_commit: "a".repeat(40),
                created_at: "2026-11-20T00:00:00.000Z".into(),
                variables: variables
                    .iter()
                    .map(|(name, value)| Variable {
                        name: name.to_string(),
                        value: value.to_string(),
                    })
                    .collect(),
                setup_script: None,
                setup_status: SetupStatus::None,
                setup_log_tail: None,
            },
        )
        .unwrap();
    }

    fn pairs(env: &[(String, String)]) -> Vec<(&str, &str)> {
        env.iter()
            .map(|(name, value)| (name.as_str(), value.as_str()))
            .collect()
    }

    #[test]
    fn a_registered_worktree_gets_its_variables_and_roots_in_order() {
        let (_dir, db) = database();
        let root = "/w/worktrees/github.com/octo/repo.js/8b54618f6bc1";
        register(&db, root, &[("MY_VAR", "one"), ("OTHER", "two words")]);
        let expected = [
            ("MY_VAR", "one"),
            ("OTHER", "two words"),
            ("PI_WORKTREE_ROOT", root),
            ("PI_PROJECT_ROOT", "/w/repos/github.com/octo/repo.js"),
        ];
        assert_eq!(pairs(&for_tool(&db, Path::new(root), None)), expected);
        // A directory inside the worktree is still that worktree.
        let nested = Path::new(root).join("packages/app");
        assert_eq!(pairs(&for_tool(&db, &nested, None)), expected);
    }

    #[test]
    fn the_git_proxy_rewrite_is_added_only_when_a_proxy_is_given() {
        let (_dir, db) = database();
        let root = "/w/worktrees/github.com/octo/repo.js/8b54618f6bc1";
        register(&db, root, &[("MY_VAR", "one")]);
        let proxy = proxy();
        let env = for_tool(&db, Path::new(root), Some(&proxy));
        let key = format!("url.{proxy}octo/repo.js.git.insteadOf");
        let no_proxy = format!("http.{proxy}.proxy");
        assert_eq!(
            pairs(&env),
            [
                ("MY_VAR", "one"),
                ("PI_WORKTREE_ROOT", root),
                ("PI_PROJECT_ROOT", "/w/repos/github.com/octo/repo.js"),
                ("GIT_TERMINAL_PROMPT", "0"),
                ("GIT_CONFIG_COUNT", "4"),
                ("GIT_CONFIG_KEY_0", key.as_str()),
                ("GIT_CONFIG_VALUE_0", "https://github.com/octo/repo.js.git"),
                ("GIT_CONFIG_KEY_1", "credential.helper"),
                ("GIT_CONFIG_VALUE_1", ""),
                ("GIT_CONFIG_KEY_2", "core.askPass"),
                ("GIT_CONFIG_VALUE_2", ""),
                ("GIT_CONFIG_KEY_3", no_proxy.as_str()),
                ("GIT_CONFIG_VALUE_3", ""),
            ]
        );
        assert_eq!(
            proxy_rewrite(&proxy, &Repository::parse("octo", "repo.js").unwrap()),
            (
                key.clone(),
                "https://github.com/octo/repo.js.git".to_string()
            )
        );
    }

    #[test]
    fn network_git_ignores_the_host_users_credentials_and_http_proxy() {
        let proxy = proxy();
        let repository = Repository::parse("octo", "repo.js").unwrap();
        let config = network_config(Some(&proxy), &repository);
        let expected = [
            (
                format!("url.{proxy}octo/repo.js.git.insteadOf"),
                "https://github.com/octo/repo.js.git".to_string(),
            ),
            // An empty value resets the list: no helper of the host user is
            // asked for a credential, and none is offered a token to store.
            ("credential.helper".to_string(), String::new()),
            ("core.askPass".to_string(), String::new()),
            // Loopback traffic to the credential proxy never goes through a
            // configured HTTP proxy.
            (format!("http.{proxy}.proxy"), String::new()),
        ];
        assert_eq!(config, expected);
        // Without a proxy address there is nothing to rewrite or exempt.
        assert_eq!(
            network_config(None, &repository),
            [
                ("credential.helper".to_string(), String::new()),
                ("core.askPass".to_string(), String::new()),
            ]
        );
    }

    #[test]
    fn any_other_root_gets_nothing_whatever_the_proxy_says() {
        let (_dir, db) = database();
        register(
            &db,
            "/w/worktrees/github.com/octo/repo.js/abc",
            &[("MY_VAR", "one")],
        );
        let proxy = proxy();
        for root in [
            "/w/worktrees/github.com/octo/repo.js/abcd",
            "/w/worktrees/github.com/octo/repo.js",
            "/w/repos/github.com/octo/repo.js",
            "/home/user/project",
        ] {
            assert!(
                for_tool(&db, Path::new(root), Some(&proxy)).is_empty(),
                "{root}"
            );
            assert!(for_tool(&db, Path::new(root), None).is_empty(), "{root}");
        }
    }

    #[test]
    fn a_stored_variable_with_a_forbidden_name_is_skipped() {
        let (_dir, db) = database();
        let root = "/w/worktrees/github.com/octo/repo.js/abc";
        // Stored by an older build, or written into the database by hand.
        register(
            &db,
            root,
            &[
                ("GIT_DIR", "/elsewhere"),
                ("KEEP", "yes"),
                ("LD_PRELOAD", "/tmp/x.so"),
                ("PI_WORKTREE_ROOT", "/elsewhere"),
                ("PATH", "/tmp"),
                ("A=B", "x"),
            ],
        );
        let env = for_tool(&db, Path::new(root), None);
        assert_eq!(
            pairs(&env),
            [
                ("KEEP", "yes"),
                ("PI_WORKTREE_ROOT", root),
                ("PI_PROJECT_ROOT", "/w/repos/github.com/octo/repo.js"),
            ]
        );
    }

    #[test]
    fn only_a_loopback_proxy_url_with_a_handle_is_accepted() {
        let good = proxy();
        assert_eq!(
            parse_proxy_url(Some(&serde_json::json!(good))).unwrap(),
            Some(good.clone())
        );
        assert_eq!(parse_proxy_url(None).unwrap(), None);
        for bad in [
            serde_json::json!(""),
            serde_json::json!(1),
            serde_json::json!(null),
            serde_json::json!("https://github.com/"),
            serde_json::json!(format!("http://evil.example:80/{}/", "ab".repeat(32))),
            serde_json::json!(format!(
                "http://127.0.0.1.evil.example/{}/",
                "ab".repeat(32)
            )),
            serde_json::json!(format!("http://127.0.0.1:4321/{}", "ab".repeat(32))),
            serde_json::json!(format!("http://127.0.0.1:4321/{}/extra/", "ab".repeat(32))),
            serde_json::json!(format!("http://127.0.0.1:/{}/", "ab".repeat(32))),
            serde_json::json!(format!("http://127.0.0.1:999999/{}/", "ab".repeat(32))),
            serde_json::json!("http://127.0.0.1:4321/short/"),
            serde_json::json!(format!("http://127.0.0.1:4321/{}/\n", "ab".repeat(32))),
            serde_json::json!(format!("http://user@127.0.0.1:4321/{}/", "ab".repeat(32))),
        ] {
            let error = parse_proxy_url(Some(&bad)).unwrap_err();
            assert_eq!(error.code, "INVALID_ARGUMENT", "{bad}");
        }
    }
}
