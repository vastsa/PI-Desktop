import assert from "node:assert/strict";
import { register } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// The module under test imports sibling TypeScript without extensions, the way
// the renderer bundle resolves it; the hook teaches node the same rule.
const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { projectRunningStatus } = await import("../src/lib/sidebar-project-status.ts");

const PROJECT = "/work/app";
const OTHER = "/work/other";

const statusFor = (input) =>
  projectRunningStatus({
    sessions: [],
    allSessions: [],
    projectPath: PROJECT,
    runningSessions: {},
    outcomes: {},
    ...input,
  });

test("a project row counts running conversations and scheduled runs separately", () => {
  const status = statusFor({
    sessions: [{ id: "a" }, { id: "b" }, { id: "c" }],
    allSessions: [
      { id: "a", projectPath: PROJECT, scheduledRun: false },
      { id: "b", projectPath: PROJECT, scheduledRun: false },
      { id: "c", projectPath: PROJECT, scheduledRun: false },
      { id: "run-1", projectPath: PROJECT, scheduledRun: true },
      { id: "run-elsewhere", projectPath: OTHER, scheduledRun: true },
    ],
    runningSessions: {
      a: true,
      c: true,
      "run-1": true,
      "run-elsewhere": true,
    },
  });

  assert.equal(status.running, 2);
  assert.equal(status.scheduledRunning, 1, "another project's run never counts here");
  assert.equal(status.total, 3);
  assert.equal(status.needsAttention, 0);
});

test("waiting for the reader is counted apart from running", () => {
  const status = statusFor({
    sessions: [{ id: "a" }, { id: "b" }],
    allSessions: [
      { id: "a", projectPath: PROJECT, scheduledRun: false },
      { id: "run-1", projectPath: PROJECT, scheduledRun: true },
    ],
    runningSessions: { a: true, "run-1": true },
    attentionSessionIds: ["b", "run-1"],
  });

  assert.equal(status.needsAttention, 2);
  assert.equal(status.total, 2);
  assert.equal(status.settled, false);
});

test("finished work settles only once nothing runs", () => {
  const settled = statusFor({
    sessions: [{ id: "a" }],
    allSessions: [{ id: "a", projectPath: PROJECT, scheduledRun: false }],
    outcomes: { a: "completed" },
  });
  assert.equal(settled.finished, 1);
  assert.equal(settled.failed, 0);
  assert.equal(settled.settled, true);

  const partial = statusFor({
    sessions: [{ id: "a" }, { id: "b" }],
    allSessions: [{ id: "a", projectPath: PROJECT, scheduledRun: false }],
    runningSessions: { b: true },
    outcomes: { a: "failed" },
  });
  assert.equal(partial.failed, 1);
  assert.equal(partial.settled, false, "work is still running");
});

test("results already read leave no project status behind", () => {
  const status = statusFor({
    sessions: [{ id: "a" }],
    allSessions: [{ id: "a", projectPath: PROJECT, scheduledRun: false }],
    outcomes: {},
  });

  assert.deepEqual(status, {
    running: 0,
    scheduledRunning: 0,
    needsAttention: 0,
    finished: 0,
    failed: 0,
    total: 0,
    settled: false,
  });
});

test("project matching ignores separators and trailing slashes", () => {
  const status = statusFor({
    projectPath: "C:\\work\\app",
    allSessions: [{ id: "run-1", projectPath: "C:/work/app/", scheduledRun: true }],
    runningSessions: { "run-1": true },
  });

  assert.equal(status.scheduledRunning, 1);
});

test("a scheduled run counts for its project while its transcript stays unlisted", () => {
  const status = statusFor({
    sessions: [],
    scheduledRuns: [
      { runId: "run-1", sessionId: "automation-1", status: "running", projectPath: PROJECT },
      { runId: "run-2", sessionId: "automation-2", status: "running", projectPath: OTHER },
    ],
  });

  assert.equal(status.scheduledRunning, 1);
  assert.equal(status.running, 0);
  assert.equal(status.total, 1);
});

test("a run the store already reports is not counted twice", () => {
  const status = statusFor({
    allSessions: [{ id: "automation-1", projectPath: PROJECT, scheduledRun: true }],
    runningSessions: { "automation-1": true },
    scheduledRuns: [
      { runId: "run-1", sessionId: "automation-1", status: "running", projectPath: PROJECT },
    ],
  });

  assert.equal(status.scheduledRunning, 1, "the store path wins, the broadcast does not add a second");
  assert.equal(status.total, 1);
});

test("a finished run reports through its unread result", () => {
  const status = statusFor({
    sessions: [],
    scheduledRuns: [
      { runId: "run-1", sessionId: "automation-1", status: "completed", projectPath: PROJECT },
    ],
    outcomes: { "automation-1": "completed" },
  });

  assert.equal(status.scheduledRunning, 0);
  assert.equal(status.finished, 1);
  assert.equal(status.settled, true);
});
