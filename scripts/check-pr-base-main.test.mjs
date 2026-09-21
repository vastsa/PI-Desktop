import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./check-pr-base-main.mjs", import.meta.url));

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function runCheck(cwd, extra = []) {
  try {
    const stdout = execFileSync("node", [script, "--cwd", cwd, ...extra], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    return {
      code: error.status ?? 1,
      stdout: error.stdout?.toString() ?? "",
      stderr: error.stderr?.toString() ?? "",
    };
  }
}

function initRepo() {
  const dir = mkdtempSync(join(tmpdir(), "pr-base-"));
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "dev@example.com"]);
  git(dir, ["config", "user.name", "Dev"]);
  writeFileSync(join(dir, "a.txt"), "a\n");
  git(dir, ["add", "a.txt"]);
  git(dir, ["commit", "-m", "base"]);
  return dir;
}

test("check-pr-base-main accepts a head that already contains main", () => {
  const dir = initRepo();
  try {
    git(dir, ["checkout", "-b", "feat/ok"]);
    writeFileSync(join(dir, "b.txt"), "b\n");
    git(dir, ["add", "b.txt"]);
    git(dir, ["commit", "-m", "feat"]);
    const result = runCheck(dir, ["--base", "main", "--head", "HEAD"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /PR base check passed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("check-pr-base-main rejects a head that is behind main", () => {
  const dir = initRepo();
  try {
    git(dir, ["checkout", "-b", "feat/stale"]);
    writeFileSync(join(dir, "b.txt"), "b\n");
    git(dir, ["add", "b.txt"]);
    git(dir, ["commit", "-m", "feat"]);
    git(dir, ["checkout", "main"]);
    writeFileSync(join(dir, "c.txt"), "c\n");
    git(dir, ["add", "c.txt"]);
    git(dir, ["commit", "-m", "main moved"]);
    git(dir, ["checkout", "feat/stale"]);
    const result = runCheck(dir, ["--base", "main", "--head", "HEAD"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /not an ancestor/);
    assert.match(result.stderr, /behind origin\/main/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("check-pr-base-main accepts a head rebased onto latest main", () => {
  const dir = initRepo();
  try {
    git(dir, ["checkout", "-b", "feat/rebased"]);
    writeFileSync(join(dir, "b.txt"), "b\n");
    git(dir, ["add", "b.txt"]);
    git(dir, ["commit", "-m", "feat"]);
    git(dir, ["checkout", "main"]);
    writeFileSync(join(dir, "c.txt"), "c\n");
    git(dir, ["add", "c.txt"]);
    git(dir, ["commit", "-m", "main moved"]);
    git(dir, ["checkout", "feat/rebased"]);
    git(dir, ["rebase", "main"]);
    const result = runCheck(dir, ["--base", "main", "--head", "HEAD"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /is an ancestor/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
