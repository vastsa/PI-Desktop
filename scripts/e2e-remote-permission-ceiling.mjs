#!/usr/bin/env node
/**
 * Headless permission-ceiling E2E: exercise a paired owner session in `auto`
 * mode and prove a delegate's `accept-edits` Write still waits for the Host.
 *
 * Prereqs: `pnpm build:js`, `pnpm -C packages/agent-runtime bundle`, and a
 * host-core binary (target/debug or PI_DESKTOP_HOST_BIN). The runner creates
 * a temporary pi-host bundle by default; PI_DESKTOP_HOST_BUNDLE_DIR may point
 * it at a prebuilt bundle. All Host data, HOME and agent definitions are
 * isolated under temporary directories. No external model service is used.
 */
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { RacpClient, wsClientTransport } from "../packages/racp/dist/index.js";
import { resolveHostBinary } from "./e2e/host.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hostBin = resolveHostBinary();
const configuredBundleDir = process.env.PI_DESKTOP_HOST_BUNDLE_DIR;
const ownsBundle = !configuredBundleDir;
const bundleDir = configuredBundleDir ?? mkdtempSync(join(tmpdir(), "pi-host-permission-e2e-bundle-"));

if (ownsBundle) {
  const bundleResult = spawnSync(
    process.execPath,
    [
      join(root, "apps/pi-host/scripts/bundle.mjs"),
      "--host-core",
      hostBin,
      "--platform",
      process.platform,
      "--arch",
      process.arch,
      "--out",
      bundleDir,
    ],
    { cwd: root, stdio: "inherit" },
  );
  if (bundleResult.error || bundleResult.status !== 0) {
    if (ownsBundle) rmSync(bundleDir, { recursive: true, force: true });
    throw bundleResult.error ?? new Error(`pi-host bundle failed with exit code ${bundleResult.status}`);
  }
}

const cli = join(bundleDir, "pi-host.js");
const sidecar = join(bundleDir, "agent-runtime/sidecar.js");
for (const [label, path] of [["pi-host cli", cli], ["sidecar bundle", sidecar]]) {
  if (!existsSync(path)) {
    if (ownsBundle) rmSync(bundleDir, { recursive: true, force: true });
    throw new Error(`${label} missing: ${path}`);
  }
}

const dataDir = mkdtempSync(join(tmpdir(), "pi-host-permission-e2e-data-"));
const homeDir = mkdtempSync(join(tmpdir(), "pi-host-permission-e2e-home-"));
const projectDir = join(dataDir, "project");
const agentsDir = join(homeDir, ".agents");
const subagentsDir = join(agentsDir, "subagents");
const targetRelativePath = "host-ceiling-target.txt";
const queuedTargetRelativePath = "host-ceiling-queued-target.txt";
const targetPath = join(projectDir, targetRelativePath);
const queuedTargetPath = join(projectDir, queuedTargetRelativePath);
const targetContents = "approved exactly once under the Host ceiling\n";
const scenarioMarker = "remote-permission-ceiling-probe";
const apiKey = "e2e-permission-ceiling-key";

mkdirSync(projectDir, { recursive: true });
mkdirSync(subagentsDir, { recursive: true });
mkdirSync(join(homeDir, ".config"), { recursive: true });
mkdirSync(join(homeDir, ".cache"), { recursive: true });
writeFileSync(join(projectDir, "README.md"), "# permission ceiling E2E\n");
writeFileSync(
  join(subagentsDir, "ceiling-writer.md"),
  [
    "---",
    "name: ceiling-writer",
    "description: Write the one file named by the parent task.",
    "tools: [Write]",
    "permission: accept-edits",
    "---",
    "Use Write exactly once for the requested workspace file. Do not write any other path.",
    "Report only after the write finishes.",
    "",
  ].join("\n"),
);

const childEnv = {
  ...process.env,
  HOME: homeDir,
  USERPROFILE: homeDir,
  XDG_CONFIG_HOME: join(homeDir, ".config"),
  XDG_CACHE_HOME: join(homeDir, ".cache"),
  PI_DESKTOP_DATA_DIR: dataDir,
  PI_DESKTOP_AGENTS_DIR: agentsDir,
};

