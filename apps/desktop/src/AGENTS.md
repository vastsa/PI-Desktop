# Renderer & UI — Agent Rules

Scoped rules for `apps/desktop/src/`. These tighten the root `AGENTS.md`;
on conflict the rules here win.

---

## Shared UI primitives are mandatory

Every renderer component must use the shared primitives from
`components/ui.tsx` and `components/settings/`. Inline reimplementation
of any shared primitive is a spec violation.

### Primitive catalog

| Need | Component | Source |
|---|---|---|
| Button | `Button` | `components/ui.tsx` |
| Text input | `Input` | `components/ui.tsx` |
| Password input | `PasswordInput` | `components/ui.tsx` |
| Textarea | `Textarea` | `components/ui.tsx` |
| Form field (label + hint) | `Field` | `components/ui.tsx` |
| Boolean toggle (switch) | `SettingsToggle` | `components/ui.tsx` |
| Multi-option segment | `SegmentedControl` | `components/ui.tsx` |
| Checkbox | `Checkbox` | `components/ui.tsx` |
| Checkbox group (array multi-select) | `CheckboxGroup` | `components/ui.tsx` |
| Native dropdown (non-Settings) | `Select` | `components/ui.tsx` |
| Settings dropdown | `SettingsMenuSelect` | `components/settings/SettingsMenuSelect.tsx` |
| Status badge | `Badge` | `components/ui.tsx` |
| Card container | `Panel` | `components/ui.tsx` |
| Icon-only button with tooltip | `TooltipButton` | `components/ui.tsx` |
| Inline help | `HelpIcon` | `components/ui.tsx` |
| Settings layout | `SettingsCard`, `SettingsRow` | `features/settings/primitives.tsx` |

### Prohibited patterns

- `<button role="switch">` with manual `settings-toggle` class → use `SettingsToggle`
- `<div className="settings-segment">` with manual button loop → use `SegmentedControl`
- `<label><input type="checkbox"/>…</label>` → use `Checkbox`
- `<select>` or `Select` in Settings pages → use `SettingsMenuSelect`
- `<button className="btn-*">` with manual class assembly → use `Button`
- `<span className="badge-*">` with manual class assembly → use `Badge`

### When to add a new primitive

Add to `components/ui.tsx` when the same pattern appears (or will appear)
in three or more files. The new component must:

1. Use existing CSS classes from `styles/ui-kit.css` or `styles/settings.css`
2. Accept `className` for composition
3. Include proper ARIA attributes
4. Be exported from `components/ui.tsx` (or `components/settings/` for
   Settings-specific primitives)
5. Be documented in `docs/spec/04-ux/07-ui-design-system.md` §11
