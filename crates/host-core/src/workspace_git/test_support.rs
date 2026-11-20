//! A local bare repository standing in for GitHub in workspace git tests.

use std::path::{Path, PathBuf};

use crate::session_worktrees::test_support::{git_cmd, init_repo};

const IDENTITY: [&str; 4] = [
    "-c",
    "user.name=PI Test",
    "-c",
    "user.email=pi-test@example.invalid",
];

/// `<dir>/remote/octo/repo.git` (bare, branches `main` and `develop`) plus the
/// scratch clone used to add commits to it.
pub struct Remote {
    pub bare: PathBuf,
    source: PathBuf,
}

impl Remote {
    pub fn new(dir: &Path) -> Remote {
        let source = init_repo(&dir.join("source"));
        git_cmd(&source, &["checkout", "-q", "-b", "develop"]);
        std::fs::write(source.join("develop.txt"), "develop\n").unwrap();
        git_cmd(&source, &["add", "develop.txt"]);
        git_cmd(&source, &["commit", "-q", "-m", "develop"]);
        git_cmd(&source, &["checkout", "-q", "main"]);
        let bare = dir.join("remote").join("octo").join("repo.git");
        std::fs::create_dir_all(bare.parent().unwrap()).unwrap();
        git_cmd(
            dir,
            &[
                "clone",
                "-q",
                "--bare",
                source.to_str().unwrap(),
                bare.to_str().unwrap(),
            ],
        );
        Remote { bare, source }
    }

    /// The base under which `<owner>/<repo>.git` resolves, as a `file://` URL.
    pub fn base(&self) -> String {
        format!(
            "file://{}",
            self.bare.parent().unwrap().parent().unwrap().display()
        )
    }

    pub fn url(&self) -> String {
        format!("file://{}", self.bare.display())
    }

    /// Commit a file on `branch` and publish it; returns the new head.
    pub fn commit(&self, branch: &str, file: &str, content: &str) -> String {
        git_cmd(&self.source, &["checkout", "-q", branch]);
        std::fs::write(self.source.join(file), content).unwrap();
        git_cmd(&self.source, &["add", "--", file]);
        git_cmd(&self.source, &["commit", "-q", "-m", file]);
        git_cmd(
            &self.source,
            &["push", "-q", self.bare.to_str().unwrap(), branch],
        );
        self.head(branch)
    }

    /// Publish a new branch at the head of `from`.
    pub fn create_branch(&self, name: &str, from: &str) -> String {
        let refspec = format!("refs/heads/{from}:refs/heads/{name}");
        git_cmd(
            &self.source,
            &["push", "-q", self.bare.to_str().unwrap(), &refspec],
        );
        self.head(name)
    }

    /// The commit `branch` points at in the bare repository.
    pub fn head(&self, branch: &str) -> String {
        rev_parse(&self.bare, &format!("refs/heads/{branch}"))
    }

    pub fn has_branch(&self, branch: &str) -> bool {
        std::process::Command::new("git")
            .arg("-C")
            .arg(&self.bare)
            .args(["show-ref", "--verify", "--quiet"])
            .arg(format!("refs/heads/{branch}"))
            .status()
            .unwrap()
            .success()
    }
}

pub fn rev_parse(dir: &Path, reference: &str) -> String {
    git_cmd(dir, &["rev-parse", "--verify", reference])
        .trim()
        .to_string()
}

/// Commit a file inside a worktree the way an agent's Bash would.
pub fn commit_file(worktree: &Path, file: &str, content: &str) -> String {
    std::fs::write(worktree.join(file), content).unwrap();
    git_cmd(worktree, &["add", "--", file]);
    let mut args = IDENTITY.to_vec();
    args.extend(["commit", "-q", "-m", file]);
    git_cmd(worktree, &args);
    rev_parse(worktree, "HEAD")
}
