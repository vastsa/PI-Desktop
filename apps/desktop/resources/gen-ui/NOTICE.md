# Inline visualization kit notice

`visualize.css`, `visualize-kit.html`, and the authoring guidance in
`../skills/visualize.md` are adapted from the ZCode visualize plugin
(`@zcode/visualize-plugin` 0.1.0, skills/visualize), which is licensed under
the Apache License, Version 2.0
(<https://www.apache.org/licenses/LICENSE-2.0>).

The upstream component ships no copyright line and no Apache `NOTICE`
file; its own license statement (`skills/visualize/LICENSE.md`) is
reproduced verbatim here:

> # Visualize resource license
>
> The skill entrypoint, standalone assets, widgets, rendering scripts, and parameter-control runtime are part of this repository and are licensed under the repository's Apache-2.0 license.
>
> The browser libraries in `assets/vendor/` retain their separate licenses: Floating UI Core and DOM use MIT; Lucide and D3 use ISC. Each library's license text is stored beside its script and recorded in `assets/vendor/manifest.json`.

Changes made for PI-Desktop:

- Element IDs renamed from `zcode-visualization-*` to
  `pi-desktop-visualization-*`.
- The variant carousel and the Lucide icon library were removed from the kit
  and the stylesheet.
- The skill text was edited for the PI-Desktop host: host API, parameter
  tweaks, calendar widget, standalone export, network-loaded map data, and the
  CDN allowlist were removed, and the text was condensed; the visualization
  directory, reference line, and sandbox rules describe PI-Desktop.
- The skill's chart guidance was rewritten around PI-Desktop's own `viz`
  helpers (`visualize-helpers.js`, not part of the upstream kit), and
  `visualize.css` gained styles for their axes, legends, and value labels.
- The shell writes the fragment into the kit's `#widget` container, as the
  upstream host does. `#widget` stacks top-level blocks with a 12px top
  margin instead of a flex column, and the upstream reset of its direct
  children (`margin`, `padding`, `border`, `!important`) was dropped so
  fragment styling is kept.
- Bundled library URLs are served by the `pi-genui:` protocol from `vendor/`
  instead of being fetched.

The libraries in `vendor/` keep their own licenses: Floating UI Core and DOM
(MIT) and D3 (ISC). Each license text sits beside its script and is
recorded with its checksum in `vendor/manifest.json`.
