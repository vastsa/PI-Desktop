# GenOffice provenance

This plugin vendors the browser renderer built from the Apache-2.0 licensed
GenOffice repository:

- Repository: https://github.com/genspark-ai/genoffice/
- Pinned commit: `d1280d153362071de433a6439ca31585af4af8f7`
- Source package: `apps/docs/src/renderer`
- Build command: `npx vite build --config vite.renderer.config.ts` from `apps/docs`

The PI integration keeps the generated browser assets and replaces the
Electron preload with `views/bridge-shim.js`. `views/pi-office-overrides.css`
is a PI-owned stylesheet that removes the unused Genspark and other AI entry
points, assistant dock, top-level file tab, file pane, and document-tab window
controls from the extracted UI without patching the vendor bundle.
GenOffice's `ee/` directory and the desktop shell are not
bundled. The upstream Apache-2.0 license is shipped as `LICENSE` in this
plugin directory. Bundled font notices are retained in `LICENSE-OFL.txt`,
`LICENSE-UNICODE.txt`, and `FONTS-README.md`.

When refreshing the editor, rebuild the renderer from the pinned commit, copy
the generated `dist` contents into `views/`, restore the relative asset URLs,
the PI bridge script, and the PI-owned override stylesheet in `views/index.html`,
and review the generated diff for network or desktop-shell imports before
updating this record.
