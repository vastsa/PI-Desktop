import { describe, expect, it } from "vitest";
import {
  pluginMcpToolKey,
  pluginSkillId,
  pluginThemeId,
  pluginToolName,
  resolvePluginLocalizedString,
  validateContributions,
  validateManifest,
  LEGACY_FS_PERMISSIONS,
  PLUGIN_PERMISSIONS,
  PLUGIN_VIEW_ICONS,
} from "./index.js";

const base = { schemaVersion: 1, id: "demo.x", name: "X", version: "0.1.0", main: "main.js" };

describe("validateManifest", () => {
  it("accepts and resolves English/Chinese panel titles", () => {
    const result = validateManifest({
      ...base,
      ui: { panel: "renderer/index.html", title: { en: "Hello", "zh-CN": "你好" } },
    });
    expect(result.ok).toBe(true);
    expect(resolvePluginLocalizedString(result.manifest?.ui?.title, "en-US")).toBe("Hello");
    expect(resolvePluginLocalizedString(result.manifest?.ui?.title, "zh-CN")).toBe("你好");
  });

  it("falls back to English for shell locales without a plugin translation", () => {
    const value = { en: "History", "zh-CN": "历史" };
    expect(resolvePluginLocalizedString(value, "zh-TW")).toBe("History");
    expect(resolvePluginLocalizedString(value, "zh-Hant")).toBe("History");
    expect(resolvePluginLocalizedString(value, "zh-CN")).toBe("历史");
  });

  it("requires both supported locales for localized panel titles", () => {
    expect(
      validateManifest({ ...base, ui: { title: { en: "Hello" } } }).error,
    ).toMatch(/zh-CN is required/);
  });

  it("accepts the new contribution shapes", () => {
    const result = validateManifest({
      ...base,
      contributes: {
        skills: ["./skills/a.md", { path: "skills/b.md", id: "b", name: "B" }],
        themes: [{ id: "midnight", label: "Midnight", path: "themes/midnight.css", base: "dark" }],
        mcpServers: [{ id: "files", transport: "stdio", command: "mcp-files" }],
        services: [{ id: "watcher", autoRestart: true }],
        bus: { publish: ["notes.created"], subscribe: ["notes.**"] },
        sessionSources: [{ id: "legacy", label: { en: "Legacy", "zh-CN": "旧会话" } }],
      },
    });
    expect(result.ok).toBe(true);
  });

  it("accepts enabledByDefault as a boolean", () => {
    expect(validateManifest({ ...base, enabledByDefault: false }).ok).toBe(true);
    expect(validateManifest({ ...base, enabledByDefault: "no" }).error).toMatch(
      /enabledByDefault must be a boolean/,
    );
  });

  it("accepts author as a string or contact object plus homepage/repository", () => {
    expect(validateManifest({ ...base, author: "PI-Desktop" }).ok).toBe(true);
    expect(
      validateManifest({
        ...base,
        author: { name: "PI", email: "pi@example.com", url: "https://example.com" },
        homepage: "https://example.com",
        repository: "https://github.com/example/pi",
      }).ok,
    ).toBe(true);
    expect(validateManifest({ ...base, author: { email: "x" } }).error).toMatch(/author\.name/);
    expect(validateManifest({ ...base, author: 42 }).error).toMatch(/manifest\.author/);
    expect(validateManifest({ ...base, homepage: 7 }).error).toMatch(/homepage/);
    expect(validateManifest({ ...base, repository: "" }).error).toMatch(/repository/);
  });

  it("keeps main and ui.panel inside the plugin directory", () => {
    expect(validateManifest({ ...base, main: "../main.js" }).error).toMatch(/manifest\.main.*\.\./);
    expect(validateManifest({ ...base, main: "/abs/main.js" }).error).toMatch(/manifest\.main.*absolute/);
    expect(validateManifest({ ...base, main: "C:\\main.js" }).error).toMatch(/manifest\.main.*absolute/);
    expect(validateManifest({ ...base, ui: { panel: "../panel.html" } }).error).toMatch(
      /manifest\.ui\.panel.*\.\./,
    );
    expect(validateManifest({ ...base, ui: { panel: "/panel.html" } }).error).toMatch(
      /manifest\.ui\.panel.*absolute/,
    );
    expect(validateManifest({ ...base, ui: { panel: 3 } }).error).toMatch(/manifest\.ui\.panel/);
    expect(validateManifest({ ...base, ui: { panel: "renderer/index.html" } }).ok).toBe(true);
  });

  it("surfaces contribution errors", () => {
    expect(
      validateManifest({ ...base, contributes: { themes: [{ id: "a", label: "A", path: "a.json" }] } })
        .error,
    ).toMatch(/\.css file/);
    expect(validateManifest({ ...base, contributes: { skills: ["../escape.md"] } }).error).toMatch(
      /\.\./,
    );
    expect(
      validateManifest({
        ...base,
        contributes: { sessionSources: [{ id: "legacy" }, { id: "legacy" }] },
      }).error,
    ).toMatch(/duplicate session source/);
  });
});

