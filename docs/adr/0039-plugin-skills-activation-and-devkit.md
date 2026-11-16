# ADR 0039: Activate plugin skills and ship plugin authoring as a first-party devkit

- Status: Accepted
- Date: 2026-07-31
- Related: [Plugin developer experience](../spec/07-plugins/10-plugin-devex.md),
  [Plugin permissions matrix](../spec/07-plugins/13-plugin-permissions-matrix.md),
  [ADR 0008](0008-plugin-runtime-isolation-target.md),
  [ADR 0037](0037-project-instruction-chain.md),
  [ADR 0040](0040-plugin-resident-services-and-message-bus.md)

## Context

`contributes.skills` has been part of manifest v1 since R1: `validateManifest`
accepts it and `examples/plugins/hello` ships a skill file. Nothing read it.

## Decision

1. **Skills reach the model as a permission-gated catalog it can load from.**
   `PluginRuntime` indexes each declared skill file at load time, only for
   plugins granted `agent.prompt.inject`, and only through the same containment
   guard as the gated `fs` APIs.
2. **Prompt order is host skills, then plugin skills, then project
   instructions.** Later text carries more weight, so a user's own instruction
   files keep the last word and an installed plugin can refine the built-in
   guidance but never the reverse.
3. **Catalog changes update an idle runtime's skills section.** The
   chronological system-transcript decision supersedes the original digest-based
   retirement: enabling a plugin, revoking `agent.prompt.inject`, or renaming a
   skill appends a section update before the next request.
4. **Plugin authoring ships as a first-party devkit, not as a plugin.**
   `@pi-desktop/plugin-devkit` owns scaffold, check and pack; three surfaces
   share that one implementation — the `pi-plugin` CLI, the `PluginScaffold` /
   `PluginCheck` / `PluginPack` agent tools served from Electron main, and the
   plugins-page template action.
5. **The built-in plugin-development skill activates only for plugin
   workspaces** — a `manifest.json` at the workspace root, or a loaded plugin
   directory inside it.
6. **Hot reload may not widen a permission set.** A watched development plugin
   reloads on save, but the reload reads the manifest first: permissions outside
   the set approved when the folder was picked stop the reload with an error
   telling the user to load the plugin again.

## Consequences

- A skill file is now executable surface.
- `check` passing implies install will pass, because the devkit reproduces the
  rules host-core enforces (store-only entries, 2000 files, 50 MB, no symlinks,
  no `.git`/`node_modules`).
- Skill files are read when the model asks for one rather than every prompt, so
  an edit takes effect on the next `Skill` call and a session that needs no
  skill reads nothing.
- A failed hot reload leaves the plugin unloaded but still watched, so the next
  save recovers it. host-core's registry still reports `ready` in that window:
  it has no RPC for a runtime-side load failure, so the reload reports itself
  through a toast and `pluginChanged`, exactly as a plugin crash does.
- Skill front-matter parsing lives in the plugin SDK (`parseSkillFrontmatter`),
  shared by the runtime registry, the built-in skills and the devkit's `check`.

## Alternatives

### Ship plugin authoring as a bundled plugin

Rejected. A plugin cannot produce a `.piplug`: there is no archive API in
`HOST_API_ALLOWLIST` and adding one would hand every plugin a zip writer.

### Inject the plugin-development skill into every session

Rejected. A plugin-authoring primer in every system prompt is pure waste for
users who will never write one.

### Share the 32 KiB instruction-chain budget with skills

Rejected. Skills come from third-party code and instructions come from the user.

### Reload with the previously granted permissions regardless of the manifest

Rejected. The grant set was approved against a specific manifest.
