import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { capabilityQuery, deriveProjectOverrides } = await import(
  "../src/lib/capability-scope.ts"
);

test("a global capability query stays scope-free even with a project selected", () => {
  // #1957 regression: with project A selected and a legacy per-project
  // override underneath (the old UI wrote those), the switch must still write
  // the global default. A query carrying projectPath here would write an
  // override instead - a no-op click that reverted on the next refresh and
  // left the global default unreachable from any project.
  assert.deepEqual(capabilityQuery("global", "/projects/a"), { level: "global" });
  assert.deepEqual(capabilityQuery("global", null), { level: "global" });
});

test("a project capability query carries the selected project's path", () => {
  // The host resolves a project definition by scanning that project's
  // directory, so without the path the row cannot be found at all.
  assert.deepEqual(capabilityQuery("project", "/projects/a"), {
    level: "project",
    projectPath: "/projects/a",
  });
  // No selection, no path to attach.
  assert.deepEqual(capabilityQuery("project", null), { level: "project" });
});

test("stored per-project overrides are surfaced, not hidden, in both directions", () => {
  // vastsa's repro shape on #1964: an override written by the old UI keeps
  // runtime precedence for its project even after the global default moves.
  // Seeding persisted false and true overrides, the derived map must expose
  // exactly the rows whose effective state disagrees with the default - those
  // are the rows the settings page badges and offers a reset for.
  const defaults = [
    { id: "server-on", enabled: true },
    { id: "server-off", enabled: false },
    { id: "agreeing", enabled: true },
    { id: "missing", enabled: true },
  ];
  const effective = [
    // Off->On: the default is On, this project stored an Off override.
    { id: "server-on", enabled: false },
    // On->Off: the default is Off, this project stored an On override.
    { id: "server-off", enabled: true },
    // Agreeing rows and rows the project list does not know carry no override.
    { id: "agreeing", enabled: true },
  ];
  assert.deepEqual(
    [...deriveProjectOverrides(defaults, effective)],
    [
      ["server-on", "off"],
      ["server-off", "on"],
    ],
  );
  assert.deepEqual(deriveProjectOverrides([], effective), new Map());
});
