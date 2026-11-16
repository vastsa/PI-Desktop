# ADR 0177: User-configurable outbound proxy

- Status: Accepted
- Date: 2026-09-08
- Related: D340, ADR 0083, ADR 0096

## Context

Outbound HTTP is split across Electron main (model discovery, models.dev refresh,
plugin `net.fetch`, OAuth polling), the agent sidecar (Node `fetch` / pi-ai
provider calls), host-core (marketplace catalog and package `curl`), Chromium
sessions, and electron-updater, and system proxy mode did not reach Node provider
calls or host-core downloads because neither Node `fetch` nor `curl` resolves
Electron's system proxy or PAC configuration — so users behind Clash, V2Ray,
corporate proxies, or SOCKS5 could browse in-app while model and plugin downloads
failed.

## Decision

1. Settings → General → Network exposes Proxy as System / Direct / Custom; Custom
   accepts `http`, `https`, `socks`, `socks5`, and `socks5h` URLs plus a bypass
   list, persisted as optional `AppSettings.networkProxy` with no protocol or
   schema bump.
2. System (default) uses `session.setProxy({ mode: "system" })`, and Electron main
   owns a loopback-only, authenticated SOCKS relay that resolves each destination
   through `session.defaultSession.resolveProxy`, including PAC decisions, which
   the sidecar's undici dispatcher and host-core `curl` use so provider and
   marketplace requests follow OS proxy policy.
3. Direct clears proxy env keys and gives host-core curl `--noproxy '*'`; Custom
   sets Chromium `proxyRules` plus `proxyBypassRules`, makes main `fetch` use
   `net.fetch` so SOCKS5 goes through Chromium, sets an undici dispatcher in the
   sidecar, and passes `--proxy` / `--noproxy` to host-core curl, with loopback in
   the default bypass list.
4. Workspace Bash, the OAuth system browser (`shell.openExternal`), and plugin
   utility processes are not rewritten: host-core strips proxy keys from the spawn
   env so credentials cannot leak into `env`, while `pi.net.fetch` still goes
   through main.
5. `settings.set` applies without restart to Chromium sessions (including
   `session-created`), the main env, and `sidecar.configure`, and a Test action
   (`pi-desktop/network/testProxy`) runs one bounded Chromium fetch through the
   supplied config without persisting it.
6. Custom proxy userinfo lives in the settings JSON beside other non-API-key
   preferences and logs redact passwords; System relay credentials are random,
   ephemeral, and accepted only on its loopback listener; and because Chromium
   `proxyRules` cannot carry userinfo or speak SOCKS5 username/password, main
   points Chromium at a `127.0.0.1` SOCKS5 relay that injects stored credentials
   (issue #490).

## Consequences

- LLM, marketplace, updates, plugin `net.fetch`, and the in-app browser honor the
  selected route, and System mode uses Electron's OS/PAC resolution for provider
  and marketplace requests too.
- System proxies requiring an interactive or OS-integrated authentication challenge
  are not answered by the raw socket relay; those requests fail closed, and users
  with explicit credentials can use Custom mode.
- Adding `undici` to the sidecar bundle keeps the dispatcher and `fetch` on one
  package.

## Alternatives

- Env-only (`HTTP_PROXY`): Node `fetch` ignores it without a dispatcher and
  host-core Bash would inherit credentials.
- `app.commandLine.appendSwitch('proxy-server')`: cannot change at runtime.
