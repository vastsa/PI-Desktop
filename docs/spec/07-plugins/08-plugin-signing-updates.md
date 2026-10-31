# 08. Plugin Signing and Updates

## 1. Goals

Provide integrity and provenance guarantees for plugin distribution.

Layers:

1. **Checksum**: protect against transfer corruption / tampering (do first)
2. **Signature**: protect against forged provenance (do later)
3. **Update channel**: controlled upgrades

## 2. Verification levels

| Level | Condition | Policy |
|---|---|---|
| L0 | No checksum | Allowed only for dev / local dir |
| L1 | sha256 checksum | Minimum requirement for marketplace downloads |
| L2 | checksum + signature | Required for official / verified plugins (later) |

## 3. Checksum flow

After download:

```text
sha256(file) == downloadInfo.shasum
```

Marketplace installation refreshes the catalog immediately before download so
the URL and checksum are resolved from one current metadata snapshot. A recent
UI cache is not trusted for an online install; if the refresh fails, the last
valid catalog may be used for offline operation and the checksum requirement
still applies.

On failure:
- Do not install
- Show "Integrity check failed"
- Record an audit entry

## 4. Signature scheme (planned, not enforced)

Recommended:

- Algorithm: `Ed25519`
- Publisher key pair
- Public key distributed by the marketplace or the publisher
- Signed object: `pluginId + version + shasum`

Example:

```ts
type PluginSignature = {
 alg: "ed25519"
 publisherId: string
 signedAt: string
 payload: {
 pluginId: string
 version: string
 shasum: string
 }
 signature: string // base64
}
```

A failed verification rejects the install / update.

Sections 4–5 describe proposed signing/key management. The current client
verifies package SHA-256 and reads catalog trust/provenance metadata; it has no
plugin-signing CLI, signature-verification gate, built-in signing key, or
user-managed trusted-key store. A verified badge is not a cryptographic signature.

## 5. Publisher trust (planned key management)

```ts
type PublisherTrust = {
 publisherId: string
 displayName: string
 publicKey: string
 level: "official" | "verified" | "community"
}
```

The host maintains:
- A built-in official public key
- User-added custom trusted publishers (advanced)

## 6. Update channels

```ts
type UpdateChannel = "stable" | "beta" | "dev"
```

Rules:
- Default is stable
- beta/dev require an explicit user opt-in
- Versions from different channels must not be blindly downgraded

## 7. Update policy

### Manual update (do first)
- Check for updates
- Show the changelog
- Upgrade after user confirmation

### Automatic update

The desktop implementation is opt-in per installed plugin. Opening the
Extensions page silently checks the remote catalog; the explicit Check for
updates action always fetches a fresh catalog and falls back to the last valid
cache when offline. Apply automatic updates upgrades only plugins with
auto-update enabled and no new permissions, and still verifies the package
checksum before installation. Updates that add permissions remain a manual
review flow.

## 8. Permission-change review

If a new version adds permissions on upgrade:

1. Block the silent upgrade
2. Show the permission diff
3. Continue after user confirmation

Example:

```text
+ net.fetch
+ fs.write   (docs/**, *.md)
+ fs.delete  (dist/**)
```

## 9. Rollback

P2 goal:

- Keep a backup of the previous version
- Automatically roll back on a failed upgrade
- Allow the user to manually revert (same id, older version)

## 10. Security incident response

If a malicious plugin version is discovered:

- The marketplace side can mark it as yanked
- The host rejects it during checkUpdates / install
- Users who already installed it get a risk warning and one-click disable

### 10.1 Yank semantics (catalog v2)

`yanked: true` on a catalog version is a distribution-side withdrawal, not a
deletion. The host must:

1. Exclude the version from install selection, including an explicit version pick.
2. Exclude it from update selection, so a yanked release is never offered or
   applied by an automatic update.
3. Keep it in version history with `yankedReason`, so a user can understand why
   the version they hold is no longer offered.
4. Mark an installed copy of a yanked version as needing attention. The host does
   not uninstall or disable it on the user's behalf; withdrawal is a distribution
   signal, and removing a working plugin without consent is a worse failure than
   a warning.

If the newest non-yanked version is older than the installed one, the plugin has
no update available. The host never presents a downgrade as an update.

## 10.2 Provenance

Catalog v2 binds each version to the source that produced it:

```ts
type PluginProvenance = {
  sourceRepository: string   // canonical https repository URL
  sourceRef: string          // refs/tags/<tag> or a 40-hex commit
  sourceCommit: string       // resolved 40-hex commit
  sourcePath?: string        // plugin directory inside the repository
  builder?: string           // builder identity and version
  builtAt?: string
}
```

The host stores provenance with the installed plugin and the detail sheet shows
repository and commit before install. Provenance is evidence for a human
decision, not an integrity control: it is only as trustworthy as the catalog it
came from, and the checksum remains the mechanism that decides whether bytes are
accepted.

## 11. Acceptance

1. A mismatched checksum cannot be installed
2. An upgrade that adds permissions prompts the user
3. The official-plugin signature policy has a configurable toggle (during development)
4. Update-check results can be shown in the UI


## 12. Implementation status

Shipped now:

- sha256 checksum verification on marketplace/package install
- update discovery via `market.checkUpdates`
- manual update actions in Plugins UI
- auto-update opt-in per plugin + `market.applyUpdates`
- permission-diff review before upgrades that add capabilities

Still planned:

- mandatory ed25519 signatures
- publisher key management UI
- yank/incident response automation
