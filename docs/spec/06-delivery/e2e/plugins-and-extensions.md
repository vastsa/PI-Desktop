# E2E Scenarios: Plugins and Extensions

## E2E-plugin-view-refresh-order

Hold the first project's plugin view request, switch projects and complete the second request, then resolve or reject the first. Verify the production WorkPanel launcher retains only the current project's views. Also switch projects without another request and reject stale writes. Coverage: `plugin-view-refresh-order.test.mjs`, view contracts and `scripts/e2e-plugin-view-refresh-order.mjs` with production WorkPanel/useAppStore in Electron. Host view results are controlled.

> Part of the [E2E test plan](../04-e2e-test-plan.md). Plugins, MCP, trusted extensions, subagents, hooks, skills, and generated UI.
> Scenario template, gates, and traceability live in the plan.

## E2E-EXTENSION-thinking-request-state

Set high thinking through the production extension bridge, send a prompt and
capture the provider stream options. The actual Agent loop sends high, matching
the extension getter. `runtime.test.ts` mocks only the provider stream.

## E2E-SUBAGENT-system-notice-reconstruction

Reconstruct a transcript with a running Task followed by a system notice.
The production entry builder, live-delegation selector and outcome resolver
keep the Task running. End the session or add a new ordinary prompt and verify
that historical Tasks are no longer live. Coverage:
`live-delegation-system-row.test.mjs`; `turn-process.test.mjs` checks the
matching turn boundary and `turn-process-header.test.mjs` the rendered labels.

## E2E-PLUGIN-appearance-extension-lifecycle

- **Preconditions:** A fixture plugin declares `ui.theme`, `ui.settings`, one
  asset-backed scenic card with a typed `--nexus-backdrop-blur` `0..20px` variable.
- **Steps:** Open Settings, find the final Extensions group by search and
  keyboard navigation, open the entry, change the variable, select/reselect the
  theme, restart, then disable, reload and uninstall the plugin while its entry
  is active.
- **Expected:** The Extensions rail draws the destination's host icon token
  (`palette` / Lucide Palette), not a Skills book glyph and not plugin SVG.
  Only the declared variable rule changes after Apply; static
  `plugin-asset://` URLs remain valid; the value restores after restart; host-
  rendered cards retain the scenic backdrop behind their translucent content,
  have no opaque native rectangle, and leave Windows/Linux minimize/maximize
  controls clickable while Settings is open. Invalid/cross-plugin values are
  refused. Every lifecycle transition removes the entry and returns the app to
  General.
- **Status:** Documented; run after integration into main.

## E2E-MCP-stdio-login-path: Market stdio MCP finds uvx/npx after a GUI launch (issue #571)

- **Preconditions**: macOS; the app was started from Finder/Dock so `process.env.PATH`
  is the GUI default; `uvx` or `npx` exists on the user's login-shell PATH.
- **Steps**: 1) Install Fetch from the MCP market (`uvx mcp-server-fetch`).
  2) Test connection. 3) Repeat with an npx catalog entry.
- **Expected**: The stdio child env PATH includes the login-shell PATH (Homebrew /
  nvm / `~/.local/bin`) ahead of the GUI PATH, so spawn succeeds. A truly missing
  binary reports `command not found: uvx` rather than `spawn uvx ENOENT`.
  Windows keeps the inherited PATH.
- **Specs linked**: ADR 0045, D600, `03-runtime/03-tools-and-permissions.md`
- **Acceptance**: Quality
- **Milestone**: M6+
- **Status**: Automated (`apps/desktop/test/user-login-path.test.mjs`,
  `apps/desktop/test/plugin-mcp.test.mjs`)

## E2E-MCP-stdio-windows-npx: Official Node and fnm both start `npx` MCP (issue #789)

- **Preconditions**: Windows; Node is either the official `Program Files\nodejs`
  install (`node.exe` + `npx.cmd` + `npx-cli.js` on PATH) or fnm-managed and
  not on the GUI PATH.
- **Steps**: 1) Add Memory from the MCP market (`npx -y @modelcontextprotocol/server-memory`).
  2) Test connection. 3) Repeat with a user-typed `npx` server.
- **Expected**: Official Node rewrites to `node.exe` + `npx-cli.js` and
  handshakes. fnm is discovered from `%LOCALAPPDATA%\fnm\aliases\default` when
  PATH has no node. Remaining `.cmd` shims start through `cmd.exe /d /s /c`
  with quoted literal args, never `shell: true`. A Git-Bash extensionless
  `npx` next to `npx.cmd` is not chosen. Missing binaries still report
  `command not found: npx`.
- **Specs linked**: ADR 0038, D624, `07-plugins/04-plugin-security.md`
- **Acceptance**: Quality
- **Milestone**: M6+
- **Status**: Automated (`apps/desktop/test/mcp-stdio-launch.test.mjs`)

## Plugin Load / Command / Disable

## E2E-022: Load local plugin

- **Preconditions**: App running; sample plugin available at local path.
- **Steps**: 1) Open Extensions from the sidebar footer Plugins icon. 2) Choose Load local plugin from the header overflow menu. 3) Enable it with the row switch.
- **Expected**: Plugin loads; manifest validated; contributions registered; the row appears under Active with a Local tag.
- **Specs linked**: `07-plugins/01-plugin-system.md`, `07-plugins/05-plugin-lifecycle.md`
- **Acceptance**: G (load local plugin)
- **Milestone**: M4
- **Status**: Automated (protocol smoke: plugins.loadDev)

## E2E-PLUGIN-id-cannot-collide: Plugins with look-alike ids never share storage

- **Preconditions**: Real host-core binary on a scratch data directory.
- **Steps**: 1) Install a plugin with id `e2e.foo_bar` from a local folder and write a file into its data directory. 2) For each look-alike id `e2e.foo!bar` (character replacement), `e2e.Foo_Bar` (letter case on case-insensitive file systems) and `e2e.foo_bar.` (Windows trailing dot), try to install it, then to load it as a development plugin. 3) Rewrite the state into what an older build persisted for `e2e.foo!bar` (raw id in the registry row and installed manifest, sanitized directory names), restart the host, and try to install and load `e2e.foo_bar`.
- **Expected**: Every attempt fails with `PLUGIN_INVALID` naming the reason, including the legacy case (`would share storage with installed plugin e2e.foo!bar`). The first plugin's installed files, data directory, and registry row are unchanged, and no second install directory appears, so two plugins can never share a directory or browser session partition (issue #2297).
- **Specs linked**: `07-plugins/02-plugin-manifest-schema.md` §7
- **Status**: Automated (`pnpm test:e2e:plugin-id-collision`, `scripts/e2e-plugin-id-collision.mjs`); unit coverage in `crates/host-core/src/plugins/manifest.rs` and `packages/plugin-sdk/src/index.test.ts`

## E2E-022A: Create a plugin from a template

- **Preconditions**: App running; an empty folder available.
- **Steps**: 1) Open Extensions. 2) Choose New plugin from template in the header overflow menu (or use the empty-state button). 3) Pick each of the four templates in turn and read its description. 4) Choose the folder. 5) Cancel the folder picker on a second attempt.
- **Expected**: The picker lists exactly `panel-basic`, `agent-tool-basic`, `skill-pack`, `full-demo`, each named and described in the active locale; choosing a folder writes the template files, loads the plugin as a development plugin, refreshes the list, then opens that folder as the active project — the app lands on chat with the new folder as the workspace, it appears in the sidebar project list, and the toast reads "<name> created, loaded, and opened for development"; the plugin's contributions are immediately usable and the built-in plugin-development skill is active in the new workspace. That skill teaches the current global `pi` API (`onLoad()` plus `pi.commands.register`) and the fixed `window.pluginBridge` boundary, and does not teach the retired `onLoad(pi)` / `pi.registerCommand` shape. A canceled folder picker changes nothing and reports no error.
- **Specs linked**: `07-plugins/10-plugin-devex.md`, `../../plugin-development.md`, ADR 0039
- **Acceptance**: G (create plugin from template)
- **Milestone**: Post-MVP
- **Status**: Automated in part (`apps/desktop/test/plugin-template-action.test.mjs`: channel, template-id parity with the devkit, locale coverage, canceled-pick ordering, project activation); UI walk-through Documented

## E2E-022B: Development plugin hot reload

- **Preconditions**: A plugin loaded from a local folder and enabled.
- **Steps**: 1) Edit `main.js` to change a command title and save. 2) Save several files at once. 3) Introduce a syntax error and save. 4) Fix the error and save. 5) Add a new permission to `manifest.json` and save. 6) Open the development-plugin card's More actions menu and choose Reload. 7) Edit again and restart the app.
- **Expected**: The single edit reloads the plugin without re-picking the folder and the command palette shows the new title; a save burst produces one reload, and writes under `dist/` or `node_modules/` produce none; the syntax error reports a reload failure without crashing the app, and the fixing save recovers the plugin; the added permission refuses automatic reload with `PERMISSION_DENIED`, while the explicit Reload action loads the registered folder, refreshes the permission ceiling, and reports success; a later edit uses the refreshed ceiling, and after a restart the folder is still watched.
- **Specs linked**: `07-plugins/10-plugin-devex.md` §7, `07-plugins/13-plugin-permissions-matrix.md`, ADR 0039, ADR 0075
- **Acceptance**: G (hot reload), D (permissions cannot widen without review)
- **Milestone**: Post-MVP
- **Status**: Automated in part (`apps/desktop/test/plugin-hot-reload.test.mjs`: debounce, ignore list, permission ceiling, recovery, teardown); manual edit loop Documented

## E2E-022C: Check, pack, install round-trip

- **Preconditions**: A scaffolded plugin directory.
- **Steps**: 1) `pnpm pi-plugin check <dir>`. 2) Delete the file named by `main` and run `check` again; repeat with the file named by `manifest.renderer` in a plugin that declares one. 3) Restore it, declare `contributes.skills` without `agent.prompt.inject`, and run `check` again. 4) `pnpm pi-plugin pack <dir>`. 5) Install the resulting `.piplug` from the plugins page. 6) Ask the agent to run `PluginCheck` and `PluginPack` on the same directory.
- **Expected**: A scaffolded plugin checks clean and reports its file count and size; the missing `main` or `manifest.renderer` entry is an error that blocks `pack`; the inert-skills case is a warning that does not block; `pack` writes `dist/<id>-<version>.piplug` with store-only entries and prints its sha256; the package installs through the normal permission review and appears under Active; the agent tools produce the same verdicts and refuse any directory outside the session workspace.
- **Specs linked**: `07-plugins/10-plugin-devex.md` §5–§6, `07-plugins/06-plugin-packaging.md`, ADR 0039
- **Acceptance**: G (local packaging round-trip)
- **Milestone**: Post-MVP
- **Status**: Automated in part (`packages/plugin-devkit` vitest: scaffold→check→pack per template, store-method headers, every check rule, and a parity test that pins the `permission.high-risk` list to the permissions matrix's high rows); install step Documented

## E2E-023: Plugin command in global search and executes

- **Preconditions**: Plugin loaded and enabled.
- **Steps**: 1) Open global search (Cmd/Ctrl+K or Cmd/Ctrl+Shift+P). 2) Find the plugin command under the Commands section. 3) Execute.
- **Expected**: Command appears in global search results; execution produces expected result.
- **Specs linked**: `07-plugins/09-plugin-command-palette.md`
- **Acceptance**: G (plugin command appears and executes)
- **Milestone**: M4
- **Status**: Draft

## E2E-PLUGIN-command-ownership: Command registration respects plugin ownership

- **Preconditions**: Two plugins run in separate plugin host processes.
- **Steps**: 1) Register a command from one plugin. 2) Attempt to replace and
  unregister it from the other plugin. 3) Update and unregister it from the
  owner. 4) Repeat with a load-time collision and concurrent registrations.
- **Expected**: Cross-plugin replacement rejects with `CONFLICT`; cross-plugin
  removal rejects with `PERMISSION_DENIED`. Rejected calls leave the original
  handler runnable. Same-owner updates preserve the ID; repeated removal is
  harmless; released IDs can be reused. A failed plugin load or unloading a
  losing registrant does not remove the winning command. Concurrent calls
  admit exactly one owner.
- **Specs linked**: `07-plugins/03-plugin-api.md`, `07-plugins/12-plugin-ipc-and-host-services.md`
- **Acceptance**: G (plugin command isolation)
- **Milestone**: M4
- **Status**: Automated — `pnpm test:e2e:plugin-command-ownership` exercises
  the public plugin API through real plugin host processes and the host broker.

## E2E-024: Plugin registers and calls agent tool

- **Preconditions**: Plugin loaded; plugin declares an agent tool.
- **Steps**: 1) Ask agent to use the plugin's tool. 2) Observe permission card if required. 3) Allow.
- **Expected**: Tool registered with forced prefix (`plugin_<id>_<name>`); call succeeds.
- **Specs linked**: `07-plugins/03-plugin-api.md`, `07-plugins/13-plugin-permissions-matrix.md`
- **Acceptance**: G (plugin agent tool)
- **Milestone**: M4
- **Status**: Automated (protocol smoke: dispatch roundtrip host->runner->host; in-app JS execution via PluginRuntime)

## E2E-024G: Marketplace detail sheet shows README, permissions, versions

- **Preconditions**: Official marketplace catalog available.
- **Steps**: 1) Open Extensions → Marketplace. 2) Open details for `demo.workspace-summary`. 3) Inspect README / risk-grouped permissions / version rows. 4) Pick a version and install after permission review. 5) Dismiss the sheet with Escape and by clicking the scrim.
- **Expected**: Detail sheet loads via `market.getDetail`; README, safety notes, and per-risk permission explanations render; the picked version drives the sticky install action; the sheet mounts on the viewport overlay host above the expanded sidebar; Escape and scrim both close the sheet without closing the permission dialog underneath.
- **Specs linked**: `07-plugins/07-plugin-marketplace.md`
- **Acceptance**: G (marketplace detail UX)
- **Status**: Documented

- **Focus regression**: In light and dark themes, open a marketplace card and press Escape. Like pointer dismissal, Escape leaves no line or focus ring on the card. Then use Tab and Shift+Tab: the detail button shows a complete, unclipped ring, and Install remains separately focusable. Automated focus-state regression: `node scripts/e2e-plugin-detail-focus.mjs`; verify the rendered ring visually.

## E2E-PLUGIN-reviews-public-reads: Public ratings and reviews stay read-only in the desktop

- **Preconditions**: Extensions reachable with at least one installed and one marketplace plugin the centre knows, plus a second run against a centre that has no review API.
- **Steps**: 1) Open Extensions → Installed and, without visiting Marketplace, confirm a published plugin's card shows a rating chip only when the centre returned a summary. 2) Open a marketplace card's detail sheet and read the ratings summary between Permissions and Versions; press "See all reviews". 3) In the drawer, filter by sentiment and switch between newest and most helpful; page with Load more. 4) Inspect the composer: it is disabled, and its one action is the link to the plugin centre page. 5) Press Escape once (only the drawer closes) and again (the sheet closes). 6) Reopen the sheet and confirm the drawer left its scroll position untouched. 7) Repeat against the centre without review support and read the summary.
- **Expected**: Installed and marketplace ids are batched into one summary read that never requires a Marketplace refresh; an unavailable centre shows no fabricated zeros, and the detail summary says ratings are unavailable — while the review entry stays reachable and the drawer retries its own list, so its disabled composer and its web link (official fallback until the host reports `reviewUrl`) are never lost; a successful summary read replaces the ratings for the ids just requested, so a plugin the centre stops serving loses its stale rating chip; the chip rides the card's existing metadata line and adds no row; the drawer covers the mounted detail sheet, keeps its scroll position, closes on the first Escape only, returns focus to its opener (Escape claims the key with preventDefault/stopPropagation; the covered sheet is inert and Tab is trapped inside the drawer), appends pages deduplicated by review id, and drops an answer for a filter the user already left; a review's version reads as user-reported, never as an installed version; the composer accepts no input, and the only write path is the real link opened through `browserOpenExternal` in the system browser on a primary or middle click (right-click stays with the platform menu), with a failed open reported as a toast; no sign-in, vote, report, or review-writing UI exists in any locale.
- **Specs linked**: `07-plugins/07-plugin-marketplace.md` §7, `07-plugins/14-plugin-roadmap.md`
- **Acceptance**: G (Extensions page) + Security
- **Status**: Automated fixture (`node scripts/e2e-plugin-reviews-drawer.mjs`: three probes — full path with card chip, section order, paging/dedup, filter stale-drop, error+retry, link href/middle-click-only/failure toast, Tab trap + inert, Escape/focus/scroll restoration; stale-summary replacement; unavailable-summary drawer entry + retry + fallback link) plus unit-covered (`plugin-reviews-logic.test.mjs`, `plugin-reviews-surface.test.mjs`)

## E2E-024F: Refresh the official marketplace catalog

- **Preconditions**: Network available to `plugins.aiuo.net`.
- **Steps**: 1) Open Extensions → Marketplace. 2) Use the header Refresh marketplace action. 3) Confirm the official catalog refreshes and the card grid updates.
- **Expected**: The marketplace uses `plugins.aiuo.net/catalog.json`; the page has no source selector; the cached official catalog remains available if refresh fails.
- **Specs linked**: `07-plugins/07-plugin-marketplace.md`
- **Acceptance**: G (remote marketplace source)
- **Status**: Documented / host-core unit covered

## E2E-024P: The marketplace ignores legacy source settings

- **Preconditions**: Profiles can be seeded with legacy `pluginMarketSource` values `github`, `mirror`, and `custom`, including a custom URL. Network or a local request stub is available for the official catalog.
- **Steps**: 1) Start the app with each seeded profile. 2) Open Extensions → Marketplace and refresh. 3) Inspect the catalog request. 4) Install a published plugin from the marketplace.
- **Expected**: The page has no source controls; every profile requests `https://plugins.aiuo.net/catalog.json` and ignores the persisted source and custom URL; install uses the official platform resolve path, with the official catalog URL as the verified fallback; legacy settings remain readable and require no migration.
- **Specs linked**: `07-plugins/07-plugin-marketplace.md` §2
- **Acceptance**: G (remote marketplace source)
- **Status**: Documented / host-core unit covered

## E2E-024Z: Windows curl handles offline revocation checks and localized errors

- **Preconditions**: Windows x64 host with curl built against Schannel. For the
  offline-revocation case, use a proxy route that can reach the HTTPS fixture
  while its certificate revocation distribution point is unavailable. For the
  diagnostic case, force the catalog request to fail with localized, non-UTF-8
  curl output (a deterministic fake curl may emit GBK stderr and exit 35).
- **Steps**: 1) Open Extensions → Marketplace. 2) Refresh the catalog and
  install a package through the system proxy while the revocation distribution
  point is offline. 3) Confirm the installed curl advertises
  `--ssl-revoke-best-effort` and inspect the verified package. 4) Force a
  localized curl/Schannel failure, refresh again, and inspect the error toast.
- **Expected**: When the installed Schannel curl supports the option, catalog
  and package requests tolerate an unavailable revocation distribution point
  without disabling certificate verification; package size and SHA-256 checks
  still gate installation. A real network/TLS failure remains
  `PLUGIN_NETWORK`, with localized diagnostics readable and no Unicode
  replacement characters.
- **Specs linked**: `07-plugins/07-plugin-marketplace.md`,
  `03-runtime/07-process-model.md`, ADR 0177
- **Acceptance**: G (remote marketplace source)
- **Status**: Documented; host-core unit covered; Windows proxy/TLS validation pending

## E2E-024B: Marketplace install with permission review

- **Preconditions**: App running; official market catalog available.
- **Steps**: 1) Open Extensions → Marketplace. 2) Install `demo.workspace-notes`. 3) Read the risk-tiered permission dialog. 4) Accept high-risk permissions.
- **Expected**: Permissions are grouped High / Medium / Low with plain-language explanations before any download; the review dialog mounts on the viewport overlay host above the expanded sidebar; the host refreshes marketplace metadata immediately before download so a stale UI cache cannot pair an old checksum with a current package; plugin installed from the marketplace package, checksum verified, permissions granted, panel/tools available; the installed tab and risk-grouped rows reflect the new plugin without a separate overview card row.
- **Specs linked**: `07-plugins/07-plugin-marketplace.md`, `07-plugins/13-plugin-permissions-matrix.md`
- **Acceptance**: G (marketplace install + permission review)
- **Status**: Documented / host-core covered by unit tests + protocol methods

## E2E-024R: Install a center-published plugin from the official marketplace

- **Preconditions**: A `schemaVersion: 2` catalog served from the distribution repository, with one plugin carrying provenance and an approved review verdict, its package under `packages/`. A second fixture declares `artifactBaseUrl` for the mirror/enterprise case.
- **Steps**: 1) Open a plugin's detail sheet. 2) Read the Source section. 3) Install the selected version through the official resolve path. 4) Repeat with a local resolve stub that returns no source, exercising the official catalog URL fallback and an `artifactBaseUrl` fixture.
- **Expected**: Center-published plugins appear in the fixed official catalog; the detail sheet shows the source repository, commit, and builder before install; resolve mirror bytes match the platform digest, while catalog fallback bytes match the catalog digest; the installed record keeps publisher, trust tier, and source pin.
- **Specs linked**: `07-plugins/07-plugin-marketplace.md`, `07-plugins/15-plugin-center.md`
- **Acceptance**: G (publisher-owned source distribution)
- **Status**: Documented / host-core covered by unit tests

## E2E-024S: Package host allowlist refuses an untrusted download

- **Preconditions**: An isolated host-core test uses `PI_DESKTOP_PLUGIN_MARKET_URL` to load a catalog fixture whose version URL points at a host outside the allowlist, plus fixtures with embedded credentials and plain HTTP.
- **Steps**: 1) Refresh the fixture catalog. 2) Inspect the plugin card and detail sheet. 3) Attempt an install. 4) Repeat with a private catalog whose packages sit on its own host.
- **Expected**: The row does not offer an install action for an off-allowlist URL; an attempted install fails with `PLUGIN_MARKET_UNTRUSTED_HOST` naming the rejected host before any request leaves the machine; a credentialed URL and non-loopback plain HTTP are refused the same way; a private catalog can still serve packages from the host that served it, without widening the allowlist for third-party hosts.
- **Specs linked**: `07-plugins/07-plugin-marketplace.md`, `07-plugins/04-plugin-security.md`
- **Acceptance**: G (marketplace download boundary)
- **Status**: Documented / host-core covered by unit tests

## E2E-024T: A withdrawn version is not offered, installed, or hidden

- **Preconditions**: A catalog where the newest version is `yanked` with a reason, an older version is live, and the yanked version is installed locally.
- **Steps**: 1) Open the plugin's detail sheet. 2) Inspect version history. 3) Select the withdrawn version. 4) Run Check for updates. 5) Run Apply automatic updates. 6) Inspect the installed row.
- **Expected**: The offered latest version is the newest non-yanked one; the withdrawn version stays in history with its reason and a struck-through number; selecting it disables the install action with withdrawn copy rather than not-yet-published copy; an explicit install of it fails with `PLUGIN_MARKET_YANKED` and the reason; no update is offered when the newest live version is not newer than the installed one, so a downgrade is never presented as an update; the installed row is flagged as needing attention and the plugin keeps running.
- **Specs linked**: `07-plugins/08-plugin-signing-updates.md`
- **Acceptance**: G (incident response propagation)
- **Status**: Documented / host-core covered by unit tests

## E2E-024U: Trust tier and host version bound are enforced by the client

- **Preconditions**: Test runs use `PI_DESKTOP_PLUGIN_MARKET_URL` for a catalog claiming `trust: "verified"`, a catalog with an unrecognised tier, and a version whose `minPiDesktop` exceeds the running host.
- **Steps**: 1) Load the fixture catalog. 2) Inspect the card and detail sheet badges. 3) Attempt to install the version pinned to a newer host. 4) Repeat with a `minPiDesktop` that is a range expression rather than a version.
- **Expected**: A `verified` claim from a non-official source renders as community with no shield; an unrecognised tier renders as unknown; the version requiring a newer host is not offered and an explicit install fails with `PLUGIN_HOST_TOO_OLD` naming both versions; an unparseable bound is ignored rather than making the plugin uninstallable.
- **Specs linked**: `07-plugins/07-plugin-marketplace.md`, `07-plugins/15-plugin-center.md`
- **Acceptance**: G (trust presentation)
- **Status**: Documented / host-core covered by unit tests

## E2E-024V: Publisher pins a version with pi-plugin publish

- **Preconditions**: A plugin directory inside a git repository with an https or ssh origin remote.
- **Steps**: 1) Run `pi-plugin publish` with uncommitted changes. 2) Commit and tag, then rerun. 3) Rerun on a commit with no tag. 4) Rerun with a remote containing credentials. 5) Feed the resulting registry entry through the center's catalog build and the client preflight.
- **Expected**: A dirty worktree is refused so the submitted commit describes the packaged bytes; a clean run writes the package, its sha256, the canonical repository URL, the tag ref, the resolved commit, and the plugin subdirectory into a submission payload; an untagged commit is accepted with a warning; a credentialed remote is refused; the generated catalog passes the same preflight the client ships.
- **Specs linked**: `07-plugins/10-plugin-devex.md`, `07-plugins/15-plugin-center.md`
- **Acceptance**: G (publisher tooling)
- **Status**: Documented / devkit covered by unit tests

## E2E-024C: Plugin package install and auto-update path

- **Preconditions**: Marketplace catalog has a newer version or local `.piplug`.
- **Steps**: 1) Install package from the header overflow menu. 2) Enable auto-update from the row overflow menu. 3) Reopen Extensions while the marketplace is slow or unavailable and confirm the Installed surface and Marketplace tab remain usable. 4) Confirm the installed list refreshes update metadata from the local catalog. 5) Run Check for updates, then Apply automatic updates.
- **Expected**: The Extensions surface does not wait for a remote request during its silent cache-only check; the row moves to Updates available and the update banner reports the count; the highest semantic version is selected even when the catalog version array is not newest-first; the explicit check fetches the current catalog and uses the cached catalog offline; permissions the new version adds are tagged New in the review dialog; auto-update applies only when the permission diff is empty or pre-granted.
- **Specs linked**: `07-plugins/06-plugin-packaging.md`, `07-plugins/08-plugin-signing-updates.md`
- **Acceptance**: G (package install + update policy)
- **Status**: Documented

## E2E-024Q: Marketplace update diagnosis and release-data gate

- **Preconditions**: A catalog fixture contains an installed `0.5.0` plugin, a
  `0.5.1` version, and either unsorted version entries or intentionally missing
  package metadata.
- **Steps**: 1) Record the plugin ID, installed version, displayed latest
  version, catalog URL, and local cache path. 2) Fetch the live/fixture catalog
  and inspect the exact entry. 3) Inspect the installed registry separately.
  4) Run `pnpm check:marketplace -- --url <catalog> --plugin <id>`. 5) Run the
  update check against the fixture.
- **Expected**: The failure is classified as catalog data, fetch/cache,
  host comparison, IPC propagation, or renderer presentation before code is
  changed; the preflight reports every missing checksum, URL, package size, or
  permissions field; an incomplete release may be shown for discovery but is
  not installable; a valid `0.5.1` is detected regardless of catalog ordering;
  the final fix includes a regression test for the diagnosed boundary.
- **Specs linked**: `07-plugins/07-plugin-marketplace.md`,
  `07-plugins/08-plugin-signing-updates.md`,
  `06-delivery/03-ai-development-workflow.md`
- **Acceptance**: G (marketplace update diagnosis)
- **Status**: Documented / preflight script

## E2E-024H: Installed plugins surface state, risk, and failures

- **Preconditions**: At least one enabled plugin, one disabled plugin, and one plugin whose load failed.
- **Steps**: 1) Open Extensions → Installed while plugin changed events are arriving in a burst. 2) Read the tab and group counts. 3) Confirm the failed plugin sits under Needs attention with its error message. 4) Search by author and by permission. 5) Clear the search.
- **Expected**: The page remains usable during transient host backpressure: identical plugin and extension registry refreshes coalesce, and renderer-facing RPC calls retry explicit `HOST_OVERLOADED` responses with bounded backoff before surfacing an error. Plugins group as Needs attention / Updates available / Active / Turned off with counts; `status: "error" | "load_error"` renders the error message inline instead of being silent; each plugin is a card in an auto-filling grid, defaulting to a quiet name/id/version summary (plus a rating chip when the centre has one), while a Details disclosure reveals risk-tinted permission chips, capabilities, and resident service status; the single scope trigger opens explained Off / This project / Everywhere choices and the project picker; card icon actions expose hover/focus labels; the result count reflects the filtered subset and clearing restores every group.
- **Specs linked**: `04-ux/01-ui-ia.md`, `07-plugins/13-plugin-permissions-matrix.md`
- **Acceptance**: G (installed plugin management)
- **Status**: Documented

## E2E-024D: Isolated plugin panel host bridge

- **Preconditions**: Plugin with `ui.panel` enabled.
- **Steps**: 1) Set the app language to English and open a panel whose manifest declares localized `ui.title.en` and `ui.title.zh-CN`; confirm the native window/launcher identity remains available without a host-rendered title. 2) Set the app language to Simplified Chinese and reopen the panel; confirm the panel content remains plugin-owned. 3) While the panel stays open, switch the app language to Korean and confirm the live `appearance:changed` event updates the panel controls, safe-area reminder, and accessible labels without reopening it. 4) Open the panel on macOS, Windows, and Linux; confirm the same frameless 46px drag band, fixed top-right capsule fully contained inside that band, and exactly three accessible controls. 5) Exercise minimize, maximize, restore, close, keyboard focus, light/dark themes, page-defined light/dark backgrounds, and reduced motion on every platform. 6) Render a plugin-owned titlebar/toolbar; verify fixed/sticky UI uses `--pi-plugin-titlebar-height`, its interactive controls use `no-drag`, and clicks outside the capsule in the top 46px are treated as window dragging. 7) On Windows with classic scrollbars, scroll a panel with content overflow and inspect the right edge. 8) Open a development plugin and confirm the localized reminder explains that the top 46px is not clickable outside the capsule. 9) Reopen a minimized panel. 10) Invoke panel bridge APIs (`ui.showToast`, optional fs/net with grants). 11) Close the panel from the capsule and by disabling or uninstalling the plugin. 12) Repeat with a panel and a docked work-panel view open and quit the app, then read the main-process log.
- **Expected**: Panel runs in its sandboxed window/partition; all three platforms use one host-owned frameless chrome contract with no native traffic lights, host-rendered title, or application menu; the top drag band is exactly 46px, and the minimal capsule stays fixed at the top-right without exceeding it. The capsule contains minimize/maximize-or-restore/close, follows the plugin page's surface/text colors, and never forces a black surface onto a light page. A v2 page marked `pi-plugin-chrome` uses `--pi-plugin-titlebar-height` and starts its own content directly below the 46px band without an additive duplicate spacer; a legacy page keeps the compatibility offset. A panel's stable scrollbar gutter is scoped to its actual content scroller; Windows does not show a second root-level empty side rail outside the page surface. The plugin owns its title and toolbar; the host drag strip remains usable, blocks clicks outside the capsule, and development panels alone show the reminder. Reopening restores the existing panel; switching to Korean while the panel remains open updates the host capsule, reminder, and accessible labels in place; bridge calls remain permission-checked and the host remains stable on panel close. Closing a panel must not throw a main-process `TypeError: Object has been destroyed` or show an uncaught-exception dialog, and neither closing a panel nor quitting with panels and docked views open may log a panel-bridge failure for the page that is closing: a call from a page that is already gone is settled, and the panel and view pages are gone before the plugin runtime and the host stop.
- **Specs linked**: `03-runtime/01-ipc-protocol.md`, `04-ux/07-ui-design-system.md`, `07-plugins/01-plugin-system.md`, `07-plugins/03-plugin-api.md`, `07-plugins/04-plugin-security.md`, `07-plugins/12-plugin-ipc-and-host-services.md`, ADR 0081, ADR 0082, ADR 0092, ADR 0093
- **Acceptance**: G (isolated panel)
- **Status**: Documented

Initial-load timeout check: Open a fixture panel from Extensions → Installed
whose page load remains pending. After 15 seconds, the open request must report
`PANEL_LOAD_TIMEOUT` through the initiating action and destroy the hidden
window; opening a normal panel afterward must still work.

