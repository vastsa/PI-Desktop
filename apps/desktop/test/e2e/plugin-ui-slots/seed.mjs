// Seeds the E2E data dir through host-core's own JSON-RPC (the MCP control
// plane blocks provider writes): a provider row pointing at the stub model
// and the UI Slots Lab as a development plugin, which a dev load enables with
// the permissions its manifest declares.
import { cpSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Host } from "../../../../../scripts/e2e/host.mjs";

export async function seed({ hostBin, dataDir, runRoot, labDir, stubPort }) {
  const project = join(runRoot, "project");
  const pluginDir = join(runRoot, "plugins", "ui-slots-lab");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "README.md"), "UI slots E2E project\n");
  // The dev plugin is watched from its directory: load a copy, not the repo.
  cpSync(labDir, pluginDir, { recursive: true });

  const host = new Host(hostBin, dataDir);
  await host.start();
  try {
    const created = await host.call("providers.create", {
      name: "E2E stub",
      type: "openai_compatible",
      baseUrl: `http://127.0.0.1:${stubPort}/v1`,
      apiStyle: "chat_completions",
      authKind: "api_key",
      secretValue: "sk-e2e",
      models: [{ id: "stub-1", contextWindow: 128000, maxTokens: 4096, thinkingLevels: ["off"] }],
      defaultModelId: "stub-1",
    });
    const providerId = created.provider?.id ?? created.id;
    await host.call("settings.set", { defaultProviderId: providerId, defaultModelId: "stub-1", defaultMode: "agent" });
    const loaded = await host.call("plugins.loadDev", { path: pluginDir });
    return { project: realpathSync(project), pluginId: loaded?.plugin?.id };
  } finally {
    await host.stop();
  }
}
