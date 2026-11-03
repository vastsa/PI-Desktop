# packages

- `shared` — IPC/protocol contracts; `formatBytes(1536)` → `1.5 KB` (binary steps, `KB`/`MB`/`GB` labels, per-unit `decimals`)
- `i18n` — English source catalog
- `plugin-sdk` — plugin author types/helpers
- `agent-runtime` — pi sidecar + runtime wrapper
- `agent-host` — headless Agent Host module (admission, turn queue, approvals, event log)
- `host-runtime` — Electron-independent runtime layer (stdio transports, restart supervisor, turn lifecycle)
- `racp` — RACP-WS server and client cores, `ws` binding, device-token pairing
