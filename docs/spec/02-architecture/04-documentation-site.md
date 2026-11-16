# Documentation site

## Status

Accepted. See [ADR 0079](../../adr/0079-vitepress-documentation-site.md) and
[ADR chinese-docs-entry-points-only](../../adr/chinese-docs-entry-points-only.md).

## Decision

The `docs/` directory is a standalone VitePress project inside the pnpm
workspace. Markdown remains the source of truth; VitePress supplies the local
development server, static build, local search index, code highlighting, and
versioned navigation shell.

The site exposes two locale entry points:

- `/` — English-first complete documentation navigation.
- `/zh-CN/` — Simplified Chinese home, guides, plugin guide, ADR map, and
  specification index. Specification and ADR pages are English only.

Existing `spec/`, `adr/`, `project/`, and guide Markdown files remain in place
so repository links and review history stay stable. The Chinese specification
index lives at `docs/zh-CN/spec/README.md` and links to English pages. A
translated page links to the canonical English page and keeps code, protocol
fields, and identifiers unchanged.

## Local commands

```bash
pnpm docs:dev
pnpm docs:build
pnpm docs:preview
pnpm docs:check
```

The production build is static and does not require a runtime service. The
site may load Google Fonts during development or deployment, but the content
and search index are generated locally by VitePress.

`pnpm docs:check` verifies that the required Chinese pages exist
(`zh-CN/spec/README.md` and `zh-CN/plugin-development.md`), and that every
Chinese page under `docs/zh-CN/spec/` has an English source and satisfies all of:

1. a top-level heading,
2. Chinese characters somewhere in the body,
3. the `[英文源规格](/spec/<path>)` canonical-source link,
4. no leftover untranslated-placeholder token (the gate greps for it as a
   bare substring, so this page cannot quote it verbatim),
5. the same table shape as the English page — the count of `|` cells, row by
   row,
6. the same number of fenced code blocks as the English page.

Conditions 5 and 6 make the gate structural rather than cosmetic: a Chinese page
that drops a table row or a code block is reported even when its prose reads
complete. The gate runs in `.github/workflows/docs-check.yml`, which covers the
documentation paths intentionally ignored by the application CI workflow. Treat
any failure as a list of Chinese pages to fix. A new English specification does
not need a Chinese companion.

`pnpm docs:check` also runs `scripts/check-docs.mjs`, a second gate over every
Markdown page under `docs/`:

1. exactly one H1, except that a `layout: home` page renders its hero instead,
2. balanced code fences, and tables whose rows agree on their column count,
3. the ADR catalog: an `NNNN-slug.md` (or plain slug) file name, one owner per
   decision id, an H1 that declares that id, and the Status, Context, and
   Decision sections,
4. `adr/README.md`, which must list every record exactly once, and may only
   link a row to the record that owns its id,
5. every `ADR NNNN` citation under `docs/`, which must resolve to a record, or
   to a retired id that `08-meta/decisions-log.md` names,
6. every Chinese page, which must mirror an English page at the same relative
   path, with `index.md` and `README.md` read as the same page,
7. `NAV.md`, which must list every page of its own tree, and the `spec/`
   section directories, which stay numbered like `01-product`; any section
   directory under `zh-CN/spec/` must exist in English.

The same workflow then runs the VitePress production build, which validates the
rendered routes and every internal link.

## Content rules

1. English remains the canonical source language for specs, ADRs, code
   identifiers, and protocol terms.
2. The Chinese locale keeps entry points only (home, guides, plugin guide, ADR
   map, specification index); its specification sidebar lists the English
   pages.
3. Chinese pages translate the complete prose, link back to the English source,
   and preserve code, protocol fields, and identifiers verbatim. When wording
   differs, the English contract remains authoritative.
4. The sidebar is derived from the Markdown tree so a new specification cannot
   be omitted from deep navigation by accident.
5. User-visible or protocol-visible documentation behavior belongs in the E2E
   test plan.
6. Navigation should expose the shortest useful path; deep files remain
   searchable and directly linkable.
