# 15. Workspace Ignore Rules

## 1. Goal

Prevent tools from scanning/reading/writing sensitive or useless paths by
default, while allowing an explicit, visible permission decision when a task
intentionally targets a path outside the session workspace.

## 2. Rule layers (priority high → low)

1. **Security denylist** (always on, not user-disable in MVP)
2. **App defaults** (shipped)
3. **Workspace rules** (`.pi-desktopignore` or settings)
4. **User global ignore** (`~/.pi-desktop/ignore`)
5. Explicit tool path still subject to the security denylist and the
   outside-path permission gate

## 3. Security denylist (always)

Outside-workspace read/write/search is denied by default. An explicit
`Read`/`Glob`/`Grep`/`Write`/`Edit` path may proceed only after the host applies
the permission mode: `auto` allows it, while `ask` and `accept-edits` ask the
user. An implicit recursive walk never gains outside-workspace access.

Also deny inside workspace for:
- `.git/objects/**` (optional optimize; metadata may be readable later)
- private key patterns: `*.pem`, `*.key`, `id_rsa`, `id_ed25519`
- `.env`, `.env.*` (read may be allowed with permission prompt in later revision; MVP default deny for Grep content export)
- credential files: `*.p12`, `*.pfx`, `credentials.json` (Google), `.npmrc` with tokens (best-effort)

> Exact env-file policy can be relaxed later with explicit permission; fail closed in MVP for content search.

## 4. Default ignore (app)

```gitignore
node_modules/
dist/
build/
.target/
target/
.venv/
venv/
__pycache__/
.pytest_cache/
.mypy_cache/
.DS_Store
*.log
coverage/
.turbo/
.next/
.cache/
```

## 5. Workspace file

Support:

```text
.pi-desktopignore
```

Syntax: gitignore-compatible subset.

## 6. Tool behavior

| tool | ignore application |
|---|---|
| Glob | filtered results |
| Grep | filtered file set |
| Read | permission-gated when explicit path is outside; `TOOL_DENIED` after denial |
| Write/Edit | permission-gated when explicit path is outside; `TOOL_DENIED` after denial |
| Bash | path sandbox still enforced by host; ignore file does not expand bash powers |

## 7. Diagnostics

Tools should return stable errors:
- `PATH_OUTSIDE_WORKSPACE` — path escapes the workspace root before an
  outside-path permission decision, or a non-permissioned compatibility call
  reaches the resolver
- `TOOL_DENIED` — outside-path permission was denied, timed out, or cancelled
- `WORKSPACE_PATH_DENIED` — reserved detail code for ignore/denylist blocks
  (maps to `PATH_OUTSIDE_WORKSPACE` today; see [08-error-codes §3.7](08-error-codes.md))

UI can show “hidden by ignore rules” counts for Glob/Grep optionally later.

## 8. Acceptance criteria

- [x] outside paths require permission in non-auto modes and are allowed in Auto
- [ ] default ignores hide node_modules from Glob/Grep
- [ ] workspace ignore file honored
- [ ] security denylist cannot be disabled from UI in MVP
