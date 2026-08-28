# 02. Tech Stack

## 1. Stack table

| Layer | Tech | Baseline | Notes |
|---|---|---|---|
| Desktop shell | Electron | latest stable (pin at impl) | app shell |
| UI | React 19 + TypeScript | modern stable | English-first UI |
| Bundler | electron-vite / Vite | stable | multi-entry build |
| Styling | Tailwind CSS 4 | stable | utility-first |
| State | Zustand | stable | UI state |
| Host backend | **Rust** | stable Rust toolchain | tools/plugins/permissions/persistence adapters |
| Rust async | tokio | stable | host services |
| Host RPC | stdio JSON-RPC (NDJSON) | frozen (D001) | Electron main ↔ Rust host |
| Agent engine | `@earendil-works/pi-agent-core` | ^0.82.1+ | agent loop |
| Model API | `@earendil-works/pi-ai` | ^0.82.1+ | provider adapters and local catalog fallback |
| Model catalog | `https://models.dev/api.json` | remote, bounded fetch | primary provider/model metadata catalog |

> Pin **^0.82.1+** remains required for pi-ai adapter compatibility and its
> fallback catalog. models.dev supplies the primary current model metadata.
> The pin also remains useful for adapter compatibility and native models that
> models.dev does not publish.

| Node runtime | Node.js | `>= 22.19` | pi requirement |
| DB | SQLite | Rust host-core via `rusqlite` | sessions/settings |
| Packaging | electron-builder | stable | macOS arm64, Windows x64, and Linux x64 release lanes |
| Package manager | pnpm | 11.18.x | JS monorepo |
| Lint/test | style-token checker (`scripts/check-style-tokens.mjs`) + vitest + cargo test; general JS linter still open (biome vs oxlint) | stable | dual stack quality |
| Schema (TS) | typebox | frozen (D011) | shared contracts |
| i18n | i18next + react-i18next | frozen (D012) | English source locale |

## 2. Language policy in engineering

- Product strings: English source
- Specs/ADRs: English primary
- Code identifiers: English
- Commits/issues/PRs: English preferred

## 3. Why Rust host core

- stronger sandboxing foundation
- better process/fs control
- long-term native performance and safety
- cleaner privilege separation from UI and model runtime

## 4. Why keep pi in Node/TS

- mature multi-provider support
- existing agent event model
- skills/extensions ecosystem leverage
- avoid rewriting agent framework

## 5. Dependency boundaries

### Allowed
- official pi packages
- mainstream Electron/React ecosystem
- Rust crates for fs/process/sqlite/rpc/serde

### Careful
- heavy native node addons
- multiple competing RPC frameworks
- large editor stacks too early (Monaco)

### Not in MVP
- remote gateway frameworks
- marketplace backend
- custom LLM provider SDK replacing pi-ai

### Production packaging boundary

- Renderer-only libraries are development/build dependencies because Vite
  bundles their runtime code and lazy assets into `out/renderer`.
- Electron Main bundles pure-JS workspace packages. Packages that require
  runtime module resolution or a native ABI remain production dependencies;
  the current external set includes only `electron-updater`.
- `Resources/agent-runtime/sidecar.js` is the only independent pi sidecar
  bundle. The complete `@pi-desktop/agent-runtime` package tree must not be
  copied into ASAR as a second runtime.
- The desktop package has no interactive PTY dependency. Agent Bash remains a
  non-interactive runtime capability owned by the agent sidecar.
- Dependency source maps, tests, examples, and declarations are build inputs,
  not release assets. License and notice files remain distributable.
- Lazy renderer capabilities such as Mermaid, KaTeX, and Shiki remain local
  assets; package-size optimization must not introduce runtime CDN fetches.

## 6. Build matrix (MVP)

- JS workspace build (`pnpm`)
- Rust host build (`cargo`)
- integration smoke (`pnpm dev` boots all layers)
