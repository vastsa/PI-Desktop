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
at the same time, the limit on one resource.

## Decision

The document bound and the package bounds are separate:

- `MAX_SKILL_BYTES` (128 KiB) remains the cap on a skill document.
- `MAX_SKILL_RESOURCE_BYTES` (2 MiB) is the new cap on one package resource.
- `MAX_SKILL_PACKAGE_FILES` is 256 and `MAX_SKILL_PACKAGE_BYTES` is 16 MiB.

Capture and apply both compare a resource against `MAX_SKILL_RESOURCE_BYTES`,
and `read_remote_revision` uses that same constant, so an upload the packager
accepted is always readable back. Capture compares a resource against its
metadata length before reading it, so an oversized file is refused without being
loaded into memory first.

## Consequences

- A package may now be 32× larger than before (512 KiB → 16 MiB) and hold 4×
  more files.
- Resources share the existing 4096-object ceiling for one revision across all
  domains; roughly sixteen maximum-size packages fill it, and the existing
  `CONFIG_SYNC_LIMIT_EXCEEDED` error is what a user sees beyond that.
- A bound is still all-or-nothing.
- The descriptor list of a package travels in the entity payload, which keeps
  its own 512 KiB bound.
- No migration. The bounds are checked at capture and apply, never stored, so
  existing packages and revisions keep working; only previously refused packages
  start being accepted.

## Alternatives

- **Raise the single shared constant.** Rejected: a 2 MiB `SKILL.md` is a prompt
  problem, not a package problem, and the market path inlines sibling resources
  into a document that must stay prompt-sized.
- **Raise only the packager bounds.** Rejected: it splits the packager from the
  receiver and converts a local refusal into a cross-device sync failure.
- **Filter junk directories and skip symlinks instead of raising bounds.**
  Rejected for this record: filtering changes which bytes a package carries, so
  it is a packaging-semantics decision on its own, not a bound to widen.
