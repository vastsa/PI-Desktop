# Plugin System

> Directory: `docs/spec/07-plugins`

Plugin authors should start with the task-oriented
[zero-to-one development guide](../../plugin-development.md). The documents in
this directory define the normative contracts and implementation boundaries.

| Document | Description |
|---|---|
| [01-plugin-system.md](01-plugin-system.md) | Plugin system overview |
| [02-plugin-manifest-schema.md](02-plugin-manifest-schema.md) | Manifest schema |
| [03-plugin-api.md](03-plugin-api.md) | Plugin API |
| [04-plugin-security.md](04-plugin-security.md) | Plugin security |
| [05-plugin-lifecycle.md](05-plugin-lifecycle.md) | Lifecycle |
| [06-plugin-packaging.md](06-plugin-packaging.md) | Packaging & installation |
| [07-plugin-marketplace.md](07-plugin-marketplace.md) | Plugin marketplace |
| [08-plugin-signing-updates.md](08-plugin-signing-updates.md) | Signing & updates |
| [09-plugin-command-palette.md](09-plugin-command-palette.md) | Command palette |
| [10-plugin-devex.md](10-plugin-devex.md) | Developer experience |
| [11-plugin-storage-isolation.md](11-plugin-storage-isolation.md) | Storage isolation |
| [12-plugin-ipc-and-host-services.md](12-plugin-ipc-and-host-services.md) | Host services & IPC |
| [13-plugin-permissions-matrix.md](13-plugin-permissions-matrix.md) | Permissions matrix |
| [14-plugin-roadmap.md](14-plugin-roadmap.md) | Plugin roadmap |
| [15-plugin-center.md](15-plugin-center.md) | Plugin center (publishing side) |
| [16-trusted-extensions.md](16-trusted-extensions.md) | Trusted extensions (in-sidecar extension surface) |

## Read the code behind the contract

Use the [complete SDK index](../../plugin-development.md#13-complete-sdk-surface-and-source-map)
for every callable method and the permission matrix for its gate. The SDK,
installer, and runtime are independent enforcement layers; the guide calls out
known differences instead of treating a permissive parser as authorization.

| Area | Implementation evidence |
|---|---|
| Manifest, permission vocabulary, host API | `packages/plugin-sdk/src/index.ts` |
| Renderer slots, actions, drafts, attachments | `packages/plugin-sdk/src/renderer.ts`, `renderer-composer.ts` |
| File/network/theme/MCP rules | SDK policy helpers and their unit tests |
| Templates, checks, packing, submission preparation | `packages/plugin-devkit/src` and its tests |
| Install, registry, marketplace, ownership | `crates/host-core/src/plugins` |
| Broker dispatch, callbacks, cleanup, events | `apps/desktop/electron/main/plugin-runtime.ts`, `plugin-host-process.mjs` |
| Panel bridge and command search | `apps/desktop/electron/preload/plugin-panel.ts`, `apps/desktop/electron/main/ipc/market-ipc.ts` |
| Trusted extension subset | `packages/agent-runtime/src/extensions` and spec 16 |
| Representative host/user paths | `apps/desktop/test/plugin-*.test.mjs`, repository example plugins |

Lifecycle proposals, background-audio types without a device backend, signing
plans, and center-server architecture are explicitly distinguished from shipped
runtime APIs. Review pages under `docs/plugin-plan` may describe unimplemented
hooks; they are not an additional public API.
