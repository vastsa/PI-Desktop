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

## ui-slots-lab

Test plugin for the renderer UI slots (`docs/plugin-plan/`). It puts one
visible sample in every slot, each marked `data-lab="<slot>[:<side>]"`:

- `userAction` / `assistantAction` items; the assistant bar's right side has
  four items, so the fourth sits in the ⋯ menu
- two stacked `entryExtra` blocks under a reply
- the `toolCard` of its own `lab_probe` tool
- the `blockRenderer` for `lab.ui-slots:chart` fences (`label,value` lines)
- `composerControl` controls on both toolbar sides

The samples exercise the contract a person should see working: `plugin.call`
round trips (`Echo`, `Refuse` → `LAB_REFUSED`, `Stall` →
`PLUGIN_CALL_TIMEOUT`), `composer.insertText`, a `Crash` control the host
must contain, `Grow` past the entryExtra collapsed height, and deliberate
contract failures that hand the block back to the host: `lab_probe`
with `mode: "crash"`, and a chart whose first line is `crash` or `tall`
(taller than the 4000px clamp).

Covered by `apps/desktop/test/plugin-ui-slots-lab.test.mjs` and the Electron
E2E.

## Templates and additional examples

`panel-basic`, `agent-tool-basic`, `skill-pack`, and `full-demo` are implemented
in `packages/plugin-devkit/src/templates.ts`; generate them with the app or
`pi-plugin init` rather than looking for separate example folders.

`roundtable` demonstrates model catalog/one-shot completion and an agent tool.
`fetch-redirect` is a local-only network-policy probe, not a marketplace package.
Load repository examples with **Load development plugin** and inspect their
manifest grants before exercising them. Source maps and the complete SDK method
inventory are in the [development guide](../../docs/plugin-development.md).

## Distribution

The official catalog is the plugin center's
[`catalog.json`](https://plugins.aiuo.net/catalog.json). Plugin sources remain
in publisher-owned repositories. The
[GitHub distribution mirror](https://github.com/AIUO-Net/pi-desktop-plugins)
contains distribution artifacts/catalog data, not the source warehouse or a
mandatory plugin template. `pi-plugin publish` prepares local submission files;
it does not upload. See the guide's release workflow before publishing.

## Fetch redirect probe

[fetch-redirect](fetch-redirect/README.md) is a local-only fixture plugin for
host-enforced follow/error/manual policies and capability detection.
