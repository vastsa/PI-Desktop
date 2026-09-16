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
  MAX_GLOBAL_SHORTCUTS_PER_PLUGIN,
  PLUGIN_PERMISSIONS,
  PLUGIN_VIEW_ICONS,
  type PluginProviderContrib,
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

  it("validates typed theme variables and sandboxed settings destinations", () => {
    expect(
      validateContributions({
        themes: [{
          id: "scenic",
          label: "Scenic",
          path: "themes/scenic.css",
          variables: [{ name: "--nexus-backdrop-blur", type: "length", unit: "px", min: 0, max: 20, default: 6 }],
        }],
        settingsDestinations: [{
          id: "scenic-themes",
          label: { en: "Scenic themes", "zh-CN": "风景主题" },
          icon: "palette",
          entry: "settings/index.html",
        }],
      }),
    ).toBeUndefined();
    expect(
      validateContributions({
        themes: [{ id: "scenic", label: "Scenic", path: "themes/scenic.css", variables: [{ name: "--pi-bg", type: "color", default: "#000000" }] }],
      }),
    ).toMatch(/variable declaration/);
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

describe("contributed theme assets and window appearance", () => {
  it("accepts a whitelisted absolute asset list", () => {
    expect(
      validateContributions({
        themes: [
          {
            id: "midnight",
            label: "Midnight",
            path: "a.css",
            assets: ["C:/art/bg.png", "file:///C:/font/ui.woff2", "/art/sheen.svg"],
          },
        ],
      }),
    ).toBeUndefined();
  });

  it("rejects a relative path, an escape, an unknown scheme or a wrong extension", () => {
    for (const asset of [
      "art/bg.png",
      "./art/bg.png",
      "../bg.png",
      "art/../bg.png",
      "C:/art/../bg.png",
      "C:/art/bg.gif",
      "https://x/bg.png",
      "",
    ]) {
      expect(
        validateContributions({
          themes: [{ id: "midnight", label: "Midnight", path: "a.css", assets: [asset] }],
        }),
      ).toMatch(/asset/);
    }
  });

  it("rejects the same asset declared twice", () => {
    expect(
      validateContributions({
        themes: [
          {
            id: "m",
            label: "M",
            path: "a.css",
            assets: ["C:/art/bg.png", "file:///C:/art/bg.png"],
          },
        ],
      }),
    ).toMatch(/twice/);
  });

  it("accepts #rrggbb and #rrggbbaa window backgrounds", () => {
    expect(
      validateContributions({
        windowAppearance: { backgroundColor: { light: "#ffffff", dark: "#0d1424cc" } },
      }),
    ).toBeUndefined();
    expect(validateContributions({ windowAppearance: {} })).toBeUndefined();
  });

  it("rejects a window background that is not #rrggbb or #rrggbbaa", () => {
    for (const color of ["#fff", "0d1424", "#0d1424z", "#0d1424ccc"]) {
      expect(
        validateContributions({ windowAppearance: { backgroundColor: { dark: color } } }),
      ).toMatch(/backgroundColor/);
    }
    expect(
      validateContributions({ windowAppearance: { backgroundColor: "dark" } } as never),
    ).toMatch(/backgroundColor/);
    expect(validateContributions({ windowAppearance: [] } as never)).toMatch(/windowAppearance/);
  });

  it("requires ui.window.appearance for a declared window background", () => {
    const contributes = { windowAppearance: { backgroundColor: { dark: "#0d1424" } } };
    expect(validateManifest({ ...base, contributes }).error).toMatch(
      /ui\.window\.appearance permission/,
    );
    expect(
      validateManifest({ ...base, permissions: ["ui.window.appearance"], contributes }).ok,
    ).toBe(true);
  });

  it("accepts empty and well-formed permissionDeny lists", () => {
    expect(validateContributions({ permissionDeny: {} })).toBeUndefined();
    expect(
      validateContributions({
        permissionDeny: {
          tools: ["Bash"],
          paths: ["**/.env"],
          commands: ["rm -rf *"],
        },
      }),
    ).toBeUndefined();
  });

  it("rejects malformed permissionDeny contributions", () => {
    expect(validateContributions({ permissionDeny: { allow: ["Bash"] } } as never)).toMatch(
      /permissionDeny\.allow is not supported/,
    );
    expect(validateContributions({ permissionDeny: { tools: "Bash" } } as never)).toMatch(
      /permissionDeny\.tools must be an array/,
    );
    expect(validateContributions({ permissionDeny: { tools: [""] } })).toMatch(
      /non-empty strings/,
    );
    expect(validateContributions({ permissionDeny: { tools: [1] } } as never)).toMatch(
      /entries must be strings/,
    );
    expect(validateContributions({ permissionDeny: { tools: ["a".repeat(513)] } })).toMatch(
      /at most 512 characters/,
    );
    expect(
      validateContributions({ permissionDeny: { tools: Array(257).fill("Bash") } }),
    ).toMatch(/at most 256 entries/);
  });

  it("requires agent.permission.deny even for an empty permissionDeny object", () => {
    const contributes = { permissionDeny: {} };
    expect(validateManifest({ ...base, contributes }).error).toMatch(
      /agent\.permission\.deny permission/,
    );
    expect(
      validateManifest({ ...base, permissions: ["agent.permission.deny"], contributes }).ok,
    ).toBe(true);
  });
});

describe("contributes.globalShortcuts", () => {
  const command = { id: "voice.pushToTalk", title: "Push to talk" };
  const withShortcuts = (globalShortcuts: unknown) =>
    ({ commands: [command], globalShortcuts }) as never;

  it("accepts a declared shortcut with a dotted id and a default", () => {
    const result = validateManifest({
      ...base,
      permissions: ["keyboard.globalShortcut"],
      contributes: withShortcuts([
        { id: "voice.pushToTalk", command: "voice.pushToTalk", default: "Alt+Space" },
      ]),
    });
    expect(result.ok).toBe(true);
    expect(result.manifest?.contributes?.globalShortcuts).toEqual([
      { id: "voice.pushToTalk", command: "voice.pushToTalk", default: "Alt+Space" },
    ]);
  });

  it("requires the keyboard.globalShortcut permission", () => {
    expect(
      validateManifest({
        ...base,
        contributes: withShortcuts([{ id: "voice.pushToTalk", command: "voice.pushToTalk" }]),
      }).error,
    ).toMatch(/globalShortcuts requires the keyboard\.globalShortcut permission/);
  });

  it("accepts an empty list without the permission, because nothing is registered", () => {
    expect(validateManifest({ ...base, contributes: withShortcuts([]) }).ok).toBe(true);
  });

  it("rejects a command that contributes.commands never declares", () => {
    expect(
      validateContributions(withShortcuts([{ id: "voice.pushToTalk", command: "voice.other" }])),
    ).toMatch(/undeclared command/);
  });

  it("rejects a duplicate id", () => {
    expect(
      validateContributions(
        withShortcuts([
          { id: "voice.pushToTalk", command: "voice.pushToTalk" },
          { id: "voice.pushToTalk", command: "voice.pushToTalk", default: "F2" },
        ]),
      ),
    ).toMatch(/duplicate global shortcut id/);
  });

  it("rejects ids outside the dotted id grammar", () => {
    for (const id of ["1voice", "voice push"]) {
      expect(validateContributions(withShortcuts([{ id, command: "voice.pushToTalk" }]))).toMatch(
        /globalShortcuts entries need an id/,
      );
    }
  });

  it("rejects a default the shortcut grammar cannot parse", () => {
    for (const value of ["Ctrl+", "Alt+Ctrl", "NopeBig", 42]) {
      expect(
        validateContributions(
          withShortcuts([{ id: "voice.pushToTalk", command: "voice.pushToTalk", default: value }]),
        ),
      ).toMatch(/invalid default/);
    }
  });

  it("caps the list at MAX_GLOBAL_SHORTCUTS_PER_PLUGIN entries", () => {
    const shortcuts = Array.from({ length: MAX_GLOBAL_SHORTCUTS_PER_PLUGIN + 1 }, (_, index) => ({
      id: `voice.slot${index}`,
      command: "voice.pushToTalk",
    }));
    expect(validateContributions(withShortcuts(shortcuts))).toMatch(
      new RegExp(`globalShortcuts is limited to ${MAX_GLOBAL_SHORTCUTS_PER_PLUGIN} entries`),
    );
    expect(
      validateContributions(withShortcuts(shortcuts.slice(0, MAX_GLOBAL_SHORTCUTS_PER_PLUGIN))),
    ).toBeUndefined();
  });
});

describe("PLUGIN_PERMISSIONS", () => {
  it("declares the capability permissions and stays unique", () => {
    for (const permission of [
      "ui.theme",
      "ui.window.appearance",
      "ui.view",
      "mcp.server.local",
      "mcp.server.remote",
      "background.service",
      "bus.publish",
      "bus.subscribe",
      "agent.prompt.inject",
      "agent.complete",
      "agent.permission.deny",
      "models.list",
      "project.create",
      "session.read",
      "fs.read",
      "fs.write",
      "fs.delete",
      "browser.cdp",
      "audio.capture.background",
      "audio.playback.background",
      "keyboard.globalShortcut",
      "net.websocket",
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

describe("contributes.providers", () => {
  const base = { schemaVersion: 1, id: "demo.providers", name: "P", version: "0.1.0", main: "main.js" };
  // Annotated so a deliberate bad value in one test does not widen the literal
  // type for every other call.
  const provider: PluginProviderContrib = {
    id: "demo",
    name: "Demo",
    baseUrl: "https://api.example.com/v1",
    apiStyle: "chat_completions",
    authKind: "api_key",
    models: [
      { id: "demo-large", name: "Demo Large", contextWindow: 200000, maxTokens: 8192 },
      { id: "demo-small" },
    ],
  };

  it("accepts a declaration when provider.register is declared", () => {
    const result = validateManifest({
      ...base,
      permissions: ["provider.register"],
      contributes: { providers: [provider] },
    });
    expect(result.ok).toBe(true);
    expect(result.manifest?.contributes?.providers?.[0]?.id).toBe("demo");
    expect(result.manifest?.contributes?.providers?.[0]?.models).toHaveLength(2);
  });

  it("rejects a declaration without the provider.register permission", () => {
    expect(validateManifest({ ...base, contributes: { providers: [provider] } }).error).toMatch(
      /provider\.register permission/,
    );
    expect(PLUGIN_PERMISSIONS).toContain("provider.register");
  });

  it("rejects an unsupported apiStyle or authKind", () => {
    const perm = { ...base, permissions: ["provider.register"] };
    expect(
      validateManifest({
        ...perm,
        contributes: { providers: [{ ...provider, apiStyle: "grpc" as never }] },
      }).error,
    ).toMatch(/unsupported apiStyle/);
    expect(
      validateManifest({
        ...perm,
        contributes: { providers: [{ ...provider, authKind: "basic" as never }] },
      }).error,
    ).toMatch(/unsupported authKind/);
  });

  it("rejects a non-http baseUrl, an unbound model list, duplicate ids, and too many entries", () => {
    expect(
      validateContributions({
        providers: [{ ...provider, baseUrl: "file:///etc/passwd" }],
      }),
    ).toMatch(/http\(s\) URL/);
    expect(validateContributions({ providers: [{ ...provider, models: [] }] })).toMatch(
      /1 to 64 models/,
    );
    expect(
      validateContributions({
        providers: [{ ...provider, models: [{ id: "m" }, { id: "m" }] }],
      }),
    ).toMatch(/declares model m twice/);
    expect(validateContributions({ providers: [{ ...provider, id: "1bad" }] })).toMatch(
      /id is missing or invalid/,
    );
    expect(validateContributions({ providers: [provider, provider] })).toMatch(
      /duplicate provider declaration id/,
    );
    expect(
      validateContributions({
        providers: Array.from({ length: 9 }, (_, index) => ({ ...provider, id: `p${index}` })),
      }),
    ).toMatch(/at most 8 entries/);
    expect(
      validateContributions({
        providers: [{ ...provider, models: [{ id: "" }] }],
      }),
    ).toMatch(/without a valid id/);
  });

  it("rejects oauth, which needs a Host-owned login flow", () => {
    expect(
      validateContributions({ providers: [{ ...provider, authKind: "oauth" as never }] }),
    ).toMatch(/unsupported authKind oauth/);
    expect(
      validateContributions({
        providers: [{ ...provider, oauth: { label: "Demo" } } as never],
      }),
    ).toMatch(/not supported in this release/);
  });

  it("requires a name", () => {
    expect(validateContributions({ providers: [{ ...provider, name: "  " }] })).toMatch(
      /requires a name/,
    );
  });
});