## E2E-024AA: Plugin-owned UI follows the host locale

- **Preconditions**: A loaded plugin with a panel or settings destination, and a plugin process subscribed to `pi.events.on("appearance:changed")`.
- **Steps**: 1) Call `pi.app.getLocale` / `app.getAppearance` and confirm the tag matches Settings → language. 2) Switch the app language while the plugin stays loaded. 3) Confirm generated `contributes.settings` titles remain the author-language strings. 4) Confirm the plugin process and any open panel receive `appearance:changed` with the new `locale` and restyle their own copy.
- **Expected**: The host publishes language only. Plugin-owned copy changes without a reload. The generated settings sheet does not parse `{ en, "zh-CN" }` maps. Host-owned identity still follows `manifest.i18n` (ADR 0267).
- **Specs linked**: `07-plugins/03-plugin-api.md`, `07-plugins/02-plugin-manifest-schema.md`, `04-ux/02-i18n-english-first.md`, ADR 0280
- **Acceptance**: G (plugin i18n)
- **Status**: Automated in part (`apps/desktop/test/plugin-settings.test.mjs`, `plugin-work-panel-views.test.mjs`); UI walk-through Documented

## E2E-024Y: Large-file plugin reads and dropped-file grants stay host-gated

- **Preconditions**: A test plugin declares `fs.read`; the workspace contains a
  readable log and a protected credential fixture; the plugin panel is open.
- **Steps**: 1) Pick a directory and open a large log. 2) Confirm initial page,
  search, follow, and a file-growth poll complete through `fs.stat` and bounded
  `fs.readRange`. 3) Drag a regular file into the panel and open it. 4) Drag a
  second file or forge an absolute path with the first grant and retry. 5)
  Reload/unload the plugin and retry the old grant.
- **Expected**: Directory reads remain relative to the selected root and are
  permission/audit checked. Range reads reject invalid values and lengths above
  8 MiB, return an empty byte array at EOF, and preserve total size. A real
  drop creates a one-file, read-only, memory-only grant; the dropped file uses
  the same paging/search/follow engine, while another path, a protected path,
  and a grant after unload fail closed with `PERMISSION_DENIED` or `NOT_FOUND`.
  No renderer worker or raw plugin `node:fs` path is used.
- **Specs linked**: `07-plugins/03-plugin-api.md`,
  `07-plugins/04-plugin-security.md`, `07-plugins/12-plugin-ipc-and-host-services.md`,
  `07-plugins/13-plugin-permissions-matrix.md`, ADR 0190
- **Acceptance**: Security + G (plugin host services)
- **Status**: Unit/integration-covered; real drag gesture remains manual

## E2E-PLUGIN-fetch-redirect-policy

- **Preconditions**: Current-main task candidate, built workspace packages,
  real Node plugin child process and two loopback HTTP fixtures; no real user
  profile, provider or credentials.
- **Steps**: Load the example probe plugin and invoke its `probe.fetch` operation
  through the production panel bridge. Query capabilities, request error/manual/
  follow, and repeat against the injected single-hop transport. Exercise invalid
  modes, missing grants, disallowed targets, relative/missing Location, loops,
  and timeout. Test 301/302/303/307/308 and default compatibility.
- **Expected**: Error returns REDIRECT_DISALLOWED and manual returns the original
  response, both with zero target requests. Follow reaches the target only after
  egress authorization. Error codes survive child IPC; refusals are audited.
- **Specs linked**: `07-plugins/03-plugin-api.md`, `07-plugins/04-plugin-security.md`
- **Acceptance**: G + Security
- **Milestone**: Post-MVP plugin API
- **Status**: Automated protocol E2E via `pnpm test:e2e:plugin-fetch-redirect`.
  The sample panel's native-window gesture remains manual; no desktop is attached.

## E2E-024E: High-risk plugin APIs require grants

- **Preconditions**: Notes plugin installed with explicit grants.
- **Steps**: 1) Call `fs.writeText` / `net.fetch` / `shell.openExternal` through plugin runtime or panel bridge. 2) Revoke one permission and retry.
- **Expected**: Granted calls succeed with audit; revoked/undeclared calls fail with `PERMISSION_DENIED` and do not crash the app.
- **Specs linked**: `07-plugins/13-plugin-permissions-matrix.md`, `07-plugins/04-plugin-security.md`
- **Acceptance**: Security + G
- **Status**: Documented

## E2E-024W: Plugin clipboard history captures bounded text and images

- **Preconditions**: The app is running; a test plugin declares and is granted
  `clipboard.read`; the Composer can receive one text paste and one image paste.
- **Steps**: 1) Paste text into the Composer, paste an image into the Composer,
  then invoke `pi.clipboard.getHistory()`. 2) Invoke it again and mutate the
  returned image bytes. 3) Paste the same text consecutively and invoke the API.
  4) Leave the app idle with an image on the OS clipboard and verify no
  clipboard sampling occurs. 5) Revoke `clipboard.read` and invoke it again.
  6) Add fixtures over the text/image caps and older than the retention window.
- **Expected**: The result is newest-first with text and image entries
  interleaved, ISO timestamps, PNG bytes, and image dimensions; mutating the
  result does not mutate host state. Consecutive duplicates collapse with a
  refreshed timestamp. Entries over the per-entry caps and expired entries are
  absent, and the host total/entry caps are enforced. A paste causes only the
  event's already-read content to be recorded; the host does not reread the OS
  clipboard or sample it while idle. The API reuses the `clipboard.read` grant,
  denied calls fail with `PERMISSION_DENIED`, and a successful call emits an
  audit entry containing the returned entry count.
- **Specs linked**: `07-plugins/03-plugin-api.md`,
  `07-plugins/04-plugin-security.md`,
  `07-plugins/13-plugin-permissions-matrix.md`, ADR 0115
- **Acceptance**: G (plugin clipboard history) + Security
- **Status**: Unit-covered (`clipboard-history.test.mjs`); Electron clipboard
  capture remains manual

## E2E-024I: Plugin skills reach the agent and load on demand

- **Preconditions**: `examples/plugins/hello` enabled with `agent.prompt.inject` granted; a second copy of the manifest without that permission available; one workspace that is a plugin directory and one that is not.
- **Steps**: 1) Start a session and ask the agent what skills it has. 2) Ask it to follow the Hello demo skill so it calls the `Skill` tool. 3) Edit the skill document and repeat step 2. 4) Disable the plugin and start a new turn. 5) Load the variant without `agent.prompt.inject` and repeat step 1. 6) Declare a document larger than the per-skill cap. 7) Open each of the two workspaces in turn.
- **Expected**: The catalog lists the skill id, name, and trimmed description but no body or path, after the built-in skills and before the project instruction chain; the `Skill` schema is loaded through `ToolSearch` only when requested and reads the edited file without a restart; the loaded result identifies the actual `SKILL.md` path and its parent directory before the body so relative references resolve against that document; disabling the plugin rebuilds the runtime so the skill disappears from the next turn; the variant without the permission loads normally and contributes no skills; the oversized document is skipped with an audit line rather than clamped into the prompt; the built-in `plugin-development` skill is catalogued in the plugin workspace and absent in the other, while `PluginCheck` is listed in the bounded on-demand tool catalog in both.
- **Specs linked**: `07-plugins/02-plugin-manifest-schema.md`, `07-plugins/04-plugin-security.md` §7.1, `07-plugins/10-plugin-devex.md`, ADR 0039, ADR 0037, D174
- **Acceptance**: G (skill activation) + E (tools & permissions) + D (high-risk permission gating)
- **Status**: Unit-covered (`plugin-skills.test.mjs`, agent-runtime prompt/digest tests); agent-facing scenario Draft

## E2E-024J: Plugin theme applies and falls back when withdrawn

- **Preconditions**: A marketplace/package-installable `examples/plugins/hello` variant (`demo.hello`) whose `midnight` theme CSS references a declared package-relative image at `art/preview.png`; a plugin with CSS using `@import` or remote `url()` for rejection plus a comment-only variant; an asset theme with `windowAppearance` variants with and without `ui.window.appearance`, including `cornerRadius: 0` and an invalid value above 24.
- **Steps**: 1) Install the packaged Hello variant from Marketplace or its `.piplug` package and select `Hello Midnight` in Settings → Appearance → Theme. 2) Restart the app. 3) Disable the providing plugin. 4) Re-enable it, then uninstall it. 5) Load the plugin with unsafe CSS. 6) Load the comment-only variant. 7) Select the asset variant's theme on Windows/Linux and on macOS, verify the package-relative image renders through `plugin-asset:` in the shell and the plugin's panel, and load a sheet with an undeclared package-relative `url()` to verify it is refused. 8) Deselect its theme after removing `ui.window.appearance`.
- **Expected**: The packaged plugin installs successfully with its relative image resolved inside the plugin root; its theme appears in the picker alongside the built-ins and applies immediately, with the image served through `plugin-asset:`; the choice survives restart as `plugin:demo.hello:midnight`; disabling or uninstalling the provider falls back to `system` instead of an unstyled shell; unsafe CSS is refused at load with the reason logged and no `<style>` element injected; the comment-only sheet loads and contributes its theme, because the sanitizer only inspects CSS the browser would apply; the declared asset paints through `plugin-asset:` in the shell and in the plugin's own panel, an undeclared reference is refused with the reason logged, the declared background colours the native window on Windows/Linux and is never sent on macOS, and `cornerRadius: 0` makes only the Windows main window rectangular while the authorized theme is selected. Deselecting the theme or dropping the grant restores the host background and the global 12 DIP `--radius-md` Windows corners; a radius above 24 rejects without changing the window. The whole shell follows the theme, including the work-panel column, its header, and the browser/file viewer strips, all of which read `--ds-bg-dock` / `--ds-bg-dock-raised` rather than a literal.
- **Specs linked**: `07-plugins/02-plugin-manifest-schema.md`, `07-plugins/04-plugin-security.md` §3.1, `04-ux/07-ui-design-system.md`, D175
- **Acceptance**: G (theme contribution) + Security
- **Status**: Unit-covered (`plugin-themes.test.mjs`, `theme-css` SDK tests, host-core package-relative asset/install tests). `test:e2e:window-controls` selects an authorized test plugin theme with `cornerRadius: 0` and returns to a built-in theme, verifying the native shape follows both choices. The broader asset visual scenario remains Draft.

## E2E-PLUGIN-runtime-theme-apis

- **Preconditions**: A plugin with `ui.theme` that can drive `pi.app.setTheme` and `pi.themes.upsert` / `remove` (panel or command). Settings → Appearance shows the searchable theme picker.
- **Steps**: 1) From the plugin UI, call `themes.upsert` with a new theme id and distinct CSS. 2) Confirm the theme appears in Settings without reload/disable. 3) Call `app.setTheme` to select it. 4) Call `themes.upsert` again with different CSS while it is active. 5) Call `themes.remove` on an inactive theme. 6) Call `app.setTheme` with an unknown id. 7) Upsert a ninth theme (former hard cap was 8).
- **Expected**: The new theme is listed and applies immediately through the same path as Settings; live CSS edits restyle the shell without plugin reload; remove drops the picker row and the event refreshes the list; an unknown id rejects with `INVALID_ARGUMENT` and leaves the preference unchanged; the ninth theme is accepted. `settingsChanged` reaches the renderer store; `appearance:changed` reaches open panels.
- **Specs linked**: `07-plugins/03-plugin-api.md`, `07-plugins/12-plugin-ipc-and-host-services.md`, `07-plugins/13-plugin-permissions-matrix.md`, ADR 0260, D417
- **Acceptance**: G (theme contribution) + Security
- **Status**: Unit-covered (`plugin-themes.test.mjs`); interactive scenario Draft

## E2E-PLUGIN-sidebar-gradient-token

- **Preconditions**: A plugin theme that sets `--ds-bg-sidebar` to a solid color and `--ds-bg-sidebar-image` to a `linear-gradient(...)`; Windows/Linux and macOS shells.
- **Steps**: 1) Select the theme. 2) Inspect the sidebar plate and rail. 3) Confirm borders/glass tint still resolve from the color token. 4) Switch back to a built-in theme.
- **Expected**: The gradient paints as `background-image` over the color plate on all platforms; macOS sheen still overlays the image layer; borders and `color-mix` consumers do not break; clearing the token returns the plain sidebar.
- **Specs linked**: `04-ux/07-ui-design-system.md`, ADR 0260, D417
- **Acceptance**: Visual / platform
- **Status**: CSS unit contracts in `plugin-themes.test.mjs`; visual scenario Draft

## E2E-024K: Plugin MCP server tools reach the agent

- **Preconditions**: A plugin declaring one `stdio` and one non-loopback HTTP MCP server against trusted local-network stubs; `mcp.server.local` and `mcp.server.remote` granted; the HTTP host is listed in `net.domains`; a settings key holding the stub credential.
- **Steps**: 1) Enable the plugin and confirm no server process starts yet. 2) Ask the agent to call a discovered tool. 3) Inspect the stub's received environment/headers. 4) Make the stub fail a call, then run an HTTP tool that takes longer than the 10s handshake budget but less than the 100s call budget, then time a call out beyond its own budget. 5) Grow the stdio stub's catalog past the old 64-tool cap and re-discover it. 6) Disable the plugin.
- **Expected**: Servers connect lazily on first use; tools appear as `plugin_demo_*_<serverId>_<tool>` at `risk: "medium"` with per-call audit; the stdio child receives only the declared `env` values plus PATH/temp/locale, never host provider keys; the non-loopback HTTP endpoint is accepted only because its host is declared, and its unencrypted transport is visible in review; a redirect to an undeclared host is blocked before the second request; the HTTP tool can finish after the handshake budget while a call that exceeds its own budget fails; other failures and timeouts return tool errors without crashing the plugin or the host; a catalog larger than the old 64-tool cap arrives whole, while a server that breaks a per-server guard (count, pages, cursor, traversal time) is refused instead of contributing a prefix of its catalog; disable disconnects both servers.
- **Specs linked**: `07-plugins/02-plugin-manifest-schema.md`, `07-plugins/04-plugin-security.md` §8.1, ADR 0038, ADR 0142, D176, D281, D452
- **Acceptance**: G (MCP bridge) + E (tools & permissions) + Security
- **Status**: Unit-covered (`plugin-mcp.test.mjs` stdio + HTTP stubs); agent-facing scenario Draft

## E2E-MCP-pi-client-owner-policy: Pi protocol under existing Desktop owners

- **Preconditions**: Pi 1.1.0 with the pinned host-policy patch; offline stdio and
  HTTP fixtures, no paid provider or user credentials.
- **Steps**: Run `plugin-mcp.test.mjs`, `user-mcp.test.mjs`,
  `mcp-stdio-launch.test.mjs`, `mcp-call-registry.test.mjs`, `mcp-oauth.test.mjs`,
  and `mcp-oauth-discovery.test.mjs` under `apps/desktop/test` using `node --test`.
- **Expected**: Concurrent discovery starts one process; host launch/env/egress
  policies remain enforced; Pi delivers progress and structured content; progress
  cannot extend the total call deadline; cancellation reaches the stdio peer and
  leaves other calls usable. OAuth uses Pi DCR/PKCE/refresh with host TLS/redirect,
  scope, callback-state, and encrypted-storage boundaries. No legacy client runs.
- **Status**: Offline integration-covered; packaged Electron journey NOT RUN.

## E2E-MCP-CANCEL: Stop interrupts only the calling session's MCP request

- **Preconditions**: Two Agent sessions share one user or plugin MCP server;
  each has a pending tool call, and the server records cancellation notifications.
- **Steps**: Stop the first session while both calls are pending, then allow the
  second call to finish. Repeat with a remote HTTP server and a stdio server.
- **Expected**: The first request receives `notifications/cancelled` and cannot
  produce a successful tool result after Stop. The second session's call finishes normally;
  its server connection remains available. Closing the app cancels remaining
  requests without retaining listeners.
- **Specs linked**: `03-runtime/01-ipc-protocol.md` §12a,
  `07-plugins/04-plugin-security.md` §8.1
- **Status**: Client and session-isolation unit-covered; full desktop journey Draft

## E2E-MCP-tool-requires-approval: User MCP tools prompt under ask and accept-edits

- **Preconditions**: A project-bound Agent session; one user-configured stdio
  MCP server whose tool list annotates a tool as read-only/low risk.
- **Steps**: 1) With the session in `ask`, ask the agent to call the MCP tool.
  2) Answer the card with allow-once, call it again, then answer with
  allow-session and call it a third time. 3) Switch to `accept-edits` in a new
  session and repeat the call. 4) Switch to `auto` and call it. 5) Switch to
  Plan, then Goal, and call it.
- **Expected**: Under `ask` and `accept-edits` every call shows an approval card
  with reason "MCP server tool requires approval" at `medium` risk, regardless of
  the server's self-declared annotation. Allow-once covers only that call;
  allow-session suppresses further cards for the same `mcp_<serverId>_<tool>`
  name in that session only, and does not cover other tools of the server.
  `auto` runs the tool without a card. Plan and Goal deny it even with a
  session grant.
- **Specs linked**: `03-runtime/03-tools-and-permissions.md`,
  `05-security/01-security.md`, D640, ADR `mcp-tool-approval-risk`
- **Acceptance**: E (tools & permissions) + Security
- **Status**: Unit-covered (host-core `permissions.rs` MCP risk and mode tests);
  desktop journey Draft

## E2E-024L: Resident plugin service is supervised and visible

- **Preconditions**: `examples/plugins/hello` enabled with `background.service` granted.
- **Steps**: 1) Open Extensions → Installed and expand Details on the plugin row to read the `Greeter heartbeat` chip. 2) Kill the plugin's utility process and watch the chip. 3) Kill it repeatedly past the restart ceiling. 4) Disable and re-enable the plugin. 5) Revoke `background.service` and reload.
- **Expected**: The Details disclosure exposes a chip that reports `running` after load; a kill shows `failed` then `running` again with an incremented restart count and backoff between attempts; past five attempts the plugin stays `failed` and stops retrying; manual disable/enable cancels the pending timer and resets the counter; without the permission the service never starts and the skip is audited.
- **Specs linked**: `07-plugins/05-plugin-lifecycle.md` §3.1, ADR 0040, D177
- **Acceptance**: G (resident services)
- **Status**: Unit-covered (`plugin-services.test.mjs` supervision + backoff); manual kill scenario Draft

## E2E-024M: Bus messages cross plugins only as declared

- **Preconditions**: Two plugins enabled — one publishing `demo.*` topics, one subscribing `demo.**` — with `bus.publish` / `bus.subscribe` granted.
- **Steps**: 1) Run the publisher's command and watch the subscriber. 2) Publish a topic absent from `contributes.bus.publish`. 3) Subscribe to a pattern absent from `contributes.bus.subscribe`. 4) Publish a payload over 64KB and exceed 100 publishes in 10s. 5) Unload the subscriber and publish again.
- **Expected**: The subscriber receives `{ topic, from, payload, at }` and the publisher never receives its own message; undeclared publish and subscribe both fail `PERMISSION_DENIED` with an audit line naming the topic; the oversized payload and the rate burst fail `LIMIT_EXCEEDED` / `RATE_LIMITED`; publishing to a departed subscriber succeeds with a smaller fan-out and no host error.
- **Specs linked**: `07-plugins/02-plugin-manifest-schema.md` §5.1, `07-plugins/04-plugin-security.md` §5.1, ADR 0040, D178
- **Acceptance**: G (message bus) + Security
- **Status**: Unit-covered (`plugin-bus.test.mjs` delivery, filtering, caps); two-plugin manual scenario Draft

## E2E-024N: Extensions page density and theme-readable actions

- **Preconditions**: App running with at least one installed extension and one
  available marketplace action; dark and light themes available.
- **Steps**: 1) Open Extensions in dark theme. 2) On Windows/Linux, confirm
  the compact two-tier header presents the extension mark/title and contextual
  action rail below the native window-control band, then confirm the Installed and Marketplace tabs are the only tabs and both reach the content
  without a four-card numeric overview band or explanatory header/section
  paragraphs. 3) Confirm installed plugins are cards in an
  auto-filling grid — cards keep their width above 340px and collapse below —
  then expand Details on one card and inspect its capabilities, service status,
  and permissions. 4) Use the compact scope
  control and its explained scope menu, the card's one call to action (Update to
  the available version, or Open panel), and the 28px settings and overflow icon
  actions; widen and narrow the window to see the rail wrap at the card's left
  edge rather than clip. 5)
  Switch to light theme and repeat. 6) Keyboard-focus the Details disclosure,
  scope states, and each action.
- **Expected**: The four numeric overview cards are absent; the header uses a
  quiet 24px extension mark, 18px title, restrained 30px action controls, and
  a visible keyboard focus ring; tab counts,
  installed group counts, and any update alert remain available in their
  relevant surfaces. The page header, section headers, empty states, and update
  alert use compact labels and actions; decision-specific explanations remain
  in disclosures, details, and dialogs. Cards keep their default height low while the
  disclosure exposes the complete secondary readout. The scope trigger stays
  aligned with the card's control rail, its menu explains each state, and icon
  actions remain visible at rest while showing labels on hover and focus; a
  disabled card shows no primary action and no settings icon.
  Primary and secondary buttons keep
  visible semantic surfaces, text, borders, hover states, and focus rings in
  both themes, and keyboard focus does not depend on pointer hover.
- **Specs linked**: `04-ux/01-ui-ia.md`, `04-ux/07-ui-design-system.md`,
  `07-plugins/07-plugin-marketplace.md`, ADR 0058, D196
- **Acceptance**: G (Extensions page) + Quality
- **Status**: Unit-covered (`extensions-page.test.mjs`,
  `plugins-page-style.test.mjs`, `plugin-reviews-surface.test.mjs`);
  visual scenario Draft

## E2E-024O: Marketplace hides development-only sample plugins

- **Preconditions**: App running; the official catalog contains the
  development fixtures `demo.hello` or `demo.workspace-summary` and at least
  one product plugin.
- **Steps**: 1) Open Extensions → Marketplace with an empty search. 2) Search
  for `Hello`, `Workspace Notes`, and `Workspace Summary` in turn. 3) Inspect
  the category filters and result cards. 4) Open Installed and verify an
  already-installed sample remains manageable.
- **Expected**: Entries whose IDs begin with `demo.` never appear in the
  marketplace cards, categories, or search results; product plugins remain
  discoverable. An already-installed sample is still listed under Installed so
  it can be disabled or uninstalled rather than becoming an unmanaged runtime.
- **Specs linked**: `07-plugins/07-plugin-marketplace.md`,
  `04-ux/01-ui-ia.md`
- **Acceptance**: G (Extensions page) + Quality
- **Status**: Unit-covered (`extensions-page.test.mjs`); visual scenario Draft

## E2E-025: Disable plugin removes contributions

- **Preconditions**: Plugin enabled and contributions visible.
- **Steps**: 1) Disable the plugin on the Extensions page. 2) Check global search and agent tools.
- **Expected**: Commands and tools disappear; no leftover contributions.
- **Specs linked**: `07-plugins/05-plugin-lifecycle.md`
- **Acceptance**: G (disable removes contributions)
- **Milestone**: M4
- **Status**: Automated (protocol smoke: disable clears enabled flag; global search removal manual)

## E2E-026: Plugin error does not crash app

- **Preconditions**: Plugin loaded.
- **Steps**: 1) Trigger a scenario where plugin throws an error. 2) Observe app behavior.
- **Expected**: App remains running; error is captured and reported; no crash.
- **Specs linked**: `07-plugins/04-plugin-security.md`
- **Acceptance**: G (plugin error → no crash)
- **Milestone**: M4
- **Status**: Draft

## E2E-024X: Page copy stays concise in both locales

- **Preconditions**: App running with English and Simplified Chinese available; project archive, Scheduled, Extensions, and Agent capability destinations are reachable.
- **Steps**: 1) Open each destination in English and inspect its header, toolbar, empty state, and primary action. 2) Switch to 简体中文 and repeat. 3) Trigger a permission, validation, destructive-action, or provider-error state.
- **Expected**: Page headers do not repeat their title as explanatory subtitles; empty states use a concise title and action, with body text only when context or a required next step is necessary. Settings and capability pages omit prose that only explains obvious controls. Permission, security, validation, destructive-action, keyboard, scope, and error details remain visible in both locales.
- **Specs linked**: `04-ux/01-ui-ia.md`, `04-ux/07-ui-design-system.md`
- **Acceptance**: Quality (concise page copy)
- **Status**: Unit-covered (`packages/i18n/test/user-facing-copy.test.mjs`); visual scenario Draft

## E2E-248: Subagent details open as closable work-panel tabs with a read-only composer

- **Preconditions**: A project-bound Agent session whose assistant emits at
  least two `Task` calls — one named `explorer` and one resumed `explorer`
  follow-up — plus one `Task` that ends in failure; the work panel closed.
- **Steps**:
  1. Run the turn. Without clicking anything, verify the panel stays closed
     while the delegates run (no tab is opened automatically).
  2. Click the `explorer` topology node. Verify a `subagent` tab opens in the
     work panel's normal tab strip (labeled `explorer`, bot icon) and the
     tab strip keeps its other tabs.
  3. Click the second (resumed) `explorer` node. Verify a second tab opens
     labeled `explorer#2`, both tabs coexist, and each can be activated,
     drag-reordered, and closed via ×, middle-click, or Delete.
  4. In the resumed tab, verify the conversation reads `user: first prompt`,
     delegate rows, `user: follow-up prompt`, delegate rows — the same
     message-list language as the main transcript (user bubbles, tool rows,
     thinking rows, markdown answers).
  5. Verify the composer at the foot is a disabled two-row textarea whose
     placeholder reads the read-only hint, in every supported locale.
  6. Wait for the failed delegate to settle, open its tab, and verify the
     ended tab persists until manually closed.
  7. Switch to another session and back. Verify the tabs are restored per
     session and closed tabs stay closed.
- **Expected**: No auto-open on delegate start; N subagents = N coexisting
  closable tabs with deduplicated `name#n` labels; the tab body is the
  delegation's user/assistant message stream with follow-up prompts as user
  turns; the composer is disabled with the in-field hint and has no send
  path; ended delegates' tabs persist until closed; tabs are session-scoped.
- **Specs linked**: `04-ux/08-component-spec.md` (delegation tab),
  `04-ux/09-interaction-patterns.md` (work panel tabs)
- **Acceptance**: Quality
- **Milestone**: M6
- **Status**: Draft

## E2E-119: Parallel subagents report back without entering the parent's context

- **Preconditions**: A project-bound Agent session with the user home containing
  `~/.agents/subagents/scout.md` (read-only, no `tools` key), `~/.agents/subagents/fixer.md`
  (`tools: Read, Edit`), `~/.agents/subagents/pinned.md` (`model:` naming a second
  configured provider) and `~/.agents/subagents/broken.md` (missing `name`); a provider
  whose stream can be driven to emit two `Task` calls in one assistant message;
  permission mode `ask` so a delegate's `Edit` is gated; read access to
  `<data_dir>/sessions/<id>.jsonl` and the `messages` index.
- **Steps**:
  1. Prompt a turn in which the assistant emits two `Task` calls — `scout` and
     `pinned` — in one message. Observe the delegation card while both run and
     after each one settles; collapse it, then expand each node.
  2. Prompt a turn whose assistant message emits a single `Task` call — `scout`
     — and compare its presentation with step 1's.
  3. Prompt a turn in which two `fixer` delegates each edit a different file, and
     answer only the first permission card.
  4. Answer the second card, then prompt a third turn where two `fixer`
     delegates edit the **same** file.
  5. Start a fan-out and press Stop while one card is on screen and another is
     queued.
  6. Prompt a `Task` call naming `broken`, then one naming an agent that does not
     exist, then one whose definition pins an unconfigured provider.
  7. Switch the session to Plan, then to Goal, and inspect the tool catalog.
  8. Reload the session and re-expand the delegation card and every `Task`
     node.
  9. Open a node with a long description and long tool paths. Resize the work
     panel to its minimum, default, and a wider width and inspect the topology
     card and the delegation tab at each width. Long content wraps inside the
     committed width without dragging the divider to read a complete line.
- **Expected**:
  - Both delegates in step 1 run concurrently, and `pinned` streams on its own
    provider/model while the parent keeps the session's.
  - The two `Task` calls in step 1 form one full-width delegation card. While
    active it opens once and its header updates the subagent and settled counts;
    after settlement it keeps the user's expansion choice and reports aggregate
    success, warning, or issue state plus elapsed time.
  - The lone `Task` in step 2 draws the same card with a single delegate node —
    same root, connector, outcome, runtime and step count — and never the
    compact one-line tool row (D265). Its aggregate line is worded for one
    subagent, so no locale reads "1 个 Subagents" or "Subagents working".
  - The expanded card shows one main-agent root connected to `scout` and
    `pinned` in parent-row order, with no invented edge between delegates. Each
    node shows its agent, short description, explicit outcome, duration and step
    count. Expanding a node shows the brief, report exactly once, and
    `status`/`turns`/`toolCalls`. Delegate rows appear only inside that node,
    never in the turn stream or the minimap.
  - At narrow, default, and wide panel widths, topology titles, descriptions,
    and step summaries reflow within the card instead of using a fixed
    one-line ellipsis. Long tool paths, commands, and answer fragments in the
    delegation tab wrap inside the committed width, produce no horizontal
    overflow, and retain the tab as the only scroll owner.
  - If the parent keeps working after those `Task` calls — thinking, `Read`,
    `Grep`, or a lifecycle row — that work is a separate processing group, not
    rows inside the delegation card (D319). The card's tile, “Subagent working”
    header, and topology canvas contain only the `Task` nodes.
  - The parent's next request contains the reports and **no** delegate message or
    tool row; the rows are nonetheless present in the transcript file and the
    index with `meta.parentToolCallId` and `meta.agentName`.
  - Only the head permission card is rendered; it names the asking delegate and
    the number waiting behind it. Answering it reveals the next card, and neither
    answer resolves the other request.
  - `scout` cannot call `Edit` or `Write` at all; `fixer` can. Same-file edits in
    step 4 apply in a defined order and neither loses the other's write.
  - Stop denies both the shown and the queued request, and both delegates end
    `aborted` in text and icon inside their own `Task` nodes — the parent turn
    ends once and the aggregate card settles with a warning.
  - `broken` is absent from the catalog with a launch diagnostic and the session
    keeps its other three delegates; an unknown agent and an unresolvable model
    pin each fail as a `Task` tool error naming the cause, with no fallback to
    the session provider and no turn failure.
  - `Task` is absent from the catalog in Plan and Goal.
  - After reload the card is collapsed by default; re-expanding preserves node
    order, attribution, outcome and nested content exactly as they appeared
    live.
- **Specs linked**: `03-runtime/02-agent-runtime.md` §5f/§7.2b/§8,
  `03-runtime/03-tools-and-permissions.md` §10.2,
  `03-runtime/04-data-storage.md` §4.7a, `04-ux/03-permission-ux.md` §6a,
  `04-ux/08-component-spec.md` §9.9, ADR 0062, decisions-log D201, D265, D319
- **Acceptance**: C (conversation), E (tools & permissions), F (persistence),
  Security, Quality
- **Milestone**: M6
- **Status**: Covered by unit tests (2026-08-06): `packages/shared`
  `subagent-definition.test.ts` and `packages/agent-runtime`
  `subagent-definitions.test.ts` (frontmatter, tool filtering, malformed
  documents, global-user-shadows-builtin, legacy-`maxTurns` ignored);
  `subagent.test.ts` (report bounding, abort, event attribution, prompt
  framing) and `path-lock.test.ts`
  (same-path ordering, concurrency cap); desktop `permission-inline.test.mjs`
  (queue order, id-matched removal, tool-call removal, abort denying the queue,
  card copy), `subagent-wiring.test.mjs` (main-process discovery and model pins)
  and `subagent-transcript.test.mjs` + `assistant-turns.test.mjs` (nesting,
  single report print, memoization, the card gate that admits a lone delegation
  and the count-aware aggregate copy in both locales), plus
  `subagent-topology.test.mjs` (delegate detection, structured outcomes and
  aggregate counts). Full multi-provider fan-out and rendered topology
  interaction remain manual.

