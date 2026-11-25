# Release announcements

A release announcement is a short, plain-language note about an important
change in a release ("what this means for you", not a changelog). It is
bundled with the app; there is no server component.

It is **off by default**. Ship one only when a release needs it.

## Behaviour

- Shown at most once per release (the id is the release version), after the
  startup guide; the Settings dialog waits behind both
  (priority: guide > announcement > settings).
- Counted as seen as soon as it is on screen; it never repeats for that id.
  State lives in renderer `localStorage` (`pi.desktop.announcement`).

## Shipping one

1. Use the release version as the id, e.g. `0.24.0`.
2. Add `content/<id>/en.md` (required) and any localized files named by
   locale id: `zh-CN.md`, `zh-TW.md`, `de.md`, `es.md`, `fr.md`, `ko.md`,
   `pt-BR.md`, `tr.md`. Missing locales fall back to the base language, then
   English.
3. Put images in `content/<id>/assets/` and reference them as
   `![alt](./assets/picture.png)`. Only bundled assets render; any other image
   reference is dropped.
4. Set `RELEASE_ANNOUNCEMENT` in `catalog.ts`:

   ```ts
   export const RELEASE_ANNOUNCEMENT: AnnouncementSchedule | null = {
     id: "0.24.0",
   };
   ```

5. Set it back to `null` (and delete the content folder) in a later release.

Markdown supports GFM (lists, tables, links). Raw HTML is not rendered. Links
open in the system browser and must be `https://`.
