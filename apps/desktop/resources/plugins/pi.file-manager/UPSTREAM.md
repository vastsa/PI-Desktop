# Vendored upstream

`pi.file-manager` is a third-party plugin that also ships through the official
marketplace. This directory is a vendored copy of one released version, so that
every installation has a file view out of the box (ADR 0241).

## Origin

| Field | Value |
| --- | --- |
| Repository | https://github.com/Tioit-Wang/pi-desktop-plugin-file-manager |
| Tag | `v0.5.2` |
| Commit | `d36ebe9f7fb82ee71e87670b0a65403660b18a00` |
| License | MIT (see `LICENSE`; upstream ships no license file) |
| Marketplace base | `pi.file-manager` 0.5.2, artifact `c8416b755e5624ad30110176caa512cd433fdf699ef32c7a2ba2df7f2df2b0f5` (1462096 bytes) |
| Bundled version | `0.5.3-pi.1` — PI-Desktop hotfix rebuilt from the tagged source |

The official marketplace now offers newer upstream releases. The bundled
hotfix remains based on 0.5.2 so this maintenance PR does not pull unrelated
features into the app. Its prerelease version is strictly above 0.5.2, so the
app repairs an equal-version marketplace install, and below stable 0.5.3 and
all 0.6+ releases, so a newer user-installed copy still wins `sync_builtin`.

> The published `.piplug` contains the seven files a plugin installs from
> (`manifest.json`, `main.js`, `README.md`, `CHANGELOG.md`, `.gitignore`,
> `views/index.html`, `views/assets/index.js`) and **not** `views-src/`: the
> artifact ships the built view, never its React source. `pi-plugin pack` on the
> repository root includes `views-src/`, and the plugin center's audit rejects
> such a package as four blockers before it can be submitted — pack from a copy
> of the tagged tree with `views-src/` removed instead.

The files below record the unmodified 0.5.2 base. Local rebuilds and metadata
changes are listed separately with their shipped hashes. Line endings are LF:
the upstream commit stores LF, and this repository's `.gitattributes` keeps it
that way.

## Upstream checksums (sha256)

| File | Bytes | sha256 |
| --- | --- | --- |
| `main.js` | 63234 | `43cface10124728f16e72530e699678177f97353b57190532e89c03186e6960d` |
| `README.md` | 20039 | `8c524f6d13eac557e286fa0ec9b9cf5138bed0bd66d4a7914f3484443e627a01` |
| `views/index.html` | 345 | `771fd3d8afdea7fca75ed1f1918c1ce93ad1c87babdb321cfb85e910465cd2c1` |
| `views/assets/index.js` | 1345417 | `d0a1dc369764bed2ab12ce0e65fe983fe0b4f9919f2f8ff4546b736208d66dac` |
| `manifest.json` | 14171 | `751a5c86d6e4901cf7fc7f5d9e1de99c90c6dc0798b316500d20781d779e4188` |

`views-src/` from the upstream repository is deliberately not vendored: this
directory carries the built view the plugin publishes, not its React source.

## Local changes

Three local changes, plus an upstream fix proposal, so a re-sync stays deliberate:

- `manifest.json` gains `"license": "MIT"`, advances the local bundled version
  to `0.5.3-pi.1`, and prepends the dark-search hotfix changelog. The shipped
  copy is 14614 bytes
  (`a54f196da16372ece0fe4b8def438bc94df6e0305fc91d03898efc6005c7a6c3`).
  The prerelease suffix is intentional: host version ordering puts it above the
  0.5.2 base but below stable 0.5.3 and every 0.6+ marketplace release.
- `package.json` is **added**, containing `{"type": "commonjs"}`. It is not in
  the upstream release and not in the published `.piplug`. `main.js` is
  CommonJS, and `apps/desktop/package.json` declares `"type": "module"`, so in
  a checkout every `.js` beneath it — this one included — is classified as ESM
  and the host's `require()` fails with "require is not defined in ES module
  scope". The marker is Node's own mechanism for that and scopes the correction
  to this plugin alone; `pi.browser` is ESM and must keep inheriting the
  ancestor's `"module"`, which is why the marker cannot live one directory up.
  In a packaged app the file is inert, and deleting it only costs the developer
  experience, never a user.
- `views/assets/index.js` is rebuilt from the tagged `views-src` after adding
  theme-token styles for CodeMirror's `.cm-panel.cm-search` text fields and
  buttons. CodeMirror otherwise applies its light defaults to those controls,
  producing white text on white fields when the plugin follows the dark app
  appearance. The local bundle is 1345983 bytes
  (`26b7d0d47992d0c4dbe77cb47f13238a85fac1f027b47391daf20bf1e6471cf1`).
