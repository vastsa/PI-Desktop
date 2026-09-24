# ADR 0303: A skill package carries resources far above the document cap

- Status: Accepted for implementation
- Date: 2026-09-22
- Amends: ADR 0300 (the "bounded Skill package resources" of the configuration
  sync baseline now have concrete values, separate from the document cap, and a
  receiver bound that matches the packager)
- Related: [03-runtime/22-config-sync](../spec/03-runtime/22-config-sync.md) ·
  `crates/host-core/src/user_skills.rs` · ADR 0243 (the document cap the market
  path enforces, unchanged)

## Context

A directory-shaped skill is a `SKILL.md` document plus sibling resources. One
constant bounded both: `MAX_SKILL_BYTES` (128 KiB) was the document limit and,
at the same time, the limit on one resource. The packager added a second pair —
at most 64 resources, at most 512 KiB of resources per package — and the
receiver kept a third copy of the per-resource number, refusing any resource
above 128 KiB when a revision was read back.

The document limit exists for a prompt-sized reason: a document can be handed to
the model. A resource is not prompt content. It is data or a script that stays
on disk and is read on demand, so sharing the document's constant with it made
the package bound an accident of the document bound.

The cost was not a graceful skip. `package_files` returns `Err` and the skills
capture propagates it, so one oversized skill failed the whole capture and, with
it, the sync of every domain. A real skill (a design-reference skill carrying
3.7 MiB of CSV and JSON in 76 files, largest file 808 KiB) reproduced exactly
that: config sync reported `SKILL_LIMIT_EXCEEDED: skill package is too large`
and stopped. Raising the packager bound alone would have been worse than the
failure it fixed — the revision would upload and then fail on the other device,
where the receiver still enforced 128 KiB.

## Decision

The document bound and the package bounds are separate:

- `MAX_SKILL_BYTES` (128 KiB) remains the cap on a skill document.
- `MAX_SKILL_RESOURCE_BYTES` (2 MiB) is the new cap on one package resource.
- `MAX_SKILL_PACKAGE_FILES` is 256 and `MAX_SKILL_PACKAGE_BYTES` is 16 MiB.

Capture and apply both compare a resource against `MAX_SKILL_RESOURCE_BYTES`,
and `read_remote_revision` uses that same constant, so an upload the packager
accepted is always readable back. Capture compares a resource against its
metadata length before reading it, so an oversized file is refused without being
loaded into memory first. Package paths, symlinks, collisions, the document cap,
and the resource-per-object transport are unchanged.

## Consequences

- A package may now be 32× larger than before (512 KiB → 16 MiB) and hold 4×
  more files. Sync volume, capture memory, and the number of WebDAV objects per
  revision grow with it; each resource is still one object, so no single request
  exceeds the per-resource cap.
- Resources share the existing 4096-object ceiling for one revision across all
  domains; roughly sixteen maximum-size packages fill it, and the existing
  `CONFIG_SYNC_LIMIT_EXCEEDED` error is what a user sees beyond that.
- A bound is still all-or-nothing. `package_files` returns an error that the
  skills capture propagates, so one resource above 2 MiB, more than 256
  resources, or more than 16 MiB of resources in one package still fails the
  capture, and with it the sync of every domain. This record moves the bound; it
  does not make an oversized package skippable.
- The descriptor list of a package travels in the entity payload, which keeps
  its own 512 KiB bound. A package with 256 resource paths long enough to push
  that payload over the bound is therefore refused at upload
  (`CONFIG_SYNC_LIMIT_EXCEEDED: local entity is too large or unsupported`)
  rather than at capture, which is a sharp edge of the wider file count.
- No migration. The bounds are checked at capture and apply, never stored, so
  existing packages and revisions keep working; only previously refused packages
  start being accepted.
- Prompt-facing behavior is unchanged: the editor counter, the market install
  check, and their copy still describe a 128 KiB document, and ADR 0243 stands.
- Known gaps are not addressed here. Junk directories (`__pycache__`, `.venv`,
  `.git`) are still packaged and now consume the larger budget, and one symlink
  anywhere in a package still fails the whole capture rather than being skipped.
  A device running an older build still enforces 128 KiB per resource on read,
  so a package accepted here is not readable by it.

## Alternatives

- **Raise the single shared constant.** Rejected: a 2 MiB `SKILL.md` is a prompt
  problem, not a package problem, and the market path inlines sibling resources
  into a document that must stay prompt-sized.
- **Raise only the packager bounds.** Rejected: it splits the packager from the
  receiver and converts a local refusal into a cross-device sync failure.
- **Filter junk directories and skip symlinks instead of raising bounds.**
  Rejected for this record: filtering changes which bytes a package carries, so
  it is a packaging-semantics decision on its own, not a bound to widen.
