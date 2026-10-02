import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const { trayVisibleSessions } = await import("../electron/main/tray-sessions.ts");

/** Only the fields the tray reads; the host owns the real payload. */
const session = (id, scheduledRun) => ({
  id,
  title: id,
  mode: "agent",
  updatedAt: "2026-10-02T00:00:00Z",
  ...(scheduledRun === undefined ? {} : { scheduledRun }),
});

test("the tray never offers a scheduled run's transcript", () => {
  const listed = [session("plain"), session("automation", true), session("legacy")];

  assert.deepEqual(
    trayVisibleSessions(listed).map((item) => item.id),
    ["plain", "legacy"],
    "a run's transcript leaves the tray's recents, a legacy summary without the flag stays",
  );
  assert.deepEqual(trayVisibleSessions([]), []);
  assert.equal(
    trayVisibleSessions(listed).some((item) => item.scheduledRun === true),
    false,
  );
});
