# 06. Plugin Packaging

## 1. Goals

Define how plugins are packaged, distributed, and installed, ensuring reproducibility across machines.

## 2. Package formats

### 2.1 Directory package (development/local)
A plain directory containing `manifest.json`.

### 2.2 Distribution package (recommended)
Extension: `.piplug` (essentially a zip)

```text
demo.hello-0.1.0.piplug
└─ (zip)
 ├─ manifest.json
 ├─ main.js
 ├─ renderer/...
 ├─ skills/...
 ├─ themes/...
 └─ checksums.json # optional, in-package manifest
```

> During implementation, `.zip` may be supported first, but at the product level everything is identified as `.piplug`.

## 3. In-package constraints

1. The root must contain `manifest.json`
2. Absolute-path symlinks are not allowed
3. Path traversal (`../`) is not allowed
4. Default max size after extraction for a single package (recommended 50MB, configurable)
5. Max file count (recommended 2000, configurable)

## 4. checksums.json (optional but recommended)

```json
{
 "algorithm": "sha256",
 "files": {
 "manifest.json": "hex...",
 "main.js": "hex..."
 }
}
```

The host can verify at install time.

## 5. Install flow

```text
select package/dir
 → verify archive safety
 → extract to temp
 → validate manifest + files
 → permission review UX
 → move to installed/<id>
 → registry write
 → optional auto enable
```

On failure, clean up temp and leave no half-installed directory.

## 6. Versioning and overwrite

- Installing a new version with the same id: upgrade
- Back up the old version to `cache/backup/<id>/<version>` before upgrade
- Rollback on upgrade failure (P2)

Semantics:
- `install`: id does not exist
- `upgrade`: id exists and version is newer
- `reinstall`: force reinstall of the same version

## 7. Uninstall and cleanup

Delete:
- `plugins/installed/<id>`
- registry entry

Optionally delete:
- `plugins/data/<id>`
- plugin logs

## 8. Development packages

Development loading does not go through `.piplug` packaging; instead:

```text
Load Development Plugin → choose directory → validate → register(source=dev)
```

## 9. Build recommendations (developers)

Minimal spec:

- Source can be TypeScript
- Compile to directly loadable js/html/css before distribution
- Do not rely on the host to run `npm install` on the spot (MVP does not support pulling dependencies at install time)

If a plugin needs third-party libraries:
- Bundle them into the plugin directory yourself

## 10. Acceptance

1. Can install from a directory
2. Can install from `.piplug` / `.zip` (per milestone during implementation)
3. A bad package fails to install and leaves no residue
4. After upgrade, the id stays the same and the new version takes effect


## 11. Implementation status

Implemented in host-core + desktop shell:

1. Directory install via `plugins.installFromPath`
2. `.piplug` / store-compressed zip install via `plugins.installFromPackage`
3. Marketplace download installs reuse the same package installer
4. Traversal / symlink / size / file-count guards are enforced before commit to `plugins/installed/<id>`