## E2E-SUBAGENT-legacy-turn-limit-frontmatter-is-ignored

- **Preconditions**: Agent mode. A user document
  `~/.agents/subagents/legacy-worker.md` whose frontmatter declares
  `maxTurns: 2` next to a valid `description` and `tools`, a second document
  that spells the same key `max-turns: 2`, and a third that never mentions it.
- **Steps**: 1) Open Settings → Subagents and confirm every row in the
  Built-in and Global groups renders with its tool grant and that no
  turn-limit field exists anywhere in the page or the editor's Advanced
  disclosure. 2) Delegate to `legacy-worker` and let it make more than two
  tool-calling turns. 3) Read the document back through the settings API and
  again as a raw file. 4) Open the editor on that row, save it without
  changing anything, and re-read the file.
- **Expected**: Both spellings load as valid definitions. The declared key is
  ignored exactly like any other unrecognized frontmatter key: no parse error,
  no warning or diagnostic naming it, the definition still resolves, and the
  file is not rewritten. The delegate is never stopped at two turns and never
  reports `truncated`; it ends only when it finishes or is `TaskStop`'d. No
  surface in the app, and no locale's `chat.subagentStatus` copy, reports a
  turn limit or a “Turn limit reached” status.
- **Specs linked**: `03-runtime/02-agent-runtime.md` §5f,
  `04-ux/06-settings-ia.md` §7, ADR 0253, decisions-log D423
- **Acceptance**: C (conversation), Quality
- **Milestone**: M6
- **Status**: Draft — unit covered in `packages/shared`,
  `packages/agent-runtime`, and the host-core `user_subagents` regression test;
  the full UI journey needs a capable environment.

## E2E-SUBAGENT-inherit-parent-tools

- **Preconditions**: Agent mode. A user document
  `~/.agents/subagents/worker.md` with `tools: inherit` (no assignable extras),
  at least one plugin or MCP tool in the parent catalog, and a non-empty Skill
  catalog. Built-in `explorer` remains on its whitelist.
- **Steps**:
  1. Confirm Settings → Agent → Subagents lists `worker` and that Edit shows
     Inherit parent tools on. Save without changing tools and reopen the file.
  2. Delegate `Task` to `worker` with a brief that needs a Skill id and a plugin
     tool the parent already had.
  3. Delegate `Task` to builtin `explorer` in the same session.
  4. Confirm `worker` cannot call `Task`, `ToolSearch`, `asktool`, or
     `new_context`.
- **Expected**:
  - Step 1 round-trips `tools: inherit`; the document does not disappear from
    `agents.active` and save does not rewrite it to `Read, Glob, Grep`.
  - `worker` receives Skill, the plugin/MCP tool, and the parent builtins minus
    the deny list. Its system prompt lists those names, includes the `# Skills`
    catalog, and says it may change files when the parent catalog includes
    Bash/Edit/Write.
  - `explorer` still has only `Read, Glob, Grep, Bash` and cannot call Skill.
  - The Task catalog line for `worker` reads `(tools: inherit)`.
- **Specs linked**: `03-runtime/03-tools-and-permissions.md` §10.2,
  `03-runtime/02-agent-runtime.md` §5f/§7.2b, ADR 0246, issue #215
- **Acceptance**: E (tools & permissions), Security
- **Milestone**: M6+
- **Status**: Automated by `test:e2e:subagents` (host-core create/read/on-disk/active/loader inherit round-trip) and `test:e2e:subagent-models` (real sidecar/local transport Task spawn, inherited Skill/plugin catalog minus the deny list, and builtin explorer isolation). Unit coverage remains in `packages/shared`, `packages/agent-runtime`, and host-core `user_subagents`; the UI inherit-checkbox journey remains Draft. Required suites: `test:e2e`, `test:e2e:subagents`, `test:e2e:subagent-models`.

## E2E-100: A pasted MCP server runs, and only where it is scoped

- **Preconditions**: Two projects on disk, `~/work/api` and `~/personal/site`.
  A local stdio MCP server available on PATH. An Agent session per project.
- **Steps**:
  1. Extensions → MCP → Import from JSON. Paste a `mcpServers` document holding
     three servers: one valid stdio entry, one remote HTTP entry at a trusted LAN
     address such as `http://192.168.1.20:8080/mcp` with no `type`, and one stdio
     entry with no `command`.
  2. Confirm the import, then open the imported stdio server and press Test
     connection.
  3. Leave the server at **Everywhere** and ask the agent in each project to
     list its available tools. Have the stdio fixture report its working
     directory and process id; open a second session in `~/work/api` as well.
  4. Set the server to **These projects**, with only `~/work/api` picked.
  5. Ask again in each project.
  6. In the already-open `~/personal/site` session — assembled while the server
     was global — ask the agent to call one of the server's tools by name.
  7. Edit the server's `env`, set a 45-second connection timeout, and save.
     Reopen it to confirm the value persisted, then clear the timeout and save.
     Ask in `~/work/api` again.
  8. Rename the server and re-scope it; ask once more.
  9. Point the server's command at a binary that does not exist, save, and open
     a new session.
  10. Restore the valid command and Test connection. Activate a tool through
      `ToolSearch`, then terminate the stub server process between calls. Call
      the same tool in the existing session without searching again.
  11. Repeat with the restarted stub omitting that tool, and with the server
      disabled or scoped away before recovery. Also try concurrent calls after
       a disconnect and a server that fails its recovery handshake.
  12. Connect the HTTP server, stop it, and refresh the MCP settings page.
      Test connection again after restarting the server.
- **Expected**:
  - The activated tool works after a transport restart without a second search;
    concurrent calls share one handshake. The fresh server list must still
    advertise the tool. Removed tools and inactive servers are refused without
    executing a call; inactive servers are not reconnected. Recovery failure
    returns `UNAVAILABLE` and does not trigger repeated handshake attempts until
    an edit or Test connection. A failed tool execution is never replayed.
  - Two servers import; the third is listed as skipped with "a stdio server
     requires command". The LAN HTTP entry lands as `http` with its url intact,
     and the editor shows the unencrypted-connection warning.
  - Test reports connected with the tool names it found, and the row's glyph
     turns from connecting to ready.
  - While global, both sessions see `mcp_<serverId>_<tool>` names.
  - The stdio fixture runs from each session's project directory. Sessions in
    `~/work/api` share one process, while `~/personal/site` uses a separate
    process. A projectless session uses the user's home directory.
  - After narrowing, only the `~/work/api` session sees them; the summary chip
     reads "1 project" and names it.
  - The stale call from step 6 fails with `TOOL_NOT_FOUND` and "not active for
     this session" — scope holds at dispatch, not only in the catalog.
  - The `env` edit drops the connection: the next assembly or call re-handshakes, and
     the tool's behaviour reflects the new value. The rename in step 8 does not
     reconnect anything.
  - The editor restores a saved timeout when reopened. Clearing it removes the
    override so the next connection uses the default handshake timeout.
  - The broken command records `failed` with a message, contributes no tools,
     and is not re-dialled on the following session assembly; pressing Test
     retries it. After a transient failure in two projects, repair the stub
     without editing its saved record and test the server. Both projects regain
     tools on their next session without an enable toggle. Testing a selected
     project uses that project's cwd and tool catalog; an active call or
     handshake in another project completes without interruption.
   - A stopped HTTP server loses its `ready` status on settings refresh and
     reports `failed`; Test connection restores `ready` after it restarts.
- **Specs linked**: `07-plugins/01-plugin-system.md` §12,
  `03-runtime/01-ipc-protocol.md` §12a, `08-meta/decisions-log.md` (D192, D193)
- **Acceptance**: E (tools & permissions), Quality
- **Milestone**: M5
- **Status**: Unit-covered (`apps/desktop/test/user-mcp.test.mjs`,
  `packages/shared/src/mcp-import.test.ts`, host-core `mcp_servers` tests); full
  UI journey Draft

## E2E-100B: Remote HTTP MCP server OAuth 2.1 authorization and token lifecycle

- **Preconditions**: An HTTP MCP server endpoint configured requiring OAuth 2.1 authentication (RFC 9728 discovery and PKCE S256).
- **Steps**:
  1. Open Settings > Agent > MCP. Add an HTTP MCP server URL.
  2. The server status displays `Authorization required`.
  3. Click `Authorize`. Main spins up loopback on `127.0.0.1`, launches external browser to the authorization endpoint with RFC 8707 `resource`.
  4. Complete login in browser, redirecting to `http://127.0.0.1:<port>/callback`.
  5. The loopback callback validates state/code, completes token exchange with PKCE verifier, saves token to encrypted secret `secret:mcp:<id>:oauth`, renders escaped success page, and emits `done` event.
  6. Settings UI updates status to `Ready` with discovered tools, shows localized success toast, and displays `OAuth` badge.
  7. When access token expires, `UserMcpRuntime` transparently uses refresh token to obtain a fresh access token without user prompt.
  8. Moving the server via `mcp.transfer` preserves and re-keys the OAuth token secret under the destination ID.
- **No-DCR case**: When authorization-server metadata omits `registration_endpoint` and there is no reusable client, Authorize does not open a browser. The error event contains `MCP_OAUTH_DCR_UNAVAILABLE` and Settings shows localized recovery guidance to request a client ID from the server operator or use a DCR-capable server.
- **Specs linked**: `03-runtime/01-ipc-protocol.md`, ADR 0283, ADR 0142
- **Acceptance**: E (tools & permissions), Security
- **Milestone**: M5
- **Discovery regression (#1221):** Local HTTP authorization flow covers root and path issuers, ordered OAuth/OIDC fallbacks, challenge-scope precedence, all protected-resource scopes, and omitted scope when absent. It checks the real callback, PKCE token exchange and storage handoff using synthetic tokens; no external account is contacted.
- **Status**: Unit-covered (`apps/desktop/test/mcp-oauth.test.mjs`, `apps/desktop/test/user-mcp.test.mjs`); local HTTP flow covered by `apps/desktop/test/mcp-oauth-discovery.test.mjs`; full UI journey Draft

## E2E-261: Clear a per-server MCP timeout override

- **Preconditions**: Isolated Electron profile and a saved MCP server with a 45-second timeout override; no live server or provider.
- **Steps**: Open the production MCP editor, enter an out-of-range value and confirm Save is disabled, then clear the timeout field and save.
- **Expected**: An invalid timeout cannot be saved. Clearing an existing override is valid and serializes as `timeoutSeconds: null`, allowing host-core to remove the override and use the default.
- **Acceptance**: `node scripts/e2e-mcp-timeout-clear.mjs` exercises the production editor and save serialization. `apps/desktop/test/mcp-editor-timeout.test.mjs` covers value conversion; host-core MCP tests cover null clearing and default behavior. No live MCP server is contacted.
- **Milestone**: M6+

## E2E-SKILL-import-multiple-folders

- **Preconditions:** An isolated Desktop profile and three sibling folders:
  `alpha/SKILL.md` and `beta/SKILL.md` are valid; `broken/` has no
  `SKILL.md`. A project is selected in Settings > Agent > Skills.
- **Steps:** Choose Import folder for that project, select all three folders,
  and confirm. Check the project list and the result message. Reopen Import
  folder and confirm it starts at the parent containing `alpha/`, `beta/`,
  and `broken/`. Cancel, reopen it, and confirm the parent is unchanged.
  Import a single Markdown file through Import file.
- **Expected:** Both valid skills appear at project level with their sibling
  resources, the invalid folder is reported without blocking the others, and
  the picker remembers their shared parent across cancellation. The single-file
  action still selects only one file.
- **Coverage:** Folder import service, preference, and settings source contract
  tests. Native multi-folder picker and remembered location remain desktop E2E.

## E2E-101: A user skill is written once and scoped per project

- **Preconditions**: Two projects on disk. An Agent session in each.
- **Steps**:
  1. Extensions → Skills → New. Save with an empty description.
  2. Fill in a description, write a body, and save.
  3. Ask the agent in each project to use the skill by name.
  4. Set the skill to **These projects** with only the first project picked,
     then switch it Off and back to **These projects**.
  5. Ask again in each project.
  6. In the first project's session, narrow the skill to the *second* project
     and immediately ask the agent to invoke it.
  7. Paste a body over 128 KB.
  8. Switch the app language to 中文 and revisit every surface above.
- **Expected**:
  - Saving without a description is refused with a message naming the field:
    the description is the only part that enters the prompt.
  - The base prompt carries the skill's id, name and trimmed description and
    not its body; the body arrives only through the `Skill` tool.
  - Toggling Off and back restores the picked project without re-picking it.
  - After narrowing, only the scoped project's session can invoke it; the other
    gets "not enabled for this project".
  - Step 6 fails in the already-open session too — the scope is re-read when the
    body is loaded, not trusted from the catalog that listed it.
  - The byte counter warns before the 128 KB cap and the save is refused past it.
  - Every label, empty state, error and count renders in Chinese, with counts
    reading naturally at 0, 1 and many.
- **Specs linked**: `07-plugins/01-plugin-system.md` §12.3,
  `03-runtime/01-ipc-protocol.md` §12b, `08-meta/decisions-log.md` (D174, D192,
  D194)
- **Acceptance**: E (tools & permissions), Quality
- **Milestone**: M5
- **Status**: Unit-covered (host-core `user_skills` tests,
  `apps/desktop/test/extensions-page.test.mjs`); full UI journey Draft

## E2E-102k: `@agent` mention delegates to a named subagent

- **Preconditions**: An Agent session in a project with the builtin
  `explorer` subagent enabled and no workspace-root entry named `explorer`.
- **Steps**: Type `look @expl`, accept the `@explorer` row from the **Agents**
  group, finish the sentence and send. Repeat in Plan mode. Add a root file
  named `explorer` and type `@` again.
- **Expected**: The chip is atomic; the user row shows the typed text with
  `@explorer` chipped; the model is instructed to call `Task` with
  `explorer` and a Task card appears. Plan mode lists no Agents group and sends
  the text literally. A same-named root file hides the agent row. Stop before
  any reply restores the typed text, not the model instruction.
- **Spec**: `04-ux/08-component-spec.md` §11.8, ADR 0346
- **Acceptance**: C (conversation & stream)
- **Milestone**: M5
- **Status**: The renderer journey (group, shadowing, Plan omission, chip,
  serialization) runs in `apps/desktop/test/composer-agent-mention-user-path.test.mjs`
  in a real Electron renderer; send-time rewriting, mode gating, file
  precedence and Skill composition in `composer-agent-mention.test.mjs`;
  transcript chips in `session-message-presentation.test.mjs`; persistence in
  `host-core` `agent_mentions_round_trip_through_record_meta`; Stop restoration
  in `composer-smart-stop.test.mjs`. The live Task card against a real
  provider is Draft (requires a configured model).

## E2E-CAPABILITY-move-across-levels: MCP servers and skills move between the global and project `.agents` levels

- **Preconditions**: The app runs against a disposable global `.agents` root
  (an isolated HOME, or `PI_DESKTOP_AGENTS_DIR` when the bare host is driven
  directly). Projects A and B are registered. The global root owns
  `~/.agents/servers/echo.json` (id `echo`, label `Echo`),
  `~/.agents/skills/review.md` (frontmatter name `Review`), and nothing else
  that uses the names used below. Project A owns no `echo` server and no
  `review` skill, and owns `<project A>/.agents/skills/with-resources/` holding
  `SKILL.md` plus `scripts/run.sh` and `templates/report.md`. The MCP and
  Skills pages show the project picker described in the Settings IA spec.
- **Steps**:
  1. Open Settings > Agent > MCP with project A selected. Disable the global
     `echo` row, then choose Move into A. Confirm the row leaves the global
     group, appears under project A, and stays disabled there.
  2. Confirm `~/.agents/servers/echo.json` no longer exists and
     `<project A>/.agents/servers/echo.json` does, byte-identical. Read
     `<data>/agent-capabilities/mcp.json` and confirm it holds no global `echo`
     entry and no project-A override for the old id, and that project A's entry
     carries the disabled value.
  3. Create a new global `echo` server again (id `echo`, label `Echo`). With
     project A selected choose Move into A and confirm the arriving row is
     `echo-2` with label `Echo (2)`, that project A's original `echo.json` is
     byte-identical to before the move, and that both project rows list.
  4. Open Skills with project A selected. Create a project `review.md` whose
     frontmatter carries `name: Review`, a description, and an extra custom
     field, plus a body; disable it, then choose Move to Global. Confirm it
     appears globally as `review-2`, arrives disabled, and leaves the global
     `review.md` unchanged.
  5. Diff the moved document against the project original: only the frontmatter
     `name` line differs (`name: Review (2)`); the description, the custom
     field, blank lines, line endings, and every body byte are identical.
  6. Move project A's `with-resources` skill to Global. Confirm
     `<project A>/.agents/skills/with-resources/` is gone and
     `~/.agents/skills/with-resources/` holds `SKILL.md`, `scripts/run.sh`, and
     `templates/report.md` with identical bytes, and that the Skill tool still
     resolves the document's resources.
  7. Reload the global and project pages. Confirm the moved rows keep the
     enablement they had across the reload, that project B lists none of the
     project-A capabilities, and that the moved global `review-2` applies to
     project B with the value it had after the move.
  8. Clear the project selection in the toolbar. Confirm Move into <project> is
     no longer offered on the remaining global rows and the project group asks
     for a project selection instead; re-select project B and confirm the
     action returns.
  9. Drive `mcp.transfer` and `skills.transfer` with `from` and `to` naming the
     same directory and confirm the response returns the current record and
     neither directory changes.
- **Expected**:
  - A move relocates the document: the destination directory gains the file,
    the source level stops listing the entry, and no copy is left behind.
  - Enablement follows the document. A global row disabled for project A
    arrives in project A disabled; a project row arrives globally with its
    visible value as the new global default. The source level keeps no state
    entry — including project overrides — for the old id.
  - A destination collision is resolved by renaming only the colliding name:
    an id collision gives the arriving id a `-2`/`-3` suffix, a case-insensitive
    display-name / label collision gives the display name a ` (2)`/` (3)`
    suffix, and the existing entry is never overwritten or merged. Renaming a
    skill rewrites only the frontmatter `name` line and preserves every other
    byte.
  - A directory-shaped skill moves as one unit with its sibling resources, and
    a transfer whose two targets name the same directory is a no-op.
  - Without a selected project the move action is unavailable with an explicit
    explanation, and no capability file or state entry changes.
- **Specs linked**: `03-runtime/06-host-rpc-protocol.md` §4 (Agent
  capabilities), `03-runtime/01-ipc-protocol.md` §12a–§12b,
  `04-ux/06-settings-ia.md` §2 (Agent capability destinations), ADR 0112,
  ADR 0269
- **Acceptance**: E (tools & permissions), F (persistence), Quality
- **Milestone**: M6+
- **Status**: Host-covered (`pnpm test:e2e:capability-move` drives the same RPC
  surface Electron main calls against a real host-core and an isolated global
  root, asserting the documents and the state file on disk; host-core
  registry/state tests cover the rename, the id the scan derives, and directory
  resources; the source contract is pinned by
  `apps/desktop/test/agent-capability-settings.test.mjs`). The rendered Settings
  journey — row menu, toggle, toast — remains Draft.

## E2E-120: Global plugin launch, next-turn editing, and stopped throughput

- **Preconditions**: Install and enable a panel plugin whose Chinese display
  name is `无限画布`, plus a second panel plugin (for example `邮件助手`).
  Configure a provider that streams slowly enough to stop a partial answer. Run
  once on macOS and once on Windows.
- **Steps**:
  1. Immediately after PI-Desktop finishes booting, leave it unfocused and press
     Option+Space on macOS or Alt+Space on Windows while another application
     owns the foreground window. Confirm the first invocation promptly reveals
     a fully rendered, centered launcher on the pointer's display without a
     blank initialization frame, native close, minimize, maximize, resize, or
     taskbar controls. Confirm Windows does not show the active application's
     system menu.
  2. Search separately for `无限`, `wuxianhuabu`, and `wxhb`. Use Up/Down and
     Enter for one run and click for another; confirm the existing plugin panel
     opens. Confirm Chinese IME candidate Enter does not open a result.
  3. Open the launcher again with an empty query and confirm the plugin opened
     in step 2 is the first result. Open the other panel plugin, then reopen
     the launcher and confirm the two plugins appear in reverse opening order.
     Restart the application and confirm the same most-recently-used order
     survives the restart.
  4. Start an Agent answer. While it streams, type the next draft and change
     Thinking, permission mode, and Agent/Plan/Goal. Confirm every selection is
     editable, Stop remains present, and Send cannot dispatch.
  5. Stop after partial output. Confirm the partial answer remains, the queued
     configuration becomes durable only after termination, and the next turn
     uses the final selection rather than any intermediate selection.
  6. Inspect the stopped answer's conversation statistics, reload the session,
     and inspect again.
- **Expected**:
  - Early warm-up starts before backend boot completes and removes BrowserWindow
    and renderer loading from the first shortcut's visible path. On macOS the
    panel is activated once without a second app/window-stack hop, so the reveal
    does not visibly stutter. Launcher search returns only enabled, ready panel
    plugins and every invocation starts with an empty, focused query ordered by
    most-recently-used history across restarts; typing a query still ranks
    relevance first. Escape and focus loss hide it without closing the main
    application.
  - No running turn observes the staged mode/model/thinking/permission change,
    and a second prompt cannot be sent concurrently.
  - Changing Thinking during a stream keeps the selected model's enabled levels
    visible. The submenu never collapses to Off-only, including for unpinned
    sessions that inherit the app default model.
  - Stopped throughput is present before and after reload. It uses exact output
    usage when the provider supplied it; otherwise the UI labels the persisted
    four-code-point estimate as approximate.
  - Completed-response throughput uses pi-ai 1.1.0's monotonic request duration;
    stopped partial responses retain the sidecar duration fallback.
- **Specs linked**: `03-runtime/01-ipc-protocol.md`,
  `03-runtime/02-agent-runtime.md` §5b/§9,
  `04-ux/07-ui-design-system.md` §8.2–8.3,
  `04-ux/08-component-spec.md` §11,
  `04-ux/09-interaction-patterns.md` §1/§3, D211, D212, D219, ADR 0072,
  ADR 0073
- **Acceptance**: C (conversation & stream), F (persistence), G (plugins),
  Quality
- **Milestone**: M6
- **Status**: Unit/source-contract covered; full cross-platform UI journey Draft
  (run only in a capable environment when this surface changes)

## E2E-122: Plugins request and deliver native notifications

- **Preconditions**: An installed plugin declares and is granted `notify`; the
  desktop platform supports Electron native notifications; the OS notification
  permission is in its initial or previously denied state.
- **Steps**: 1) From the plugin process, call
  `getNotificationPermission()`. 2) Call `requestNotificationPermission()` and
  observe the native permission/probe result. 3) Call
  `showNativeNotification({ title, body })`. 4) Repeat with a plugin that lacks
  `notify`, and on a platform where native notifications are unsupported.
- **Expected**: The first status is `unknown`, `denied`, or `unsupported`; the request
  returns a best-effort `granted`, `denied`, or `unsupported` result; a granted
  plugin receives `{ shown: true, permission: "granted" }` for native delivery,
  while denied/unsupported delivery returns `shown: false` without crashing the
  plugin. Missing `notify` fails with `PERMISSION_DENIED`. Clicking a delivered
  native plugin notification restores and focuses the main window, but native
  plugin notifications do not add durable task inbox rows or activate a chat
  session.
- **Specs linked**: `07-plugins/01-plugin-system.md`,
  `07-plugins/03-plugin-api.md`, `07-plugins/13-plugin-permissions-matrix.md`,
  ADR 0074
- **Acceptance**: E (tools & permissions), G (plugins), Security, Quality
- **Milestone**: M6+
- **Status**: Unit/source-contract covered; full cross-platform OS permission
  journey Draft (run only in a capable environment when this surface changes)

## E2E-148: Plugin settings and local shortcuts are editable

- **Preconditions**: An enabled plugin declares string, boolean, JSON, and
  `shortcut` settings; the shortcut points to a declared plugin command.
- **Steps**: 1) Open Plugins and open the plugin settings surface. 2) Change a
  normal field and the shortcut, then save. 3) Reload the plugin list and press
  the new shortcut while the app window is focused. 4) Try a reserved app
  shortcut and repeat with the plugin scoped away from the current project.
  5) For JSON fields, save, reopen and save again with `"hello"`, `"42"`,
  `"true"`, `"null"`, `""`, a null default, a number, a boolean, an array and an
  object. Edit a JSON string, reset to a string default, and submit malformed
  JSON before correcting it.
- **Expected**: Controls are generated from the manifest, values persist in the
  plugin-private settings file, and `plugin:settingsChanged` is delivered. The
  new shortcut invokes the plugin command only in the focused app window and
  matching activation scope. Reserved/conflicting bindings are rejected; no OS
  global shortcut is registered. JSON strings remain quoted in the editor and
  retain their type after save/reopen/reset. Invalid JSON leaves the draft and
  sheet open without an IPC settings write.
- **Specs linked**: `07-plugins/02-plugin-manifest-schema.md`,
  `07-plugins/03-plugin-api.md`, `07-plugins/11-plugin-storage-isolation.md`,
  ADR 0159
- **Acceptance**: F (persistence), G (plugins), Security, Quality
- **Milestone**: M6+
- **Status**: Source-contract and focused integration coverage. JSON
  save/reopen/edit/reset is covered by `plugin-settings-json-user-path.test.mjs`
  in an isolated Electron renderer with a settings IPC fixture; full desktop
  journey Draft (run only in a capable environment when this surface changes)

## E2E-152: A plugin contributes a work panel view

- **Preconditions**: A development plugin declaring `ui.view` and one
  `contributes.views` entry whose `entry` is a small HTML page calling
  `window.pluginBridge.invoke("ui.showToast", …)`. Two projects open, with the
  plugin's activation scope limited to the first.
- **Steps**:
  1. Load the plugin as a development plugin. Confirm the Plugins page shows a
     work-panel-views capability badge.
  2. Press `Cmd/Ctrl + J` to reveal the work panel, then click `+` to create a
     New launcher tab. Confirm the fixed `+` trigger, the maximize control, and
     the viewport-fixed work-panel toggle resolve to one button group — one
     4px control gap, no divider between maximize and the toggle — while the
     `+` trigger and the toggle stay separate, non-overlapping hit regions with
     more than 24px of visual gap. Confirm the launcher lists the built-in
     Review row and the plugin view's localized title and icon (or a lettered
     tile if the manifest names an unknown token).
  3. Activate the plugin row. Confirm the plugin's page renders inside the panel body
     with no window-control capsule and no reserved 46px band, and that its
     button reaches the host toast.
  4. Drag the inner panel divider and resize the conversation area. Confirm
     the page tracks the panel rect without lag or tearing, then drag the outer
     right window edge and confirm the panel width changes while the base chat
     width stays fixed.
  5. Open global search, then Settings. Confirm the page is hidden while each
     overlay is up and returns when it closes.
  6. Click `+` again, then choose the same view from the new launcher. Confirm
     it returns to the live page — same scroll position, no reload — rather than
     stacking a second tab.
  7. Switch to the second project. Confirm the view disappears from the New
     launcher and from the no-tab entry list.
  8. Switch back, reopen the view, then disable the plugin. Confirm the tab
     closes and the view's renderer process exits (Activity Monitor / Task
     Manager).
  9. Re-enable, reopen, then edit the plugin's HTML on disk to trigger a
     development reload. Confirm the view reloads rather than going blank.
- **Expected**: A plugin view is reachable, isolated, correctly positioned, and
  bounded by the plugin's lifecycle and activation scope. The panel remains an
  in-flow internal column; its renderer-owned divider resizes the panel and
  native window edges never change that target. It never renders while a
  blocking overlay is open, and it never obtains window controls.
- **Specs linked**: `07-plugins/02-plugin-manifest-schema.md` §4/§5,
  `07-plugins/13-plugin-permissions-matrix.md` §2,
  `04-ux/08-component-spec.md` §5, ADR 0104, ADR 0092
- **Acceptance**: G (plugins), Security, Quality
- **Milestone**: M6+
- **Status**: Unit coverage in
  `apps/desktop/test/plugin-work-panel-views.test.mjs` (addressing, launcher
  grouping, isolation parity, scope filtering, lifecycle teardown),
  `packages/plugin-sdk` and host-core manifest validation; the desktop journey
  is Draft (run only in a capable environment when this surface changes)

## E2E-PLUGIN-file-view-collapse-persists

- **Preconditions**: The bundled File Manager view is open on a project with
  nested folders and a text file, and the work panel is wide enough for the
  two-pane layout.
- **Steps**:
  1. Drag the divider between the file list and the content pane to a
     non-default width, then activate the toolbar's left-most toggle from the
     keyboard alone (Tab to it, then Enter or Space).
  2. Click a file reference in the conversation.
  3. Activate the same toggle again.
  4. Collapse the file list, then close and reopen the view, and finally
     restart the app.
  5. Expand the file list by hand and click another chat file reference.
- **Expected**: The toggle hides the view's own left file list and gives the
  content pane the full width, and it stays keyboard-reachable with an
  accessible name that swaps between `Hide file list` and `Show file list`.
  The open request that follows a chat click shows the requested file with its
  ancestor folders expanded and the file list collapsed, whether the view was
  already open or was opened by that click. Expanding again restores the
  previously dragged split width together with the expanded folders and the
  selected file, not the default split or the project root. The collapsed state
  is persisted: it survives closing and reopening the view and a full app
  restart, and a manual expansion holds until the next host open request
  collapses it again.
- **Specs linked**: `07-plugins/02-plugin-manifest-schema.md` §4/§5,
  `04-ux/08-component-spec.md` §5.2.2, ADR 0104, ADR 0241, ADR 0262
- **Acceptance**: G (plugins), Quality
- **Milestone**: M6+
- **Status**: The bundle's manifest, entry page, and upstream checksum are
  unit-covered (`apps/desktop/test/bundled-plugins.test.mjs`); the plugin-side
  journey is Draft (run only in a capable environment when this surface changes)

## E2E-PLUGIN-file-view-switches-folder-per-project

- **Preconditions**: A project group whose two folders each hold a text file the
  other folder does not, and a second, single-folder project. The work panel is
  open on the bundled File Manager view, browsing the first project's primary
  folder.
- **Steps**:
  1. Switch the view's top-left folder control to the project's second folder.
     Confirm the tree, the filename search, and open/save all follow it.
  2. Save an edit in the text file only that second folder holds.
  3. Close and reopen the view, then restart the app. Confirm the second folder
     is still the one being browsed.
  4. Switch to the other project and back. Confirm each project remembers its
     own folder.
  5. Click a chat reference that resolves in the project's second folder, then
     one that resolves in its primary folder.
  6. With the second folder selected, search the tree for the primary folder's
     own file name, and try to open a `.env` and a symlink or junction inside
     the second folder that points outside it. 7) With the second folder
     selected, right-click the text file only that folder holds and use **Open
     with default app**, then **Show in folder**; switch to the primary folder
     and do the same for a file only *it* holds. 8) Back in the second folder,
     use the same two actions on a file whose name both folders contain.
- **Expected**:
  - The control lists the project's folders in group order, primary first, and
    names the one being browsed; the tree, search, and editing all work inside
    that one folder, and a single-folder project offers just its one folder.
  - Switching folders changes only what this view browses: the app's visible
    workspace, the agent's tool roots, the session's primary path, project
    instructions, and project memory are all unchanged (ADR 0263).
  - The choice is remembered per project: it survives closing and reopening the
    view and a full app restart, and the other project keeps its own folder.
  - Both chat references open in this view on the file they name — the one from
    the second folder included, in that folder — with no host `file:` tab.
  - The selected folder is the jail, not the group: the filename search does not
    reach a file that only another project folder holds, and the credential path
    and the symlink/junction escape are still refused (ADR 0241).
  - The two system actions reach the file that was clicked, in the folder being
    browsed: a file only the second folder holds opens or reveals its real self
    instead of reporting "not found", and the file whose name both folders share
    opens the second folder's copy, not the primary folder's (ADR 0264).
- **Specs linked**: `07-plugins/03-plugin-api.md` §3,
  `04-ux/08-component-spec.md` §5.2.2, ADR 0241, ADR 0249, ADR 0263, ADR 0264
