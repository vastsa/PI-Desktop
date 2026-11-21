use std::path::{Path, PathBuf};
use std::time::Duration;

use super::workspace_git_rpc::{handle_with, WorkspaceGitContext};
use super::*;
use crate::session_worktrees::git::GitRunner;
use crate::session_worktrees::test_support::git_cmd;
use crate::workspace_git::layout::{short_id, work_branch};
use crate::workspace_git::test_support::{commit_file, rev_parse, Remote};

const INSTALLATION: &str = "00000000-0000-4000-8000-000000000000";
const OTHER_INSTALLATION: &str = "11111111-1111-4111-8111-111111111111";

struct Fixture {
    dir: tempfile::TempDir,
    state: Arc<Mutex<AppState>>,
    context: Arc<WorkspaceGitContext>,
    remote: Remote,
    root: PathBuf,
}

impl Fixture {
    fn new() -> Fixture {
        Self::with_git(|_| GitRunner::default())
    }

    fn with_git(git: impl FnOnce(&Path) -> GitRunner) -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let base = crate::workspace::simple_canonicalize(dir.path()).unwrap();
        let mut state = AppState::open(&base.join("data")).unwrap();
        state.handshook = true;
        let remote = Remote::new(&base);
        let context = WorkspaceGitContext::with_remote_base(&remote.base()).with_git(git(&base));
        Fixture {
            state: Arc::new(Mutex::new(state)),
            context: Arc::new(context),
            remote,
            root: base.join("workspaces"),
            dir,
        }
    }

    /// A git that pauses before the named subcommands, so a test can observe
    /// or interrupt the step that runs them.
    #[cfg(unix)]
    fn slow(pattern: &'static str, seconds: &'static str) -> Fixture {
        Self::with_git(|base| {
            use std::os::unix::fs::PermissionsExt;
            let script = base.join("slow-git");
            std::fs::write(
                &script,
                format!(
                    "#!/bin/sh\ncase \" $* \" in {pattern}) sleep {seconds};; esac\nexec git \"$@\"\n"
                ),
            )
            .unwrap();
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
            GitRunner::with_program(script)
        })
    }

    fn proxy(&self) -> Value {
        json!({ "url": format!("http://127.0.0.1:4321/{}/", "ab".repeat(32)) })
    }

    async fn call(&self, method: &str, mut params: Value) -> Result<Value, JsonRpcError> {
        if params.get("workspacesRoot").is_none() {
            params["workspacesRoot"] = json!(self.root);
        }
        handle_with(&self.state, &self.context, method, params).await
    }

    fn prepare_params(&self, session: &str, base_branch: &str) -> Value {
        json!({
            "gitProxy": self.proxy(),
            "installationId": INSTALLATION,
            "sessionId": session,
            "repository": { "owner": "octo", "name": "repo" },
            "baseBranch": base_branch,
        })
    }

    async fn start_prepare(&self, params: Value) -> String {
        let started = self.call("workspaceGit.prepare", params).await.unwrap();
        started["jobId"].as_str().unwrap().to_string()
    }

    /// Poll a job to its terminal state; returns it with the distinct phases
    /// seen on the way, in order.
    async fn wait(&self, job_id: &str) -> (Value, Vec<String>) {
        let mut phases: Vec<String> = Vec::new();
        for _ in 0..3000 {
            let job = self
                .call("workspaceGit.job", json!({ "jobId": job_id }))
                .await
                .unwrap();
            let phase = job["phase"].as_str().unwrap().to_string();
            if phases.last() != Some(&phase) {
                phases.push(phase);
            }
            if job["state"] != "running" {
                return (job, phases);
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("job {job_id} did not finish; phases {phases:?}");
    }

    async fn prepare(&self, session: &str, base_branch: &str) -> Value {
        let job_id = self
            .start_prepare(self.prepare_params(session, base_branch))
            .await;
        let (job, _phases) = self.wait(&job_id).await;
        assert_eq!(job["state"], "succeeded", "{job}");
        job["worktree"].clone()
    }

    fn main_path(&self) -> PathBuf {
        self.root.join("repos/github.com/octo/repo")
    }

    fn worktree_path(&self, session: &str) -> PathBuf {
        self.root
            .join("worktrees/github.com/octo/repo")
            .join(short_id(INSTALLATION, session))
    }

    fn session(&self, session: &str) -> Value {
        json!({ "installationId": INSTALLATION, "sessionId": session })
    }
}

fn code(error: &JsonRpcError) -> String {
    error.data.as_ref().unwrap()["errorCode"]
        .as_str()
        .unwrap()
        .to_string()
}

fn worktree_count(main: &Path) -> usize {
    git_cmd(main, &["worktree", "list"]).lines().count()
}

fn is_ordered_subsequence(seen: &[String], order: &[&str]) -> bool {
    let mut position = 0;
    seen.iter().all(|phase| {
        match order[position..]
            .iter()
            .position(|candidate| candidate == phase)
        {
            Some(offset) => {
                position += offset + 1;
                true
            }
            None => false,
        }
    })
}

#[cfg(unix)]
#[tokio::test]
async fn prepare_clones_then_creates_the_worktree_and_reports_phases_in_order() {
    let f = Fixture::slow("*' clone '*|*' fetch '*|*' worktree add '*", "0.3");
    let before = f
        .call(
            "workspaceGit.repository",
            json!({ "repository": { "owner": "octo", "name": "repo" } }),
        )
        .await
        .unwrap();
    assert_eq!(before, json!({ "path": f.main_path(), "cloned": false }));
    // Asking where a repository lives creates nothing.
    assert!(!f.root.exists());

    let job_id = f.start_prepare(f.prepare_params("session-1", "main")).await;
    let (job, phases) = f.wait(&job_id).await;
    assert_eq!(job["state"], "succeeded", "{job}");
    assert_eq!(job["kind"], "prepare");
    assert_eq!(job["phase"], "done");
    for phase in ["cloning", "creatingWorktree", "done"] {
        assert!(phases.iter().any(|seen| seen == phase), "{phases:?}");
    }
    assert!(
        is_ordered_subsequence(&phases, &["queued", "cloning", "creatingWorktree", "done"]),
        "{phases:?}"
    );

    let worktree = &job["worktree"];
    let path = f.worktree_path("session-1");
    assert_eq!(
        *worktree,
        json!({
            "sessionId": "session-1",
            "repository": { "owner": "octo", "name": "repo" },
            "baseBranch": "main",
            "workBranch": "pi-desktop/8b54618f6bc1",
            "path": path,
            "checkoutPresent": true,
            "mainPath": f.main_path(),
            "baseCommit": f.remote.head("main"),
            "createdAt": worktree["createdAt"],
            "setup": { "status": "none" },
        })
    );
    assert!(worktree["createdAt"].as_str().unwrap().ends_with('Z'));
    assert_eq!(rev_parse(&path, "HEAD"), f.remote.head("main"));
    assert_eq!(
        git_cmd(&path, &["symbolic-ref", "--short", "HEAD"]).trim(),
        work_branch(INSTALLATION, "session-1")
    );
    let after = f
        .call(
            "workspaceGit.repository",
            json!({ "repository": { "owner": "octo", "name": "repo" } }),
        )
        .await
        .unwrap();
    assert_eq!(after, json!({ "path": f.main_path(), "cloned": true }));

    // A second session reuses the clone: it fetches instead.
    f.remote.commit("develop", "later.txt", "later\n");
    let job_id = f
        .start_prepare(f.prepare_params("session-2", "develop"))
        .await;
    let (job, phases) = f.wait(&job_id).await;
    assert_eq!(job["state"], "succeeded", "{job}");
    assert!(
        phases.iter().any(|seen| seen == "fetching")
            && !phases.iter().any(|seen| seen == "cloning"),
        "{phases:?}"
    );
    assert!(
        is_ordered_subsequence(&phases, &["queued", "fetching", "creatingWorktree", "done"]),
        "{phases:?}"
    );
    assert_eq!(job["worktree"]["baseCommit"], f.remote.head("develop"));
    assert!(f.worktree_path("session-2").join("later.txt").is_file());
    // The first session's worktree is untouched.
    assert_eq!(rev_parse(&path, "HEAD"), f.remote.head("main"));
    assert_eq!(worktree_count(&f.main_path()), 3);
}

#[tokio::test]
async fn a_second_prepare_for_the_same_session_returns_the_existing_worktree() {
    let f = Fixture::new();
    let first = f.prepare("session-1", "main").await;
    commit_file(&f.worktree_path("session-1"), "work.txt", "work\n");
    let head = rev_parse(&f.worktree_path("session-1"), "HEAD");

    // A retry after a lost reply, or a double click; even with another base.
    let job_id = f
        .start_prepare(f.prepare_params("session-1", "develop"))
        .await;
    let job = f
        .call("workspaceGit.job", json!({ "jobId": job_id }))
        .await
        .unwrap();
    // Already terminal on the first poll: nothing ran.
    assert_eq!(job["state"], "succeeded");
    assert_eq!(job["phase"], "done");
    assert_eq!(job["worktree"], first);
    assert_eq!(rev_parse(&f.worktree_path("session-1"), "HEAD"), head);
    assert_eq!(worktree_count(&f.main_path()), 2);
    let listed = f
        .call(
            "workspaceGit.list",
            json!({ "installationId": INSTALLATION }),
        )
        .await
        .unwrap();
    assert_eq!(listed["worktrees"].as_array().unwrap().len(), 1);
}

#[cfg(unix)]
#[tokio::test]
async fn a_running_job_makes_the_session_busy() {
    let f = Fixture::slow("*' clone '*", "1");
    let params = f.prepare_params("session-1", "main");
    let job_id = f.start_prepare(params.clone()).await;
    let error = f.call("workspaceGit.prepare", params).await.unwrap_err();
    assert_eq!(code(&error), "WORKSPACE_GIT_BUSY");
    // Another session of the same repository is not blocked from starting.
    let other = f.start_prepare(f.prepare_params("session-2", "main")).await;
    let (job, _phases) = f.wait(&job_id).await;
    assert_eq!(job["state"], "succeeded", "{job}");
    let (job, _phases) = f.wait(&other).await;
    assert_eq!(job["state"], "succeeded", "{job}");
    assert_eq!(worktree_count(&f.main_path()), 3);
}

#[cfg(unix)]
#[tokio::test]
async fn push_and_remove_are_busy_while_the_setup_script_runs() {
    let f = Fixture::new();
    let mut params = f.prepare_params("session-1", "main");
    params["environment"] = json!({ "variables": [], "setupScript": "sleep 1" });
    let job_id = f.start_prepare(params.clone()).await;
    // Wait until the worktree is registered and the script has started.
    for _ in 0..1000 {
        let job = f
            .call("workspaceGit.job", json!({ "jobId": job_id }))
            .await
            .unwrap();
        if job["phase"] == "runningSetup" {
            break;
        }
        assert_eq!(job["state"], "running", "{job}");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let mut push = f.session("session-1");
    push["gitProxy"] = f.proxy();
    for (method, input) in [
        ("workspaceGit.prepare", params),
        ("workspaceGit.push", push),
        ("workspaceGit.remove", {
            let mut input = f.session("session-1");
            input["force"] = json!(true);
            input
        }),
    ] {
        let error = f.call(method, input).await.unwrap_err();
        assert_eq!(code(&error), "WORKSPACE_GIT_BUSY", "{method}");
    }
    let (job, _phases) = f.wait(&job_id).await;
    assert_eq!(job["state"], "succeeded", "{job}");
    assert!(f.worktree_path("session-1").is_dir());
}

#[cfg(unix)]
#[tokio::test]
async fn cancelling_during_the_clone_leaves_nothing_and_a_later_prepare_succeeds() {
    let f = Fixture::slow("*' clone '*", "30");
    let job_id = f.start_prepare(f.prepare_params("session-1", "main")).await;
    for _ in 0..1000 {
        let job = f
            .call("workspaceGit.job", json!({ "jobId": job_id }))
            .await
            .unwrap();
        if job["phase"] == "cloning" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let started = std::time::Instant::now();
    let cancelled = f
        .call("workspaceGit.jobCancel", json!({ "jobId": job_id }))
        .await
        .unwrap();
    assert_eq!(cancelled, json!({ "ok": true }));
    // The cancel returns once the job has stopped and cleaned up.
    let job = f
        .call("workspaceGit.job", json!({ "jobId": job_id }))
        .await
        .unwrap();
    assert_eq!(job["state"], "cancelled", "{job}");
    assert!(started.elapsed() < Duration::from_secs(10));
    assert!(job.get("worktree").is_none());

    // Nothing where the main checkout or the worktree belong, and no
    // half-cloned directory beside it.
    assert!(!f.main_path().exists());
    assert!(!f.worktree_path("session-1").exists());
    let siblings: Vec<_> = std::fs::read_dir(f.main_path().parent().unwrap())
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert!(siblings.is_empty(), "{siblings:?}");
    let listed = f
        .call(
            "workspaceGit.list",
            json!({ "installationId": INSTALLATION }),
        )
        .await
        .unwrap();
    assert_eq!(listed["worktrees"], json!([]));

    // The same session can be prepared again, with a git that is not stuck.
    let retry = Fixture {
        context: Arc::new(WorkspaceGitContext::with_remote_base(&f.remote.base())),
        ..f
    };
    let worktree = retry.prepare("session-1", "main").await;
    assert_eq!(worktree["baseCommit"], retry.remote.head("main"));
    assert!(retry.worktree_path("session-1").join("README.md").is_file());
}

#[cfg(unix)]
#[tokio::test]
async fn cancelling_during_the_setup_script_removes_the_worktree_and_keeps_the_clone() {
    let f = Fixture::new();
    let mut params = f.prepare_params("session-1", "main");
    params["environment"] = json!({ "variables": [], "setupScript": "sleep 30" });
    let job_id = f.start_prepare(params).await;
    for _ in 0..1000 {
        let job = f
            .call("workspaceGit.job", json!({ "jobId": job_id }))
            .await
            .unwrap();
        if job["phase"] == "runningSetup" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let started = std::time::Instant::now();
    f.call("workspaceGit.jobCancel", json!({ "jobId": job_id }))
        .await
        .unwrap();
    let job = f
        .call("workspaceGit.job", json!({ "jobId": job_id }))
        .await
        .unwrap();
    assert_eq!(job["state"], "cancelled", "{job}");
    assert_eq!(job["phase"], "runningSetup");
    assert!(started.elapsed() < Duration::from_secs(10));
    assert!(!f.worktree_path("session-1").exists());
    assert_eq!(worktree_count(&f.main_path()), 1);
    assert!(f.main_path().join("README.md").is_file());
    let error = f
        .call("workspaceGit.status", f.session("session-1"))
        .await
        .unwrap_err();
    assert_eq!(code(&error), "WORKSPACE_GIT_NOT_FOUND");
}

#[cfg(unix)]
#[tokio::test]
async fn a_setup_script_runs_in_the_worktree_and_its_failure_does_not_fail_the_job() {
    let f = Fixture::new();
    let mut ok = f.prepare_params("session-ok", "main");
    ok["environment"] = json!({
        "variables": [{ "name": "MY_VAR", "value": "from the environment" }],
        "setupScript": "printf '%s|%s|%s' \"$MY_VAR\" \"$PI_WORKTREE_ROOT\" \"$PI_PROJECT_ROOT\" > setup-out.txt\necho setup-ran",
    });
    let job_id = f.start_prepare(ok).await;
    let (job, phases) = f.wait(&job_id).await;
    assert_eq!(job["state"], "succeeded", "{job}");
    assert!(
        is_ordered_subsequence(
            &phases,
            &[
                "queued",
                "cloning",
                "creatingWorktree",
                "runningSetup",
                "done"
            ]
        ),
        "{phases:?}"
    );
    let path = f.worktree_path("session-ok");
    assert_eq!(job["worktree"]["setup"]["status"], "ok");
    assert!(job["worktree"]["setup"]["logTail"]
        .as_str()
        .unwrap()
        .contains("setup-ran"));
    assert_eq!(
        std::fs::read_to_string(path.join("setup-out.txt")).unwrap(),
        format!(
            "from the environment|{}|{}",
            path.display(),
            f.main_path().display()
        )
    );

    let mut failing = f.prepare_params("session-bad", "main");
    failing["environment"] =
        json!({ "variables": [], "setupScript": "echo before-failure; exit 7" });
    let job_id = f.start_prepare(failing).await;
    let (job, _phases) = f.wait(&job_id).await;
    // The worktree is ready; only the setup status reports the failure.
    assert_eq!(job["state"], "succeeded", "{job}");
    assert_eq!(job["worktree"]["setup"]["status"], "failed");
    assert!(job["worktree"]["setup"]["logTail"]
        .as_str()
        .unwrap()
        .contains("before-failure"));
    assert!(f.worktree_path("session-bad").join("README.md").is_file());
    let status = f
        .call("workspaceGit.status", f.session("session-bad"))
        .await
        .unwrap();
    assert_eq!(status["worktree"]["setup"]["status"], "failed");

    // An empty script is no script.
    let mut empty = f.prepare_params("session-empty", "main");
    empty["environment"] = json!({ "variables": [], "setupScript": "  \n" });
    let job_id = f.start_prepare(empty).await;
    let (job, phases) = f.wait(&job_id).await;
    assert_eq!(job["worktree"]["setup"], json!({ "status": "none" }));
    assert!(!phases.iter().any(|phase| phase == "runningSetup"));
}

#[tokio::test]
async fn push_runs_as_a_job_and_reports_the_remote_head() {
    let f = Fixture::new();
    f.prepare("session-1", "main").await;
    let path = f.worktree_path("session-1");
    let head = commit_file(&path, "work.txt", "work\n");
    let before = f
        .call("workspaceGit.status", f.session("session-1"))
        .await
        .unwrap();
    assert_eq!(
        (
            &before["ahead"],
            &before["behind"],
            &before["uncommittedFiles"],
            &before["unpushedCommits"],
            &before["pushedOnce"]
        ),
        (&json!(0), &json!(0), &json!(0), &json!(1), &json!(false))
    );
    assert_eq!(before["worktree"]["sessionId"], "session-1");

    let mut push = f.session("session-1");
    push["gitProxy"] = f.proxy();
    let started = f.call("workspaceGit.push", push.clone()).await.unwrap();
    let (job, phases) = f.wait(started["jobId"].as_str().unwrap()).await;
    assert_eq!(job["state"], "succeeded", "{job}");
    assert_eq!(job["kind"], "push");
    assert!(is_ordered_subsequence(
        &phases,
        &["queued", "pushing", "done"]
    ));
    let branch = work_branch(INSTALLATION, "session-1");
    assert_eq!(
        job["pushed"],
        json!({ "branch": branch, "remoteHead": head })
    );
    assert_eq!(f.remote.head(&branch), head);
    let after = f
        .call("workspaceGit.status", f.session("session-1"))
        .await
        .unwrap();
    assert_eq!(after["unpushedCommits"], 0);
    assert_eq!(after["pushedOnce"], true);

    // A session without a worktree has nothing to push.
    let mut missing = f.session("no-such-session");
    missing["gitProxy"] = f.proxy();
    let error = f.call("workspaceGit.push", missing).await.unwrap_err();
    assert_eq!(code(&error), "WORKSPACE_GIT_NOT_FOUND");
    // Network methods need the proxy address.
    let error = f
        .call("workspaceGit.push", f.session("session-1"))
        .await
        .unwrap_err();
    assert_eq!(code(&error), "INVALID_ARGUMENT");
}

#[tokio::test]
async fn remove_refuses_to_lose_work_unless_forced() {
    let f = Fixture::new();
    f.prepare("session-1", "main").await;
    f.prepare("session-2", "develop").await;
    let path = f.worktree_path("session-1");
    commit_file(&path, "work.txt", "work\n");
    std::fs::write(path.join("scratch.txt"), "scratch\n").unwrap();
    let branch = work_branch(INSTALLATION, "session-1");

    let mut input = f.session("session-1");
    input["force"] = json!(false);
    let refused = f.call("workspaceGit.remove", input.clone()).await.unwrap();
    assert_eq!(
        refused,
        json!({ "removed": false, "uncommittedFiles": 1, "unpushedCommits": 1 })
    );
    assert!(path.join("scratch.txt").is_file());
    assert!(git_cmd(&f.main_path(), &["branch", "--list", &branch]).contains(&branch));

    input["force"] = json!(true);
    let removed = f.call("workspaceGit.remove", input.clone()).await.unwrap();
    assert_eq!(
        removed,
        json!({ "removed": true, "uncommittedFiles": 1, "unpushedCommits": 1 })
    );
    assert!(!path.exists());
    assert_eq!(git_cmd(&f.main_path(), &["branch", "--list", &branch]), "");
    // The other session and the main checkout are intact.
    assert!(f.worktree_path("session-2").join("develop.txt").is_file());
    assert_eq!(worktree_count(&f.main_path()), 2);
    let listed = f
        .call(
            "workspaceGit.list",
            json!({ "installationId": INSTALLATION }),
        )
        .await
        .unwrap();
    assert_eq!(listed["worktrees"].as_array().unwrap().len(), 1);
    assert_eq!(listed["worktrees"][0]["sessionId"], "session-2");

    // Nothing left to remove.
    let error = f.call("workspaceGit.remove", input).await.unwrap_err();
    assert_eq!(code(&error), "WORKSPACE_GIT_NOT_FOUND");
    // A clean worktree needs no force.
    let mut clean = f.session("session-2");
    clean["force"] = json!(false);
    assert_eq!(
        f.call("workspaceGit.remove", clean).await.unwrap(),
        json!({ "removed": true, "uncommittedFiles": 0, "unpushedCommits": 0 })
    );
    assert!(!f.worktree_path("session-2").exists());
}

#[tokio::test]
async fn list_and_status_are_scoped_to_the_installation() {
    let f = Fixture::new();
    f.prepare("session-1", "main").await;
    let mut other = f.prepare_params("session-1", "develop");
    other["installationId"] = json!(OTHER_INSTALLATION);
    let job_id = f.start_prepare(other).await;
    let (job, _phases) = f.wait(&job_id).await;
    assert_eq!(job["state"], "succeeded", "{job}");
    // Same session id, another desktop: its own branch and directory.
    assert_ne!(job["worktree"]["path"], json!(f.worktree_path("session-1")));

    let mine = f
        .call(
            "workspaceGit.list",
            json!({ "installationId": INSTALLATION }),
        )
        .await
        .unwrap();
    assert_eq!(mine["worktrees"].as_array().unwrap().len(), 1);
    assert_eq!(mine["worktrees"][0]["baseBranch"], "main");
    assert_eq!(
        mine["worktrees"][0]["path"],
        json!(f.worktree_path("session-1"))
    );
    // The wire shape never carries the installation id or the environment.
    assert!(mine["worktrees"][0].get("installationId").is_none());
    assert!(mine["worktrees"][0].get("variables").is_none());
    let theirs = f
        .call(
            "workspaceGit.list",
            json!({ "installationId": OTHER_INSTALLATION }),
        )
        .await
        .unwrap();
    assert_eq!(theirs["worktrees"].as_array().unwrap().len(), 1);
    assert_eq!(theirs["worktrees"][0]["baseBranch"], "develop");
    let nobody = f
        .call(
            "workspaceGit.list",
            json!({ "installationId": "22222222-2222-4222-8222-222222222222" }),
        )
        .await
        .unwrap();
    assert_eq!(nobody["worktrees"], json!([]));

    // One desktop cannot remove another's worktree by naming its session.
    let error = f
        .call(
            "workspaceGit.remove",
            json!({ "installationId": "22222222-2222-4222-8222-222222222222", "sessionId": "session-1", "force": true }),
        )
        .await
        .unwrap_err();
    assert_eq!(code(&error), "WORKSPACE_GIT_NOT_FOUND");
    assert!(f.worktree_path("session-1").is_dir());
}

#[tokio::test]
async fn a_forked_session_starts_at_its_parents_unpushed_commit() {
    let f = Fixture::new();
    f.prepare("parent", "main").await;
    let unpushed = commit_file(&f.worktree_path("parent"), "parent.txt", "parent\n");
    assert!(!f.remote.has_branch(&work_branch(INSTALLATION, "parent")));

    let mut params = f.prepare_params("child", "main");
    params["fromSessionId"] = json!("parent");
    let job_id = f.start_prepare(params).await;
    let (job, _phases) = f.wait(&job_id).await;
    assert_eq!(job["state"], "succeeded", "{job}");
    let child = f.worktree_path("child");
    assert_eq!(rev_parse(&child, "HEAD"), unpushed);
    assert_eq!(job["worktree"]["baseCommit"], unpushed);
    // `baseBranch` is recorded as given; the child is on its own work branch.
    assert_eq!(job["worktree"]["baseBranch"], "main");
    assert_eq!(
        job["worktree"]["workBranch"],
        work_branch(INSTALLATION, "child")
    );
    assert_eq!(
        git_cmd(&child, &["symbolic-ref", "--short", "HEAD"]).trim(),
        work_branch(INSTALLATION, "child")
    );
    assert!(child.join("parent.txt").is_file());

    // A parent that has no worktree for this installation.
    for (session, installation, from) in [
        ("orphan", INSTALLATION, "no-such-parent"),
        ("stranger", OTHER_INSTALLATION, "parent"),
    ] {
        let mut params = f.prepare_params(session, "main");
        params["installationId"] = json!(installation);
        params["fromSessionId"] = json!(from);
        let job_id = f.start_prepare(params).await;
        let (job, _phases) = f.wait(&job_id).await;
        assert_eq!(job["state"], "failed", "{job}");
        assert_eq!(job["error"]["code"], "WORKSPACE_GIT_NOT_FOUND");
        assert!(job.get("worktree").is_none());
    }
    assert!(!f.worktree_path("orphan").exists());
    assert_eq!(worktree_count(&f.main_path()), 3);
}

#[tokio::test]
async fn a_parent_in_another_repository_is_not_a_starting_point() {
    let f = Fixture::new();
    f.prepare("parent", "main").await;
    // A second repository on the same host.
    let second = f.remote.bare.parent().unwrap().join("second.git");
    git_cmd(
        f.dir.path(),
        &[
            "clone",
            "-q",
            "--bare",
            f.remote.bare.to_str().unwrap(),
            second.to_str().unwrap(),
        ],
    );
    let mut params = f.prepare_params("child", "main");
    params["repository"] = json!({ "owner": "octo", "name": "second" });
    params["fromSessionId"] = json!("parent");
    let job_id = f.start_prepare(params).await;
    let (job, _phases) = f.wait(&job_id).await;
    assert_eq!(job["state"], "failed", "{job}");
    assert_eq!(job["error"]["code"], "WORKSPACE_GIT_NOT_FOUND");
}

#[tokio::test]
async fn a_missing_base_branch_or_repository_fails_the_job_with_a_typed_error() {
    let f = Fixture::new();
    let job_id = f
        .start_prepare(f.prepare_params("session-1", "no-such-branch"))
        .await;
    let (job, _phases) = f.wait(&job_id).await;
    assert_eq!(job["state"], "failed", "{job}");
    assert_eq!(job["error"]["code"], "WORKSPACE_GIT_BRANCH_NOT_FOUND");
    assert!(!f.worktree_path("session-1").exists());
    // The failure left the session free to be prepared again.
    let worktree = f.prepare("session-1", "main").await;
    assert_eq!(worktree["baseBranch"], "main");

    let mut params = f.prepare_params("session-2", "main");
    params["repository"] = json!({ "owner": "octo", "name": "missing" });
    let job_id = f.start_prepare(params).await;
    let (job, _phases) = f.wait(&job_id).await;
    assert_eq!(job["state"], "failed", "{job}");
    assert_eq!(job["error"]["code"], "WORKSPACE_GIT_REPOSITORY_NOT_FOUND");
    assert!(!f.root.join("repos/github.com/octo/missing").exists());
}

#[tokio::test]
async fn names_shaped_like_options_or_paths_are_rejected_before_anything_is_created() {
    let f = Fixture::new();
    let good = f.prepare_params("session-1", "main");
    let with = |field: &str, value: Value| {
        let mut params = good.clone();
        params[field] = value;
        params
    };
    let variables = |name: &str| json!({ "variables": [{ "name": name, "value": "x" }] });
    for params in [
        with("repository", json!({ "owner": "octo", "name": ".." })),
        with("repository", json!({ "owner": "octo", "name": "." })),
        with("repository", json!({ "owner": "..", "name": "repo" })),
        with(
            "repository",
            json!({ "owner": "octo", "name": "--upload-pack=x" }),
        ),
        with(
            "repository",
            json!({ "owner": "octo/evil", "name": "repo" }),
        ),
        with("repository", json!({ "owner": "octo", "name": "repo.git" })),
        with("repository", json!("octo/repo")),
        with("baseBranch", json!("-x")),
        with("baseBranch", json!("a..b")),
        with("baseBranch", json!("../../etc")),
        with("baseBranch", json!("a.lock")),
        with("baseBranch", json!("a\u{0}b")),
        with("installationId", json!("../..")),
        with("installationId", json!("not-a-uuid")),
        with("sessionId", json!("")),
        with("sessionId", json!("s".repeat(257))),
        with("fromSessionId", json!("")),
        with("fromSessionId", json!(7)),
        with("environment", variables("GIT_DIR")),
        with("environment", variables("PATH")),
        with("environment", variables("LD_PRELOAD")),
        with("environment", variables("1A")),
        with(
            "environment",
            json!({ "variables": (0..65).map(|index| json!({ "name": format!("V{index}"), "value": "x" })).collect::<Vec<_>>() }),
        ),
        with(
            "environment",
            json!({ "variables": [{ "name": "BIG", "value": "x".repeat(8193) }] }),
        ),
        with(
            "environment",
            json!({ "variables": [], "setupScript": "x".repeat(65537) }),
        ),
        with("gitProxy", json!({ "url": "https://evil.example/" })),
        with("gitProxy", json!(null)),
        with("workspacesRoot", json!("relative/root")),
        with("workspacesRoot", json!("/tmp/../etc")),
    ] {
        let error = f
            .call("workspaceGit.prepare", params.clone())
            .await
            .unwrap_err();
        assert_eq!(code(&error), "INVALID_ARGUMENT", "{params}");
    }
    // The repository lookup applies the same rules.
    for repository in [
        json!({ "owner": "octo", "name": ".." }),
        json!({ "owner": "-octo", "name": "repo" }),
        json!({ "owner": "octo", "name": "a/b" }),
    ] {
        let error = f
            .call(
                "workspaceGit.repository",
                json!({ "repository": repository }),
            )
            .await
            .unwrap_err();
        assert_eq!(code(&error), "INVALID_ARGUMENT");
    }
    // No directory was created anywhere, and no job was started.
    assert!(!f.root.exists());
    assert!(f
        .state
        .lock()
        .await
        .workspace_git_jobs
        .lock()
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn unknown_jobs_and_methods_are_typed_errors_through_the_dispatcher() {
    let f = Fixture::new();
    let (tx, _rx) = mpsc::unbounded_channel();
    for method in ["workspaceGit.job", "workspaceGit.jobCancel"] {
        let error = handle_request(
            f.state.clone(),
            method,
            json!({ "jobId": "no-such-job" }),
            tx.clone(),
        )
        .await
        .unwrap_err();
        assert_eq!(code(&error), "WORKSPACE_GIT_JOB_NOT_FOUND", "{method}");
    }
    let error = handle_request(f.state.clone(), "workspaceGit.nope", json!({}), tx.clone())
        .await
        .unwrap_err();
    assert_eq!(error.code, -32601);
    let listed = handle_request(
        f.state.clone(),
        "workspaceGit.list",
        json!({ "installationId": INSTALLATION }),
        tx.clone(),
    )
    .await
    .unwrap();
    assert_eq!(listed, json!({ "worktrees": [] }));
    let error = handle_request(
        f.state.clone(),
        "workspaceGit.status",
        f.session("session-1"),
        tx,
    )
    .await
    .unwrap_err();
    assert_eq!(code(&error), "WORKSPACE_GIT_NOT_FOUND");
}

#[tokio::test]
async fn a_missing_checkout_preserves_the_local_branch() {
    let f = Fixture::new();
    f.prepare("session-1", "main").await;
    let path = f.worktree_path("session-1");
    let head = commit_file(&path, "unpushed.txt", "precious");
    std::fs::remove_dir_all(&path).unwrap();
    let status = f
        .call("workspaceGit.status", f.session("session-1"))
        .await
        .unwrap();
    assert_eq!(status["worktree"]["checkoutPresent"], false);
    assert_eq!(status["unpushedCommits"], 1);
    assert_eq!(status["aheadOfBase"], 1);
    let mut remove = f.session("session-1");
    // Only the legacy, explicitly forced method can discard local commits.
    remove["force"] = json!(true);
    let result = f.call("workspaceGit.removeSafely", remove).await.unwrap();
    assert_eq!(result["removed"], false);
    assert_eq!(result["unpushedCommits"], 1);
    let worktree = f.prepare("session-1", "main").await;
    assert_eq!(worktree["baseBranch"], "main");
    assert_eq!(rev_parse(&path, "HEAD"), head);
    assert_eq!(worktree_count(&f.main_path()), 2);
}

#[tokio::test]
async fn a_restore_only_request_cannot_create_a_new_registration() {
    let f = Fixture::new();
    let mut params = f.prepare_params("session-1", "main");
    params["restoreOnly"] = json!(true);
    let error = f.call("workspaceGit.prepare", params).await.unwrap_err();
    assert_eq!(code(&error), "WORKSPACE_GIT_NOT_FOUND");
    assert!(!f.worktree_path("session-1").exists());
    assert!(!f.main_path().exists());
}

/// Branch names follow git's rules, not an allowlist: a name GitHub lists must
/// survive every layer down to git, as an operand and inside a full ref name.
#[tokio::test]
async fn a_worktree_is_prepared_from_base_branches_with_unusual_names() {
    let f = Fixture::new();
    for (session, branch) in [
        ("session-hash", "fix/#123"),
        ("session-equals", "release=1.0"),
        ("session-unicode", "功能/登录"),
    ] {
        let head = f.remote.create_branch(branch, "develop");
        let worktree = f.prepare(session, branch).await;
        assert_eq!(worktree["baseBranch"], branch);
        assert_eq!(worktree["baseCommit"], head, "{branch}");
        let path = f.worktree_path(session);
        assert_eq!(rev_parse(&path, "HEAD"), head, "{branch}");
        assert!(path.join("develop.txt").is_file());
        // The name never became part of a path: the directory is the short id.
        assert_eq!(
            path.file_name().unwrap().to_str().unwrap(),
            short_id(INSTALLATION, session)
        );
        let status = f
            .call("workspaceGit.status", f.session(session))
            .await
            .unwrap();
        assert_eq!(status["worktree"]["baseBranch"], branch);
    }
    // An owner with an underscore is a valid coordinate (it is simply absent here).
    let mut params = f.prepare_params("session-emu", "main");
    params["repository"] = json!({ "owner": "mona_acme", "name": "repo" });
    let job_id = f.start_prepare(params).await;
    let (job, _phases) = f.wait(&job_id).await;
    assert_eq!(
        job["error"]["code"], "WORKSPACE_GIT_REPOSITORY_NOT_FOUND",
        "{job}"
    );
}

#[tokio::test]
async fn rerun_setup_reruns_script_in_place_and_rejects_when_busy() {
    let f = Fixture::new();
    let mut params = f.prepare_params("session-rerun", "main");
    params["environment"] = json!({
        "variables": [{ "name": "SETUP_MODE", "value": "fail" }],
        "setupScript": "echo first-attempt; exit 1",
    });
    let first_id = f.start_prepare(params).await;
    let (first_job, _) = f.wait(&first_id).await;
    assert_eq!(first_job["state"], "succeeded", "{first_job}");
    assert_eq!(first_job["worktree"]["setup"]["status"], "failed");
    let worktree_path = PathBuf::from(first_job["worktree"]["path"].as_str().unwrap());
    let work_branch = first_job["worktree"]["workBranch"]
        .as_str()
        .unwrap()
        .to_string();

    // Place an untracked marker in the worktree to prove rerunSetup does not delete/recreate it.
    let marker = worktree_path.join("preserve-me.txt");
    std::fs::write(&marker, "kept").unwrap();

    // Rerun with a gated script so we can also observe WORKSPACE_GIT_BUSY and live setupLogTail.
    let gate = f.dir.path().join("setup.gate");
    let mut rerun_params = f.prepare_params("session-rerun", "main");
    rerun_params["rerunSetup"] = json!(true);
    rerun_params["environment"] = json!({
        "variables": [{ "name": "SETUP_MODE", "value": "ok" }],
        "setupScript": format!(
            "echo rerun-started-$SETUP_MODE; while [ ! -f '{}' ]; do sleep 0.02; done; echo rerun-done",
            gate.display()
        ),
    });
    let rerun_id = f.start_prepare(rerun_params.clone()).await;

    // Poll until live setupLogTail shows up in workspaceGit.job.
    let mut saw_live_tail = false;
    for _ in 0..500 {
        let job = f
            .call("workspaceGit.job", json!({ "jobId": rerun_id }))
            .await
            .unwrap();
        if job["phase"] == "runningSetup"
            && job["setupLogTail"]
                .as_str()
                .is_some_and(|tail| tail.contains("rerun-started-ok"))
        {
            saw_live_tail = true;
            break;
        }
        assert_eq!(job["state"], "running", "job ended too early: {job}");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(
        saw_live_tail,
        "expected live setupLogTail while setup is running"
    );

    // A concurrent prepare while setup is running is rejected with WORKSPACE_GIT_BUSY.
    let busy_err = f
        .call("workspaceGit.prepare", rerun_params)
        .await
        .unwrap_err();
    assert_eq!(code(&busy_err), "WORKSPACE_GIT_BUSY");

    // Release the gate and confirm the rerun succeeds in place.
    std::fs::write(&gate, "go").unwrap();
    let (rerun_job, _) = f.wait(&rerun_id).await;
    assert_eq!(rerun_job["state"], "succeeded", "{rerun_job}");
    assert_eq!(
        rerun_job["worktree"]["path"],
        worktree_path.to_str().unwrap()
    );
    assert_eq!(rerun_job["worktree"]["workBranch"], work_branch);
    assert_eq!(rerun_job["worktree"]["setup"]["status"], "ok");
    assert!(
        rerun_job["worktree"]["setup"]["logTail"]
            .as_str()
            .unwrap_or("")
            .contains("rerun-done"),
        "{rerun_job}"
    );
    assert_eq!(std::fs::read_to_string(&marker).unwrap(), "kept");
}

#[cfg(unix)]
#[tokio::test]
async fn prepare_and_push_report_git_progress_on_running_jobs() {
    use std::os::unix::fs::PermissionsExt;
    let f = Fixture::with_git(|base| {
        let gate = base.join("progress.gate");
        let script = base.join("progress-git");
        std::fs::write(
            &script,
            format!(
                "#!/bin/sh\n\
                 case \" $* \" in\n\
                   *\" clone \"*)\n\
                     printf 'Receiving objects:  42%% (10/24)\\r' >&2\n\
                     while [ ! -f '{gate}' ]; do sleep 0.02; done\n\
                     ;;\n\
                   *\" push \"*)\n\
                     printf 'Writing objects:  75%% (3/4)\\r' >&2\n\
                     while [ ! -f '{gate}' ]; do sleep 0.02; done\n\
                     ;;\n\
                 esac\n\
                 exec git \"$@\"\n",
                gate = gate.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        GitRunner::with_program(script)
    });
    let gate = f.root.parent().unwrap().join("progress.gate");

    // 1. Clone progress during prepare.
    let prepare_id = f
        .start_prepare(f.prepare_params("session-progress", "main"))
        .await;
    let mut saw_clone_progress = false;
    for _ in 0..500 {
        let job = f
            .call("workspaceGit.job", json!({ "jobId": prepare_id }))
            .await
            .unwrap();
        if job["progress"]["percent"] == 42 && job["progress"]["detail"] == "Receiving objects" {
            saw_clone_progress = true;
            break;
        }
        assert_eq!(job["state"], "running", "prepare ended early: {job}");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(saw_clone_progress, "expected clone progress on prepare job");
    std::fs::write(&gate, "go").unwrap();
    let (prepared, _) = f.wait(&prepare_id).await;
    assert_eq!(prepared["state"], "succeeded", "{prepared}");
    assert!(prepared.get("progress").is_none());

    // 2. Push progress after making a commit in the worktree.
    std::fs::remove_file(&gate).unwrap();
    let worktree_path = PathBuf::from(prepared["worktree"]["path"].as_str().unwrap());
    commit_file(&worktree_path, "progress.txt", "hello");
    let push_started = f
        .call(
            "workspaceGit.push",
            json!({
                "gitProxy": f.proxy(),
                "installationId": INSTALLATION,
                "sessionId": "session-progress",
            }),
        )
        .await
        .unwrap();
    let push_id = push_started["jobId"].as_str().unwrap().to_string();
    let mut saw_push_progress = false;
    for _ in 0..500 {
        let job = f
            .call("workspaceGit.job", json!({ "jobId": push_id }))
            .await
            .unwrap();
        if job["progress"]["percent"] == 75 && job["progress"]["detail"] == "Writing objects" {
            saw_push_progress = true;
            break;
        }
        assert_eq!(job["state"], "running", "push ended early: {job}");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(saw_push_progress, "expected push progress on push job");
    std::fs::write(&gate, "go").unwrap();
    let (pushed, _) = f.wait(&push_id).await;
    assert_eq!(pushed["state"], "succeeded", "{pushed}");
    assert!(pushed.get("progress").is_none());
}

/// Tests that spawn real git processes and inspect the process table.
mod process;
