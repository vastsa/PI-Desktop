# ADR 0059: Persist Composer Clipboard Files in Session Scratch

- Status: Accepted
- Date: 2026-08-05
- Deciders: PI-Desktop core
- Related: D197, D209, ADR 0024 (composer commands and @ file references), ADR 0070 (compact reference display), D114 (session scratch directory), D119 (transcript file store)

## Context

The composer is a controlled textarea. Chromium exposes pasted operating-system
files and screenshots as `File` objects, while the native picker exposes files
that may live outside the active workspace. The text-only prompt contract has
no binary `ImageContent` channel and an attached file must remain available to
the agent after the prompt is sent. Writing the bytes into the project would
dirty git state and would not follow the session-bound workspace/scratch
ownership rules.

## Decision

1. The renderer intercepts paste only when the clipboard contains one or more
   `File` objects. Text-only paste remains native textarea behavior.
2. The renderer transfers bounded file bytes plus the browser-provided name and
   MIME type to Electron main through `composer/pasteFiles`, together with the
   durable session id. A home composer creates or reuses a session before the
   transfer. Native picker selections use the additive `composer/importFiles`
   channel with the same session id; main resolves and copies those source
   paths before returning references to the renderer.
3. Electron main validates that the session exists, limits the request to 20
   files, 64 MiB per file, and 128 MiB total, strips directory components and
   unsafe name characters, and writes unique files with exclusive-create
   semantics below:

   ```text
   <data_dir>/scratch/<sessionId>/pasted/
   ```

4. Main returns each UUID-backed absolute path plus its sanitized original leaf
   name. Under ADR 0070 the renderer keeps the path in transient reference
   state, shows the leaf name as a compact chip, and serializes the path into
   the prompt as an `@` reference using the existing whitespace quoting rule.
   The prompt and transcript carry paths, never clipboard bytes.
5. Pasted files follow the existing scratch lifecycle: deleting the session or
   the orphan/stale startup sweep removes them. They are not workspace
   artifacts and never change project git status.

## Security and boundary notes

- The renderer cannot select the destination directory; the session id is
  checked in main and the output root is constructed from the host data dir.
  Picker source paths are resolved through `realpath` and must be regular files;
  they never become prompt references or destination paths.
- Renderer names are reduced to a basename and sanitized. A UUID prefix and
  exclusive creation prevent collisions and overwrite-by-name.
- The bridge is Electron-only. It adds no host RPC method and does not expose
  arbitrary filesystem write access to the renderer.

## Alternatives considered

- **Insert the browser file name only:** loses the bytes and gives the agent no
  usable path. Rejected.
- **Write into the workspace:** makes a normal paste dirty the project and
  breaks session scratch isolation. Rejected.
- **Send binary inline with the prompt:** changes the text-only prompt contract,
  inflates context, and requires provider-specific attachment handling.
  Rejected.
- **Use an Electron file picker for paste:** does not support screenshots and
  adds an extra interaction for the common clipboard workflow. Rejected as the
  paste path; the separate picker upload action now reuses this scratch
  contract for explicitly selected files.

## Consequences

- File and image paste works from both home and docked composers without a
  project file mutation.
- The visible draft gains compact leaf-name references; the dispatched prompt
  gains the same normal `@absolute/path` references, so existing Read/Glob/Grep
  behavior handles the materialized files.
- Large or malformed clipboard payloads fail visibly in the composer and do
  not partially write because bytes are validated before the first write.