const modelRequests = [];
const modelFailures = [];
let completionNumber = 0;
let childWriteCount = 0;
let childWriteArgs;

function contentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part?.text === "string" ? part.text : JSON.stringify(part)))
      .join("\n");
  }
  return content === undefined ? "" : JSON.stringify(content);
}

function toolName(tool) {
  return tool?.function?.name ?? tool?.name;
}

function findToolResult(messages, toolCallId) {
  return messages.find(
    (message) => message?.role === "tool" && message.tool_call_id === toolCallId,
  );
}

function streamCompletion(response, result) {
  completionNumber += 1;
  const base = {
    id: `permission-ceiling-${completionNumber}`,
    object: "chat.completion.chunk",
    created: 1,
    model: "permission-ceiling-model",
  };
  response.writeHead(200, { "content-type": "text/event-stream" });
  const delta = result.toolCall
    ? {
        role: "assistant",
        tool_calls: [{
          index: 0,
          id: result.toolCall.id,
          type: "function",
          function: {
            name: result.toolCall.name,
            arguments: JSON.stringify(result.toolCall.arguments),
          },
        }],
      }
    : { role: "assistant", content: result.content };
  const finish = result.toolCall ? "tool_calls" : "stop";
  response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`);
  response.end("data: [DONE]\n\n");
}

function failModel(response, message) {
  modelFailures.push(message);
  response.writeHead(500, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: { message, type: "invalid_request_error" } }));
}

function deterministicModelReply(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const names = tools.map(toolName);
  let lastUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      lastUserIndex = index;
      break;
    }
  }
  const turnMessages = messages.slice(lastUserIndex >= 0 ? lastUserIndex : 0);
  const serializedTurn = JSON.stringify(turnMessages);
  const turnSuffix = serializedTurn.includes(queuedTargetRelativePath) ? "queued" : "initial";
  const taskCallId = `call_ceiling_task_${turnSuffix}`;
  const waitCallId = `call_ceiling_wait_${turnSuffix}`;
  const writeCallId = `call_ceiling_write_${turnSuffix}`;
  const systemText = messages
    .filter((message) => message?.role === "system")
    .map((message) => contentText(message.content))
    .join("\n");
  const isDelegate = systemText.includes('You are the "ceiling-writer" subagent');

  if (isDelegate) {
    if (!names.includes("Write")) {
      throw new Error("the real subagent launch did not include its declared Write tool");
    }
    if (findToolResult(turnMessages, writeCallId)) {
      return { content: "The requested file was written." };
    }
    childWriteCount += 1;
    if (childWriteCount !== 1) throw new Error("the delegate requested more than one Write call");
    const target = serializedTurn.includes(queuedTargetRelativePath)
      ? queuedTargetRelativePath
      : targetRelativePath;
    childWriteArgs = { path: target, content: targetContents };
    return {
      toolCall: {
        id: writeCallId,
        name: "Write",
        arguments: childWriteArgs,
      },
    };
  }

  if (!serializedTurn.includes(scenarioMarker)) {
    throw new Error("the parent model request lost the remote permission E2E marker");
  }
  const taskResult = findToolResult(turnMessages, taskCallId);
  if (!taskResult) {
    const target = serializedTurn.includes(queuedTargetRelativePath)
      ? queuedTargetRelativePath
      : targetRelativePath;
    const taskTool = tools.find((tool) => toolName(tool) === "Task");
    if (!taskTool) throw new Error("the real parent launch did not offer the Task tool");
    const description = taskTool.function?.description ?? taskTool.description ?? "";
    if (!description.includes("ceiling-writer")) {
      throw new Error("the temporary ceiling-writer definition is absent from the Task catalog");
    }
    return {
      toolCall: {
        id: taskCallId,
        name: "Task",
        arguments: {
          agent: "ceiling-writer",
          task: `Write exactly one file in the workspace root: ${target}. Its exact contents must be ${JSON.stringify(targetContents)}. Do not write any other file.`,
          description: "write ceiling fixture",
        },
      },
    };
  }

  const waitResult = findToolResult(turnMessages, waitCallId);
  if (!waitResult) {
    const resultText = contentText(taskResult.content);
    const delegationId = resultText.match(/Delegation ([0-9a-f-]{36}) started/)?.[1];
    if (!delegationId) throw new Error("Task did not return its real delegation id");
    if (!names.includes("TaskWait")) throw new Error("the real parent launch did not offer TaskWait");
    return {
      toolCall: {
        id: waitCallId,
        name: "TaskWait",
        arguments: { delegationIds: [delegationId], timeoutSeconds: 45 },
      },
    };
  }

  return { content: "The delegated write completed after Host approval." };
}

const modelServer = createServer((request, response) => {
  if (request.method === "GET" && request.url?.endsWith("/models")) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ object: "list", data: [{ id: "permission-ceiling-model", object: "model" }] }));
    return;
  }
  if (request.method !== "POST") {
    response.writeHead(404);
    response.end();
    return;
  }
  let requestBody = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => (requestBody += chunk));
  request.on("end", () => {
    try {
      const body = JSON.parse(requestBody);
      modelRequests.push(body);
      streamCompletion(response, deterministicModelReply(body));
    } catch (error) {
      failModel(response, error instanceof Error ? error.message : String(error));
    }
  });
});

await new Promise((resolveListen, rejectListen) => {
  modelServer.once("error", rejectListen);
  modelServer.listen(0, "127.0.0.1", resolveListen);
});
const modelAddress = modelServer.address();
if (!modelAddress || typeof modelAddress === "string") throw new Error("loopback model did not bind to a TCP port");

const results = [];
function check(id, ok, detail = "") {
  results.push({ id, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${id}${detail ? ` — ${detail}` : ""}`);
  if (!ok) throw new Error(`${id}${detail ? `: ${detail}` : ""}`);
}

