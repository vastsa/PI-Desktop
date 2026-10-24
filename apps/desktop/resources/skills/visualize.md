---
name: visualize
description: "Create interactive visualizations directly in the conversation. Use to show how something works; explore 'what happens when', 'what changes', or 'help me understand'; compare or inspect; create simulations, charts, graphs, diagrams, and UI previews. Use standard tools for static scientific figures."
---

<!-- Adapted from the ZCode visualize skill (Apache-2.0); see resources/gen-ui/NOTICE.md. -->

# Visualize

- A request for a new standalone file, website, app page, component, or
  project change is not an in-conversation visualization, even with charts.
  Build it in the project.
- Create a visual only when the user needs to see or explore it in the
  conversation and it materially improves the explanation.
- Use a Markdown table when asked for a table; a fenced Mermaid block when
  labeled nodes and edges explain a static structure. Visualize dynamics,
  motion, adjustable inputs, spatial layout, and data worth hovering or
  filtering.
- Work silently: no progress commentary. In the reply, describe only what the
  visual helps the user see or decide. Never announce this skill, HTML, SVG,
  scripts, or local files.

Read this file in full before authoring. Copy into every compaction summary:
`Reload the full visualize skill before creating or updating a visualization.`

## Hard rules

- One `Write`, then the reply. Do not verify the fragment: no Bash or shell
  command, no browser, no screenshot, no reading it back.
- Do not open the kit, stylesheet, or helper source to look things up; the
  classes and `viz` API you need are in this skill. Anything missing goes in
  the reply, not in another tool call.

## Output contract

### File

- Write `<title>.html` (concise lowercase-hyphenated ASCII) with its
  absolute path into the **visualization directory named in the system
  prompt**, directly in that directory. No directory listed, or not
  writable: answer without a visual.
- Never write inline fragments into the project or a temp directory.

### Fragment

- Write only an HTML fragment: no `<!doctype>`, `<html>`, `<head>`, or
  `<body>`. The host supplies the document, the stylesheet below, and the
  runtime.
- Write literal markup with real newlines, never an escaped string
  (`<div class=\"card\">`, `\n`).
- Give the fragment root a unique ID and select it with
  `document.getElementById(...)`; never derive it from `document.currentScript`.
- Keep it under 1 MB: aggregate, bin, or downsample large datasets.
- Write the file once, complete. Before writing, check that the script has
  no undefined identifiers, every queried element exists, and the primary
  interaction updates the visual. Do not read it back (see Hard rules); reply
  right after the write succeeds.

### Reference in the reply

Put any short explanation in the reply, then the reference as the last line of
the reply, as plain text. The line looks like this (with real values):

::visualize{"path":"<absolute-path>/<title>.html","title":"<short title>"}

- Emit the literal ASCII prefix `::visualize` followed by a JSON object; do
  not put it in a code block, backticks, or a link. Write the path with
  forward slashes (`C:/Users/...` on Windows).
- Whenever you create or update a visualization, reference it again in that
  turn's final reply, even when editing an existing file.
- Do not repeat the data as a table; add at most one short conclusion.

### Sandbox

- There is no network: `fetch`, XHR, WebSocket, remote scripts, fonts, images,
  and map data are all blocked and fail silently. Draw with inline SVG or
  `<canvas>`; embed small assets as `data:` URIs.
- D3 7.9.0 (`d3`) and the `viz` helpers below are preloaded; use them
  directly and never add a `<script src>`. Floating UI is loaded by the
  runtime for tooltips. Any other library is unavailable.
- No popups, alerts, navigation, external links, form submission, cookies,
  or `localStorage`. Keep state in script variables; it resets when the card
  reloads.
- The card starts at 240px and follows content height up to 2000px. The same
  fragment also opens in a larger expanded view.

## Color and type

- Make every fill, stroke, text, border, and canvas color theme-aware. The
  host follows the app's light or dark theme; never hard-code white panels,
  black text, or Tailwind color literals.
