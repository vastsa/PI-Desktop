# Trusted extensions E2E harness (E2E-241 to E2E-245)

The harness drives the real desktop app and renderer through the local MCP
control plane against a deterministic OpenAI-compatible stub. The CI entry
point owns all process startup, temporary data isolation, readiness checks, and
cleanup:

```bash
pnpm test:e2e:trusted-extensions
```

The command expects the JavaScript packages, desktop bundle, Electron, and a
`target/debug` or `target/release` host-core binary to already be built. The
optional `PI_DESKTOP_HOST_BIN` environment variable selects a host binary.
Use `E2E_KEEP_ARTIFACTS=1` to retain the generated run directory for debugging;
use `DEBUG_E2E=1` to stream child-process output.

The seed creates six plugin-form fixtures in an isolated temporary directory;
it does not read or write the user's `~/.pi` profile. The driver prints one
`PASS` / `FAIL` line per assertion and a `SUMMARY` before the runner reports
its final exit status.

What the automated run proves:

- plugin registration/discovery, capability and permission projection, project
  scope, loaded/error state, and diagnostics (the runtime portion of
  E2E-241/E2E-244);
- `registerTool` through `tool_search` activation, `tool_call` blocking,
  `tool_result` replacement, `before_agent_start`, provider header and request
  hooks, and lifecycle hooks (E2E-242);
- slash commands in the composer menu and global search, a command with
  `ui.input` / `ui.select` / `ui.confirm` answered through the broker,
  `exec`, `setSessionName`, abort dismissing an open prompt, and
  `sendUserMessage` through the Host-owned queue (E2E-243);
- a throwing module and unsupported terminal-UI imports degrading to
  diagnostics while the remaining extensions continue to run (E2E-244).

The native picker/import journey and explicit enable/disable UI flow in
E2E-241 are not faked by this headless driver. The 30-second stalled-handler
fixture in E2E-244 and the packaged sidecar/jiti journey in E2E-245 remain
outside this command; E2E-245 has contract coverage in
`packages/agent-runtime/src/extensions/bundle.test.ts`.

For manual inspection, the lower-level steps remain available:

```bash
E2E_ROOT=/tmp/pi-ext-e2e STUB_PORT=47123 \
  HOST_BIN="$PWD/target/debug/pi-desktop-host-core" \
  node apps/desktop/test/e2e/trusted-extensions/seed.mjs
```
