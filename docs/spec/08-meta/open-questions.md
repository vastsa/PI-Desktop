# Open Questions

> Updated for baseline `0.4.12` (icon-free composer prompt row).
> Frozen decisions live in [decisions-log.md](decisions-log.md); resolved
> items move there instead of lingering here.

## Recently resolved (see decisions-log)

- Sidecar packaging format → `ELECTRON_RUN_AS_NODE` on the Electron binary (D008)
- Code signing / notarization operational setup → dual lanes + release runbook (D072)
- App icon / brand mark v1 → canonical `build/icon_1024.png` with derived ICNS
  (D079); renderer identity and shared `BrandLogo` usage → D094
- zh-CN locale timeline → zh-CN strings ship alongside English and are
  asserted by UI e2e scenarios (English remains the source language)
- Application update ownership and delivery modes → D120 / ADR 0022

## Still open

### Release / distribution (post-first-release)
1. When to make the release feed public or replace it with an authenticated
   endpoint without shipping a client credential
2. Distribution beyond DMG (Homebrew cask? direct download page?)
3. Signed Windows/macOS in-app installation, Linux publishing, rollback, and
   stable/prerelease rollout policy

### Marketplace (post-MVP)
1. Official marketplace domain and provider IDs
2. Whether third-party sources are enabled by default
3. Private source auth: token header vs mTLS
4. Whether `.zip` remains accepted beside `.piplug`

### Plugin advanced policy
1. When to enforce strict separate-process plugin runtime (ADR 0008 target)
2. Whether future plugin settings may include secret fields under special storage
3. Optional “keep data on uninstall” UX copy/defaults beyond hard default delete
4. Whether `ui.panel` contribution implies the panel permission or must declare it
   (tracked from 07-plugins/02-plugin-manifest-schema)

### Provider / model
1. Remote catalog distribution channel (signed app update vs dedicated catalog feed)
2. Whether to ship large multi-vendor bundled catalog or slim + refresh-on-demand
3. Azure deployment-name UX details vs raw model id
4. Bedrock region/profile advanced UI beyond aws_sdk_default in MVP

### Tooling
1. JS linter choice (biome vs oxlint) — style tokens are already enforced by
   `scripts/check-style-tokens.mjs`; a general linter remains unpicked

## Decision rules

- Frozen decisions go to `decisions-log.md` (D-entries)
- Architecture boundary changes require an ADR
- Non-blocking polish stays here until implementation nears
