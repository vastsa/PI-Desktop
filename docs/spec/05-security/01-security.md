# 01. Security

> Language: English (per ADR 0009). Statuses reflect the implementation as of
> M5 hardening. Cross-references: [logging](../03-runtime/09-logging-and-observability.md)
> · [process model](../03-runtime/07-process-model.md) · [plugin security](../07-plugins/04-plugin-security.md)

## 1. Security goals

1. The renderer must never gain unconstrained system access
2. Protect provider API keys
3. Bound the blast radius of agent tool execution
4. Keep sensitive operations auditable

## 2. Electron baseline

Required (all **implemented**):

- `contextIsolation: true`
- `nodeIntegration: false`
- `sandbox: true` — the preload is a fully bundled CJS file with no runtime
  module resolution, verified end-to-end by `test:e2e:boot`
- No remote module (Electron ≥ 14 default)
- Navigation locked down: `setWindowOpenHandler` denies in-app windows and
  forwards only parsed `http:` / `https:` / `mailto:` URLs to the OS browser
  (`parseAllowedExternalUrl`, D330 / ADR 0168). `file:`, `javascript:`,
  `data:`, and custom URI schemes never reach `shell.openExternal`.
  `will-navigate` blocks all non-dev-server navigations
- Every web contents Electron creates starts with a deny-all window-open
  handler and a blocked `<webview>` attach (`app.on("web-contents-created")`);
  the owning surface replaces the handler with its own policy, so a window
  that forgets to wire one denies popups instead of inheriting Chromium's
  defaults
- Preload exposes a whitelist-checked `invoke`/`on` bridge only
  (`IPC_WHITELIST` enforced on both preload and main sides)
- Transcript Markdown is sanitized (`rehype-sanitize`), but remote `http(s)`
  images, audio, and video that a model writes into a reply are fetched on
  render, without a click. This is a deliberate readability trade-off: a
  reply can therefore reveal the user's IP to the host it names. Links never
  navigate in-app and always route through the external-open path.

### Content Security Policy

- Dev: `script-src 'self' 'unsafe-inline' 'unsafe-eval'` (required by Vite
  HMR tooling), localhost websocket connect-src. Fonts are restricted to
  `'self'` and `data:` so Vite-inlined KaTeX WOFF2 assets can render without
  admitting remote font origins.
- Production build: `'unsafe-eval'` and localhost connect-src are stripped
  at build time (`tightenCsp` plugin in `electron.vite.config.ts`);
  `connect-src 'self'` only. Provider network traffic happens in the Node
  sidecar, never in the renderer.
- Assistant Mermaid diagrams do not widen CSP or renderer privileges. Only a
  completed answer fence may dynamically load the bundled local renderer.
  Mermaid runs with `securityLevel: strict`, protected security/theme/limit
  configuration, HTML labels disabled, a 20,000-character source limit, and a
  500-edge limit. Its generated SVG then passes through DOMPurify's SVG profile;
  links, URL attributes, `foreignObject`, script, embedded media, and external
  image elements are removed before the SVG reaches the DOM. Invalid or
  oversized input fails closed to escaped source text.

### Future hardening (tracked, post-MVP)

- Electron fuses (`runAsNode`, `nodeCliInspect` off) at package time
- `webSecurity` assertions in an automated security e2e

## 3. Secrets

- Keys stored via Electron `safeStorage` encryption, managed by host-core
  (see [14-secrets-storage](../03-runtime/14-secrets-storage.md))
- UI shows configured/not-configured only; never echoes key material
- Logs must never contain secrets: Logger redaction (key-name patterns +
  `sk-`-style token pattern) in Electron main, `redact_value` in host-core
  audit writes; verified by the no-secret-leak smoke check
- Error messages must not echo full keys

## 4. Workspace sandbox

- File tools are restricted to the project root by default; an explicit path
  outside the session workspace and scratch roots requires the host permission
  decision described in `03-runtime/03-tools-and-permissions.md`
- Path normalization + root boundary check in host-core
  (`workspace::tests::blocks_escape` covers escape attempts)
- Symlink targets outside the root are rejected when detectable unless the
  explicit path was approved by the host permission layer

