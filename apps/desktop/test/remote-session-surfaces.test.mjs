import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isRemoteSession, sessionSurfaceGates } from "../src/lib/session-capabilities.ts";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

const REMOTE_CAPABILITIES = {
  canPrompt: true,
  canAttach: false,
  canMentionFiles: false,
  canSelectModel: false,
  canSteer: false,
  canEditHistory: false,
  canTerminal: false,
};

test("a local session keeps every surface when no optional flag is set", () => {
  assert.deepEqual(sessionSurfaceGates({ source: "desktop", capabilities: { canPrompt: true } }), {
    remote: false,
    canAttach: true,
    canSelectModel: true,
    canSteer: true,
    canEditHistory: true,
    canTerminal: false,
    localFiles: true,
  });
  assert.equal(sessionSurfaceGates(undefined).canAttach, true);
});

test("a remote session turns off the surfaces its host cannot serve", () => {
  const gates = sessionSurfaceGates({ source: "remote", capabilities: REMOTE_CAPABILITIES });
  assert.deepEqual(gates, {
    remote: true,
    canAttach: false,
    canSelectModel: false,
    canSteer: false,
    canEditHistory: false,
    canTerminal: false,
    localFiles: false,
  });
  assert.equal(isRemoteSession({ source: "remote" }), true);
  assert.equal(isRemoteSession({ source: "pi-native" }), false);
  assert.equal(
    sessionSurfaceGates({ source: "remote", capabilities: { ...REMOTE_CAPABILITIES, canTerminal: true } }).canTerminal,
    true,
  );
});

test("a native pi session keeps its own model and attachment rules", () => {
  const gates = sessionSurfaceGates({ source: "pi-native", capabilities: { canPrompt: true } });
  assert.equal(gates.canAttach, false);
  assert.equal(gates.canSelectModel, false);
  assert.equal(gates.localFiles, true);
});

test("selecting a remote session leaves the local workspace alone", () => {
  const slice = read("../src/stores/slices/session-slice.ts");
  assert.match(slice, /if \(isRemoteSession\(summary\)\) \{/);
  assert.match(slice, /!isRemoteSession\(detail\?\.session\) &&\s*!\(await runtime\.queueWorkspaceAlignment/);
  const runtime = read("../src/stores/runtime/session-runtime.ts");
  assert.match(runtime, /!isRemoteSession\(session\) && sessionMatchesProject\(session, projectPath\)/);
});

test("the sidebar lists remote sessions only under their host", () => {
  const sidebar = read("../src/components/Sidebar.tsx");
  assert.match(sidebar, /!isRemoteSession\(session\) && !normalizeProjectPath\(session\.projectPath\)/);
  assert.match(sidebar, /filtered\.filter\(isRemoteSession\)/);
  assert.match(sidebar, /<RemoteHostSessions/);
  assert.match(sidebar, /settings\?\.developerMode === true && !isRemoteSession\(session\)/);
  const section = read("../src/components/sidebar/RemoteHostSessions.tsx");
  assert.match(section, /if \(hosts\.length === 0\) return null;/);
  assert.match(section, /api\.onSessionsChanged\(load\)/);
});

test("the files panel browses a remote session through the session", () => {
  const files = read("../src/components/workpanel/FilesTab.tsx");
  assert.match(files, /api\.fsList\(rel, sessionArg\)/);
  assert.match(files, /api\.fsRead\(rel, mimeType, sessionArg\)/);
  assert.match(files, /\{remoteSessionId \? null : \(/);
});

test("remote Review shows the Host working-tree diff beside recorded changes", () => {
  const review = read("../src/components/workpanel/ReviewTab.tsx");
  assert.match(review, /workspaceDiff\(remoteSessionId\)/);
  assert.match(review, /<WorkspaceDiffFileCard/);
  assert.match(review, /review-remote-history/);
  assert.match(review, /setRefreshVersion/);
});

test("remote review cards do not offer an unsupported rollback action", () => {
  const card = read("../src/components/ReviewChangeCard.tsx");
  assert.match(card, /const canRollback = useAppStore/);
  assert.match(card, /change\.reversible && canRollback/);
  assert.match(card, /panel\.review\.rollbackUnavailable/);
});
