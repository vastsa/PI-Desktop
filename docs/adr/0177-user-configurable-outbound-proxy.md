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

Custom proxy settings already covered these surfaces, but System mode did not
reach Node provider calls or host-core marketplace downloads. Users behind
Clash, V2Ray, corporate HTTP proxies, or SOCKS5 could use the in-app browser
while model and plugin downloads failed because Node `fetch` and `curl` do not
resolve Electron's system proxy or PAC configuration.

A single Settings control should apply one proxy to app-owned traffic.

## Decision

1. **Settings → General → Network** exposes Proxy as System / Direct /
   Custom. Custom accepts `http`, `https`, `socks`, `socks5`, and `socks5h`
   URLs plus a bypass list. Persistence is optional
   `AppSettings.networkProxy` in the existing host settings blob. No protocol
   or storage schema version bump.

2. **System** (default): Chromium uses
   `session.setProxy({ mode: "system" })`. Electron main owns a loopback-only,
   authenticated SOCKS relay that calls `session.defaultSession.resolveProxy`
   for each destination and follows the returned proxy fallback list, including
   PAC decisions. The sidecar's undici dispatcher and host-core marketplace
   `curl` use that relay, so provider and marketplace requests follow the same
   OS proxy policy without putting proxy settings in a process environment.

3. **Direct**: Chromium `{ mode: "direct" }`. Proxy env keys are cleared in
   Electron main. host-core marketplace curl uses `--noproxy '*'`.

4. **Custom**: Chromium `proxyRules` + `proxyBypassRules`; Electron main
   `fetch` is `net.fetch` so SOCKS5 uses the Chromium stack; sidecar sets an
   undici dispatcher (`ProxyAgent` for HTTP(S), SOCKS5 CONNECT + the same
   undici `fetch`); host-core curl gets `--proxy` / `--noproxy` from the
   stored settings. Default bypass is
   `localhost,127.0.0.1,::1,<local>` so loopback MCP and local models stay
   direct.

For host-core curl in every proxy mode, Windows builds use Schannel's
best-effort revocation mode when the installed curl advertises it. This
tolerates unavailable or offline revocation distribution points while keeping
certificate verification on.

5. **Not rewritten**: workspace Bash (host-core spawn env strips proxy
   keys so credentials cannot leak into `env`), and the system browser used
   for OAuth (`shell.openExternal`). Plugin utility processes keep their
   stripped env; `pi.net.fetch` still goes through main.

6. **Apply without restart.** `settings.set` updates Chromium sessions
   (including `session-created`), main env, and `sidecar.configure`. A Test
   action (`pi-desktop/network/testProxy`) runs one bounded Chromium fetch
   through the supplied config and does not persist it.

7. **Secrets.** Custom proxy userinfo lives in the settings JSON next to other
   non-API-key preferences. Logs redact passwords. System relay credentials
   are random, ephemeral, and accepted only on its loopback listener. host-core
   never `set_var`s proxy URLs onto its process env. Chromium `proxyRules` cannot
   include userinfo (it fails with `net::ERR_NO_SUPPORTED_PROXIES`) and
   cannot speak SOCKS5 username/password, so Electron main points Chromium
   at a `127.0.0.1` SOCKS5 relay that injects stored custom credentials
   (issue #490). In System mode, the relay resolves the route through
   Electron for each destination and tries PAC fallbacks in order. No proxy
   credentials are inherited by workspace Bash.

## Consequences

- LLM, marketplace, updates, plugin `net.fetch`, and the in-app browser honor
  the selected route. System mode uses Electron's OS/PAC resolution for
  provider and marketplace requests as well as Chromium-owned requests.
- System proxies that require an interactive or OS-integrated authentication
  challenge are not answered by the raw socket relay; those requests fail
  closed. Users can use Custom mode when they have explicit proxy credentials.
- Adding `undici` to the sidecar bundle keeps the dispatcher and `fetch`
  implementation on one package.

## Alternatives

- Env-only (`HTTP_PROXY`): Node `fetch` ignores it without a dispatcher;
  SOCKS5 is incomplete; host-core Bash would inherit credentials.
- `app.commandLine.appendSwitch('proxy-server')`: cannot change at runtime.
- Per-provider proxy: does not cover marketplace, updates, or the browser.
