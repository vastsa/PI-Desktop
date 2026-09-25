import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const { IPC } = await import("@pi-desktop/shared");
const { registerTerminalIpc } = await import("../electron/main/ipc/terminal-ipc.ts");

test("terminal IPC registers only remote operations and fails local calls closed", async () => {
  const handlers = new Map();
  registerTerminalIpc({
    registrar: {
      handle: (channel, handler) => handlers.set(channel, handler),
    },
  });

  const channels = [
    IPC.invoke.remoteTerminalOpen,
    IPC.invoke.remoteTerminalInput,
    IPC.invoke.remoteTerminalResize,
    IPC.invoke.remoteTerminalClose,
  ];
  assert.deepEqual([...handlers.keys()].sort(), [...channels].sort());
  for (const channel of channels) {
    await assert.rejects(
      handlers.get(channel)({ sessionId: "local-session" }),
      (error) => error.errorCode === "CAPABILITY_UNAVAILABLE",
      channel,
    );
    await assert.rejects(
      handlers.get(channel)({}),
      (error) => error.errorCode === "CAPABILITY_UNAVAILABLE",
      channel,
    );
  }
});

test("the main IPC registrar installs the fail-closed terminal handlers", async () => {
  const source = await readFile(
    new URL("../electron/main/ipc/register.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /import \{ registerTerminalIpc \} from "\.\/terminal-ipc"/);
  assert.match(source, /registerTerminalIpc\(\{ registrar \}\)/);
});
