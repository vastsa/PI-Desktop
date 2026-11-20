# Bundled Official Enhancements

This snapshot comes from the local `pi-plugin-official-enhancements` checkout
at `779930de85c14b0b8b99a451952d9c49333f6360`, including its local settings
panel and capability-toggle changes. It uses the released Desktop plugin API
and does not depend on the proposed turn-start or multi-suggestion APIs.

Desktop ships the CommonJS runtime and built panel from
`apps/desktop/resources/plugins/pi.official-enhancements`. This directory holds
editable panel source, not packaged content. The bundled defaults live in the
runtime entry: only session titles start enabled, and persisted settings win.
The optional features keep their existing manifest grants, but do not run
suggestions, transform drafts, or recall AI memory while switched off.

From the repository root, with the workspace dependencies already available:

```sh
node apps/desktop/plugin-sources/official-enhancements/scripts/build-css.mjs
node apps/desktop/plugin-sources/official-enhancements/build.mjs
node --test apps/desktop/test/bundled-official-enhancements.test.mjs
```

Commit the generated panel with any source changes. Keep the upstream license
and dependency notices with the runtime and update notices when changing
bundled dependencies.
