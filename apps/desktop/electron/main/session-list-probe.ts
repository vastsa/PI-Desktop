/** Isolated session-list responsiveness coverage for the existing boot probe. */
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname } from "node:path";
import { performance } from "node:perf_hooks";
import type { BrowserWindow } from "electron";
import type { HostProcess } from "./host-process";
import type { ModelsDevCatalog } from "./models-dev-catalog";

const SESSION_COUNT = 800;
const REFRESH_COUNT = 8;

type FixtureSession = { id: string; modelId: string };

type RendererMeasurements = {
  refreshCount: number;
  returnedCount: number;
  complete: boolean;
  capabilitiesConsistent: boolean;
  listDurationsMs: number[];
  heartbeatDurationsMs: number[];
};

export async function runSessionListProbe({
  dataDir,
  host,
  window,
  catalog,
}: {
  dataDir: string;
  host: HostProcess;
  window: BrowserWindow;
  catalog: ModelsDevCatalog;
}) {
  const profile = await realpath(dataDir);
  if (
    !basename(profile).startsWith("pi-desktop-boot-") ||
    dirname(profile) !== await realpath(tmpdir())
  ) {
    throw new Error("session-list probe requires its own temporary boot profile");
  }
  const existing = await host.call<{ providers: unknown[] }>("providers.list");
  if (existing.providers.length > 0) {
    throw new Error("session-list probe refuses a profile with configured providers");
  }
  await catalog.ensureLoaded();
  const models = catalog.modelsForProvider({
    vendorKey: "openai",
    providerId: "session-list-probe",
  }).slice(0, 13);
  const modelIds = models.map((model) => model.modelId);
  if (modelIds.length < 2) throw new Error("bundled catalog lacks probe model fixtures");
  const { provider } = await host.call<{ provider: { id: string } }>("providers.create", {
    name: "Session list responsiveness fixture",
    vendorKey: "openai",
    type: "openai_compatible",
    protocol: "openai_compatible",
    authKind: "none",
    baseUrl: "http://127.0.0.1:9/session-list-probe",
    defaultModelId: modelIds[0],
    models: models.map((model) => ({
      id: model.modelId,
      contextWindow: model.contextWindow ?? 128_000,
      maxTokens: model.maxTokens ?? 8_192,
      thinkingLevels: model.supportedThinkingLevels ?? [],
    })),
  });
  const fixtures: FixtureSession[] = [];
  // Seed through the authoritative Host API without warming Main's lookup cache.
  for (let offset = 0; offset < SESSION_COUNT; offset += 20) {
    const batch = await Promise.all(Array.from({ length: 20 }, async (_, index) => {
      const modelId = modelIds[(offset + index) % modelIds.length];
      const { session } = await host.call<{ session: FixtureSession }>("session.create", {
        title: `Session list fixture ${offset + index + 1}`,
        mode: "agent",
        providerId: provider.id,
        modelId,
      });
      if (!session?.id) throw new Error("session-list fixture creation failed");
      return { id: session.id, modelId };
    }));
    fixtures.push(...batch);
  }

  let lastTick = performance.now();
  let maxMainGapMs = 0;
  let mainTicks = 0;
  const heartbeat = setInterval(() => {
    const now = performance.now();
    maxMainGapMs = Math.max(maxMainGapMs, now - lastTick);
    lastTick = now;
    mainTicks += 1;
  }, 10);
  try {
    const measurements: RendererMeasurements = await window.webContents.executeJavaScript(`
      (async () => {
        const api = window.piDesktop;
        const fixtures = ${JSON.stringify(fixtures)};
        const listDurationsMs = [];
        const heartbeatDurationsMs = [];
        let measuring = true;
        const heartbeats = (async () => {
          do {
            const started = performance.now();
            const result = await api.invoke(api.channels.invoke.appGetVersion);
            if (!result?.ok) throw new Error("session-list heartbeat IPC failed");
            heartbeatDurationsMs.push(performance.now() - started);
            if (measuring) await new Promise((resolve) => setTimeout(resolve, 20));
          } while (measuring);
        })();
        let snapshots;
        try {
          snapshots = await Promise.all(Array.from({ length: ${REFRESH_COUNT} }, async () => {
            const started = performance.now();
            const result = await api.invoke(api.channels.invoke.sessionList);
            if (!result?.ok) throw new Error("session-list IPC failed");
            listDurationsMs.push(performance.now() - started);
            return result.data.sessions;
          }));
        } finally {
          measuring = false;
          await heartbeats;
        }
        const views = snapshots.map((sessions) => {
          const byId = new Map(sessions.map((session) => [session.id, session]));
          return fixtures.map(({ id, modelId }) => {
            const row = byId.get(id);
            if (!row || row.modelId !== modelId ||
                typeof row.supportsReasoning !== "boolean" ||
                typeof row.supportsVision !== "boolean" ||
                !Array.isArray(row.supportedThinkingLevels)) return null;
            return [id, modelId, row.supportsReasoning, row.supportsVision, row.supportedThinkingLevels];
          });
        });
        const baseline = JSON.stringify(views[0]);
        return {
          refreshCount: snapshots.length,
          returnedCount: snapshots[0].length,
          complete: views.every((rows) => rows.every(Boolean)),
          capabilitiesConsistent: views.every((rows) => JSON.stringify(rows) === baseline),
          listDurationsMs,
          heartbeatDurationsMs,
        };
      })()
    `);
    // Let a timer delayed by the final synchronous IPC handler record its gap.
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    return {
      ...measurements,
      seededCount: fixtures.length,
      distinctModels: modelIds.length,
      mainTicks,
      maxMainGapMs,
    };
  } finally {
    clearInterval(heartbeat);
  }
}
