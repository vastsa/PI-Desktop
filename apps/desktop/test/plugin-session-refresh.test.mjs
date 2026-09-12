import { readAppSourceSync, readMainSourceSync } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(here, "..");
const protocol = readFileSync(
  join(desktopRoot, "../../packages/shared/src/protocol.ts"),
  "utf8",
);
const api = readFileSync(join(desktopRoot, "src/lib/api.ts"), "utf8");
const app = readAppSourceSync();
const main = readMainSourceSync();

test("plugin session mutations use the host-owned renderer refresh event", () => {
  assert.match(protocol, /sessionsChanged:\s*"pi-desktop\/session\/event\/changed"/);
  assert.match(api, /onSessionsChanged:/);
  assert.match(api, /IPC\.event\.sessionsChanged/);
  assert.match(app, /const offSessionsChanged = api\.onSessionsChanged/);
  assert.match(
    app,
    /refreshSessions\(\s*revealImportedProjects \? \{ revealImportedProjects: true \} : undefined,\s*\)\s*\.then\(/,
  );
  assert.match(main, /method === "plugin\.session\.import"/);
  assert.match(main, /method === "plugin\.session\.importBatch"/);
  assert.match(main, /sendToRenderer\(IPC\.event\.sessionsChanged/);
});
