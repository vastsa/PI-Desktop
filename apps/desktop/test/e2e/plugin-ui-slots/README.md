# Plugin UI slots E2E

Launches the real Electron app with the UI Slots Lab
(`examples/plugins/ui-slots-lab`) loaded as a development plugin and drives
every renderer slot end to end. The model is a deterministic in-process
Chat Completions stub; no real provider or network access is used.

```bash
pnpm build:js
cargo build -p host-core            # or set PI_DESKTOP_HOST_BIN
pnpm test:e2e:plugin-ui-slots
```

| File | Role |
| --- | --- |
| `scripts/e2e-plugin-ui-slots.mjs` | Runner: isolated data/home/profile, seed, Electron with MCP control and a CDP port, cleanup |
| `stub-model.mjs` | Stub model; the prompt names the scenario (`lab: probe <ok\|fail\|crash\|slow>`, `lab: chart <crash\|tall>`, `lab: gate`) |
| `seed.mjs` | Provider row for the stub and `plugins.loadDev` of a copy of the lab, through host-core JSON-RPC |
| `clients.mjs` | MCP control client (sessions, prompts, turn status) and a CDP renderer client |
| `drive.mjs` | The scenarios and their checks |

Covered behavior (`E2E-PLUGIN-ui-slots-*` in the E2E test plan):

- every slot mounts its sample for the open session: `userAction`,
  `assistantAction` (fourth right item in the ⋯ menu), stacked `entryExtra`,
  `toolCard`, `blockRenderer`, `composerControl`
- the plugin's injected sheet is scoped to its own mounts
- ⋯ menu opens, closes on Escape (focus returns to ⋯) and on an outside
  press, stays open on an inside press, and runs the folded item
- `plugin.call` round trips, a plugin error code passing through, and the
  2s `PLUGIN_CALL_TIMEOUT`; `composer.insertText` from every slot
- `entryExtra` collapsed clamp and the host expand toggle
- a crashing item, block or control is contained to itself
- `toolCard`: a failed call as `toolError`, a throwing card falling back to
  the host row, and `running → success` for a slow call
- `blockRenderer`: a throwing or over-4000px render falling back to the host
  code block
- self-drawn layers (`pi.ui.openLayer`): a wizard at z 600 over the app with
  the plugin's scoped sheet, a notice opened later at 601 above it, Escape
  closing neither, both hidden and inert while a permission request (a
  `Bash` call in Ask mode) waits and back unchanged once it is answered, ✕
  closing one, and the root leaving with the last layer
- disabling the plugin removes every mount, menu, block, layer and sheet;
  enabling it mounts fresh samples

Environment knobs: `E2E_ROOT` (fixed run root, kept), `E2E_KEEP_ARTIFACTS=1`,
`E2E_TIMEOUT_MS` (drive budget, default 240000), `DEBUG_E2E=1` (Electron
output). A failed run keeps its root, including `final.png`.