- Theme variables: `--background`, `--foreground`, `--card`,
  `--card-foreground`, `--popover`, `--popover-foreground`, `--primary`,
  `--primary-foreground`, `--secondary`, `--secondary-foreground`, `--muted`,
  `--muted-foreground`, `--accent`, `--accent-foreground`, `--destructive`,
  `--border`, `--input`, `--ring`, and hues `--blue`, `--orange`, `--green`,
  `--red`, `--purple`, `--yellow`. Use `currentColor` inside SVG.
- In each pair the base token is a surface and `-foreground` is the content
  on it. `--muted` is a fill; use `--muted-foreground` for secondary text.
- Use `--viz-series-1` for a single measure or active state, and
  `--viz-series-2` … `--viz-series-6` only for persistent category or series
  identity. Keep mappings stable and pair color with labels or shapes. Keep
  values and labels in `--foreground` / `--muted-foreground`.
- Keep grids and inactive structure thin (1–2px) and neutral. Never outline
  bars, progress tracks, or stacked segments.
- Where CSS variables cannot be read (canvas), use `viz.color("--primary")`
  inside a `viz.chart` draw function, which reruns on theme changes.
- Type scales from `--font-size-base` (14px); `.text-small` is 12px. Never go
  below 11px, never set custom font sizes or line heights, and use only
  `var(--font-weight-normal)` and `var(--font-weight-medium)`. Use `.tabular-nums` on changing numbers.
- Use at most one concise heading (`h1`–`h3`) per chart; do not restate the
  prompt.

## Composition

Choose the smallest composition that fits.

- Prefer interaction detail over permanent panels, toolbars, repeated
  legends, or long stacks. Add only requested controls; never invent search,
  filter, or reset controls, or qualitative score and status cards.
- Put live values in control labels or on the visual.
- **Explainer or simulation:** compact controls, one dominant visual, at most
  one single-line selected-state detail. For step-throughs, add only step
  controls and update one current visual.
- **Graphs and plots:** D3 with `viz` for data-rich plots; handwritten SVG
  for a few directly labeled values.
- **Dense categorical grid:** one compact selected-item summary, a grid with
  one readable identifier per cell, one small legend.
- **Part-to-whole over time:** one stacked chart of category allocation per
  period.
- **Maps:** the sandbox cannot download geometry. Draw a map only from
  coordinates or small geometry you embed yourself; otherwise choose another
  form.
- **UI mockups:** match the product's own chrome, colors, and type. Do not use
  the visualization utility classes or variables inside the mocked product;
  define root-scoped product styles with `light-dark(<light>, <dark>)`. Give
  product surfaces opaque backgrounds and keep the surrounding area
  transparent. Show realistic states, not filler dashboards.

## Layout

- Keep the top-level surface transparent and unframed, and fill the available
  width. Design for about 700px and support widths down to 320px; stack
  side-by-side content when it no longer fits.
- Text, controls, and dynamic content must fit at every width without overlap
  or clipping. The host sizes the frame to content, so never use fixed outer
  widths, horizontal overflow, internal scrolling, `position: fixed`, or
  viewport-height layouts. Use `.table-responsive` only when table columns
  cannot fit.
- Draw chart SVGs with `viz.chart` (below); never a fixed-width `viewBox`.
  When `compact`, drop annotations.

## Utility classes

Let the utilities own geometry, appearance, and interaction; never restyle
them.

- **Surfaces:** `.card` is the only card-like surface — use it for a necessary
  numeric summary, a selected-item summary, or a bounded interactive field.
  Never nest cards or frame charts, maps, tables, or the whole visual.
  `.viz-stat` + `.viz-stat-value` inside a card for one metric.
- **Layout:** `.viz-grid` (equal columns that stack when narrow; 2–3 columns at
  700px), `.viz-row` (wrapping inline group), `.viz-controls` (wrapping row of
  controls for one visual), `<hr>` separator.
