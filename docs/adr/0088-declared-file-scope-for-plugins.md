# ADR 0088: Plugin file access is declared per mode, and deletion is recoverable

- Status: Accepted (Implemented 2026-08-15)
- Date: 2026-08-15

## Context

ADR 0008 put plugin main code in its own `utilityProcess`, but noted that the
process is a full Node environment: permissions gate the `pi.*` surface, not
`require("node:fs")`. Capability sandboxing is still the open half (ADR 0008,
D009).

- `fs.read.workspace` → any file in the workspace, including `.env` and
  `.git/config`
- `fs.write.workspace` → any path in the workspace
- `fs.delete.workspace` → `fs.remove` with `recursive: false`, which bounds one
  call and not the blast radius: `fs.glob("**/*")` followed by a loop empties a
  workspace as thoroughly as `rm -rf` does**

- A **read** is dangerous when the bytes can leave.

## Decision

### 1. `manifest.fs` declares scope; permission names stay flat strings

`permissions` remains `readonly string[]` and gains `fs.read`, `fs.write`,
`fs.delete` — "may this plugin touch files at all". A separate `fs` block says
"which files":

```json
{
  "permissions": ["fs.read", "fs.write", "fs.delete"],
  "fs": {
    "read": { "root": "workspace", "scope": ["**/*"] },
    "write": { "root": "workspace", "scope": ["docs/**", "*.md"] },
    "delete": { "own": true, "scope": ["dist/**"] }
  }
}
```

A separate field rather than objects inside `permissions` because permissions
are handled as strings end to end — install review, chips, grant round-trips,
catalog validation — and the marketplace catalog format is versioned separately.

### 2. Four gates, in a fixed order

Every `pi.fs.*` call passes, in order:

1. `assertPermission` — is `fs.<mode>` declared **and** granted (intersection,
   so a revoked permission actually stops working)
2. Containment — `realpath` on both the root and the target; for a path being
   created, `realpath` of the nearest existing ancestor.
3. Unconditional deny-list — credentials and history refused under every root,
   scope, and grant: `.env*`, `.npmrc`, `.netrc`, `.git-credentials`, `id_rsa*`,
   `*.pem`/`*.p12`/`*.pfx`/`*.keystore`, and anything inside `.git`, `.ssh`,
   `.aws`, `.gnupg`, `.kube`, `.docker`, plus the host's own data directory
   (provider keys, session store)
4. Declared scope, else user consent

`pi.fs.glob` answers to the same rules: results are filtered by the read scope,
denied paths and reserved trees are omitted (a name is a read too), and
`node_modules` / `.git` / `.venv` / `__pycache__` are not walked at all.

### 3. Deletion has two tiers, and always goes to the trash

- **`fs.delete` with `own: true`** — the host appends every successful
  `fs.writeText` to a write ledger in the plugin's own data directory (path plus
  mtime, host-owned, not reachable from the plugin API).
- **`fs.delete` with `scope`** — deleting somebody else's file requires the
  globs up front, and they are shown to the user where the permissions are
  shown.

Both tiers additionally:

- go through `shell.trashItem`, never `rm`.
- keep `recursive: false`; a non-empty directory is refused rather than emptied
- answer to a rolling brake of 50 deletes per 60s per plugin.

### 4. Consent is a native dialog, and never more durable than the session

Out-of-scope access calls `dialog.showMessageBox`: **Deny** / **Allow once** /
**Allow this session**. A session grant covers the containing directory and dies
with the process; nothing is persisted.

### 5. `root: "userSelected"`

`pi.fs.requestDirectory()` opens the native directory picker and returns a
handle. Inside that directory the plugin needs no manifest scope — the user just
pointed at it, which *is* the grant — while containment and the deny-list still
apply.

This is where the capability comes back. "Organize my whole photo folder", "bulk
import/export" plugins become possible with **zero standing power**, modelled on
the browser's File System Access API.

### 6. Migration is a breaking downgrade

| Legacy permission | What it is worth now |
|---|---|
| `fs.read.workspace` | `fs.read`, `scope: ["**/*"]` — unchanged, because egress is closed |
| `fs.write.workspace` | `fs.write` with an empty scope — every write asks the user |
| `fs.delete.workspace` | `fs.delete` with `own: true` — only its own output goes without asking |

Capability is reduced; no hole is left open. An explicit rule always beats the
legacy default, so an author upgrades by adding `fs`, never by renaming
anything.

## Consequences

- A plugin that writes or deletes outside its declared scope now prompts, and a
  prompt the user denies is audited as `PERMISSION_DENIED`.
- Installed plugins that predate `manifest.fs` lose write and delete reach on
  the next load.
- Reads stay generous, which keeps the interesting plugins possible.
- Deletion is recoverable through the OS trash on every platform Electron
  supports it, and we store none of the user's data to achieve that — no
  quarantine copy, no undo journal.
- The rate brake is per plugin and rolling, so a legitimate large cleanup is
  interrupted once rather than refused.

## Alternatives considered

- **A host-owned quarantine directory with an undo UI** instead of the OS trash:
  rejected.
- **Objects inside `permissions`** (`{ "name": "fs.write", "scope": [...] }`):
  rejected.
- **Prompt on every file access, no manifest scope**: rejected.
- **Keeping `recursive: false` as the only delete bound**: rejected.
