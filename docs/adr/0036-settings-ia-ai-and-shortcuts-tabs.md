# ADR 0036: Split Settings into AI and Shortcuts destinations

- Status: Accepted
- Date: 2026-07-30
- Deciders: PI-Desktop core
- Related: D090, D133, ADR 0013, ADR 0026

## Context

ADR 0026 froze the Settings directory at five destinations: Basics, Model
configuration, Import, Project archive, and Info. Over time Basics accumulated
six unrelated cards — Appearance, Defaults, Permissions, Context management,
Keyboard shortcuts, and Developer — making the single page long to scan and
burying two conceptually distinct concerns:

1. **Global AI behavior** (the permission mode that governs how autonomously the
   agent acts, and context management that governs how the agent compacts its
   context) is an AI-runtime concern, not a look-and-feel basic.
2. **Keyboard shortcuts** is a self-contained, frequently referenced surface
   that benefits from its own destination, especially now that the global search
   dialog and command palette route users to shortcut configuration.

## Decision

Keep the full-page Settings shell, Back to app action, search control, rail
metrics, content cards, and theme behavior unchanged. Replace the five-
destination rail with seven destinations in this exact order:

1. **Basics** (`general`, Lucide `SlidersHorizontal`) — Appearance and Defaults
2. **全局 AI / AI** (`ai`, Lucide `Sparkles`) — Permissions and Context management
3. **Shortcuts** (`shortcuts`, Lucide `Keyboard`) — Keyboard shortcuts
4. **Model configuration** (`agent`, Lucide `Bot`) — provider studio and default
   model
5. **Import** (`import`, Lucide `Download`) — session import
6. **Project archive** (`projects`, Lucide `Archive`) — durable project index
7. **Info** (`about`, Lucide `Info`) — versions, logs, updates, and Developer

Content moves only; no setting is added, removed, or renamed:

- Permissions and Context management cards move from Basics to the new **AI**
  destination.
- The Keyboard shortcuts card moves from Basics to the new **Shortcuts**
  destination.
- The Developer card moves from Basics to **Info**.
- Basics keeps only Appearance and Defaults.
- Model configuration, Import, Project archive, and their contents are
  unchanged.

## Consequences

- Basics is shorter and focused on look-and-feel; AI behavior, shortcuts, and
  developer controls are each one click away without scrolling a single long
  page.
- The frozen five-destination count and order from D133/ADR 0026 is superseded
  for the destination count and ordering only; no IPC, host RPC, database,
  security, or project-activation contract changes.
- Specs and E2E scenarios that assert the exact five-item rail order must be
  updated to the seven-item order, including the assertion that there is "no
  Keyboard destination" (now reversed).
- Developer mode moves from Basics to Info; Settings search and the developer-
  tools gating behavior are unchanged.
- The shared `settingsTab` union and `SETTINGS_NAV` index grow by two entries;
  existing persisted/default tab (`general`) is unaffected.

## Alternatives

### Keep all six cards in Basics

Rejected because the single page is long to scan and groups unrelated concerns
(appearance alongside AI permission policy and shortcut recording).

### Merge AI behavior into Model configuration

Rejected because Model configuration owns *which* provider/model to use (a
connection/identity concern), while permission mode and context compaction are
*runtime behavior* concerns.

### Move Developer to a dedicated Advanced destination

Rejected because a one-card destination is not worth a rail row; Info already
groups system/advanced surfaces (versions, logs, updates) and is the natural
home for developer-tool gating.

## References

- `docs/spec/00-baseline.md`
- `docs/spec/04-ux/01-ui-ia.md`
- `docs/spec/04-ux/06-settings-ia.md`
- `docs/spec/06-delivery/04-e2e-test-plan.md`
- `docs/spec/08-meta/decisions-log.md` (D166)
