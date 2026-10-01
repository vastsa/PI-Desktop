import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";

it("the retained coding-agent compatibility patch supports offline manual compaction", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-compact-patch-"));
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: true, reserveTokens: 512, keepRecentTokens: 512 } });
    const resourceLoader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [pi => { pi.on("session_before_compact", async event => ({ compaction: {
        summary: "offline extension summary", firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
      } })); }],
    });
    await resourceLoader.reload();
    const modelRuntime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false,
      credentials: { read: async () => undefined, list: async () => [], modify: async (_id, fn) => fn(undefined), delete: async () => undefined } });
    const model = getBuiltinModel("openai", "gpt-6.1-sol");
    const manager = SessionManager.inMemory(dir);
    for (let i = 0; i < 6; i++) manager.appendMessage({ role: "user", content: `message-${i} ${"fixture ".repeat(1500)}`, timestamp: i + 1 });
    ({ session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime, model, settingsManager,
      resourceLoader, sessionManager: manager, noTools: "all" }));
    await session.bindExtensions({});
    const compacted = await session.compact();
    expect(compacted.summary).toBe("offline extension summary");
    expect(compacted.estimatedTokensAfter).toBeGreaterThan(0);
    expect(manager.getBranch().some(entry => entry.type === "compaction")).toBe(true);
  } finally { session?.dispose(); await rm(dir, { recursive: true, force: true }); }
});
