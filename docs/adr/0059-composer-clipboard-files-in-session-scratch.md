# ADR 0059: Persist Composer Clipboard Files in Session Scratch

- Status: Accepted (amended 2026-09-14, issue #138, which replaced the clipboard
  selection rule)
- Date: 2026-08-05
- Related: D114, D119, D197, D209, ADR 0024, ADR 0070, ADR 0131

## Context

The composer is a controlled textarea: Chromium exposes pasted operating-system
files and screenshots as `File` objects, while the native picker exposes files
that may live outside the active workspace. The text-only prompt contract has no
binary `ImageContent` channel, an attached file must remain available to the
agent after the prompt is sent, and writing the bytes into the project would
dirty git state.

## Decision

Native directories stay path references, per the
[directory-reference amendment](composer-pasted-directory-references.md); this
byte contract covers files and images only.

1. The renderer intercepts paste only when the clipboard holds `File` objects;
   text-only paste stays native textarea behavior. It prefers editable text when
   that text is not whitespace-only and every accompanying file is `image/*`
   resolving to no native path; any native path, non-image file, or absent or
   whitespace-only text keeps the attachment flow.
2. The renderer transfers bounded bytes plus name and MIME type to Electron main
   through `composer/pasteFiles` with the durable session id; native picker
   selections use `composer/importFiles`.
3. Main validates the session, bounds the payload, strips directory components
   and unsafe name characters, and writes unique files with exclusive-create
   semantics below `<data_dir>/scratch/<sessionId>/pasted/`; the renderer cannot
   choose the destination and picker paths resolve through `realpath` to regular
   files only.
4. Main returns each UUID-backed absolute path plus its sanitized leaf name, which
   ADR 0070 renders as a compact chip and serializes into the prompt as an `@`
   reference, so prompt and transcript carry paths, never clipboard bytes.
5. Pasted files follow the existing scratch lifecycle and never change project
   git status; text above ADR 0131's `largePasteThreshold` likewise becomes a
   session scratch `text/plain` reference.

The bridge is Electron-only: it adds no host RPC method and exposes no arbitrary
filesystem write access to the renderer.

## Consequences

- File and image paste works from home and docked composers without a project
  file mutation, with leaf-name chips in the draft and `@absolute/path`
  references in the dispatched prompt.
- Large or malformed payloads fail visibly and write nothing.

## Alternatives

- Insert the browser file name only: loses the bytes and gives no usable path.
- Send binary inline with the prompt: changes the text-only contract and needs
  provider-specific attachment handling.
