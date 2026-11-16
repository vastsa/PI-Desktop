# ADR 0177: User-configurable outbound proxy

- Status: Accepted
- Date: 2026-09-08
- Deciders: PI-Desktop core
- Related: D340, ADR 0083, ADR 0096,
  `04-ux/06-settings-ia.md`, `03-runtime/07-process-model.md`

## Context

Outbound HTTP is split across processes:

- Electron main — model discovery, models.dev refresh, plugin `net.fetch`, OAuth
  polling, GitHub-adjacent fetches
- Agent sidecar (Node `fetch` / pi-ai) — LLM provider calls
- host-core — marketplace catalog and package `curl`
- Chromium sessions — default session, `persist:work-browser`, plugin panels

## Decision

1. **Settings → General → Network** exposes Proxy as System / Direct / Custom.

2. **System** (default): Chromium uses `session.setProxy({ mode: "system" })`.

3. **Direct**: Chromium `{ mode: "direct" }`.

4. **Custom**: Chromium `proxyRules` + `proxyBypassRules`; Electron main `fetch`
   is `net.fetch` so SOCKS5 uses the Chromium stack; sidecar sets an undici
   dispatcher (`ProxyAgent` for HTTP(S), SOCKS5 CONNECT + the same undici
   `fetch`); host-core curl gets `--proxy` / `--noproxy` from the stored
   settings.

For host-core curl in every proxy mode, Windows builds use Schannel's
best-effort revocation mode when the installed curl advertises it. This
tolerates unavailable or offline revocation distribution points while keeping
certificate verification on.

5. **Not rewritten**: workspace Bash (host-core spawn env strips proxy keys so
   credentials cannot leak into `env`), and the system browser used for OAuth
   (`shell.openExternal`).

6. **Apply without restart.** `settings.set` updates Chromium sessions
   (including `session-created`), main env, and `sidecar.configure`.

7. **Secrets.** Custom proxy userinfo lives in the settings JSON next to other
   non-API-key preferences.

## Consequences

- LLM, marketplace, updates, plugin `net.fetch`, and the in-app browser honor
  the selected route.
- System proxies that require an interactive or OS-integrated authentication
  challenge are not answered by the raw socket relay; those requests fail
  closed.
- Adding `undici` to the sidecar bundle keeps the dispatcher and `fetch`
  implementation on one package.

## Alternatives

- Env-only (`HTTP_PROXY`): Node `fetch` ignores it without a dispatcher; SOCKS5
  is incomplete; host-core Bash would inherit credentials.
- `app.commandLine.appendSwitch('proxy-server')`: cannot change at runtime.
- Per-provider proxy: does not cover marketplace, updates, or the browser.
