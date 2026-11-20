#!/usr/bin/env node
/**
 * Remote git workspaces, end to end, with no real GitHub and no real token:
 *
 *   desktop boot API -> loopback RACP -> pi-host operations -> real host-core
 *   -> git -> pi-host credential proxy -> a local `git http-backend` fixture
 *
 * Scenarios `E2E-REMOTE-repo-session-prepares-isolated-worktree` and
 * `E2E-REMOTE-git-proxy-rejects-foreign-ref`
 * (docs/spec/06-delivery/e2e/live-and-remote.md).
 *
 * Usage: PI_HOST_CORE_BINARY=<host-core binary> node scripts/e2e-remote-workspace-git.mjs
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

register(new URL("../apps/desktop/test/helpers/ts-import-hooks.mjs", import.meta.url));
const { HostProcess, createHostSessionPort } = await import("../packages/host-runtime/dist/index.js");
const { AgentHost } = await import("../packages/agent-host/dist/index.js");
const { bindRacpWebSocket, RacpServer, MemoryCredentialStore, DeviceTokenAuthenticator, hashToken, newDeviceToken } = await import("../packages/racp/dist/index.js");
const { createHostOperations } = await import("../apps/pi-host/dist/host-operations.js");
const { createGitCredentialProxy } = await import("../apps/pi-host/dist/git-credential-proxy.js");
const { workspaceGitWorkBranch } = await import("../apps/pi-host/dist/workspace-git.js");
const { createRemoteHostsBoot } = await import("../apps/desktop/electron/main/bootstrap/remote-hosts.ts");
const { createBackendRouter } = await import("../apps/desktop/electron/main/remote/backend-router.ts");
const { startGitHttpFixture } = await import("./e2e/git-http-fixture.mjs");

assert.ok(process.env.PI_HOST_CORE_BINARY, "PI_HOST_CORE_BINARY must name the current candidate Rust binary");

const FIXTURE_TOKEN = "e2e-fixture-token-0123456789-not-a-real-credential";
const INSTALLATION = "00000000-0000-4000-8000-000000000000";
const OWNER_TOKEN = newDeviceToken();
const repository = { owner: "octo", name: "repo" };
const HOST = "fixture";

const root = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "remote-workspace-git-"));
const hostDataDir = join(root, "host-data");
const workspacesRoot = join(root, "pi-workspaces");
const remoteRoot = join(root, "github");
const bare = join(remoteRoot, "octo", "repo.git");

// Never inherit configuration that could redirect git in this harness.
const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "user.name=PI E2E", "-c", "user.email=pi-e2e@example.invalid", "-c", "commit.gpgsign=false", ...args],
  { env: { ...gitEnv, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const remoteHead = (branch) => git(bare, "rev-parse", "--verify", `refs/heads/${branch}`);
const remoteHasBranch = (branch) => {
  try { remoteHead(branch); return true; } catch { return false; }
};

let currentStep = "setup";
async function step(name, action) {
  currentStep = name;
  await action();
  console.log(`ok - ${name}`);
}

let fixture; let host; let proxy; let binding; let server; let boot;
const hostLogs = [];
let token = FIXTURE_TOKEN;
const deadline = setTimeout(() => { console.error(`FAILED - ${currentStep}: remote workspace git acceptance exceeded 180s`); process.exit(1); }, 180_000);

async function pollJob(jobId) {
  const phases = [];
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const job = await boot.workspaceGit.job(HOST, jobId);
    if (phases.at(-1) !== job.phase) phases.push(job.phase);
    if (job.state !== "running") return { job, phases };
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`job ${jobId} did not finish; phases ${phases.join(",")}`);
}

async function prepare(sessionId, baseBranch, extra = {}) {
  const { jobId } = await boot.workspaceGit.prepare(HOST, { sessionId, repository, baseBranch, ...extra });
  const { job, phases } = await pollJob(jobId);
  assert.equal(job.state, "succeeded", `prepare ${sessionId}: ${JSON.stringify(job.error)} after ${phases.join(",")}`);
  return { worktree: job.worktree, phases };
}

let shell;
let toolCall = 0;
/** Run one Bash command in a session's worktree through the remote tool path. */
async function bash(sessionId, path, command) {
  toolCall += 1;
  const result = await boot.executeWorkspaceTool({
    hostKey: HOST, path, sessionId, turnId: "e2e-turn", toolCallId: `e2e-call-${toolCall}`, toolName: "Bash",
    args: { command: `${command}\necho "exit=$?"` }, timeoutMs: 60_000,
    expectedCommandShellId: shell.id, expectedCommandShellDialect: shell.dialect,
  });
  const output = `${result.content?.stdout ?? ""}${result.content?.stderr ?? ""}`;
  const exit = /exit=(\d+)\s*$/.exec(output.trim());
  assert.ok(exit, `Bash produced no exit marker: ${JSON.stringify(result)}`);
  return { exitCode: Number(exit[1]), output };
}

