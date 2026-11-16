# ADR 0179: Import model configuration from local agent stores

- Status: Accepted for model import semantics; original Settings placement
  superseded by ADR 0319 / D645 (amended 2026-10-18: Pi auth.json and cached
  catalog)
- Date: 2026-09-08
- Deciders: PI-Desktop core
- Related: D007, D342, ADR 0012,
  ADR 0188,
  `04-ux/06-settings-ia.md`, `04-ux/08-component-spec.md` §18.5,
  `03-runtime/01-ipc-protocol.md`, `03-runtime/11-provider-model-system.md`

## Context

At the time this decision was recorded, Settings → Import scanned Claude Code,
Codex, OpenCode, and Pi session stores. The same tools keep provider URLs, model
ids, and often API keys in well-known files.

## Decision

1. The original placement was a Model configuration card under **Settings →
   Import**, with its own Scan / selection / Import selected.

2. **Sources** (same family as session import):
   - Claude Code: `~/.claude/settings.json` plus `settings.local.json` overlay
     (`env.ANTHROPIC_*`, `model`)
   - Codex: `~/.codex/config.toml` `[model_providers.<id>]`
   - OpenCode: `~/.config/opencode/opencode.json` `provider` map plus
     `~/.local/share/opencode/auth.json` API keys
   - Pi: `~/.pi/agent/models.json` (fallback `~/.pi/models.json`).
   - CC Switch: `~/.cc-switch/cc-switch.db` `providers` table (legacy
     `config.json`).

3. **IPC** (Electron only, no host protocol bump):
   `pi-desktop/modelConfig/importScan` returns public drafts (`source`,
   `externalId`, `name`, `baseUrl`, `apiStyle`, `modelIds`, `hasSecret`).

4. **Secrets.** A stored API key, `env:` / `env_key` resolution, or
   `Authorization: Bearer` header is copied into the host secret store.

5. **Idempotence.** A candidate whose normalized base URL, API style, and
   credential match an existing provider is skipped.

6. **Default model.** If `settings.defaultProviderId` is empty after the first
   successful create in that run, that provider and its first model become the
   global default.

## Consequences

- Switching from another local agent can bring both transcripts and the models
  those transcripts used, without pasting keys into Settings.
- PI-Desktop still does not silently ingest `~/.pi`.
- Users with only a ChatGPT/Claude subscription still sign in through Vendor
  accounts; import cannot impersonate that grant.

## Alternatives

- Auto-import on first launch: rejected by D007.
- Merge keys into an existing same-URL provider: would overwrite a working row.
- Renderer-side `providers.create` with the key in the IPC payload: the scan
  cache already exists for sessions; keep secrets off the renderer.

## Amendment — 2026-10-18: discover Pi auth-only providers

Settings → Models only scanned `models.json`, so providers connected through `pi
/login` (for example DeepSeek or a Z.AI coding plan) never appeared in the Pi
group. The explicit scan now reads `auth.json` API keys and pairs them with the
catalog Pi already cached in `models-store.json`.
