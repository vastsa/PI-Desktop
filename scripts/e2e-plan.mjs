#!/usr/bin/env node
/**
 * Headless Plan and command-shell acceptance harness.
 *
 * This intentionally speaks only the host JSON-RPC protocol. It does not
 * configure a provider, call a provider, or require network access.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { PROTOCOL_VERSION as SHARED_PROTOCOL_VERSION } from "../packages/shared/dist/protocol.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const PROTOCOL_VERSION = 11;
const PLAN_APPROVAL_TIMEOUT_MS = 30 * 60 * 1000;
const LONG_TIMEOUT_ENABLED = process.env.PI_DESKTOP_E2E_LONG_TIMEOUT === "1";

if (SHARED_PROTOCOL_VERSION !== PROTOCOL_VERSION) {
  throw new Error(
    `shared protocol is ${SHARED_PROTOCOL_VERSION}; Plan acceptance requires protocol v${PROTOCOL_VERSION}`,
  );
}

const results = [];

function record(id, ok, detail = "") {
  results.push({ id, ok, skipped: false, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${id}${detail ? ` - ${detail}` : ""}`);
}

function skip(id, detail) {
  results.push({ id, ok: true, skipped: true, detail });
  console.log(`SKIP ${id} - ${detail}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function shortJson(value, max = 500) {
  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    text = String(value);
  }
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function errorCodeOf(error) {
  return (
    error?.errorCode ??
    error?.data?.errorCode ??
    error?.rpc?.data?.errorCode ??
    error?.code ??
    undefined
  );
}

function errorText(error) {
  const code = errorCodeOf(error);
  const message = error?.message || String(error);
  return code ? `${code}: ${message}` : message;
}

function rpcErrorFromWire(wire, method) {
  const error = new Error(`${method}: ${wire?.message || shortJson(wire)}`);
  error.errorCode = wire?.data?.errorCode;
  error.rpc = wire;
  return error;
}

function failPending(pending, error) {
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
    entry.reject(error);
  }
  pending.clear();
}

function hostBinaryCandidates() {
  const names =
    process.platform === "win32"
      ? ["pi-desktop-host-core.exe", "pi-desktop-host-core"]
      : ["pi-desktop-host-core"];
  const candidates = [];
  const configured = process.env.PI_DESKTOP_HOST_BIN;
  if (configured) {
    const configuredPath = resolve(configured);
    candidates.push(configuredPath);
    if (process.platform === "win32" && !configuredPath.toLowerCase().endsWith(".exe")) {
      candidates.push(`${configuredPath}.exe`);
    }
  }
  for (const name of names) {
    candidates.push(join(root, "target", "debug", name));
    // Cargo target output is commonly shared by the primary checkout and
    // slim worktrees, so also accept the workspace-level target directory.
    candidates.push(join(root, "..", "..", "..", "target", "debug", name));
  }
  return candidates;
}

function resolveHostBinary() {
  const candidates = hostBinaryCandidates();
  const binary = candidates.find((candidate) => existsSync(candidate));
  if (!binary) {
    throw new Error(
      `host binary missing; set PI_DESKTOP_HOST_BIN. Tried: ${candidates.join(", ")}`,
    );
  }
  return resolve(binary);
}

class Host {
  constructor(binary, dataDir) {
    this.binary = binary;
    this.dataDir = dataDir;
    this.child = null;
    this.readline = null;
    this.pending = new Map();
    this.notifications = [];
    this.stderr = "";
    this.exited = false;
    this.exitPromise = Promise.resolve();
  }

  async start() {
    if (this.child) throw new Error("host is already running");
    this.pending = new Map();
    this.notifications = [];
    this.stderr = "";
    this.exited = false;
    const child = spawn(this.binary, [], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, PI_DESKTOP_DATA_DIR: this.dataDir },
    });
    this.child = child;
    this.exitPromise = new Promise((resolveExit) => {
      child.once("exit", (code, signal) => {
        this.exited = true;
        const suffix = this.stderr.trim() ? ` stderr=${this.stderr.trim().slice(-500)}` : "";
        failPending(
          this.pending,
          new Error(`host exited code=${code} signal=${signal || "none"}${suffix}`),
        );
        resolveExit({ code, signal });
      });
    });
    child.on("error", (error) => {
      failPending(this.pending, error);
    });
    child.stderr.on("data", (chunk) => {
      this.stderr += String(chunk);
      if (process.env.DEBUG_HOST) process.stderr.write(chunk);
    });
    this.readline = createInterface({ input: child.stdout });
    this.readline.on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        if (process.env.DEBUG_HOST) console.error(`host non-JSON stdout: ${line}`);
        return;
      }
      if (message.id !== undefined && message.id !== null) {
        const entry = this.pending.get(String(message.id));
        if (!entry) return;
        this.pending.delete(String(message.id));
        clearTimeout(entry.timer);
        if (message.error) entry.reject(rpcErrorFromWire(message.error, entry.method));
        else entry.resolve(message.result);
        return;
      }
      if (message.method) {
        this.notifications.push(message);
        if (this.notifications.length > 2_000) this.notifications.shift();
      }
    });

    const handshake = await this.call(
      "app.handshake",
      { protocolVersion: PROTOCOL_VERSION },
      45_000,
    );
    assert(
      handshake?.protocolVersion === PROTOCOL_VERSION,
      `handshake protocol mismatch: ${shortJson(handshake)}`,
    );
    return handshake;
  }

  call(method, params = {}, timeoutMs = 30_000) {
    if (!this.child || this.exited) {
      return Promise.reject(new Error(`host is not running for ${method}`));
    }
    const id = randomUUID();
    return new Promise((resolveResult, rejectResult) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        rejectResult(new Error(`timeout ${method} after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: resolveResult,
        reject: rejectResult,
        timer,
      });
      try {
        this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        rejectResult(error);
      }
    });
  }

  clearNotifications() {
    this.notifications = [];
  }

  matchingNotifications(method, predicate = () => true) {
    return this.notifications.filter((note) => note.method === method && predicate(note));
  }

  async stop() {
    const child = this.child;
    if (!child) return;
    failPending(this.pending, new Error("host stopped by harness"));
    try {
      child.kill();
    } catch {
      // The exit event below is the authoritative cleanup signal.
    }
    await Promise.race([this.exitPromise, delay(3_000)]);
    if (!this.exited) {
      try {
        child.kill("SIGKILL");
      } catch {
        // Best effort on platforms without SIGKILL semantics.
      }
      await Promise.race([this.exitPromise, delay(3_000)]);
    }
    this.readline?.close();
    this.readline = null;
    this.child = null;
    if (!this.exited) throw new Error("host did not exit during cleanup");
  }

  async restart() {
    await this.stop();
    await this.start();
  }
}

async function withScenario(id, fn, binary, tempRoot) {
  const scenarioRoot = await mkdtemp(join(tempRoot, `${id.toLowerCase()}-`));
  const dataDir = join(scenarioRoot, "data");
  const workspace = join(scenarioRoot, "workspace");
  await mkdir(dataDir, { recursive: true });
  await mkdir(workspace, { recursive: true });
  const host = new Host(binary, dataDir);
  let primaryError = null;
  try {
    await host.start();
    await host.call("workspace.set", { path: workspace });
    return await fn({ id, host, dataDir, workspace, scenarioRoot });
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    let cleanupError = null;
    try {
      await host.stop();
    } catch (error) {
      cleanupError = error;
    }
    try {
      await rm(scenarioRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    } catch (error) {
      cleanupError ||= error;
    }
    if (!primaryError && cleanupError) throw cleanupError;
  }
}

async function expectRpcError(call, expectedCodes) {
  let returned = false;
  let value;
  try {
    value = await call();
    returned = true;
  } catch (error) {
    const code = errorCodeOf(error);
    if (!expectedCodes.includes(code)) {
      throw new Error(
        `expected RPC error ${expectedCodes.join("/")}, got ${errorText(error)}`,
      );
    }
    return code;
  }
  if (returned) {
    throw new Error(`expected RPC error ${expectedCodes.join("/")}, got ${shortJson(value)}`);
  }
}

function toolErrorCode(result) {
  return result?.errorCode || result?.content?.code || result?.content?.errorCode;
}

function assertToolFailure(result, expectedCode) {
  assert(result?.ok === false, `expected tool failure, got ${shortJson(result)}`);
  assert(
    toolErrorCode(result) === expectedCode,
    `expected tool error ${expectedCode}, got ${shortJson(result)}`,
  );
}

function assertToolSuccess(result, toolCallId) {
  assert(result?.ok === true, `expected tool success, got ${shortJson(result)}`);
  assert(result.toolCallId === toolCallId, `tool identity mismatch: ${shortJson(result)}`);
}

async function waitFor(predicate, timeoutMs, label, intervalMs = 25) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(intervalMs);
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function createSession(host, workspace, title, mode = "agent") {
  const response = await host.call("session.create", {
    title,
    mode,
    projectPath: workspace,
  });
  assert(response?.session?.id, `session.create returned no session: ${shortJson(response)}`);
  return response.session;
}

async function configureSession(host, session, mode, permissionMode) {
  const response = await host.call("session.configure", {
    id: session.id,
    mode,
    permissionMode,
  });
  assert(response?.session?.id === session.id, `session.configure failed: ${shortJson(response)}`);
  return response.session;
}

async function beginTurn(host, sessionId) {
  const response = await host.call("session.beginTurn", { sessionId });
  assert(response?.turnId, `session.beginTurn returned no turn: ${shortJson(response)}`);
  return response.turnId;
}

async function endTurn(host, turnId, status = "completed") {
  return host.call("session.endTurn", {
    turnId,
    status,
    createNotification: false,
  });
}

async function enterPlan(host, sessionId, turnId, toolCallId) {
  const response = await host.call("plans.enter", {
    sessionId,
    turnId,
    toolCallId,
    requestedMode: "agent",
  });
  assert(response?.state === "planning", `plans.enter failed: ${shortJson(response)}`);
  return response;
}

async function submitPlan(host, sessionId, turnId, toolCallId, title, markdown, question) {
  const response = await host.call("plans.submit", {
    sessionId,
    turnId,
    toolCallId,
    title,
    markdown,
    question,
  });
  assert(response?.status === "pending", `plans.submit failed: ${shortJson(response)}`);
  assert(response?.proposal?.id, `plans.submit returned no proposal: ${shortJson(response)}`);
  return response.proposal;
}

function resolveParams(proposal, action, targetPermissionMode) {
  const params = {
    proposalId: proposal.id,
    sessionId: proposal.sessionId,
    turnId: proposal.turnId,
    toolCallId: proposal.toolCallId,
    version: proposal.version,
    action,
  };
  if (targetPermissionMode !== undefined) params.targetPermissionMode = targetPermissionMode;
  return params;
}

async function resolvePlan(host, proposal, action, targetPermissionMode) {
  return host.call("plans.resolve", resolveParams(proposal, action, targetPermissionMode));
}

async function verifyArtifact(ctx, proposal, markdown, title, question) {
  const artifact = proposal.artifact;
  assert(artifact, `proposal has no artifact: ${shortJson(proposal)}`);
  assert(
    /^\.pi\/plan\/[^/\\]+\.md$/.test(artifact.relativePath),
    `unsafe/unexpected artifact path: ${artifact.relativePath}`,
  );
  const path = join(ctx.workspace, ...artifact.relativePath.split("/"));
  const bytes = await readFile(path);
  const expectedBytes = Buffer.from(markdown, "utf8");
  assert(bytes.equals(expectedBytes), `artifact bytes changed at ${artifact.relativePath}`);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  assert(artifact.sha256 === sha256, `artifact hash mismatch: ${shortJson(artifact)}`);
  assert(artifact.sizeBytes === bytes.length, `artifact size mismatch: ${shortJson(artifact)}`);
  assert(proposal.markdown === markdown, "proposal Markdown is not byte-identical");
  assert(proposal.plan === markdown, "proposal plan snapshot is not byte-identical");
  assert(proposal.title === title.trim(), `structured title mismatch: ${shortJson(proposal)}`);
  assert(proposal.question === question.trim(), `structured question mismatch: ${shortJson(proposal)}`);
  return { path, bytes, sha256, sizeBytes: bytes.length };
}

function shellDialectForId(id) {
  if (id === "windows-powershell") return "powershell";
  if (id === "cmd") return "cmd";
  if (id === "git-bash" || id === "bash") return "posix";
  return undefined;
}

function effectiveShell(catalog) {
  const shell = catalog?.effective;
  assert(shell?.id && shell.available, `no available effective shell: ${shortJson(catalog)}`);
  assert(
    shellDialectForId(shell.id) === shell.dialect,
    `shell dialect mismatch: ${shortJson(shell)}`,
  );
  return shell;
}

function posixQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function powerShellQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function cmdQuote(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function encodedPowerShellCommand(script) {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${encoded}`;
}

function markerCommand(dialect, path, value = "ran") {
  if (dialect === "posix") return `printf ${posixQuote(value)} > ${posixQuote(path)}`;
  if (dialect === "powershell") {
    return `[IO.File]::WriteAllText(${powerShellQuote(path)}, ${powerShellQuote(value)})`;
  }
  if (dialect === "cmd") return `echo ${value}>${cmdQuote(path)}`;
  throw new Error(`unsupported shell dialect ${dialect}`);
}

function planBashCommand(dialect, path) {
  if (dialect === "posix") {
    return `${markerCommand(dialect, path, "plan-auto")}; printf 'plan-auto'`;
  }
  if (dialect === "powershell") {
    return `${markerCommand(dialect, path, "plan-auto")}; [Console]::Out.Write('plan-auto')`;
  }
  if (dialect === "cmd") return `${markerCommand(dialect, path, "plan-auto")} & echo plan-auto`;
  throw new Error(`unsupported shell dialect ${dialect}`);
}

function outputCommand(dialect) {
  if (dialect === "posix") {
    return "printf 'e2e114-stdout\\n'; printf 'e2e114-stderr\\n' >&2";
  }
  if (dialect === "powershell") {
    return "[Console]::Out.WriteLine('e2e114-stdout'); [Console]::Error.WriteLine('e2e114-stderr')";
  }
  if (dialect === "cmd") return "echo e2e114-stdout & echo e2e114-stderr 1>&2";
  throw new Error(`unsupported shell dialect ${dialect}`);
}

function delayedMarkerCommand(dialect, startedPath, latePath, delaySeconds, holdSeconds = 30) {
  if (dialect === "posix") {
    return `${markerCommand(dialect, startedPath, "started")}; sleep ${delaySeconds}; ${markerCommand(
      dialect,
      latePath,
      "late",
    )}; sleep ${holdSeconds}`;
  }
  const script = `${markerCommand("powershell", startedPath, "started")}; Start-Sleep -Seconds ${delaySeconds}; ${markerCommand(
    "powershell",
    latePath,
    "late",
  )}; Start-Sleep -Seconds ${holdSeconds}`;
  if (dialect === "powershell") return script;
  if (dialect === "cmd") return encodedPowerShellCommand(script);
  throw new Error(`unsupported shell dialect ${dialect}`);
}

function abortPowerShellScript(startedPath, latePath) {
  const grandchild = `Start-Sleep -Milliseconds 2000; ${markerCommand(
    "powershell",
    latePath,
    "late",
  )}`;
  const child = `Start-Process -FilePath powershell.exe -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-Command',${powerShellQuote(
    grandchild,
  )}) -WindowStyle Hidden; ${markerCommand(
    "powershell",
    startedPath,
    "started",
  )}; Start-Sleep -Seconds 30`;
  return `Start-Process -FilePath powershell.exe -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-Command',${powerShellQuote(
    child,
  )}) -WindowStyle Hidden; Start-Sleep -Seconds 30`;
}

function abortCommand(dialect, startedPath, latePath) {
  if (dialect === "posix") {
    return `(sleep 2; ${markerCommand(dialect, latePath, "late")}) & ${markerCommand(
      dialect,
      startedPath,
      "started",
    )}; sleep 30`;
  }
  const script = abortPowerShellScript(startedPath, latePath);
  if (dialect === "powershell") return script;
  if (dialect === "cmd") return encodedPowerShellCommand(script);
  throw new Error(`unsupported shell dialect ${dialect}`);
}

function bashParams(sessionId, toolCallId, shell, command, extra = {}) {
  return {
    sessionId,
    toolCallId,
    toolName: "Bash",
    args: { command },
    mode: "agent",
    expectedCommandShellId: shell.id,
    expectedCommandShellDialect: shell.dialect,
    ...extra,
  };
}

async function scenario105(binary, tempRoot) {
  return withScenario("E2E-105", async (ctx) => {
    await writeFile(join(ctx.workspace, "readme.txt"), "Plan workspace read fixture\n", "utf8");
    const session = await createSession(ctx.host, ctx.workspace, "Plan policy", "plan");
    await configureSession(ctx.host, session, "plan", "auto");
    const catalog = await ctx.host.call("commandShells.list");
    const shell = effectiveShell(catalog);
    const read = await ctx.host.call("tools.execute", {
      sessionId: session.id,
      toolCallId: "e2e105-read",
      toolName: "Read",
      args: { path: "readme.txt" },
      mode: "agent",
    });
    assertToolSuccess(read, "e2e105-read");
    assert(
      String(read.content?.content || "").includes("Plan workspace read fixture"),
      `Read did not return fixture: ${shortJson(read)}`,
    );

    const forbidden = [
      ["Write", { path: "forged-write.txt", content: "must-not-write" }, "WRITE_DISABLED_IN_PLAN"],
      [
        "Edit",
        { path: "readme.txt", old_string: "fixture", new_string: "changed" },
        "EDIT_DISABLED_IN_PLAN",
      ],
      ["plugin_fake_tool", {}, "PLUGIN_DISABLED_IN_PLAN"],
      ["UnknownTool", {}, "TOOL_DISABLED_IN_PLAN"],
    ];
    ctx.host.clearNotifications();
    for (const [toolName, args, code] of forbidden) {
      const result = await ctx.host.call("tools.execute", {
        sessionId: session.id,
        toolCallId: `e2e105-${toolName}`,
        toolName,
        args,
        mode: "agent",
      });
      assertToolFailure(result, code);
    }
    const marker = join(ctx.workspace, "plan-bash-marker.txt");
    const bash = await ctx.host.call(
      "tools.execute",
      bashParams(
        session.id,
        "e2e105-bash",
        shell,
        planBashCommand(shell.dialect, marker),
      ),
    );
    assertToolSuccess(bash, "e2e105-bash");
    assert(bash.commandShellId === shell.id, `Bash shell identity mismatch: ${shortJson(bash)}`);
    assert(String(bash.content?.stdout || "").includes("plan-auto"), shortJson(bash));
    assert(existsSync(marker), "Plan Bash did not execute its marker command");
    assert(
      ctx.host.matchingNotifications("permissions.request").length === 0,
      "Plan policy scenario emitted a permission prompt",
    );
    const current = await ctx.host.call("session.get", { id: session.id });
    assert(current.session?.mode === "plan", `forged mode changed session: ${shortJson(current)}`);
    return `mode=plan read=ok denied=4 shell=${shell.id}/${shell.dialect}`;
  }, binary, tempRoot);
}

async function scenario106(binary, tempRoot) {
  return withScenario("E2E-106", async (ctx) => {
    const session = await createSession(ctx.host, ctx.workspace, "Plan submit identity", "agent");
    const firstTurn = await beginTurn(ctx.host, session.id);
    await enterPlan(ctx.host, session.id, firstTurn, "e2e106-enter");
    const afterEnter = await ctx.host.call("session.get", { id: session.id });
    assert(afterEnter.session?.mode === "plan", shortJson(afterEnter));

    const title1 = "Exact Acceptance Title";
    const question1 = "Proceed with the exact snapshot?";
    const markdown1 = "\n  # Exact Acceptance Plan  \n\n- preserve leading bytes  \n- retain trailing bytes\n\n  ";
    const proposal1 = await submitPlan(
      ctx.host,
      session.id,
      firstTurn,
      "e2e106-submit-1",
      title1,
      markdown1,
      question1,
    );
    const artifact1 = await verifyArtifact(ctx, proposal1, markdown1, title1, question1);
    const rejected = await resolvePlan(ctx.host, proposal1, "reject");
    assert(rejected.proposal?.status === "rejected", shortJson(rejected));
    assert(rejected.state === "planning", shortJson(rejected));
    const rejectedSession = await ctx.host.call("session.get", { id: session.id });
    assert(rejectedSession.session?.mode === "plan", shortJson(rejectedSession));
    await endTurn(ctx.host, firstTurn);

    const secondTurn = await beginTurn(ctx.host, session.id);
    const title2 = "Revised Acceptance Title";
    const question2 = "Approve the revised snapshot with Ask?";
    const markdown2 = "# Revised Acceptance Plan\n\n1. preserve the first artifact\n2. approve this snapshot\n";
    const proposal2 = await submitPlan(
      ctx.host,
      session.id,
      secondTurn,
      "e2e106-submit-2",
      title2,
      markdown2,
      question2,
    );
    const artifact2 = await verifyArtifact(ctx, proposal2, markdown2, title2, question2);
    assert(artifact1.path !== artifact2.path, "resubmission reused the first artifact path");
    assert(artifact1.sha256 !== artifact2.sha256, "resubmission reused the first artifact hash");
    const firstAgain = await readFile(artifact1.path);
    assert(firstAgain.equals(artifact1.bytes), "first artifact changed after resubmission");

    const missingModeCode = await expectRpcError(
      () => ctx.host.call("plans.resolve", resolveParams(proposal2, "approve")),
      ["PLAN_PERMISSION_MODE_REQUIRED"],
    );
    const stillPending = await ctx.host.call("plans.pending", { sessionId: session.id });
    assert(stillPending.plans?.length === 1, shortJson(stillPending));
    const approved = await resolvePlan(ctx.host, proposal2, "approve", "ask");
    assert(approved.proposal?.status === "approved", shortJson(approved));
    assert(approved.targetPermissionMode === "ask", shortJson(approved));
    assert(approved.execution?.state === "queued", shortJson(approved));
    assert(approved.execution?.targetPermissionMode === "ask", shortJson(approved));
    const claimed = await ctx.host.call("plans.claimExecution", {
      executionId: approved.execution.id,
    });
    await ctx.host.call("plans.finishExecution", {
      executionId: claimed.execution.id,
      status: "completed",
    });
    await endTurn(ctx.host, secondTurn);
    return `first=${proposal1.id.slice(0, 8)} second=${proposal2.id.slice(0, 8)} missingMode=${missingModeCode} approval=ask`;
  }, binary, tempRoot);
}

async function scenario107(binary, tempRoot) {
  return withScenario("E2E-107", async (ctx) => {
    const session = await createSession(ctx.host, ctx.workspace, "Plan expiry", "plan");
    const turnId = await beginTurn(ctx.host, session.id);
    const proposal = await submitPlan(
      ctx.host,
      session.id,
      turnId,
      "e2e107-submit",
      "Expiry plan",
      "# Expiry plan\n",
      "Approve expiry plan?",
    );
    const createdAt = Date.parse(proposal.createdAt);
    const expiresAt = Date.parse(proposal.expiresAt);
    assert(Number.isFinite(createdAt) && Number.isFinite(expiresAt), shortJson(proposal));
    const delta = expiresAt - createdAt;
    assert(delta === PLAN_APPROVAL_TIMEOUT_MS, `expiry delta=${delta}ms`);
    const reloaded1 = await ctx.host.call("plans.pending", { sessionId: session.id });
    const reloaded2 = await ctx.host.call("plans.pending", { sessionId: session.id });
    assert(reloaded1.plans?.length === 1 && reloaded2.plans?.length === 1, "pending reload lost proposal");
    assert(reloaded1.plans[0].expiresAt === proposal.expiresAt, "first pending reload changed deadline");
    assert(reloaded2.plans[0].expiresAt === proposal.expiresAt, "second pending reload changed deadline");
    skip("E2E-107-late-expiry", "public host RPC has no clock-control boundary; late expiry was not faked");
    await resolvePlan(ctx.host, proposal, "reject");
    await endTurn(ctx.host, turnId);
    return `expiryDeltaMs=${delta} pendingReloadDeadlineStable=true`;
  }, binary, tempRoot);
}

async function scenario108(binary, tempRoot) {
  return withScenario("E2E-108", async (ctx) => {
    const session = await createSession(ctx.host, ctx.workspace, "Restart pending Plan", "plan");
    const turnId = await beginTurn(ctx.host, session.id);
    const proposal = await submitPlan(
      ctx.host,
      session.id,
      turnId,
      "e2e108-submit",
      "Restart pending plan",
      "# Pending before restart\n",
      "Reject after restart?",
    );
    await ctx.host.restart();
    const pending = await ctx.host.call("plans.pending", { sessionId: session.id });
    assert(pending.plans?.length === 0, `stale pending proposal replayed: ${shortJson(pending)}`);
    assert(pending.state === "planning", `Plan did not remain editable: ${shortJson(pending)}`);
    const after = await ctx.host.call("session.get", { id: session.id });
    assert(after.session?.mode === "plan", `restart changed pending session mode: ${shortJson(after)}`);
    const staleCode = await expectRpcError(
      () => resolvePlan(ctx.host, proposal, "approve", "ask"),
      ["PLAN_APPROVAL_STALE", "PLAN_APPROVAL_CONFLICT"],
    );
    const afterResolve = await ctx.host.call("session.get", { id: session.id });
    assert(afterResolve.session?.mode === "plan", shortJson(afterResolve));
    return `pendingAfterRestart=0 sessionMode=plan oldResolve=${staleCode}`;
  }, binary, tempRoot);
}

async function approvedExecution(ctx, title, shouldClaim) {
  const session = await createSession(ctx.host, ctx.workspace, title, "agent");
  const turnId = await beginTurn(ctx.host, session.id);
  await enterPlan(ctx.host, session.id, turnId, `${title}-enter`);
  const proposal = await submitPlan(
    ctx.host,
    session.id,
    turnId,
    `${title}-submit`,
    title,
    `# ${title}\n`,
    `${title} approval?`,
  );
  const resolved = await resolvePlan(ctx.host, proposal, "approve", "ask");
  assert(resolved.execution?.state === "queued", shortJson(resolved));
  const executionId = resolved.execution.id;
  let execution = resolved.execution;
  if (shouldClaim) {
    const claimed = await ctx.host.call("plans.claimExecution", { executionId });
    assert(claimed.execution?.state === "running", shortJson(claimed));
    execution = claimed.execution;
  }
  return { session, turnId, proposal, execution, executionId };
}

async function scenario109(binary, tempRoot) {
  return withScenario("E2E-109", async (ctx) => {
    const queued = await approvedExecution(ctx, "queued restart execution", false);
    await ctx.host.restart();
    const queuedAfter = await ctx.host.call("plans.queuedExecutions", {
      sessionId: queued.session.id,
    });
    assert(queuedAfter.executions?.length === 0, `queued execution replayed: ${shortJson(queuedAfter)}`);
    const queuedSession = await ctx.host.call("session.get", { id: queued.session.id });
    assert(queuedSession.session?.mode === "agent", shortJson(queuedSession));
    const queuedClaimCode = await expectRpcError(
      () => ctx.host.call("plans.claimExecution", { executionId: queued.executionId }),
      ["PLAN_EXECUTION_STALE"],
    );

    const running = await approvedExecution(ctx, "running restart execution", true);
    assert(running.execution.state === "running", shortJson(running.execution));
    await ctx.host.restart();
    const allQueuedAfter = await ctx.host.call("plans.queuedExecutions", {});
    assert(allQueuedAfter.executions?.length === 0, `running execution replayed: ${shortJson(allQueuedAfter)}`);
    const runningSession = await ctx.host.call("session.get", { id: running.session.id });
    assert(runningSession.session?.mode === "agent", shortJson(runningSession));
    const runningClaimCode = await expectRpcError(
      () => ctx.host.call("plans.claimExecution", { executionId: running.executionId }),
      ["PLAN_EXECUTION_STALE"],
    );
    return `queuedReplay=0/${queuedClaimCode} runningReplay=0/${runningClaimCode} sessions=agent`;
  }, binary, tempRoot);
}

async function scenario110(binary, tempRoot) {
  return withScenario("E2E-110", async (ctx) => {
    await ctx.host.call("settings.set", { defaultMode: "agent" });
    const created = await ctx.host.call("scheduled.create", {
      title: "Plan scheduled task",
      prompt: "unattended plan prompt",
      cadence: "manual",
      mode: "plan",
    });
    const task = created.task;
    assert(task?.mode === "plan", shortJson(created));
    const beforeSessions = await ctx.host.call("session.list");
    const beforeRuns = await ctx.host.call("scheduled.listRuns", { taskId: task.id });
    const beforeArtifacts = await ctx.host.call("artifacts.list", {});
    const planRunCode = await expectRpcError(
      () => ctx.host.call("scheduled.run", { id: task.id }),
      ["PLAN_REQUIRES_INTERACTIVE_SESSION"],
    );
    const afterSessions = await ctx.host.call("session.list");
    const afterRuns = await ctx.host.call("scheduled.listRuns", { taskId: task.id });
    const afterArtifacts = await ctx.host.call("artifacts.list", {});
    assert(afterSessions.sessions?.length === beforeSessions.sessions?.length, "Plan schedule created a session");
    assert(afterRuns.runs?.length === beforeRuns.runs?.length, "Plan schedule created a run");
    assert(
      afterArtifacts.artifacts?.length === beforeArtifacts.artifacts?.length,
      "Plan schedule created an artifact",
    );

    const updated = await ctx.host.call("scheduled.update", { id: task.id, mode: "agent" });
    assert(updated.task?.mode === "agent", shortJson(updated));
    await ctx.host.call("settings.set", { defaultMode: "plan" });
    const run = await ctx.host.call("scheduled.run", { id: task.id });
    assert(run.sessionId && run.runId && run.task?.mode === "agent", shortJson(run));
    const runSession = await ctx.host.call("session.get", { id: run.sessionId });
    assert(runSession.session?.mode === "agent", shortJson(runSession));
    const listed = await ctx.host.call("scheduled.listRuns", { taskId: task.id });
    assert(listed.runs?.some((item) => item.id === run.runId && item.status === "running"), shortJson(listed));
    await ctx.host.call("scheduled.finishRun", { runId: run.runId, status: "completed" });
    await ctx.host.call("session.delete", { id: run.sessionId });
    await ctx.host.call("scheduled.delete", { id: task.id });
    return `planRun=${planRunCode} noSideEffects=true explicitAgentRun=true globalDefault=plan`;
  }, binary, tempRoot);
}

async function scenario111(binary, tempRoot) {
  return withScenario("E2E-111", async (ctx) => {
    const sessionA = await createSession(ctx.host, ctx.workspace, "Boundary A", "agent");
    const sessionB = await createSession(ctx.host, ctx.workspace, "Boundary B", "agent");
    const catalog = await ctx.host.call("commandShells.list");
    const shell = effectiveShell(catalog);
    const alternateShell = catalog.choices?.find(
      (choice) => choice.available && choice.id !== shell.id,
    );
    if (!alternateShell) {
      skip(
        "E2E-111-shell-change",
        "only one available shell; genuine-change coverage is provided by deterministic host-core settings tests",
      );
    }
    const activeTurn = await beginTurn(ctx.host, sessionA.id);
    const duplicateCode = await expectRpcError(
      () => beginTurn(ctx.host, sessionA.id),
      ["AGENT_BUSY"],
    );
    const activeConfigureCode = await expectRpcError(
      () =>
        ctx.host.call("session.configure", {
          id: sessionA.id,
          mode: "plan",
          providerId: "renderer-forged-provider",
          modelId: "renderer-forged-model",
          thinkingLevel: "off",
          permissionMode: "auto",
        }),
      ["PLAN_CONFIGURATION_BLOCKED"],
    );
    const activeShellCode = alternateShell
      ? await expectRpcError(
          () =>
            ctx.host.call("settings.set", {
              defaultCommandShell: alternateShell.id,
            }),
          ["PLAN_CONFIGURATION_BLOCKED"],
        )
      : (await ctx.host.call("settings.set", { defaultCommandShell: shell.id }),
        "IDEMPOTENT_ALLOWED");
    const independent = await configureSession(ctx.host, sessionB, "agent", "auto");
    assert(independent.permissionMode === "auto", shortJson(independent));

    await enterPlan(ctx.host, sessionA.id, activeTurn, "e2e111-enter");
    const firstProposal = await submitPlan(
      ctx.host,
      sessionA.id,
      activeTurn,
      "e2e111-submit-1",
      "Boundary first",
      "# Boundary first\n",
      "Reject boundary first?",
    );
    const pendingDuplicateCode = await expectRpcError(
      () => beginTurn(ctx.host, sessionA.id),
      ["AGENT_BUSY"],
    );
    const pendingConfigureCode = await expectRpcError(
      () => ctx.host.call("session.configure", { id: sessionA.id, mode: "agent", permissionMode: "ask" }),
      ["PLAN_CONFIGURATION_BLOCKED"],
    );
    const pendingShellCode = alternateShell
      ? await expectRpcError(
          () =>
            ctx.host.call("settings.set", {
              defaultCommandShell: alternateShell.id,
            }),
          ["PLAN_CONFIGURATION_BLOCKED"],
        )
      : (await ctx.host.call("settings.set", { defaultCommandShell: shell.id }),
        "IDEMPOTENT_ALLOWED");
    await resolvePlan(ctx.host, firstProposal, "reject");
    await endTurn(ctx.host, activeTurn);

    const laterTurn = await beginTurn(ctx.host, sessionA.id);
    const secondProposal = await submitPlan(
      ctx.host,
      sessionA.id,
      laterTurn,
      "e2e111-submit-2",
      "Boundary revised",
      "# Boundary revised\n\n- new complete snapshot\n",
      "Reject revised boundary plan?",
    );
    assert(secondProposal.status === "pending", shortJson(secondProposal));
    await resolvePlan(ctx.host, secondProposal, "reject");
    await endTurn(ctx.host, laterTurn);
    const idleConfigured = await configureSession(ctx.host, sessionA, "agent", "auto");
    assert(idleConfigured.mode === "agent" && idleConfigured.permissionMode === "auto", shortJson(idleConfigured));
    const idleShell = alternateShell?.id || shell.id;
    await ctx.host.call("settings.set", { defaultCommandShell: idleShell });
    return `active=${duplicateCode}/${activeConfigureCode}/${activeShellCode} pending=${pendingDuplicateCode}/${pendingConfigureCode}/${pendingShellCode} idleSessionIndependent=true resubmit=true shellChange=${alternateShell ? `${shell.id}->${alternateShell.id}` : "host-core-covered"}`;
  }, binary, tempRoot);
}

async function scenario112(binary, tempRoot) {
  return withScenario("E2E-112", async (ctx) => {
    const catalog = await ctx.host.call("commandShells.list");
    const choices = Array.isArray(catalog.choices) ? catalog.choices : [];
    assert(choices.length > 0, `empty shell catalog: ${shortJson(catalog)}`);
    const expectedIds =
      process.platform === "win32"
        ? ["windows-powershell", "cmd", "git-bash"]
        : ["bash"];
    for (const id of expectedIds) {
      assert(choices.some((choice) => choice.id === id), `missing platform shell ${id}`);
    }
    for (const choice of choices) {
      assert(shellDialectForId(choice.id) === choice.dialect, shortJson(choice));
      assert(typeof choice.available === "boolean", shortJson(choice));
    }
    const invalidCode = await expectRpcError(
      () => ctx.host.call("settings.set", { defaultCommandShell: "not-a-command-shell" }),
      ["COMMAND_SHELL_INVALID"],
    );
    const unavailable =
      choices.find((choice) => !choice.available)?.id ||
      (process.platform === "win32" ? "bash" : "windows-powershell");
    const unavailableCode = await expectRpcError(
      () => ctx.host.call("settings.set", { defaultCommandShell: unavailable }),
      ["COMMAND_SHELL_INVALID"],
    );
    const selected = effectiveShell(catalog);
    await ctx.host.call("settings.set", { defaultCommandShell: selected.id });
    const settings = await ctx.host.call("settings.get");
    assert(settings.defaultCommandShell === selected.id, shortJson(settings));
    const persisted = await ctx.host.call("commandShells.list");
    assert(persisted.configuredId === selected.id, shortJson(persisted));
    assert(persisted.effective?.id === selected.id, shortJson(persisted));
    await ctx.host.restart();
    const afterRestartSettings = await ctx.host.call("settings.get");
    const afterRestartCatalog = await ctx.host.call("commandShells.list");
    assert(afterRestartSettings.defaultCommandShell === selected.id, shortJson(afterRestartSettings));
    assert(afterRestartCatalog.configuredId === selected.id, shortJson(afterRestartCatalog));
    assert(afterRestartCatalog.effective?.id === selected.id, shortJson(afterRestartCatalog));
    skip(
      "E2E-112-fallback",
      "public RPC cannot make an installed shell unavailable without mutating the host environment",
    );
    return `catalog=${choices.map((choice) => `${choice.id}:${choice.available}`).join(",")} invalid=${invalidCode} unavailable=${unavailableCode} persisted=${selected.id}`;
  }, binary, tempRoot);
}

async function scenario113(binary, tempRoot) {
  return withScenario("E2E-113", async (ctx) => {
    const session = await createSession(ctx.host, ctx.workspace, "Shell dialect mismatch", "agent");
    await configureSession(ctx.host, session, "agent", "auto");
    const shell = effectiveShell(await ctx.host.call("commandShells.list"));
    const wrongDialect = shell.dialect === "posix" ? "powershell" : "posix";
    const marker = join(ctx.workspace, "e2e113-must-not-run.txt");
    const result = await ctx.host.call("tools.execute", {
      ...bashParams(session.id, "e2e113-mismatch", shell, markerCommand(shell.dialect, marker)),
      expectedCommandShellDialect: wrongDialect,
    });
    assertToolFailure(result, "COMMAND_SHELL_CHANGED");
    assert(result.content?.expectedCommandShellDialect === wrongDialect, shortJson(result));
    assert(result.content?.commandShellDialect === shell.dialect, shortJson(result));
    await delay(100);
    assert(!existsSync(marker), "stale shell dialect spawned the marker command");
    return `shell=${shell.id} expectedDialect=${wrongDialect} actualDialect=${shell.dialect} marker=false`;
  }, binary, tempRoot);
}

async function scenario114(binary, tempRoot) {
  return withScenario("E2E-114", async (ctx) => {
    const session = await createSession(ctx.host, ctx.workspace, "Bash output streams", "agent");
    await configureSession(ctx.host, session, "agent", "auto");
    const shell = effectiveShell(await ctx.host.call("commandShells.list"));
    const toolCallId = "e2e114-output";
    ctx.host.clearNotifications();
    const result = await ctx.host.call(
      "tools.execute",
      bashParams(session.id, toolCallId, shell, outputCommand(shell.dialect)),
    );
    assertToolSuccess(result, toolCallId);
    assert(result.commandShellId === shell.id, shortJson(result));
    assert(String(result.content?.stdout || "").includes("e2e114-stdout"), shortJson(result));
    assert(String(result.content?.stderr || "").includes("e2e114-stderr"), shortJson(result));
    await delay(50);
    const output = ctx.host.matchingNotifications(
      "tools.output",
      (note) => note.params?.sessionId === session.id && note.params?.toolCallId === toolCallId,
    );
    assert(output.some((note) => note.params.stream === "stdout"), shortJson(output));
    assert(output.some((note) => note.params.stream === "stderr"), shortJson(output));
    assert(output.every((note) => note.params.commandShellId === shell.id), shortJson(output));
    const streamed = output.map((note) => `${note.params.stream}:${note.params.chunk}`).join("|");
    assert(streamed.includes("e2e114-stdout") && streamed.includes("e2e114-stderr"), streamed);
    return `shell=${shell.id} stdoutStream=true stderrStream=true finalTool=${result.toolCallId}`;
  }, binary, tempRoot);
}

async function scenario115(binary, tempRoot) {
  return withScenario("E2E-115", async (ctx) => {
    const session = await createSession(ctx.host, ctx.workspace, "Bash timeout bounds", "agent");
    await configureSession(ctx.host, session, "agent", "auto");
    const shell = effectiveShell(await ctx.host.call("commandShells.list"));
    const invalidLegs = [
      ["zero", 0, ["INVALID_ARGUMENT"]],
      ["negative", -1, ["INVALID_PARAMS"]],
      ["over-max", 300_001, ["INVALID_ARGUMENT"]],
    ];
    const invalidDetails = [];
    for (const [name, timeoutMs, codes] of invalidLegs) {
      const marker = join(ctx.workspace, `e2e115-invalid-${name}.txt`);
      let code;
      try {
        const result = await ctx.host.call(
          "tools.execute",
          bashParams(
            session.id,
            `e2e115-invalid-${name}`,
            shell,
            markerCommand(shell.dialect, marker),
            { timeoutMs },
          ),
        );
        code = toolErrorCode(result);
      } catch (error) {
        code = errorCodeOf(error);
      }
      assert(codes.includes(code), `${name} timeout error=${code}`);
      assert(!existsSync(marker), `${name} timeout spawned a marker`);
      invalidDetails.push(`${name}:${code}`);
    }

    const shortStarted = join(ctx.workspace, "e2e115-short-started.txt");
    const shortLate = join(ctx.workspace, "e2e115-short-late.txt");
    const shortStart = Date.now();
    const shortResult = await ctx.host.call(
      "tools.execute",
      bashParams(
        session.id,
        "e2e115-short",
        shell,
        delayedMarkerCommand(shell.dialect, shortStarted, shortLate, 3),
        { timeoutMs: 1_200 },
      ),
    );
    const shortElapsed = Date.now() - shortStart;
    assertToolFailure(shortResult, "TOOL_TIMEOUT");
    assert(existsSync(shortStarted), "short timeout command never started");
    assert(!existsSync(shortLate), "short timeout left a delayed marker");
    await delay(1_800);
    assert(!existsSync(shortLate), "short timeout descendant wrote after timeout");

    let longDetail = "";
    if (!LONG_TIMEOUT_ENABLED) {
      skip(
        "E2E-115-60s-default",
        "PI_DESKTOP_E2E_LONG_TIMEOUT=1 is not set; skipped the 60-second default leg",
      );
      longDetail = "default60s=skipped";
    } else {
      const defaultStarted = join(ctx.workspace, "e2e115-default-started.txt");
      const defaultLate = join(ctx.workspace, "e2e115-default-late.txt");
      const defaultStart = Date.now();
      let defaultResult;
      try {
        defaultResult = await ctx.host.call(
          "tools.execute",
          bashParams(
            session.id,
            "e2e115-default",
            shell,
            delayedMarkerCommand(shell.dialect, defaultStarted, defaultLate, 70),
          ),
          80_000,
        );
      } catch (error) {
        throw new Error(`60-second default RPC failed: ${errorText(error)}`);
      }
      const defaultElapsed = Date.now() - defaultStart;
      try {
        assertToolFailure(defaultResult, "TOOL_TIMEOUT");
        assert(defaultElapsed >= 55_000 && defaultElapsed <= 75_000, `default elapsed=${defaultElapsed}ms`);
        assert(existsSync(defaultStarted), "default timeout command never started");
        assert(!existsSync(defaultLate), "default timeout left a delayed marker");
        await delay(1_500);
        assert(!existsSync(defaultLate), "default timeout descendant wrote after timeout");
        record("E2E-115-60s-default", true, `elapsedMs=${defaultElapsed}`);
      } catch (error) {
        record("E2E-115-60s-default", false, errorText(error));
        throw error;
      }
      longDetail = `default60s=${defaultElapsed}ms`;
    }
    return `shell=${shell.id} invalid=${invalidDetails.join(",")} shortElapsedMs=${shortElapsed} ${longDetail}`;
  }, binary, tempRoot);
}

async function scenario116(binary, tempRoot) {
  return withScenario("E2E-116", async (ctx) => {
    const session = await createSession(ctx.host, ctx.workspace, "Bash abort tree", "agent");
    await configureSession(ctx.host, session, "agent", "auto");
    const shell = effectiveShell(await ctx.host.call("commandShells.list"));
    const startedPath = join(ctx.workspace, "e2e116-started.txt");
    const latePath = join(ctx.workspace, "e2e116-late.txt");
    const toolCallId = "e2e116-abort";
    ctx.host.clearNotifications();
    const executionPromise = ctx.host.call(
      "tools.execute",
      bashParams(session.id, toolCallId, shell, abortCommand(shell.dialect, startedPath, latePath)),
      15_000,
    );
    let result;
    try {
      await waitFor(() => existsSync(startedPath), 5_000, "E2E-116 command start marker");
      const aborted = await ctx.host.call("tools.abort", {
        sessionId: session.id,
        toolCallId,
      });
      assert(aborted?.ok === true && aborted?.found === true && aborted?.aborted === true, shortJson(aborted));
      result = await executionPromise;
    } catch (error) {
      try {
        await ctx.host.call("tools.abort", { sessionId: session.id, toolCallId }, 5_000);
      } catch {
        // The process may already have exited; preserve the original failure.
      }
      try {
        await executionPromise;
      } catch {
        // Preserve the original failure.
      }
      throw error;
    }
    assertToolFailure(result, "TOOL_ABORTED");
    await delay(2_500);
    assert(existsSync(startedPath), "abort test lost its start marker");
    assert(!existsSync(latePath), "aborted descendant wrote its delayed marker");
    const lateOutput = ctx.host.matchingNotifications(
      "tools.output",
      (note) => note.params?.sessionId === session.id && note.params?.toolCallId === toolCallId,
    );
    assert(
      !lateOutput.some((note) => String(note.params?.chunk || "").includes("e2e116-late")),
      shortJson(lateOutput),
    );
    return `shell=${shell.id} abort=TOOL_ABORTED lateMarker=false lateOutput=false`;
  }, binary, tempRoot);
}

async function runScenario(id, fn) {
  try {
    const detail = await fn();
    record(id, true, detail || "completed");
  } catch (error) {
    record(id, false, errorText(error));
  }
}

async function main() {
  let binary;
  try {
    binary = resolveHostBinary();
  } catch (error) {
    record("E2E-harness-host", false, errorText(error));
    printSummary();
    process.exitCode = 1;
    return;
  }

  const tempRoot = await mkdtemp(join(tmpdir(), "pi-desktop-plan-e2e-"));
  try {
    await runScenario("E2E-105", () => scenario105(binary, tempRoot));
    await runScenario("E2E-106", () => scenario106(binary, tempRoot));
    await runScenario("E2E-107", () => scenario107(binary, tempRoot));
    await runScenario("E2E-108", () => scenario108(binary, tempRoot));
    await runScenario("E2E-109", () => scenario109(binary, tempRoot));
    await runScenario("E2E-110", () => scenario110(binary, tempRoot));
    await runScenario("E2E-111", () => scenario111(binary, tempRoot));
    await runScenario("E2E-112", () => scenario112(binary, tempRoot));
    await runScenario("E2E-113", () => scenario113(binary, tempRoot));
    await runScenario("E2E-114", () => scenario114(binary, tempRoot));
    await runScenario("E2E-115", () => scenario115(binary, tempRoot));
    await runScenario("E2E-116", () => scenario116(binary, tempRoot));
  } finally {
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
  printSummary();
  if (results.some((result) => !result.ok)) process.exitCode = 1;
}

function printSummary() {
  const skipped = results.filter((result) => result.skipped).length;
  const failed = results.filter((result) => !result.ok).length;
  const passed = results.filter((result) => result.ok && !result.skipped).length;
  const executed = passed + failed;
  console.log(`\nSummary: ${passed} passed, ${failed} failed, ${skipped} skipped (${executed} executed)`);
}

main().catch((error) => {
  record("E2E-harness-fatal", false, errorText(error));
  printSummary();
  process.exitCode = 1;
});
