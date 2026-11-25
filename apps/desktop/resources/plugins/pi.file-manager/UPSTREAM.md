# Vendored File Manager

Desktop ships the ordinary runtime for `pi.file-manager` with the same ID,
permissions, workspace scope and view entry as upstream. Build and QA files
are not shipped.

| Field | Value |
| --- | --- |
| Repository | https://github.com/Tioit-Wang/pi-desktop-plugin-file-manager |
| Source tag | None; pinned upstream main commit |
| Source commit | `6466e52bfd329ba961e81d2537753522ce664fb7` |
| Bundled version | `0.13.0` |
| Distribution | Desktop build from the pinned commit; not a marketplace artifact |
| License | MIT; preserve Desktop's `LICENSE` and bundled PDF.js notices |

This snapshot adds document tabs with independent drafts, Git changes and
history with user-initiated repository operations, and responsive loading.
The SSH workspace stays read-only and uses scoped Host services, not local Git.
Desktop preserves an already-installed copy at the same or a newer version.

## Desktop differences and rebuild

1. Export the pinned commit as LF files and use its `views-src` lockfile.
2. Replay `patches/file-manager-runtime.patch` on `main.js` for trailing-dot
   rejection (#2184) and immediate Git deadlines (#1731). Upstream already
   returns canonical mutation metadata. Replay
   `patches/file-manager-directory-location.patch` on the view source for
   directory locations sent by Desktop (#2113).
3. Run `pnpm typecheck`, `pnpm build` and `pnpm verify` in `views-src`.
   Copy `views/` from the build, never edit generated JavaScript by hand.
4. Run upstream's `node scripts/prepare-package.mjs`. Copy the runtime files,
   including all three Git modules. Keep Desktop's MIT license and CommonJS
   marker; add the license field and Desktop changelog prefix to the manifest.
5. Update the checksums and run the bundled plugin, Git deadline, file mutation,
   directory location, theme, and remote regressions against the shipped copy.

## Runtime checksums

| File | Bytes | SHA-256 |
| --- | --- | --- |
| `CHANGELOG.md` | 37124 | `5dd1dc141c61e3013c53275bb282b6780dbca2a05c488863c2cc7492e69991cf` |
| `LICENSE` | 1067 | `ebaec3ae096498a39f6b86e3ac8017e39818fb5aaff80b452349f94bc275ec0d` |
| `README.md` | 42505 | `fc28350ebd0b11de3ba23c46fc75f687d2ff1c8876c93e5a91da40c9a4b65ba9` |
| `git-batch.js` | 2229 | `6fa41b09313a2e7c2140ad6c2dabfc356b5ba8a6392069a410fbb9268e5f4107` |
| `git-history.js` | 8916 | `02e51c58144dde8152b26737421fcb1d7124dbe71dfa4d0b40a7a8906f1f0f4d` |
| `git-sync.js` | 20845 | `5cd653e600a31b7186c4542d0a70c6a8434c45f342732233af587539dd95b0aa` |
| `main.js` | 153538 | `af73cc4c4efe015d1637b611171a8bd3d3695cd2b8fdaa9bdc33a470e4e37c47` |
| `manifest.json` | 3526 | `b71b52c8f9cf201df4e4dc51cf60b7f5b4b8903825024fed044788158f8e95db` |
| `package.json` | 25 | `8005a3491db7d92f36ac66369861589f9c47123d3a7c71e643fc2c06168cd45a` |
| `remote-workspace.js` | 4150 | `aa8526fcf30220f58f21b278fc2736de9a1d2abedab9d320462a936add77b79c` |
| `views/assets/index.js` | 6666887 | `4db75965d643b1b450d9af1a536f358197b81bce6a272069e38f7deef8dfe8b1` |
| `views/assets/pdfjs-LICENSES.txt` | 61789 | `a8b04e2e9022721482079ee5c85b9f05ae129e6a2cfd59ea67f2629a3fc23640` |
| `views/index.html` | 345 | `771fd3d8afdea7fca75ed1f1918c1ce93ad1c87babdb321cfb85e910465cd2c1` |
