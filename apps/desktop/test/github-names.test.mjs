/**
 * Contract test for the owner, repository, and branch name rules the GitHub
 * connector applies before a name becomes part of a request (ADR
 * github-connector).
 *
 * The rules have to accept every name GitHub can return from a listing —
 * otherwise a repository or branch the user just picked is refused by the
 * next call — and still refuse anything that could change which resource a
 * request addresses. The host git capability applies the same rules before a
 * name reaches git.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  isGitBranchName,
  isGitHubOwner,
  isGitHubRepositoryName,
} from "../electron/main/github/names.ts";

test("owners are 1 to 39 letters, digits, hyphens, or underscores", () => {
  for (const owner of ["octocat", "octo-org", "mona_acme", "a", "A1", "_bot", "o".repeat(39)]) {
    assert.equal(isGitHubOwner(owner), true, owner);
  }
  for (const owner of [
    "", "-octo", "octo-", "octo/org", "octo.org", "octo org", "..", "o".repeat(40),
    "octo\n", "octo%2f", "öcto", 7, null, undefined,
  ]) {
    assert.equal(isGitHubOwner(owner), false, String(owner));
  }
});

test("repository names are 1 to 100 letters, digits, dots, hyphens, or underscores", () => {
  for (const name of ["hello", "hello.world", "hello-world_2", ".github", "a", "r".repeat(100)]) {
    assert.equal(isGitHubRepositoryName(name), true, name);
  }
  for (const name of [
    "", ".", "..", "a/b", "repo?x=1", "repo#1", "repo name", "repo.git", "r".repeat(101),
    "repo\n", "仓库", 7, null, undefined,
  ]) {
    assert.equal(isGitHubRepositoryName(name), false, String(name));
  }
});

test("branch names follow git's reference-name rules", () => {
  for (const branch of [
    "main", "feature/login", "pi-desktop/abc123", "fix/#123", "release=1.0", "a&b",
    "user+tag", "a@b", "v1.0.x", "功能/登录", "fonctionnalité", "wip!", "50%", "a$b", "(x)",
    "{x}", "a;b", "a,b", "a'b", "a\"b", "a|b", "<x>", "b".repeat(244),
  ]) {
    assert.equal(isGitBranchName(branch), true, branch);
  }
  for (const branch of [
    "", "@", "-x", "/main", "main/", "main.", "main.lock", "a..b", "a//b", "a@{b", "a/.b",
    "a b", "a~b", "a^b", "a:b", "a?b", "a*b", "a[b", "a\\b", "a\tb", "a\nb", "a\u0000b",
    "a\u007fb", "\u001fa", "b".repeat(245), 7, null, undefined,
  ]) {
    assert.equal(isGitBranchName(branch), false, JSON.stringify(branch));
  }
});