- **Acceptance**: G (plugins), Security, Quality
- **Milestone**: M6+
- **Status**: The host-side resolution and addressing are unit-covered
  (`apps/desktop/test/chat-ref-resolve.test.mjs`,
  `apps/desktop/test/transcript-file-chips.test.mjs`); the plugin-side journey
  is Draft (run only in a capable environment when this surface changes)

## E2E-PLUGIN-bundled-plugin-keeps-a-marketplace-update

- **Preconditions**: A build that ships a bundled plugin whose marketplace entry
  offers a newer version, and a data directory the user can install into.
- **Steps**:
  1. Open the Plugins page. Confirm the plugin is listed as bundled and enabled,
     and that it offers no Uninstall action.
  2. Update it from the marketplace. Confirm the row moves to the catalog
     version and still offers no Uninstall action.
  3. Restart the app. Confirm the updated version is still the installed one,
     the plugin is still enabled, and the registry holds exactly one row for it.
  4. Disable the plugin, restart again, and confirm it stays disabled at the
     updated version.
- **Expected**: Bundled means default and non-removable, not frozen. A user's
  update outlives the launch that reconciles the shipped copy, an app that ships
  a strictly newer version still wins, and a catalog version that is not newer
  is never offered as an update.
- **Specs linked**: `07-plugins/07-plugin-marketplace.md`, ADR 0104, ADR 0241
- **Acceptance**: G (plugins), Quality
- **Milestone**: M6+
- **Status**: Unit coverage in host-core
  `a_bundled_plugin_keeps_the_update_the_user_installed`,
  `a_newer_shipped_version_replaces_an_older_user_install`,
  `a_plugin_a_build_stops_shipping_is_no_longer_bundled`, and
  `market_entry_offers_an_update_only_when_the_catalog_is_newer`; the packaged
  journey is Draft

## E2E-NAV-plugins-button-goes-back: Plugins footer reuses navigation history

- **Preconditions**: An isolated profile has a named conversation and visible
  messages. No model credentials or external marketplace access are required.
- **Steps**: 1) Select the conversation, type an unsent draft, enter Plugins
  from the footer, and click the same button again. 2) Reopen Plugins, type a
  search in Installed, return and reopen. 3) In the navigation fixture, repeat
  from `scheduled` and Settings; test a history containing both
  Scheduled and Settings before Plugins. 4) Exercise Forward then the Plugins
  button again. 5) Open Plugins with no previous history entry and click it.
- **Expected**: The second click performs the existing Back action exactly once;
  it does not append a return entry or skip Settings. A chat history entry uses
  existing session selection/loading behavior. The conversation and unsent draft
  remain usable on return. If Back is unavailable, the button opens chat.
  Its pressed state reflects whether Plugins is active. Plugin browsing tab,
  search fields, and category survive route unmounts; dialogs and listeners
  are released rather than kept hidden. Settings navigation is unchanged.
- **Specs linked**: `04-ux/01-ui-ia.md` §2/§5, `04-ux/08-component-spec.md` §3
- **Acceptance**: C (session navigation), G (plugin browsing), Quality
- **Milestone**: M6+
- **Status**: Actual footer-handler/history-slice and browse-state regression
  tests passed. Real macOS UI validation of the rebuilt history-based revision
  passed two open/back cycles: the same two conversation messages and unsent
  draft remain, the button clears its active state on return, and reopening
  retains the Installed search filter. Non-chat history entries, Forward, and
  no-history fallback are covered by tests, not native UI. The layout journey
  also activates the footer button a second time and asserts the previous
  destination; it passed 37/37 checks from integrated main `d6ffaa3b`. No
  external marketplace or live model was required.

## E2E-PLUGIN-global-shortcut-owns-only-its-own-command

- **Preconditions**: Two local fixture plugins are installed in an isolated
  profile. Plugin A declares `keyboard.globalShortcut`, `contributes.commands`
  with one command, and `contributes.globalShortcuts` mapping `Alt+Shift+V` to
  it. Plugin B declares the same permission and asks for `Alt+Shift+V` while A
  holds it. A second application is available for a cross-application keypress.
- **Steps**: 1) Install and load A and confirm the accelerator is held through
  `listGlobalShortcuts`. 2) Focus another application, press `Alt+Shift+V`, and
  confirm A's command runs; drive the registered handler through the host's
  test seam when no cross-application input is available. 3) Attempt a shortcut
  whose `command` belongs to another plugin. 4) Attempt B's registration of
  `Alt+Shift+V` and inspect the answer. 5) Disable and uninstall A and confirm
  the accelerator becomes free and B can take it; repeat after terminating A's
  runtime (crash) and while A's panel is closed. 6) Attempt the app's own
  launcher accelerator `Alt+Space`, the `Alt+Shift+W` window toggle, a
  reserved binding such as `Mod+C`, an invalid accelerator, and a ninth
  shortcut for one plugin.
- **Expected**: Only A's own command runs for the accelerator; a shortcut whose
  `command` is not registered by the plugin is refused with `INVALID_ARGUMENT`.
  B receives a refusal (`registered: false`, code `SHORTCUT_CONFLICT`) and keeps
  no accelerator while A holds it. The host's own `Alt+Space` launcher and
  `Alt+Shift+W` window-toggle shortcuts and OS-reserved bindings are refused with
  `SHORTCUT_CONFLICT` or `SHORTCUT_UNAVAILABLE`; an invalid accelerator is
  refused with `INVALID_ACCELERATOR` and the ninth per-plugin shortcut with
  `LIMIT_EXCEEDED`. Disabling, unloading, or crashing a plugin releases every
  accelerator it held, after which another plugin can take it, and app quit
  releases all shortcuts. Audit records each register/unregister attempt with
  the plugin id and result, and never records key contents.
- **Specs linked**: `07-plugins/03-plugin-api.md`,
  `07-plugins/04-plugin-security.md`,
  `07-plugins/13-plugin-permissions-matrix.md`, ADR 0257
- **Acceptance**: G (plugins), Security, Quality
- **Milestone**: M6+
- **Status**: Registry, host wiring, and manifest validation are unit-covered
  (`apps/desktop/test/plugin-shortcuts.test.mjs`,
  `packages/plugin-sdk/src/index.test.ts`,
  `crates/host-core/src/plugins/tests.rs`); the cross-application keypress
  journey is Draft and needs a capable desktop environment.

## E2E-PLUGIN-permission-gate-for-real-time-capabilities

- **Preconditions**: A fixture plugin whose manifest can be changed between
  runs, and a data directory in which the user can re-grant permissions.
- **Steps**: 1) Install a build that requires `keyboard.globalShortcut` and
  inspect the install dialog. 2) Load a plugin that calls
  `pi.keyboard.listGlobalShortcuts()` without declaring the permission.
  3) Declare but do not grant the permission, then call the same API. 4) Grant
  the permission and call the same API again. 5) Revoke the permission with the
  plugin loaded and press the accelerator. 6) Repeat steps 2–5 for
  `audio.capture.background`, `audio.playback.background`, and `net.websocket`.
- **Expected**: Undeclared and declared-but-ungranted calls are refused with
  `PERMISSION_DENIED` and an audit entry, so an ungranted capability fails
  closed instead of degrading. After a grant the same call is allowed — for
  `net.websocket` that is a connect that proceeds past the gate — while the
  callable audio methods answer a coded `UNSUPPORTED` because the host has no
  device backend yet, audited as
  `{ api: "audio.<method>", ok: false, errorCode: "UNSUPPORTED" }`, never a
  silent success. Revoking the permission with the
  plugin loaded stops the accelerator immediately and the host releases it. The
  four permissions appear with their risk tiers (high for
  `audio.capture.background` and `net.websocket`, medium for
  `audio.playback.background` and `keyboard.globalShortcut`) and localized copy
  in the install dialog and in the plugin detail sheet, ordered by descending
  risk.
- **Specs linked**: `07-plugins/04-plugin-security.md`,
  `07-plugins/13-plugin-permissions-matrix.md`, ADR 0257
- **Acceptance**: G (plugins), Security
- **Milestone**: M6+
- **Status**: The gates and validator behaviour are unit-covered
  (`packages/plugin-sdk/src/index.test.ts`,
  `packages/plugin-devkit/src/check.test.ts`,
  `crates/host-core/src/plugins/tests.rs`); the dialog journey is Draft.

## E2E-PLUGIN-background-audio-and-realtime-connection

- **Preconditions**: A voice-assistant fixture plugin holding
  `background.service`, `audio.capture.background`,
  `audio.playback.background`, `keyboard.globalShortcut`, `net.websocket`, and
  `desktop.control`, with a mock audio backend and a local mock WebSocket
  server so CI never needs a real microphone.
- **Steps**: 1) Load the plugin with no panel open and confirm that its
  background service starts. 2) Register the push-to-talk accelerator. 3) Open
  the input device and receive PCM frames. 4) Connect the mock server and send
  PCM. 5) Receive the response audio and play it. 6) Interrupt playback with
  `stopOutput`. 7) Call `pi.desktop.invoke({ operation: "session/create" })`
  and then `agent/prompt`. 8) Unload the plugin.
- **Expected**: Frames flow with bounded buffering and no unbounded queue
  growth, and `stopOutput` clears queued audio immediately. Egress to a host
  outside `manifest.net.domains` is refused. On unload the microphone, the
  audio output, the socket, and the accelerator are all released with no orphan
  process, listener, or timer. `session/delete`-class dangerous desktop
  operations still require the host's native confirmation even when the plugin
  passes `confirm: true`.
- **Specs linked**: `07-plugins/03-plugin-api.md`,
  `07-plugins/04-plugin-security.md`,
  `07-plugins/12-plugin-ipc-and-host-services.md`, ADR 0257
- **Acceptance**: G (plugins), Security, Quality
- **Milestone**: M6+
- **Status**: Partially implemented — the socket half is implemented and
  unit-covered by `apps/desktop/test/plugin-websocket.test.mjs` (allowlist,
  bounds, lifecycle); the background-audio half answers a coded `UNSUPPORTED`
  because the host has no device backend yet, so this scenario stays Draft until
  audio lands.

<a id="e2e-config-sync-webdav-portable-configuration"></a>

## E2E-199: Subagent editor offers preset templates and a provider-bounded model picker

- **Preconditions**: A project-bound Agent session. At least one configured,
  runnable provider with model bindings exists in Settings. The
  `~/.agents/subagents` directory is empty. Builtins are present but no project
  subagent file overrides them.
- **Steps**:
  1. Open Settings → Agent → Subagents, click **New subagent**, and confirm
     the sheet opens with a "Start from template" row of compact name
     chips (Explorer, Code reviewer, Test runner, Fixer, plus a blank
     chip). Chips show names only; the selected chip's one-line caption
     appears once under the row. Confirm there is no long subtitle, no
     per-chip Apply label, and that Advanced starts collapsed. Confirm
     hyphenated ids (`code-reviewer`, `test-runner`) render catalog names,
     not raw keys such as `presetCode-reviewerName`. At normal desktop width,
     confirm the name/description/select controls read as compact filled wells,
     the prompt editor is the only tall field, and the Save/Cancel actions stay
     visually subordinate to the form. Focus a field and confirm its accent
     ring remains visible without a permanent divider.
  2. Click the **Explorer** chip without touching any field. Confirm the
     form is pre-filled: name `Explorer`, the description from the
     builtin, the `Read / Glob / Grep / Bash` tool grant, and the full
     Explorer system prompt. Expand Advanced and confirm the model field is
     unchanged (still inherit).
  3. Reopen the sheet, click **Fixer**, and confirm the grant expands to
     `Read / Glob / Grep / Edit / Write / Bash` and the Fixer body. The
     mutating-hint line appears under the tools row. Expand Advanced and
     confirm the output limit starts empty.
  4. Expand Advanced. Open the model picker. Confirm the picker lists every
     model of every configured, runnable provider, grouped by provider
     name. Choose one and confirm the draft's `model` field becomes
     `<vendorKey-or-name>/<modelId>` (matches what the runtime resolver
     accepts in `BUILTIN_SUBAGENT_DOCUMENTS`).
  4a. Configure a custom endpoint whose display name contains a space (for
     example **My Gateway**). Confirm the picker offers it, select it, and
     confirm the sheet saves with the pin `<display name>/<modelId>` and the
     save button enabled. The picker and the draft check must never disagree
     about what is saveable.
  4b. Configure two providers with the same display name and vendor key, so
     their pins use distinct stored provider ids. Add one as a fallback model,
     save and reopen the sheet. Confirm the ordered row and its move/remove
     accessible names use the provider display name and model ID, not the id,
     while the saved pin still identifies the chosen provider. Add the second
     provider with the same model ID and confirm both rows and their accessible
     names include their provider IDs to distinguish them. Disable one provider
     and confirm its row and move/remove accessible names retain the configured
     provider name and model ID, with a localized disabled status; the row must
     not revert to a raw UUID label. Confirm the disabled provider is absent
     from the add menu, while its saved row remains movable and removable.
     Save and reopen, then re-enable the provider: its name remains visible,
     the disabled status clears, and its stored pin is unchanged. A genuinely
     missing or ambiguous provider binding keeps its raw pin with an unavailable
     status rather than borrowing another provider's name. Reorder or remove
     that row, save and reopen, and confirm all remaining pins and their order
     are preserved exactly.
  5. Confirm the picker offers no **Custom (provider/model)…** entry and the
     field renders no free-text input, so a model id can only come from the
     configured catalog. Switch the picker to **Inherit session model**, save,
     and confirm the draft's `model` field is empty and the sidecar falls back
     to the session model.
  5a. In the open model menu, confirm the list scrolls inside the menu and
     never runs past the window edge, and that typing in the filter field
     narrows the rows (including by provider name). Confirm the menu is not an
     OS-drawn select popup: it stays inside the sheet's own layer.
  6. Disable every provider that contributes a model. Reopen
     the editor, expand Advanced, and confirm the model field renders an
     empty state with an action button instead of a free-text input, and that
     the action opens Models.
  7. Switch the locale to Simplified Chinese. Confirm the preset chips
     render the translated names (`探索者`, `代码审查员`, `测试执行者`,
     `修复者`, `空白开始`) and the picker labels (`沿用当前会话的模型`,
     `前往模型设置`) resolve; no raw i18n keys appear in
     either locale.
- **Expected**: The editor offers only models the user already configured, so
  the picker is the only way to set a model and every saved pin is resolvable.
  No free-text model id is accepted. When no provider offers a runnable model
  the field explains that and links to Models instead of asking the user to
  type an id the runtime could not resolve. Picking a
  preset overwrites the draft wholesale (description, tools, body) but
  never silently clears the user's other choices (model,
  thinking level, scope).
- **Specs linked**: `04-ux/06-settings-ia.md` §7,
  `03-runtime/13-model-catalog-and-selection.md` §11,
  `03-runtime/11-provider-model-system.md` §6.4,
  ADR 0062, ADR 0089
- **Acceptance**: B (model config), C (conversation & stream), Quality
- **Milestone**: M6+
- **Status**: Unit/source-contract covered
  (`packages/shared/src/subagent-presets.test.ts`,
  `apps/desktop/test/subagent-editor-presets.test.mjs`); full UI journey
  Draft (run only in a capable environment when this surface changes)

## E2E-SUBAGENT-settings-lists-builtin-defaults

- **Preconditions**: A running app. `~/.agents/subagents` is empty. The five
  shipped builtins are present, none is switched off, and no user document
  shadows them.
- **Steps**:
  1. Open Settings → Agent → Subagents. Confirm a Built-in group lists
     `explorer`, `code-reviewer`, `test-runner`, `fixer`, and `ui-designer`
     with localized names, `Task(<handle>)` copy, tool grants, a Built-in
     badge, **Copy as mine**, and an enablement switch in the on position.
     Confirm none of those rows has Reveal or Delete.
  2. Confirm the Global group still shows localized `settings.subagentsEmpty`
     copy and the New subagent action.
  3. Switch `fixer` off from its Built-in row. Confirm the row dims with its
     switch off, the toast names it, nothing appears in `~/.agents/subagents`,
     and the row stays listed, because that switch is the way back on.
  4. Send a prompt with `fixer` switched off. Confirm the Task catalog does not
     offer it while the other four remain, then switch it back on and confirm
     the next prompt offers it again.
  5. Choose **Copy as mine** on explorer. Confirm the create sheet opens
     pre-filled from that definition (name, description, tools, body) with
     the Explorer template chip selected, not Blank. Save. Confirm
     explorer now appears only as a user-owned Global row and is omitted from
     Built-in, and the next prompt's Task catalog uses the user document.
  6. Disable the user explorer and reload the page. Confirm the user row is
     off and explorer reappears under Built-in (disabled user documents do
     not reach the loader, so the shipped definition wins again).
- **Expected**: Settings shows the defaults the agent can actually delegate to,
  and every one of them can be turned off from its own row. Builtin activation
  is app-local state rather than a document, so a switched-off default keeps its
  row; copying a builtin stays the way to retune one, and reveal and delete
  remain file-backed actions on user-owned rows only.
- **Specs linked**: `04-ux/06-settings-ia.md` §2, `03-runtime/01-ipc-protocol.md`
  §12c, `03-runtime/02-agent-runtime.md` §5f, ADR 0062, ADR 0063, ADR 0270
- **Acceptance**: E (tools & permissions), Quality
- **Milestone**: M6+
- **Status**: Source/unit covered (`apps/desktop/test/agent-capability-settings.test.mjs`,
  `apps/desktop/test/subagent-wiring.test.mjs`,
  `packages/agent-runtime/src/subagent-definitions.test.ts`,
  `packages/shared/src/subagent-presets.test.ts`); full UI journey Draft
  (run only in a capable environment when this surface changes)

## E2E-198: A subagent task opens with a live conversation process

- **Preconditions**: A project-bound Agent session with a mocked provider stream
  where one `explorer` delegate has a Task description and emits thinking,
  tool, and answer rows over time. The work panel is initially closed.
- **Steps**: 1) Expand the activity group if needed and click the `explorer`
  topology node. 2) Click the selected `explorer` node again and confirm the
  right-side dock closes, then click it once more to reopen it. 3) Observe the
  right-side dock while the delegate streams. 4) Scroll the task/process
  conversation upward and then return to the latest output. 5) Switch sessions
  and return to the original session. 6) Let a delegate start and then fail,
  open its node, and read the foot of the dock; repeat with a delegate that
  completes and one that is still running.
- **Expected**: The right dock shows a sticky identity header (avatar, name,
  and model caption on the left; status capsule and elapsed time trailing on
  the same row without wrapping), the Task call's description
  as a full-width inset grouped card under a Task section label, capped at four
  lines with an inline Show more / Show less control for longer tasks, and
  the delegate's live thinking/tool/answer process under an Activity section
  on one subtle vertical timeline using the same row components as the main
  conversation.
  The selected topology node is a full-row toggle without an extra disclosure
  chevron: its first click opens the dock and its second click closes it.
  New rows appear without a reload and follow the bottom while pinned. The
  panel has one body scrollbar; the process does not create a nested scrollbar
  or a second elevated card. At the minimum supported panel width, long
  commands, paths, and tool summaries remain contained within the dock without
  horizontal page overflow. A real upward gesture pauses follow and exposes
  jump-to-latest. The transcript remains the same height and keeps its own
  scroll state. Session switching hides the selection and returning never
  shows another session's task.
  In step 6, a delegate that starts and then fails closes the dock with an
  error card rather than a bare `Failed` capsule: the localized summary (the
  registered `errors.<code>` sentence when the runtime reported a known code,
  the localized `chat.subagentStatus.*` outcome otherwise), the stable code,
  the raw provider message behind a Show details / Hide details disclosure, and
  a copy control. The disclosure control stays reachable while the details are
  collapsed, and the delegate that completed or is still running shows no card
  at all.
- **Specs linked**: `04-ux/08-component-spec.md` §5.7,
  `04-ux/09-interaction-patterns.md` §9.1
- **Acceptance**: C (conversation), Quality
- **Milestone**: M6+
- **Status**: Documented; desktop journey pending. The failure card's data
  source is unit-tested in `subagent-topology.test.mjs`: a settled delegation's
  `error: { code, message }` read from `TaskWait` `delegations[]` and `TaskStop`
  `stopped[]`, lifecycle row ordering, entries without an error, and the
  terminal Task snapshot that carries a failure before parent polling.

## E2E-SUBAGENT-settlement-updates-before-parent-poll

- **Preconditions**: An Agent session with two parallel delegates; one can
  finish while the other continues and the parent does not poll lifecycle tools.
- **Steps**: 1) Start both delegates and open the first delegate's detail dock.
  2) Optionally let TaskList report both as running. 3) Complete only the first
  delegate while the parent turn remains live. 4) Switch sessions and return,
  then reload history after the turn finishes. 5) Repeat with failed and stopped
  delegates, and with a delegate finishing before its Task result arrives.
- **Expected**: The settled node stops spinning immediately, its status is
  completed (green) or the actual failure/stop outcome, and its elapsed time
  stops increasing. The sibling remains running; the aggregate reads one of
  two settled. The open dock updates with the same status and failure details.
  A stale running TaskList snapshot cannot undo settlement. Reload preserves
  the actual terminal outcome and original Task identity, arguments, and usage.
- **Specs linked**: `03-runtime/02-agent-runtime.md` §Subagents,
  `04-ux/08-component-spec.md` delegation topology
- **Acceptance criterion**: C, Quality
- **Milestone**: M6+
- **Status**: Runtime event-order and renderer projection regressions automated;
  desktop journey documented. Required suites: `test:e2e`, `test:e2e:subagents`.

## E2E-SUBAGENT-resume-a-settled-delegation

- **Preconditions**: An Agent session on a deterministic local transport that can
  complete, fail, stop, and hold a delegate open on request. Two user
  definitions, `~/.agents/subagents/scout.md` (read-only) and
  `~/.agents/subagents/fixer.md`; a workspace file `src/report.ts` whose
  conclusion is easy to locate by file and line; and a definition model binding
  that can be removed from the configuration. The parent catalog offers `Task`,
  `TaskWait`, `TaskList`, and `TaskStop`.
- **Steps**:
  1. Delegate `scout` a brief that must end by naming one conclusion with its
     file and line number, and let it settle `completed`. Note the
     `delegationId` the Task result returns.
  2. Send a turn that passes that id as `Task.resume` and asks for the same
     conclusion plus a second occurrence the first run never reached. Expand the
     delegation card, then inspect what the parent itself received.
  3. Send a turn that only says "reuse what the scout already found", with no
     `resume` value.
  4. Start a long-running `scout` delegation and call `Task.resume` for it while
     it works; then, while a resumed run of another chain is still working, call
     `Task.resume` for that chain again.
  5. `TaskStop` one delegation, abort a second, and close the app while a third
     is still working. After relaunch, call `Task.resume` for each of those three
     ids as reported by `TaskWait`.
  6. Let a delegation fail after one successful read, then call `Task.resume`
     for it.
  7. Send one `Task` call that carries both `resume` and `model`.
  8. Remove the chain's recorded model from the configuration, then `Task.resume`
     the chain and read its delegation lifecycle details and card.
  9. Settle two `scout` chains, `resume` the older one, settle a third chain for
     the same definition, and read the reusable list the next prompt offers; then
     keep one chain running while two others settle for that definition.
  10. Accumulate more than 50,000 lines of read-only tool output in one chain,
      then call `Task.resume` with its id.
  11. Resume a `scout` chain while spelling `Task.agent` as `Explorer`, then as
      `explorer.md`, then as another definition's name.
  12. Let one chain read more than eight files and send two further prompts in
      the same session, comparing the reusable list each prompt composes.
  13. Relaunch the app and, without changing anything else, `Task.resume` a
      `completed` chain from before the restart.
  14. From a fixture session that resolves a chain but no longer holds any of its
      delegate rows, call `Task.resume` with that id.
- **Expected**:
  - Step 2 resumes from the chain: the new run answers with the earlier
    conclusion's exact file and line, and its rows contain no fresh full read of
    that file. `Task` returns a new `delegationId`, and the parent's own context
    still holds one final report for that delegation and no delegate tool rows.
  - Step 3 is a cold start: a brand-new delegate with no earlier conclusion in
    its rows, a fresh `delegationId`, and no link to the earlier chain. Leaving
    the id out never inherits context, whatever the prompt says.
  - Step 4 fails twice as tool errors. The running delegation is reported as
    still running, with the instruction to converge through `TaskWait` first;
    nothing is started, nothing is queued, and the running delegate keeps
    working.
  - Step 5 refuses `stopped`, `aborted`, and the run the app closed while it was
    still working (which reads as `interrupted` after relaunch) as not
    resumable, each naming that reason and the fresh-delegation path instead. No
    run starts.
  - Step 6 resumes the failed chain like a completed one: the reads it already
    made seed the new run, and its failed assistant row is not replayed.
  - Step 7 is refused as a tool error: a resumed run keeps the chain's model, and
    the message points at starting a new delegation to change models.
  - Step 8 still resumes, on the binding the definition resolves to now, and the
    delegation's lifecycle details carry the previous model id as
    `modelChangedFrom`. The parent sees it through the lifecycle snapshot it
    polls and the card shows it with the run, so the switch is never silent.
  - Step 9 keeps at most two reusable chains per definition: the least recently
    active settled chain is evicted whole, so every id on it answers as an
    unknown delegation with the current reusable list, while a chain whose latest
    run is still working is never evicted — the group may sit over the bound
    rather than strand a live delegate.
  - Step 10 drops the over-budget chain from the reusable list without trimming
    its history: no later prompt offers it and a `resume` for it is refused as
    having read too much to resume cheaply, while an ordinary delegation for the
    same work still succeeds from cold.
  - Step 11 matches the definition name case-insensitively and with the document
    suffix — `Explorer` and `explorer.md` both resume the chain — while a
    different definition's name is a name mismatch that lists the agents that do
    have reusable chains.
  - Step 12 offers each chain's latest `delegationId`, its objective, and at most
    eight of the files it read, with a `(+N more)` suffix past that. A chain that
    just settled is already there in the same session, with no app restart and no
    new session; running, non-resumable, over-budget, and evicted chains never
    appear.
  - Step 13 rebuilds the chain relationship from the transcript, so the
    `completed` chain is offered again after relaunch and resumes as before.
  - Step 14 fails as having no recorded history, and that same id is not listed
    among the reusable ids in the error or in any later prompt: the chain leaves
    the reusable list.
  - Throughout, the transcript shows the chain as one continuous multi-turn
    conversation under its newest Task card, with no "resumed" marker, and the
    resumed run's counters start at 0 so its turn, tool, and usage numbers
    describe the new run while the earlier rounds stay readable above it.
- **Specs linked**: `03-runtime/02-agent-runtime.md` §5f, ADR 0279
- **Acceptance**: C (conversation), Quality
- **Milestone**: M6+
- **Not covered (二期)**: reviving a `stopped`/`aborted` delegation, in-chain
  compaction, task queuing, and cross-session resumption.
- **Status**: Draft — chain resolution, resume validation, the reusable list, and
  transcript chain grouping are unit/regression covered
  (`packages/agent-runtime/src/delegation-chain.test.ts`,
  `delegation-history.test.ts`, `runtime.test.ts`,
  `apps/desktop/test/assistant-turns.test.mjs`); the desktop journey needs a
  capable environment. Required suites: `test:e2e`, `test:e2e:subagents`,
  `test:e2e:transcript`.

## E2E-SUBAGENT-context-overflow-compacts-before-failing

- **Preconditions**: An Agent session on a deterministic local transport whose
  model metadata declares a small context window (for example 16,000 tokens)
  and whose replies are scripted. The small window is injected through that
  fake provider, never a real one: real providers and paid APIs are not
  default test environments in this repository. A user definition
  `~/.agents/subagents/reader.md` declares `Read`, `Glob`, and `Grep`, and the
  workspace holds files large enough that two or three reads cross the
  delegate's hard limit.
- **Steps**:
  1. Delegate a brief that requires reading those files in sequence and record
     every request the transport receives, with its estimated size.
  2. Read the request that follows the boundary at which the delegate crosses
     its hard limit.
  3. Repeat with the crossing landing while a tool result is still pending,
     then with it landing on a completed turn.
  4. Repeat with the summary request scripted to fail.
  5. Repeat with a summary response containing only thinking blocks or
     whitespace, including a response stopped at the output limit.
  6. Run the same brief as the session Agent on the same fixture and compare
     its requests and transcript rows with a run recorded before this change.
  7. Inspect the delegation card, the transcript, the context inspector, and
     the parent's own model context after the delegate settles.
- **Expected**: The delegate keeps working instead of failing. The request
  after the crossing is below the hard limit and carries a summary plus the
  applicable retained tail; no request is sent above the window. A pending
  tool result retains as an active turn (latest user message only), a
  completed turn retains none. A failed summary degrades to the original task
  brief plus the most recent message(s), the run still completes, and the
  report and lifecycle details say it was degraded rather than presenting a
  partial answer as complete. A thinking-only or whitespace-only summary also
  follows that degradation path, preserves the recent tool evidence, and never
  installs an empty successful checkpoint. Delegate compaction adds no
  transcript row, no host-core checkpoint, no warning toast, and no
  context-inspector line; the delegate's own rows stay complete and the
  parent's model context still holds only the report. The session Agent
  behaves exactly as it did before.
- **Specs linked**: `03-runtime/02-agent-runtime.md` §5.1, §5f,
  `03-runtime/08-error-codes.md` §3.2, ADR 0299, ADR 0064, ADR 0136
- **Acceptance criterion**: C — Conversation & stream; Quality
- **Milestone**: M6+
- **Status**: Draft. Required suites: `test:e2e`, `test:e2e:subagents`.

## E2E-SUBAGENT-output-token-limit-is-a-visible-failure

- **Preconditions**: An Agent session uses a deterministic local provider whose
  response ends with `stopReason: "length"` or `"max_tokens"` after emitting
  non-empty assistant text. The delegate has a valid report and no pending
  tool call.
- **Steps**: 1) Delegate the task and let the provider end at its output-token
  limit. 2) Read the Task result, lifecycle details, and delegation card. 3)
  Resume or retry the same work with a provider response that ends normally.
- **Expected**: The first run settles as `failed`, not `completed`, with
  `SUBAGENT_OUTPUT_TRUNCATED` and `outputTruncated: true`. The parent receives
  an explicit explanation and the bounded partial report under `Its last
  output was:`. A later turn that ends with `stop` clears the marker and
  settles as `completed`; the partial run never masquerades as a finished
  report.
- **Specs linked**: `03-runtime/02-agent-runtime.md` §5f,
  `03-runtime/08-error-codes.md` §3.2
- **Acceptance**: C (conversation), H (diagnostics), Quality
- **Milestone**: M6+
- **Status**: Unit covered by `packages/agent-runtime/src/subagent.test.ts`;
  the full desktop journey remains required: `test:e2e`,
  `test:e2e:subagents`.

## E2E-SUBAGENT-context-overflow-reports-actionable-failure

- **Preconditions**: The same injected small-window fake provider, sized so
  even the degraded context cannot fit. One definition declares two ordered
  `fallbackModels`: one whose window is no larger than the primary's and one
  that is larger. A second definition declares none.
- **Steps**:
  1. Delegate a brief that overflows past both compaction and degradation, and
     read the tool result the parent receives plus the lifecycle details.
  2. Repeat for the definition that declares the two alternatives, recording
     which alternatives the transport is actually asked for.
  3. Repeat with every alternative at the same small window.
  4. Read the delegation card and the report in English and in Chinese.
  5. Continue the parent turn, then send a new prompt.
- **Expected**: The run fails with `SUBAGENT_CONTEXT_OVERFLOW`, not retriable,
  and what the parent reads names what it can change — narrow the task,
  delegate to a model with a larger context window, read less at once. The
  provider's raw overflow sentence is not what the parent receives. An
  alternative whose own budget cannot hold the carried context is never
  requested and appears in `modelFailures` with that reason; the larger
  alternative is attempted and can succeed. With no alternative that fits, the
  outcome stays `SUBAGENT_CONTEXT_OVERFLOW` rather than the final provider
  error. The delegate's rows stay durable and visible, the session returns to
  idle, and the next prompt is not `AGENT_BUSY`.
