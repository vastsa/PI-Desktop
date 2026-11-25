# Changelog

## Desktop bundled configuration

- Enable automatic session titles on a fresh profile. Next-message suggestions,
  prompt enhancement, and AI memory are off until enabled in plugin settings.
- Keep previously saved choices and preserve manual session names.

## 0.10.0 — 2026-11-04

- Fix the next-message suggestion never appearing. Two independent defects kept
  it off: the manifest declared `session.read`, while `session.listMessages` is
  gated by `session.read.own` and answers only for sessions the plugin imported
  itself, and the read then looked for a `messages` field in a result that
  carries `items`, so even a successful read produced an empty excerpt and a
  wasted completion.
- Declare `session.read.all` (ADR 0339, host PR #2092) instead of the unused
  `session.read`. `.all` is a separate grant that reaches the conversations the
  user started in the app; plain `session.read` only ever covered
  `session.getLlmContext`, which this plugin does not call.
- Report a refused read instead of swallowing it. The empty `catch` turned
  `PERMISSION_DENIED` into `not-visible`, so the settings window had nothing to
  say and the capability looked unimplemented. A refusal now keeps the
  suggestion off, spends no completion, and shows the host's error code.
- Raise `engines.piDesktop` to `>=0.22.0-beta.4`, the first release that carries
  `session.read.all`.

## 0.9.1 — 2026-10-30

- Key a project by its normalized folder path, the same key the sidebar uses to
  group sessions. Project groups are no longer consulted, so the panel and the
  sidebar show one grouping instead of two: `F:\PI-Desktop`, `F:/PI-Desktop/` and
  the Windows extended-length form all resolve to one project.
- Keep 0.9.0 records that were keyed by a group id visible for their own folder,
  so the key change does not hide existing memories.

## 0.9.0 — 2026-10-30

- Give pending user-level proposals a home. The assistant could only suggest
  them and the suggestion was discarded with the tool result, so a user who saw
  the switch on could never find or confirm one. Proposals are now stored, listed
  in settings, and turned into entries by the user.
- Split the manager into two panes, list on the left and editor on the right, so
  a long list no longer pushes the form out of view. Widen the panel to 960x720
  to give both panes a usable column; a narrow window falls back to one column.
- Raise the storage schema to 3 and migrate forward from 1 and 2 in order, so a
  0.7.0 file gains the temporal fields and the empty proposal list.
## 0.8.0 — 2026-10-30

- Keep only the user and project memory levels. The session level is removed:
  mid-task context already lives in the transcript, and a second copy only
  added staleness and a session-switch race.
- Add per-entry labels with supersession. Saving the same label with new content
  retires the earlier row (`validUntil` + `supersededBy`) instead of deleting
  it, so facts stay auditable, revertible, and queryable as of a past moment.
- Make user-level assistant writes proposals. A user preference shapes every
  conversation, so the assistant now returns a proposal the user confirms in
  settings instead of writing it directly.
- Split limits per level: 500 characters / 50 entries for the profile, 2,000
  characters / 32 KB / 100 entries per project. Capacity errors are explicit
  rather than silent truncation.
- Migrate 0.7.0 files by dropping session entries and the `sessionEnabled`
  switch while keeping user and project rows. A read never rewrites the file.
- Fix the panel dropping `expectedRevision` on edit, which turned an edit into
  an insert.

## 0.7.0 — 2026-10-30

- Add optional local user, project, and session memories with separate level,
  AI recall, and AI write switches. Existing enhancements keep their defaults.
- Add English and Simplified Chinese memory management with add, edit, search,
  explicit delete confirmation, context-switch protection, and visible errors.
- Add a host-bound memory agent tool with bounded local retrieval and revision
  checks. The new `agent.tool.register` permission requires a grant when loading
  this version. Memory and AI writes start disabled.
- Persist versioned private records with serialized writes and atomic rename;
  reject corrupt or future-version storage without clearing it.
- Document source research and behavior contracts. Memory retrieval is on demand;
  no background extraction, cloud service, or automatic per-turn injection.
- Fix HTML generation so literal JavaScript dollar tokens survive template
  insertion; cover the generated script with a syntax regression test.
