# ADR 0339: Chat file references open absolute files outside the managed roots

- Status: Accepted
- Date: 2026-11-03
- Deciders: PI-Desktop maintainers
- Related: ADR 0262 (chat file refs open in the file view), ADR 0172 (fs read
  containment), ADR 0249 / ADR 0263 (project folder groups),
  `docs/spec/03-runtime/01-ipc-protocol.md` § fs, issue #1837
- Amends: ADR 0262 §4

## Context

The agent is instructed to reference files by their exact absolute path, and
it routinely works on files outside the open project: a download, a chat
client's folder, the system temporary directory, or any path in a session with
no project at all. The main process answered `fs/resolveRef`, `fs/read`,
`fs/reveal`, and `fs/open` by **root containment** — the project folders, the
session scratch store, the whole scratch store, and the attachment store. Every
correctly written absolute link to a file outside those roots therefore
reported "outside the locations this app can access" and could not be opened
(#1722 follow-up, #1837).

The restriction protected nothing. The agent reads and writes those files with
its own tools, and a renderer that can issue arbitrary IPC already controls the
agent. Opening a file the user clicked shows it to that same user on this
machine: the bytes reach neither the model nor the network. A credential deny
list was considered to stop a prompt-injected link to
`~/.ssh/id_ed25519`, but such a click only shows the user their own file — there
is no disclosure to defend against. Comparable agent desktops (ZCode 3.16)
open any clicked local file, dotfiles included, and hand any file to the OS
default application without a deny list.

## Decision

1. For a **user-initiated open of an exact absolute path** outside every
   managed root, the host replaces containment with one shape check: the path
   is absolute (no `~`, no relative shorthand, no `attachments/<sha256>`) and
   its real path is an existing regular file. No path is withheld, dotfile
   folders such as `.ssh` included.
2. The rule lives in one module, `packages/host-runtime/src/external-files.ts`
   (`resolveExternalFile`, `resolveUserOpenablePath`, `readUserOpenableFile`),
   and is applied by `fs/read`, `fs/reveal`, and `fs/open`. Containment still
   answers first, unchanged. `fs/resolveRef` answers an absolute outside
   reference with `resolveExternalChatRef`: a match with the new
   `root: "external"`, `matchedBy: "exact-absolute"`, or `match: null` when no
   regular file is there.
3. A shorthand never resolves outside the managed roots, and an outside
   absolute path never falls back to a same-name file inside a root.
4. A Markdown link whose destination is an absolute path reaches the opener
   even without a file extension (`/etc/hosts`, `.ssh/config`); the host, not a
   renderer filename heuristic, decides. Bare prose tokens keep the extension
   heuristic that decides which of them become chips.
5. Unchanged: `fs/list` (project only), `fs/readImageDataUrl` (inline chat
   images load without a click, so a model-written image reference must not
   render an arbitrary local image), remote and headless-host file reads
   (`apps/pi-host`), the `pi.file-manager` plugin's own deny list (plugin code
   receives the bytes), and the renderer routing, which already sends a
   non-project match to the host `file:` tab. An external `.html` file opens as
   source there, never in the side browser.

## Consequences

- Clicking a correct absolute link to an ordinary file anywhere on the machine
  opens it; sessions without a project and temporary directories work.
- An exact absolute path to an existing outside file now verifies as a chip in
  user messages too.
- `fs/open` can hand any such file to its OS default application, including a
  script or application bundle that the OS runs when "opened". That is the same
  capability the agent already has through its shell and that project files
  already had, and it still requires the user to choose the default-app
  destination.
- `FsChatRefRoot` gains `"external"`. Consumers that switch on the root treat
  any value other than `workspace` as an absolute-path file, so no consumer
  changes. `reason: "outside-allowed-roots"` keeps its shape and remains only
  for an outside reference that is not an exact absolute path.

## Alternatives considered

- **Credential deny list on the host.** Rejected: showing a user their own file
  discloses nothing, the agent can already read it, and the list made correct
  links to dotfiles fail.
- **Ask the user to grant each outside folder.** Rejected: the user asked for
  links that simply open, and `fs/resolveRef` also runs automatically for chip
  verification, so a grant prompt would fire without a click.
- **Keep containment and add the temp directory and downloads as roots.**
  Rejected: it fixes only the reported folders and leaves every other location
  (chat clients, mounted drives) broken.