Plan is not itself the workspace security boundary. Host-core resolves the
durable session mode for every `tools.execute` call and applies the Plan matrix
before permission modes, grants, plugin risk, or renderer/sidecar state. Plan
denies Write/Edit/plugin/unknown tools, while BrowserPreview is the explicit
read-only UI inspection exception (it reveals bundled `pi.browser` chrome; raw
CDP plugin tools stay denied in Plan). Bash remains available in Plan: Ask and
Accept edits prompt, and Auto runs without confirmation and may mutate the
workspace or scratch directory. The UI must state this tradeoff. `SubmitPlan`
preserves exact Markdown bytes in a new unique `<workspaceRoot>/.pi/plan/*.md`
file through host-core, validates the in-root artifact path, computes SHA-256
and byte size, and only then creates the `plan_approvals` record with
structured title/question fields. Renderer and sidecar state cannot write or
replace an artifact.

## 5. Command execution

- Bash requires confirmation by default (risk-tiered permission cards); in
  either Agent or Plan, explicit Auto may run it without confirmation
- The Bash protocol name remains stable, but host-core selects a catalog shell
  (`windows-powershell`, `windows-pwsh`, `cmd`, `git-bash`, or `bash`) from persisted
  `defaultCommandShell` where supported by the platform. Settings writes reject
  unavailable/wrong-platform IDs. If a persisted choice later becomes
  unavailable, catalog resolution intentionally falls back to the first
  available platform shell; each turn pins its effective ID/dialect and the
  host rejects a changed pin before spawn with `COMMAND_SHELL_CHANGED`.
- Timeouts are mandatory: 60s default with a 1–21,600s bounded override (D329). Output
  streams as separate stdout/stderr channels and is truncated at 96KB / 4000
  lines with an explicit `[truncated: …]` marker that names which end survived
  (see [16-tool-result-limits](../03-runtime/16-tool-result-limits.md))
- User abort and timeout shut down the complete process tree before the tool
  closes; no orphan process may continue writing output.
- Full command line recorded in the audit log (SQLite, redacted), with shell ID
  and dialect rather than an untrusted executable path or path hash
- Allowlist/denylist refinement is a tracked follow-up
  ([03-tools-and-permissions](../03-runtime/03-tools-and-permissions.md))

## 6. Supply chain

- Dependency versions locked via `pnpm-lock.yaml` / `Cargo.lock` committed
  to the repo; upgrades are explicit commits
- Prefer official pi packages
- Marketplace package installation is remote-capable. Current SHA-256 checks
  verify transfer integrity against the catalog value, but signatures and
  publisher provenance are not yet enforced; see the plugin trust limitation
  in `07-plugins/08-plugin-signing-updates.md` before treating marketplace code
  as trusted.
- A plugin main currently runs with raw Node built-ins in its own
  `utilityProcess`. The brokered `pi.*` permission gate does not constrain
  direct Node access, so marketplace plugins must be treated as unrestricted
  user-privileged code until capability sandboxing is implemented.

## 7. Application update security (D120)

- Electron Main owns `electron-updater`; renderer IPC cannot provide or
  override the fixed HTTPS GitHub owner/repository or releases URL.
- The updater forces `allowPrerelease = false` so discovery always uses
  GitHub's latest stable release rather than a same-channel prerelease pin.
- Feed manifests bind artifacts with electron-builder hashes. An error,
  unavailable feed, hash mismatch, or invalid updater state must not install.
- Packaged macOS is manual-only: it detects a release and opens the fixed
  releases page, but never downloads or installs it in-app. Enabling a signed
  macOS in-app channel requires a later explicit decision and qualification.
- D126 tag releases publish Windows NSIS and Linux AppImage installers with
  their update manifests, plus Linux deb/rpm packages and a Windows portable
  exe. The NSIS and AppImage artifacts activate the existing in-app lanes.
  The portable exe uses notify-and-link delivery and does not write
  `latest.yml`. macOS tag artifacts
  are Developer ID-signed, notarized, and stapled before upload; rollback and
  staged-rollout qualification remain release follow-ups.
- The client carries no GitHub token. A private or otherwise unreachable feed
  fails closed; automatic failures stay ambient and explicit checks expose the
  error.
- Unsigned macOS distributions keep a narrow first-launch fallback for trusted
  sources. The DMG exposes only a text note named `If app won't open, read this.txt`; it gives
  the manual `com.apple.quarantine` command and says signed/notarized builds do
  not need it. The ZIP package also includes the executable helper, which
  searches only `/Applications/PI-Desktop.app` and `~/Applications/PI-Desktop.app`,
  verifies `CFBundleIdentifier` is `com.pi-desktop.app`, removes only
  `com.apple.quarantine` recursively when present, and opens the app. It accepts
  no arbitrary path, uses no privilege escalation, and is not a substitute for
  Developer ID signing or notarization.
- Localized product "what's new" text (D164/D345) is selected in Main from the
  shipped changelog catalog and attached to `UpdateState.releaseNotes`. The
  renderer cannot supply a notes URL, feed, or remote body; missing catalog
  entries simply omit the section.
