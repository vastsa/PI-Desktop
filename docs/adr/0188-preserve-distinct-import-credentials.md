# ADR 0188: Preserve distinct credentials during model configuration import

- Status: Accepted
- Date: 2026-09-08
- Deciders: PI-Desktop core
- Related: D342, D351, ADR 0179, E2E-209

## Context

CC Switch can keep several named profiles for one gateway endpoint. Those
profiles may use different API keys, such as separate accounts or quotas.

## Decision

1. An imported provider is equivalent only when its normalized endpoint, API
   style, and credential match an existing provider.
2. Profiles using different credentials at the same endpoint are created as
   independent provider rows and remain separately selectable in the Composer
   model menu.
3. Electron main resolves existing API keys through the host secret boundary for
   the comparison.
4. A no-credential candidate only matches another no-credential provider at the
   same endpoint and API style.
5. The live-tool-versus-CC Switch scan applies the same credential-aware rule,
   so an identical live profile is omitted while a different-key profile is
   retained.

## Consequences

- Multiple CC Switch profiles for one gateway can be imported in one run.
- Re-importing an unchanged profile still reports it as skipped.
- If a source key changes, import creates a new independent row; the old row is
  not overwritten.

## Alternatives

- Endpoint-only matching was rejected because it loses valid credentials.
- Matching by display name was rejected because names are editable and are not
  stable credentials.
- Updating an existing row with the new key was rejected because it would
  overwrite a working account and violate the explicit import review boundary.
