# ADR 0177: User-configurable outbound proxy

- Status: Accepted
- Date: 2026-09-08
- Deciders: PI-Desktop core
- Related: D340, ADR 0083, ADR 0096,
  `04-ux/06-settings-ia.md`, `03-runtime/07-process-model.md`

## Context

Outbound HTTP is split across processes:

- Electron main — model discovery, models.dev refresh, plugin `net.fetch`,
  OAuth polling, GitHub-adjacent fetches
- Agent sidecar (Node `fetch` / pi-ai) — LLM provider calls
- host-core — marketplace catalog and package `curl`
- Chromium sessions — default session, `persist:work-browser`, plugin panels
- electron-updater — Chromium / Electron net

None of those surfaces honored a product setting. Users behind Clash, V2Ray,
corporate HTTP proxies, or SOCKS5 had working OS/TUN proxies for the in-app
browser but silent failures on model calls, because Node's `fetch` does not
use the system proxy.

A single Settings control should apply one proxy to app-owned traffic.

## Decision

1. **Settings → General → Network** exposes Proxy as System / Direct /
   Custom. Custom accepts `http`, `https`, `socks`, `socks5`, and `socks5h`
   URLs plus a bypass list. Persistence is optional
   `AppSettings.networkProxy` in the existing host settings blob. No protocol
   or storage schema version bump.

2. **System** (default): Chromium `session.setProxy({ mode: "system" })`.
   Node sidecar stays direct unless the process already inherited proxy env
   from the launching shell. This preserves today's GUI-app behavior.

3. **Direct**: Chromium `{ mode: "direct" }`. Proxy env keys are cleared in
   Electron main. host-core marketplace curl uses `--noproxy '*'`.

4. **Custom**: Chromium `proxyRules` + `proxyBypassRules`; Electron main
   `fetch` is `net.fetch` so SOCKS5 uses the Chromium stack; sidecar sets an
   undici dispatcher (`ProxyAgent` for HTTP(S), SOCKS5 CONNECT + the same
   undici `fetch`); host-core curl gets `--proxy` / `--noproxy` from the
   stored settings. Default bypass is
   `localhost,127.0.0.1,::1,<local>` so loopback MCP and local models stay
   direct.

5. **Not rewritten**: workspace Bash (host-core spawn env strips proxy
   keys so credentials cannot leak into `env`), and the system browser used
   for OAuth (`shell.openExternal`). Plugin utility processes keep their
   stripped env; `pi.net.fetch` still goes through main.

6. **Apply without restart.** `settings.set` updates Chromium sessions
   (including `session-created`), main env, and `sidecar.configure`. A Test
   action (`pi-desktop/network/testProxy`) runs one bounded Chromium fetch
   through the supplied config and does not persist it.

7. **Secrets.** Proxy userinfo lives in the settings JSON next to other
   non-API-key preferences. Logs redact passwords. host-core never
   `set_var`s the URL onto its process env.

## Consequences

- LLM, marketplace, updates, and the in-app browser share one proxy.
- System mode does not magically make Node follow the macOS/Windows system
  proxy; users who need model calls through Clash still choose Custom
  (typically `http://127.0.0.1:7890` or `socks5://127.0.0.1:1080`).
- Adding `undici` to the sidecar bundle keeps the dispatcher and `fetch`
  implementation on one package.

## Alternatives

- Env-only (`HTTP_PROXY`): Node `fetch` ignores it without a dispatcher;
  SOCKS5 is incomplete; host-core Bash would inherit credentials.
- `app.commandLine.appendSwitch('proxy-server')`: cannot change at runtime.
- Per-provider proxy: does not cover marketplace, updates, or the browser.
