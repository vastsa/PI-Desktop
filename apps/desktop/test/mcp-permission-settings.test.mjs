import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Children, createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { catalogs } from "@pi-desktop/i18n";
import { createServer } from "vite";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { createSessionLaunchRuntime } = await import("../electron/main/runtime/session-launch.ts");
const { UserMcpRuntime } = await import("../electron/main/user-mcp.ts");

test("Plan and Goal launch admit user MCP only by the switch or existing named list", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "pi-mcp-permission-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const tools = [{ name: "lookup" }, { name: "ping" }];
  let connected = false;
  const userMcp = new UserMcpRuntime({ createClient: () => ({
    connect: async () => { connected = true; return tools; },
    isConnected: () => connected, getTools: () => tools,
    close: () => { connected = false; },
  }) });
  t.after(() => userMcp.disposeAll());
  const provider = { id: "fixture", name: "Fixture", vendorKey: "custom", enabled: true,
    authKind: "none", apiStyle: "chat_completions", models: [{ id: "parent" }] };
  const record = { id: "ctx", label: "Context", transport: "stdio", command: "node",
    args: [], enabled: true, scope: { mode: "global", projects: [] }, planSafeTools: ["lookup"] };
  const shell = { id: "windows-powershell", label: "PowerShell", dialect: "powershell", available: true, isDefault: true };
  const runtime = createSessionLaunchRuntime({
    runtimeState: { host: { isAvailable: () => true, call: async (method) => {
      if (method === "commandShells.list") return { configuredId: shell.id, effective: shell, fallback: false, choices: [shell] };
      if (method === "providers.list") return { providers: [provider] };
      if (method === "mcp.active") return { servers: [record] };
      if (method === "agents.active") return { subagents: [] };
      if (method === "skills.active") return { skills: [] };
      if (method === "providers.getSecret" || method === "project.memory.get") return {};
      throw new Error("Unexpected host call " + method);
    } } },
    logger: { app() {} }, userMcp,
    plugins: { listLoaded: () => [], getSkills: () => [], getAgentExtensions: () => [],
      getTools: () => [{ fullName: "plugin_unsafe", pluginId: "fixture", description: "Plugin", schema: {} }] },
    sessionProjects: new Map(), dataDir: workspace, vendorOAuth: {},
    modelsDevCatalog: { configureAccount() {}, ensureLoaded: async () => {}, findModel: () => undefined },
    getWorkspacePath: () => workspace, pluginActiveInProject: () => true,
    bindingForModel: (row, id) => row.models.find((model) => model.id === id),
    effectiveSubagentModelConfig: () => ({}), normalizeThinkingLevel: () => "off",
  });
  for (const mode of ["plan", "goal"]) {
    for (const settings of [{}, { allowMcpInPlanGoal: true }, { allowMcpInPlanGoal: false }]) {
      const launch = await runtime.resolveAgentRuntimeLaunch("session", {
        providerId: provider.id, modelId: "parent", projectPath: workspace, mode,
      }, settings);
      assert.equal(launch.sidecarParams.mode, mode);
      const byName = Object.fromEntries(launch.sidecarParams.pluginTools.map((tool) => [tool.name, tool]));
      assert.deepEqual(byName.mcp_ctx_lookup.planSafeActions, ["mcp_ctx_lookup"]);
      assert.deepEqual(byName.mcp_ctx_lookup.mcpTool, { serverId: "ctx", toolName: "lookup" });
      assert.deepEqual(byName.mcp_ctx_ping.mcpTool, { serverId: "ctx", toolName: "ping" });
      assert.deepEqual(byName.mcp_ctx_ping.planSafeActions,
        settings.allowMcpInPlanGoal ? ["mcp_ctx_ping"] : undefined);
      assert.equal(byName.mcp_ctx_ping.risk, undefined, "MCP risk is never downgraded");
      assert.equal(byName.plugin_unsafe.planSafeActions, undefined, "the switch never grants plugin actions");
    }
  }
});

test("the MCP permission row toggles and saves the same shared Plan/Goal setting", async (t) => {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)), configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false }, esbuild: { jsx: "automatic" },
    appType: "custom", optimizeDeps: { noDiscovery: true, include: [] },
  });
  t.after(() => server.close());
  const { PlanGoalMcpRow } = await server.ssrLoadModule("/src/components/settings/PlanGoalMcpRow.tsx");
  const { searchSettings } = await server.ssrLoadModule("/src/lib/settings-search.ts");
  const { SettingsToggle } = await server.ssrLoadModule("/src/components/ui.tsx");
  const i18n = createInstance();
  await i18n.init({ lng: "en", resources: { en: { translation: catalogs.en } } });
  let settings = { defaultMode: "agent", theme: "light" };
  let tree;
  function Harness() {
    tree = PlanGoalMcpRow({ settings, saveSettings: async (patch) => { settings = { ...settings, ...patch }; } });
    return tree;
  }
  function* elements(node) {
    if (!isValidElement(node)) return;
    yield node;
    for (const child of Children.toArray(node.props.children)) yield* elements(child);
  }
  for (const checked of [false, true, false]) {
    const html = renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(Harness)));
    const toggle = [...elements(tree)].find((node) => node.type === SettingsToggle);
    assert.ok(toggle);
    assert.equal(toggle.props.checked, checked);
    assert.ok(html.includes('role="switch"'));
    assert.ok(html.includes('aria-checked="' + checked + '"'));
    assert.equal(toggle.props.label, i18n.t("settings.allowMcpInPlanGoal"));
    assert.ok(html.includes(i18n.t("settings.allowMcpInPlanGoalDesc")));
    const hit = searchSettings("change data", (key) => i18n.t(key)).find((row) => row.tab === "ai");
    assert.equal(hit?.rowKey, "settings.allowMcpInPlanGoal", "description search must target the row title");
    assert.equal(i18n.t(hit.rowKey), tree.props.title);
    toggle.props.onChange();
    assert.equal(settings.allowMcpInPlanGoal, !checked);
  }
});