async function filesUnder(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await filesUnder(path));
    else if (entry.isFile()) found.push(path);
  }
  return found;
}

try {
  // "GitHub": one private repository with two branches.
  const source = join(root, "source");
  await mkdir(source, { recursive: true });
  git(source, "init", "-q", "-b", "main");
  await writeFile(join(source, "README.md"), "main\n");
  git(source, "add", "README.md");
  git(source, "commit", "-q", "-m", "init");
  git(source, "checkout", "-q", "-b", "develop");
  await writeFile(join(source, "develop.txt"), "develop\n");
  git(source, "add", "develop.txt");
  git(source, "commit", "-q", "-m", "develop");
  git(source, "checkout", "-q", "main");
  await mkdir(join(remoteRoot, "octo"), { recursive: true });
  git(root, "clone", "-q", "--bare", source, bare);
  fixture = await startGitHttpFixture({ projectRoot: remoteRoot, repositoryPath: "/octo/repo.git", token: FIXTURE_TOKEN });
  const mainHead = remoteHead("main");
  const developHead = remoteHead("develop");

  // The paired host: real host-core, pi-host's operations and proxy, RACP on loopback.
  host = new HostProcess({ binaryPath: resolve(process.env.PI_HOST_CORE_BINARY), dataDir: hostDataDir, onStderr: (text) => hostLogs.push(String(text)) });
  await host.handshake();
  // The only way to point the proxy anywhere but GitHub: its constructor.
  proxy = createGitCredentialProxy({ upstream: fixture.url, log: (level, message, data) => hostLogs.push(JSON.stringify({ level, message, data })) });
  await proxy.start();
  const agentHost = new AgentHost({ sessions: createHostSessionPort(() => host),
    runtime: { async prompt() { throw new Error("no remote model"); }, async stop() { return { requested: false }; }, async abort() {}, async respondInput() {} },
    approvals: { async resolveTool() { throw new Error("no remote approval"); }, async resolveContract() { throw new Error("no remote contract"); }, async listPendingTools() { return []; } },
  });
  const credentials = new MemoryCredentialStore();
  await credentials.saveDevice({ deviceId: "fixture-owner", label: "Fixture", roles: ["owner"], tokenHash: hashToken(OWNER_TOKEN), createdAt: new Date().toISOString() });
  const authenticator = new DeviceTokenAuthenticator(credentials);
  const operations = createHostOperations({
    getHost: () => host, runtime: { isBusy: () => false, async compact() { throw new Error("no remote model"); } },
    browseRoot: root, dataDir: hostDataDir, workspacesRoot, gitProxy: proxy,
  });
  server = new RacpServer({ agentHost, operations, authenticator, hostId: "git-host", serverVersion: "fixture", log: (level, message, data) => hostLogs.push(JSON.stringify({ level, message, data })) });
  binding = await bindRacpWebSocket({ server, authenticator, host: "127.0.0.1", port: 0, log: () => {} });
  const desktopLogs = [];
  boot = createRemoteHostsBoot({
    dataDir: join(root, "desktop"), router: createBackendRouter(), clientInfo: { name: "workspace-git-fixture", version: "fixture" }, emit: () => {},
    encryption: { isAvailable: () => true, encryptString: (value) => Buffer.from(value), decryptString: (value) => value.toString() },
    getInstallationId: async () => INSTALLATION,
    log: (level, message, data) => desktopLogs.push(JSON.stringify({ level, message, data })),
  });
  await mkdir(join(root, "desktop"), { recursive: true });

  let a; let b;
  const workA = workspaceGitWorkBranch(INSTALLATION, "session-a");
  const workB = workspaceGitWorkBranch(INSTALLATION, "session-b");

  await step("1 connect and deliver the credential", async () => {
    boot.workspaceGit.setCredentialProvider(async () => token);
    assert.equal((await boot.addHost({ hostKey: HOST, label: "Fixture", url: `ws://127.0.0.1:${binding.address.port}/v1/racp/ws`, deviceToken: OWNER_TOKEN })).connected, true);
    await boot.workspaceGit.refreshCredential();
    assert.equal(await boot.workspaceGit.supported(HOST), true);
    shell = await boot.workspaceCommandShell(HOST);
    const where = await boot.workspaceGit.repository(HOST, repository);
    assert.deepEqual(where, { path: join(workspacesRoot, "repos/github.com/octo/repo"), cloned: false });
    assert.equal(existsSync(workspacesRoot), false, "asking where a repository lives creates nothing");
    assert.equal(fixture.requests.length, 0);
  });

  await step("2 prepare session A from main (E2E-REMOTE-repo-session-prepares-isolated-worktree)", async () => {
    const prepared = await prepare("session-a", "main");
    a = prepared.worktree;
    assert.ok(prepared.phases.includes("cloning"), prepared.phases.join(","));
    assert.equal(a.workBranch, workA);
    assert.equal(a.baseCommit, mainHead);
    assert.equal(a.mainPath, join(workspacesRoot, "repos/github.com/octo/repo"));
    assert.ok(a.path.startsWith(join(workspacesRoot, "worktrees/github.com/octo/repo/")));
    assert.equal(git(a.path, "rev-parse", "HEAD"), mainHead);
    assert.equal(git(a.path, "symbolic-ref", "--short", "HEAD"), workA);
    assert.ok(existsSync(join(a.mainPath, ".git")), "the main checkout exists");
    // The stored remote is the GitHub URL: no proxy address, no credential.
    assert.equal(git(a.mainPath, "config", "--get", "remote.origin.url"), "https://github.com/octo/repo.git");
    assert.deepEqual(await boot.workspaceGit.repository(HOST, repository), { path: a.mainPath, cloned: true });
    assert.ok(fixture.requests.length > 0 && fixture.requests.every((request) => request.authorized), "the clone went through the proxy with the credential");
    // A retry returns the same worktree instead of a second one.
    assert.deepEqual((await prepare("session-a", "develop")).worktree, a);
  });

  await step("3 prepare session B from develop", async () => {
    const seen = fixture.requests.length;
    const prepared = await prepare("session-b", "develop");
    b = prepared.worktree;
    // The repository is cloned once; a later session only fetches.
    assert.equal(prepared.phases.includes("cloning"), false, prepared.phases.join(","));
    assert.ok(fixture.requests.length > seen, "the fetch reached the fixture");
    assert.equal(b.workBranch, workB);
    assert.notEqual(b.path, a.path);
    assert.equal(git(b.path, "rev-parse", "HEAD"), developHead);
    assert.ok(existsSync(join(b.path, "develop.txt")));
    assert.equal(git(a.path, "rev-parse", "HEAD"), mainHead, "session A is untouched");
    assert.equal(existsSync(join(a.path, "develop.txt")), false);
  });

  let committed;
  await step("4 the agent's Bash commits and pushes its work branch", async () => {
    const commit = await bash("session-a", a.path, "printf 'work\\n' > work.txt && git add work.txt && git -c user.name='PI E2E' -c user.email=pi-e2e@example.invalid commit -q -m work");
    assert.equal(commit.exitCode, 0, commit.output);
    committed = git(a.path, "rev-parse", "HEAD");
    assert.equal(remoteHasBranch(workA), false);

    // A forked session starts from the parent's commit while it is still unpushed.
    const fork = await prepare("session-c", "main", { fromSessionId: "session-a" });
    assert.equal(fork.worktree.baseCommit, committed);
    assert.equal(git(fork.worktree.path, "rev-parse", "HEAD"), committed);
    assert.equal(git(fork.worktree.path, "symbolic-ref", "--short", "HEAD"), workspaceGitWorkBranch(INSTALLATION, "session-c"));
    assert.equal(fork.worktree.baseBranch, "main");

    const pushed = await bash("session-a", a.path, "git push 2>&1");
    assert.equal(pushed.exitCode, 0, pushed.output);
    assert.equal(remoteHead(workA), committed, "the fixture's repository has the work branch");
    assert.equal(remoteHead("main"), mainHead);
    // The same push as a host job is a no-op that reports the remote head.
    const { jobId } = await boot.workspaceGit.push(HOST, "session-a");
    const { job } = await pollJob(jobId);
    assert.deepEqual([job.state, job.pushed], ["succeeded", { branch: workA, remoteHead: committed }]);
  });

  await step("5 a push to another ref is refused by the proxy (E2E-REMOTE-git-proxy-rejects-foreign-ref)", async () => {
    const receivePacks = () => fixture.requests.filter((request) => request.method === "POST" && request.path.endsWith("/git-receive-pack")).length;
    const before = receivePacks();
    for (const command of ["git push origin HEAD:main 2>&1", "git push origin HEAD:refs/heads/other 2>&1", "git push origin :develop 2>&1", `git push origin HEAD:${workA} HEAD:refs/tags/v1 2>&1`]) {
      const foreign = await bash("session-a", a.path, command);
      assert.notEqual(foreign.exitCode, 0, `${command}: ${foreign.output}`);
      assert.match(foreign.output, /403/, command);
    }
    assert.equal(receivePacks(), before, "no refused push reached the fixture");
    assert.equal(remoteHead("main"), mainHead, "main is unchanged");
    assert.equal(remoteHead("develop"), developHead, "develop still exists");
    assert.equal(remoteHasBranch("other"), false);
    assert.equal(git(bare, "tag", "--list"), "");
  });

  await step("6 status, guarded removal, and list", async () => {
    const status = await boot.workspaceGit.status(HOST, "session-a");
    assert.deepEqual([status.unpushedCommits, status.pushedOnce, status.uncommittedFiles, status.ahead, status.behind], [0, true, 0, 0, 0]);
    await writeFile(join(a.path, "scratch.txt"), "uncommitted\n");
    assert.deepEqual(await boot.workspaceGit.remove(HOST, "session-a", false), { removed: false, uncommittedFiles: 1, unpushedCommits: 0 });
    assert.ok(existsSync(join(a.path, "scratch.txt")));
    assert.deepEqual(await boot.workspaceGit.remove(HOST, "session-a", true), { removed: true, uncommittedFiles: 1, unpushedCommits: 0 });
    assert.equal(existsSync(a.path), false);
    // The fork has nothing unpushed any more (its commit is on the remote): no force needed.
    assert.deepEqual(await boot.workspaceGit.remove(HOST, "session-c", false), { removed: true, uncommittedFiles: 0, unpushedCommits: 0 });
    const listed = await boot.workspaceGit.list(HOST);
    assert.deepEqual(listed.map((worktree) => worktree.sessionId), ["session-b"]);
    assert.equal(remoteHead(workA), committed, "removing a worktree never deletes the remote branch");
    assert.ok(existsSync(join(b.path, "develop.txt")));
  });

  await step("7 without the credential, git fails closed with an authentication error", async () => {
    const fetched = await bash("session-b", b.path, "git fetch 2>&1");
    assert.equal(fetched.exitCode, 0, fetched.output);
    token = null;
    await boot.workspaceGit.refreshCredential();
    const seen = fixture.requests.length;
    const started = Date.now();
    const refused = await bash("session-b", b.path, "git fetch 2>&1");
    assert.ok(Date.now() - started < 30_000, "the fetch failed promptly");
    assert.notEqual(refused.exitCode, 0, refused.output);
    assert.match(refused.output, /terminal prompts disabled|Authentication failed|could not read Username|error: 401/i, refused.output);
    assert.equal(fixture.requests.length, seen, "nothing reached the fixture without a credential");
    // The host's own push fails the same way, as a typed job error.
    const { jobId } = await boot.workspaceGit.push(HOST, "session-b");
    const { job } = await pollJob(jobId);
    assert.deepEqual([job.state, job.error?.code], ["failed", "WORKSPACE_GIT_AUTH_REQUIRED"]);
    assert.equal(fixture.requests.length, seen);
  });

  await step("8 the token is nowhere on the host's disk, in a URL, or in a log", async () => {
    const basic = Buffer.from(`x-access-token:${FIXTURE_TOKEN}`).toString("base64");
    const needles = [Buffer.from(FIXTURE_TOKEN), Buffer.from(basic)];
    const files = [...await filesUnder(hostDataDir), ...await filesUnder(workspacesRoot)];
    assert.ok(files.length > 20, "the scan covered the data directory and the workspaces");
    for (const file of files) {
      const content = await readFile(file);
      for (const needle of needles) assert.equal(content.includes(needle), false, `${file} contains the token`);
    }
    for (const request of fixture.requests) {
      assert.equal(`${request.path}?${request.query}`.includes(FIXTURE_TOKEN), false, "the token was never part of a URL");
    }
    const logs = [...hostLogs, ...desktopLogs].join("\n");
    assert.equal(logs.includes(FIXTURE_TOKEN), false, "no log line carries the token");
    assert.equal(logs.includes(basic), false);
    assert.equal(/\/[0-9a-f]{64}\//.test(logs), false, "no log line carries a proxy handle");
    // The worktree's git configuration names neither the proxy nor a credential.
    const config = await readFile(join(workspacesRoot, "repos/github.com/octo/repo/.git/config"), "utf8");
    assert.equal(/127\.0\.0\.1|insteadOf|credential/i.test(config), false, config);
  });

  await boot.removeHost(HOST);
  console.log("PASS remote git worktrees: clone, isolated worktrees, fork, proxied push, foreign-ref refusal, guarded removal, fail-closed without credential, no token at rest");
} catch (error) {
  console.error(`FAILED - ${currentStep}`);
  console.error(error);
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  await boot?.closeAll().catch(() => undefined);
  server?.close();
  await binding?.close().catch(() => undefined);
  await proxy?.close().catch(() => undefined);
  await host?.dispose().catch(() => undefined);
  await fixture?.close().catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}
