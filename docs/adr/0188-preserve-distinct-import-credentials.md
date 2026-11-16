# ADR 0188: Preserve distinct credentials during model configuration import

- Status: Accepted
- Date: 2026-09-08
- Related: D342, D351, ADR 0179, E2E-209

## Context

CC Switch can keep several named profiles for one gateway endpoint with different
API keys, for separate accounts or quotas. The original import idempotence rule
treated normalized endpoint and API style as the whole identity, so importing a
selection created the first profile and silently skipped the rest. The renderer
still must not receive raw credentials, and re-importing the same profile must
stay idempotent.

## Decision

An imported provider matches an existing one only when its normalized endpoint,
API style, and credential all match. Profiles with different keys at one endpoint
become independent provider rows that stay separately selectable in the Composer
model menu, while Electron main resolves existing keys through the host secret
boundary so raw values stay in main-process memory and never enter scan results,
renderer state, logs, or provider metadata. A no-credential candidate matches only
another no-credential provider at the same endpoint and style, and OAuth-only
credentials never match an API-key candidate. The live-tool-versus-CC Switch scan
applies the same rule, and no host protocol or storage schema version changes.

## Consequences

- Several CC Switch profiles for one gateway import in a single run, while an
  unchanged profile still reports as skipped.
- A changed source key creates a new row instead of overwriting the working
  account.
- Matching by display name or updating an existing row would lose or overwrite
  credentials, so neither is used.