- **Specs linked**: `03-runtime/02-agent-runtime.md` §5f,
  `03-runtime/08-error-codes.md` §3.2, ADR 0299,
  ADR subagent-model-fallback
- **Acceptance criterion**: C — Conversation & stream; Quality
- **Milestone**: M6+
- **Status**: Draft. Required suites: `test:e2e`, `test:e2e:subagents`,
  `test:e2e:subagent-models`.

## E2E-SUBAGENT-resume-seeds-within-context-budget

- **Preconditions**: The same injected small-window fake provider. One settled
  `reader` chain read enough to exceed the delegate hard limit while staying
  under `MAX_RESUMABLE_READ_LINES`; a second settled chain fits well inside
  the budget. The resumed fixture uses `vendorKey: "deepseek"` and includes a
  persisted assistant row with both answer text and thinking.
- **Steps**:
  1. `Task.resume` the over-budget chain and capture its first provider
     request in full.
  2. `Task.resume` the chain that fits and capture the same request.
  3. Ask the resumed run for a conclusion the chain reached in its most recent
     round, and for one it reached in its first round.
  4. Relaunch the app, rebuild the chain index from the transcript, and resume
     the over-budget chain again.
  5. Accumulate more than `MAX_RESUMABLE_READ_LINES` of read-only output in a
     chain and read the reusable list the next prompt offers.
  6. Inspect the resumed assistant history in the captured request and verify
     its same-model reasoning remains in `reasoning_content`.
- **Expected**: The first request of a resumed run is below the hard limit. It
  opens with the original task brief and holds the most recent turns; the
  oldest tool results are dropped first, and dropping an assistant message
  drops its tool calls with it, so no orphaned tool call reaches the provider.
  A chain that fits is seeded whole, exactly as before. The most recent
  conclusion is answered from the seeded context; the first round's may be
  gone, and the run says so rather than inventing it. A resume never fails
  with `CONTEXT_TOO_LARGE` or `SUBAGENT_CONTEXT_OVERFLOW` on its first
  request. With a vendorKey binding, restored assistant history uses the same
  `model.provider` / `model.id` identity as live requests, and its thinking
  stays in the native `reasoning_content` field. `MAX_RESUMABLE_READ_LINES`
  still removes an over-read chain from the reusable list; truncation does not
  make it resumable again.
- **Specs linked**: `03-runtime/02-agent-runtime.md` §5f, ADR 0299, ADR 0279
- **Acceptance criterion**: C — Conversation & stream; Quality
- **Milestone**: M6+
- **Status**: Draft. Required suites: `test:e2e`, `test:e2e:subagents`.

## E2E-161: A delegation lifecycle row reads as a subagent row

- **Preconditions**: A project-bound Agent session with a mocked provider stream
  that starts two delegates (`explorer`, `fixer`) with `Task`, then calls
  `TaskList`, `TaskWait` and `TaskStop`.
- **Steps**: 1) Start both delegates and inspect the collapsed `TaskList` row
  while both are running. 2) Let `explorer` complete and `fixer` fail, then
  inspect the `TaskWait` row's summary, badge and expanded body. 3) Start a
  third delegate reusing the `explorer` definition, call `TaskList`, and read
  the summary. 4) Stop a running delegate and inspect the `TaskStop` row.
  5) Confirm the delegation card's own subagent count is unchanged by all three
  lifecycle rows. 6) Repeat in Chinese.
- **Expected**: Every lifecycle row summarizes by agent name — never by its
  `delegationIds` argument, and no bare UUID appears in a collapsed row. Its
  badge uses the shared subagent status vocabulary: running while any member
  runs, `Failed` / “失败” once a member failed even though a sibling completed,
  and `Stopped by request` / “已按请求停止” for the stopped delegate — including
  when the persisted `TaskStop` snapshot still says `running`. The topology
  card's node matches that stopped outcome and is not labelled working after
  the turn ends. A repeated
  definition is counted (`explorer ×2`) rather than listed twice. The expanded
  body shows the joined reports as a notice followed by one named row per
  subagent with status, runtime and turns, and contains no pretty-printed
  `delegations[]` JSON. The delegation card still reports the number of `Task`
  calls only, so lifecycle rows never inflate the topology counts.
- **Specs linked**: `04-ux/08-component-spec.md` §9.9,
  `03-runtime/02-agent-runtime.md` §5f, ADR 0062, ADR 0089, decisions-log D269
- **Acceptance**: C (conversation), Quality

## E2E-155: Subagent lifetime is parent-judged; runtime delivers reports

- Abort the parent while it is waiting for a provider response and while it is
  idle waiting for two delegates. Hold delegate teardown at the provider edge;
  retire the parent and one child first. Abort must remain pending, status must
  remain busy and a new prompt must be rejected until the last child retires.
  Concurrent abort requests share cleanup. A follow-up prompt is accepted after
  abort resolves, with no old-turn continuation or tool execution.

- **Preconditions**: A project-bound Agent session with a Bash-capable
  `explorer` definition and a mocked provider stream.
- **Steps**: 1) Start a delegate and let the parent stop calling tools while
  it still runs; confirm the durable turn stays open and the delegate is not
  aborted. 2) Let the delegate finish and confirm the parent is prompted with
  its report without the user sending “continue”. 3) Let a `TaskWait` expire
  while the delegate is still running and read the heartbeat the parent
  receives. 4) `TaskList` a running delegate and confirm elapsed / last-tool
  fields. 5) `TaskStop` and user Stop still abort. 6) Run a delegate whose
  document declares `maxTurns: 2` and let it pass two tool-calling turns;
  confirm the key is ignored and the delegate keeps running. 7) Start a
  delegate on another model, exhaust the parent HTTP 429 budget, and click
  Continue; confirm leftover delegates abort, the session is idle, Continue
  is accepted, and the failed assistant error surface stays visible. 8) Define
  a delegate with an explicit `maxTokens` and one without, run both, and read
  the two outgoing provider requests. 9) Start enough delegates for their
  combined reports to exceed the bounded `TaskWait` result, then let the parent
  idle.
- **Expected**: Idle and duration watchdogs never fire. Parent idle does not
  abort delegates. Completion reports are delivered into the same durable
  turn. `TaskWait` expiry reports “Still running after Ns”, includes a
  heartbeat, and states that this is not a failure. No turn count ends a
  delegate, and no status reports one. Explorer's catalog includes
  `Bash` while code-reviewer remains read-only. A terminal parent 429 aborts
  leftover delegates and Continue is not `AGENT_BUSY` (D352). In step 8 the
  capped delegate's request carries the declared output limit and the uncapped
  one carries the model's published limit, so the cap overrides the derived
  `max_tokens` / `max_completion_tokens` / `max_output_tokens` without
  disturbing the session's own requests (D383). In step 9, the reports omitted
  from the bounded `TaskWait` content are delivered once by the idle resume and
  are not replayed after they reach the parent.
- **Specs linked**: `03-runtime/02-agent-runtime.md` §5f,
  `03-runtime/08-error-codes.md`, `03-runtime/09-logging-and-observability.md`,
  ADR 0166, ADR 0189, decisions-log D328 / D352 / D383
- **Acceptance**: C (conversation), E (tools & permissions), H (diagnostics), Quality
- **Milestone**: M6+
- **Status**: Covered by unit tests; full desktop journey pending. The output
  cap's parse and clamp are covered in `packages/shared`
  `subagent-definition.test.ts`, and its document round-trip in host-core
  `user_subagents` tests; the request-level assertion in step 8 stays manual.

## E2E-166: Subagent model selection

- **Preconditions**: Agent mode; at least one provider has two configured model
  bindings; a builtin subagent definition is available.
- **Steps**: 1) Enable the delegation checkbox for one model binding, save the
  provider, reopen it, and confirm the checkbox remains enabled; restart the
  app, reopen the provider again, and confirm it is still enabled. 2) Start a
  session and inspect the parent agent's system prompt for the delegation model
  summary. 3) Delegate a Task with `model: "provider/modelId"` pointing to the
  enabled binding. 4) Delegate a Task with `model:` pointing to a binding that
  is not enabled for subagents. 5) Delegate a Task with `model:` pointing to a
  model that is not configured at all. 6) Delegate a Task with no `model:`
  parameter and a definition that has a frontmatter model pin. 7) Delegate a
  Task with no `model:` parameter and a definition that has no frontmatter
  model pin. 8) With no enabled delegation models, delegate a Task once with
  no `model:` and once with `model:` repeating the current session's
  `provider/modelId`. 9) Pin an unselected model to one definition; attempt to
  use it as another definition's explicit override, then invoke its owner with
  no override. 10) Remove a previously enabled override key and start another
  prompt in the same idle session.
- **Expected**:
  1. Saving and reopening the provider preserves the
     `availableForSubagents` opt-in, including after an application restart.
  2. The delegation model summary appears in the parent's system prompt listing
     every successfully resolved model marked `availableForSubagents`, with
     no definition-only pins. The Task definition catalog displays each default
     model and recommends omitting `model` to preserve it.
  3. The Task tool accepts the `model` parameter and the delegate runs on the
     specified model, not the session model; its delegation node shows the
     effective model id immediately after the subagent name.
  4. If the model is not configured or not enabled for delegation, the Task
     returns a tool error listing available models. With an empty override
     catalog, the error, system summary and Task description name the Settings
     → Models / model Advanced / "Available for AI delegation" / save path.
     A denied guessed override sends no child request; retrying with `model`
     omitted still uses the definition default or inherits the parent model.
  5. Resolution priority is Task.model parameter → definition frontmatter pin →
     session model.
  6. On-demand resolution succeeds for models enabled in provider settings via
     the `provider.resolveSubagentModel` RPC.
  7. When no delegation model is configured, omitting `model:` and explicitly
     repeating the current session `provider/modelId` both start the delegate
     on the session model; the latter is not reported as an unavailable model.
  8. A private pin remains usable by its definition when `model` is omitted
     or when `Task.model` repeats that definition's own pin key, but cannot be
     selected for another definition without opt-in. Rejection issues no child
     provider request. On-demand authorization does not retire an idle runtime;
     changed launch opt-in does, so a stale cached binding grants no selection
     rights.
- **Specs linked**: `03-runtime/02-agent-runtime.md` §5f,
  `03-runtime/11-provider-model-system.md` §7,
  `03-runtime/12-provider-config-schema.md` §2,
  `08-meta/decisions-log.md` (D278)
- **Acceptance**: C (chat/stream) + B (model configuration) + E (tools)
- **Milestone**: M6+
- **Status**: Partially automated. `pnpm test:e2e:subagent-models` drives the
  built sidecar over real NDJSON and a local deterministic SSE model fixture:
  empty-catalog guidance and inheritance after a denied override,
  private cross-definition rejection, own-pin echo, normal pin use, allowed override priority,
  on-demand authorization without runtime rebuild, exact-session inheritance, and revocation across two
  prompts all pass. Runtime unit tests cover the same selection gates and the
  desktop launch test exercises independent opt-in, revocation, and accounts
  sharing a vendor alias; the wiring test checks unique on-demand matching. The settings checkbox
  UI/persistence journey and live external provider execution remain manual;
  this fixture does not claim a complete native UI journey.

- **Authorization regression coverage (#841)**: `pnpm test:e2e:subagent-models`
  grants a model on demand, reuses the runtime, then revokes it without changing
  the launch catalog. The next prompt must reauthorize and issue no child request.
  A transcript-restored resume with a colliding model id must use the session
  binding rather than another definition's private account. Runtime tests also
  cover own pins/fallbacks, opted-in bindings, visible fallback metadata, live-key
  reauthorization, and late RPC responses crossing parent turns.

## E2E-181: An imported skill is listed in the next session catalog

- **Preconditions**: Settings > Agent > Skills is open. A conventional
  `<skill>/SKILL.md` document has a non-ASCII frontmatter name and a folded
  YAML description. An empty Agent session is available on the same project
  the skill will be imported into.
- **Steps**:
  1. Import the `SKILL.md` into Global, then into the selected project.
  2. Confirm the Skills page shows the display name, the ASCII id (directory
     name, not `skill`), and the flattened description.
  3. Start a new Agent session on that project and ask the agent to use the
     skill by display name.
  4. Repeat with a second directory skill that also lacks an ASCII name, and
     with a skill whose description is a `|` block.
- **Expected**:
  - Import succeeds. The catalog lists both skills with distinct ids.
  - The next session's system prompt includes each skill's id, name, and
    flattened description. The `Skill` tool loads the body by that id.
  - A misspelled `Skill` id lists user skill ids among the available skills,
    not only plugin ids.
  - Neither document is dropped because its title is non-ASCII or because both
    files are named `SKILL.md`.
- **Specs linked**: `03-runtime/01-ipc-protocol.md` §12b,
  `07-plugins/01-plugin-system.md` §12.3, `08-meta/decisions-log.md` (D174,
  D194)
- **Acceptance**: E (tools & permissions), Quality
- **Milestone**: M5
- **Status**: Unit-covered (host-core `user_skills` / `agent_capabilities`
  tests, `apps/desktop/test/plugin-skills.test.mjs`); full UI journey Draft
  (run only in a capable environment when this surface changes)

## E2E-186: Token usage dashboard is plugin-owned; host still stores turn totals

- **Preconditions**: A profile with at least one completed Agent turn that
  reported provider usage after this build. Settings is reachable. Plugin
  `pi.token-insights` may be installed.
- **Steps**: 1) Complete a turn that also settled a subagent. 2) Open
  Settings. 3) Search settings for "tokens" / "用量". 4) Open Token Insights
  from the command palette (`usage` / `用量`). 5) Confirm the transcript
  assistant chip.
- **Expected**:
  - The rail has no Usage / 用量 destination. Preferences is General, AI,
    Shortcuts.
  - Settings search does not surface a usage tab.
  - `stats.getTokenUsageHistory` still returns completed-turn totals that
    include subagent spend.
  - The assistant chip under the transcript still shows parent-only provider
    usage.
  - Token Insights is the heatmap / KPI dashboard. When the plugin is
    installed, PI-Desktop remainders from the host turns table appear there
    without rewriting `message.usage`.
- **Specs linked**: `04-ux/06-settings-ia.md`,
  `03-runtime/01-ipc-protocol.md`, `03-runtime/06-host-rpc-protocol.md`,
  ADR 0171, ADR 0173, `08-meta/decisions-log.md` (D331, D335)
- **Acceptance**: F (persistence), Quality
- **Milestone**: M5
- **Status**: Unit-covered (agent-runtime usage split, host-core history
  aggregation, settings-search / i18n catalogs); plugin remainder merge
  covered in `pi-desktop-plugins`; full UI journey Draft (run only in a capable environment when this surface changes)

## E2E-188: Plugin host APIs list models, read in-flight context, and complete

- **Preconditions**: At least one authenticated provider; a development plugin
  granted `models.list`, `session.read`, and `agent.complete`; an Agent
  session with a prior user turn.
- **Steps**:
  1. From the plugin process call `pi.models.list()`. Confirm only ready
     models are returned and no secret fields appear.
  2. Call `pi.session.getLlmContext()` outside a tool execution. Confirm
     `INVALID_ARGUMENT`.
  3. Ask the Agent to call the plugin tool. Inside `execute`, call
     `getLlmContext()` then `agent.complete({ modelKey, includeSessionContext:
     true })`. Confirm the tool result contains reviewer text and usage, not
     a secret.
  4. Repeat `agent.complete` until the eighth call in 60s succeeds and the
     ninth returns `RATE_LIMITED`.
  5. Make the completion fail at the provider (for example a model whose
     credential the user has revoked). Confirm the plugin reads the classified
     code — `PROVIDER_UNAUTHORIZED` — rather than a generic failure.
  6. Stop host-core and call `pi.models.list()`. Confirm `[]` and no warn line.
  5. Stop host-core and call `pi.models.list()`. Confirm `[]` and no warn line.
- **Expected**: Credentials never leave Electron main. Audit lines record
  plugin id, model key, sizes, and usage — not transcript or completion text.
  Plan still returns `PLUGIN_DISABLED_IN_PLAN` for the plugin tool. A dead
  host transport returns an empty model list without a warning (D080).
- **Specs linked**: `07-plugins/03-plugin-api.md`,
  `07-plugins/13-plugin-permissions-matrix.md`, ADR 0174, D336
- **Acceptance**: G (plugin agent tool), Security
- **Milestone**: M5
- **Status**: Unit-covered (`plugin-complete.test.mjs`,
  `plugin-session-context.test.ts`, `subagent-wiring.test.mjs`); full UI
  journey Draft (run only in a capable environment when this surface changes)

## E2E-189: Bundled Advisor plugin is temporarily unavailable

- **Preconditions**: A packaged or development build of PI-Desktop.
- **Steps**:
  1. Inspect the bundled plugin resources and confirm `pi.advisor` is absent.
  2. Open the command palette and plugin settings. Confirm `/advisor`, the
     Advisor plugin, and its `advisor` tool are absent.
- **Expected**: The temporary removal does not expose an Advisor command,
  plugin, panel, skill, or agent tool. The general host-owned plugin completion
  APIs remain available to explicitly installed plugins.
- **Specs linked**: `07-plugins/03-plugin-api.md`, ADR 0174, D336
- **Acceptance**: G (plugin agent tool), C (conversation)
- **Milestone**: M5
- **Status**: Unit-covered (`bundled-plugins.test.mjs`); full UI journey Draft
  (run only in a capable environment when this surface changes)

## E2E-202: Subagent thinking follows its exact model binding

- **Preconditions**: A configured provider has a model binding marked
  `availableForSubagents`. The catalog either reports that model as
  non-reasoning or omits one of the levels the binding explicitly enables. A
  user subagent definition and the builtin `Task` catalog are available.
- **Steps**: 1) In Settings → Model configuration, enable `medium` and `high`
  for the delegation model and mark it available for subagents. 2) Set the
  subagent definition's thinking level to `high`, save, and restart the app.
  3) Run the definition with its frontmatter model pin. 4) Run a builtin with
  `Task.model` selecting the same binding, including the on-demand resolution
  path. 5) Run a definition with no model pin while the parent session is set
  to `medium`.
- **Expected**: The pinned and explicitly selected delegates retain the
  binding's enabled thinking levels and send the selected non-`off` level even
  when models.dev says reasoning is unavailable or publishes a sparse set. The
  unpinned delegate inherits the parent's effective level. A binding with no
  non-`off` level still resolves to `off`.
- **Specs linked**: `03-runtime/02-agent-runtime.md`,
  `03-runtime/11-provider-model-system.md`, ADR 0144 / D283
- **Acceptance**: B (model configuration) + C (chat/stream) + Quality
- **Milestone**: M6+
- **Status**: Unit/wiring-covered (`model-capabilities.test.ts`,
  `apps/desktop/test/subagent-wiring.test.mjs`); full UI journey Draft (do not
  run E2E locally unless explicitly requested)

## E2E-203: Omit subagent thinking override and read selected levels in dark mode

- **Preconditions**: A configured subagent model supports reasoning, and the
  application has both light and dark themes available.
- **Steps**: 1) Open Settings → Agent → Subagents and inspect the thinking
  selector. 2) Confirm it contains inherit-session, do-not-send, `off`, and
  the canonical levels. 3) Choose do-not-send, save, and confirm the document
  contains `thinkingLevel: omit`. 4) Run the subagent through a provider with a
  meaningful adapter default and inspect the outbound request. 5) Switch to
  dark mode, open Settings → Model configuration, expand a model's Advanced
  section, and select multiple thinking-level chips.
- **Expected**: Inherit continues to use the parent level; do-not-send
  persists and sends no provider thinking override; explicit `off` remains an
  explicit disable. Selected thinking chips have a solid high-contrast fill
  and readable text in both themes, and each selected level is visually
  distinguishable from the track.
- **Specs linked**: `03-runtime/01-ipc-protocol.md`,
  `03-runtime/02-agent-runtime.md`, `03-runtime/13-model-catalog-and-selection.md`,
  `04-ux/06-settings-ia.md`, ADR 0194 / D356
- **Acceptance**: B (model configuration) + C (chat/stream) + Quality
- **Milestone**: M6+
- **Status**: Unit/source-contract-covered; full UI journey Draft (run only in a capable environment when this surface changes)

## E2E-214: Plugin session import and ownership boundary

- **Preconditions**: A test plugin declares two `contributes.sessionSources`
  entries and receives only the P0/P1 session permissions. A second plugin has
  no access to the first plugin's sessions.
- **Steps**: 1) Import a session with external project/provider/model history,
  user, assistant, and tool messages. 2) Repeat the same import and verify
  idempotent skip with the same host-generated id. 3) List, get, and page
  messages, including descending order and content truncation. 4) Attempt an
  undeclared source, a system/running message role, invalid timestamps, an
  oversized/deep tool value, and each missing permission. 5) Repeat list/get/
  messages/rename/delete from the second plugin.
- **Expected**: Source declarations and permissions are enforced in Electron
  before host dispatch; ids are generated by host-core; original bindings are
  history-only; returned messages are marked external; reserved tool metadata is
  removed; invalid inputs fail with stable error codes; the second plugin sees
  neither the row nor its transcript.
- **Specs linked**: `07-plugins/02-plugin-manifest-schema.md`,
  `07-plugins/03-plugin-api.md`, `07-plugins/13-plugin-permissions-matrix.md`,
  ADR 0200, D367
- **Acceptance**: Security, Quality
- **Milestone**: M6+
- **Status**: Unit/RPC/wiring-covered; full UI journey Draft (run only in a capable environment when this surface changes)

## E2E-215: Plugin batch and delete lifecycle

- **Preconditions**: The test plugin can call `session.importBatch`, rename,
  and delete. Host-core starts with an empty v14 database.
- **Steps**: 1) Run a `skip` batch containing valid, duplicate, and invalid
  items. 2) Run a `fail` batch containing one invalid or conflicting item and
  verify no item from that batch lands. 3) Rename an owned session and verify
  list ordering/metadata. 4) Trash it, verify normal core/plugin reads omit it,
  then purge it and import the same external id again. 5) Exercise page-size,
  payload, batch-size, and rolling import/delete limits. 6) Restart on a
  migrated v13 database and verify existing core sessions remain active.
- **Expected**: Skip is partial and fail is atomic; list/get/message operations
  stay ownership-scoped; trash is recoverable only through the owner purge;
  purge removes transcript files and permits re-import; bounds return
  `LIMIT_EXCEEDED` and rolling limits return `RATE_LIMITED`; migration produces
  schema v14 without project rows for plugin history.
- **Specs linked**: `03-runtime/04-data-storage.md`,
  `03-runtime/06-host-rpc-protocol.md`, ADR 0200, D367
- **Acceptance**: Security, Quality, Recovery
- **Milestone**: M6+
- **Status**: Host/RPC/unit-covered; full UI journey Draft (run only in a capable environment when this surface changes)

## E2E-PLUGIN-usage-listTurns: Plugin usage fact listing

- **Preconditions**: A test plugin is granted `usage.read`. The host database
  has completed turns across live and soft-deleted sessions.
- **Steps**: 1) Call `pi.usage.listTurns` without the permission. 2) Call it
  with the permission, page by cursor, and filter by session/project/window.
  3) Pass inverted bounds, a window longer than 365 days, and a malformed
  cursor. 4) Confirm rows include token counters and titles but no message
  bodies, and that trashed sessions are absent.
- **Expected**: Missing permission returns `PERMISSION_DENIED` and does not
  hit the host. Valid calls return keyset pages of completed-turn facts.
  Invalid params return `INVALID_PARAMS`. Empty titles are `null`.
- **Specs linked**: `07-plugins/03-plugin-api.md`,
  `07-plugins/13-plugin-permissions-matrix.md`,
  `03-runtime/06-host-rpc-protocol.md`, ADR 0173, D335
- **Acceptance**: Security, Quality
- **Milestone**: M6+
- **Status**: Unit/RPC/wiring-covered (`plugin-session-api.test.mjs`,
  host-core `plugin_usage`); full UI journey Draft

## E2E-216: Explicit plugin project binding and host-owned sidebar refresh

- **Preconditions**: A test plugin has `project.create` and `session.import`
  permissions, declares a session source, and the renderer is showing the
  existing sidebar. A project path is available without changing the active
  workspace.
- **Steps**: 1) Call `pi.project.create({ path })` and record the returned
  `projectId`. 2) Import one session with that id and one session without it.
  3) Observe the renderer while the plugin call completes. 4) Repeat the
  import with the same external id and then rename/delete an owned session.
- **Expected**: Project creation returns a durable id without activating or
  replacing the current workspace. Only the import with an explicit id has an
  active project binding; an omitted id stays unbound and its `projectPath` is
  history only. Each successful write causes one host-owned
  `pi-desktop/session/event/changed`, the renderer refreshes through
  `refreshSessions()`, and the sidebar does not require a plugin-emitted event.
  Skipped imports do not trigger a redundant refresh, and closed project tabs
  are not reopened merely because their session list was refreshed.
- **Specs linked**: `07-plugins/03-plugin-api.md`,
  `07-plugins/13-plugin-permissions-matrix.md`, `03-runtime/01-ipc-protocol.md`,
  `03-runtime/06-host-rpc-protocol.md`, ADR 0201, D368
- **Acceptance**: C (sessions), Security, Quality
- **Milestone**: M6+
- **Status**: Unit/source-contract-covered; full UI journey Draft (run only in a capable environment when this surface changes)

## E2E-259: Installing the prompt-enhancement plugin migrates preferences once

- **Preconditions**: The profile contains legacy host prompt-enhancement
  settings and has no `pi.prompt-enhancement` plugin data. The standalone plugin
  is available from a configured catalog or repository; a Composer session is
  ready.
- **Steps**: 1) With the plugin absent, inspect the Composer and Settings and
  confirm there is no prompt-enhancement action or settings card. 2) Install the
  plugin explicitly and grant its requested permissions. 3) Inspect the
  plugin-owned settings and confirm valid legacy model, thinking, and enabled
  custom-template values were copied before the plugin loaded. 4) Transform a
  draft, undo it, and send it; confirm the action does not create a transcript
  row. 5) Clear a migrated plugin value, reload the plugin, and confirm the
  migration does not restore it. 6) Uninstall the plugin and confirm legacy host
  values remain.
- **Expected**: Installing the plugin is the only path that exposes the action.
  Existing plugin settings win over legacy values; invalid or inactive custom
  templates are skipped. A private marker makes migration one-time. Clearing a
  plugin setting does not cause a later import, and uninstalling the plugin does
  not delete legacy host values. Plugin transforms preserve draft/session race
  safety and attachment chip positions.
- **Specs linked**: `04-ux/12-prompt-enhancement.md`,
  `04-ux/06-settings-ia.md`, `03-runtime/04-data-storage.md`,
  `07-plugins/03-plugin-api.md`, ADR 0324
- **Acceptance**: C (conversation & stream), Quality, compatibility
- **Milestone**: M6+
- **Status**: Migration and plugin-runtime integration tests cover the copy,
  precedence, one-time marker, permission gate, and callback; full UI journey
  Draft (run only in a capable environment when this surface changes)

## E2E-220: Local MCP control drives a running desktop

- **Preconditions**: Start PI-Desktop with
  `PI_DESKTOP_MCP_CONTROL=1` and a clean profile. A local project directory is
  available, the Electron user-data directory is writable, and the desktop
  has completed backend boot.
- **Steps**: 1) Read `mcp-control.json` and use its URL and bearer token. 2)
  Call `initialize`, `tools/list`, and `pi_control_describe`. 3) Call
  `pi_project_open` with the fixture project. 4) Call `pi_session_create`,
  `pi_session_get`, and `pi_agent_status`. 5) Call `pi_agent_prompt` and
  observe the existing desktop session-change event select the target session.
  6) Call `pi_desktop_invoke` for a reviewed read operation. 7) Attempt
  `pi_session_delete` and `pi_session_configure` without confirmation, then
  repeat with `confirm: true`. 8) Stop the app and inspect the manifest.
- **Expected**: An unauthenticated request receives 401; `initialize` with an
  unsupported protocol version negotiates `2025-06-18`; the authenticated MCP
  handshake and tool catalog succeed; project/session/Agent operations use the
  same IPC validation and host permission boundaries as the renderer; mutating
  calls refresh/select the visible project and session while `pi_session_get`
  does not; destructive operations and `pi_session_configure` fail with a
  confirmation error until acknowledged; secret writes, `plugin/loadDev`, and
  native-picker channels are absent from `pi_control_describe`; secret-shaped
  fields are stripped; the endpoint binds loopback only; disallowed Origins and
  unsupported protocol version headers are rejected; and the manifest changes
  to `active: false` on shutdown.
- **Specs linked**: `02-architecture/01-architecture.md`,
  `03-runtime/01-ipc-protocol.md`, `05-security/01-security.md`, ADR 0203,
  D370, D372
- **Acceptance**: A (app control), C (sessions), Security, Quality
- **Milestone**: M6+
- **Status**: MCP protocol/unit-covered by `apps/desktop/test/mcp-control.test.mjs`;
  full Electron journey documented and remains deferred by the no-local-E2E
  policy

## E2E-MCP-session-get-projects-large-compaction

- **Preconditions**: Start PI-Desktop with `PI_DESKTOP_MCP_CONTROL=1`. A durable
  session exists whose `session.compaction` record (`summary` / `retainedTail` /
  `details.modifiedFiles`) alone serializes to more than the 512 KiB MCP result
  limit. A second durable session exists whose `session.compactions` history
  alone does — the newest `compaction` is already compact, but several history
  entries each carry their own `summary` / `retainedTail` /
  `details.modifiedFiles` (mocode #506).
- **Steps**: 1) Read `mcp-control.json`, use its URL and bearer token, and
  complete the MCP handshake. 2) Call `pi_session_get` for that session with any
  `messageLimit` / `contentLimit` / `messageBefore`. 3) Inspect
  `structuredContent`. 4) Repeat for the history-heavy session with the smallest
  page (`messageLimit: 1`, `contentLimit: 1`). 5) Repeat for a small session.
- **Expected**: The answer is not the `{truncated: true, reason:
  "MCP_RESULT_LIMIT", preview}` envelope; `session.messages` carries the
  requested transcript page; `session.compaction` keeps `createdAt` and
  `details.generation` while `summary`, `retainedTail`, and
  `details.modifiedFiles` are absent. Every `session.compactions` entry keeps its
  scalar identity and drops those same unbounded fields, so the history-heavy
  session returns a real page even at `messageLimit: 1` / `contentLimit: 1`. The
  small session's answer is unchanged.
- **Specs linked**: `03-runtime/01-ipc-protocol.md` §13d
- **Acceptance**: C (sessions), Quality
- **Milestone**: M6+
- **Status**: The local MCP server contract test in
  `apps/desktop/test/mcp-control.test.mjs` exercises authenticated JSON-RPC
  `tools/call` for oversized (current record, compaction history, and
  history-only) and under-limit `pi_session_get` results. The separate full
  Electron-to-Host journey remains release qualification.

## E2E-236: Plugin desktop control needs the user's native consent

- **Preconditions**: A dev plugin granted `desktop.control` whose panel calls
  `pi.desktop.invoke({ operation: "session/delete", args: [id], confirm })`.
  One disposable session exists.
- **Steps**: 1) Invoke with `confirm: false`. 2) Invoke with `confirm: true`
  and press Escape on the dialog. 3) Invoke with `confirm: true` and click
  Deny. 4) Invoke with `confirm: true` and click Allow once. 5) Invoke a
  `read` operation.
- **Expected**: Step 1 fails with `CONFIRMATION_REQUIRED` and no dialog
  appears. Steps 2 and 3 fail with `PERMISSION_DENIED`; the session still
  exists. The dialog names `session/delete` and the catalog description, never
  panel-authored text. Step 4 deletes the session and the sidebar refreshes.
  Step 5 shows no dialog. Every invocation is audited with plugin id,
  operation, and risk.
- **Specs linked**: `07-plugins/03-plugin-api.md` (desktop control),
  `07-plugins/04-plugin-security.md` §8.2,
  `07-plugins/13-plugin-permissions-matrix.md`, ADR 0203, ADR 0208, D370,
  D372, D377
- **Acceptance**: D (plugins), Security
- **Milestone**: M6+
- **Status**: runtime-covered by
  `apps/desktop/test/plugin-desktop-control.test.mjs`; the native dialog
  journey is documented and deferred by the no-local-E2E policy

