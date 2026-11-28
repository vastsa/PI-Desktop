# LAN WebUI MVP: a companion to the running desktop

**Status: MVP implemented behind an off-by-default Desktop setting; real-device
acceptance is still open (see §9).** “MVP” here
means the first release of the WebUI, not the frozen [Desktop MVP](../00-baseline.md).
It does not schedule a public Gateway or change the existing SSH or loopback MCP
profiles. The [remote rollout](../06-delivery/07-remote-control-rollout.md) and
[ADR 0205](../../adr/0205-remote-agent-control-boundary.md) remain in force.

## 1. Release promise

A person leaves PI-Desktop running, pairs their phone on the same Wi-Fi, picks
an **existing** project, creates a session in it, and sends a message. They can
put the phone away, return to the same conversation on either device, and
organize it. This is not screen sharing: choosing a project on the phone must
never switch the desktop user's current project, session, draft or scroll position.
A computer browser on the same LAN can use the same interface.

The following are **P0 release requirements**, not optional polish. Scenario
numbers refer to the [WebUI acceptance catalog](../06-delivery/e2e/live-and-remote.md#lan-webui-mvp-acceptance).

| ID | What the user must be able to do | Acceptance |
|---|---|---|
| W01 | Enable intentionally, pair over the LAN, disconnect or revoke | E2E-269, E2E-274 |
| W02 | Find, switch and organize existing shared projects | E2E-270, E2E-274, E2E-275 |
| W03 | Find, create, rename, pin, archive and restore sessions in the right scope | E2E-270, E2E-271, E2E-275 |
| W04 | Continue a real desktop chat, see progress, answer ordinary questions and stop work | E2E-271, E2E-272 |
| W05 | Move between clients, refresh or reconnect without losing or repeating work | E2E-270, E2E-271, E2E-273 |
| W06 | Revoke paired devices and keep elevated actions on Desktop | E2E-269, E2E-272, E2E-274 |
| W07 | Complete the journey on a phone, with a keyboard or screen reader, and with long histories | E2E-276 |
| W08 | Retain existing names, organization, transcripts and local behavior across upgrade and disable | E2E-275 |

## 2. Enable, pair and leave (W01, W06)

1. On Desktop, **Settings → System → LAN WebUI** shows the service off on a
   fresh install. The user chooses a private IPv4 interface (or loopback) and a
   port, and sees the exact origin after starting. Bind only the selected
   address; never fall back to a wildcard, another adapter, or public
   exposure. IPv6-only networks are outside this first release.
2. **Transport decision (product owner, 2026-11-25): plain HTTP on the LAN; no
   certificate or HTTPS validation in the MVP.** Traffic on the local network is
   therefore not encrypted, and the settings copy says so. In place of TLS the
   listener rejects any request whose `Host` is not the bound origin (DNS
   rebinding) or whose `Origin` is foreign, requires a CSRF token on every
   authenticated mutation, and serves a restrictive CSP. Adding HTTPS later must
   not change the browser API.
3. Once the listener is on, **Add device** shows the address and a copyable
   one-time 6-digit code. For a LAN address, Desktop generates a QR code locally.
   Scanning opens the browser with the code prefilled, not submitted. The
   dialog discloses access to local and temporary conversations and supported changes. A valid
   code immediately issues the device cookie; no additional Desktop approval
   or permission configuration is required. No project data is sent before
   pairing. Each code lasts five minutes at most and is invalidated after use
   or five failed attempts. Only Desktop can generate a code. The browser accepts
   pasted digits with spaces, dashes or full-width forms and does not consume
   attempts for malformed input or duplicate submits while pairing.
4. Devices shows the label and last activity of each paired browser. **Remove**
   and browser sign-out invalidate that device's cookie and streams. Turning
   off in Settings closes the listener and revokes every pairing. The next
   launch stays off and retains only the last binding for manual enablement.
   Closing a browser tab is not sign-out.
5. Minimizing or hiding Desktop does not stop the service. Phone backgrounding,
   Wi-Fi loss or closing a tab does not stop it. A browser cannot generate a
   pairing code or submit a tool or plan approval. Sleep makes Desktop
   unreachable. Quitting Desktop closes the listener. On its next launch,
   Desktop tries the last explicitly enabled address and port, and the same
   browser can reconnect without a new code while its pairing is valid.
   An unavailable address or port leaves the listener down without changing
   the saved preference. Settings shows the cause and lets the user retry or
   turn it off. Selecting a different binding requires fresh pairing. Do not
   promise active turns survive process exit.

Show actionable failures on the side that can fix them: no eligible interface,
port occupied, client isolation/firewall,
wrong/expired code, device limit, revoked device or desktop offline. A phone
unable to reach the Host cannot diagnose why; offer the address and local
network checks, not a false claim that the desktop quit. Never open firewall or
router ports, use UPnP, or set up a tunnel automatically.

Desktop administration stays on the main-window-only LAN admin IPC channel.
The payload-free `lanWebUiChanged` event asks the renderer to refetch after
listener, code or device changes. `POST /pair` returns `{ state: "paired" }`
and sets the session cookie in the same response. `/pair/status` checks an
already-established cookie for older browser tabs; there is no pending state.
`/v1/me` retains the former access flags as fixed compatibility metadata.

## 3. Projects and sessions (W02, W03)

| Surface | Required behavior |
|---|---|
| Projects | Show all eligible local desktop projects, including closed or archived ones and projects added after pairing, not just the visible sidebar. A logical multi-root group is **one** project. Search by display name across the catalog, switch, rename the display name, pin/unpin, archive/restore. Show pinned first, then recent; distinguish “no local projects”, “no matches” and “no sessions”. Do not show absolute paths. |
| Project sessions | Enter a project to see its sessions; search by title, open history, rename, pin/unpin, archive/restore. Show running, waiting, interrupted or failed status from the Host. Stable IDs, not names or list positions, distinguish equally named records. Use bounded pages; search is not limited to the first loaded page. |
| New in project | A project's **New session** targets that explicit project, even if the desktop or a second tab is viewing another. Use desktop defaults and the normal local Agent. Only reuse an existing empty conversation if it meets Desktop's pristine, same-scope reuse rule; never attach to a running session or another pending submission. Double-tapping one intent cannot create two sessions. |
| Temporary | Any paired device can list, organize and continue ordinary temporary conversations and create one through the Temporary conversations entry. A temporary conversation has no project and uses normal temporary workspace isolation. It never inherits the last Desktop project. |
| Archive | Archiving is reversible organization, not deletion, cancellation, folder movement or transcript modification. Inspect archived items via an explicit filter without restoring them. Restore an archived parent project before creating or sending; restore an archived session before sending. Restoring a project preserves each session's own archive/pin state. Decline a web archive if the target session, or a project descendant, is running, queued or waiting for input. Never stop work to make archive succeed. |

Only existing locally owned, local-workspace projects and ordinary local Agent
sessions are writable in P0. Local-Agent projects backed by an SSH workspace,
legacy remote-Agent sessions, and sessions outside a registered project or
the Temporary scope are **not exposed**. In a local project, existing special
sessions (e.g. Plan/Goal) may show safe history and “Continue on Desktop”, but
no unsupported mutation. Never convert them to Agent or change their workspace.
Desktop-only deletion or a change of project membership must
invalidate stale rows and deep links; do not redirect to a different session.

## 4. Conversation (W04)

- Show the project and session identity, active model label and run state.
  A new session inherits the configured desktop default; an existing one uses
  its own configuration. If no usable model exists, preserve the draft and
  point to model setup on Desktop. Never ask the phone for a provider key.
- In an idle, writable local Agent conversation, tap the model chip under the
  draft to search the Desktop's configured chat models by model or service.
  The picker marks the session's saved selection and applies a new choice to
  that conversation's next turn, without clearing the draft or changing
  Desktop defaults. Keep the previous binding on failure and let the user
  reload the choices. Running, queued, waiting, archived, scheduled, and
  extension-owned sessions cannot be changed from this picker.
- Page older history backwards without losing the reading position. A page
  requested before navigating away must not change the new view's messages,
  pagination cursor or scroll position. Render
  user/assistant text, safe Markdown, code and bounded tool summaries in order.
  Unsupported cards or attachments get a typed, non-executable placeholder;
  do not fetch embedded remote images or open local files from transcript text.
- Send text once, show admission/queued status separately from streaming, and
  reconcile optimistic text with the Host record. When busy, expose a distinct
  **Queue message** action if offered; otherwise keep the draft and say busy.
  Show queued entries and allow cancellation of an authorized, not-yet-started
  turn. **Stop generation** targets the named active turn (RACP `turn/interrupt`),
  preserves partial output and never stops a different turn after a race.
- An ordinary Host-typed question with supported text/choice fields can be
  answered from a paired chat-capable browser; the first valid answer wins.
  Tool permissions, Plan/Goal approvals, credential prompts and native dialogs
  remain **desktop-only**. The phone shows “Waiting for approval on Desktop”
  or “Input needed on Desktop”, then the actual outcome. Classification comes
  from the Host, not question text. Disconnect, expiry or dismissal is never consent.
- Preserve in-progress drafts per session within the open tab across navigation
  and transient network loss. Do not silently send drafts on reconnect. Refresh
  restores **accepted** work from the Host, not a promise of offline draft storage.

## 5. Authority, consistency and compatibility (W05, W08)

The web page is another client of the **running desktop's** sessions. The
network edge is scoped to WebUI operations; it is not a way to call arbitrary
Electron IPC, `host.proxy`, local MCP, Rust RPC or SQLite. Rust remains the
only SQLite owner. No second `pi-host` against the desktop profile, second
transcript store, remote provider copy, or browser-owned execution/queue.

| Shared, authoritative state | Local to each view |
|---|---|
| Project/session IDs, membership, labels, pins, archives, transcripts, turns, queue, pending interactions and their resolutions | Selected project/session, route, filters, sidebar expansion, scroll, focus and unsent draft |

The browser API is a small WebUI-specific HTTP/JSON surface with same-origin SSE
change notices (`/v1/projects`, `/v1/sessions`, `/v1/sessions/:id[/history]`,
`/v1/sessions/:id/turns`, `/v1/turns/:id:interrupt|:cancel`, `…/organize`). It
maps onto existing Desktop handlers and Agent Host turn admission rather than
implementing the full RACP browser profile. `/v1/sessions` without a
`projectId` lists every visible scope (running first, then most recent; sessions
of archived projects only with `archived=1`), and each session carries its
display `projectLabel` (`null` for Temporary) so cross-project rows say where
they live. Catalog changes reach other clients
even when they are not subscribed to that conversation; clients invalidate and
refetch a scoped view rather than streaming every transcript. A deep link
restores only the browser's navigation, after fresh authorization.

`GET /v1/sessions/:id/models` returns the configured model choices, the saved
selection when it is still listed, and an opaque revision. The choices carry
only provider/model IDs and display labels. `POST /v1/sessions/:id/model`
accepts only `{ providerId, modelId, revision }` and returns `{ ok: true }`.
The server revalidates session eligibility, idleness, and the binding against
the current local catalog. A stale selection returns `CONFLICT` rather than
overwriting a newer edit. See [LAN model selection](../../adr/lan-webui-session-model-selection.md).

- Mutations carry a principal-bound idempotency key; organization edits carry
  the last observed resource revision and an **explicit desired value**, not
  “toggle”. A lost reply is reconciled with the Host; a proven same-key retry
  returns the original admission/result. Different input on the same key or a
  stale revision fails, refetches, and allows an explicit new choice. Never
  blindly resend chat, append duplicate output or claim external tools ran
  exactly once when their outcome is unknown.
- Across clients a session has at most one active turn. Distinct simultaneous
  sends are distinct intents: admit one; queue the other only if its request
  explicitly allows it, otherwise report busy without dropping the draft.
  Chat can interrupt the named active turn or cancel a specified queued turn in
  its authorized session, even if it was submitted on Desktop. Neither action
  may apply to a different session or a subsequent turn.
- Change notices carry at most a session id the device may see. On any notice,
  reconnect or foregrounding the page refetches the authoritative view
  (committed messages, live assistant text, queue and pending-on-Desktop state);
  it never reconstructs text by replay. Late results for an old route are
  discarded.
- On loss, mark the view stale, keep the visible draft, disable mutations, and
  reconnect with bounded backoff. Reattach on foregrounding. `UNAUTHORIZED`
  requires pairing again; scope loss clears affected data; `CONFLICT` refreshes
  the record; busy/limit responses retain the draft and honor retry hints.
  Show meaningful terminal state after a desktop restart, not endless “running”.

**Organization ownership.** Pins, archives and display names stay in the
existing Desktop sidebar record ([ADR 0016](../../adr/0016-sidebar-organization-and-multi-project-tabs.md));
logical groups keep their [host-owned identities](../../adr/0249-chatgpt-style-logical-project-groups.md).
A browser edit is written to that record by Electron Main and kept pending until
the open Desktop renderer acknowledges it, so an older sidebar snapshot cannot
overwrite it. Session and group renames go through the existing host calls.
Temporary sessions are created with no project and never inherit the active
workspace. Existing IDs, group membership, names, pins, archives and transcripts
are untouched; view-only preferences (collapse, sort, open tabs) stay private.
Stopping the WebUI removes access, not data.

## 6. Access and privacy (W06)

Follow the [code-only pairing decision](../../adr/lan-webui-code-pairing.md)
and the applicable [remote permission policy](../05-security/02-remote-control-security.md).
Successful pairing gives every device the same WebUI access: eligible current
and future local projects, archived history, and temporary conversations.
Disclose that scope before displaying a code. Chat and Organize are included
for every paired device, not separate grants.
History may contain sensitive text the user or model already put in the
conversation; sharing is not an automatic redaction of authored messages.
Never enrich it with credential records, absolute workspace paths or raw tool
diagnostics that the safe transcript projection does not already expose.

| Operation | Available after pairing | Not exposed by pairing |
|---|---|---|
| View | Local project and temporary catalogs, safe history, activity and scoped events | Remote project metadata, paths, secrets or arbitrary file reads |
| Chat | Create, select a configured model in an idle local Agent conversation, send/queue, interrupt, cancel queued work, answer ordinary typed questions when supported | Shell endpoint, remote approvals, raising permission mode, configuring providers |
| Organize | Rename, set pin, set archive/restore on eligible objects | Permanent delete, project registration/root editing, granting roles |

Check the device credential, live resource scope, object state, and policy on
every command, page, attachment placeholder, catalog notification and stream.
Guessing an ID must reveal no more than a missing record. Revoking a device
closes its streams and rejects subsequent requests or in-flight results. The
release also requires canceling its not-started queued work. Already admitted
running work follows the Host incident policy; never silently replay or undo
it. Clear protected views on authorization loss; already seen text cannot be
remotely erased. A web turn never gets the SSH-paired-owner exemption: apply
the lower of session policy and the WebUI `ask` ceiling without changing the
desktop session setting. A browser cannot approve its own escalation.

Session archive is **owner-only** in RACP. The LAN WebUI does not reuse RACP
`session/archive` and never grants a phone the owner role. The WebUI checks
its organize operations against the current local catalog and only writes
the same Desktop organization record the sidebar uses (§5).

Use a Host-issued `HttpOnly`, host-only, `SameSite=Strict` cookie (no `Secure`
flag because the MVP is HTTP), exact Host/Origin validation, and CSRF tokens
for authenticated mutations. Both browser and server expire the pairing after
30 days from redemption. Desktop stores a verifier of the random cookie, not
its value, in a machine-local profile file with the listener preference and
device metadata. Pairing codes, streams and in-flight request state are never
persisted. An explicit disable, removal or sign-out is saved before it is
acknowledged. Invalid saved state is not used to open the listener. No session
credentials in URLs, local storage or logs. A QR may include the one-time
code in a fragment; the browser removes it before sending requests, and
submits it only in the pairing POST body. Serve assets locally
under a restrictive CSP; never cache authenticated data (`no-store`). Logs
record only start/stop and failure codes, not prompts, history, codes or
cookies. Bound request bodies (300 KiB), prompts (256 KiB), pages (50 items)
and devices (16); never silently truncate input.

## 7. Phone usability and service targets (W07)

- Phone: Projects → Sessions → Conversation is usable with one hand. Browser
  Back returns to the prior list and position. Put New session and Send in
  reach, row actions in a labeled menu, and the composer above the keyboard
  and safe area. Desktop browsers may keep a persistent project/session rail.
  Do not hijack standard browser navigation, zoom or copy.
- Support 320 CSS px width, portrait/landscape, 200% zoom, visible keyboard
  focus, 44 × 44 CSS px action targets, descriptive control names and status
  text independent of color. Announce actionable state changes, not every
  token. Preserve Chinese IME composition; Enter for candidate selection must
  not submit. Ship localized controls/errors via Desktop's catalog conventions,
  with English fallback; verify English and Simplified Chinese.
- The page follows the Desktop visual system
  ([UI design system](../04-ux/07-ui-design-system.md)): the neutral
  monochrome palette, divider-free tonal tiles, stroke plus shadow only on
  floating layers (action sheet, toast, status pill), Lucide icons, and the
  shared radius, type and motion ramps, mirrored as tokens in the page's own
  stylesheet. Light or dark follows the phone's system preference. Phone-only
  deviations: 16 px reading size for answers, rows and form fields (iOS does
  not zoom a 16 px field on focus), a New session capsule pinned within thumb
  reach, a floating composer pill, list pages that lead with a large title
  handing over to the bar on scroll, and rename in the action sheet instead of
  a native prompt. Floating layers enter with a fade and at most 8 px of
  travel, so their actions are tappable from the first frame; a sheet can also
  be pulled down to dismiss. A live refresh keeps the focused field, caret and
  draft; Back restores the list scroll position and closes any open menu.
  Wider windows keep one readable column under a full-width bar, move New
  conversation into the bar, and show sheets as centred dialogs.
- Home leads with Recent conversations across projects (running work always
  listed), then Projects with Temporary first. One search covers project names
  and conversation titles and can be cleared in place. Row menus also open on
  long-press or secondary click. Archived items sit behind one Archived entry
  per list (`#/archived`, `#/p/:id/archived`) instead of a sticky filter.
  Home's New conversation asks only for the destination. Home names the paired
  device above Disconnect, and disconnecting asks for confirmation.
- A conversation names its project and run state in the header and its model
  in the composer (or the header when it is not editable). An empty one shows
  where it will run. Answers render the safe Markdown subset
  (no HTML, no remote images, only `http(s)` links opening in a new tab);
  consecutive tool calls fold into one step summary; code blocks and the last
  answer of each exchange offer Copy, confirmed on the control itself (with a
  non-secure-context fallback); content that arrives while the reader watches
  fades in, while refreshes and settling records stay still. A
  sent message appears immediately and yields to the Host record, the queue
  entry, or a 30 s timeout; a failed send restores the text to the draft.
  While a reply runs without streamed text a working cue shows; the composer
  offers Stop alone until text is typed, then Queue. Jump to latest appears
  once the reader scrolls away. Send and New conversation wait while offline.
- Qualification: physical iPhone/Safari and Android/Chrome on the same LAN,
  plus desktop Chromium; record browser/OS/build versions. Qualify listener
  start, shutdown and restart on every Desktop OS advertised as supported.
- On a healthy LAN (RTT ≤50 ms, warm assets, fixture provider), test 100
  projects, 1,000 sessions and one 2,000-message history. Across 30 runs, p95
  first usable catalog and committed cross-client metadata visibility must each
  be ≤2 seconds. Initial chat fetch loads at most 100 history items, not the
  entire transcript. Do not count model latency in these targets.

## 8. Delivery and release decision

1. **Boundary (done):** a WebUI-specific edge in Electron Main calls the
   existing Desktop handlers (Agent Host turn admission, session create/rename,
   project rename, abort) and host-core reads. It exposes no generic IPC, RPC or
   SQLite access. Organization edits use the existing sidebar backup as the one
   durable record (§5). An ADR is still owed for this boundary and for the HTTP
   transport decision.
2. **Deliver the basic workflow:** implement W02–W04 against the same durable
   records, then exercise both clients together, including empty/new/existing
   projects and sessions, device revocation and a lost reply. Do not count an
   independent headless session or a mock renderer as the real user journey.
3. **Release gate:** all P0 rows and E2E-269 through E2E-276 must pass on the
   candidate, including physical iPhone/Safari and Android/Chrome on a real
   LAN. Use isolated profiles, deterministic model/tool fixtures, no real
   secrets or paid providers. This document supplies no real-device evidence.

**After P0, not release dependencies:** choosing among desktop-approved models
on the web, creating/importing projects or editing roots, moving/forking or
permanently deleting sessions, attachments/files/diffs, Plan/Goal authoring,
remote approvals, terminal, plugins/settings, notifications and offline sending.
No public relay, account service, Internet exposure or standalone WebUI Agent
is part of this product increment.

## 9. Implementation status (MVP)

Code: `apps/desktop/electron/main/lan-webui/` (listener, pairing, scope checks,
workspace edge, organization owner), `apps/desktop/resources/lan-webui/` (phone
page), `apps/desktop/src/features/lan-webui/LanWebUiSection.tsx` (Desktop
settings) and `apps/desktop/src/features/lan-webui/lan-catalog-sync.ts`
(applies browser edits to the open Desktop sidebar without navigating).

| Area | Delivered | Not yet |
|---|---|---|
| W01 | Off by default; remembers opt-in, binding and unexpired pairings across launches; one-time-code pairing with copy and QR; explicit disable revokes access | HTTPS (deliberately deferred) |
| W02/W03 | Local projects and temporary conversations; search; archived filter; rename, pin, archive/restore with revision conflicts; new session in the explicit project | Reuse of an existing empty session |
| W04 | Paged history; live assistant text; send; queue; cancel queued; stop the named turn; “waiting on Desktop” for approvals and input | Answering ordinary questions from the browser; model label is the raw model id |
| W05 | Idempotency keys for every mutation; SSE change notices with refetch; reconnect banner | Cursor-based replay (refetch is used instead) |
| W06 | Device revocation; non-owner principal under the remote `ask` ceiling; plan/goal and remote sessions read-only or hidden | Idle (30 min) session expiry; canceling already queued work on device revocation |
| W07 | Phone-first layout, 44 px targets, English and Simplified Chinese, IME-safe Enter | Screen-reader and large-catalog qualification |
| W08 | Existing names, pins and archives keep working; browser edits survive stale sidebar writes | — |

Automated coverage: `apps/desktop/test/lan-webui-organization.test.mjs`,
`lan-webui-restart.test.mjs` (saved startup and pairing lifecycle),
`lan-webui-user-path.test.mjs` (real HTTP listener, fake Desktop), and
`lan-webui-settings-user-path.test.mjs` (isolated Desktop System settings).
The phone-size Electron Chromium journey runs separately with
`pnpm test:e2e:lan-webui` on the Electron-equipped CI runner.
