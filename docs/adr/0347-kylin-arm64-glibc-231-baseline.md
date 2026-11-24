# ADR 0347: Build Linux host-core against glibc 2.31

- Status: Accepted
- Related: ADR 0145, ADR 0318, Issue #2

## Context

The native Linux release runners use Ubuntu 22.04. The binary they build
cannot load on the Galaxy Kylin V10 SP1 (2403) ARM64 desktop, whose target
glibc is 2.31. Changing the app's startup minimum leaves the binary unchanged.

## Decision

Build Linux host-core inside the official Debian 11 Rust image, on the
matching native architecture. Use the resulting binary for Linux desktop and
pi-host packaging. Keep the packaged load-time floor at glibc 2.31 and check
the actual Debian payload, including the Electron executable. Preserve the
packager's default Debian dependencies and declare the additional core,
audio, and graphics runtime libraries explicitly.

## Consequences

The Linux release needs Docker for the Rust build. The runner can continue
using a newer distribution for JavaScript tooling. A successful binary
inspection does not qualify a package for offline installation until the
clean Kylin desktop passes the delivery procedure.