## E2E-PLUGIN-session-orchestrator-real-workers: Session Orchestrator creates and coordinates durable sessions

- **Preconditions**: The marketplace `pi.session-orchestrator` plugin is installed and enabled;
  the parent Agent session has a configured authenticated provider/model and a
  project path. The parent is in Agent mode.
- **Steps**: 1) Ask the parent to review Frontend, Electron, and Rust in
  parallel. 2) Confirm that `SessionTask.spawn` returns three distinct real
  durable `sessionId` values and one host `messageId` per delivery; each
  worker is visible in the normal session list. 3) Confirm all three workers
  receive prompts without using `session/fork` and can run concurrently. 4)
  While a worker is busy, send a follow-up to that exact Session ID and verify
  it is queued against the target inbox rather than starting a second turn. 5)
  Inspect status from the Agents panel and a sidebar hover card; confirm both
  use bounded host projections, the hover card marks currently running
  created-session links, and neither surface fetches a complete worker
  transcript.
  6) Wait for one worker, query `result` by its exact `messageId` and `turnId`,
  and inspect the parent transcript for one host-generated completion message.
  7) Re-read the result and repeat the settlement notification path; confirm
  the callback and transcript row are not duplicated. 8) Send a parent-to-worker
  and worker-to-parent message in separate active plugin Agent tool turns;
  verify source/target provenance and real target turn binding in both
  transcripts. 9) Open one worker from the Agents panel, send it a follow-up
  using the exact returned `sessionId`, and stop another worker. 10) Restart
  the host/plugin with a queued delivery and confirm it remains held, while an
  interrupted turn is not replayed. Repeat the parallel creation step with a
  large existing session list while keeping the parent visible. 11) With one
  model's «Available for AI delegation» left off, ask the parent to spawn a
  worker on it by `modelKey`, then spawn again with no `modelKey`.
- **Expected**: Each worker is a real durable session with the parent's
  project/model/thinking/permission ceiling and an independent empty
  transcript at creation. The host ledger binds every delivery to the actual
  target durable turn; result text and error status derive from that turn's
  terminal state, not from polling assistant text. The parent receives only
  bounded, at-most-once completion messages; full worker transcripts remain
  inspectable in their own sessions. `sessionId` is the only canonical worker
  identity and follow-up `send` reuses that same session and context without
  creating a replacement. A session-message row is visibly distinct from
  human input and its provenance survives reload. `wait` returns `timedOut`
  within its bound instead of occupying the host tool deadline. Cancel
  interrupts only the selected delivery/turn without deleting the session.
  Sends without an active plugin tool invocation, forged source ids, targets
  above the source permission ceiling, worker fan-out overflow, inbox overflow,
  and autonomous callback loops fail closed. A `spawn` naming a model the user
  has not enabled for AI delegation is refused with `PERMISSION_DENIED` before
  a worker exists, while omitting `modelKey` — or naming the default model's
  own key — still inherits. Unrelated sessions and the
  existing Task family are unchanged, and no localhost MCP call or token
  access occurs. Bursts of worker notifications serialize and coalesce
  session-list refreshes while preserving the final worker list and the
  foreground session.
- **Specs linked**: `07-plugins/03-plugin-api.md`,
  `07-plugins/04-plugin-security.md`, `07-plugins/11-plugin-storage-isolation.md`,
  `03-runtime/01-ipc-protocol.md`, `03-runtime/06-host-rpc-protocol.md`,
  `03-runtime/04-data-storage.md`, `03-runtime/11-provider-model-system.md`,
  ADR 0237, ADR 0239, ADR subagent-model-opt-in
- **Acceptance**: C (parallel durable sessions), D (plugin security), Quality
- **Milestone**: M6+
- **Status**: host ledger coverage is automated by
  `pnpm test:e2e:collaboration`; marketplace plugin tests cover the plugin
  runtime, and host-core/desktop unit tests cover the additive host primitives.
  The full live provider/Electron journey remains runner validation under the
  no-local-E2E policy

## E2E-237: Plugin fetch re-checks egress on every redirect

- **Preconditions**: A dev plugin with `net.domains: ["allowed.test"]` and
  `net.fetch`. A local server on `allowed.test` answers `/hop` with a 302 to
  `http://undeclared.test/leak`, `/ok` with 200, and `/limited` with 429 and
  `Retry-After: 2`.
- **Steps**: 1) Call `pi.net.fetch({ url: "https://allowed.test/ok" })`. 2)
  Call `pi.net.fetch({ url: "https://allowed.test/hop" })`. 3) Call
  `pi.net.fetch({ url: "https://allowed.test/limited" })`.
- **Expected**: Step 1 returns 200. Step 2 fails with `PERMISSION_DENIED`
  naming `undeclared.test`, and the undeclared server records no request. The
  audit log shows the denied hop. Step 3 returns 429 with its `Retry-After`
  header intact, the server records exactly one request for it, and the audit
  log shows `ok: false` with the advertised `retryAfter` — the host retries
  nothing.
- **Specs linked**: `07-plugins/04-plugin-security.md` §8.0,
  `07-plugins/03-plugin-api.md` §7
- **Acceptance**: D, Security
- **Milestone**: M4+
- **Status**: runtime-covered by `apps/desktop/test/plugin-egress.test.mjs`
  (per-hop egress and failed-call audit)

## Trusted extension scenarios (R7 v1)

The following scenarios are the acceptance targets of D387 / ADR 0214 and
`07-plugins/16-trusted-extensions.md`. The headless runner generates its six
plugin-form fixtures in an isolated temporary directory at runtime.

## E2E-241: Discovery lists trusted extensions and enablement is explicit

- **Preconditions** (D388): a pi extension directory `hello/` with
  `index.ts`, and a plugin package declaring `contributes.agentExtensions`
  with `agent.extension` whose activation scope is limited to the fixture
  project; a second project outside that scope.
- **Steps**: 1) Plugins → Import pi extension, accept the confirm, pick
  `hello/`. 2) Send a prompt in the fixture project. 3) Open the imported
  plugin's row details. 4) Disable the plugin and send a prompt. 5) Switch
  to the second project and send a prompt. 6) Load a plugin whose manifest
  lists `agentExtensions` without the permission.
- **Expected**: The import creates `plugins/imported/hello` with a manifest
  holding `agent.extension` and lists the plugin with the `agentExtension`
  capability and the permission chip; the next turn lists its tools and the
  row shows `loaded` with the registered names; disabling the plugin retires
  the runtime and the next turn has no extension tools; the project-scoped
  plugin contributes nothing outside its projects; the manifest without the
  permission is rejected as `PLUGIN_INVALID`; `~/.pi/agent/settings.json`
  is never written.
- **Specs linked**: `07-plugins/16-trusted-extensions.md` §2, §3, §11; D007; D387
- **Acceptance**: Security, Quality
- **Milestone**: Post-MVP (R7 v1)
- **Status**: Partially automated (`pnpm test:e2e:trusted-extensions`); the headless journey covers plugin discovery/projection, project scope, load state, and diagnostics, while native picker import and explicit enablement remain renderer/platform validation.

## E2E-PLUGIN-imported-pi-package-wrapper: Imported package module types preserve plugin initialization

- **Preconditions**: Isolated local Pi packages declare `type: module`,
  `type: commonjs`, or no `type`; each has an extension and skill contributions.
  A fourth fixture represents an older imported ESM package with the generated
  CommonJS `main.js` and matching manifest.
- **Steps**: Run `node --test apps/desktop/test/imported-package-skills-runtime.test.mjs`.
  Generate each plugin through the production importer, load it through
  `PluginRuntime` and the real child-process plugin host, read its skill catalog
  and bodies, and inspect its declared extension. Re-import the older fixture
  without loading it, then load the older fixture itself.
- **Expected**: Each new manifest points to an existing `main.cjs`; initialization
  succeeds for all three package types. Source and both copied `package.json`
  files retain the same bytes. The repeated import has a distinct path/id and
  loads successfully; generating it leaves the older manifest, wrapper, and
  package files unchanged. Loading the older fixture rewrites its generated
  `main.js` in place to `main.cjs`, keeps the copied `package.json` bytes, and
  initializes. A customized `main.js` is not rewritten.
- **Specs linked**: `07-plugins/16-trusted-extensions.md` §3.2; ADR 0215.
- **Acceptance**: Quality
- **Status**: Automated import-to-plugin-host fixture. Run against the committed
  task candidate after incorporating the latest `origin/main`; record the tested
  candidate, base, result, and environment in delivery evidence. Native picker,
  npm dependency installation, Windows execution, and third-party extension
  execution during a provider turn are not covered by this fixture.

## E2E-PLUGIN-imported-pi-package-skills: Explicit package import exposes skills through plugin grants

- **Preconditions**: A local fixture package under an npm-style
  `node_modules/@fixture/package-skills` path declares `pi.extensions` and
  `pi.skills`. Its skills include a direct Markdown file, a directory with
  `SKILL.md`, and a collection containing two different `SKILL.md` files.
  Reference files, assets, a `node_modules-note.txt` resource, and an internal
  `node_modules` dependency are present. A second fixture declares only
  `pi.skills`. No downloaded third-party code or dependency installation is
  needed.
- **Steps**:
  1. Choose the mixed package through Plugins → Import pi extension and
     inspect the generated manifest and copied resources. For headless
     validation, pass the explicit selected path to the same importer.
  2. Load the generated directory in the real `PluginRuntime`; inspect
     `getSkills()` and read every document with `loadSkillBody(id)`.
  3. Reload with only `agent.extension` granted, then reload with only
     `agent.prompt.inject` granted. Unload the plugin and try the old skill IDs.
  4. Import the skill-only package; ensure a helper `index.js` is not treated
     as an extension. Install a generated two-skill fixture through the real
     Host `plugins.installFromPath`, list it, read its installed manifest and
     skill files, then uninstall it.
  5. Attempt declarations with absolute paths, `..`, missing or unsupported
     files, an internal dependency path, or descendant symbolic links. Exceed
     the 32-skill or 256-directory scan limit and inspect failure cleanup.
- **Expected**: All four declared skills appear with independent stable IDs,
  including the repeated `SKILL.md` basenames, and loading them returns the
  correct body with frontmatter removed. The imported extension remains a
  separate contribution. Resources and their relative paths survive copying;
  npm installation ancestors do not suppress the package, and only dependency
  directory segments within the selection are excluded. Missing skill grants
  leave no skill catalog entries and produce the existing permission audit;
  grants can be restored without changing IDs. Unload removes both catalogs,
  and old skill IDs return `NOT_FOUND`. Skill-only imports declare only
  `agent.prompt.inject`, and Host reports the `skills` capability while
  retaining both skill documents. Invalid declarations fail without importing
  outside data or retaining a partial copied plugin. Nothing automatically
  imports `~/.pi` or runs npm lifecycle scripts; the explicit dependency path
  may run the bounded npm installer described in E2E-PLUGIN-import-extension-installs-dependencies.
- **Specs linked**: `07-plugins/16-trusted-extensions.md` §3.2;
  `07-plugins/02-plugin-manifest-schema.md`; D007
- **Acceptance**: E (tools & permissions), G (plugins), Quality
- **Milestone**: Post-MVP (R7 v1)
- **Status**: Partially automated. `imported-package-skills.test.mjs` covers
  import discovery, resource copying, grants, and invalid-path handling.
  `imported-package-skills-runtime.test.mjs` drives the generated no-op plugin
  through the real plugin host subprocess and verifies catalog/body loading,
  grant removal/restoration, and unload. On 2026-09-13, a separate temporary
  two-skill fixture passed real Host `plugins.installFromPath` → `plugins.list`
  → installed manifest/body reads → `plugins.uninstall`; it reported only
  `agent.prompt.inject` and the `skills` capability. The native picker,
  rendered plugin row, and a provider turn invoking the imported Skill have
  not been executed for this scenario; no full desktop journey is claimed.

## E2E-242: Extension tools and hooks take effect in a turn

- **Preconditions**: An enabled fixture extension that registers tool `fx_add`,
  handles `before_agent_start` by appending a marker to the system prompt,
  `tool_call` by blocking `bash` with a reason, and `tool_result` by
  replacing `fx_add` output.
- **Steps**: 1) Start a turn in Agent mode whose fixture model calls `fx_add`
  then `bash`. 2) Inspect the provider request. 3) Inspect the tool results.
  4) Switch to Plan mode and repeat. 5) Register a second extension declaring
  a tool named `read`.
- **Expected**: The system prompt carries the marker; `fx_add` executes in the
  sidecar with no permission prompt and its result is the replaced value;
  `bash` is blocked with the extension's reason and the block is visible in
  the transcript; an audit line records extension id, tool name, and duration
  and no parameters; in Plan mode `fx_add` follows the non-core mode gate;
  the `read` collision is rejected with a diagnostic and the core tool is
  unchanged.
- **Specs linked**: `07-plugins/16-trusted-extensions.md` §6, §7; ADR 0214
- **Acceptance**: B (agent), Security, Quality
- **Milestone**: Post-MVP (R7 v1)
- **Status**: Partially automated (`pnpm test:e2e:trusted-extensions`); Agent-mode tool dispatch, ToolSearch deferral, hooks, blocking, and result replacement pass, while Plan-mode gating and core-tool collision remain additional validation.

## E2E-HOOKS-prompt-chain: Multiple extensions preserve prompt additions

- **Preconditions**: Two or three enabled fixture extensions append different markers
  using `event.systemPrompt` in `before_agent_start`; the provider is a local
  deterministic HTTP/SSE service.
- **Steps**: Run two turns through the real runtime and inspect both provider
  requests. Exercise multiple handlers, explicit replacements (including an
  empty string), missing/malformed returns, exceptions, timeout/late input
  mutation, and Stop/disposal while a handler waits.
- **Expected**: All markers reach the provider in extension/registration order,
  once per turn. Identical inputs produce identical prompt bytes. Full string
  replacements remain supported. Only timely returned strings enter the chain;
  failed handlers do not discard earlier additions, cancelled turns send no
  request, and the next turn can proceed. Other events retain existing folds.
- **Specs linked**: `07-plugins/16-trusted-extensions.md` §6; ADR 0214; #1023.

## E2E-HOOKS-context-every-request: Context handlers shape every provider request

- **Preconditions**: An enabled fixture extension appends a marker message in
  `context`; the provider is a local deterministic HTTP/SSE service whose first
  reply is a tool call.
- **Steps**: Run two turns through the real runtime: the first turn makes a
  tool call and a follow-up request, the second answers directly. Inspect every
  provider request and the persisted transcript rows.
- **Expected**: `context` fires once per provider request, including the first
  request of each run, and every request carries the marker exactly once. The
  marker never reaches the persisted transcript.
- **Specs linked**: `07-plugins/16-trusted-extensions.md` §6; ADR 0214; #1838.
- **Acceptance**: B (agent), Quality
- **Milestone**: Post-MVP (R7 v1)
- **Status**: Automated by `extensions/prompt-chain.test.ts`,
  `extensions/runner.test.ts`, and `extensions/runtime-lifecycle.test.ts`.
  `pnpm test:e2e:trusted-extensions` additionally checks that two plugin-form
  extensions reach the provider in the desktop's extension ID order.

## E2E-TRUSTED-EXTENSION-custom-agent-stream-and-binding: Plugin-owned agent streams and session binding

- **Preconditions**: An enabled trusted extension calls `registerAgent` with one
  model and a fixture `stream`/`complete` implementation. The fixture provider
  has no Host provider row or Host secret.
- **Steps**: 1) Load the extension and inspect `ctx.modelRegistry` for the
  redacted model. 2) Call `pi.setModel(model)` while idle. 3) Run a turn and
  inspect the callback's model/context/options. 4) Restart or create the next
  turn. 5) Attempt to read Host provider keys/secret refs through the registry.
- **Expected**: `registerAgent` appears in the loaded contract and the model is
  selectable; `setModel` persists only the current session binding under an
  `extension-agent:` provider id; the plugin callback streams the assistant
  response and receives cancellation; the next turn reloads the extension and
  restores the same agent implementation; the registry exposes model metadata
  and auth availability but no Host key, secret ref, OAuth token or arbitrary
  Host headers. `registerProvider` with the same plugin-owned stream shape has
  equivalent behavior.
- **Specs linked**: `07-plugins/16-trusted-extensions.md` §5, §10; ADR 0258;
  D426
- **Acceptance**: B (agent), C (conversation & stream), Security, Quality
- **Milestone**: Post-MVP (R7 v1)
- **Status**: Partially automated (`pnpm test:e2e:trusted-extensions`): the loaded
  contract, both registration forms (`registerAgent` and the `registerProvider`
  alias, in each call form), the custom-agent names on the plugin row, the
  redacted registry, idle `setModel` persistence under the `extension-agent:` id,
  and the next turn restored through the plugin's own transport pass.
  Cancellation through `options.signal`, the `stream`-form callback's
  model/context/options inspection, and cross-session module sharing remain
  additional validation.

## E2E-243: Extension commands and UI prompts round-trip through the renderer

- **Preconditions**: An enabled fixture extension registering command `greet`
  that calls `ui.input`, then `ui.select`, then `ui.confirm`, then
  `ui.notify`, and renames the session.
- **Steps**: 1) Open global search and inspect the Commands section. 2) Run
  `/greet` from the composer. 3) Answer each prompt. 4) Run `/greet` again and
  abort the turn while the input prompt is open. 5) Run `/greet` with no
  active session. 6) Attach a remote controller (fixture) and run `/greet`.
- **Expected**: `greet` is listed after built-in and plugin commands with the
  extension label; each prompt shows the extension label and path; answers
  reach the extension in order; the toast appears; the session is renamed
  and `session_info_changed` fires; the aborted prompt resolves `undefined`
  and the command ends; with no session the entry is disabled with a tooltip;
  under remote control the prompt fails with `UNSUPPORTED` and the command
  reports it.
- **Specs linked**: `07-plugins/16-trusted-extensions.md` §8, §9, §10;
  `07-plugins/09-plugin-command-palette.md`
- **Acceptance**: A (app control), Quality
- **Milestone**: Post-MVP (R7 v1)
- **Status**: Partially automated (`pnpm test:e2e:trusted-extensions`); global/composer command discovery, prompt broker round-trip, abort, session rename, exec, and Host-owned queue pass, while no-session and remote-control cases remain additional validation.

## E2E-TRUSTED-EXTENSION-temporary-session-cwd-is-scratch: Extensions in a temporary session work in its scratch

- **Preconditions**: An enabled fixture extension registering command `where`
  that reports `ctx.cwd`, `ctx.sessionManager.getCwd()`, and the working
  directory of a child started with `pi.exec` without a `cwd` option.
- **Steps**: 1) Start a temporary session (no project) and run `/where`
  before any tool call. 2) Run `/where` in a project session.
- **Expected**: In the temporary session all three values are the session's
  `scratch/<sessionId>` directory, which exists and the child starts in; none
  is the sidecar's process directory. In the project session all three are
  the project root, and no scratch directory is created for the extension.
- **Specs linked**: `07-plugins/16-trusted-extensions.md` §7; D114
- **Acceptance**: A (app control), Quality
- **Milestone**: Post-MVP (R7 v1)
- **Status**: Unit-covered (`packages/agent-runtime/src/extensions/runtime-lifecycle.test.ts`); Electron journey Documented

## E2E-244: Unsupported APIs, load errors, and handler timeouts degrade to diagnostics

- **Preconditions**: Four enabled fixture extensions: one importing
  `@earendil-works/pi-tui` at top level and calling `ui.setWidget`; one importing
  an unsupported named export from `@earendil-works/pi-coding-agent`; one whose
  module throws at load; one whose `context` handler never resolves.
- **Steps**: 1) Start a turn. 2) Open the diagnostics drawer for each entry.
  3) Confirm the unsupported export stays undefined. 4) Wait past the 30 s
  handler limit. 5) Disable the throwing extension and start another turn.
- **Expected**: The pi-tui import succeeds, `setWidget` returns an inert
  `dispose`, and one diagnostic per member is recorded; the throwing
  coding-agent export stays unavailable and reports `unsupported_api`; the
  throwing extension shows `error` with message and stack, the composer shows a
  one-line notice, and the other extensions still load; the stalled handler
  is abandoned after 30 s with a diagnostic and the turn completes with the
  unmodified context; after disabling, the notice disappears at the next turn
  boundary and no running turn was interrupted.
- **Specs linked**: `07-plugins/16-trusted-extensions.md` §4.2, §4.4, §5, §6
- **Acceptance**: Quality
- **Milestone**: Post-MVP (R7 v1)
- **Status**: Partially automated (`pnpm test:e2e:trusted-extensions`); missing static named exports are covered through the real Jiti loader by `runner.test.ts`, while diagnostics-drawer rendering for that import, the stalled-handler timeout, and disable-at-boundary journey remain additional validation.

## E2E-245: The packaged sidecar loads a TypeScript extension through jiti

- **Preconditions**: A packaged build of the desktop app; a fixture
  `~/.pi/agent/extensions/typed.ts` that uses TypeScript syntax, imports
  `@earendil-works/pi-coding-agent` and `typebox`, and registers a tool.
- **Steps**: 1) Launch the packaged app. 2) Enable `typed.ts`. 3) Start a
  turn whose fixture model calls the tool. 4) Inspect the sidecar bundle
  manifest for the three pi package versions.
- **Expected**: The extension loads without a transpile or resolution error;
  the aliased imports resolve to the sidecar's copies; the tool executes;
  the three pi package versions are identical and the CI version-lock check
  passes.
- **Specs linked**: `07-plugins/16-trusted-extensions.md` §4.2, §13; ADR 0214
- **Acceptance**: Quality, Release
- **Milestone**: Post-MVP (R7 v1, delivered first as the bundling spike)
- **Status**: Unit-covered by `packages/agent-runtime/src/extensions/bundle.test.ts`: an esbuild bundle run from a temp directory, plus a kernel-loader case that loads a `typebox`-importing extension through `@earendil-works/pi-coding-agent`'s own loader from a bundle with no `node_modules` above it; the packaged-app jiti journey remains Draft and is not faked by the headless runner.
## E2E-PLUGIN-import-extension-installs-dependencies: Importing an extension with npm dependencies installs them before first load

- **Preconditions**: A local pi extension package with `package.json`, `pi.extensions`,
  a pinned pure-JavaScript `is-number@7.0.0` dependency, a `workspaces` field, and
  no `node_modules`; the built workspace packages and npm are available.
- **Steps**: 1) Generate the imported plugin from the local directory. 2) Run the
  real bounded installer. 3) Inspect the copied package, lockfile, installed module,
  lifecycle marker, and trusted-extension load report.
- **Expected**: The plugin root holds the copied `package.json` with `workspaces`
  stripped. The installer runs the two registry-only, `--ignore-scripts` npm steps;
  every lockfile `resolved` URL is registry-only, `node_modules/is-number` exists,
  no lifecycle marker is written, and the trusted-extension runner reports `loaded`
  with the dependency-backed command registered.
- **Specs linked**: `07-plugins/16-trusted-extensions.md` §3.2, §10.2; ADR 0244
- **Acceptance**: Security, Quality
- **Milestone**: Post-MVP (R7 v1)
- **Status**: Automated by `pnpm test:e2e:plugin-import-deps` for the deterministic
  installer boundary; the full picker/renderer/turn journey remains a separate
  validation surface.

## E2E-PLUGIN-import-extension-reports-missing-dependency: A failed dependency install or unloadable dependency is surfaced, never silent

- **Preconditions**: Three local pi extension packages whose `package.json`
  dependencies use unsupported `file:`, git, and HTTP tarball sources; none has
  `node_modules` or a lockfile.
- **Steps**: 1) Generate each imported plugin. 2) Invoke the real dependency
  installer. 3) Inspect the returned error and the generated plugin directory.
- **Expected**: Each failure is explicit and occurs before npm starts; the imported
  plugin and manifest remain registered, while no loadable `node_modules` or generated
  lockfile remains. The renderer toast/load-error journey is covered separately.
- **Specs linked**: `07-plugins/16-trusted-extensions.md` §3.2, §4.4, §10.2; ADR 0244
- **Acceptance**: Security, Quality
- **Milestone**: Post-MVP (R7 v1)
- **Status**: Automated by `pnpm test:e2e:plugin-import-deps` for the deterministic
  registry-source rejection boundary; renderer warning-toast and `load_error`
  behavior remains a separate validation surface.

## E2E-PLUGIN-import-extension-recovers-missing-npm: Choose a trusted npm installation and resume the same import

- **Preconditions**: A desktop build with an isolated data directory; npm/Node.js
  unavailable on its inherited `PATH`; a local extension declaring a pinned
  registry dependency and an install-script marker; a trusted Node.js/npm
  installation outside `PATH` (on macOS, include a hidden `~/.nvm` directory).
- **Steps**: 1) Import the package through Plugins and accept the trust confirm.
  2) In the native missing-npm message choose "Choose npm". Select an invalid
  executable, then an npm without usable Node.js; choose again after each warning.
  3) Select working npm alongside `node`. Inspect the resulting plugin and saved
  path. 4) Restart the app and import another package; then remove or move the
  saved executable and repeat. 5) Repeat with Cancel in the message box, picker,
  and invalid-selection warning. 6) Make saving the path fail while keeping the
  plugin destination writable and retry with a valid selection. 7) With working
  npm, force an ordinary registry/network failure. Repeat dialog checks in all
  eight shipped locales.
- **Expected**: Only structured npm/Node unavailability prompts for a path.
  Native copy explains trusted Node.js, installing Node.js if absent, and remembering
  the selection; hidden directories are visible. Invalid selections are rejected
  by bounded version checks and never saved; choose-again/cancel stays available.
  A valid choice resumes installation in the original generated directory with
  the original plugin id and writes `<dataDir>/npm-path.json` atomically. Restart
  reuses the validated path without prompting; a stale saved path prompts again.
  Save failure warns but the current install still uses the valid choice. Every
  completion, cancellation, and dependency error loads/registers that generated
  plugin exactly once without recopying it; dependency failures remain visible.
  Network/registry failures never open the npm picker. Only the install child
  gains the selected directory in `PATH`; shell probing, global environment
  changes, credential inheritance, and lifecycle marker execution do not occur.
  The registry-only proxy and two-step dependency validation remain enforced.
  Dialogs use localized standalone bodies and existing localized Cancel, with
  dynamic diagnostics appended on a new line.
- **Specs linked**: `07-plugins/16-trusted-extensions.md` §3.2; ADR 0244
- **Acceptance**: F, G, Security, Quality
- **Milestone**: Post-MVP (R7 v1)
- **Status**: Automated at the native-dialog I/O boundary by
  `pnpm test:e2e:plugin-import-deps`: the real import handler and npm installer
  recover from an empty PATH, keep registry-only resolution and disabled scripts,
  persist the selected path, and register the same plugin once. The desktop
  `npm-install-recovery.test.mjs` suite covers cancellation, invalid/stale paths,
  preference reload, save failure, localization, and ordinary network errors.
  Physical native-picker interaction (including macOS symlink selection), full
  desktop restart, and visual checks in every locale remain manual/not run.

---

## E2E-233: Icon-only actions explain their purpose in the active language

- **Preconditions**: The desktop app is running with a project, a chat error,
  toast, update notice, dialog, sidebar row, pull request, and work-panel file
  available as applicable; the UI language can be changed between English and
  Simplified Chinese.
- **Steps**: 1) Hover each icon-only action in the error, toast/update,
  dialog, capability search, sidebar, pull-request, and file-viewer surfaces.
  2) Focus the same controls with the keyboard. 3) Repeat after switching the
  UI language to Simplified Chinese.
- **Expected**: Each control exposes a localized action purpose on hover and
  focus, has the same localized accessible name, and does not expose a raw icon
  name or URL as its action label. Decorative icons remain silent to assistive
  technology. English and Simplified Chinese show different catalog values.
- **Specs linked**: `04-ux/08-component-spec.md`,
  `04-ux/09-interaction-patterns.md`
- **Acceptance**: Accessibility, Quality
- **Milestone**: M6+
- **Status**: Source-contract covered; desktop hover/focus automation pending

## E2E-254: A skill loads on the first Agent turn

- **Preconditions**: At least one Skill is active for the current project, a
  provider is configured, and the session runs in Agent mode with another
  on-demand capability present (for example `BrowserPreview` or a plugin tool).
- **Steps**:
  1. Open a new Agent conversation and send a prompt that matches the active
     Skill's description.
  2. Inspect the first provider request and its tool list.
  3. Confirm the model calls `Skill` with the exact id without calling
     `ToolSearch` first, and that the returned document is the skill body.
  4. Select a Skill and send `/skill:<skill-id>` from the composer; inspect the
     following turn and confirm the original Skill id reaches the tool.
  4a. Add a second active Skill with `/` after the first token, submit the
      prompt, switch away from the session, and reopen it.
  5. Switch the session to Plan mode and inspect the tool list again.
  6. Disable or remove every Skill and start another Agent turn.
- **Expected**: Whenever the skill catalog is non-empty, `Skill` ships with the
  first request and never appears under `# On-demand tools`, so both a matching
  task and a `/skill:<skill-id>` invocation load the body without a discovery round
  trip. Both explicit Skills load in their selected order; after reopening,
  each remains a separate transcript chip beside the user's prompt text.
  An unprefixed name that matches a Skill remains an ordinary command or
  template, not a Skill alias.
  `ToolSearch` still exists for the other on-demand capabilities and
  never returns `Skill`. Plan mode omits the tool and the `# Skills` section,
  and an empty catalog registers no `Skill` tool at all.
- **Specs linked**: `03-runtime/02-agent-runtime.md` (§7.1),
  `03-runtime/03-tools-and-permissions.md` (§2.1),
  `04-ux/04-builtin-commands.md` (§8), `08-meta/decisions-log.md` (D404),
  ADR 0048, ADR 0219, ADR 0230
- **Acceptance**: C (conversation & stream), E (tools & permissions), Quality
- **Milestone**: M5
- **Status**: Unit-covered (`packages/agent-runtime/src/runtime.test.ts`);
  rendered desktop journey Draft
  (run only in a capable environment when this surface changes)

## E2E-SKILL-builtin-activation: Manage bundled skills from Settings

- **Preconditions**: An isolated Desktop profile and an ordinary project
  workspace. Keep a separate active user or plugin Skill so the `Skill` tool
  remains available after imagegen is disabled.
- **Steps**:
  1. Open Settings > Agent > Skills and inspect the Built-in skills group.
     Confirm `pi-desktop/imagegen` and `pi-desktop/plugin-development` are
     listed and enabled by default.
  2. Turn off `pi-desktop/imagegen` and open a new session in the ordinary
     workspace. Inspect its skill catalog and Composer's `/` menu.
  3. Invoke the local `Skill` tool with the stale imagegen id.
  4. Turn imagegen back on and open another session. Restart the app and
     inspect the setting and a new session catalog again.
- **Expected**: The disabled imagegen skill is absent from the prompt catalog
  and the `skill:pi-desktop/imagegen` slash entry. A stale direct `Skill` load
  reports that the built-in skill is disabled. Re-enabling restores both
  entries on a new session, and the setting survives restart. The
  plugin-development row stays visible in Settings but its session entry
  remains limited to plugin workspaces. Associated agent tools remain
  independently available.
- **Specs linked**: `07-plugins/01-plugin-system.md` (§12.3),
  `03-runtime/01-ipc-protocol.md` (§12b), `03-runtime/02-agent-runtime.md`
  (§7.0.0), `04-ux/04-builtin-commands.md` (§8)
- **Acceptance**: C (conversation & stream), E (tools & permissions),
  F (persistence), Quality
- **Coverage**: `settings-inline-import-user-path.test.mjs` exercises the
  Settings switch in isolated Electron and asserts the persisted IPC request
  and visible off state. `image-generation.test.mjs`,
  `composer-mcp.test.mjs`, host-core user-skill/RPC tests cover catalog
  filtering, stale loads, persistence, and the activation wire contract. The
  restart and full new-session journey remain part of desktop acceptance.
- **Milestone**: M6+
- **Status**: Rendered desktop journey Draft

## E2E-255: An ideographic comma opens the slash menu

