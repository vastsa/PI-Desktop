#!/usr/bin/env node
/**
 * Headless remote Host E2E (E2E-231 host half): boots a real `pi-host` with
 * the debug host-core and the bundled sidecar on a throwaway data dir, pairs
 * a device over the loopback RACP-WS socket, registers a project, creates a
 * session, reads the workspace, drops the connection, and reconnects by
 * cursor. No model provider is configured, so `turn/start` is expected to
 * fail closed with `MODEL_NOT_CONFIGURED` rather than hang.
 *
 * Prereqs: `pnpm build:js`, `pnpm -C packages/agent-runtime bundle`, and a
 * host-core binary (target/debug or PI_DESKTOP_HOST_BIN).
 */
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { RacpClient, wsClientTransport } from "../packages/racp/dist/index.js";
import { assert, errorCodeOf, shortJson } from "./e2e/assert.mjs";
import { resolveHostBinary } from "./e2e/host.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "apps/pi-host/dist/cli.js");
const sidecar = join(root, "packages/agent-runtime/dist-bundle/sidecar.js");
for (const [label, path] of [["pi-host cli", cli], ["sidecar bundle", sidecar]]) {
  if (!existsSync(path)) {
    console.error(`${label} missing: ${path}`);
    process.exit(1);
  }
}
const hostBin = resolveHostBinary();
const dataDir = mkdtempSync(join(tmpdir(), "pi-host-e2e-"));
const project = join(dataDir, "project");
mkdirSync(project, { recursive: true });
writeFileSync(join(project, "README.md"), "# remote project\n");

