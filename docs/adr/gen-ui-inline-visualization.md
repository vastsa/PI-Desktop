# ADR: Inline generative UI visualizations

- Status: Accepted
- Related: D671, D114 (session scratch root), ADR 0092 (plugin-owned panel surface)

## Context

Models can explain dynamic systems, tunable parameters, and spatial
relationships far better with a small interactive page than with prose,
Markdown tables, or Mermaid. PI-Desktop cannot show such a page in the
transcript: assistant text renders through Markdown only, the transcript has no
embedded frames, and MCP Apps `ui://` resources are not supported.

Codex and ZCode solve the same problem the same way. The model writes an HTML
*fragment* to a host-owned, per-session directory and references it from the
final reply. The host validates the file, wraps it in a host shell with a
strict Content Security Policy and theme variables, and renders it in an
isolated frame inside the message. PI-Desktop adopts that architecture and
adapts ZCode's Apache-2.0 visualize kit (stylesheet, tooltip and tab runtime,
and a condensed skill text); the Codex text is proprietary and is not used.
Attribution lives in `apps/desktop/resources/gen-ui/NOTICE.md`.

This record covers the first version: an inline card with theming,
self-reported height, and an expanded view. Interactive state, follow-up
messages, external links, tweak panels, icons, and image export are
deferred.

## Decision

### Reference syntax

The model ends its reply with one standalone line per visualization:

```text
::visualize{"path":"/abs/path/to/chart.html","title":"Optional title"}
```

The renderer parses only completed assistant messages. Fenced and indented code
stays code, except a closing fence containing only one reference is accepted as
the model's reference. Malformed lines stay text. The first-party builtin
`pi-desktop/visualize` skill teaches this contract; host APIs, tweaks, calendar,
export, and CDN guidance are removed from the adapted ZCode skill.

### Storage root (Rust host-core)

1. Each local session gets `<data_dir>/visualizations/<sessionId>/` as an
   additional containment root for `Read`, `Write`, and `Edit`, addressed by
   absolute path only, with the same lexical and symlink defenses as the D114
   scratch root.
   The visualization base and session directories must not be redirected by
   symlinks or junctions, including when the data directory is in a workspace.
2. Before adding the root, the single optional `scratch_root` parameter that
   threads through path resolution is generalized into an ordered list of
   contained roots. That step is behavior-preserving and lands first, so the
   new root does not become a second parallel path.
3. `Write` and `Edit` into the visualization root accept only `.html` files.
   `Read` is unrestricted inside the root so the model can revise a fragment.
4. Valid contained writes auto-allow under scratch's conditions (local workspace
   only; contract and Plan modes still deny), without artifacts or review
   snapshots. Redirected roots never grant containment; an explicitly approved
   external path continues through ordinary external permission semantics.
5. The directory is created lazily and removed with its session (session
   delete and project removal). The startup sweep removes only directories of
   sessions that no longer exist; unlike scratch it never expires live
   sessions by age, because transcripts keep pointing at these files.
   Cleanup refuses a redirected base instead of traversing or deleting its
   target. The selected data directory itself may use a canonical alias.
6. Forks copy only the fragments their transcript references into
   `visualizations/<childId>/` and rewrite those paths, like referenced pasted
   files in scratch. Cards always resolve against the owning session, so a
   transcript cannot load another session's files, and deleting the parent
   leaves the child's cards intact.
   References are matched by source-session/file identity rather than the
   current absolute prefix, so relocation and canonical aliases preserve forks.
   Only assistant/checkpoint visualization references are remapped; raw tool
   strings, thinking, code examples, and foreign-session references stay intact.

### Model guidance (agent runtime and Electron Main)

Inline visualizations are opt-in: `AppSettings.inlineVisualizations` is absent
and `false` by default, and only `true` enables them. While the switch is off
the absolute directory path is not advertised in the system prompt, the
`pi-desktop/visualize` skill is withheld from the catalog, the `/` menu, and the
on-demand `Skill` tool, and the renderer hides existing reference lines without
loading a card. With the switch on, the directory is advertised beside the
scratch directory and the skill is active unless the user disables it like other
built-in skills; a disabled skill also withholds the directory from the prompt.
Remote-host sessions get neither the directory nor the skill (neither in the
runtime nor in the `/` menu or a send-time `/skill:` mention): their tools write
on the remote machine, which Electron Main cannot read. The card's "unavailable"
state is only a fallback for older messages.

### Serving (Electron Main)

1. Main registers a `pi-genui:` scheme through the single
   `registerSchemesAsPrivileged` call site as `standard` and `secure` only —
   no Fetch API support, no CORS, no `Access-Control-Allow-Origin` header.
   Every document response also enforces `sandbox allow-scripts` in its CSP
   header. This forces an opaque origin even when a renderer plugin or other
   caller omits the iframe sandbox; blocking Fetch alone cannot isolate DOMs.
2. The card URL is `pi-genui://session/<sessionId>/<file>.html`. The renderer derives
   it from the trailing `visualizations/<sessionId>/<file>.html` segment of the
   referenced path and never loads the absolute path. Main asks the current
   local Host to resolve its own data directory, so references survive
   relocation without rewriting the historical message prefix.
3. The handler accepts `GET` only, validates the session ID against
   `[A-Za-z0-9_-]` and the file name as a single path component ending in
   `.html`, and rejects symlinks, non-regular files, files over 2 MB, and
   complete HTML documents (a leading `<!doctype`, `<html`, `<head`, or
   `<body`).
   Main does not open model-written paths. The private
   `visualizations.readFragment` RPC returns bounded base64 bytes for a session
   and filename only. Unix Host Core opens base/session/leaf relative to pinned
   directory descriptors with no-follow flags and a nonblocking leaf. Windows
   opens every canonical ancestor and owned child through `NtCreateFile` with
   `RootDirectory`, retaining handles through the bounded leaf read. It rejects
   reparse entries and keeps read-only share masks as additional defense, not
   the security boundary: attribute handles can mutate reparse points despite
   those masks. Relative opens stay bound to the pinned directory objects.
   Ancestor rename, attribute-junction mutation, or ABA cannot redirect the leaf.
   No renderer IPC or Plugin SDK surface is added.
   This replaces path snapshots, which cannot establish an atomic directory
   capability. Main validates the private reply before constructing the shell.
