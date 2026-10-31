#!/usr/bin/env node
/**
 * Live-model E2E for isolated sessions (ADR 0329,
 * E2E-WORKTREE-isolated-session-lifecycle), protocol level: a real host-core
 * and agent runtime with a real model, a throwaway git project, and a
 * throwaway data directory. Nothing outside the temp directory is touched.
 *
 * Env (no defaults: this sends real prompts with a real key), either
 *  PI_DESKTOP_TEST_API_KEY, PI_DESKTOP_TEST_BASE_URL (OpenAI-compatible) and
 *  PI_DESKTOP_TEST_MODEL, or PI_DESKTOP_TEST_PROVIDER_DATA_DIR: a *copy* of a
 *  PI-Desktop data directory whose default provider and model are used (the
 *  copy may be migrated). Optional: PI_DESKTOP_HOST_BIN, PI_DESKTOP_KEEP_TEMP.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesktopAgentRuntime } from "../packages/agent-runtime/dist/runtime.js";
import { PROTOCOL_VERSION } from "../packages/shared/dist/protocol.js";
import { Host, resolveHostBinary } from "./e2e/host.mjs";

/** The default provider of a copied data directory; the key stays in memory. */
async function providerFromDataDir(dir) {
  const source = new Host(resolveHostBinary(), dir, { quiet: true });
  await source.start(PROTOCOL_VERSION);
  try {
    const settings = await source.call("settings.get");
    const values = settings.settings ?? settings;
    const { providers } = await source.call("providers.list");
    const provider =
      providers.find((entry) => entry.id === values.defaultProviderId) ?? providers.find((entry) => entry.enabled);
    if (!provider) throw new Error("the data directory has no provider");
    const { value } = await source.call("providers.getSecret", { id: provider.id });
    if (!value) throw new Error(`provider ${provider.name} has no API key`);
    return {
      name: provider.name,
      baseUrl: provider.baseUrl,
      model: provider.id === values.defaultProviderId && values.defaultModelId ? values.defaultModelId : provider.defaultModelId,
      apiKey: value,
      apiStyle: provider.apiStyle ?? "chat_completions",
      protocol: provider.protocol ?? "openai_compatible",
      headers: provider.headers,
    };
  } finally {
    await source.stop();
  }
}

let live;
if (process.env.PI_DESKTOP_TEST_PROVIDER_DATA_DIR?.trim()) {
  live = await providerFromDataDir(process.env.PI_DESKTOP_TEST_PROVIDER_DATA_DIR.trim());
} else {
  const REQUIRED_ENV = ["PI_DESKTOP_TEST_API_KEY", "PI_DESKTOP_TEST_BASE_URL", "PI_DESKTOP_TEST_MODEL"];
  const missingEnv = REQUIRED_ENV.filter((name) => !process.env[name]?.trim());
  if (missingEnv.length > 0) {
    console.error(`missing required environment variables: ${missingEnv.join(", ")}`);
    process.exit(1);
  }
  live = {
    name: "Live",
    baseUrl: process.env.PI_DESKTOP_TEST_BASE_URL,
    model: process.env.PI_DESKTOP_TEST_MODEL,
    apiKey: process.env.PI_DESKTOP_TEST_API_KEY,
    apiStyle: "chat_completions",
    protocol: "openai_compatible",
  };
}
console.log(`model: ${live.name} / ${live.model} (${live.apiStyle})`);
// The host inherits this process's environment and the live model runs Bash
// with it, so the key must not be in it (`env` would print it).
for (const name of Object.keys(process.env)) {
  if (name.startsWith("PI_DESKTOP_TEST_")) delete process.env[name];
}

const temp = mkdtempSync(join(tmpdir(), "pi-worktree-live-"));
const dataDir = join(temp, "data");
const project = join(temp, "project");
mkdirSync(dataDir);
mkdirSync(project);

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" });
git(project, "init", "-q", "-b", "main");
git(project, "config", "user.email", "e2e@example.invalid");
git(project, "config", "user.name", "E2E");
writeFileSync(join(project, "f.txt"), "line one\nline two\n");
writeFileSync(join(project, ".gitignore"), ".env\n");
writeFileSync(join(project, ".worktreeinclude"), ".env\n");
git(project, "add", "-A");
git(project, "commit", "-q", "-m", "base");
writeFileSync(join(project, ".env"), "SECRET=local\n");

