# 03. Repo Structure

## 1. Workspace layout

Two workspaces share one repository: pnpm owns every JavaScript package
(`apps/*`, `packages/*`, `docs`), Cargo owns the Rust crate. Root
`package.json` scripts fan out to both.

```text
PI-Desktop/
├── apps/
│ └── desktop/                # Electron product shell
│   ├── electron/
│   │ ├── main/               # main process, one module per concern
│   │ ├── preload/            # renderer and plugin-panel preloads
│   │ └── shared/             # code both main and preload import
│   ├── src/                  # React renderer
│   │ ├── components/         # UI; settings/, workpanel/, plugins/, extensions/
│   │ ├── hooks/              # React hooks
│   │ ├── lib/                # framework-free renderer logic and the IPC client
│   │ ├── pages/              # routed destinations
│   │ ├── stores/             # zustand app store
│   │ ├── styles/             # CSS split by surface; tokens.css is the design system
│   │ └── assets/             # fonts and brand art
│   ├── test/                 # node --test suites (*.test.mjs) and helpers/
│   ├── resources/            # packaged extraResources: skills/, plugins/, models.dev/
│   ├── build/                # icons and macOS entitlements for electron-builder
│   ├── index.html
│   ├── electron.vite.config.ts
│   └── package.json          # also holds the electron-builder config
├── crates/
│ └── host-core/              # Rust privileged host (binary pi-desktop-host-core)
│   ├── Cargo.toml
│   └── src/                  # rpc/, tools/, a2a/, plus one module per domain
├── packages/
│ ├── shared/                 # IPC/protocol contracts, error codes, changelog
│ ├── i18n/                   # en and zh-CN catalogs plus locale helpers
│ ├── agent-runtime/          # pi sidecar and runtime wrapper (bundled into the app)
│ ├── plugin-sdk/             # plugin author types and validators
│ └── plugin-devkit/          # pi-plugin CLI: scaffold, check, pack, publish
├── examples/
│ ├── plugins/                # hello and roundtable sample plugins
│ └── fixtures/sample-project # workspace fixture for E2E scenarios
├── docs/                     # VitePress site and the English source of truth
│ ├── spec/                   # numbered specification domains (see spec/README.md)
│ ├── adr/                    # architecture decision records
│ ├── project/                # board, audits, implementation plans
│ ├── guide/                  # user-facing quick guide
│ ├── zh-CN/                  # path-for-path Chinese mirror of spec/ and guide/
│ ├── image/                  # images embedded by the repository READMEs
│ ├── public/                 # static assets served by the docs site
│ ├── scripts/                # docs-only checks (check-locales.mjs)
│ └── .vitepress/             # site config and theme
├── scripts/                  # repository automation (see scripts/README.md)
├── .github/                  # CI and release workflows, issue templates
├── AGENTS.md                 # mandatory rules for AI coding agents
├── package.json              # root scripts, pnpm workspace
├── pnpm-workspace.yaml
├── Cargo.toml                # Rust workspace
└── README.md · README.zh-CN.md
```

## 2. Package responsibilities

### `apps/desktop`
Product entry:
- Electron lifecycle, windows, tray, application menu
- IPC surface between renderer and main
- host-core and sidecar process supervision
- plugin runtime, panels, and views
- packaging configuration

### `crates/host-core`
Rust host services:
- tools execution
- permission gateway
- plugin host services
- persistence (SQLite, transcripts, artifacts, secrets)
- audit logging

### `packages/agent-runtime`
Node wrapper over pi:
- model bootstrap
- agent turn control
- event normalization
- host tool bridge client

### `packages/shared`
Cross-boundary contracts:
- IPC channel names
- DTO types
- error codes
- protocol versioning
- changelog entries surfaced in the app

### `packages/i18n`
- English source catalog and the zh-CN catalog
- locale resolution helpers
- message ID conventions

### `packages/plugin-sdk`
- manifest types
- host API types
- validators

### `packages/plugin-devkit`
- `pi-plugin` CLI used by plugin authors and the marketplace publish flow
- template scaffolding, manifest check, package, publish

## 3. Runtime data (not in git)

`PI_DESKTOP_DATA_DIR` overrides the default location.

```text
~/.pi-desktop/
 ├── pi.sqlite               # single DB, host-core owned (03-runtime/04, D086)
 ├── sessions/               # per-session transcript files (D119)
 ├── artifacts/              # plan and goal checkpoint artifacts
 ├── attachments/            # content-addressed prompt attachment blobs (main)
 ├── scratch/<sessionId>/    # session-scoped temporary files
 ├── secrets/
 ├── logs/
 │    ├── app/<category>.log
 │    ├── host/<category>.log
 │    └── agent/<category>.log
 ├── cache/
 ├── plugins/
 │    ├── installed/
 │    ├── data/
 │    ├── logs/
 │    ├── cache/
 │    ├── market/             # catalog and downloaded packages
 │    └── registry.json
 ├── window-state.json       # last main-window bounds (main)
 └── close-behavior.json     # persisted close-to-tray choice (main)
```

## 4. Naming conventions

| Object | Convention |
|---|---|
| JS packages | `@pi-desktop/*` |
| Rust crate | `pi-desktop-host-core` (or `host-core`) |
| IPC channels | `pi-desktop/<domain>/<action>` |
| i18n keys | `domain.section.key` |
| Plugin IDs | reverse-domain style |
| Main-process modules | one file per concern under `electron/main/`; `index.ts` wires them |
| Renderer tests | `apps/desktop/test/<subject>.test.mjs`, never beside the source |
