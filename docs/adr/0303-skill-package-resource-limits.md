# ADR 0303: A skill package carries resources far above the document cap

- Status: Accepted for implementation
- Date: 2026-09-22
- Amends: ADR 0300 (the "bounded Skill package resources" of the configuration
  sync baseline now have concrete values, separate from the document cap, and a
  receiver bound that matches the packager)
- Related: [03-runtime/22-config-sync](../spec/03-runtime/22-config-sync.md) ·
  ADR 0243 (the document cap the market path enforces, unchanged)

## Context

A directory-shaped skill is a `SKILL.md` document plus sibling resources, and one
constant bounded both: `MAX_SKILL_BYTES` was the document limit and the limit on
one resource, while the packager added its own resource count and total and the
receiver kept a third copy of the per-resource number. The document limit exists
because a document can be handed to the model; a resource is data or a script
read from disk on demand, so it has no reason to inherit a prompt-sized bound. The
failure was not graceful either: `package_files` returns `Err`, the skills capture
propagates it, and one oversized skill failed the whole capture and every sync
domain with `SKILL_LIMIT_EXCEEDED`.

## Decision

The document bound and the package bounds are separate: `MAX_SKILL_BYTES` stays
the cap on a skill document, `MAX_SKILL_RESOURCE_BYTES` is 2 MiB for one package
resource, `MAX_SKILL_PACKAGE_FILES` is 256, and `MAX_SKILL_PACKAGE_BYTES` is
16 MiB. Capture, apply, and `read_remote_revision` all compare against
`MAX_SKILL_RESOURCE_BYTES`, so an upload the packager accepted is always readable
back, and capture compares a resource against its metadata length before reading
it so an oversized file is refused without being loaded. Package paths, symlinks,
collisions, the document cap, and the resource-per-object transport are unchanged.

## Consequences

- A package may be far larger and hold more files, while each resource is still one
  WebDAV object and shares the existing per-revision object ceiling, beyond which
  `CONFIG_SYNC_LIMIT_EXCEEDED` is reported.
- A bound is still all-or-nothing: an oversized resource, too many resources, or
  too much total resource data still fails the capture and every sync domain.
- No migration is needed because bounds are checked at capture and apply rather
  than stored, the prompt-facing 128 KiB document limit and ADR 0243 stand, and a
  device on an older build still enforces its own per-resource bound on read.

## Alternatives

- Raise the single shared constant — rejected: a 2 MiB `SKILL.md` is a prompt
  problem, and the market path inlines resources into a prompt-sized document.
- Raise only the packager bounds — rejected: it turns a local refusal into a
  cross-device sync failure.
