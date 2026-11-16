# PI-Desktop Docs

`docs/` is a VitePress project. The published site starts at [`index.md`](index.md);
the repository's English technical source of truth is organized under `spec/`
and `adr/`.

## Local commands

```bash
pnpm docs:dev
pnpm docs:build
pnpm docs:preview
pnpm docs:check
```

## Layout

| Path | Contents |
|---|---|
| `spec/` | English specifications; E2E scenarios live in `spec/06-delivery/e2e/` |
| `adr/` | Architecture decision records |
| `guide/` | User guides |
| `plugin-development.md` | Plugin authoring guide |
| `plugin-plan/` | Plugin slot, render, runtime, and host API catalog (static HTML) |
| `project/`, `implementation/` | Historical records and evidence still cited by specs, scripts, or tests |
| `zh-CN/` | Chinese entry points only: home, guides, plugin guide, ADR map, spec index |
| `public/` | Site assets; `public/readme/` also serves the repository READMEs |
| `scripts/` | `check-locales.mjs` and `check-docs.mjs`, run by `pnpm docs:check` |

Specification and ADR pages are English only (ADR
[chinese-docs-entry-points-only](adr/chinese-docs-entry-points-only.md)).
`check-locales` requires the Chinese specification index and plugin guide, and
validates any other Chinese specification page that exists. Retired records
remain available in git history.

## Entry points

- [English documentation site](index.md)
- [中文入口](zh-CN/index.md)
- [Quick guide](guide/index.md)
- [Specification index](spec/README.md)
- [ADR index](adr/README.md)
- [Plugin development](plugin-development.md)
