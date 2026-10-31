# 11. Plugin Storage Isolation

## 1. Ownership and layout

Rust host-core owns the plugin registry, managed installation files, and all
SQLite access. Electron Main's plugin broker owns plugin settings files and
runtime bookkeeping. Plugins use public APIs, never host database handles.
The data root belongs to the owning host instance; do not hard-code
`~/.pi-desktop` or reread a process-global override to locate another instance's
catalog/cache. Development code remains at the loaded source directory.

```text
<dataRoot>/plugins/
├── registry.json
├── installed/<plugin-id>/
├── data/<plugin-id>/
│   └── settings.json
├── logs/                    # legacy per-plugin log location
├── cache/download/
├── cache/backup/<plugin-id>/<version>/
└── market/
    ├── catalog.json
    └── packages/
```

## 2. Registry

`plugins/registry.json` records installed/development/marketplace entries,
enabled state, activation scope, granted permissions, path/version, update
preferences, and marketplace provenance. The host reads and writes it; it is
not a plugin API or a file plugins should edit. The registry restores the list
on restart. Runtime load/service state is a projection, not a substitute for
this durable ownership record.

## 3. Private settings and files

`pi.plugin.getDataPath()` returns only the calling plugin's private data
directory. `pi.plugin.getSettings()` merges declared defaults with its stored
`settings.json`; `setSettings(partial)` merges a patch. Settings are not stored
in the host SQLite `kv` table by this implementation. Theme variable values
share a host-reserved private settings namespace managed through
`pi.themes.setVariables`; do not overwrite it yourself.

Settings are ordinary JSON, not a secret store. `secret: true` generated
settings are rejected. Provider API keys stay in the host secret store; the
separate `provider.oauth` callback can receive only its contribution's OAuth
credential. No generic plugin-secret read/write API exists.

## 4. Filesystem and process trust

`pi.fs.*` operates on the declared workspace/user-selected scope; it is not a
generic private-data filesystem API. File actions use the calling tool session
or the appropriate view/workspace root. The broker refuses host-reserved data
and protected credentials and prevents escaping a root through symlinks.

These are **brokered API** guarantees. A plugin's Node entry process currently
retains raw Node filesystem/network access under the user's OS account. Its
private path is namespacing, not an OS sandbox. A trusted `renderer.extension`
likewise shares the host document. Isolated panel/view pages have no Node
integration and cannot open the host database through the preload.

## 5. Sessions, usage, and collaboration

`session.read` returns only the invoking tool session's bounded model-facing
context. `session.read.own` / `update.own` / `delete.own` address only sessions
imported by the calling plugin. `session.autoTitle` is a bounded first-turn
projection and compare-and-set write. `usage.read` returns completed-turn facts,
not message bodies. These are separate permissions, not broad database access.

The reviewed `desktop.control` collaboration gateway injects source invocation
identity and keeps its durable ledger in host-core. Plugin-private JSON is
never authorization, a host Session ID, or a replacement for that ledger.
The gateway exposes neither SQLite nor arbitrary Electron IPC/MCP bearer tokens.

## 6. Logs and cleanup

Use Settings → Info → Logs and filter by plugin id. The runtime emits audit
records into the categorized application log service; it does not promise one
live `plugins/logs/<id>.log` per plugin. Never log credentials or transcripts.

Uninstall removes the registry row, managed installed code, plugin-private data,
and any legacy per-plugin log file by default. It preserves development source
and refuses bundled ids. No keep-data option is implemented. Disable/reload
withdraws runtime resources but retains settings and private files.

## 7. Implementation evidence and acceptance

- `crates/host-core/src/plugins/registry.rs`: paths, registry and uninstall
- `apps/desktop/electron/main/plugin-runtime.ts`: settings, private paths, scopes
- `apps/desktop/electron/main/plugin-session-scope.ts`: invocation ownership
- Verify restart recovery, settings defaults/patches, cross-plugin read refusal,
  scope/deny-list enforcement, and uninstall cleanup using existing plugin tests.
- Backup/portable configuration has its own host contract; this layout does not
  promise export of arbitrary plugin-private data.
