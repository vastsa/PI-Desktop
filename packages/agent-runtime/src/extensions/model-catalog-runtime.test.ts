import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { DesktopAgentRuntime } from "../runtime.js";

it("a loaded extension discovers other host models synchronously without changing its session", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-model-catalog-"));
  const entry = join(root, "extension.ts");
  writeFileSync(entry, `export default function (pi) {
    pi.registerCommand("catalog", { async handler(_, ctx) {
      const registry = ctx.modelRegistry;
      const available = registry.getAvailable();
      const found = registry.find("other", "shared");
      await ctx.ui.notify(JSON.stringify({ available, found, current: ctx.model.id,
        auth: registry.getProviderAuthStatus("other"),
        missing: registry.find("missing", "shared") ?? null }));
    } });
  }`);
  const messages: string[] = [];
  const runtime = new DesktopAgentRuntime({
    sessionId: "catalog", mode: "agent", thinkingLevel: "off",
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    provider: { id: "current", name: "Current", modelId: "shared", apiKey: "fixture-secret",
      baseUrl: "https://unused.invalid/?key=fixture-secret", authKind: "api_key",
      supportsReasoning: false, supportedThinkingLevels: ["off"] },
    ...{ extensionModels: [{ providerId: "other", providerName: "Other", available: true,
      model: { id: "shared", name: "Other model", provider: "other", api: "openai-completions",
        baseUrl: "", reasoning: false, input: ["text"], contextWindow: 32000, maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } }] },
    trustedExtensions: [{ id: entry, entry, root, label: "Catalog", source: "plugin" }],
    host: { async call<T>(method: string, params?: unknown): Promise<T> {
      if (method === "extensions.ui.request") messages.push((params as { request: { message: string } }).request.message);
      return {} as T;
    } }, onEvent() {},
  });
  try {
    await runtime.loadTrustedExtensions();
    expect(await runtime.runTrustedExtensionCommand("catalog", "")).toEqual({ handled: true });
    const result = JSON.parse(messages.at(-1)!);
    expect(result.available.map((model: { provider: string }) => model.provider)).toContain("other");
    expect(result.found).toMatchObject({ provider: "other", id: "shared" });
    expect(result.auth.configured).toBe(true);
    expect(result.current).toBe("shared");
    expect(result.missing).toBeNull();
    expect(messages.join("\n")).not.toContain("fixture-secret");
  } finally {
    await runtime.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
