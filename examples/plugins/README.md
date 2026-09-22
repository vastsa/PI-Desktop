# Example Plugins

Sample plugins for development, specification, and integration tests. Start
with the [zero-to-one plugin development guide](../../docs/plugin-development.md)
before using these as API references.

## hello

Reference example covering:

- `commands`
- `ui.panel`
- `agentTools`
- `skills`
- `settings`
- `themes`
- resident `services`
- inter-plugin `bus`
- `permissions`

Related specs:

- `docs/spec/07-plugins/01-plugin-system.md`
- `docs/spec/07-plugins/02-plugin-manifest-schema.md`
- `docs/spec/07-plugins/03-plugin-api.md`
- `docs/spec/07-plugins/05-plugin-lifecycle.md`
- `docs/spec/07-plugins/09-plugin-command-palette.md`

Panel chrome contract:

- PI-Desktop owns exactly a transparent 46px drag band and the minimal
  top-right three-button window-control capsule on every platform.
- Normal-flow panel content is offset below that band automatically. Do not
  add another 46px top padding.
- If a panel adds fixed or sticky top UI, anchor it at
  `top: var(--pi-plugin-titlebar-height, 46px)`. The plugin owns that UI and
  should add `-webkit-app-region: no-drag` to its interactive controls.

## provider-request

A trusted agent extension (`contributes.agentExtensions`) that reads the ready
model catalogue and issues one authenticated provider request.

Reference example covering:

- `contributes.agentExtensions`
- `ctx.modelRegistry` reads (`models.list`)
- `ctx.providers.request(input)` (`provider.request`)
- the host-owned credential boundary

Related specs:

- `docs/spec/07-plugins/13-plugin-permissions-matrix.md`
- `docs/spec/07-plugins/16-trusted-extensions.md` §5, §5.1
- `docs/spec/03-runtime/08-error-codes.md` §3.6

## Planned examples

- `panel-basic`
- `agent-tool-basic`
- `skill-pack`
- `marketplace-mock-publisher`

## Official marketplace repository

Published plugins live in [`vastsa/pi-desktop-plugins`](https://github.com/vastsa/pi-desktop-plugins).

Local examples here remain useful for development loading (`Load dev plugin`).
Marketplace installs should come from that repository's `catalog.json` + `packages/*.piplug`.


## Practical template

Prefer the official warehouse template:

- https://github.com/vastsa/pi-desktop-plugins/tree/main/plugins/demo.workspace-summary
- Contribution guide: https://github.com/vastsa/pi-desktop-plugins/blob/main/CONTRIBUTING.md
