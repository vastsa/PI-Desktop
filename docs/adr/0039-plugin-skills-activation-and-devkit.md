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
Declaring a skill had no observable effect, so the contribution point was
documentation, not a feature.

The authoring path was incomplete in the other direction. A `.piplug` package
could be installed but not produced: host-core owns `install_from_package`, and
nothing in the repository could write the store-only zip it accepts. There were
no templates, no manifest validation ahead of install, and every source edit to
a development plugin required re-picking its folder through the native dialog.

The two gaps are the same gap: PI-Desktop asked users to write plugins without
giving them the loop — scaffold, run, inspect, package.

## Decision

1. **Skills reach the model as a permission-gated catalog it can load from.**
   `PluginRuntime` indexes each declared skill file at load time, only for
   plugins granted `agent.prompt.inject`, and only through the same containment
   guard as the gated `fs` APIs. The system prompt carries a `# Skills` section
   of one line per skill — id, name, applicability — and the model pulls a body
   on demand with the `skill` tool, served from Electron main because the plugin
   directories live there. A skill document may be 128 KiB and a plugin may
   teach 32 of them, because an unread document costs nothing (D174, which
   supersedes this ADR's original 16 KiB whole-body prompt injection).
2. **Prompt order is host skills, then plugin skills, then project
   instructions.** Later text carries more weight, so a user's own instruction
   files keep the last word and an installed plugin can refine the built-in
   guidance but never the reverse.
3. **Runtime reuse keys on the catalog digest, not on bodies.** Enabling a
   plugin, revoking `agent.prompt.inject` or renaming a skill changes the text
   the model reads, so it retires the idle runtime rather than reusing a stale
   prompt. An edit to a body needs no retirement: the `skill` tool reads the file
   at call time.
4. **Plugin authoring ships as a first-party devkit, not as a plugin.**
   `@pi-desktop/plugin-devkit` owns scaffold, check and pack; three surfaces
   share that one implementation — the `pi-plugin` CLI, the `scaffold_plugin` /
   `check_plugin` / `pack_plugin` agent tools served from Electron main, and the
   plugins-page template action.
5. **The built-in plugin-development skill activates only for plugin
   workspaces** — a `manifest.json` at the workspace root, or a loaded plugin
   directory inside it. Ordinary sessions pay for three tool descriptions and
   nothing else; scaffolding writes a manifest, which activates the full skill
   on the next prompt.
6. **Hot reload may not widen a permission set.** A watched development plugin
   reloads on save, but the reload reads the manifest first: permissions outside
   the set approved when the folder was picked stop the reload with an error
   telling the user to load the plugin again. Grants do follow the manifest
   downwards, so a removed permission stops being available.

## Consequences

- A skill file is now executable surface. `agent.prompt.inject` keeps its
  high-risk tier in the permissions matrix and is the only gate; the install
  review already shows it.
- `check` passing implies install will pass, because the devkit reproduces the
  rules host-core enforces (store-only entries, 2000 files, 50 MB, no symlinks,
  no `.git`/`node_modules`). Those limits are duplicated in TypeScript and Rust
  and must move together.
- Skill files are read when the model asks for one rather than every prompt, so
  an edit takes effect on the next `skill` call and a session that needs no skill
  reads nothing. The catalog metadata is indexed at load time, so renaming a
  skill still needs a reload — which a watched development plugin does on save.
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
Scaffolding would also require `fs.write.workspace`, a high-risk permission, for
a capability the application itself should provide. First-party means always
available, with no permission prompt and no chicken-and-egg.

### Inject the plugin-development skill into every session

Rejected. A plugin-authoring primer in every system prompt is pure waste for
users who will never write one. The three tool descriptions are enough to
bootstrap, and the workspace gate turns the full skill on exactly when it
becomes relevant.

### Share the 32 KiB instruction-chain budget with skills

Rejected. Skills come from third-party code and instructions come from the user.
A shared budget would let an installed plugin displace a project's own rules.

### Reload with the previously granted permissions regardless of the manifest

Rejected. The grant set was approved against a specific manifest. Reusing it
after a manifest edit would let a file write widen capabilities behind the
permission gateway — the one boundary the plugin system exists to hold.