describe("validateContributions", () => {
  it("passes when absent", () => {
    expect(validateContributions(undefined)).toBeUndefined();
  });

  it("rejects duplicate ids", () => {
    expect(
      validateContributions({
        themes: [
          { id: "a", label: "A", path: "a.css" },
          { id: "a", label: "A2", path: "b.css" },
        ],
      }),
    ).toMatch(/duplicate theme id/);
    expect(
      validateContributions({ services: [{ id: "s" }, { id: "s" }] }),
    ).toMatch(/duplicate service id/);
    expect(
      validateContributions({
        mcpServers: [
          { id: "m", transport: "stdio", command: "x" },
          { id: "m", transport: "stdio", command: "y" },
        ],
      }),
    ).toMatch(/duplicate mcp server id/);
  });

  it("rejects invalid bus declarations", () => {
    expect(validateContributions({ bus: { publish: ["notes.*"] } })).toMatch(/valid topic/);
    expect(validateContributions({ bus: { subscribe: ["notes.**.x"] } })).toMatch(/not valid/);
  });

  it("rejects malformed skill and service entries", () => {
    expect(validateContributions({ skills: [{ path: "" } as never] })).toMatch(/need a path/);
    expect(validateContributions({ services: [{ id: "1bad" }] })).toMatch(/id must match/);
  });

  it("reports a null or malformed command entry instead of throwing", () => {
    expect(() => validateContributions({ commands: [null as never] })).not.toThrow();
    expect(validateContributions({ commands: [null as never] })).toMatch(/commands entries/);
    expect(validateContributions({ commands: [{ title: "No id" } as never] })).toMatch(/need an id/);
    expect(validateContributions({ commands: [{ id: "x.open" } as never] })).toMatch(/requires a title/);
    expect(
      validateContributions({
        commands: [
          { id: "x.open", title: "A" },
          { id: "x.open", title: "B" },
        ],
      }),
    ).toMatch(/duplicate command id/);
    const result = validateManifest({ ...base, contributes: { commands: [null] } });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/commands entries/);
  });

  it("accepts plugin-local shortcut settings and rejects undeclared commands", () => {
    expect(
      validateContributions({
        commands: [{ id: "demo.open", title: "Open" }],
        settings: [
          {
            key: "openShortcut",
            title: "Open shortcut",
            type: "shortcut",
            default: "Mod+Shift+O",
            command: "demo.open",
            scope: "plugin",
          },
        ],
      }),
    ).toBeUndefined();
    expect(
      validateContributions({
        settings: [
          { key: "openShortcut", title: "Open shortcut", type: "shortcut", command: "demo.open" },
        ],
      }),
    ).toMatch(/undeclared command/);
  });
});