- The Developer ID + notarization lane remains documented in the
  [release runbook](../06-delivery/06-release-runbook.md).

## 8. Local MCP control plane

The local MCP control server is an explicit automation boundary, not a general
remote-control listener:

- It is disabled by default and only starts with
  `PI_DESKTOP_MCP_CONTROL=1`.
- It binds `127.0.0.1` only and refuses to start if the listen address is not
  loopback. There is no configuration path for a LAN or public interface, and
  the feature does not revive the deferred remote Gateway / WebUI scope.
- It validates any supplied `Origin` against local loopback hostnames to block
  DNS-rebinding access from remote web content. Non-browser clients may omit
  `Origin`.
- A random 256-bit bearer token is persisted in the Electron user-data
  directory. The token and connection manifest are mode `0600` where
  supported, and the manifest is marked inactive during shutdown.
- Secret get/set/delete channels, provider/OAuth/MCP secret-write paths,
  settings writes, and renderer-only native picker/dialog channels (including
  `plugin/loadDev`) are excluded. Secret-shaped argument fields are stripped
  before dispatch. The reviewed catalog is explicit; newly added IPC handlers
  are not exposed automatically.
- Calls delegate to the existing main-process IPC handlers, so host
  availability, workspace boundaries, permission checks, input validation, and
  redacted logging remain authoritative. Dangerous generic operations,
  session-configure (permission mode), and destructive named tools require an
  explicit `confirm: true`. That flag is an agent acknowledgement, not a user
  prompt.
- Request and serialized-result sizes, including `structuredContent`, are
  bounded. Startup failure is fail-soft for the desktop.

An Agent using this endpoint has the same local-user authority as the running
desktop for the operations it invokes. Users must protect the user-data
directory and token; the endpoint is not intended for untrusted local users or
remote clients. `confirm: true` does not ask the visible desktop for approval.

The post-MVP remote control target is a separate security boundary. It is
specified in
[`02-remote-control-security.md`](02-remote-control-security.md) and
[`02-architecture/05-remote-agent-control.md`](../02-architecture/05-remote-agent-control.md).
Those specifications require an authenticated Gateway/Agent Host link,
session-scoped authorization, event replay controls, and no network access to
host-core. They do not change the loopback-only rule above.

## 9. Host process attack surface

- host-core speaks NDJSON JSON-RPC on stdio to the Electron main process
  only; it binds no network ports
- The agent sidecar reaches host services only through the main-process
  proxy (`host.proxy`), which enforces a **method allowlist**
  (`tools.execute`, `tools.list`, `session.get`, `session.appendMessage`,
  `workspace.get`, `app.health`) — the sidecar cannot pull secrets or
  mutate providers/settings/plugins through the proxy
- host-core child processes (Bash tool) run with the user's privileges;
  containment relies on the permission layer, catalog identity, process-group/
  job-tree shutdown, and workspace sandbox rather than OS sandboxing

## 10. Threat model (summary)

| Threat | Mitigation |
|---|---|
| Malicious web content in renderer | no Node, sandbox, navigation lock, CSP |
| Prompt-injected destructive tool use | host-owned durable mode policy, permission confirmation, path boundary, secret isolation |
| Dependency poisoning | lockfiles, few deps, native-module review |
| Malicious local plugin | declared permissions, no secret access, process isolation tracked post-MVP (ADR 0008) |

## 11. Security acceptance gates

1. Renderer cannot `require('fs')` (sandbox + no nodeIntegration) — verified
2. Plan Write/Edit/plugin calls cannot run under any permission mode; Bash is
   confirmed under Ask/Accept edits and may run without confirmation only under
   explicit Auto
3. Writing outside the workspace fails — verified (host tests)
4. API keys never appear in plaintext in exports/logs by default — verified
5. Non-whitelisted IPC channels are rejected — verified (M1)
6. A forged renderer/sidecar mode cannot override the durable host session mode
7. Plan artifact bytes/path/hash/size are host-authenticated; approval is
   approve/reject-only and scheduled Plan is rejected before artifact/queue work
8. Plan expiry, rejection, host restart, and stale responses never replay
   pending/queued/running work; an approved interruption leaves the session Agent
9. Invalid settings and stale shell ID/dialect fail closed; Bash output streams
   separately and timeout/abort kills the complete process tree
10. Local MCP control is loopback-only, bearer-authenticated, opt-in, bounded,
    excludes secret writes and native pickers, and requires confirmation for
    session permission-mode changes