- **Preconditions**: A Chinese IME is available, the composer draft is empty,
  and at least one slash entry exists (builtin alias, template, plugin command,
  or Skill).
- **Steps**:
  1. With the draft empty, compose `、`, inspect the pre-edit text, then commit.
  2. Continue typing a command name and accept the highlighted row.
  3. Type a draft that contains `、` between other characters.
  4. Send a draft whose first character was typed as `、` without accepting any
     row.
  5. Cancel a composition, then type `/` again. Also delete text after a
     dropped `compositionend` and confirm the slash menu still reopens.
- **Expected**: The committed `、` is rewritten to `/` in place, the ordinary
  slash menu opens with the same filtering and keyboard behavior as a typed
  `/`, and the caret stays after the substituted character. A `、` anywhere
  later in the draft stays untouched text, and the `@` file menu never reacts
  to the mark. Pre-edit `、` remains unchanged until commit; the result is `/`,
  never `/、`. Ordinary Chinese composition and punctuation in existing drafts
  remain unchanged. Cancelling leaves a blank draft, and replacing the draft
  releases the old composition's empty-draft origin.
- **Specs linked**: `04-ux/04-builtin-commands.md` (§9),
  `04-ux/08-component-spec.md` (§11), `08-meta/decisions-log.md` (D405),
  ADR 0024, ADR 0231
- **Acceptance**: C (conversation & stream), Localization, Quality
- **Milestone**: M2
- **Status**: Partially automated. Unit coverage:
  `packages/shared/src/composer-trigger.test.ts`,
  `apps/desktop/test/composer-ime.test.mjs`. Rendered Electron coverage:
  `node scripts/e2e-composer-ime-stack.mjs` mounts the production input, draft,
  and completion components, drives Chromium composition through CDP, and
  covers alias commit, ordinary Chinese text, cancellation, draft replacement,
  completion acceptance, and lost-end recovery. Sending and a physical OS IME
  candidate window remain manual checks.

## E2E-CLONE-accepts-a-lan-remote-and-rejects-metadata

- **Preconditions**: The home project switcher Clone git project action is available.
- **Steps**: 1) Enter `https://192.168.1.5/org/repo.git`, `http://10.0.0.7/org/repo.git`, and `git@192.168.1.5:org/repo.git`. 2) Enter `https://169.254.169.254/org/repo.git` and `https://metadata.google.internal/org/repo.git`. 3) Enter `https://github.com/org/repo.git` and `git@github.com:org/repo.git`.
- **Expected**: A LAN or loopback remote the user typed is accepted and parses to a folder name, because the remote is the user's own address. Cloud metadata hosts stay rejected, as do `file:` and password-bearing URLs, before `git clone` runs. Public GitHub HTTPS and SSH remotes still parse.
- **Specs linked**: `04-ux/01-ui-ia.md`, ADR 0247, ADR 0304, D416
- **Acceptance**: Security, D (workspace)
- **Milestone**: M5
- **Status**: Unit-covered (`apps/desktop/test/git-clone.test.mjs`)

## E2E-257: Plugin session import into an archived project restores its visibility

- **Preconditions**: A durable project has been archived in the renderer
  sidebar preferences and is hidden from the default sidebar. A test plugin
  can import a new session with an explicit host project id.
- **Steps**:
  1. Open Settings → Project archive and confirm the archived project remains
     available there while the default sidebar omits it.
-  2. Use the plugin's `session.importBatch` with the existing project's id
     and wait for the host session refresh event.
-  3. Confirm the project and its newly imported session appear in the default
     sidebar, then archive the project again.
-  4. Refresh sessions without importing anything, then use
     `session.importBatch` for a pathless session and for a duplicate or
     skipped session.
- **Expected**: A successful plugin import that adds a project-bound session
  clears the archived presentation state for that exact normalized project
  path and makes the project/session discoverable. Ordinary refreshes,
  pathless sessions, skipped imports, and repeated imports leave archive state
  unchanged; no host project row or transcript is deleted or recreated.
- **Specs linked**: `04-ux/06-settings-ia.md`, `04-ux/08-component-spec.md`,
  `03-runtime/04-data-storage.md`, ADR 0236, D407
- **Acceptance**: C (conversation & stream), F (persistence), G (plugins),
  Quality
- **Milestone**: M6+
- **Status**: Unit/source-contract covered (`sidebar-session-groups.test.mjs`,
  `project-import-archive.test.mjs`, `plugin-session-refresh.test.mjs`);
  rendered desktop journey Draft (run only in a capable environment when this
  surface changes)

## E2E-IMPORT-codex-scan-filters-synthetic-titles

- **Preconditions**: A Codex archive whose sessions open with synthetic
  injections (`# Context from my IDE setup:`, `# In app browser:`,
  `# Browser comments:`, `# Files mentioned by the user:`,
  `# Diff comments:`, `# Selected text:`, `# Review findings:`,
  `# AGENTS.md`, `You are Codex`, `<environment>`) and at least one session
  whose stored timestamps are corrupt or out of range.
- **Steps**:
  1. Run `node --test test/importer-codex-scan.test.mjs` from `apps/desktop`.
  2. Confirm test coverage for synthetic title filtering and timestamp fallback.
  3. Confirm an archive above the file cap reports truncation metadata and
     includes only the newest 250 files.
- **Expected**: Candidate titles come from the first real user message —
  synthetic injections never surface as titles, while genuinely pasted
  markdown that starts with `#` (for example `# Role: …`) is kept. Sessions
  whose user messages are all synthetic do not appear as candidates. A
  corrupt or out-of-range stored timestamp falls back to the source file's
  mtime, never to the import moment. An archive above 250 session files returns
  the newest 250 by folder date plus truncated-count metadata; Settings no
  longer renders the retired session-import cap note.
- **Specs linked**: `03-runtime/01-ipc-protocol.md`,
  D320
- **Acceptance**: C (conversation & stream), F (persistence), Quality
- **Milestone**: M6+
- **Status**: Unit-covered (`importer-codex-scan.test.mjs`); no Settings UI journey

## MCP market scenarios (`pnpm test:e2e:mcp-market`, headless protocol-level)

| ID | Scenario | Verification |
|---|---|---|
| E2E-MCP-MARKET-NET-BOUNDARY | The URL guard rejects credentials, cloud metadata, unspecified, multicast and reserved forms (trailing dot included) even when the user typed them, and rejects loopback, private, special-use IPv4, v4-mapped, ULA, site-local and link-local forms for *third-party* hops — a redirect target or a catalog body; the same forms typed by the user into a source field are accepted, with plain `http` behind `networkPolicy.allowInsecureUserEndpoints`; direct/unknown routes pin the checked address by default, while a fully proxied route uses the session transport and an explicit `allowFakeIp` opt-in can cover transparent-router fake-IP sources without allowing real private answers | deterministic guard assertions; source-contract coverage for DNS pin, proxy route selection, explicit fake-IP scope and bounded responses |
| E2E-MCP-MARKET-SEMANTICS | Registry records map to install templates preserving package versions, named/positional runtime/package arguments and required/optional env variables; a remote header variable is recognized in both the registry's `{name}` and the catalog's `${NAME}` spelling, prompts for declared editable values, preserves unbound brace literals, and resolves header-local defaults, fixed values, and optional flags without merging same-named inputs across headers (ADR registry-header-variable-spelling) | deterministic mapping assertions |
| E2E-MCP-MARKET-INSTALL | Builtin catalog entry resolves through `resolveCatalogEntry` and installs via the host `mcp.upsert` RPC; record lands in `~/.agents/servers/` | real host binary, isolated temp HOME |
| E2E-MCP-MARKET-explicit-project-owner | Select Project on the MCP page, open Market, and install a builtin entry; the upsert carries the selected project and the saved row appears in that project. All and Global retain global installation, and an entry in another level does not block installation | real React page and market in isolated Electron; IPC boundary fixture (`apps/desktop/test/mcp-market-owner-user-path.test.mjs`) |
| E2E-MCP-MARKET-HEADER-SCOPE | Registry header-local `{token}` resolves only in its header; same-named URL path/query tokens remain literal through mapping, resolution, host upsert/list and persistence. URL templates retain only legacy `${NAME}` substitution. When `headerBindings` exists (even empty or partial), unbound tokens in every header stay literal and never consume another header's input or default | shared regressions plus real host binary with isolated temporary storage; remote entry disabled, no network call |
| E2E-MCP-MARKET-partial-header-bindings-stay-literal | Resolve a catalog with only Authorization bound and another header using the same `{token}` / `${token}`; an undeclared `${UNBOUND}` in a third header also remains literal through host upsert/list and disk persistence | real host binary, disabled remote entry, synthetic input and isolated temporary storage; no network call |
| E2E-MARKET-CATALOG-RETRY | In Skill Market and MCP Market, a failed query and then a partial source failure expose Retry; clicking it announces loading, refreshes the same query, and clears the failure when the source recovers | real React components in Electron with deterministic mocked market API responses; no live network |

## E2E-MCP-MARKET-explicit-project-owner: Market installation respects an explicit Project filter

- **Preconditions**: MCP settings with a selected project; isolated Electron
  profile and deterministic IPC responses, without live market or MCP calls.
- **Steps**: Select Project, open Market, install a builtin entry, and reopen
  Market. Repeat with All and Global, with no project under All, and with the
  same entry already present in the other level. Select Project with no
  project, then try an install directly through the panel's public interface.
- **Expected**: Project sends `level: "project"` and the selected `projectPath`;
  All and Global send `level: "global"` without a project owner. The installed
  row appears on return, and reopening Market marks it installed only for the
  target level. A record in another level never blocks installation. With no
  project selected, the Project market action is disabled and the panel guard
  reports the missing selection without writing.
- **Specs linked**: `04-ux/06-settings-ia.md`, ADR 0112.
- **Acceptance**: Quality.
- **Milestone**: M6+.
- **Status**: Automated (`node --test apps/desktop/test/mcp-market-owner-user-path.test.mjs`).

## E2E-SKILL-MARKET-NET-BOUNDARY: A user-supplied source reaches the LAN, third-party content does not

- **Preconditions**: Shared public-network helpers and the main-process
  public-HTTPS client with injectable fetch/DNS/route.
- **Steps**: 1) Classify trailing-dot localhost, IPv4 loopback, IPv4-mapped
  IPv6, ULA, link-local, RFC1918, and `http://` URLs twice: once as a source URL
  the user typed, once as a document URL that arrived inside a catalog. 2)
  Resolve a public hostname to a private A record. 3) Follow a 302 whose Location
  is `https://127.0.0.1/`. 4) Report a proxied route and a TUN fake-IP answer
  (`198.18.0.1`), the same answer on a `DIRECT` route, on an unreadable route,
  and on a route list that offers `DIRECT`. 5) Let a first hop be proxied and
  its redirect target direct. 6) On a direct route, return both a public address
  and a ULA address, then return a TUN `benchmark` fake-IP with a ULA address
  under the existing fake-IP opt-in. 7) Return a ULA address without any
  acceptable companion address.
- **Expected**: A source URL the user typed may be a loopback or LAN catalog —
  `https` always, `http` only under
  `networkPolicy.allowInsecureUserEndpoints` — while the same address as a
  *document* URL inside a catalog, or as a redirect target, is rejected. Cloud
  metadata, `unspecified`, multicast, and reserved addresses are rejected on
  every input. A user-supplied source resolving to a private address is fetched;
  a third-party hop resolving only to a private address throws a policy error
  without fetching that target. A local resolver with no answer is retried and
  reported as `NETWORK_RESOLVE_FAILED` (`kind` `unresolved`), not as an
  address-check refusal. A direct request with an acceptable address beside a
  rejected ULA pins the acceptable address; a ULA-only answer stays refused. An
  address in a proxy's fake-IP range (`198.18.0.0/15`, Clash's default) is
  accepted on a proxied route. On a direct route it is refused unless the
  existing fake-IP opt-in allows Main to pin that benchmark address; unreadable
  routes remain strict. A refusal for a benchmark address is reported as `kind`
  `fake-ip`, `addressKind` `benchmark`, and `reason` `non-public-address`;
  refusals for real private targets remain `kind` `policy`, `addressKind`
  `private`. Every refusal carries the host, reason, address class, and route so
  the install sheet and market list can distinguish policy blocks from network
  failures. Every redirect hop is judged on its own route (ADR 0272, ADR 0321).
- **Specs linked**: `05-security/01-security.md`, ADR 0243, ADR 0272, ADR 0321,
  `03-runtime/01-ipc-protocol.md` §12b
- **Acceptance**: Security, Quality
- **Milestone**: M6+
- **Status**: Automated (`pnpm test:e2e:skill-market`,
  `apps/desktop/test/public-https-fetch.test.mjs`,
  `apps/desktop/test/public-https-fetch-route.test.mjs`,
  `apps/desktop/test/skill-market-scan.test.mjs`,
  `apps/desktop/test/skill-market-failure.test.mjs`,
  `apps/desktop/test/skill-market-policy-refusal.test.mjs`,
  `packages/shared/src/public-network.test.ts`)

## E2E-MARKET-CATALOG-RETRY: Retry a failed or partially available market query

- **Preconditions**: Rendered Skill Market and MCP Market panels with the
  market APIs stubbed at the IPC boundary. Each API returns a total failure,
  then a result with one failed source, then a complete result. A second run
  loads a result first, fails afterwards, and recovers on retry; a third run
  changes the query after a success so the failure carries a snapshot taken
  for another query; a fourth run fails with nothing loaded.
- **Steps**: Open each market; click Retry after the total failure; confirm the
  loading announcement and recovered entry; click Retry again after the
  partial failure. Then load a list, fail the next query, retry, and change
  the query before failing once more.
- **Expected**: Both markets repeat the current search, show loading while the
  request runs, retain a Retry action for partial failures, and clear the failed
  source after recovery. After a successful load, a later failure keeps that
  list on screen, says when it was taken, retains each remote source badge,
  and still offers Retry; the retained list disappears once a retry succeeds,
  and it never stands in for a different query or for a failure with nothing
  loaded. The test makes no live network request and does not change the
  main-process network policy.
- **Specs linked**: `04-ux/06-settings-ia.md`, ADR 0177, ADR 0272
- **Acceptance**: Quality
- **Milestone**: M6+
- **Status**: Automated (`pnpm test:e2e:market-retry`,
  `apps/desktop/test/skill-market-panel.test.mjs`,
  `apps/desktop/test/mcp-market-panel.test.mjs`)

## E2E-SKILL-MARKET-EXPANSION: Adjacent markdown resources inline before install

- **Preconditions**: A jsDelivr skill document whose directory lists FORMS.md
  and REFERENCE.md (mocked listing in unit tests; expansion helper in E2E).
- **Steps**: Split SKILL.md, expand listed sibling markdown files as fenced
  appendices, and confirm a document over 128 KiB is flagged too large.
- **Expected**: The preview/install body contains the skill text plus
  `# Attached resource:` appendices. Non-markdown siblings are omitted. A
  body that would exceed host `MAX_SKILL_BYTES` is not written.
- **Specs linked**: `04-ux/06-settings-ia.md`, ADR 0243
- **Acceptance**: Quality
- **Milestone**: M6+
- **Status**: Automated (`pnpm test:e2e:skill-market`,
  `apps/desktop/test/skill-market-scan.test.mjs`)

## E2E-SKILL-MARKET-INSTALL: Market install writes a user skill through skills.create

- **Preconditions**: Host binary; isolated HOME. A builtin catalog entry with
  an assembled markdown body.
- **Steps**: Handshake; `skills.create` with the assembled name/description/body;
  read `~/.agents/skills/pdf.md`; `skills.list`.
- **Expected**: The file has rendered frontmatter and the instruction body.
  The skill appears in `skills.list`. No path besides `skills.create` is used.
- **Specs linked**: `03-runtime/01-ipc-protocol.md` §12b, ADR 0243
- **Acceptance**: Quality
- **Milestone**: M6+
- **Status**: Automated (`pnpm test:e2e:skill-market`)

## E2E-SKILL-MARKET-ID-ALIGN: Scanned skill ids match host valid_capability_id

- **Preconditions**: Shared `sanitizeSkillCatalogId`.
- **Steps**: Sanitize `Frontend_Design`, `1-pdf`, and an empty remainder.
- **Expected**: Host-legal slugs (`frontend-design`, `1-pdf`, `skill-7`) so
  `installedIds` matches the created record.
- **Specs linked**: `03-runtime/01-ipc-protocol.md` §12b
- **Acceptance**: Quality
- **Milestone**: M6+
- **Status**: Automated (`pnpm test:e2e:skill-market`)

## E2E-PLUGIN-turn-ended-once-per-host-turn: A plugin observes exactly one turn-end event per host turn

- **Preconditions**: A plugin with a tool and an event listener for
  `session:turnEnded` is loaded and enabled; its panel records each received
  payload and the `turnId` its tool receives through the tool context.
- **Steps**:
  1. Submit a prompt whose reply issues three tool calls in one turn.
  2. Record the number of `session:turnEnded` payloads the plugin receives and
     compare the `turnId` with the one the plugin's tool saw.
  3. Submit another prompt, then stop it with `Cmd/Ctrl + .`.
  4. Submit a third prompt that fails, so the turn ends with an error.
  5. Inspect the Plugins settings page for a new permission review.
- **Expected**: Step 2 receives exactly one `session:turnEnded` whose `reason`
  is `completed`, and its `turnId` equals the tool context's `turnId`. Step 3
  receives exactly one event with `reason` `aborted` — never a second
  `completed` after the abort. Step 4 receives exactly one event with `reason`
  `error`. A turn that never started emits nothing, and no plugin receives two
  events for one turn even when the terminal event arrives more than once.
  Step 5 shows no new permission review, and subscribing to an unknown event
  name does not surface an error.
- **Specs linked**: `07-plugins/03-plugin-api.md`, `07-plugins/13-plugin-permissions-matrix.md`,
  ADR 0252
- **Acceptance**: Quality (protocol and plugin contract)
- **Milestone**: M6+
- **Status**: Module-covered (`apps/desktop/test/session-turn-ended.test.mjs`,
  `apps/desktop/test/queued-turn-finalization.test.mjs`); desktop journey Draft
  (run only in a capable environment when this surface changes)

## E2E-SUBAGENT-ordered-model-fallback-preserves-work

- **Preconditions**: A configured primary and at least three alternatives use
  deterministic local transports; one definition declares the ordered
  alternatives. A second definition has no alternatives, and none are opted
  in for Task overrides.
- **Steps**: Add two alternatives in Settings, reorder them, save and reopen;
  change another field without changing the list. Run the child, complete one
  tool call, then fail the primary request. Fail the first alternative and
  complete the second. Run a matrix with zero, one, two, and three unavailable
  models before a successful model, leaving an unused model after success.
  Repeat with all four models unavailable, mixed 401/403/404 failures,
  exhausted transient/429 retries on two consecutive models,
  unavailable/duplicate pins, an explicit authorized Task primary,
  and Stop during recovery. Remove all alternatives, save, and reopen.
- **Expected**: List order and clear/preserve semantics round-trip. Provider
  retry budgets precede fallback; each distinct configured binding is used
  once. The original task and completed tool results reach the next model;
  completed tools are not replayed. Adapter/auth/headers and thinking match
  each selected model. Failure diagnostics and total usage survive settlement;
  effective model/thinking survive reload. Stop cancels the chain; host/tool
  errors do not switch models. Exhaustion fails explicitly. Alternatives never
  authorize a Task override for the second definition. No alternatives retains
  the existing single-model behavior.
- **Specs linked**: `03-runtime/02-agent-runtime.md` §5f,
  `03-runtime/13-model-catalog-and-selection.md` §Subagent editor,
  ADR subagent-model-fallback.
- **Acceptance criterion**: C — Conversation & stream; Quality (compatibility
  and permission isolation).
- **Milestone**: M6+.
- **Status**: Automated registry and runtime coverage through shared/runtime
  regression tests and `test:e2e:subagents` / `test:e2e:subagent-models`. The
  sidecar suite checks the zero-to-three failure matrix and four-model
  exhaustion against actual HTTP request order, live/settled Task metadata,
  ordered failure diagnostics, and the successful child report. Completed-tool
  preservation and independent retry budgets use real-transport runtime tests.
  The configuration-editor journey passed under WSL; task-transcript reload
  acceptance remains outstanding. Required post-integration suites: `test:e2e`,
  `test:e2e:subagents`, `test:e2e:subagent-models`.

## E2E-PLUGIN-provider-catalog-add-service: Select a plugin provider from its custom Add Service category

- **Preconditions**: A loaded plugin has `provider.register` and declares two
  API-key providers with a `baseUrl`, a localized `category`, and a short
  localized `description`; one provider has static models and the other has an
  empty model list. Both Host-owned rows have no saved key. Include another row
  whose key is already configured and a provider contribution from a plugin
  without `provider.register`.
- **Steps**: 1) Open Settings → Models → Add provider. 2) Find the declared
  category and hover or keyboard-focus a provider tile. 3) Select the provider,
  enter a fixture key, and save. 4) Reopen Add provider and search the remaining
  entry by category, provider name, introduction, endpoint, and model ID. 5)
  Change the app language between English and Simplified Chinese and reopen the
  chooser. 6) Load a manifest with malformed localized category/description
  fields, an empty category/description, and values over their length limits.
- **Expected**: Step 1 groups unconfigured API-key contributions under the
  category for the active locale. Tiles show only provider names; hover/focus
  shows the one-sentence introduction, and the tile's accessible description
  remains available to assistive technology. The chooser has no provider-count
  cap and omits configured providers, OAuth / no-auth rows, and contributions
  whose plugin lacks the grant. Step 2 opens the existing Host-owned provider
  key form; the endpoint and plugin remain visible there for a destination
  check. Step 3 saves through the Host provider secret API; only an empty-model
  declaration triggers Host model discovery after save. Discovered models are
  cached for that plugin-owned row. The key is never returned to plugin code or
  included in catalog metadata. The provider row and key remain in the service
  list, and that entry disappears from Add Service while the other unconfigured
  entry remains. Step 4 finds the remaining tile by the listed search fields
  and never offers the saved row. Step 5 switches the declared localized text
  correctly. Step 6 rejects malformed metadata without partially loading the
  plugin. Existing plugin row ids, ownership, reconciliation, and key retention
  remain unchanged.
- **Specs linked**: `07-plugins/02-plugin-manifest-schema.md` §5.4,
  `07-plugins/03-plugin-api.md`, `07-plugins/04-plugin-security.md`,
  `07-plugins/13-plugin-permissions-matrix.md`, `04-ux/06-settings-ia.md`,
  `04-ux/08-component-spec.md`, ADR 0322; D650.
- **Acceptance**: B (model config), E (tools & permissions), F (persistence),
  G (plugins), Security, Quality
- **Milestone**: Post-MVP (R7 v1)
- **Status**: The representative Add Service → category → key save path runs
  in `apps/desktop/test/plugin-provider-catalog-user-path.test.mjs` under an
  isolated Electron renderer with a fake Host IPC boundary. Catalog filtering,
  locale resolution, description tooltip, category validation, filtering, and
  search have focused tests. The user-path test also confirms that model
  discovery follows key save and saving one entry hides only that configured
  row while another entry remains available.

## E2E-PLUGIN-declared-provider-appears-in-the-native-provider-list: Plugin providers use Host-owned rows, permissions, and OAuth sign-in

- **Preconditions**: An installed local plugin declares one API-key provider
  with `provider.register` and one OAuth provider with both `provider.register`
  and `provider.oauth`. Both use a fixture `baseUrl` and one model; the API-key
  model has `thinkingLevels: ["off", "low", "high"]` and
  `defaultThinkingLevel: "high"`. Its `onProviderOAuth` callback uses only a
  local OAuth fixture and host-rendered `pi.providers.oauth` interactions.
- **Steps**: 1) Enable the plugin and open Settings → Providers. 2) Inspect
  the model binding and Composer thinking selector, then select the row as the
  session model and run a turn. 3) Change the session thinking level and run a
  second turn. 4) Try to edit the provider, then delete it, through the user
  path. 5) Open Vendor accounts, sign in to the plugin OAuth provider using its
  host-rendered prompt/device-code step, then select that provider and run a
  turn. 6) Expire the fixture access token and run another turn to exercise the
  plugin refresh callback. 7) Cancel a second login and confirm the callback's
  abort signal fires; sign out and then disable/re-enable the plugin. 8)
  Uninstall the plugin; reinstall and enable it, then remove the declaration
  from its manifest and reload. 9) Load manifests that omit `provider.register`
  or `provider.oauth`, have OAuth metadata without `authKind: "oauth"`, or
  lack the `onProviderOAuth` module export. 10) Load manifests whose model uses a
  non-array `thinkingLevels`, a non-string entry, or a non-string
  `defaultThinkingLevel`.
- **Expected**: Step 1 shows one row in the native provider list with
  `ownerPluginId` set to the plugin and the row id
  `plugin:<pluginId>:<declaredId>`. Its model binding contains the normalized
  levels `off`, `low`, and `high` in declaration order, with `high` as the
  default. Step 2 shows those declared levels in the thinking selector and
  starts the session at `high`; the turn uses that choice. Step 3 persists and
  uses the changed session level without changing the provider declaration.
  Step 4 refuses both actions with an error whose message begins
  `PROVIDER_OWNED_BY_PLUGIN` and leaves the row unchanged. Step 5 completes
  login through the native OAuth dialog and stores one encrypted credential
  under `secret:provider:<plugin-row-id>:oauth`; the renderer sees only status
  and the non-secret account label. Step 6 invokes the refresh callback with
  the plugin's own credential, but only the new access token reaches the Agent
  Runtime; refresh tokens stay in Electron main and the Host secret store. Step
  7 stops the callback on cancellation, clears the OAuth secret on sign-out,
  keeps both manifest-owned rows across disable/enable, and restores sign-in
  status only for credentials that remain stored. Step 8 removes both rows and
  their credential refs when uninstalled or undeclared. Step 9 fails closed:
  missing permissions fail manifest validation, and a missing callback fails
  plugin load without exposing a sign-in action. Step 10 rejects malformed
  thinking-level fields with `PLUGIN_INVALID` and leaves enablement unchanged.
- **Specs linked**: `07-plugins/02-plugin-manifest-schema.md` §4, §5.4, §7;
  `07-plugins/03-plugin-api.md` (provider OAuth); `07-plugins/04-plugin-security.md`;
  `07-plugins/13-plugin-permissions-matrix.md`; `03-runtime/04-data-storage.md`
  §4.3, §7; `03-runtime/11-provider-model-system.md` §6.2;
  `03-runtime/12-provider-config-schema.md` §2, §9;
  `03-runtime/06-host-rpc-protocol.md`; ADR 0259; D427
- **Acceptance**: B (model config), E (tools & permissions), F (persistence),
  G (plugins), Security, Quality
- **Milestone**: Post-MVP (R7 v1)
- **Status**: Runs in the Linux CI integration candidate through
  `pnpm test:e2e:trusted-extensions` under Xvfb, using local
  synthetic OAuth credentials: the API-key and OAuth declared rows, permission
  projection, Settings sign-in picker, Host-rendered device-code and secret
  prompt, encrypted-credential handoff, refresh, model request auth,
  cancellation, and sign-out are exercised through the real Electron renderer
  and plugin process. Ownership refusal, disable/enable, cleanup, and malformed
  manifest cases remain covered by host-core checks. No live identity provider
  is used.

## E2E-PLUGIN-fs-root-follows-the-calling-session: A plugin tool's fs root follows its own session, not the visible workspace

- **Preconditions**: Two projects, A and B, each holding a text file the other
  does not, and one enabled plugin that registers an agent tool whose execute
  calls `pi.fs.readText` and `pi.fs.glob` on a root-relative path and declares
  `fs.read` with the `workspace` root. Both projects have a live session with the
  plugin tool available, and the window shows project A.
- **Steps**:
  1. Invoke the tool from session A on the file only project A holds, then from
     session B (project B) on the file only project B holds, without switching
     the window's visible workspace.
  2. Switch the visible workspace to project B and repeat both calls.
  3. With the visible workspace on project B, ask session A's tool for a path
     that exists only under project A, and session B's tool for the same path.
  4. Open the plugin's panel and call the same read over the panel bridge with
     project A visible, then with project B visible.
  5. Move one session to a temporary chat so no workspace is visible, invoke the
     tool from that session, then call the panel bridge in the same state.
- **Expected**: Steps 1 and 2 answer from the invoking session's own project every
  time: session A reads and globs project A's file, session B project B's file,
  and neither answer changes when the visible workspace moves between the two
  projects. Step 3 returns project A's file for session A and `NOT_FOUND` for
  session B, so a session can never reach the other project's root. Step 4 is
  unchanged from before: each panel call resolves the visible workspace, so its
  answer follows the project on screen rather than either session. Step 5 keeps
  working per session -- the session's plugin tool resolves its own project -- and
  the panel call still fails with `NOT_FOUND` ("No workspace is open"). No gate
  is relaxed anywhere: a denied name, a `..` or absolute path, a symlink out of
  the root, and a path outside the declared scope behave as they do for a single
  visible workspace.
- **Specs linked**: `07-plugins/03-plugin-api.md` §3,
  `07-plugins/13-plugin-permissions-matrix.md` §6, ADR 0016, ADR 0249, ADR 0266,
  D093
- **Acceptance**: G (plugins), Security, Quality
- **Milestone**: M6+
- **Status**: Partially automated
  (`apps/desktop/test/plugin-fs-session-root.test.mjs`): a tool call writes and
  reads under the project of the invoking session, a panel call and an untracked
  session fall back to the visible workspace, a `userSelected` mode keeps the
  picked directory, and a session root stands in when the window shows no
  project. The two-live-sessions desktop journey and the panel step are Draft
  (run only in a capable environment when this surface changes)

### Workspace discovery consistency and project-isolated queues

- Run `node --experimental-strip-types --test
  apps/desktop/test/plugin-workspace-session.test.mjs` on Node 22, together with
  the existing session-root, invocation, filesystem-scope and workspace-root
  suites. The real plugin child process checks concurrent A/B workspace
  discovery against actual marker reads, foreground switching, no visible
  workspace, legacy provider mismatch, remote identity, and absolute reveal
  limited to the caller's registered roots. Only the OS reveal boundary is stubbed.
- A companion knowledge-plugin process test runs the real PluginRuntime, actual
  plugin entry point, project queues and temporary files. Hold A's read at an
  explicit RPC gate; B must save before A is released. A second caller in A
  queues behind A and must retain its own invocation after the first finishes.
  Switch or clear the visible project, reject an A invocation targeting B,
  cancel A while B searches, and verify both original bodies and B's saved
  revision. No live provider, installed user instance or `verify:ui:*` is used.
- The full two-live-session shell journey remains separate; the child-process
  tests establish the actual host/plugin/filesystem boundary without requiring
  a foreground Electron app or changing permission semantics.

## E2E-PLUGIN-official-channel-resolves-through-the-platform: An official-channel install uses platform mirrors when resolve answers promptly

- **Preconditions**: A clean profile on the official channel, a plugin present in `plugins.aiuo.net/catalog.json`, and a request log for the platform and both mirror hosts (a local stub may stand in for each).
- **Steps**: 1) Open Extensions → Marketplace and confirm the catalog loads. 2) Capture the catalog request and verify it used `plugins.aiuo.net`. 3) Install the plugin. 4) Capture the request the platform received. 5) Inspect which mirror served the package. 6) Install a second plugin, then install the same version of the first one again.
- **Expected**: The marketplace UI has no source selector; exactly one `POST /api/v1/download/resolve` is sent per install or update, with a JSON body carrying `deviceId`, `pluginId`, and the version when one was picked; when resolve answers within three seconds, the package comes from the first entry in `downloads` that answers, and its bytes match the returned `sha256` and `sizeBytes` before anything is extracted; a mirror that is unreachable or fails is abandoned and the next one is used without user interaction; if resolve exceeds its deadline, the install switches to the catalog URL and verifies its catalog digest; reinstalling the same version issues a fresh resolve call rather than reusing the earlier answer, because the response is never cached; the installed plugin passes the ordinary permission review and its record names the official channel as its provider.
- **Specs linked**: `07-plugins/07-plugin-marketplace.md` §2, `07-plugins/15-plugin-center.md` §10
- **Acceptance**: G (remote marketplace source)
- **Milestone**: M6+
- **Status**: Draft

