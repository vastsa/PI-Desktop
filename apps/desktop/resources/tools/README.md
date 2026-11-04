# Bundled tool packages

Every directory here is one **tool package**: it appears on the app's Tools page
(sidebar → 工具) and ships inside the application image (electron-builder copies
this tree to `<resources>/tools`).

## Package layout

```
resources/tools/
  local.example.package/
    tool.json
```

## `tool.json`

```json
{
  "schemaVersion": 1,
  "id": "local.example.package",
  "name": "Example tools",
  "version": "0.1.0",
  "description": "What this package is for, in one line.",
  "author": "optional",
  "tools": [
    {
      "name": "inspect_widget",
      "description": "What the tool does, in one line.",
      "risk": "low"
    }
  ]
}
```

| Field | Required | Notes |
| --- | --- | --- |
| `schemaVersion` | yes | Must be `1`; another value renders the row as broken instead of guessing |
| `id` | recommended | Falls back to the directory name; two directories sharing one id render one row and one broken row |
| `name` | recommended | Display name; falls back to `id` |
| `version` | no | Shown as a badge next to the name |
| `description` | no | One line under the name |
| `author` | no | Optional attribution |
| `tools[]` | no | `name` (required per entry), `description`, `risk` = `low` / `medium` / `high` |

A manifest that cannot be read, has an unsupported `schemaVersion`, or contains
malformed JSON still gets a row: the page shows the error so the package can be
fixed instead of silently disappearing.

## Ownership

* **Scan** — host-core reads this directory. Electron only says where it is
  (`PI_DESKTOP_BUILTIN_TOOLS_DIR`), because only Electron knows whether the app
  runs from `resources/` or a source checkout.
* **Enabled set** — host-core persists it in `<data>/tools/state.json`
  (`{ "disabled": ["id", …] }`). The renderer never touches the filesystem.
* **RPC** — `toolPackages.list` and `toolPackages.setEnabled` (see
  `03-runtime/04-data-storage.md`).

Adding a package: create the directory and its `tool.json`, then start the app.
Disabling a package from the Tools page hides it from the agent without
touching the image.
