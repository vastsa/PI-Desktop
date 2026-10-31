/**
 * The send-time slash resolver must agree with the menu: a remote session's
 * runtime never receives the local-only visualize skill, so `/skill:...` for
 * it must not resolve there either.
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const load = (relative) => import(pathToFileURL(join(here, relative)).href);

const { resolveComposerCommand } = await load("../src/hooks/use-composer-autocomplete.ts");
const { api } = await load("../src/lib/api.ts");
const { useAppStore } = await load("../src/stores/app-store.ts");

const VISUALIZE = { name: "skill:pi-desktop/visualize", kind: "skill", title: "Visualize", skillId: "pi-desktop/visualize" };
const MINE = { name: "skill:mine", kind: "skill", title: "Mine", skillId: "mine" };

async function withCommands(body) {
  const original = api.composerCommands;
  api.composerCommands = async () => ({ commands: [VISUALIZE, MINE] });
  try {
    return await body();
  } finally {
    api.composerCommands = original;
  }
}

test("a remote session does not resolve the visualize skill at send time", async () => {
  useAppStore.setState({
    workspace: { path: "/gen-ui-remote-resolve" },
    activeSessionId: "s-remote",
    sessions: [{ id: "s-remote", remoteWorkspace: { hostId: "h", path: "/srv" } }],
  });
  await withCommands(async () => {
    assert.equal((await resolveComposerCommand(VISUALIZE.name)).status, "unknown");
    assert.equal((await resolveComposerCommand(MINE.name)).status, "resolved");
  });
});

test("a local session still resolves the visualize skill", async () => {
  useAppStore.setState({
    workspace: { path: "/gen-ui-local-resolve" },
    activeSessionId: "s-local",
    sessions: [{ id: "s-local" }],
  });
  await withCommands(async () => {
    const resolution = await resolveComposerCommand(VISUALIZE.name);
    assert.equal(resolution.status, "resolved");
    assert.equal(resolution.command.skillId, "pi-desktop/visualize");
  });
});
