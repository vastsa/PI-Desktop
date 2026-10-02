import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveSidecarEntry } from "../electron/main/agent-sidecar-entry.mjs";

test("resolves the agent sidecar from the built main-process chunk directory", () => {
  const repository = "/repo";
  const moduleUrl = pathToFileURL(
    join(repository, "apps/desktop/out/main/chunks/index.js"),
  ).href;
  const expected = join(repository, "packages/agent-runtime/dist/sidecar.js");
  const checked = [];

  const resolved = resolveSidecarEntry(moduleUrl, "/resources", (candidate) => {
    checked.push(candidate);
    return candidate === expected;
  });

  assert.equal(resolved, expected);
  assert.ok(
    checked.includes(join(repository, "apps/packages/agent-runtime/dist/sidecar.js")),
  );
});

test("prefers the packaged sidecar resource", () => {
  const packaged = "/app/resources/agent-runtime/sidecar.js";

  assert.equal(
    resolveSidecarEntry("file:///app/out/main/index.js", "/app/resources", (candidate) =>
      candidate === packaged,
    ),
    packaged,
  );
});

test("reports checked paths when no sidecar entry exists", () => {
  assert.throws(
    () => resolveSidecarEntry("file:///repo/apps/desktop/out/main/index.js", "", () => false),
    /Unable to locate agent sidecar entry.*packages\/agent-runtime\/dist\/sidecar\.js/,
  );
});