const results = [];
function record(id, ok, detail = "") {
  results.push({ id, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${id}${detail ? ` — ${detail}` : ""}`);
}
const read = (path) => (existsSync(path) ? readFileSync(path, "utf8") : null);
const firstLine = (path) => read(path)?.split("\n")[0]?.trim();
const projectClean = () => git(project, "status", "--porcelain") === "";

const host = new Host(resolveHostBinary(), dataDir, { quiet: true });
const runtimes = new Map();
let provider;

// The platform's default command shell, as host-core resolves it: Windows
// PowerShell on Windows (the `bash` id does not exist there), bash elsewhere.
const windows = process.platform === "win32";
const commandShell = windows
  ? { id: "windows-powershell", label: "Windows PowerShell", dialect: "powershell", available: true, isDefault: true }
  : { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true };
const portCommand = windows
  ? 'Set-Content -NoNewline -Path port.txt -Value "$env:PI_PORT|$env:PI_WORKTREE_ROOT"'
  : "printf '%s|%s' \"$PI_PORT\" \"$PI_WORKTREE_ROOT\" > port.txt";

const writer = {
  name: "writer",
  description: "Creates or edits files exactly as instructed.",
  tools: ["Read", "Write", "Edit"],
  prompt: "Do exactly the file change you are asked to do, then reply DONE.",
  source: "user",
};

async function isolatedSession(title) {
  const created = await host.call("session.create", {
    title,
    mode: "agent",
    projectPath: project,
    isolated: true,
  }, 120_000);
  const sessionId = created.session.id;
  const { path } = await host.call("worktree.location", { sessionId });
  return { sessionId, title, root: path, worktree: created.worktree };
}

async function prompt(session, text, { subagents } = {}) {
  let runtime = runtimes.get(session.sessionId);
  const turn = await host.call("session.beginTurn", { sessionId: session.sessionId });
  const userMessageId = randomUUID();
  await host.call("session.appendMessage", {
    sessionId: session.sessionId,
    turnId: turn.turnId,
    message: { id: userMessageId, role: "user", content: text, createdAt: new Date().toISOString(), status: "complete" },
  });
  const events = [];
  if (!runtime) {
    runtime = new DesktopAgentRuntime({
      host,
      sessionId: session.sessionId,
      turnId: turn.turnId,
      mode: "agent",
      projectPath: project,
      workspaceRoot: session.root,
      subagents,
      provider: {
        id: provider.provider.id,
        name: live.name,
        baseUrl: live.baseUrl,
        modelId: live.model,
        apiKey: live.apiKey,
        authKind: "api_key_and_base_url",
        apiStyle: live.apiStyle,
        ...(live.headers ? { headers: live.headers } : {}),
        supportsReasoning: false,
        supportedThinkingLevels: ["off"],
      },
      thinkingLevel: "off",
      commandShell,
      onEvent: (e) => session.events?.push(e.event),
    });
    runtimes.set(session.sessionId, runtime);
  }
  session.events = events;
  let status = "completed";
  try {
    await runtime.prompt(text, userMessageId, turn.turnId);
    if (events.some((event) => event.type === "error")) status = "error";
  } catch (error) {
    status = "error";
    console.error(`prompt failed in ${session.sessionId}:`, error instanceof Error ? error.message : error);
  } finally {
    for (const event of events) {
      if (event.type === "message_end" && event.message.role === "assistant") {
        await host.call("session.appendMessage", { sessionId: session.sessionId, turnId: turn.turnId, message: event.message }).catch(() => {});
      }
    }
    await host.call("session.endTurn", { turnId: turn.turnId, status, createNotification: false });
    const tools = events.filter((event) => event.type === "tool_start").map((event) => event.toolName ?? event.name);
    const errors = events.filter((event) => event.type === "error").map((event) => event.error?.code ?? event.error?.message ?? "error");
    const reply = events.findLast((event) => event.type === "message_end" && event.message.role === "assistant")?.message.content;
    console.log(`  [${session.title}] ${status}; events=${events.length}; tools=${tools.join(",") || "-"}; errors=${errors.join(",") || "-"}; reply=${String(reply ?? "").slice(0, 120).replace(/\s+/g, " ")}`);
  }
  return events;
}

async function merge(session) {
  const { preview } = await host.call("worktree.preview", { sessionId: session.sessionId }, 120_000);
  return host.call("worktree.merge", { sessionId: session.sessionId, previewToken: preview.previewToken }, 120_000);
}

try {
  await host.start(PROTOCOL_VERSION);
  provider = await host.call("providers.create", {
    name: live.name,
    baseUrl: live.baseUrl,
    defaultModelId: live.model,
    secretValue: live.apiKey,
    type: "openai_compatible",
    protocol: live.protocol,
    apiStyle: live.apiStyle,
    authKind: "api_key_and_base_url",
  });

  // Throwaway profile: tools run without approval cards (session.create does
  // not accept a permission mode of its own).
  await host.call("settings.set", { defaultPermissionMode: "auto" });

  const probe = await host.call("worktree.probe", { projectPath: project });
  record("probe-git-project", probe.available === true && probe.uncommittedChanges === false);

  // 1. Two isolated sessions edit the same file at the same time.
  const a = await isolatedSession("Session A");
  const b = await isolatedSession("Session B");
  record("worktrees-outside-project", !a.root.startsWith(project) && !b.root.startsWith(project) && a.root !== b.root);
  record("include-file-copied", read(join(a.root, ".env")) === "SECRET=local\n" && read(join(b.root, ".env")) === "SECRET=local\n");
  const task = (letter) =>
    `In the current workspace: 1) Use Edit or Write so that the first line of f.txt is exactly "${letter}" ` +
    `(keep the second line). 2) Create ${letter.toLowerCase()}.txt containing exactly "from-${letter.toLowerCase()}". ` +
    `3) Run this Bash command: ${portCommand} . Then reply DONE.`;
  await Promise.all([prompt(a, task("A")), prompt(b, task("B"))]);
  record("parallel-edits-isolated",
    firstLine(join(a.root, "f.txt")) === "A" && firstLine(join(b.root, "f.txt")) === "B" &&
      read(join(a.root, "a.txt"))?.trim() === "from-a" && read(join(b.root, "b.txt"))?.trim() === "from-b" &&
      !existsSync(join(a.root, "b.txt")) && !existsSync(join(b.root, "a.txt")),
    `A=${firstLine(join(a.root, "f.txt"))} B=${firstLine(join(b.root, "f.txt"))}`);
  record("project-untouched", projectClean() && firstLine(join(project, "f.txt")) === "line one");
  const [portA, rootA] = (read(join(a.root, "port.txt")) ?? "").split("|");
  const [portB] = (read(join(b.root, "port.txt")) ?? "").split("|");
  record("distinct-ports-and-root", Boolean(portA) && Boolean(portB) && portA !== portB && rootA === a.root,
    `A=${portA} B=${portB}`);

  // 2. Merge A, then B conflicts on the same line.
  const mergedA = await merge(a);
  record("merge-a", mergedA.outcome?.result === "merged" && firstLine(join(project, "f.txt")) === "A" &&
    read(join(project, "a.txt"))?.trim() === "from-a");
  const { counts } = await host.call("worktree.behindAll", {});
  record("behind-marker-after-merge", counts[b.sessionId] >= 1 && counts[a.sessionId] === 0, JSON.stringify(counts));
  let conflict;
  try {
    await merge(b);
  } catch (error) {
    conflict = error;
  }
  record("merge-b-conflicts-in-worktree",
    conflict?.errorCode === "WORKTREE_CONFLICT" && projectClean() && firstLine(join(project, "f.txt")) === "A" &&
      !existsSync(join(project, ".git", "MERGE_HEAD")),
    conflict?.errorCode ?? "no conflict");

  // 3. The agent resolves the conflict in its worktree; the merge lands.
  // Both sessions wrote port.txt too, so it conflicts alongside f.txt.
  const conflictFiles = conflict?.rpc?.data?.files ?? [];
  record("conflict-lists-files", conflictFiles.includes("f.txt") && conflictFiles.includes("port.txt"), conflictFiles.join(","));
  await prompt(b,
    "The workspace has unresolved git merge conflicts in: " + conflictFiles.join(", ") + ". Resolve all of them: " +
      'f.txt must be exactly two lines, "AB" and "line two"; for every other conflicted file keep this session\'s ' +
      "own version. Remove every conflict marker. Do not run git commands. Then reply DONE.");
  let mergedB;
  try {
    mergedB = await merge(b);
  } catch (error) {
    console.error(error.message);
  }
  record("merge-b-after-resolution", mergedB?.outcome?.result === "merged" && firstLine(join(project, "f.txt")) === "AB" &&
    read(join(project, "b.txt"))?.trim() === "from-b" && projectClean());

  // 3b. Session A still has its pre-resolution code; "Sync from project"
  // brings B's resolution in without touching the project.
  const { commits: behindA } = await host.call("worktree.behind", { sessionId: a.sessionId });
  const syncA = await host.call("worktree.sync", { sessionId: a.sessionId }, 120_000);
  record("sync-brings-resolution-into-a",
    behindA > 0 && syncA.outcome?.result === "synced" && firstLine(join(a.root, "f.txt")) === "AB" && projectClean(),
    `behind=${behindA} A=${firstLine(join(a.root, "f.txt"))}`);

  // 4. Two writing subagents in parallel inside one isolated session.
  const c = await isolatedSession("Session C");
  await prompt(c,
    "Use the Task tool to start two `writer` subagents in parallel (two Task calls in one message). " +
      'The first creates c1.txt containing exactly "one"; the second creates c2.txt containing exactly "two". ' +
      "Wait for both reports with TaskWait, then reply DONE. Do not create the files yourself.",
    { subagents: [writer] });
  // Project plus the three session worktrees; no subagent worktree is left.
  const worktreeCount = git(project, "worktree", "list").split("\n").filter(Boolean).length;
  const delegateRows = { length: worktreeCount - 4 };
  record("subagents-merged-back",
    read(join(c.root, "c1.txt"))?.trim() === "one" && read(join(c.root, "c2.txt"))?.trim() === "two" && delegateRows.length === 0,
    `c1=${read(join(c.root, "c1.txt"))?.trim()} c2=${read(join(c.root, "c2.txt"))?.trim()} delegates=${delegateRows.length}`);

  // 5. Delete with unmerged work discards worktree and branch only.
  const { pending } = await host.call("worktree.pendingWork", { sessionId: c.sessionId });
  record("pending-work-reported", pending.unmergedCommits > 0 || pending.uncommittedChanges === true);
  const branchC = c.worktree?.worktree?.branch;
  await runtimes.get(c.sessionId)?.dispose();
  runtimes.delete(c.sessionId);
  await host.call("session.delete", { id: c.sessionId }, 120_000);
  record("delete-discards-worktree", !existsSync(c.root) && !git(project, "branch", "--list").includes(branchC ?? "pi-desktop/none") &&
    !existsSync(join(project, "c1.txt")));

  // 6. Restart keeps an isolated session in its worktree.
  for (const runtime of runtimes.values()) await runtime.dispose();
  runtimes.clear();
  await host.restart(PROTOCOL_VERSION);
  const { path: afterRestart } = await host.call("worktree.location", { sessionId: a.sessionId });
  record("restart-keeps-worktree", afterRestart === a.root && existsSync(afterRestart));
} catch (error) {
  console.error(error instanceof Error ? error.stack : error);
  record("harness", false, error instanceof Error ? error.message : String(error));
} finally {
  for (const runtime of runtimes.values()) await runtime.dispose().catch(() => {});
  await host.stop().catch(() => {});
  if (process.env.PI_DESKTOP_KEEP_TEMP) {
    console.log(`kept ${temp} (its data directory holds the provider key; delete it when done)`);
  }
  else rmSync(temp, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.ok);
console.log(`\nSummary: ${results.length - failed.length} / ${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
