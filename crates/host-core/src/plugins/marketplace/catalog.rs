use super::super::*;

pub(crate) fn built_in_catalog() -> MarketCatalogFile {
    let data_dir = std::env::var("PI_DESKTOP_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            dirs::home_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join(".pi-desktop")
        });
    let package_dir = data_dir.join("plugins/market/packages");
    let hello_path = package_dir.join("demo.hello-0.2.0.piplug");
    let notes_path = package_dir.join("demo.workspace-notes-0.1.0.piplug");
    let hello_bytes = bundled_package_bytes("demo.hello", "0.2.0").unwrap_or_default();
    let notes_bytes = bundled_package_bytes("demo.workspace-notes", "0.1.0").unwrap_or_default();
    MarketCatalogFile {
        schema_version: 1,
        provider_id: "official".into(),
        catalog_id: None,
        name: Some("PI-Desktop Official Plugins (bundled fallback)".into()),
        homepage: Some("https://github.com/vastsa/pi-desktop-plugins".into()),
        updated_at: Some("2026-07-28T00:00:00Z".into()),
        generated_at: None,
        policy_version: None,
        // The bundled fallback materializes packages next to the catalog, so
        // its URLs are already absolute `file://` paths.
        artifact_base_url: None,
        plugins: vec![
            MarketCatalogEntry {
                id: "demo.hello".into(),
                name: "Hello".into(),
                description: "Official sample plugin with panel, command, and echo tool.".into(),
                author: "PI-Desktop".into(),
                icon_url: None,
                categories: vec!["demo".into(), "official".into()],
                verified: true,
                downloads: Some(1280),
                homepage: Some("https://github.com/vastsa/PI-Desktop".into()),
                repository: Some("https://github.com/vastsa/PI-Desktop".into()),
                readme_markdown: Some(
                    "# Hello\n\nOfficial demo plugin used by the local marketplace provider.".into(),
                ),
                safety_notes: Some("Low risk demo. Registers one agent tool and one panel.".into()),
                versions: vec![MarketVersion {
                    version: "0.2.0".into(),
                    published_at: "2026-07-28T00:00:00Z".into(),
                    changelog: Some("Marketplace package with isolated panel bridge.".into()),
                    min_pi_desktop: Some(">=0.2.0".into()),
                    shasum: sha256_hex(&hello_bytes),
                    url: format!("file://{}", hello_path.to_string_lossy()),
                    size_bytes: hello_bytes.len() as u64,
                    permissions: vec![
                        "ui.panel".into(),
                        "agent.tool.register".into(),
                        "notify".into(),
                    ],
                    ..Default::default()
                }],
                ..Default::default()
            },
            MarketCatalogEntry {
                id: "demo.workspace-notes".into(),
                name: "Workspace Notes".into(),
                description: "Read/write a notes file in the current workspace and fetch optional snippets.".into(),
                author: "PI-Desktop".into(),
                icon_url: None,
                categories: vec!["productivity".into(), "official".into()],
                verified: true,
                downloads: Some(420),
                homepage: None,
                repository: None,
                readme_markdown: Some(
                    "# Workspace Notes\n\nDemonstrates high-risk plugin capabilities with explicit grants.".into(),
                ),
                safety_notes: Some(
                    "Requests workspace write and network access. Review permissions before install.".into(),
                ),
                versions: vec![MarketVersion {
                    version: "0.1.0".into(),
                    published_at: "2026-07-28T00:00:00Z".into(),
                    changelog: Some("Initial marketplace release.".into()),
                    min_pi_desktop: Some(">=0.2.0".into()),
                    shasum: sha256_hex(&notes_bytes),
                    url: format!("file://{}", notes_path.to_string_lossy()),
                    size_bytes: notes_bytes.len() as u64,
                    permissions: vec![
                        "ui.panel".into(),
                        "fs.read.workspace".into(),
                        "fs.write.workspace".into(),
                        "net.fetch".into(),
                        "shell.openExternal".into(),
                        "clipboard.read".into(),
                        "clipboard.write".into(),
                        "notify".into(),
                        "agent.tool.register".into(),
                    ],
                    ..Default::default()
                }],
                ..Default::default()
            },
        ],
    }
}

