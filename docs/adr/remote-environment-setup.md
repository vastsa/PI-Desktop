# ADR: Remote environment setup scripts and variables

- Status: Accepted
- Date: 2026-11-20
- Related: D692, [Environments and composer session targets](environments-and-session-targets.md)

## Context

Different repositories can need dependencies or environment variables before
the Agent starts working in a new checkout.

## Decision

A user can edit an environment from the home composer or from Remote Hosts
settings. They can enter a setup script and variables as part of that
environment. A new worktree runs the script before the first prompt dispatches.
The Host rejects reserved variable names, duplicate names, and oversized inputs.
Tools inside the worktree receive the saved variables. The worktree becomes
usable after a script failure, with the bounded log tail available in the
composer. When the Host restarts, interrupted setup is recorded as failed.

## Consequences

Configuration is reusable for new sessions on the selected Host. Existing
worktrees keep the environment used at preparation. Variables are stored as
environment configuration, so they should contain configuration values
appropriate for the paired Host.
