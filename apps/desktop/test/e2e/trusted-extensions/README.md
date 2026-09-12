# Trusted extensions E2E harness (E2E-241 to E2E-245)

Drives the real desktop app end to end through the local MCP control plane
against a deterministic OpenAI-compatible stub. Not part of `pnpm test`;
run it by hand (or from a release checklist) on a machine with a built
`host-core` binary and a built desktop bundle.

What it proves, per run:

- six fixture plugins contributing `agentExtensions` under `agent.extension`,
  one limited to the fixture project, and the plugin rows' `agentExtension`
  state / diagnostics (E2E-241);
- `registerTool` through ToolSearch activation, `tool_call` blocking,
  `tool_result` replacement, `before_agent_start`, provider header and
  request hooks, lifecycle hooks (E2E-242);
- slash commands in the composer menu and global search, a command with
  `ui.input` / `ui.select` / `ui.confirm` answered through the broker,
  `exec`, `setSessionName`, abort dismissing an open prompt, and
  `sendUserMessage` through the Host-owned queue (E2E-243);
- a throwing module, an unsupported terminal-UI import, and inert API
  members degrading to diagnostics (E2E-244).

E2E-245 (the bundled loader) is covered by
`packages/agent-runtime/src/extensions/bundle.test.ts`.

## Run

```bash
# 0. once: build everything the app loads at runtime
pnpm -C packages/shared build && pnpm -C packages/i18n build
pnpm -C packages/agent-runtime build
pnpm --filter @pi-desktop/desktop build
cargo build -p host-core

# 1. seed a throwaway data dir (fixture plugins registered through host-core, stub provider)
export E2E_ROOT=/tmp/pi-ext-e2e STUB_PORT=47123
mkdir -p "$E2E_ROOT"
HOST_BIN="$PWD/target/debug/pi-desktop-host-core" node apps/desktop/test/e2e/trusted-extensions/seed.mjs

# 2. stub provider
REQUEST_LOG="$E2E_ROOT/requests.jsonl" node apps/desktop/test/e2e/trusted-extensions/stub-server.mjs &

# 3. the app, with the MCP control plane on
(cd apps/desktop && PI_DESKTOP_DATA_DIR="$E2E_ROOT/data" PI_CODING_AGENT_DIR="$E2E_ROOT/agent" \
  PI_DESKTOP_MCP_CONTROL=1 PI_DESKTOP_MCP_PORT=47130 ELECTRON_RENDERER_URL= ./node_modules/.bin/electron . &)
until [ -f "$E2E_ROOT/data/mcp-control.json" ]; do sleep 1; done

# 4. drive it; run twice to cover a second session on the cached modules
E2E_PROJECT="$(node -e 'console.log(require("fs").realpathSync(process.env.E2E_ROOT + "/project"))')" \
  node apps/desktop/test/e2e/trusted-extensions/drive.mjs
```

The driver prints one `PASS` / `FAIL` line per check and a `SUMMARY`.
Prompts raised by the `greet` command also appear as real dialogs in the
window; the driver answers them through `extensions/ui/respond` using the
prompt ids main writes to `logs/app/plugin.log`.