4. Main wraps the fragment in a host shell: the kit stylesheet
   (`resources/gen-ui/visualize.css`, which defines the agent-facing tokens
   such as `--foreground` and `--viz-series-1` from MCP Apps-style
   `--color-*` host variables), a small host runtime that reports content
   height and applies theme updates, the fragment, and then the kit runtime
   (tooltips and tabs). Bundled libraries (D3 7.9.0, Floating UI 1.7.x) are
   referenced by their pinned CDN URLs; the shell rewrites exactly those URLs
   to `pi-genui://assets/<file>`, which serves only files listed in
   `resources/gen-ui/vendor/manifest.json`. The response carries the CSP and a deny-all
   `Permissions-Policy` as HTTP headers, plus `X-Content-Type-Options: nosniff`
   and `Cache-Control: no-store`.
5. The guest CSP is `default-src 'none'`; `script-src` allows
   `'unsafe-inline'` and `pi-genui://assets` only, `style-src`
   `'unsafe-inline'` only; `img-src`, `font-src`, and `media-src` allow
   `data:` and `blob:`; `connect-src`, `frame-src`, `form-action`, and
   `base-uri` are `'none'`. No CDN is allowed: an allowlisted
   module CDN can proxy arbitrary code, doubles as an exfiltration channel, and
   makes rendering contact the network. `webrtc 'block'` is also sent, but
   Chromium does not enforce it today: a guest can still open an
   `RTCPeerConnection` and send STUN packets to an address it chooses. This
   residual channel is accepted for v1 (the guest only sees what the model
   wrote into it) and is tracked as a follow-up; the main window itself uses
   WebRTC for live voice, so a process-wide WebRTC policy is not an option.
6. Permission request and check handlers deny every request from a
   `pi-genui:` origin.

### Main window

`apps/desktop/index.html` adds exactly `frame-src pi-genui:` to its CSP. The
parent's `frame-src` also governs where the frame may navigate, so a
visualization cannot replace itself with a remote page outside its own CSP.

### Rendering (renderer)

1. The assistant message bubble splits references out of the message content
   before Markdown rendering and renders one card per reference. With
   `AppSettings.inlineVisualizations` off it still strips the reference lines —
   a historical reply must not show its absolute path as text — but produces no
   card, so nothing is read from disk or framed. The shared Markdown component
   is unchanged, so plugin READMEs, file previews, and tool
   rows never show cards.
2. The card is `<iframe sandbox="allow-scripts" loading="lazy">` without
   `allow-same-origin`; the guest has an opaque origin and cannot reach the
   host DOM, storage, or preload bridge.
3. The renderer accepts only `{ type: "pi-genui:size", height }` and
   `{ type: "pi-genui:wheel", deltaX, deltaY, deltaMode }` messages whose
   `event.source` is that card's frame. Height is clamped to 120–2000 px
   (initially 240 px). A wheel report is replayed as an untrusted `wheel`
   event on the frame element: the guest is an out-of-process frame whose
   input never reaches the transcript, so without it a scroll that chains out
   of a card reads as programmatic and follow mode pulls the reader back. The
   renderer posts `{ type: "pi-genui:theme", vars, colorScheme }` (host
   design tokens mapped to `--color-*` names) when the resolved theme
   changes and `{ type: "pi-genui:view", view }` on load.
4. Expanding opens a modal with a fresh frame for the same URL. The inline
   frame remains mounted with its existing interactive state. The `expanded`
   view centers the fragment in the dialog; Esc closes the copy.
5. A missing, invalid, or remote file renders an "unavailable" card with a
   localized reason; the rest of the message renders normally. Serving errors
   reach the card as a fixed code (`pi-genui:error`), never as text or paths.
6. A shared pool bounds inline and expanded frames to eight across all panes.
   Expanded views protect their source inline frame from quota eviction while
   open; off-screen inline frames are evicted before visible ones.

## Consequences

- The transcript can show interactive pages without giving them host
  capabilities, network access, or same-origin access.
- host-core gains a small module mirroring the scratch lifecycle and a
  behavior-preserving generalization of contained roots.
- Plan mode cannot produce visualizations because it exposes no `Write` or
  `Edit` tools.
- Visualizations can use only the bundled libraries; any other library or
  remote asset is blocked. The kit adds about 380 KB to the app resources.
- Data-directory relocation and forks keep working; a fork owns copies of the
  fragments it references, so deleting the parent does not break its cards.
- A guest can still reach the network through WebRTC ICE until Chromium
  enforces `webrtc 'block'` (see Serving item 5).

## Alternatives

- **Store fragments under `scratch/<sessionId>/visualizations/`.** About a third
  of the change, but it changes D114's "scratch is temporary" meaning and still
  needs a sweep exception. Rejected for unclear ownership.
- **One `<webview>` per card (ZCode).** Process-level isolation, but requires
  the webview tag, lifecycle management, and size syncing. An opaque-origin
  sandboxed iframe behind a strict CSP is sufficient for this version.
- **Declarative JSON component trees (A2UI).** Safer, but limited to predefined
  components, which loses the expressiveness that motivates the feature.
- **MCP Apps `ui://` first.** Standard, but tied to MCP tool results; it can
  reuse this sandbox later.
