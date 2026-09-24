# ADR pi-npm-skill-discovery: Discover installed pi skills before explicit import

- Status: Accepted for implementation
- Date: 2026-09-21
- Related: Issue #236, ADR 0112, ADR 0214, ADR 0215

## Context

A pi CLI npm package can declare skills that Desktop cannot discover. The
existing importer already preserves these skills and their resources, but
requires the user to locate a hidden package directory. Automatically loading
these packages would bypass the explicit trust decision, particularly for
packages that also contain executable extensions.

## Decision

The Skills page requests read-only candidates from the installed package level
of `~/.pi/agent/npm/node_modules`, including scoped packages. Electron main
reuses the existing `pi.skills` declaration parser. Discovery neither imports
nor executes code. Package metadata is bounded to 256 KiB and contribution
traversal retains the importer's bounds and path validation. Metadata reads
are asynchronous; hoisted npm dependencies do not impose a skill-discovery
cutoff. Invalid packages and unreadable scopes produce diagnostics without
hiding valid peers.

The renderer sends a candidate identifier, never a source path. Main rediscovers
the candidate, displays native confirmation including its source and whether it
contains executable extensions, and revalidates its metadata and skill paths
before using the existing import, restricted dependency installation, host
registration and plugin runtime path. Cancellation is the default. Concurrent
imports are rejected. Existing registered imports, including disabled plugins,
are identified using host-owned plugin descriptions; orphaned import directories
are not an enablement registry and do not block retries.

This narrowly amends the discovery wording of ADR 0214. ADR 0112's `.agents`
capability roots are unchanged: candidates are not enabled user-skill records.
No automatic import, CLI configuration mutation, background synchronization,
or new database schema is introduced. Broader pi package management remains
outside this change.

## Consequences

Users can find and explicitly import the package reported in #236 from Skills.
Imported packages remain managed in Plugins, where disable, reload and uninstall
retain their existing behavior. Source changes are not automatically copied.
Only the installed global npm package location is covered; this does not promise
support for every CLI custom path, linked package or third-party extension API.

## Alternatives

- Keep manual directory selection: preserves trust but leaves discovery missing.
- Load all discovered skills: rejected because it silently changes model input
  and may enable executable package contributions without consent.
