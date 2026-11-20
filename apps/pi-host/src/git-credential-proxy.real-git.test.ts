import { execFile, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createGitCredentialProxy } from "./git-credential-proxy.js";

/**
 * Real git through the proxy, against `git http-backend` standing in for
 * GitHub. What a hand-written request cannot show is how git itself talks:
 * which requests it sends first, and what it does with the answers.
 */
const TOKEN = "fixture-token-not-a-real-credential";
const INSTALLATION = "00000000-0000-4000-8000-000000000000";
const WORK_BRANCH = "pi-desktop/8b54618f6bc1";

function gitExecPath(): string | null {
  try { return execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim(); } catch { return null; }
}
const execPath = gitExecPath();
const available = execPath !== null && existsSync(join(execPath, "git-http-backend"));

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

const ambient = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
/** Asynchronous on purpose: the proxy and the fixture run on this event loop. */
function git(cwd: string, args: string[], env: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", cwd, "-c", "user.name=PI Test", "-c", "user.email=pi-test@example.invalid", "-c", "commit.gpgsign=false", ...args],
      { env: { ...ambient, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", ...env }, encoding: "utf8", timeout: 60_000 },
      (error, stdout, stderr) => (error ? reject(new Error(`git ${args[0]} failed: ${stderr}`)) : resolve(stdout.trim())));
  });
}

describe.skipIf(!available)("git credential proxy with real git", () => {
  it("pushes a pack larger than git's post buffer to the work branch", async () => {
    const root = await mkdtemp(join(tmpdir(), "git-proxy-real-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const source = join(root, "source");
    await mkdir(source);
    await git(source, ["init", "-q", "-b", "main"]);
    await writeFile(join(source, "README.md"), "main\n");
    await git(source, ["add", "README.md"]);
    await git(source, ["commit", "-q", "-m", "init"]);
    const bare = join(root, "github", "octo", "repo.git");
    await mkdir(join(root, "github", "octo"), { recursive: true });
    await git(root, ["clone", "-q", "--bare", source, bare]);

    const fixtureUrl = new URL("../../../scripts/e2e/git-http-fixture.mjs", import.meta.url).href;
    const { startGitHttpFixture } = await import(/* @vite-ignore */ fixtureUrl) as {
      startGitHttpFixture(options: { projectRoot: string; repositoryPath: string; token: string }): Promise<{ url: string; requests: Array<{ method: string; path: string }>; close(): Promise<void> }>;
    };
    const fixture = await startGitHttpFixture({ projectRoot: join(root, "github"), repositoryPath: "/octo/repo.git", token: TOKEN });
    cleanup.push(() => fixture.close());
    const proxy = createGitCredentialProxy({ upstream: fixture.url });
    await proxy.start();
    cleanup.push(() => proxy.close());
    proxy.setToken(INSTALLATION, TOKEN);
    const base = proxy.register({ installationId: INSTALLATION, sessionId: "session-1", repository: { owner: "octo", name: "repo" }, workBranch: WORK_BRANCH });
    // The rewrite reaches git the way host-core and the tool environment send it.
    const rewrite = {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `url.${base}octo/repo.git.insteadOf`,
      GIT_CONFIG_VALUE_0: "https://github.com/octo/repo.git",
    };

    const clone = join(root, "clone");
    await git(root, ["clone", "-q", "--", "https://github.com/octo/repo.git", clone], rewrite);
    await git(clone, ["checkout", "-q", "-b", WORK_BRANCH]);
    // Random bytes do not compress: the pack is well over the 1 MiB post buffer.
    await writeFile(join(clone, "large.bin"), randomBytes(3 * 1024 * 1024));
    await git(clone, ["add", "large.bin"]);
    await git(clone, ["commit", "-q", "-m", "large"]);
    const head = await git(clone, ["rev-parse", "HEAD"]);

    await git(clone, ["push", "-q", "origin", `${WORK_BRANCH}:${WORK_BRANCH}`], rewrite);
    expect(await git(bare, ["rev-parse", "--verify", `refs/heads/${WORK_BRANCH}`])).toBe(head);
    // The same large pack aimed at another branch is still refused whole.
    const before = await git(bare, ["rev-parse", "--verify", "refs/heads/main"]);
    await expect(git(clone, ["push", "-q", "origin", `${WORK_BRANCH}:main`], rewrite)).rejects.toThrow(/403/);
    expect(await git(bare, ["rev-parse", "--verify", "refs/heads/main"])).toBe(before);
  }, 120_000);
});
