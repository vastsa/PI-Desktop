# ADR: Inline generative UI visualizations

- Status: Accepted
- Related: D671, D114 (session scratch root), ADR 0092 (plugin-owned panel surface)

## Context

A model explains dynamic systems, tunable parameters, and spatial relationships
far better with a small interactive page than with prose, tables, or Mermaid,
but the transcript renders Markdown only and supports no embedded frames. This
record adapts the approach Codex and ZCode use — a model-written HTML fragment
in a host-owned per-session directory, validated and framed by the host — and
borrows ZCode's Apache-2.0 visualize kit; interactive state, follow-up messages,
external links, tweak panels, and image export are deferred.

## Decision

### Reference syntax

The model ends its reply with a standalone
`::visualize{"path":"/abs/path/to/chart.html","title":"Optional title"}` line
per visualization, the renderer parses only completed assistant messages, and
fenced or indented code stays code except for a closing fence holding one
reference.

### Storage root (Rust host-core)

Each local session gets `<data_dir>/visualizations/<sessionId>/` as an
additional containment root for `Read`, `Write`, and `Edit`, addressed by
absolute path only and defended like the D114 scratch root. The single
`scratch_root` parameter becomes an ordered list of contained roots first, so
the new root does not create a parallel path. Writes accept only `.html` while
`Read` is unrestricted inside the root, contained writes auto-allow under
scratch's conditions without artifacts or review snapshots, and the directory
is created lazily and removed with its session, sweeping only sessions that no
longer exist.

### Model guidance (agent runtime and Electron Main)

Inline visualizations are opt-in through `AppSettings.inlineVisualizations`,
absent and false by default; while off, the system prompt does not advertise the
directory, the `pi-desktop/visualize` skill is withheld from the catalog, `/`
menu, and `Skill` tool, and the renderer hides existing reference lines.
Remote-host sessions get neither the directory nor the skill, because their
tools write on the remote machine.

### Serving (Electron Main)

Main registers a `pi-genui:` scheme as `standard` and `secure` only, without
Fetch API support, CORS, or an `Access-Control-Allow-Origin` header, and every
response carries `sandbox allow-scripts` in its CSP so the document keeps an
opaque origin even when a caller omits the iframe sandbox. The card URL is
`pi-genui://session/<sessionId>/<file>.html`, derived by the renderer from the
trailing path segment; the handler accepts `GET` only, validates the session id
and single-component file name, rejects symlinks, non-regular files, oversized
files, and complete HTML documents, and reads bytes through the private
`visualizations.readFragment` RPC rather than opening model-written paths.
Fragments are wrapped in a host shell with the kit stylesheet, a height and
theme runtime, a preloaded chart layer with pinned bundled libraries, and the
kit tooltip and tab runtime, and the guest CSP allows only `'unsafe-inline'` and
`pi-genui://assets` with no CDN, no `connect-src`, and no `frame-src`.

### Main window

`apps/desktop/index.html` adds exactly `frame-src pi-genui:` to its CSP, so the
parent also governs where the frame may navigate.

### Rendering (renderer)

The assistant bubble splits references out before Markdown rendering and shows
one card per reference, and with the setting off it still strips the lines while
framing nothing. The card is a `sandbox="allow-scripts"` lazy iframe without
`allow-same-origin`, so the guest cannot reach the host DOM, storage, or preload
bridge; the renderer accepts only size and wheel reports from that frame, clamps
height, replays wheel intent as untrusted input, posts theme and view messages,
and opens a modal with a fresh frame for the expanded view. A shared pool bounds
frames across all panes, and serving errors reach the card as a fixed code.

## Consequences

- The transcript shows interactive pages without granting host capabilities,
  network access, or same-origin access, at the cost of the bundled-kit weight.
- host-core gains a module mirroring the scratch lifecycle, and forks copy only
  the fragments their transcript references, so relocation and deletion behave
  as they do for pasted files.
- Plan mode cannot produce visualizations, and a guest can still reach the
  network through WebRTC ICE until Chromium enforces `webrtc 'block'`.

## Alternatives

- Fragments under `scratch/<sessionId>/`: rejected, it changes D114's
  "scratch is temporary" meaning for unclear ownership gain.
- Declarative JSON component trees: rejected, predefined components lose the
  expressiveness that motivates the feature.