describe("contributes.views", () => {
  const view = { id: "changes", title: "Changes", entry: "views/changes.html" };

  it("accepts plain and localized titles, icons, and order", () => {
    expect(
      validateContributions({
        views: [
          view,
          {
            id: "history",
            title: { en: "History", "zh-CN": "历史" },
            icon: "clock",
            entry: "views/history.html",
            order: 10,
          },
        ],
      }),
    ).toBeUndefined();
  });

  it("requires an id, a title, and an entry", () => {
    expect(validateContributions({ views: [{ ...view, id: "1bad" }] })).toMatch(/views id/);
    expect(validateContributions({ views: [{ ...view, title: undefined as never }] })).toMatch(
      /requires a title/,
    );
    expect(validateContributions({ views: [{ ...view, title: "  " }] })).toMatch(
      /requires a title/,
    );
    expect(validateContributions({ views: [{ ...view, entry: "" }] })).toMatch(
      /requires an entry/,
    );
  });

  it("requires both locales for a localized title", () => {
    expect(
      validateContributions({ views: [{ ...view, title: { en: "Changes" } as never }] }),
    ).toMatch(/zh-CN is required/);
  });

  it("rejects duplicate ids and escaping entry paths", () => {
    expect(validateContributions({ views: [view, view] })).toMatch(/duplicate view id/);
    expect(
      validateContributions({ views: [{ ...view, entry: "../outside.html" }] }),
    ).toMatch(/\.\./);
    expect(
      validateContributions({ views: [{ ...view, entry: "/etc/passwd" }] }),
    ).toMatch(/absolute path/);
  });

  it("accepts an unknown icon token, because it degrades to a letter tile", () => {
    expect(
      validateContributions({ views: [{ ...view, icon: "not-a-real-icon" }] }),
    ).toBeUndefined();
    expect(PLUGIN_VIEW_ICONS).toContain("diff");
    expect(new Set(PLUGIN_VIEW_ICONS).size).toBe(PLUGIN_VIEW_ICONS.length);
  });
});

describe("naming helpers", () => {
  it("keeps the forced plugin tool prefix", () => {
    expect(pluginToolName("demo.hello", "echo-text")).toBe("plugin_demo_hello_echo_text");
    expect(pluginToolName("demo.hello", pluginMcpToolKey("files", "read_file"))).toBe(
      "plugin_demo_hello_files_read_file",
    );
  });

  it("namespaces skills and themes by plugin", () => {
    expect(pluginSkillId("demo.hello", "release")).toBe("demo.hello/release");
    expect(pluginThemeId("demo.hello", "midnight")).toBe("plugin:demo.hello:midnight");
  });
});

describe("planSafeActions contract (ADR 0211)", () => {
  it("accepts a planSafeActions list on a manifest agentTool", () => {
    const result = validateManifest({
      ...base,
      contributes: {
        agentTools: [
          {
            name: "Browser",
            description: "browser tool",
            risk: "medium",
            planSafeActions: ["navigate", "snapshot"],
            schema: {
              type: "object",
              properties: {
                action: { type: "string", enum: ["navigate", "snapshot", "click"] },
              },
              required: ["action"],
            },
          },
        ],
      },
    });
    expect(result.ok).toBe(true);
  });

  it("treats an absent planSafeActions as plan-denied", () => {
    const result = validateManifest({
      ...base,
      contributes: {
        agentTools: [
          {
            name: "Browser",
            description: "browser tool",
            schema: {
              type: "object",
              properties: { action: { type: "string", enum: ["navigate"] } },
            },
          },
        ],
      },
    });
    expect(result.ok).toBe(true);
  });
});

describe("PLUGIN_PERMISSIONS", () => {
  it("declares the capability permissions and stays unique", () => {
    for (const permission of [
      "ui.theme",
      "ui.view",
      "mcp.server.local",
      "mcp.server.remote",
      "background.service",
      "bus.publish",
      "bus.subscribe",
      "agent.prompt.inject",
      "agent.complete",
      "models.list",
      "project.create",
      "session.read",
      "fs.read",
      "fs.write",
      "fs.delete",
      "browser.cdp",
    ]) {
      expect(PLUGIN_PERMISSIONS).toContain(permission);
    }
    expect(new Set(PLUGIN_PERMISSIONS).size).toBe(PLUGIN_PERMISSIONS.length);
  });

  it("no longer advertises the unscoped workspace-wide fs names", () => {
    for (const legacy of Object.keys(LEGACY_FS_PERMISSIONS)) {
      expect(PLUGIN_PERMISSIONS).not.toContain(legacy);
    }
  });
});

