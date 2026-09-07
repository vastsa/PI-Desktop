# PI-Desktop Docs

`docs/` is a VitePress project. The published site starts at [`index.md`](index.md);
the repository's English technical source of truth remains organized under
`spec/` and `adr/`.

## Local commands

```bash
pnpm docs:dev
pnpm docs:build
pnpm docs:preview
pnpm docs:check
```

## Layout notes

- `spec/` and `adr/` are the English source of truth; `zh-CN/` mirrors
  `spec/` and `guide/` path for path and is checked by `pnpm docs:check`.
- `image/` holds pictures embedded by the repository READMEs. `public/` holds
  assets served by the site itself (brand mark, screenshots).
- `project/` keeps historical planning records; current status lives in the
  changelog and GitHub Issues.

## Entry points

- [English documentation site](index.md)
- [中文入口](zh-CN/index.md)
- [Quick guide](guide/index.md)
- [Specification index](spec/README.md)
- [ADR index](adr/README.md)
- [Plugin development](plugin-development.md)
- [Visual verification](project/2026-08-13-docs-redesign-verification.md)

The Chinese entry point mirrors the English reading paths and includes a
path-for-path companion for every specification. Each translated page links to
the canonical English source and preserves code, protocol fields, and
identifiers. The generated sidebar keeps both locale trees complete as the
specification set grows.
