#!/usr/bin/env node
/**
 * Acceptance journey for PR #2382 / issue #2370: "paired host" integration
 * across the real renderer/Host boundaries — no RPC mocks anywhere.
 *
 *   A. Real Rust host binary (PI_HOST_CORE_BINARY, stdio JSON-RPC):
 *      projects.create → session.create in two projects → session.list
 *      through `withSessionProjectIds` — the per-record decoration guard keeps
 *      each session's project identity in a mixed batch (no cross-record
 *      overwrite), then a real attach (`session.get`) round-trips.
 *
 *   B. Real paired-host journey: boots the real `pi-host` CLI on loopback with
 *      the same Rust binary, pairs a device over the real RACP-WS socket using
 *      the production Main modules (`exchangePairingToken`,
 *      `createRemoteHostsBoot`), registers two projects, creates sessions,
 *      lists them through the production catalog, attaches through the
 *      production Main history module (`createRemoteHistory` →
 *      `session/attach` with includeSnapshot), reconciles the returned
 *      SessionDetail into the renderer session list exactly like the
 *      production selectSession remote branch, and verifies the project
 *      grouping contract over that post-attach store state: one group per
 *      project, exclusive membership, sorted rows, distinct `remote::`
 *      collapse keys. Negative controls: removing the get-side project
 *      decoration must break the grouping, and a forced failed check must
 *      fail the process exit even when finish(0) is requested. The fold is
 *      driven by the real store action (`setProjectCollapsed`) and the
 *      rendered groups must consume the restored collapse state.
 *
 * Prereqs: `pnpm build:js`, `pnpm -C packages/agent-runtime bundle`, and a
 * host-core binary (`cargo build`); point PI_HOST_CORE_BINARY (or
 * PI_DESKTOP_HOST_BIN) at `target/debug/pi-desktop-host-core`.
 *
 * Exit code 0 = PASS, 1 = FAIL (reason on stderr); any failed check forces a
 * non-zero exit regardless of the requested code.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(join(here, ".."));
register(
  new URL("../apps/desktop/test/helpers/ts-import-hooks.mjs", import.meta.url),
);

const { HostProcess, withSessionProjectIds } =
  await import("../packages/host-runtime/dist/index.js");
const { createRemoteHostsBoot } =
  await import("../apps/desktop/electron/main/bootstrap/remote-hosts.ts");
const { exchangePairingToken } =
  await import("../apps/desktop/electron/main/remote/racp-remote-host-client.ts");
const { createBackendRouter } =
  await import("../apps/desktop/electron/main/remote/backend-router.ts");
const {
  groupRemoteProjectSessions,
  remoteProjectKey,
  remoteProjectCollapseKey,
} = await import("../apps/desktop/src/lib/remote-project-catalog.ts");
const { writeSidebarBackup, readSidebarBackup } =
  await import("../apps/desktop/electron/main/sidebar-preferences.ts");
// Production attach path: session/attach with includeSnapshot — the exact
// module behind IPC.invoke.sessionGet on the Main side.
const { createRemoteHistory } =
  await import("../apps/desktop/electron/main/remote/remote-history.ts");
const { createRacpRemoteHostClient } =
  await import("../apps/desktop/electron/main/remote/racp-remote-host-client.ts");
const { parseRemoteSessionId } =
  await import("../apps/desktop/electron/main/remote/backend-router.ts");
const { wsClientTransport } = await import("@pi-desktop/racp");
// Production renderer-store pieces: the reconcile a remote SessionDetail goes
// through when selected, and the sidebar collapse store action.
const { safeSessionSummary } =
  await import("../apps/desktop/src/lib/remote-session-safety.ts");
const {
  decorateSessions,
  preferencesFromState,
  withoutRecordKey,
  withProjectDisplayName,
  promoteProjectPath,
  removeProjectPath,
  upsertWorkspace,
} = await import("../apps/desktop/src/stores/helpers/store-helpers.ts");
const { createProjectSlice } =
  await import("../apps/desktop/src/stores/slices/project-slice.ts");

const results = [];
const record = (id, ok, detail = "") => {
  results.push({ id, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${id}${detail ? ` — ${detail}` : ""}`);
};
function finish(code) {
  // The requested exit code alone never decides the outcome: a single failed
  // check turns the process status into failure, whatever the caller asked for.
  const failed = results.filter((row) => !row.ok);
  const ok = code === 0 && failed.length === 0;
  console.log(
    `\n${ok ? "ACCEPTANCE PASS" : "ACCEPTANCE FAIL"}: ${results.length - failed.length}/${results.length} checks`,
  );
  process.exit(ok ? 0 : 1);
}

// Negative self-check mode: a forced `record(..., false)` must make the
// process fail even though the caller requests exit 0. The main run below
// spawns itself with this flag and requires a non-zero exit.
if (process.argv.includes("--self-check-finish")) {
  record("forced-regression", false);
  finish(0);
}

const selfCheck = spawn(
  process.execPath,
  [fileURLToPath(import.meta.url), "--self-check-finish"],
  { stdio: ["ignore", "pipe", "pipe"] },
);
let selfCheckOutput = "";
selfCheck.stdout.on("data", (chunk) => {
  selfCheckOutput += String(chunk);
});
selfCheck.stderr.on("data", (chunk) => {
  selfCheckOutput += String(chunk);
});
const selfCheckExit = await new Promise((resolveExit) =>
  selfCheck.once("exit", resolveExit),
);
record(
  "negative-forced-record-failure-fails-process",
  selfCheckExit !== 0 &&
    selfCheckOutput.includes("FAIL forced-regression") &&
    selfCheckOutput.includes("ACCEPTANCE FAIL"),
  `self-check exit=${selfCheckExit}`,
);

const hostBin = resolve(
  process.env.PI_HOST_CORE_BINARY ?? process.env.PI_DESKTOP_HOST_BIN ?? "",
);
if (!hostBin) {
  console.error(
    "PI_HOST_CORE_BINARY (or PI_DESKTOP_HOST_BIN) must name the built host-core binary",
  );
  process.exit(1);
}
assert.ok(process.env.PI_SCRATCH_DIR ?? true);

const scratch = mkdtempSync(
  join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "project-groups-journey-"),
);
const projectOne = join(scratch, "project-one");
const projectTwo = join(scratch, "project-two");
mkdirSync(projectOne, { recursive: true });
mkdirSync(projectTwo, { recursive: true });
writeFileSync(join(projectOne, "README.md"), "# one\n");
writeFileSync(join(projectTwo, "README.md"), "# two\n");

const cleanups = [];
process.on("exit", () => {
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {}
});

// ---------------------------------------------------------------------------
// Phase A — real host binary over stdio JSON-RPC (production Main↔Host port)
// ---------------------------------------------------------------------------
let localHost;
try {
  localHost = new HostProcess({
    binaryPath: hostBin,
    dataDir: join(scratch, "local-host-data"),
    onStderr: () => {},
  });
  cleanups.push(() => localHost?.dispose());
  await localHost.handshake();
  record("host-binary-handshake", true, hostBin);

  const created1 = await localHost.call("projects.create", {
    path: projectOne,
  });
  const created2 = await localHost.call("projects.create", {
    path: projectTwo,
  });
  const projectOneId = String(created1.project.id);
  const projectTwoId = String(created2.project.id);
  assert.notEqual(projectOneId, projectTwoId);
  record(
    "host-binary-projects-create",
    true,
    `${projectOneId} / ${projectTwoId}`,
  );

  const sessionOneA = await localHost.call("session.create", {
    projectPath: projectOne,
    mode: "agent",
  });
  const sessionOneB = await localHost.call("session.create", {
    projectPath: projectOne,
    mode: "agent",
  });
  const sessionTwoA = await localHost.call("session.create", {
    projectPath: projectTwo,
    mode: "agent",
  });
  record(
    "host-binary-sessions-create",
    true,
    `${sessionOneA.session.id}, ${sessionOneB.session.id}, ${sessionTwoA.session.id}`,
  );

  // Mixed batch: the per-record guard must keep each row's project identity.
  const listed = await localHost.call("session.list", {});
  const summaries = await withSessionProjectIds(localHost, listed.sessions);
  const byId = new Map(summaries.map((row) => [row.id, row]));
  const identity = [
    [sessionOneA.session.id, projectOneId, projectOne],
    [sessionOneB.session.id, projectOneId, projectOne],
    [sessionTwoA.session.id, projectTwoId, projectTwo],
  ];
  const bad = identity.filter(
    ([id, projectId]) => byId.get(id)?.projectId !== projectId,
  );
  record(
    "mixed-batch-keeps-per-record-project-identity",
    bad.length === 0 && summaries.length === 3,
    bad.length
      ? `overwritten rows: ${bad.map(([id]) => id).join(",")}`
      : `${summaries.length} rows`,
  );
  const identities = new Set(
    identity
      .map(
        ([, , path]) =>
          byId.get(identity.find(([id]) => byId.get(id)?.workspaceLabel)?.[0])
            ?.workspaceIdentity,
      )
      .filter(Boolean),
  );
  const distinctIdentity = new Set(
    summaries.map((row) => row.workspaceIdentity).filter(Boolean),
  );
  record(
    "workspace-identity-fingerprint-per-project",
    distinctIdentity.size === 2,
    `${distinctIdentity.size} distinct fingerprints`,
  );

  // Attach through the real binary.
  const attached = await localHost.call("session.get", {
    id: sessionOneA.session.id,
    messageLimit: 1,
  });
  record(
    "host-binary-attach-round-trip",
    attached.session?.id === sessionOneA.session.id &&
      Array.isArray(attached.session?.messages),
    attached.session?.id ?? "no session",
  );
} catch (error) {
  record("phase-a-real-host-binary", false, String(error?.stack ?? error));
  finish(1);
} finally {
  await localHost?.dispose().catch(() => {});
  localHost = undefined;
}

// ---------------------------------------------------------------------------
// Phase B — paired-host journey: real pi-host + real Main modules + real RACP
// ---------------------------------------------------------------------------
let child = null;
let piStderr = "";
function startPairedHost() {
  const cli = join(root, "apps/pi-host/dist/cli.js");
  const sidecar = join(root, "packages/agent-runtime/dist-bundle/sidecar.js");
  child = spawn(
    process.execPath,
    [
      cli,
      "--data-dir",
      join(scratch, "pi-host-data"),
      "--port",
      "0",
      "--host-core",
      hostBin,
      "--sidecar",
      sidecar,
      "--browse-root",
      scratch,
      "--log-level",
      "warn",
      "--pair",
    ],
    { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env } },
  );
  child.stderr.on("data", (chunk) => {
    piStderr += String(chunk);
  });
  return new Promise((resolveReady, reject) => {
    let out = "";
    const info = {};
    const timer = setTimeout(
      () => reject(new Error("pi-host not ready\n" + piStderr.slice(-2000))),
      90_000,
    );
    child.stdout.on("data", (chunk) => {
      out += String(chunk);
      for (const line of out.split("\n")) {
        if (line.startsWith("PI_HOST_READY "))
          info.ready = JSON.parse(line.slice(14));
        if (line.startsWith("PI_HOST_PAIRING_TOKEN "))
          info.pairing = JSON.parse(line.slice(22));
        if (line.startsWith("PI_HOST_FAILED ")) {
          clearTimeout(timer);
          reject(new Error(line));
        }
      }
      if (info.ready && info.pairing) {
        clearTimeout(timer);
        resolveReady(info);
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(
        new Error(
          `pi-host exited early code=${code}\n${piStderr.slice(-2000)}`,
        ),
      );
    });
  });
}
async function stopPairedHost() {
  if (!child) return;
  const proc = child;
  child = null;
  await new Promise((resolveExit) => {
    proc.once("exit", resolveExit);
    proc.kill("SIGTERM");
    setTimeout(() => proc.kill("SIGKILL"), 5000).unref();
  });
}
cleanups.push(() => stopPairedHost());

let boot;
try {
  const ready = await startPairedHost();
  const url = `ws://127.0.0.1:${ready.ready.port}/v1/racp/ws`;
  record(
    "paired-host-boots-on-loopback",
    ready.ready.host === "127.0.0.1" && ready.ready.port > 0,
    url,
  );

  const clientInfo = { name: "project-groups-journey", version: "0.0.0" };
  const deviceToken = await exchangePairingToken({
    url,
    pairingToken: ready.pairing.token,
    clientInfo,
    label: "journey desktop",
  });
  record(
    "pairing-exchanges-owner-device-token",
    deviceToken.startsWith("pdt1."),
    `${deviceToken.length} chars`,
  );

  const desktopDataDir = join(scratch, "desktop");
  mkdirSync(desktopDataDir, { recursive: true });
  boot = createRemoteHostsBoot({
    dataDir: desktopDataDir,
    router: createBackendRouter(),
    clientInfo,
    emit: () => {},
    encryption: {
      isAvailable: () => true,
      encryptString: (value) => Buffer.from(value),
      decryptString: (value) => value.toString(),
    },
  });
  cleanups.push(() => boot?.closeAll().catch(() => {}));
  const host = await boot.addHost({
    hostKey: "journey",
    label: "Journey Host",
    url,
    deviceToken,
  });
  record("paired-host-connects", host.connected === true, host.status ?? "");

  const registered1 = await boot.registerProject("journey", projectOne);
  const registered2 = await boot.registerProject("journey", projectTwo);
  record(
    "projects-register-on-paired-host",
    Boolean(registered1.id) &&
      Boolean(registered2.id) &&
      registered1.id !== registered2.id,
    `${registered1.id} / ${registered2.id}`,
  );

  const createdOneA = await boot.createSession({
    hostKey: "journey",
    projectId: registered1.id,
    title: "One A",
  });
  const createdOneB = await boot.createSession({
    hostKey: "journey",
    projectId: registered1.id,
    title: "One B",
  });
  const createdTwoA = await boot.createSession({
    hostKey: "journey",
    projectId: registered2.id,
    title: "Two A",
  });
  record(
    "sessions-create-under-projects",
    createdOneA.source === "remote" && createdTwoA.source === "remote",
    `${createdOneA.id}, ${createdOneB.id}, ${createdTwoA.id}`,
  );

  // sessions list through the production catalog, over the real socket.
  const sessions = await boot.sessions("journey");
  record(
    "sessions-list-over-real-transport",
    sessions.length === 3,
    `${sessions.length} summaries`,
  );
  const projectOf = (id) =>
    sessions.find((row) => row.id === id)?.remoteProjectId;
  const identityRows = [
    [createdOneA.id, registered1.id],
    [createdOneB.id, registered1.id],
    [createdTwoA.id, registered2.id],
  ];
  const overwritten = identityRows.filter(
    ([id, projectId]) => projectOf(id) !== projectId,
  );
  record(
    "remote-summaries-keep-per-record-project-identity",
    overwritten.length === 0,
    overwritten.length
      ? `overwritten: ${overwritten.map(([id]) => id).join(",")}`
      : "identities intact",
  );
  record(
    "remote-summaries-carry-host-and-source",
    sessions.every(
      (row) =>
        row.source === "remote" &&
        row.remoteHostKey === "journey" &&
        row.remoteHostLabel === "Journey Host",
    ),
    "",
  );

  // Attach through the production Main path: a second real RACP client over
  // the paired socket, driven through `createRemoteHistory` — the exact module
  // IPC.invoke.sessionGet uses. With no `messageBefore`, it requests
  // `session/attach` with includeSnapshot and returns the snapshot-derived
  // SessionDetail (`racpSessionToSummary` applies the get-side project
  // decoration: remoteProjectId = snapshot.session.projectId).
  const attachClient = createRacpRemoteHostClient({
    transport: wsClientTransport({ url, token: deviceToken }),
    clientInfo,
    log: () => {},
  });
  cleanups.push(() => attachClient?.close().catch(() => {}));
  await attachClient.connect();
  const attachHostSessionId = parseRemoteSessionId(
    createdOneA.id,
  )?.hostSessionId;
  record(
    "attach-uses-production-remote-session-id",
    createdOneA.id.startsWith("remote:journey:") &&
      Boolean(attachHostSessionId),
    createdOneA.id,
  );

  const attachSnapshots = [];
  const remoteHistory = createRemoteHistory({
    client: attachClient.client,
    hostLabel: "Journey Host",
    onSnapshot: (snapshot) => attachSnapshots.push(snapshot),
  });
  const attachDetail = await remoteHistory.read(
    createdOneA.id,
    attachHostSessionId,
    { messageLimit: 24 },
  );
  record(
    "attach-production-session-attach-snapshot",
    attachSnapshots.length === 1 &&
      attachSnapshots[0]?.session?.id === attachHostSessionId &&
      attachDetail?.id === createdOneA.id &&
      Array.isArray(attachDetail?.messages),
    `snapshot.session=${attachSnapshots[0]?.session?.id}, messages=${attachDetail?.messages?.length}`,
  );

  // Renderer store reconcile: exactly what the production selectSession remote
  // branch does with a freshly loaded remote SessionDetail — the summary part
  // of the detail replaces the cached entry in `sessions`
  // (session-slice.ts: safeSessionSummary(summary) + filter by id).
  const reconcileIntoStore = (sessions, summary) =>
    decorateSessions(
      [
        safeSessionSummary(summary),
        ...sessions.filter((session) => session.id !== summary.id),
      ],
      {},
    );
  const storeAfterAttach = reconcileIntoStore(sessions, attachDetail);
  const reconciled = storeAfterAttach.find((row) => row.id === createdOneA.id);
  record(
    "attach-detail-reconciled-keeps-project-identity",
    storeAfterAttach.length === 3 &&
      reconciled?.remoteProjectId === registered1.id &&
      reconciled?.remoteHostKey === "journey",
    `remoteProjectId=${reconciled?.remoteProjectId}`,
  );

  // Renderer grouping contract over the post-attach store state (not the
  // pre-attach inventory): the attached summary's project identity decides
  // which group the session lands in.
  const compare = (left, right) =>
    (left.title ?? "").localeCompare(right.title ?? "");
  const groups = groupRemoteProjectSessions(storeAfterAttach, compare);
  record(
    "groups-one-per-project",
    groups.length === 2,
    `${groups.length} groups`,
  );
  const membership = groups.map((group) => ({
    projectId: group.project.projectId,
    ids: group.sessions.map((row) => row.id).sort(),
  }));
  const idsOne = [createdOneA.id, createdOneB.id].sort();
  const idsTwo = [createdTwoA.id].sort();
  const exclusive =
    membership.length === 2 &&
    membership.some(
      (group) => JSON.stringify(group.ids) === JSON.stringify(idsOne),
    ) &&
    membership.some(
      (group) => JSON.stringify(group.ids) === JSON.stringify(idsTwo),
    );
  record(
    "group-membership-exclusive-and-complete",
    exclusive,
    JSON.stringify(membership),
  );
  const sortedInside = groups.every((group) =>
    group.sessions.every(
      (row, index, rows) => index === 0 || compare(rows[index - 1], row) <= 0,
    ),
  );
  record("group-rows-sorted", sortedInside, "");
  const groupKeys = groups.map((group) => group.project.key);
  record(
    "group-keys-are-host-project-pairs",
    groupKeys.length === new Set(groupKeys).size,
    JSON.stringify(groupKeys),
  );

  const collapseKeys = groupKeys.map((key) => remoteProjectCollapseKey(key));
  record(
    "collapse-keys-remote-namespaced-and-unique",
    collapseKeys.every((key) => key.startsWith("remote::")) &&
      collapseKeys.length === new Set(collapseKeys).size,
    JSON.stringify(collapseKeys),
  );

  // Negative control: without the get-side project decoration the attach
  // summary carries no remoteProjectId, so the reconcile must drop the
  // session out of its project group — the grouping contract must fail.
  const undecorated = safeSessionSummary({
    ...attachDetail,
    remoteProjectId: undefined,
  });
  const storeWithoutDecoration = reconcileIntoStore(sessions, undecorated);
  const brokenGroups = groupRemoteProjectSessions(
    storeWithoutDecoration,
    compare,
  );
  const brokenExclusive =
    brokenGroups.length === 2 &&
    brokenGroups.some(
      (group) =>
        JSON.stringify(group.sessions.map((row) => row.id).sort()) ===
        JSON.stringify(idsOne),
    ) &&
    brokenGroups.some(
      (group) =>
        JSON.stringify(group.sessions.map((row) => row.id).sort()) ===
        JSON.stringify(idsTwo),
    );
  record(
    "negative-get-side-decoration-removed-breaks-grouping",
    !brokenExclusive,
    `without decoration: exclusive=${brokenExclusive}, groups=${brokenGroups.length}`,
  );

  // Fold persistence driven by the real renderer store action
  // (project-slice.setProjectCollapsed), whose persist hook runs the real
  // Main sidebar-preferences serialization; the restart consumes the restored
  // `projectMeta` the way createInitialState rebuilds `projectCollapsed`.
  const foldStore = (() => {
    let state = {
      sessionMeta: {},
      projectMeta: {},
      projectCollapsed: {},
      projectSort: "recent",
      sessionView: { sort: "recent", archived: false },
      openProjectPaths: [],
    };
    const get = () => state;
    const set = (update) => {
      state = {
        ...state,
        ...(typeof update === "function" ? update(state) : update),
      };
    };
    const slice = createProjectSlice({
      get,
      set,
      runtime: {},
      withoutRecordKey,
      withProjectDisplayName,
      promoteProjectPath,
      removeProjectPath,
      upsertWorkspace,
      persistCurrentSidebar: (getNow) =>
        writeSidebarBackup(desktopDataDir, preferencesFromState(getNow())),
    });
    return { slice, get };
  })();
  for (const key of collapseKeys)
    foldStore.slice.setProjectCollapsed(key, true);
  record(
    "collapse-store-action-marks-folded-in-state",
    collapseKeys.every((key) => foldStore.get().projectCollapsed[key] === true),
    JSON.stringify(Object.keys(foldStore.get().projectCollapsed)),
  );

  // Restart: the store rebuilds from the persisted preferences, and the
  // rendered groups consume that restored state.
  const restoredPrefs = readSidebarBackup(desktopDataDir);
  const restoredProjectMeta = restoredPrefs.projectMeta ?? {};
  const restoredCollapsed = Object.fromEntries(
    Object.entries(restoredProjectMeta)
      .filter(([, meta]) => meta?.collapsed === true)
      .map(([key]) => [key, true]),
  );
  record(
    "collapse-state-persists-across-restart",
    collapseKeys.every((key) => restoredCollapsed[key] === true),
    JSON.stringify(Object.keys(restoredCollapsed)),
  );
  const renderedGroups = groups.map((group) => ({
    collapseKey: remoteProjectCollapseKey(group.project.key),
    collapsed:
      restoredCollapsed[remoteProjectCollapseKey(group.project.key)] === true,
  }));
  record(
    "rendered-groups-consume-restored-collapse-state",
    renderedGroups.length === 2 &&
      renderedGroups.every((group) => group.collapsed),
    JSON.stringify(renderedGroups),
  );
  const leakedLocal = Object.keys(restoredProjectMeta).filter(
    (key) => !key.startsWith("remote::"),
  );
  record(
    "collapse-namespace-has-no-local-path-leak",
    leakedLocal.length === 0,
    JSON.stringify(leakedLocal),
  );

  console.log("\nJOURNEY EVIDENCE");
  console.log(
    JSON.stringify(
      {
        hostBinary: hostBin,
        pairedHost: { url, hostId: ready.ready.hostId },
        groups: groups.map((group) => ({
          collapseKey: remoteProjectCollapseKey(group.project.key),
          hostLabel: group.project.hostLabel,
          connected: group.project.connected,
          sessions: group.sessions.map((row) => row.title),
        })),
        persistedCollapsedKeys: Object.keys(restoredCollapsed),
      },
      null,
      2,
    ),
  );
} catch (error) {
  record(
    "phase-b-paired-host-journey",
    false,
    String(error?.stack ?? error) +
      (piStderr ? `\npi-host stderr: ${piStderr.slice(-1500)}` : ""),
  );
  finish(1);
} finally {
  await boot?.closeAll().catch(() => {});
  boot = undefined;
  await stopPairedHost();
}
finish(0);