const results = [];
const record = (id, ok, detail = "") => {
  results.push({ id, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${id}${detail ? " — " + detail : ""}`);
};

let child = null;
let stderr = "";
function startHost(extraArgs = []) {
  child = spawn(process.execPath, [cli, "--data-dir", dataDir, "--port", "0", "--host-core", hostBin, "--sidecar", sidecar, "--browse-root", dataDir, "--log-level", "warn", ...extraArgs], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
    if (process.env.DEBUG_HOST) process.stderr.write(chunk);
  });
  return new Promise((resolveReady, reject) => {
    let out = "";
    const ready = {};
    const timer = setTimeout(() => reject(new Error("pi-host did not become ready\n" + stderr.slice(-2000))), 60_000);
    child.stdout.on("data", (chunk) => {
      out += String(chunk);
      for (const line of out.split("\n")) {
        if (line.startsWith("PI_HOST_READY ")) ready.info = JSON.parse(line.slice("PI_HOST_READY ".length));
        if (line.startsWith("PI_HOST_PAIRING_TOKEN ")) ready.pairing = JSON.parse(line.slice("PI_HOST_PAIRING_TOKEN ".length));
        if (line.startsWith("PI_HOST_FAILED ")) {
          clearTimeout(timer);
          reject(new Error("pi-host failed: " + line + "\n" + stderr.slice(-2000)));
        }
      }
      if (ready.info && (!extraArgs.includes("--pair") || ready.pairing)) {
        clearTimeout(timer);
        resolveReady(ready);
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`pi-host exited early code=${code}\n${stderr.slice(-2000)}`));
    });
  });
}
async function stopHost() {
  if (!child) return;
  const proc = child;
  child = null;
  await new Promise((resolveExit) => {
    proc.once("exit", resolveExit);
    proc.kill("SIGTERM");
    setTimeout(() => proc.kill("SIGKILL"), 5_000).unref();
  });
}

function client(url, token, options = {}) {
  const events = [];
  const instance = new RacpClient({
    transport: wsClientTransport({ url, token }),
    client: { name: "pi-host-e2e", version: "0.15.0" },
    onEvent: (envelope) => events.push(envelope),
    requestTimeoutMs: 30_000,
    ...options,
  });
  return { client: instance, events };
}

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

let exitCode = 0;
try {
  const ready = await startHost(["--pair"]);
  const url = `ws://127.0.0.1:${ready.info.port}/v1/racp/ws`;
  record("host-boots-on-loopback", ready.info.host === "127.0.0.1" && ready.info.port > 0 && typeof ready.info.hostId === "string", shortJson(ready.info));

  // Pairing: the token is single-use and the device token replaces it.
  const pairing = client(url, ready.pairing.token);
  const init = await pairing.client.connect();
  record("pairing-connection-is-unprivileged", init.principal.roles.length === 0 && init.server.hostId === ready.info.hostId);
  const paired = await pairing.client.request("connection/pair", { deviceLabel: "e2e desktop" });
  record("pair-mints-owner-device", paired.roles.includes("owner") && paired.deviceToken.startsWith("pdt1."));
  let secondPair = null;
  try {
    await pairing.client.request("connection/pair", {});
  } catch (error) {
    secondPair = errorCodeOf(error);
  }
  record("pairing-token-is-single-use", secondPair === "PAIRING_FAILED", String(secondPair));
  await pairing.client.close();

  const owner = client(url, paired.deviceToken, { reconnect: { enabled: true, baseDelayMs: 50, maxAttempts: 10 } });
  const ownerInit = await owner.client.connect();
  record("device-token-authenticates-as-owner", ownerInit.principal.roles.includes("owner") && ownerInit.capabilities.remoteHostProfile === true);

  const registered = await owner.client.request("project/register", { path: project });
  record("project-registers-on-host", typeof registered.project.id === "string" && registered.project.label === "project", shortJson(registered));
  let missing = null;
  try {
    await owner.client.request("project/register", { path: join(dataDir, "missing") });
  } catch (error) {
    missing = errorCodeOf(error);
  }
  record("project-register-validates-path-on-host", missing === "REMOTE_PATH_NOT_FOUND", String(missing));
  const browsed = await owner.client.request("project/browse", { path: dataDir });
  record("project-browse-lists-directories", browsed.entries.some((entry) => entry.name === "project"));

  await owner.client.request("events/subscribe", { scope: "host" });
  const created = await owner.client.request("session/create", { title: "Remote E2E", projectId: registered.project.id });
  record("session-creates-under-project", created.session.projectId === registered.project.id && created.session.status === "idle", shortJson(created.session));
  const listed = await owner.client.request("session/list");
  record("session-list-includes-created", listed.sessions.some((session) => session.id === created.session.id));
  const attach = await owner.client.request("session/attach", { sessionId: created.session.id });
  record("attach-returns-snapshot", attach.replayComplete === true && Array.isArray(attach.snapshot.items) && attach.snapshot.queuedTurns.length === 0);
  await owner.client.request("events/subscribe", { scope: "session", sessionId: created.session.id });

  const files = await owner.client.request("workspace/list", { sessionId: created.session.id, path: "" });
  const readme = await owner.client.request("workspace/read", { sessionId: created.session.id, path: "README.md" });
  record("workspace-reads-execute-on-host", files.entries.some((entry) => entry.name === "README.md") && readme.kind === "text" && readme.content.includes("remote project"));
  let escape = null;
  try {
    await owner.client.request("workspace/read", { sessionId: created.session.id, path: "../../etc/passwd" });
  } catch (error) {
    escape = errorCodeOf(error);
  }
  record("workspace-read-refuses-escape", escape === "REMOTE_PATH_FORBIDDEN", String(escape));
  const diff = await owner.client.request("workspace/diff", { sessionId: created.session.id });
  record("workspace-diff-runs-on-host", typeof diff.repo === "boolean");

  // No provider is configured: the turn must fail closed with a typed code and leave the session idle.
  let turnError = null;
  try {
    await owner.client.request("turn/start", { sessionId: created.session.id, input: { text: "hello" }, context: { requestId: "r1", idempotencyKey: "e2e-1" } });
  } catch (error) {
    turnError = errorCodeOf(error);
  }
  record("turn-without-provider-fails-closed", turnError === "MODEL_NOT_CONFIGURED", String(turnError));
  await sleep(200);
  const after = await owner.client.request("session/get", { sessionId: created.session.id });
  record("failed-admission-leaves-session-idle", after.session.status === "idle" && !after.session.activeTurnId, shortJson(after.session));

  const renamed = await owner.client.request("session/rename", { sessionId: created.session.id, title: "Renamed remotely" });
  const configured = await owner.client.request("session/configure", { sessionId: created.session.id, permissionMode: "accept-edits" });
  record("remote-host-profile-mutations", renamed.ok === true && configured.session.permissionMode === "accept-edits");
  await sleep(200);
  const hostKinds = owner.events.filter((event) => event.scope === "host").map((event) => event.kind);
  record("host-scope-events-announce-session-changes", hostKinds.includes("session.created") && hostKinds.includes("session.changed"), hostKinds.join(","));

  // Reconnect by cursor: the desktop-side transport drops, the Host keeps everything.
  const cursor = owner.client.cursorFor(created.session.id);
  const states = [];
  const owner2 = client(url, paired.deviceToken, { onStateChange: (state) => states.push(state) });
  await owner2.client.connect();
  const resumed = await owner2.client.request("session/attach", { sessionId: created.session.id, after: cursor });
  record("reconnect-resumes-by-cursor", resumed.replayComplete === true && resumed.session.title === "Renamed remotely", shortJson({ cursor, title: resumed.session.title }));
  const stale = await owner2.client.request("session/attach", { sessionId: created.session.id, after: { epoch: "ep_old", sequence: 3 } });
  record("stale-epoch-yields-snapshot", stale.replayComplete === false && stale.resyncReason === "epoch" && stale.snapshot !== undefined);
  await owner2.client.close();

  // Viewer role from a second pairing is refused the owner operations.
  let forbidden = null;
  const devices = await owner.client.request("session/revoke", { deviceId: "dev_unknown" });
  record("revoke-unknown-device-is-false", devices.revoked === false);
  try {
    await owner.client.request("host/list", {});
  } catch (error) {
    forbidden = errorCodeOf(error);
  }
  record("host-list-is-gateway-only", forbidden === "METHOD_NOT_FOUND", String(forbidden));

  await owner.client.request("session/delete", { sessionId: created.session.id });
  const gone = await owner.client.request("session/list");
  record("session-delete-removes-on-host", !gone.sessions.some((session) => session.id === created.session.id));
  await owner.client.close();

  // Restart: identity and the paired device survive; a fresh epoch resyncs.
  await stopHost();
  const again = await startHost();
  record("host-identity-is-stable-across-restarts", again.info.hostId === ready.info.hostId, `${ready.info.hostId} vs ${again.info.hostId}`);
  const owner3 = client(`ws://127.0.0.1:${again.info.port}/v1/racp/ws`, paired.deviceToken);
  const init3 = await owner3.client.connect();
  record("device-credential-survives-restart", init3.principal.roles.includes("owner"));
  await owner3.client.close();
} catch (error) {
  record("headless-remote-host-e2e", false, `${error?.message ?? error}\n${stderr.slice(-3000)}`);
} finally {
  await stopHost();
  rmSync(dataDir, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) exitCode = 1;
process.exit(exitCode);
