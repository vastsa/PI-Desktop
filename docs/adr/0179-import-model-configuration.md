# ADR 0179: Import model configuration from local agent stores

- Status: Accepted for model import semantics; original Settings placement
  superseded by ADR 0319 / D645 (amended 2026-10-18: Pi auth.json and cached
  catalog)
- Date: 2026-09-08
- Related: ADR 0012, ADR 0188, D007, D342

## Context

Users switching to PI-Desktop otherwise retype provider URLs, model ids, and API
keys that other local agents already keep in well-known files. D007 forbids
auto-importing `~/.pi`, so a scan must stay an explicit action with nothing
written until the user imports, and secrets must never cross the renderer.

## Decision

1. The model configuration card originally lived under Settings → Import; ADR
   0319 / D645 retires that Settings session-import UI while the model
   scan/import semantics below stay in force and plugin session-import contracts
   are unchanged.
2. Sources match the session-import family: Claude Code, Codex, OpenCode, Pi, and
   CC Switch, each read from its own settings, config, or database file. For Pi,
   provider entries and API keys from `auth.json` are paired with Pi's cached
   `models-store.json` so an auth-only provider still gets its endpoint, models,
   and limits, and `models.json` stays authoritative when both files describe one
   provider. CC Switch rows are converted by app type, official seeds and
   OAuth-only rows are omitted, and a live file matching the same endpoint and
   credential is not listed twice.
3. The Electron-only IPC `pi-desktop/modelConfig/importScan` returns public drafts
   (`source`, `externalId`, `name`, `baseUrl`, `apiStyle`, `modelIds`,
   `hasSecret`); `importRun` resolves the selection from the latest scan cache and
   calls host `providers.create`. No host protocol bump.
4. A stored API key, `env:` / `env_key` resolution, or `Authorization: Bearer`
   header is copied into the host secret store, while placeholder values count as
   missing, a `!<shell command>` key or header is never executed or stored, Pi
   `oauth` entries are skipped entirely, plain `api_key` entries are copied, and
   an unresolved environment reference in `models.json` is filled from the
   matching `auth.json` key.
5. Import is idempotent: a candidate whose normalized base URL, API style, and
   credential match an existing provider is skipped, different credentials stay
   independent rows, and credential comparison never reaches the renderer. ADR
   0188 amends this rule.
6. If `settings.defaultProviderId` is empty after the first successful create in a
   run, that provider and its first model become the global default; an existing
   default is never overwritten.

## Consequences

- Switching tools can bring transcripts and the models they used, without pasting
  keys into Settings.
- PI-Desktop still never silently ingests `~/.pi`, and subscription grants stay
  with their own vendor sign-in.
- The 2026-10-18 amendment makes Settings → Models discover Pi auth-only providers
  through `auth.json` plus the cached catalog.

## Alternatives

- Auto-import on first launch: rejected by D007.
- Merge keys into an existing same-URL provider: rejected because it would
  overwrite a working row; skipping is safer.