## E2E-PLUGIN-mirror-digest-mismatch-falls-through-to-the-next-mirror: A mirror whose bytes fail the digest is rejected before extraction

- **Preconditions**: An official-channel install whose `downloads` list has at least two entries, with the first mirror serving bytes that do not match the returned `sha256` (a stale distribution, or a stub that serves the CNB-era bytes for `pi.todo-0.6.5`), plus a view of the install cache and the plugin directory.
- **Steps**: 1) Start the install. 2) Watch the first mirror's download and the digest check. 3) Inspect the install cache and the plugin directory before the install finishes. 4) Let the install continue. 5) Repeat with a stub whose first mirror fails only the announced `sizeBytes`.
- **Expected**: The mismatching bytes are discarded without being extracted or handed to the installer, nothing lands in the plugin directory, and the rejection is reported in the install progress instead of being swallowed; the next mirror's bytes are verified against the same digest and the install completes from there; the size-mismatch case behaves identically; when every returned mirror fails digest or size validation, the install ends as a reported failure rather than falling back to different bytes or leaving a partial plugin.
- **Specs linked**: `07-plugins/07-plugin-marketplace.md` §2
- **Acceptance**: G (remote marketplace source) + Security
- **Milestone**: M6+
- **Status**: Draft

## E2E-PLUGIN-platform-unreachable-install-falls-back-to-the-catalog-url: A slow or unavailable platform resolve falls back quickly to the catalog URL

- **Preconditions**: The official catalog has been refreshed. A local stub can delay `POST /api/v1/download/resolve` beyond three seconds or return `429`, `503 NO_DOWNLOAD_SOURCE`, and the publication refusals.
- **Steps**: 1) Install a plugin while the resolve stub delays its response beyond three seconds. 2) Confirm the UI leaves Resolve and begins downloading from the catalog URL. 3) Repeat with a `429` and `503 NO_DOWNLOAD_SOURCE`. 4) Return `403 NOT_PUBLISHED`, `403 PLUGIN_ARCHIVED`, and `404` for a selected version.
- **Expected**: A slow resolve call is abandoned after three seconds; timeout, `429`, and `503 NO_DOWNLOAD_SOURCE` proceed through the catalog's `artifactBaseUrl` plus relative `url`, and bytes still pass the catalog digest check before installation; rate limiting is not retried or waited out; `403 NOT_PUBLISHED`, `403 PLUGIN_ARCHIVED`, and `404` remain explicit failures and never install the fallback package; archived plugins remain hidden from install and update selection; the selected channel does not change.
- **Specs linked**: `07-plugins/07-plugin-marketplace.md` §2
- **Acceptance**: G (remote marketplace source)
- **Milestone**: M6+
- **Status**: Draft

## E2E-PLUGIN-device-identifier-is-stable-and-never-the-machine-code: The device identifier is stable across launches and is not the raw machine code

- **Preconditions**: A host whose machine identifier is readable (Windows `MachineGuid`, the macOS platform UUID, or `/etc/machine-id`), a second environment where it is not readable, and a request-logging stub for `POST /api/v1/download/resolve`.
- **Steps**: 1) Trigger two installs in one session and compare the recorded `deviceId` values. 2) Restart the app and trigger a third install. 3) Compare the value with the raw machine identifier of the host. 4) Search the settings, the Marketplace surface, and the installed-plugin detail view for the value. 5) Repeat steps 1 and 2 where no machine identifier is readable, then inspect the application data directory.
- **Expected**: Every resolve request from one installation carries the same 64-character lowercase hex value, including after a restart and after an app reinstall while the machine identifier is unchanged; the value is neither the machine code nor a prefix of it, and it equals `sha256("pi-desktop.device.v1:" + <machine identifier>)`; the identifier never appears in the UI and no setting can reveal or reset it; in the unreadable case the value is a different 64-hex string that is generated once and persisted under `plugins/market/device.json`, then repeated across restarts.
- **Specs linked**: `07-plugins/07-plugin-marketplace.md` §2, ADR 0276
- **Acceptance**: G (remote marketplace source) + Security
- **Milestone**: M6+
- **Status**: Draft

## E2E-PLUGIN-install-progress-shows-phases-and-mirror: An official-channel install reports its phases and the mirror it is using, then completes

- **Preconditions**: A clean profile on the official channel, a plugin whose resolve answer lists at least two entries, a first mirror that fails or is slow so a second attempt is observable, and a renderer subscribed to `plugin.installProgress`.
- **Steps**: 1) Start a manual install from the marketplace detail sheet. 2) Record the reports that arrive while it runs. 3) Hover the dialog after the install succeeds. 4) Look at the installed plugin once the install ends. 5) Install again with a large package and count the reports over a window of at least one second.
- **Expected**: The dialog shows the phases in order — `resolve`, `download`, `verify`, `install`, `enable` — with `mirror n/N · name` and a determinate bar from `receivedBytes` / `totalBytes`; it is mounted on the viewport overlay host and remains fully above the expanded sidebar, including its cancel/close controls; every report carries `pluginId` and `version`, only the report that names a mirror carries `source`, and `attempt` counts 1-based within `attempts` while a mirror switch increments `attempt` without changing `attempts`; byte reports arrive at most once per 200 ms, with one extra report per phase change and one terminal report; the install ends with no `error` and the plugin is installed and enabled after the ordinary permission review; the dialog closes about two seconds after success, that countdown pauses while it is hovered, and a background auto-update installs the same way without opening the dialog at all.
- **Specs linked**: `07-plugins/07-plugin-marketplace.md` §2, `07-plugins/15-plugin-center.md` §10, ADR 0276 §7
- **Acceptance**: G (remote marketplace source)
- **Milestone**: M6+
- **Status**: Draft

- **Local fallback regression**: Set the process default data directory to a
  different temporary root, then create a plugin manager with its own root.
  All bundled fallback package URLs must stay beneath the manager's root;
  installing the bundled package must still report byte progress, validate its
  size and checksum, and preserve cancellation behavior.

## E2E-PLUGIN-cancel-during-download-installs-nothing: Cancelling during the download stops the install, leaves nothing installed, and closes the dialog without an error

- **Preconditions**: An official-channel install of a package large enough or a mirror slow enough that the download phase lasts, a way to answer `market.cancelInstall`, and a view of the plugin directory, the install cache, and the Installed list.
- **Steps**: 1) Start the install and wait for the download phase. 2) Press the cancel action in the dialog. 3) Watch the dialog and capture the RPC answer. 4) Inspect the plugin directory, the install cache, and the Installed list after the install ends. 5) Send `market.cancelInstall` again for the same id, for an install that is not running, and once after the download has finished.
- **Expected**: The cancel call answers `{ cancelled: true, id }` for the running install, and the install fails with `PLUGIN_CANCELLED` (JSON-RPC code 1019); the dialog closes without reporting an error; nothing is installed — no plugin directory, no installed row, no enabled plugin — and no partial package survives in the cache; the second call for the same id, the call for an install that is not running, and a call after the download finished answer `{ cancelled: false, id }` and change nothing, so a cancel can never interrupt the write of the plugin directory.
- **Specs linked**: `07-plugins/07-plugin-marketplace.md` §2, ADR 0276 §7
- **Acceptance**: G (remote marketplace source) + Security
- **Milestone**: M6+
- **Status**: Draft

## E2E-PLUGIN-failed-install-lists-tried-mirrors: A failed install keeps the dialog open and lists the mirrors it tried with a copy action

- **Preconditions**: An official-channel install whose every mirror fails — for example a digest mismatch on the first and a network error on the second — with a renderer subscribed to `plugin.installProgress` and a clipboard readback.
- **Steps**: 1) Start the install. 2) Let every mirror fail. 3) Read the terminal report and the dialog. 4) Use the copy action, then the retry action once the mirrors serve valid bytes again.
- **Expected**: The terminal report carries `error` and a `tried[]` entry per mirror in the order they were tried, each naming its `source`, `url`, and the error that mirror answered; the dialog stays open and shows the readable error plus that list; the copy action puts the tried mirrors on the clipboard; the retry action starts a new install of the same version and completes it when the mirrors answer, without reusing the failed attempt's partial state; nothing was installed by the failed attempt.
- **Specs linked**: `07-plugins/07-plugin-marketplace.md` §2, ADR 0276 §7
- **Acceptance**: G (remote marketplace source)
- **Milestone**: M6+
- **Status**: Draft

## E2E-PLUGIN-slow-tool-is-not-cut-off-by-host-dispatch

- **Preconditions:** A loaded plugin that registers an agent tool; the tool
  awaits work longer than 60s but shorter than the 110s plugin tool budget (for
  example an `agent.complete` call that takes ~70s).
- **Steps:** Ask the agent to use the tool, approve it if prompted, and wait for
  the call to finish. Repeat with the permission card left open for a while
  before approving.
- **Expected:** The call returns the plugin's result. host-core does not answer
  `TOOL_TIMEOUT` before Electron's budget expires, and no transport layer reports
  `host RPC timeout`, `sidecar RPC timeout`, or `parent host proxy timeout` for
  the call. Budgets nest from the inside out: plugin `agent.complete` 90s < MCP
  call 100s < plugin tool 110s < host-core dispatch 150s, while the widest MCP leg
  (a lazy handshake, then a `tools/list` traversal, then the call) is 140s. The
  transport deadline covers the permission wait, the admission queue wait, and
  that dispatch, so a call that waited for a saturated plugin class before it was
  dispatched is still inside it.
- **Specs:** `07-plugins/12-plugin-ipc-and-host-services.md` agent-tool
  dispatch; ADR 0038; ADR 0174.
- **Acceptance:** G (plugin agent tool).
- **Milestone:** Post-MVP regression coverage.
- **Automation:** `apps/desktop/test/plugin-timeout-budgets.test.mjs` checks the
  budget order and the dispatch call site across the TypeScript and Rust sources;
  `packages/shared/src/protocol.test.ts` covers the transport deadline; host-core
  `desktop_dispatch_outlasts_every_electron_budget_it_wraps` covers the dispatch
  default.
- **Status:** Contract-covered; no end-to-end driver waits out a real 70s call.

## E2E-PLUGIN-crash-report-names-the-exit-code

- **Preconditions:** A loaded plugin whose host process dies on its own —
  `process.exit(7)` after writing one line to stderr is the fixture — with a
  resident service so the supervisor path is exercised too. Isolated desktop
  profile; no marketplace or network access.
- **Steps:** Load the plugin and let the host process die. Read the load error,
  the `failed` service state, the `plugin.crash` audit record and the `plugin`
  log channel. Repeat with a hard fault (a Windows `0xC0000005`-class exit) if
  one is available, and then quit the app while a plugin host is alive.
- **Expected:** Every one of those surfaces names the exit code (`exit code 7`,
  and `exit code 3221225477 (0xC0000005)` for the fault), while the fixture's
  stderr line is absent from the load error and crash audit record. A clean quit
  reports no crash at all: quitting is a shutdown, not a crash.
- **Specs:** `07-plugins/05-plugin-lifecycle.md` §3.1 / §8,
  `08-meta/decisions-log.md` D607.
- **Acceptance:** G (plugin host lifecycle), Quality (diagnosability).
- **Milestone:** Post-MVP regression coverage.
- **Automation:** `apps/desktop/test/plugin-services.test.mjs` forks a real host
  process, kills it with a fixture exit code and asserts the code plus the
  absence of raw stderr in the crash audit record; `plugin-isolation.test.mjs`
  and the shutdown cases cover the "quit is not a crash" half.
- **Status:** Automated at the runtime level; no UI driver reads the plugin
  page's error text.

## E2E-MCP-HTTP-ACK — HTTP acknowledgement and authorization status

- **Preconditions**: A local mock Streamable HTTP server returns JSON for
  initialize, `202` with plain-text `Accepted` for notifications/initialized,
  SSE for tools/list, and JSON for tools/call. No provider credentials needed.
- **Steps**: Connect, discover a tool, and call it. Render the MCP settings row
  with idle, connecting, ready, non-authentication failure, and authentication
  failure statuses, including an expired stored OAuth credential.
- **Expected**: The acknowledgement does not enter the JSON parser; discovery,
  calls, and session headers remain functional. Only explicit authRequired
  status shows the authorization-required badge. Non-authentication failures
  retain their original error. Authentication failures remain actionable.
- **Specs**: 07-plugins/01-plugin-system §12.2; ADR 0038; ADR 0283.
- **Acceptance**: HTTP client integration and settings component rendering.
- **Milestone**: Maintenance.
- **Status**: Covered by the existing HTTP client integration fixture and a
  focused component-render validation; no live IDA process required.

## E2E-MCP-HTTP-SSE-held-open — A streamable HTTP reply lands before the server ends the stream (issue #1188)

- **Preconditions**: A local mock Streamable HTTP server writes its JSON-RPC
  reply immediately and keeps the `text/event-stream` body open well past the
  client's handshake budget — the shape `https://gitmcp.io/docs` shows, where
  initialize is answered in about two seconds and the stream only ends about
  twelve seconds later. No provider credentials needed.
- **Steps**: Configure that server with the `http` transport and a handshake
  budget shorter than the stream lifetime; connect, discover the tools, and call
  one. Repeat with a server that keeps the stream open and never answers.
- **Expected**: Handshake, discovery, and the call complete as soon as their
  reply event arrives, so the connection reports `ready` with the discovered
  tools instead of `mcp initialize timed out after <budget>ms`. A server that
  never replies still fails with `TIMEOUT` inside the same budget, and a stream
  left open past its request is aborted rather than kept open.
- **Specs**: 07-plugins/01-plugin-system §12.2; ADR 0038.
- **Acceptance**: HTTP transport integration and the main-process MCP handshake.
- **Milestone**: Maintenance.
- **Status**: Automated by `apps/desktop/test/plugin-mcp.test.mjs` (held-open
  reply case); no live app process required.

## E2E-IME-escape: Composition cancellation preserves drafts

- **Steps**: Edit a user message; type a draft; dispatch composing Escape and Cmd/Ctrl+Enter. Open global search and dispatch composing Escape from its input. Repeat with legacy keyCode 229, then ordinary Escape and retry shortcuts.
- **Expected**: Composition events neither discard the edit nor close search nor submit a retry. Ordinary Escape still cancels/closes, including search focus outside its input; ordinary Cmd/Ctrl+Enter still retries.
- **Coverage**: `node scripts/e2e-ime-escape.mjs` exercises production components with bubbling DOM keyboard events and host-boundary fixtures. This does not verify an operating system IME candidate window.

## E2E-HOOKS-cancel-and-dispose

- **Issue #816 extension:** Cancel a command while its prompt is visible and
  verify the real renderer removes the dialog, no later prompts or exec occur,
  and the next command/turn succeeds. The trusted-extension Electron driver
  checks the DOM via CDP. Runner tests cover long commands, stopped context waits,
  tool cancellation and late updates, detached header payloads and recovery;
  process tests use a real parent/child tree with readiness synchronization.

- **Preconditions:** An isolated Desktop profile, deterministic local provider,
  and a trusted plugin with a waiting preflight handler.
- **Steps:** Start a prompt; stop while the handler waits; release the old
  handler; send another prompt. Repeat with runtime disposal. Load another
  fixture with stalled startup/shutdown handlers and a deferred event.
- **Expected:** No provider request starts for the stopped/disposed prompt;
  the next prompt completes. Late results cannot restart work. Shutdown runs
  once, waits time out per handler, and deferred registrations are diagnosed
  without disabling supported handlers.
- **Specs:** 07-plugins/16 §6.
- **Acceptance:** Responsive cancellation and bounded extension lifecycle waits.
- **Milestone:** Hooks P0.
- **Status:** Runner and real Runtime/local-HTTP integration automated in
  `extensions/runner.test.ts` and `extensions/runtime-lifecycle.test.ts`.
  The trusted-extension Electron driver exercises the Stop path through the
  real renderer via CDP and records the visible and retired dialog states.
## Imported-extension GUI executable discovery regression (#1173)

Start dependency installation with a GUI-like PATH that cannot resolve Node/npm
and a trusted fixture installation in `~/.local/bin`. Validation and both npm
stages must use that installation, preserve the application PATH, and avoid shell
startup probing. Explicit selections keep their bin directory first. Missing
installations still return `npm-unavailable` and retain native picker recovery.
The executable integration fixture uses real isolated child processes and checks
registry-only installation and credential isolation.

## E2E-PLUGIN-automatic-jsx-activation

- Preconditions: a granted renderer plugin whose compiled entry imports
  `react/jsx-runtime` or `react/jsx-dev-runtime`, with React externalized to the
  host.
- Steps: activate production and development entries through the host import
  map; render automatic JSX components that read a host context with a hook.
- Expected: both entries resolve and render the supplied context value without
  bundling a second React instance. Legacy React bindings remain unchanged.
- Automated regression: `apps/desktop/test/plugin-renderer-import-map.test.mjs`
  evaluates the generated shims and renders an automatic JSX component using
  the host hooks and context. Isolated Electron coverage uses
  `scripts/e2e-plugin-jsx-runtime.mjs`; no user profile or provider is used.

## E2E-267: A plugin follows the selected session and opens its own view

- **Preconditions**: A development plugin that declares one
  `contributes.views` entry and holds `ui.view`, and whose command calls
  `pi.session.getActive()`, subscribes to `pi.events.on("session:activated")`,
  and then calls `pi.ui.revealView({ location: "src/App.tsx" })`. Two sessions
  exist in different projects; one of them is running a turn.
- **Steps**:
  1. Select the idle session and run the plugin's command.
  2. Switch to the other project's session and start a turn; re-check the
     payload the plugin reported.
  3. While that turn runs, run the plugin's command and inspect the work panel.
  4. Switch to the first session, then run the plugin's command again from a
     stale reference to the previous session id.
  5. Disable the plugin and re-open the same work-panel tab.
- **Expected**: `pi.session.getActive()` answers with the session on screen, its
  project path, and `activeTurn: null` while it is idle. `session:activated`
  arrives once per real change — a selection switch, a project change, and the
  turn starting or finishing — and the running session reports the durable
  `turnId` with its start time rather than an inferred one. `pi.ui.revealView`
  opens the plugin's view as a work-panel tab of the active session and focuses
  it, and the view receives `src/App.tsx` through `piViewOpen`/`view:open`
  without being reloaded when it is already open. A call naming a session the
  user left fails with `INVALID_ARGUMENT` and opens nothing. Revealing without
  `ui.view` fails with `PERMISSION_DENIED`. With the plugin disabled the tab
  reports the missing view instead of showing stale content.
- **Specs linked**: `07-plugins/03-plugin-api.md` §ui, §session follow, §5
  events, §6 panel bridge; ADR 0331.
- **Acceptance**: A plugin can follow the selected session and show its own view
  beside it without importing host internals, and a stale session can never be
  revealed onto a panel the user is no longer looking at.
- **Status**: Draft. Unit coverage in
  `apps/desktop/test/plugin-session-follow.test.mjs` (snapshot assembly,
  announcement deduplication, stale-turn and stale-session refusal,
  `ui.view` gating, panel-bridge channel) and the wiring contract in
  `apps/desktop/test/main-wiring-contract.test.mjs`; the interactive Electron
  scenario remains a manual validation run.

## E2E-268: A plugin reads and rewrites a session the user created

- **Preconditions**: A development plugin that declares
  `session.read.all`, `session.update.all`, and `session.delete.all`, and whose
  commands call `pi.session.list()`, `pi.session.get()`,
  `pi.session.listMessages()`, `pi.session.rename()`,
  `pi.session.appendMessage()`, `pi.session.replaceMessages()`,
  `pi.session.deleteMessage()`, and `pi.session.truncateFrom()`. One ordinary
  session the user created and typed two prompts into, plus the same manifest
  edited down to only the `.own` grants.
- **Steps**:
  1. Install the `.all` build and run each read command against the user's own
     session.
  2. Run `rename`, then check the session title in the sidebar and whether the
     auto-title plugin can still rename it.
  3. Run `appendMessage` while the session is idle, and again while a turn is
     running.
  4. Run `replaceMessages`, `deleteMessage`, and `truncateFrom` on the same
     session, watching the open transcript between calls.
  5. Reinstall the `.own`-only build and repeat steps 1 and 4, including a call
     that passes `scope: "all"` itself.
  6. Check the app log for one audit line per call.
- **Expected**: With `.all`, `list` returns the user's session with
  `originKind: "created"`, `source: "desktop"`, `externalId: null`, the real
  `modelId`/`providerId`/`bound.model`, and messages reporting
  `origin: "desktop"`; `get` and `listMessages` agree with it. `rename`
  succeeds and the auto-title plugin can no longer replace that title.
  `appendMessage` adds one row while idle and returns its `messageId`; a repeat
  with the same id adds nothing. While a turn runs, `appendMessage` still
  appends and the three transcript rewrites fail with `TURN_RUNNING`.
  `replaceMessages` and `truncateFrom` repaint the open transcript without
  reselecting the session, `deleteMessage` on a user prompt removes the prompt
  and its replies, and a repeated delete reports `deleted: false`. With `.own`
  the same session is `NOT_FOUND` for every call, nothing in the transcript
  changes, and the plugin's own `scope: "all"` is ignored — the call still runs
  as `own`. Every audited line names the scope that authorised it.
- **Specs linked**: `07-plugins/03-plugin-api.md` §plugin-owned and host-wide
  sessions; `07-plugins/13-plugin-permissions-matrix.md` §2;
  `07-plugins/04-plugin-security.md` §5; ADR 0340, ADR 0200 (amendment).
- **Acceptance**: A plugin that declares the `.all` grants can read and rewrite
  the user's own conversations, the user sees the result in the open transcript,
  and a plugin that declares only `.own` keeps exactly the ADR 0200 reach.
- **Status**: Draft. Host-core coverage in the `plugin_sessions` and
  `plugin_session` tests, broker policy in
  `apps/desktop/test/plugin-session-access.test.mjs`, and the plugin-process
  path in `apps/desktop/test/plugin-session-api.test.mjs`; the interactive
  Electron scenario remains a manual validation run.

## E2E-1175: A plugin suggestion rides in the Composer placeholder and is taken with Tab

- **Preconditions**: A plugin that declares `composer.suggest` is installed,
  enabled, and granted the permission, and it offers one line on
  `session:turnEnded` after its own completion.
- **Steps:** 1) Run an Agent turn in a session and let it complete while that
  session is on screen and its Composer is empty. 2) Observe the placeholder
  layer. 3) Press Tab. 4) Repeat, then press Esc. 5) Repeat, then type one
  character. 6) Repeat, then switch session before the offer arrives.
- **Expected**: The suggestion appears in the placeholder layer of an empty
  draft, brighter than the shell placeholder and on one line with an ellipsis,
  with a `Tab` / `Esc` hint and one polite announcement. Tab writes the exact
  text into the draft with the caret at the end and the input focused, keeping
  any staged attachment; Esc drops it; a first character drops it; a missed
  offer answers `{ shown: false, reason }` and shows nothing. No transcript row,
  toast, or overlay appears, and the plugin's call is audited.
- **Specs linked**: `07-plugins/03-plugin-api.md`,
  `07-plugins/13-plugin-permissions-matrix.md`, ADR 0333.
- **Acceptance**: A (Composer entry path), Security (permission-gated, never
  sent by the plugin).
- **Milestone**: M6+
- **Status**: Unit/source-contract-covered by
  `composer-suggestion-state.test.mjs`, `composer-suggestion-relay.test.mjs`,
  and `plugin-composer-suggestion.test.mjs`; the rendered journey remains a
  manual/Electron check when this surface changes.

## E2E-GENUI-inline-visualization-card: a visualization renders inline and stays sandboxed

- **Preconditions**: The app is running with a local Agent session, Settings →
  AI → Inline visualizations switched on, and the builtin
  `pi-desktop/visualize` skill enabled. A second session uses a remote
  workspace.
- **Steps**: 0) With the switch off (the default), ask for a chart and confirm
  no directory, skill, or card appears; then switch it on. 1) Ask for an
  interactive chart (for example "show a slider that
  changes a sine wave's frequency"). 2) Wait for the turn to finish, then drag
  the slider. 3) Switch the app theme between light and dark. 4) Press the
  card's expand button, then Esc. 5) Ask the model to write a non-`.html` file
  into the visualization directory, and to write a fragment that calls
  `fetch("https://example.com")`. 6) Fork the session, then delete the source
  session. 7) Repeat step 1 in the remote session. 8) Relocate the data directory,
  then fork a transcript that still names its old visualization path. 9) Try
  redirected visualization roots and a `.html` FIFO, and open two document
  URLs from callers that omit the iframe sandbox. 10) Expand a card while
  eight inline cards are live.
- **Expected**:
  - No permission card appears for the fragment write. While streaming, the
    reply shows plain text; after completion the `::visualize` line is
    replaced by a card whose height fits the content (at most 2000 px).
  - The slider works; theme changes recolor the card without a reload.
  - Expand opens a large modal copy; Esc closes it and the inline card keeps
    its state.
  - The non-`.html` write fails with a tool error; fetch requests are blocked,
    and the frame cannot open popups or navigate remotely. The ADR's WebRTC
    ICE limitation remains explicit rather than a blanket no-network claim.
  - The fork retains its own card after the source session is deleted, including
    a fork made after data relocation. The source's directory is removed.
  - Redirected roots cannot bypass Ask write confirmation or let cleanup delete
    unrelated data. FIFO requests fail without blocking other filesystem work.
  - Every document response enforces an opaque sandbox; a caller that omits
    iframe sandbox cannot read another session's DOM.
  - Expanded and inline frames share the eight-frame quota, and the expanded
    card's original inline control state remains unchanged.
  - The remote session gets no visualization directory or skill.
- **Coverage**: `pnpm test:e2e:gen-ui` runs the offline Electron card journey,
  including real protocol responses, bundled assets, the preloaded `viz`
  helpers (`viz.chart` sizing, `viz.render` charts and their date, year,
  re-render, and donut edge cases), a fragment script error shown in the
  card, the fragment inside the kit's `#widget` container with its top-level
  blocks spaced while inline controls, block styling, wrapped roots, and flex,
  grid, and column roots keep their geometry, focus/guest Escape,
  viewport release, and unsandboxed callers through a real isolated Host.
  Native directory, FIFO, and ABA regressions run in `visualizations/files`;
  `gen-ui-file-safety.test.mjs` validates the private Host-to-Main boundary.
  Rust visualization RPC/lifecycle/fork tests
  cover authorization, deletion safety, Windows path spelling, and relocation.
- **Status**: Automated without a paid provider or a user's running instance.

## E2E-PLUGIN-PROJECTS: Enumerate durable projects without switching workspace

- **Preconditions**: An isolated Host profile with a standalone project and a
  multi-folder group, plus a session with no project. A plugin with no granted
  permissions registers a command that calls `pi.projects.list()`.
- **Steps**:
  1. Run the command through the plugin process and read the same list through
     the panel bridge's `projects.list` channel.
  2. Compare the entries with the Host's durable `projects.list` rows and group
     roots, and verify that the visible workspace remains unset.
  3. Restart the Host and run the command again.
  4. Stop the Host and run the command again.
- **Expected**: Exactly one entry per durable row, including ungrouped and
  secondary-folder rows; non-empty decimal database ids; most recently opened
  first regardless of pins; every entry has its own primary path first in
  non-empty roots. A primary group row includes its additional roots in order.
  Identities survive restart. No workspace is opened or switched, no filesystem
  grant is added, and a stopped Host returns `[]`. No Host credentials appear.
- **Automation**: `pnpm test:e2e:plugin-projects` runs a real isolated Rust Host
  and plugin child process without provider calls. The companion
  `apps/desktop/test/plugin-projects.test.mjs` covers pin-independent ordering,
  group lookup failure, missing project providers, failed/malformed lookup,
  rename identity, and stale results after Host replacement.

## E2E-268: Plugin launcher grid, triggers, and local applications

- **Preconditions**: An isolated Host profile with a panel plugin that declares
  one launcher trigger (for example `^\d+\s*[\+\-\*/]\s*\d+$`, so `1+1` matches
  it) and whose panel renders the text it received through
  `window.pluginBridge.consumeLauncherPayload()`. A second panel plugin with a
  Latin name, and at least two installed applications, one of them Chinese with
  a `wx` / `weixin` / `微信` spelling chain. Run on Windows and macOS.
- **Steps**:
  1. Press `Alt+Space` (`⌥+Space` on macOS) with an empty input. Read the grid:
     group titles, rows, tiles per row, and the two header actions.
  2. Type the trigger expression `1+1` and inspect the first tile and its detail
     line; press `Enter` and read the opened panel.
  3. Reopen the launcher and type a pinyin initial such as `wx`, then `weixin`,
     then `微信`; confirm the same application is the matching tile each time.
  4. Type `pi` and confirm the plugin named `PI-Desktop` is listed with a name
     match, and that the same item is reachable by pinyin and initials.
  5. Drag the panel's edge to a larger and then a smaller size; count the tiles
     per row at each width. Quit and restart the application, then reopen the
     launcher.
  6. Type a query that matches more than 24 items. Read the header action and
     the window height.
  7. Disable one plugin that was in recents/pins, reopen the launcher, and check
     the empty-input view and a query that used to match it.
  8. Paste 500 characters of garbage into the search field.
  9. Pin an application, quit, restart, and reopen the launcher with an empty
     input.
 10. Install a plugin whose name matches an installed application (for example
     `Calculator`) and open the launcher with an empty input.
- **Expected**: Step 1 shows `Recently used` with two rows of eight tiles and
  `Pinned` with one row of eight once the user has pins; the recents header
  reports the true number of remembered items and offers `Show all {count} →`
  plus `All plugins →`. Step 2 lists the trigger plugin as the **first** tile,
  ahead of name matches and without a detail line, and the panel shows `1+1`
  exactly once (a second read returns `null`). Step 3 reaches the same
  application through all three spellings. Step 4 lists `PI-Desktop` once by
  name. Step 5 keeps eight columns per row at every width, the panel height
  always matches what it renders, and the dragged width is restored after the
  restart. Step 6 keeps the window at its height cap, reports the dropped count
  in the header, and asks the user to keep typing. Step 7 removes the disabled
  plugin from recents, pins, and matches while every other tile still opens.
  Step 8 keeps the panel responsive (no frozen input, no unhandled error) and
  reports no match, because input longer than 256 characters is never matched
  row. Step 10 lists both entries with the identical 48px rounded square and the
  same name line — the source is only in the hover title — and opening the plugin
  row still lands in the plugin panel while the application row launches the
  program.
- **Automation**: `pnpm --filter @pi-desktop/desktop test` runs the offline
  coverage for these rules: `launcher-search.test.mjs` (ranking order, section
  caps, overflow total, trigger whole-input matching, the 256-character limit
  and the all-plugins view), `launcher-store.test.mjs` (pins and the eight-pin
  cap, recents, legacy migration, retired fields read without error, and
  pruning), `plugin-launcher-height.test.mjs` (content-height arithmetic and
  clamping), `local-apps.test.mjs` (discovery, bounds, icon budget and icon
  cache, dropped targets, opaque-id launch) and `plugin-launcher-state.test.mjs`
  (clamping and re-centring). Rust `plugins` tests cover the manifest rules. The
  rendered Electron journey above — grouped grid, content height, resize,
  restart, and the panel payload round trip — is Draft until a launcher E2E
  script exists.
## E2E-ISSUE-1953

MCP All uses the selected project for create/import/install, falling back to Global only without a project. Explicit filters retain ownership and an opened editor pins its project. Verify create and market installation across all/project/global and missing-project cases with `mcp-market-owner-user-path.test.mjs`.

Open an editor in project A, switch the page to B and wait for B's list. A/B
same-name definitions with different IDs do not prevent saving to A. A real
duplicate name or ID in A still blocks creation; a real duplicate name blocks
editing. Cover both creating and editing before changing the page selection.

## E2E-ISSUE-2184

Load the actual bundled plugin in an isolated workspace. Create a file and Unicode directory, rename and move the file; verify disk entries and response metadata. Invalid create/rename names fail before writing, and duplicate destinations are refused. Coverage: apps/desktop/test/file-manager-mutations.test.mjs. Existing Electron directory-location path also passes.
