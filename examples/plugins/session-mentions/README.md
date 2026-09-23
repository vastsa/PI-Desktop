# Session Mentions

A local-session reference plugin implemented on `completionSource`,
`composerReference`, and the permissioned `input` (Before Send) runtime hook.
This replaces the host-specific implementation in PR #447. It depends on
`feat/528-plugin-slots` and the small generic contract completions in this PR;
it is **not compatible with a main/release build without those contracts**.

## Build and install for development

From the repository root, using its existing Node/pnpm environment:

```sh
pnpm exec tsc -p examples/plugins/session-mentions/tsconfig.json
node examples/plugins/session-mentions/test/run.mjs
```

Load `examples/plugins/session-mentions` using Extensions > Load local plugin.
Use the plugin-folder loader, not Import pi extension: both its renderer and
headless entry are needed. The build creates the `dist/` files imported by the
entries; loading an unbuilt source folder is not supported.

## Behavior

Type `@`, select a session in the **Sessions** section below the built-in file
rows, and send. The draft holds `@session:<uuid>`; title chips are drawn by the
existing reference slot **below the editor**, not by a new native file-chip
kind. Click a title chip to open its session. Edit/delete its literal token to
remove the reference. Only local desktop UUID sessions are supported; native
and remote session namespaces are deliberately excluded. Plugin rows have
click/keyboard-button activation; the host's arrow-key highlight still owns
only the built-in rows.

Before the draft is cleared or queued, the reference slot validates it. The
runtime rechecks the authoritative context at admission, then transforms the
model's copy through `input`. Its rewrite is recorded by the host and remains
inspectable. A blocked runtime admission now rejects the sidecar RPC before
acknowledgement, letting the existing composer restore its captured draft.
Steering consults the same input hook and revalidates the target turn afterward.

The plugin reads physical transcript pages through host APIs, never SQLite,
raw files, or a private renderer store. It keeps complete parent Q&A, not
thinking, tools, delegates, partial answers, or attachment contents. Sources
share one budget; the newest complete turn in every nonempty source must fit.
Older complete turns fill the remainder, and omission/unread coverage is explicit.
Nested references are not recursively expanded. Token counting is a UTF-8
estimate, not a tokenizer or a mathematical upper bound.

Budget options (10/25/50/100%, default 25%) live in this plugin's settings, not
Settings > AI. Output, prompt and attachment reserves are subtracted first.
Unknown runtime occupancy blocks rather than inventing free capacity. The
runtime receives its own non-secret settings snapshot on launch. Changing
settings during a running turn takes effect on the next runtime launch.

## Deliberate boundaries

A queued message is prechecked when queued and resolved again when it actually
starts, using that time's history and remaining budget. A later failed queued
admission stays recoverable through the host queue, rather than overriding a
newer composer draft. This is **not** the old PR's submit-time frozen queued
snapshot. Draft chips use the current slot's placement; historical plain-text
UUID mentions are not converted into native clickable transcript chips.

Host input-handler exceptions/timeouts retain the existing no-op policy.
This plugin catches its failures and has a 20-second deadline below the host's
30-second deadline; the renderer validation itself fails closed on timeout,
unload or error. An explicitly disabled/uninstalled plugin cannot expand a
plain-text token. Durable user rows and rewrite audit records may already exist
when runtime admission rejects; "blocked" means no provider execution, not a
database rollback. No model requests are issued by validation.

## Public contracts completed here

- Completion props add a session identity and a stale-safe `acceptText` callback.
- Reference registrations may validate sends before draft clearing/queuing.
- Permissioned session recap accepts an explicit target and a physical cursor,
  and returns physical bounds. The existing two read grants still apply.
- Extensions can read their own non-secret launch-time settings snapshot.
- The sidecar awaits the existing Before Send result, not model execution,
  before acknowledging; admitted input is marked once so it is not transformed twice.

These contracts are generic and contain no session-mention parser or UI policy.
All feature-specific behavior remains in this plugin. Tests cover the real
plugin entry and the real runtime/slot seams; they do not claim a live Windows
application or real-model end-to-end run.