- The same source fix is proposed against upstream `main` in
  [Tioit-Wang/pi-desktop-plugin-file-manager#6](https://github.com/Tioit-Wang/pi-desktop-plugin-file-manager/pull/6),
  where it can ship in a release newer than the marketplace's current 0.9.0.

## Re-syncing a newer release

1. Check out the new upstream tag and confirm the marketplace entry points at
   the same bytes.
2. Replace the four upstream files above (`main.js`, `README.md`,
   `views/index.html`, `views/assets/index.js`) plus `manifest.json` with the
   tag's copies, **as LF**: `git archive` applies the checkout's line-ending
   conversion, so extract the blobs from the working tree (or with
   `git cat-file blob`) instead of from an archive.
3. Re-apply `"license": "MIT"` and the local hotfix version/changelog to
   `manifest.json`, and re-create `package.json` — those are local additions.
4. Update `Origin`, the base and shipped checksum records, and the commit hash
   `bundled-plugins.test.mjs` pins, then run
   `node --test test/bundled-plugins.test.mjs` in `apps/desktop`.
5. If the upstream fix has shipped, replace this hotfix with that release and
   return the manifest to the exact upstream stable version.

## What 0.5.2 adds

A folder switch that looked like it worked but did not. The host reports a project
folder with forward slashes (`C:/Users/.../Docs`) while this plugin's own process
stores the remembered choice through Node's `path.resolve`, i.e. with backslashes
(`C:\Users\...\Docs`). `samePath` / `matchRoot` compared the two forms literally and
then case-insensitively, never separator-insensitively, so the value just written
matched no root at all: the containment base fell back to the primary folder. The
view's header still showed the sibling folder (it compares its own untouched copy of
the host string), while the main process listed and read the primary folder - and
reopening the view lost the choice entirely.

`canonicalPath` now folds backslashes to forward slashes (trailing separators and the
case-insensitive fallback stay as they were) in both implementations, so a memory
written before this release heals as well; nobody has to switch again. The tests grew
the shape they had missed: the jail harness now reports folder roots with forward
slashes like the real host, with a section that fails without the fix, and the pure
checks assert that the same directory in either spelling matches.

> The published 0.5.2 package's `manifest.json` carries CRLF: it was packed from a
> Windows checkout that had rewritten that one file. Every other file in the package,
> and every file in this vendored copy, is LF - so a re-sync should expect the tag's
> bytes, not the artifact's manifest.

## What 0.5.1 adds

Two defects of 0.5.0 on the folder switch:

- Opening a file with the system default app, or revealing it in the file manager,
  named the entry relative to the folder the view was browsing. The host resolves a
  relative path against the **workspace** root, so with a sibling folder selected a
  same-named file in the primary folder opened instead, and a file only the sibling
  folder holds reported not found. The view now sends an absolute path whenever the
  selected folder is not the primary one, and the host accepts an absolute path that
  lies inside a registered folder root of the open project (ADR 0253) — for those two
  actions only, with the declared scope, the credential deny list and the
  protected-path guard unchanged.
- The editor pane showed its empty state while its buffer still held the previous
  folder's document, so switching back to a same-relative-path file or pressing
  Ctrl+S met the other folder's content. The document is cleared when the open file
  closes.

## What 0.5.0 adds

A project can be a group of local folder roots, and the view now learns that:
`pi.workspace.get()` and the `workspace:changed` event carry `projectId` and
`roots` (`{ path, name, primary }[]`, group order, primary first) beside the
unchanged `path` / `name`. The folder name in the view's header becomes a switcher
when the group holds more than one folder, and the choice is remembered per project
in the view's own `prefs.projectRoots` — it never changes the workspace, the agent's
tool roots, a session's primary path or project instructions.

The containment base is still exactly one registered root at a time, never the
union of the group: listing, reading, writing, search and SQLite all resolve against
the selected folder, with the same symlink and junction refusals and the same
credential deny list. An absolute path the host asks this view to open that lies
under another folder of the same project switches the base to that folder first and
is then resolved relative to it — which is what lets a chat file reference that
completes into a sibling folder open in the view instead of as an external file.

## What 0.4.0 adds

The host can hand a contributed view one file to show: the reference travels as
the view entry URL's `piViewOpen` query parameter on creation, and as the
`view:open` preload event once the view is loaded. A chat file reference uses
that to open in this view instead of the host file tab, and the view collapses
its own left file list when the host asks it to show a file. The view also
accepts absolute paths outside the project root — the session scratch and
attachment stores the host itself picked — which is why its `safetyNotes`
discloses that exception instead of claiming the project-root containment still
covers everything it reads.
