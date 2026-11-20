# Vendored File Manager

Desktop ships the runtime for `pi.file-manager`, with the same plugin ID,
permissions, workspace scope and view entry as upstream. Source, build and
QA dependencies are not shipped.

| Field | Value |
| --- | --- |
| Repository | https://github.com/Tioit-Wang/pi-desktop-plugin-file-manager |
| Source tag | `v0.9.1` |
| Source commit | `90cfc010a3f9d02ac612055eea065d3c822d4977` |
| Bundled version | `0.9.1` |
| Distribution | Desktop build from the Git tag; not a marketplace artifact |
| License | MIT; preserve Desktop's `LICENSE` and the bundled PDF.js notices |

This snapshot includes project-relative Markdown images, bounded read-only
XLSX previews, saved line-reference copying, search controls themed upstream,
and scoped read-only SSH browsing. Structured Add to chat requires host
support; the built-in version does not add that host contract. The version
replaces older installs (including `0.9.1-pi.2`) without replacing same-version
or newer user-installed copies.

## Desktop differences and rebuild

1. Export the pinned commit as LF files and use its `views-src` lockfile.
2. Replay `patches/file-manager-runtime.patch` on `main.js` to retain filename
   validation and mutation metadata (#2184) and immediate Git deadline handling
   (#1731). Replay `patches/file-manager-directory-location.patch` on the view
   source to retain host-open directory browsing (#2113) and its verification.
   The upstream search theme fix replaces the old Desktop CSS patch.
3. Run `pnpm typecheck`, `pnpm build` and `pnpm verify` in `views-src`. The
   recorded build used Node 24.14.0 and Vite 5.4.21. Copy `views/` from the
   build with LF line endings; never edit generated JavaScript by hand.
4. Copy the runtime files listed below, keep the Desktop MIT license and
   CommonJS marker, and add the `license` field and Desktop changelog prefix
   to the upstream manifest. Keep its ID, version and permissions unchanged.
5. Update the checksums. Validate the runtime with PluginCheck, then run the
   bundled-plugin, mutation, Git deadline and remote bridge tests and the
   production Electron Markdown, theme, directory and remote-file journeys.

## Runtime checksums

| File | Bytes | SHA-256 |
| --- | --- | --- |
| `CHANGELOG.md` | 36051 | `038bd20e1ec4dd711489c72c10cc3b6aef56a4ccdaa8e087d38ae409090e3dd7` |
| `LICENSE` | 1067 | `ebaec3ae096498a39f6b86e3ac8017e39818fb5aaff80b452349f94bc275ec0d` |
| `README.md` | 42609 | `2a853984ccde5d01cdd2254492d804a848acd96b2671cdf2522c9a1be23c14b0` |
| `main.js` | 137954 | `d672355d7c28e3a9cbc4b8689de911dc5232ce267b92636311ba206a88c73807` |
| `manifest.json` | 42118 | `8ae434a470537109d571b09d225397f17d1cb7fb123ff9f49dbfc2752e6112ae` |
| `package.json` | 25 | `8005a3491db7d92f36ac66369861589f9c47123d3a7c71e643fc2c06168cd45a` |
| `remote-workspace.js` | 4150 | `aa8526fcf30220f58f21b278fc2736de9a1d2abedab9d320462a936add77b79c` |
| `views/assets/index.js` | 6622991 | `16bd329eaa6476d11fd8e5a48f6d51e6705d70b14c1b627a95d1d833daa547c3` |
| `views/assets/pdfjs-LICENSES.txt` | 61789 | `a8b04e2e9022721482079ee5c85b9f05ae129e6a2cfd59ea67f2629a3fc23640` |
| `views/index.html` | 345 | `771fd3d8afdea7fca75ed1f1918c1ce93ad1c87babdb321cfb85e910465cd2c1` |
