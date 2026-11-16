# ADR 0339: Chat file references open absolute files outside the managed roots

- Status: Accepted
- Date: 2026-11-03
- Related: ADR 0172, ADR 0249, ADR 0262, ADR 0263,
  `docs/spec/03-runtime/01-ipc-protocol.md` § fs, issue #1837
- Amends: ADR 0262 §4

## Context

The agent references files by exact absolute path and routinely works outside the
open project: downloads, a chat client's folder, the temporary directory, or any
path in a session with no project. Because `fs/resolveRef`, `fs/read`, `fs/reveal`,
and `fs/open` answered by root containment, every correct absolute link outside
the project, scratch, and attachment roots reported "outside the locations this
app can access" (#1837). The restriction protected nothing: the agent already
reads those files with its own tools, and opening a clicked file shows the user
their own bytes, which reach neither the model nor the network.

## Decision

1. A user-initiated open of an exact absolute path outside every managed root
   needs one shape check instead of containment: the path is absolute, with no
   `~`, relative shorthand, or `attachments/<sha256>`, and its real path is an
   existing regular file.
2. The rule lives in `packages/host-runtime/src/external-files.ts`
   (`resolveExternalFile`, `resolveUserOpenablePath`, `readUserOpenableFile`) and
   is applied by `fs/read`, `fs/reveal`, and `fs/open`, while containment still
   answers first and `fs/resolveRef` reports an outside match through
   `resolveExternalChatRef` as `root: "external"`, `matchedBy:
   "exact-absolute"`, or `match: null`.
3. A shorthand never resolves outside the managed roots, and an outside absolute
   path never falls back to a same-name file inside a root.
4. A Markdown link with an absolute destination reaches the opener without a file
   extension, because the host decides instead of a renderer filename heuristic;
   bare prose tokens keep the extension heuristic.
5. `fs/list`, `fs/readImageDataUrl`, remote and headless-host reads, the
   `pi.file-manager` plugin's own deny list, and renderer routing are unchanged,
   and an external `.html` file opens as source in the `file:` tab, never in the
   side browser.

## Consequences

- A correct absolute link to an ordinary file anywhere on the machine opens,
  including in sessions without a project and inside temporary directories.
- `fs/open` can hand such a file to its OS default application, the same
  capability the agent's shell already has, and still only when the user chooses
  that destination.
- `FsChatRefRoot` gains `"external"` for consumers that switch on it, and
  `reason: "outside-allowed-roots"` remains only for an outside reference that is
  not an exact absolute path.

## Alternatives considered

- Credential deny list on the host: rejected; showing a user their own file
  discloses nothing and made correct links to dotfiles fail.
- Ask the user to grant each outside folder: rejected; verification runs without
  a click, so the prompt would fire anyway.