function eventCollector() {
  const events = [];
  const waiters = new Set();
  return {
    events,
    onEvent(event) {
      events.push(event);
      for (const waiter of waiters) {
        if (!waiter.predicate(event)) continue;
        waiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.resolve(event);
      }
    },
    waitFor(predicate, label, timeoutMs = 60_000) {
      const found = events.find(predicate);
      if (found) return Promise.resolve(found);
      return new Promise((resolveEvent, rejectEvent) => {
        const waiter = {
          predicate,
          resolve: resolveEvent,
          timer: setTimeout(() => {
            waiters.delete(waiter);
            rejectEvent(new Error(`timed out waiting for ${label}`));
          }, timeoutMs),
        };
        waiters.add(waiter);
      });
    },
  };
}

function makeClient(url, token, onEvent) {
  return new RacpClient({
    transport: wsClientTransport({ url, token }),
    client: { name: "remote-permission-ceiling-e2e", version: "0.15.0" },
    onEvent,
    requestTimeoutMs: 30_000,
  });
}

function startHost(extraArgs) {
  const child = spawn(
    process.execPath,
    [
      cli,
      "--data-dir",
      dataDir,
      "--port",
      "0",
      "--host-core",
      hostBin,
      "--sidecar",
      sidecar,
      "--browse-root",
      dataDir,
      "--log-level",
      "warn",
      "--remote-max-permission-mode",
      "ask",
      "--apply-ceiling-to-paired-devices",
      "true",
      ...extraArgs,
    ],
    { stdio: ["ignore", "pipe", "pipe"], env: childEnv },
  );
  hostChild = child;
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${String(chunk)}`.slice(-4_000);
    if (process.env.DEBUG_HOST) process.stderr.write(chunk);
  });
  return new Promise((resolveReady, rejectReady) => {
    let output = "";
    let ready;
    const timer = setTimeout(() => rejectReady(new Error(`pi-host did not become ready\n${stderr}`)), 60_000);
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
      while (output.includes("\n")) {
        const newline = output.indexOf("\n");
        const line = output.slice(0, newline).trim();
        output = output.slice(newline + 1);
        if (line.startsWith("PI_HOST_READY ")) ready = JSON.parse(line.slice("PI_HOST_READY ".length));
        if (line.startsWith("PI_HOST_PAIRING_TOKEN ")) {
          const pairing = JSON.parse(line.slice("PI_HOST_PAIRING_TOKEN ".length));
          if (ready) ready.pairing = pairing;
        }
        if (line.startsWith("PI_HOST_FAILED ")) {
          clearTimeout(timer);
          rejectReady(new Error(`pi-host failed: ${line}\n${stderr}`));
          return;
        }
        if (ready?.pairing) {
          clearTimeout(timer);
          resolveReady({ child, ready, stderr: () => stderr });
          return;
        }
      }
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectReady(error);
    });
    child.once("exit", (code, signal) => {
      if (ready?.pairing) return;
      clearTimeout(timer);
      rejectReady(new Error(`pi-host exited before ready (code=${code}, signal=${signal})\n${stderr}`));
    });
  });
}

function runProviderImport(cliPath, payload) {
  return new Promise((resolveImport, rejectImport) => {
    const child = spawn(process.execPath, [cliPath, "provider-import", "--data-dir", dataDir], {
      stdio: ["pipe", "pipe", "pipe"],
      env: childEnv,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.once("error", rejectImport);
    child.once("exit", (code, signal) => resolveImport({ code, signal, stdout, stderr }));
    child.stdin.end(JSON.stringify(payload));
  });
}

async function stopHost(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
  child.kill("SIGTERM");
  let timer;
  const completed = await Promise.race([
    exited.then(() => true),
    new Promise((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout(false), 4_000);
    }),
  ]);
  clearTimeout(timer);
  if (completed) return;
  child.kill("SIGKILL");
  await Promise.race([
    exited,
    new Promise((resolveTimeout) => setTimeout(resolveTimeout, 2_000)),
  ]);
}

let hostChild;
const clients = new Set();
try {
  const boot = await startHost(["--pair"]);
  hostChild = boot.child;
  const url = `ws://127.0.0.1:${boot.ready.port}/v1/racp/ws`;
  check("host-binds-loopback", boot.ready.host === "127.0.0.1" && boot.ready.port > 0);

  const pairing = makeClient(url, boot.ready.pairing.token);
  clients.add(pairing);
  const pairingInit = await pairing.connect();
  check("pairing-token-is-unprivileged", pairingInit.principal.roles.length === 0);
  const paired = await pairing.request("connection/pair", { deviceLabel: "permission ceiling E2E" });
  check("pairing-mints-owner-device", paired.roles.includes("owner") && paired.deviceToken.startsWith("pdt1."));
  await pairing.close();
  clients.delete(pairing);

  const eventStream = eventCollector();
  const owner = makeClient(url, paired.deviceToken, eventStream.onEvent);
  clients.add(owner);
  const ownerInit = await owner.connect();
  check("paired-owner-sees-enabled-host-ceiling", ownerInit.principal.roles.includes("owner") &&
    ownerInit.policy.remoteMaxPermissionMode === "ask" && ownerInit.policy.applyCeilingToPairedDevices === true,
  JSON.stringify(ownerInit.policy));

  const registered = await owner.request("project/register", { path: projectDir });
  const created = await owner.request("session/create", {
    title: "Remote permission ceiling E2E",
    projectId: registered.project.id,
    permissionMode: "auto",
  });
  check("paired-owner-session-keeps-auto-mode", created.session.permissionMode === "auto", created.session.permissionMode);
  await owner.request("session/attach", { sessionId: created.session.id });
  await owner.request("events/subscribe", { scope: "session", sessionId: created.session.id });

  const importResult = await runProviderImport(cli, {
    version: 1,
    providers: [{
      sourceId: "permission-ceiling-provider",
      input: {
        name: "Permission ceiling loopback",
        vendorKey: "custom",
        type: "openai_compatible",
        protocol: "openai_compatible",
        baseUrl: `http://127.0.0.1:${modelAddress.port}/v1`,
        authKind: "api_key_and_base_url",
        apiStyle: "chat_completions",
        secretValue: apiKey,
        models: [{
          id: "permission-ceiling-model",
          contextWindow: 128_000,
          maxTokens: 8_192,
          thinkingLevels: ["off"],
          defaultThinkingLevel: "off",
        }],
      },
    }],
    defaultModel: { sourceId: "permission-ceiling-provider", modelId: "permission-ceiling-model" },
  });
  const providerLine = importResult.stdout
    .split("\n")
    .find((line) => line.startsWith("PI_HOST_PROVIDERS "));
  const providerSummary = providerLine
    ? JSON.parse(providerLine.slice("PI_HOST_PROVIDERS ".length))
    : null;
  check("loopback-provider-imports", importResult.code === 0 && providerSummary?.defaultSet === true,
    importResult.code === 0 ? JSON.stringify(providerSummary) : importResult.stderr.slice(-500));
  check("provider-secret-is-not-echoed", !importResult.stdout.includes(apiKey) && !importResult.stderr.includes(apiKey));

  const turnStart = await owner.request("turn/start", {
    sessionId: created.session.id,
    input: { text: `${scenarioMarker}: use ceiling-writer to create ${targetRelativePath}` },
    context: { requestId: "permission-ceiling-turn", idempotencyKey: "permission-ceiling-turn-1" },
  });
  check("turn-effective-mode-is-clamped-to-ask", turnStart.accepted === true &&
    turnStart.turn.effectivePermissionMode === "ask", JSON.stringify(turnStart.turn));

  const terminalEvent = await eventStream.waitFor(
    (event) => event.sessionId === created.session.id &&
      (event.kind === "approval.requested" || event.kind === "turn.failed"),
    "Host approval request",
  );
  if (terminalEvent.kind === "turn.failed") {
    throw new Error(`turn failed before approval: ${JSON.stringify({ event: terminalEvent, modelFailures })}`);
  }
  const approval = terminalEvent.payload;
  check("delegate-write-raises-host-approval", approval.kind === "tool" &&
    approval.toolName === "Write" && approval.agentName === "ceiling-writer" &&
    approval.allowedDecisions.includes("allow-once") && childWriteCount === 1 &&
    childWriteArgs?.path === targetRelativePath,
  JSON.stringify({ kind: approval.kind, toolName: approval.toolName, agentName: approval.agentName, childWriteArgs }));
  check("target-does-not-exist-before-approval", !existsSync(targetPath));

  const queued = await owner.request("turn/start", {
    sessionId: created.session.id,
    admission: "queue",
    input: { text: `${scenarioMarker}: use ceiling-writer to create ${queuedTargetRelativePath} after Host restart` },
    context: { requestId: "permission-ceiling-queued-turn", idempotencyKey: "permission-ceiling-queued-turn-1" },
  });
  check("second-delegated-turn-is-queued-before-restart", queued.turn.status === "queued" &&
    queued.turn.effectivePermissionMode === "ask" && queued.turn.queuePosition === 1,
  JSON.stringify(queued.turn));

  await owner.close();
  clients.delete(owner);
  await stopHost(hostChild);
  hostChild = undefined;
  check("unapproved-first-write-did-not-reach-disk", !existsSync(targetPath) && !existsSync(queuedTargetPath));
  childWriteCount = 0;
  childWriteArgs = undefined;

  const restarted = await startHost(["--pair"]);
  hostChild = restarted.child;
  const restartedUrl = `ws://127.0.0.1:${restarted.ready.port}/v1/racp/ws`;
  check("host-identity-survives-restart", restarted.ready.hostId === boot.ready.hostId,
    `${boot.ready.hostId} → ${restarted.ready.hostId}`);
  const restartedEvents = eventCollector();
  const restartedOwner = makeClient(restartedUrl, paired.deviceToken, restartedEvents.onEvent);
  clients.add(restartedOwner);
  const restartedInit = await restartedOwner.connect();
  check("paired-owner-token-survives-restart", restartedInit.principal.roles.includes("owner") &&
    restartedInit.policy.applyCeilingToPairedDevices === true);
  await restartedOwner.request("events/subscribe", { scope: "session", sessionId: created.session.id });
  const reattached = await restartedOwner.request("session/attach", { sessionId: created.session.id });
  const restoredQueueEntry = reattached.snapshot.queuedTurns.find((turn) => turn.id === queued.turn.id);
  const restoredActiveTurn = reattached.snapshot.activeTurn?.id === queued.turn.id
    ? reattached.snapshot.activeTurn
    : undefined;
  check("queued-turn-restores-with-approval-ceiling", [restoredQueueEntry, restoredActiveTurn].some((turn) =>
    turn?.effectivePermissionMode === "ask"), JSON.stringify({
        replayComplete: reattached.replayComplete,
        queuedTurns: reattached.snapshot.queuedTurns.map((turn) => ({ id: turn.id, effectivePermissionMode: turn.effectivePermissionMode })),
        activeTurn: reattached.snapshot.activeTurn
          ? { id: reattached.snapshot.activeTurn.id, effectivePermissionMode: reattached.snapshot.activeTurn.effectivePermissionMode }
          : undefined,
      }));

  let restoredApprovalEvent;
  try {
    restoredApprovalEvent = await restartedEvents.waitFor(
      (event) => event.sessionId === created.session.id &&
        (event.kind === "approval.requested" || event.kind === "turn.failed"),
      "approval for the restored queued turn",
      30_000,
    );
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}; ${JSON.stringify({
      restoredEventKinds: restartedEvents.events.map((event) => event.kind),
      modelRequestCount: modelRequests.length,
      modelFailures,
      hostStderr: restarted.stderr(),
    })}`);
  }
  if (restoredApprovalEvent.kind === "turn.failed") {
    throw new Error(`restored queued turn failed before approval: ${JSON.stringify(restoredApprovalEvent.payload)}`);
  }
  const restoredApproval = restoredApprovalEvent.payload;
  check("restored-delegate-write-still-raises-approval", restoredApproval.kind === "tool" &&
    restoredApproval.toolName === "Write" && restoredApproval.agentName === "ceiling-writer" &&
    restoredApproval.turnId === queued.turn.id && restoredApproval.allowedDecisions.includes("allow-once") &&
    childWriteCount === 1 && childWriteArgs?.path === queuedTargetRelativePath,
  JSON.stringify({ kind: restoredApproval.kind, toolName: restoredApproval.toolName, agentName: restoredApproval.agentName, turnId: restoredApproval.turnId, childWriteArgs }));
  check("restored-target-does-not-exist-before-approval", !existsSync(queuedTargetPath));

  const resolved = await restartedOwner.request("approval/respond", {
    approvalId: restoredApproval.id,
    decision: "allow-once",
    context: { requestId: "permission-ceiling-restored-approval" },
  });
  check("restored-host-approval-is-allow-once", resolved.status === "resolved" &&
    resolved.decision === "allow-once" && resolved.alreadyResolved === false, JSON.stringify(resolved));

  const finished = await restartedEvents.waitFor(
    (event) => event.sessionId === created.session.id && event.turnId === queued.turn.id &&
      (event.kind === "turn.completed" || event.kind === "turn.failed"),
    "restored turn completion after approval",
  );
  if (finished.kind === "turn.failed") throw new Error(`restored turn failed after approval: ${JSON.stringify(finished.payload)}`);
  const onDisk = existsSync(queuedTargetPath) ? readFileSync(queuedTargetPath, "utf8") : undefined;
  const remoteRead = await restartedOwner.request("workspace/read", {
    sessionId: created.session.id,
    path: queuedTargetRelativePath,
  });
  check("approved-restored-write-reaches-workspace", onDisk === targetContents &&
    remoteRead.kind === "text" && remoteRead.content === targetContents,
  JSON.stringify({ onDisk, remoteReadKind: remoteRead.kind }));
  check("restored-queued-turn-used-one-write-and-one-approval", childWriteCount === 1 &&
    restartedEvents.events.filter((event) => event.sessionId === created.session.id && event.kind === "approval.requested").length === 1 &&
    modelRequests.length >= 3 && modelFailures.length === 0,
    JSON.stringify({ childWriteCount, modelRequests: modelRequests.length, modelFailures }));
} finally {
  for (const client of clients) await client.close().catch(() => undefined);
  await stopHost(hostChild);
  modelServer.closeAllConnections?.();
  await new Promise((resolveClose) => modelServer.close(() => resolveClose()));
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
  if (ownsBundle) rmSync(bundleDir, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.ok);
console.log(`RESULT ${results.length - failed.length}/${results.length} checks passed`);
if (failed.length > 0) process.exitCode = 1;
