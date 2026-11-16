# ADR 0009: English-first globalization

- Status: Accepted
- Date: 2026-07-25

## Context

PI-Desktop targets global users and open contribution. Chinese-only product
surfaces would block international adoption and plugin ecosystem growth.

## Decision

PI-Desktop is **English-first**:

1. Product UI default language: **English**
2. Specs, ADRs, code comments, commits, issues, plugin docs: **English primary**
3. i18n framework is required from early UI work
4. Additional locales (including Chinese) are optional packs, not the source of
   truth

## Localization Rules

- Source strings live in English
- No hard-coded non-English UI copy in core code
- Locale packs use stable message IDs
- Plugin manifests/docs recommended in English; localized fields optional later

## Consequences

### Positive
- Global-ready baseline
- Easier external contribution
- Cleaner plugin ecosystem language default

### Negative
- Chinese copy becomes a translation layer, not primary authoring format