pub(crate) fn bundled_package_bytes(plugin_id: &str, version: &str) -> Option<Vec<u8>> {
    match (plugin_id, version) {
        ("demo.hello", "0.2.0") => Some(make_zip(&[
            (
                "manifest.json",
                br#"{
  "schemaVersion": 1,
  "id": "demo.hello",
  "name": "Hello",
  "version": "0.2.0",
  "description": "Official sample plugin with panel, command, and echo tool.",
  "author": "PI-Desktop",
  "main": "main.js",
  "ui": {
    "panel": "renderer/index.html",
    "width": 420,
    "height": 320,
    "title": "Hello Plugin"
  },
  "contributes": {
    "commands": [
      {
        "id": "hello.open",
        "title": "Hello: Open Panel",
        "keywords": ["hello", "demo"],
        "category": "Demo"
      }
    ],
    "agentTools": [
      {
        "name": "echo_text",
        "description": "Echo text back to the agent",
        "risk": "low",
        "schema": {
          "type": "object",
          "properties": { "text": { "type": "string" } },
          "required": ["text"]
        }
      }
    ],
    "settings": [
      {
        "key": "greeting",
        "type": "string",
        "default": "Hello from marketplace",
        "title": "Greeting"
      }
    ]
  },
  "permissions": ["ui.panel", "agent.tool.register", "notify"]
}"#,
            ),
            (
                "main.js",
                br#"async function onLoad() {
  const settings = await pi.plugin.getSettings();
  await pi.commands.register({
    id: "hello.open",
    title: "Hello: Open Panel",
    keywords: ["hello", "demo"],
    run: async () => {
      await pi.ui.openPanel({ title: "Hello Plugin" });
      await pi.ui.showToast(settings.greeting || "Hello from marketplace");
    },
  });
  await pi.agent.registerTool({
    name: "echo_text",
    description: "Echo text back to the agent",
    risk: "low",
    schema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
    execute: async (args) => ({
      ok: true,
      echo: String(args?.text ?? ""),
      pluginId: pi.plugin.getId(),
    }),
  });
}
async function onUnload() {
  await pi.commands.unregister("hello.open");
  await pi.agent.unregisterTool("echo_text");
}
module.exports = { onLoad, onUnload };
"#,
            ),
            (
                "renderer/index.html",
                br#"<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="pi-plugin-chrome" content="v2" />
    <title>Hello Plugin</title>
    <style>
      :root { color-scheme: dark; --bg: #181818; --surface: #212121; --fg: #ffffff; --muted: color-mix(in oklab, #ffffff 52%, transparent); --border: color-mix(in oklab, #ffffff 10%, transparent); --accent: #ffffff; }
      :root[data-base="light"] { color-scheme: light; --bg: #ffffff; --surface: #f9f9f9; --fg: #1a1c1f; --muted: #5d5d5d; --border: color-mix(in oklab, #1a1c1f 10%, transparent); --accent: #1a1c1f; }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; padding: var(--pi-plugin-titlebar-height, 0px) 16px 16px; overflow: auto; background: var(--bg); color: var(--fg); }
      /* PI-Desktop reserves exactly a transparent 46px drag band. Normal-flow
         content is offset automatically; fixed/sticky top UI starts at
         top: var(--pi-plugin-titlebar-height, 46px). */
      .card { border: 1px solid var(--border); border-radius: 12px; padding: 16px; background: var(--surface); }
      h2 { margin: 0 0 4px; font-size: 16px; font-weight: 560; letter-spacing: -0.02em; }
      p { margin: 0; color: var(--muted); }
      button { margin-top: 12px; border: 1px solid var(--border); border-radius: 8px; padding: 8px 12px; background: var(--accent); color: var(--bg); cursor: pointer; font: inherit; }
      button:focus-visible { outline: 2px solid color-mix(in oklab, var(--accent) 58%, transparent); outline-offset: 2px; }
    </style>
  </head>
  <body>
    <div class="card">
      <h2>Hello Plugin</h2>
      <p>Isolated marketplace panel with host bridge.</p>
      <button id="ping">Toast Ping</button>
    </div>
    <script>
      const applyAppearance = (appearance) => {
        const base = appearance?.base;
        document.documentElement.dataset.base = base === "light" || base === "dark"
          ? base
          : window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
      };
      window.pluginBridge?.on("appearance:changed", applyAppearance);
      window.pluginBridge?.invoke("app.getAppearance").then(applyAppearance).catch(() => applyAppearance(null));
      document.getElementById("ping").addEventListener("click", async () => {
        if (window.pluginBridge?.invoke) {
          await window.pluginBridge.invoke("ui.showToast", { message: "Hello panel bridge" });
        }
      });
    </script>
  </body>
</html>
"#,
            ),
        ])),
        ("demo.workspace-notes", "0.1.0") => Some(make_zip(&[
            (
                "manifest.json",
                br#"{
  "schemaVersion": 1,
  "id": "demo.workspace-notes",
  "name": "Workspace Notes",
  "version": "0.1.0",
  "description": "Read/write workspace notes and fetch remote snippets with explicit high-risk grants.",
  "author": "PI-Desktop",
  "main": "main.js",
  "ui": {
    "panel": "renderer/index.html",
    "width": 480,
    "height": 420,
    "title": "Workspace Notes"
  },
  "contributes": {
    "commands": [
      {
        "id": "notes.open",
        "title": "Notes: Open Panel",
        "keywords": ["notes", "workspace"],
        "category": "Productivity"
      }
    ],
    "agentTools": [
      {
        "name": "save_note",
        "description": "Append a note to NOTES.md in the workspace",
        "risk": "high",
        "schema": {
          "type": "object",
          "properties": { "text": { "type": "string" } },
          "required": ["text"]
        }
      }
    ]
  },
  "permissions": [
    "ui.panel",
    "fs.read.workspace",
    "fs.write.workspace",
    "net.fetch",
    "shell.openExternal",
    "clipboard.read",
    "clipboard.write",
    "notify",
    "agent.tool.register"
  ]
}"#,
            ),
            (
                "main.js",
                br#"const NOTE_FILE = "NOTES.md";
async function onLoad() {
  await pi.commands.register({
    id: "notes.open",
    title: "Notes: Open Panel",
    keywords: ["notes", "workspace"],
    run: async () => {
      await pi.ui.openPanel({ title: "Workspace Notes" });
    },
  });
  await pi.agent.registerTool({
    name: "save_note",
    description: "Append a note to NOTES.md in the workspace",
    risk: "high",
    schema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
    execute: async (args) => {
      const text = String(args?.text ?? "").trim();
      let current = "";
      try { current = await pi.fs.readText(NOTE_FILE); } catch {}
      const next = current ? `${current.trimEnd()}\n- ${text}\n` : `# Notes\n\n- ${text}\n`;
      await pi.fs.writeText(NOTE_FILE, next);
      await pi.ui.notify({ title: "Note saved", body: text.slice(0, 80) });
      return { ok: true, path: NOTE_FILE, bytes: next.length };
    },
  });
}
async function onUnload() {
  await pi.commands.unregister("notes.open");
  await pi.agent.unregisterTool("save_note");
}
module.exports = { onLoad, onUnload };
"#,
            ),
            (
                "renderer/index.html",
                br#"<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="pi-plugin-chrome" content="v2" />
  <title>Workspace Notes</title>
  <style>
    :root { color-scheme: dark; --bg: #181818; --surface: #212121; --fg: #ffffff; --muted: color-mix(in oklab, #ffffff 52%, transparent); --border: color-mix(in oklab, #ffffff 10%, transparent); --accent: #ffffff; }
    :root[data-base="light"] { color-scheme: light; --bg: #ffffff; --surface: #f9f9f9; --fg: #1a1c1f; --muted: #5d5d5d; --border: color-mix(in oklab, #1a1c1f 10%, transparent); --accent: #1a1c1f; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--fg); padding: var(--pi-plugin-titlebar-height, 0px) 16px 16px; overflow: auto; }
    /* PI-Desktop reserves exactly a transparent 46px drag band. Normal-flow
       content is offset automatically; fixed/sticky top UI starts at
       top: var(--pi-plugin-titlebar-height, 46px). */
    textarea { width: 100%; min-height: 180px; border-radius: 10px; border: 1px solid var(--border); background: var(--surface); color: inherit; padding: 10px; box-sizing: border-box; font: inherit; }
    .row { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
    button { border: 1px solid var(--border); border-radius: 8px; padding: 8px 12px; background: var(--accent); color: var(--bg); cursor: pointer; font: inherit; }
    button.secondary { background: var(--surface); color: var(--fg); }
    .meta { color: var(--muted); font-size: 12px; margin-bottom: 8px; }
  </style>
</head>
<body>
  <div class="meta">High-risk demo: workspace files, clipboard, network, external links.</div>
  <textarea id="notes" placeholder="Workspace NOTES.md"></textarea>
  <div class="row">
    <button id="reload">Reload</button>
    <button id="save">Save</button>
    <button class="secondary" id="clip">Copy</button>
    <button class="secondary" id="fetch">Fetch sample</button>
    <button class="secondary" id="docs">Open docs</button>
  </div>
  <script>
    const applyAppearance = (appearance) => {
      const base = appearance?.base;
      document.documentElement.dataset.base = base === "light" || base === "dark"
        ? base
        : window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
    };
    window.pluginBridge?.on("appearance:changed", applyAppearance);
    window.pluginBridge?.invoke("app.getAppearance").then(applyAppearance).catch(() => applyAppearance(null));
    const notes = document.getElementById('notes');
    async function reload() {
      try { notes.value = await window.pluginBridge.invoke('fs.readText', { path: 'NOTES.md' }); }
      catch { notes.value = '# Notes\n\n'; }
    }
    document.getElementById('reload').onclick = reload;
    document.getElementById('save').onclick = async () => {
      await window.pluginBridge.invoke('fs.writeText', { path: 'NOTES.md', content: notes.value });
      await window.pluginBridge.invoke('ui.showToast', { message: 'Saved NOTES.md' });
    };
    document.getElementById('clip').onclick = async () => {
      await window.pluginBridge.invoke('clipboard.writeText', { text: notes.value });
      await window.pluginBridge.invoke('ui.showToast', { message: 'Copied to clipboard' });
    };
    document.getElementById('fetch').onclick = async () => {
      const res = await window.pluginBridge.invoke('net.fetch', {
        url: 'https://example.com',
        method: 'GET',
        timeoutMs: 8000,
      });
      notes.value = `${notes.value.trim()}\n\n<!-- fetched status ${res.status} -->\n`;
    };
    document.getElementById('docs').onclick = async () => {
      await window.pluginBridge.invoke('shell.openExternal', { url: 'https://example.com' });
    };
    reload();
  </script>
</body>
</html>
"#,
            ),
        ])),
        _ => None,
    }
}

pub(crate) fn make_zip(files: &[(&str, &[u8])]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut offset: u32 = 0;
    let mut central = Vec::new();
    let mut entries = 0u16;
    for (name, data) in files {
        let name_bytes = name.as_bytes();
        let crc = crc32(data);
        let mut local = Vec::new();
        local.extend_from_slice(&0x04034b50u32.to_le_bytes());
        local.extend_from_slice(&20u16.to_le_bytes()); // version needed
        local.extend_from_slice(&0u16.to_le_bytes()); // flags
        local.extend_from_slice(&0u16.to_le_bytes()); // method store
        local.extend_from_slice(&0u16.to_le_bytes()); // time
        local.extend_from_slice(&0u16.to_le_bytes()); // date
        local.extend_from_slice(&crc.to_le_bytes());
        local.extend_from_slice(&(data.len() as u32).to_le_bytes());
        local.extend_from_slice(&(data.len() as u32).to_le_bytes());
        local.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
        local.extend_from_slice(&0u16.to_le_bytes()); // extra
        local.extend_from_slice(name_bytes);
        local.extend_from_slice(data);
        out.extend_from_slice(&local);

        let mut cen = Vec::new();
        cen.extend_from_slice(&0x02014b50u32.to_le_bytes());
        cen.extend_from_slice(&20u16.to_le_bytes());
        cen.extend_from_slice(&20u16.to_le_bytes());
        cen.extend_from_slice(&0u16.to_le_bytes());
        cen.extend_from_slice(&0u16.to_le_bytes());
        cen.extend_from_slice(&0u16.to_le_bytes());
        cen.extend_from_slice(&0u16.to_le_bytes());
        cen.extend_from_slice(&crc.to_le_bytes());
        cen.extend_from_slice(&(data.len() as u32).to_le_bytes());
        cen.extend_from_slice(&(data.len() as u32).to_le_bytes());
        cen.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
        cen.extend_from_slice(&0u16.to_le_bytes());
        cen.extend_from_slice(&0u16.to_le_bytes());
        cen.extend_from_slice(&0u16.to_le_bytes());
        cen.extend_from_slice(&0u16.to_le_bytes());
        cen.extend_from_slice(&0u32.to_le_bytes());
        cen.extend_from_slice(&offset.to_le_bytes());
        cen.extend_from_slice(name_bytes);
        central.extend_from_slice(&cen);
        offset += local.len() as u32;
        entries += 1;
    }
    let central_offset = out.len() as u32;
    out.extend_from_slice(&central);
    let central_size = central.len() as u32;
    out.extend_from_slice(&0x06054b50u32.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&entries.to_le_bytes());
    out.extend_from_slice(&entries.to_le_bytes());
    out.extend_from_slice(&central_size.to_le_bytes());
    out.extend_from_slice(&central_offset.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out
}