describe("validateManifest net.domains", () => {
  it("accepts an omitted or well-formed allowlist", () => {
    expect(validateManifest(base).ok).toBe(true);
    expect(
      validateManifest({ ...base, net: { domains: ["api.github.com", "*.example.com"] } }).ok,
    ).toBe(true);
  });

  it("rejects a malformed allowlist at install instead of at call time", () => {
    for (const net of [
      { domains: "api.github.com" },
      { domains: ["*"] },
      { domains: ["https://api.github.com"] },
    ]) {
      const result = validateManifest({ ...base, net });
      expect(result.ok, JSON.stringify(net)).toBe(false);
      expect(result.error).toMatch(/^manifest\.net\.domains/);
    }
    expect(validateManifest({ ...base, net: [] }).ok).toBe(false);
  });
});

describe("validateManifest fs scope", () => {
  it("accepts a scoped policy backed by its permissions", () => {
    expect(
      validateManifest({
        ...base,
        permissions: ["fs.read", "fs.write", "fs.delete"],
        fs: {
          read: { scope: ["**/*"] },
          write: { scope: ["docs/**"] },
          delete: { own: true, scope: ["dist/**"] },
        },
      }).ok,
    ).toBe(true);
  });

  it("rejects a write or delete scope that covers the whole root", () => {
    const result = validateManifest({
      ...base,
      permissions: ["fs.write"],
      fs: { write: { scope: ["**/*"] } },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/^manifest\.fs\.write\.scope/);
  });

  it("rejects a scope whose permission was never declared", () => {
    const result = validateManifest({ ...base, fs: { write: { scope: ["docs/**"] } } });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/needs the fs\.write permission/);
  });

  it("accepts a legacy permission name as the scope's backing", () => {
    // The old name still resolves to fs.read, so an author can add scope
    // before renaming and neither step breaks on its own.
    expect(
      validateManifest({
        ...base,
        permissions: ["fs.read.workspace"],
        fs: { read: { scope: ["docs/**"] } },
      }).ok,
    ).toBe(true);
  });
});

describe("contributes.agentExtensions", () => {
  const base = { schemaVersion: 1, id: "demo.ax", name: "AX", version: "0.1.0", main: "main.js" };

  it("accepts relative .ts/.js entries when agent.extension is declared", () => {
    const result = validateManifest({
      ...base,
      permissions: ["agent.extension"],
      contributes: { agentExtensions: ["src/index.ts", "lib/hooks.mjs"] },
    });
    expect(result.ok).toBe(true);
    expect(result.manifest?.contributes?.agentExtensions).toEqual(["src/index.ts", "lib/hooks.mjs"]);
  });

  it("rejects entries without the permission, outside the plugin, non-script, or too many", () => {
    expect(validateManifest({ ...base, contributes: { agentExtensions: ["src/index.ts"] } }).error).toMatch(
      /agent\.extension permission/,
    );
    const perm = { ...base, permissions: ["agent.extension"] };
    expect(validateManifest({ ...perm, contributes: { agentExtensions: ["../out.ts"] } }).ok).toBe(false);
    expect(validateManifest({ ...perm, contributes: { agentExtensions: ["notes.md"] } }).error).toMatch(/\.ts or \.js/);
    expect(
      validateManifest({ ...perm, contributes: { agentExtensions: Array.from({ length: 9 }, (_, i) => `e${i}.ts`) } })
        .error,
    ).toMatch(/at most/);
    expect(PLUGIN_PERMISSIONS).toContain("agent.extension");
  });
});
