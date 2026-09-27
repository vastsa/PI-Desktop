# 14. Plugin Roadmap

## 1. Guiding principle

```text
Local plugins usable → developer-friendly → marketplace distribution → signing and auto-update
```

## 2. Roadmap

### R1 — Foundation (with M4) ✅
- manifest v1
- Local directory loading
- enable/disable/uninstall
- command palette integration
- hello example plugin
- permission declaration display

### R2 — Agent Extension (partial ✅)
- Full agentTools pipeline ✅
- Skills contribution is activated: declared skills reach the model as a `# Skills`
  catalog in the system prompt when `agent.prompt.inject` is granted, and the model
  loads a body on demand through the `Skill` tool ✅ (ADR 0039, D174)
- Unified namespace and audit ✅
- Per-plugin settings API and generated settings UI are implemented. The UI
  supports string/number/boolean/select/json fields and plugin-local command
  shortcuts; OS-global plugin shortcuts remain out of scope.
- Plugin log panel remains planned; runtime audit logs exist without a dedicated
  plugin-log surface

### R3 — DX & Packaging ✅
- plugin-sdk ✅
- Template generation ✅ (`panel-basic`, `agent-tool-basic`, `skill-pack`,
  `full-demo`, from the plugins page, the agent, or `pi-plugin init`)
- `pi-plugin check/pack` ✅ (`@pi-desktop/plugin-devkit`, also exposed as the
  `PluginCheck` / `PluginScaffold` / `PluginPack` agent tools)
- `.piplug` install ✅
- dev hot reload ✅ (watch + debounce, and a reload can never widen permissions)

### R4 — Marketplace Read-only ✅
- market provider abstraction (official remote GitHub catalog provider)
- Official-source browse/search from `vastsa/pi-desktop-plugins`
- Download + checksum install
- updates list (manual update)

### R5 — Trust & Auto Update (partial ✅)
- Publisher verification (verified flag in catalog)
- Signature verification (still planned; checksum enforced now)
- Permission-diff upgrade ✅
- Auto-update policy ✅
- Malicious-version yank response (still planned)

### R6 — Advanced Ecosystem (partial ✅)
- MCP plugin type ✅ — `contributes.mcpServers` over stdio and remote HTTP (D176)
- Background service plugins ✅ — `contributes.services` with supervised
  restarts (D177)
- Inter-plugin message bus ✅ — declared topics, `pi.bus.*` (D178)
- Theme plugins ✅ — plugins ship CSS files (D175)
- Enterprise private sources (still planned)
- Marketplace reviews / quality score (optional, still planned)

## 3. Mapping to product milestones

| Product milestone | Plugin goal |
|---|---|
| M1 Skeleton | Reserve the plugins directory and interface stubs |
| M2 Chat Runtime | Non-blocking; can be designed in parallel |
| M3 Tools | ToolHost reserves contribution hooks |
| M4 Plugin Foundation | R1 complete |
| M5 Hardening | Plugin isolation and stability |
| Post-MVP | Complete R2 and progress R3–R6 in phases |

## 4. Success metrics (ecosystem)

1. Users can extend their workflow via plugins even without a new official release
2. Third parties can independently develop and locally install plugins
3. A plugin failure does not break the main app's availability
4. Permissions are visible and refusable before installing any plugin

## 5. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Building the marketplace too early destabilizes the core | Defer the marketplace; R1 does local first |
| Plugin security incident | Deny by default + audit + mandatory signing later |
| Frequent API breakage | apiVersion / schemaVersion |
| High developer barrier | Templates + hello example + SDK |