- **Controls:** `.btn`, `.btn-primary` (one main action per group),
  `.btn-ghost`, `.btn-block`; `.form-label`, `.form-control`, `.form-select`,
  `.form-range` (show the current value and units right before it),
  `.form-check` / `.form-switch` around a native checkbox,
  `.form-control-color`. Use native `button`, `input`, `select`, `textarea`;
  never recreate controls or add `tabindex`.
- **Tabs:** `.nav.nav-pills[role="tablist"]` with `aria-label`, holding
  `button.nav-link[role="tab"]` with a unique `id`, `type="button"`,
  `aria-controls`, and `aria-selected`; mark the initial tab `.active`. Each
  `[role="tabpanel"]` has the matching `id`, `aria-labelledby`, and `hidden`
  when inactive. The runtime wires the behavior.
- **Data:** `.table` (add `.table-sm` for more rows; `.text-end`,
  `.text-center`, `.text-nowrap` in cells), `.progress` + `.progress-bar` with
  `role="progressbar"` and `aria-value*`, `.viz-badge` for a display-only
  status pill, `.viz-tile` on a selectable dense-grid `.btn`.
- **Text:** `.text-small`, `.text-muted` (never for essential values),
  `.text-destructive` (errors only), `<code>`, `.sr-only`.
- **Tooltips:** `data-tooltip="…"` on any focusable trigger or SVG mark,
  optionally `data-tooltip-placement="top|right|bottom|left"`. The runtime
  handles hover, focus, and touch. Never use `title` or custom tooltip markup
  for these.
- Use `.cursor-interaction` on custom interactive elements instead of
  `cursor: pointer`.

## Charts

Preloaded `viz` helpers own sizing, redraw, axes, ticks, legends, tooltips,
and label overlap; never write that code yourself. For a standard chart,
describe it with `viz.render` instead of drawing it:

```js
const c = viz.render("sales", { mark: "line", data, label: "Sales by month",
  x: { field: "month", title: "Month" }, y: { field: "sales", title: "Sales (k)" },
  color: "region" });
slider.oninput = () => c.update({ data: filter(slider.value) });
```

- `mark`: `bar` (horizontal when `y` is categorical; `stack: true`),
  `line`, `area` (stacks with `color`), `point` (`size`, `trend: true`
  regression line), `heatmap` (`x`, `y`, `value`), `arc` (donut: `theta`,
  `color`). Channels: a field name or `{ field, title, format, domain }`;
  types are inferred (numbers, ISO dates, categories). Optional `tooltip: (d) => text`, `height`.
- `viz.regression(data, x, y)` → `{ slope, intercept, r }`.

For custom visuals use `viz.chart(el, ({ svg, width, height, compact }) => {...}, { label })`,
which redraws an emptied, container-sized SVG on width or theme change
(and on `redraw()`); inside it `viz.plot(svg, width, height)` →
`{ g, innerWidth, innerHeight }`, `viz.axes(g, { x, y, innerWidth, innerHeight, xLabel, yLabel })`,
`viz.extent(data, accessor, { zero })`, `viz.series(i)`, `viz.duration(ms)`,
`viz.pruneOverlaps(labels)`.

- Title axes with quantity and units.
- Custom marks get tooltips via `data-tooltip`; isolated marks need 32px
  hit targets.
- Animate only state transitions, with `viz.duration`; never loop motion.
- Scope custom SVG styles to the chart's class.

## Accessibility

- Use semantic HTML, keyboard-accessible controls, and concise labels.
- Give every chart (`viz.chart` `label`), SVG, and canvas a screen-reader
  summary (`aria-label` or an `.sr-only` description).
- Use `aria-live="polite"` for dynamic results and `role="alert"` for
  validation errors; do not announce every hover or frame.
- Keep essential content and actions available without hover, and keep
  browser focus styles.
- Keep visible text in the user's language.
