# 06. Plugin Packaging

## 1. Formats and ownership

Development loading references a local directory whose root contains
`manifest.json`; it does not copy the source. Installed directories and
marketplace packages are managed by Rust host-core. The desktop runtime loads
an entry only after the install/load path has reviewed the manifest and grants.

A distribution `.piplug` is a **store-only ZIP (compression method 0)**.
The installer also reads store-only `.zip` input; a generic ZIP tool's deflated
entries are rejected. Use `pi-plugin pack` or the Agent's `PluginPack`, never
assume a renamed archive is compatible.

## 2. Package contents

The devkit writes the manifest at archive root. Include executable JavaScript,
HTML/CSS, skills, renderer modules, and all referenced assets. The installer
can discover a manifest at root or one directory below it, but the devkit's
root layout is the supported authoring path.

There is no installer-managed dependency or TypeScript build for ordinary
packages. Bundle runtime dependencies; `node_modules` never enters the package.
Agent extension modules have their own TypeScript loader, and the explicit
Import pi extension flow has bounded registry-only npm preparation; see
[16-trusted-extensions.md](16-trusted-extensions.md). Neither exception makes
ordinary package loading run arbitrary install scripts.

## 3. Enforced bounds and exclusions

| Surface | Current rule |
|---|---|
| Package content | At most 2,000 files and 50 MiB; marketplace download bytes are also bounded |
| Filesystem paths | Reject traversal and symlinks; referenced entries must remain in the plugin root except the separately declared theme-asset route |
| Always skipped by devkit walk | `.git` and `node_modules` directories |
| Also excluded from devkit package | Root `dist/`, `.env`, `.env.*`, `.npmrc`, `*.pem`, `*.key` |
| Credential exclusions | Warn with skipped paths; do not rely on exclusions as a secret scanner |
| Archive encoding | Store-only entries in deterministic code-unit order; package SHA-256 is printed |

`check` applies authoring/package checks, reports blocking errors and advisory
warnings, and `pack` refuses errors. A successful check does not execute the
entry, grant permissions, prove compatibility with every host, or pass a
plugin-center review. Install and exercise the actual artifact before release.

## 4. Integrity

Marketplace installs require the catalog/resolve package SHA-256 and check
announced size when supplied. A mismatch is `PLUGIN_INTEGRITY` and prevents
installation. Local directory loading has no download digest.
`checksums.json` is not a verified per-file integrity protocol in the current
installer. It may be an ordinary bundled file, but provides no host trust gate.
Signatures remain planned; a publisher badge is catalog metadata, not signing.

## 5. Install and upgrade

The host stages input under `plugins/cache/download`, validates archive safety
and manifest references, computes the permission difference, writes the managed
`plugins/installed/<id>` directory, persists the registry, and enables according
to the chosen grants/options. Marketplace downloads reuse this installer.

An existing id with a different version is reported as an upgrade; local
installation does not itself require that version to be newer. Marketplace
selection performs version comparison separately. Existing-version code is
copied to `plugins/cache/backup/<id>/<version>` before replacement. Backup
creation is not a promise of transactional rollback after every later I/O or
runtime-load failure; do not advertise guaranteed automatic rollback.

Upgrades retain the plugin id and private data. Added permissions require
review; automatic update must not silently expand them. Refer to
[08-plugin-signing-updates.md](08-plugin-signing-updates.md) for update policy.

## 6. Uninstall

The runtime first unloads the plugin and withdraws its contributions. Host-core
removes the registry row, managed installed code, private data, and legacy
per-plugin log file by default. A development source directory is retained.
Bundled plugin ids cannot be uninstalled, including after a marketplace update;
disable them instead. There is no implemented keep-data toggle or uninstall
lifecycle callback.

## 7. CLI and publisher handoff

Run these commands from the PI-Desktop repository root after its normal setup:

```bash
pnpm pi-plugin check ../my-plugin
pnpm pi-plugin pack ../my-plugin
pnpm pi-plugin publish ../my-plugin --channel stable
```

`publish` creates a local `.piplug` and `.submission.json`; it does not upload.
It records repository/ref/commit/path and artifact digest/size. It requires a
git repository with `origin`, rejects credential-bearing remotes, and refuses
a dirty tree unless `--allow-dirty` is explicit. Ignore `dist/` first because
packing precedes that clean-tree check. A tag at HEAD is preferred; `--ref` is
recorded but does not replace the recorded HEAD commit or make it reproducible.
The plugin center independently resolves and verifies the source claim.

## 8. Implementation evidence

- `packages/plugin-devkit/src/{check,walk,pack,publish,cli}.ts` and their tests
- `crates/host-core/src/plugins/{install,manifest,validation,registry}.rs`
- [Author release workflow](../../plugin-development.md#9-check-pack-and-install)
