# ADR 0009: English-first globalization

- Status: Accepted
- Date: 2026-07-25

## Context

PI-Desktop targets global users and open contribution; Chinese-only product
surfaces would block international adoption and plugin growth.

## Decision

The project is English-first. UI source strings, specs, ADRs, comments,
commits, issues, and plugin docs are authored in English, and core code carries
no hard-coded non-English copy. The i18n framework is required from early UI
work; other locales, Chinese included, ship as optional locale packs keyed by
stable message IDs and are never the source of truth.

## Consequences

- External contribution and the plugin ecosystem share one language default.
- Chinese copy becomes a translation layer, not the authoring format.
