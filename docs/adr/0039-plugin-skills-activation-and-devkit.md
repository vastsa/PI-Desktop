# ADR 0039: Activate plugin skills and ship plugin authoring as a first-party devkit

- Status: Accepted
- Date: 2026-07-31
- Related: D174, ADR 0008, ADR 0037, ADR 0040

## Context

`validateManifest` accepted `contributes.skills` since manifest v1, but nothing
read it, so declaring a skill had no effect, and a `.piplug` could be installed but
not produced — no templates, no pre-install validation, no packaging loop. Users
were asked to write plugins without scaffold, run, inspect, and package.

## Decision

`PluginRuntime` indexes each declared skill file at load time, only for plugins
granted `agent.prompt.inject` and through the gated `fs` containment guard, and the
system prompt carries a `# Skills` section of one line per skill (id, name,
applicability) whose bodies the model pulls on demand with the `Skill` tool served
from Electron main, so a 128 KiB document costs nothing until it is read (D174).
Prompt order is host skills, plugin skills, then project instructions, so project
rules keep the last word, and enabling a plugin, revoking `agent.prompt.inject`, or
renaming a skill appends a section update to an idle runtime. Authoring ships as
`@pi-desktop/plugin-devkit` — scaffold, check, pack — shared by the `pi-plugin`
CLI, the `PluginScaffold` / `PluginCheck` / `PluginPack` agent tools, and the
plugins-page template action, and its built-in development skill activates only for
a workspace holding a `manifest.json` or a loaded plugin. A hot reload reads the
manifest first, so permissions beyond the set approved when the folder was picked
stop it with an error asking the user to load the plugin again, while grants still
follow the manifest downwards.

## Consequences

- A skill file is executable surface: `agent.prompt.inject` is the only, high-risk
  gate, and install review shows it.
- `check` reproduces the host rules, so passing implies install will pass; those
  limits live in TypeScript and Rust and must move together.
- Bodies apply on the next `Skill` call while catalog metadata is indexed at load
  time, so a rename needs a reload, and a failed reload leaves the plugin unloaded
  but watched, reporting through a toast and `pluginChanged` like a crash.

## Alternatives

- Authoring as a bundled plugin: no archive API in `HOST_API_ALLOWLIST`, and
  scaffolding would need `fs.write.workspace`.
- Share the instruction-chain budget with skills: plugin content could displace a
  project's own rules.
