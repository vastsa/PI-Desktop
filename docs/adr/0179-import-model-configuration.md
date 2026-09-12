# ADR 0179: Import model configuration from local agent stores

- Status: Accepted
- Date: 2026-09-08
- Deciders: PI-Desktop core
- Related: D007, D342, ADR 0012,
  ADR 0188,
  `04-ux/06-settings-ia.md`, `04-ux/08-component-spec.md` §18.5,
  `03-runtime/01-ipc-protocol.md`, `03-runtime/11-provider-model-system.md`

## Context

Settings → Import already scans Claude Code, Codex, OpenCode, and Pi session
stores. The same tools keep provider URLs, model ids, and often API keys in
well-known files. Users who switch to PI-Desktop otherwise retype those
endpoints on Settings → Models.

D007 forbids auto-import of `~/.pi` so PI-Desktop owns `~/.pi-desktop`. That
must stay true for model configuration: a scan is an explicit action, and
nothing is written until Import selected.

Secrets cannot cross the renderer. Session import already keeps `filePath`
in the main-process scan cache; model import must keep keys the same way.

OAuth/subscription grants from those tools (Codex ChatGPT login, Claude
subscription, OpenCode `type: oauth`) are not PI-Desktop vendor-account
credentials. Copying refresh tokens would be the wrong security boundary.

## Decision

1. **Settings → Import** gains a second card, Model configuration, with its
   own Scan / selection / Import selected. Session import is unchanged.

2. **Sources** (same family as session import):
   - Claude Code: `~/.claude/settings.json` plus `settings.local.json`
     overlay (`env.ANTHROPIC_*`, `model`)
   - Codex: `~/.codex/config.toml` `[model_providers.<id>]`
   - OpenCode: `~/.config/opencode/opencode.json` `provider` map plus
     `~/.local/share/opencode/auth.json` API keys
   - Pi: `~/.pi/agent/models.json` (fallback `~/.pi/models.json`)
   - CC Switch: `~/.cc-switch/cc-switch.db` `providers` table (legacy
     `config.json`). Each row's `settings_config` is converted by app type.
     Empty official seeds and OAuth-only rows are omitted. A live Claude /
     Codex / OpenCode / Pi file that matches a CC Switch endpoint and
     credential is not listed twice; a different credential remains visible.

3. **IPC** (Electron only, no host protocol bump):
   `pi-desktop/modelConfig/importScan` returns public drafts
   (`source`, `externalId`, `name`, `baseUrl`, `apiStyle`, `modelIds`,
   `hasSecret`). `importRun` looks the selection up in the latest scan
   cache and calls host `providers.create`.

4. **Secrets.** A stored API key, `env:` / `env_key` resolution, or
   `Authorization: Bearer` header is copied into the host secret store.
   Placeholder values (`YOUR_API_KEY`, `${VAR}`) are treated as missing.
   OAuth auth.json entries and Codex `requires_openai_auth` tables without
   a key are omitted or imported without a secret.

5. **Idempotence.** A candidate whose normalized base URL, API style, and
   credential match an existing provider is skipped. Different credentials
   remain independent provider rows; the credential comparison stays in
   Electron main and never reaches the renderer. Named presets may set
   `vendorKey`; a custom URL stays `custom`. ADR 0188 amends this rule.

6. **Default model.** If `settings.defaultProviderId` is empty after the
   first successful create in that run, that provider and its first model
   become the global default. An existing default is never overwritten.

## Consequences

- Switching from another local agent can bring both transcripts and the
  models those transcripts used, without pasting keys into Settings.
- PI-Desktop still does not silently ingest `~/.pi`.
- Users with only a ChatGPT/Claude subscription still sign in through
  Vendor accounts; import cannot impersonate that grant.

## Alternatives

- Auto-import on first launch: rejected by D007.
- Merge keys into an existing same-URL provider: would overwrite a working
  row. Skip is safer; the user can edit the Models page.
- Renderer-side `providers.create` with the key in the IPC payload: the
  scan cache already exists for sessions; keep secrets off the renderer.
