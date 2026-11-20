//! Real git processes: helper survival on cancel, and the environment
//! production network git runs with.

use super::*;

/// Command lines of every live process that mention `marker`.
#[cfg(target_os = "linux")]
fn processes_mentioning(marker: &str) -> Vec<String> {
    let mut found = Vec::new();
    for entry in std::fs::read_dir("/proc").unwrap().flatten() {
        let name = entry.file_name();
        if !name
            .to_string_lossy()
            .bytes()
            .all(|byte| byte.is_ascii_digit())
        {
            continue;
        }
        let Ok(raw) = std::fs::read(entry.path().join("cmdline")) else {
            continue;
        };
        let command = String::from_utf8_lossy(&raw).replace('\0', " ");
        if command.contains(marker) {
            found.push(command);
        }
    }
    found
}

/// Review focus 5 with a real git: a clone stuck on the network is cancelled.
/// git runs its transfer in a helper process (`git remote-http`); killing only
/// git itself would leave the helper transferring and the clone directory in
/// place.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn cancelling_a_stalled_clone_kills_gits_helper_and_removes_the_partial_clone() {
    use tokio::io::AsyncReadExt;
    // An upstream that accepts the request and then never answers.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let stalled = tokio::spawn(async move {
        let mut open = Vec::new();
        loop {
            if let Ok((mut socket, _)) = listener.accept().await {
                let mut request = [0u8; 1024];
                let _ = socket.read(&mut request).await;
                open.push(socket);
            }
        }
    });
    let marker = format!("127.0.0.1:{port}/octo/repo.git");
    let f = Fixture::new();
    let f = Fixture {
        context: Arc::new(WorkspaceGitContext::with_remote_base(&format!(
            "http://127.0.0.1:{port}"
        ))),
        ..f
    };
    let job_id = f.start_prepare(f.prepare_params("session-1", "main")).await;
    let parent = f.main_path().parent().unwrap().to_path_buf();
    let partial_clones = |parent: &Path| -> Vec<String> {
        std::fs::read_dir(parent)
            .map(|entries| {
                entries
                    .flatten()
                    .map(|entry| entry.file_name().to_string_lossy().into_owned())
                    .filter(|name| name.starts_with("repo.cloning-"))
                    .collect()
            })
            .unwrap_or_default()
    };
    // Wait until git's transfer helper is talking to the stalled upstream.
    let mut helper_seen = false;
    for _ in 0..500 {
        let commands = processes_mentioning(&marker);
        if commands
            .iter()
            .any(|command| command.contains("remote-http"))
            && !partial_clones(&parent).is_empty()
        {
            helper_seen = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(helper_seen, "git's transfer helper never started");

    f.call("workspaceGit.jobCancel", json!({ "jobId": job_id }))
        .await
        .unwrap();
    let job = f
        .call("workspaceGit.job", json!({ "jobId": job_id }))
        .await
        .unwrap();
    assert_eq!(job["state"], "cancelled", "{job}");

    // No git or helper of the job survives, and nothing is left to clean up.
    let mut survivors = processes_mentioning(&marker);
    for _ in 0..100 {
        if survivors.is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
        survivors = processes_mentioning(&marker);
    }
    assert!(survivors.is_empty(), "still running: {survivors:?}");
    assert_eq!(partial_clones(&parent), Vec::<String>::new());
    assert!(!f.main_path().exists());
    assert!(!f.worktree_path("session-1").exists());
    stalled.abort();

    // The same session prepares normally once the upstream answers.
    let retry = Fixture {
        context: Arc::new(WorkspaceGitContext::with_remote_base(&f.remote.base())),
        ..f
    };
    let worktree = retry.prepare("session-1", "main").await;
    assert_eq!(worktree["baseCommit"], retry.remote.head("main"));
}

#[test]
fn production_network_git_uses_the_proxy_rewrite_and_no_host_credentials() {
    let proxy = format!("http://127.0.0.1:4321/{}/", "ab".repeat(32));
    let repository = crate::workspace_git::layout::Repository::parse("octo", "repo").unwrap();
    let keys = |context: &WorkspaceGitContext| -> Vec<String> {
        context
            .network_config(&proxy, &repository)
            .into_iter()
            .map(|(key, value)| format!("{key}={value}"))
            .collect()
    };
    assert_eq!(
        keys(&WorkspaceGitContext::default()),
        [
            format!("url.{proxy}octo/repo.git.insteadOf=https://github.com/octo/repo.git"),
            "credential.helper=".to_string(),
            "core.askPass=".to_string(),
            format!("http.{proxy}.proxy="),
        ]
    );
    // A substituted remote has nothing to rewrite, and still asks nobody.
    assert_eq!(
        keys(&WorkspaceGitContext::with_remote_base("file:///tmp/x")),
        ["credential.helper=", "core.askPass="]
    );
}
