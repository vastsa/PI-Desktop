import { claudeImporter } from "./claude";
import { CODEX_SCAN_MAX_FILES, codexImporter, scanCodexSessionsResult } from "./codex";
import { opencodeImporter } from "./opencode";
import { piImporter } from "./pi";
import type {
  ExternalSessionSummary,
  ExternalSource,
  ImportedSession,
  SessionImporter,
} from "./types";

export type { ExternalSessionSummary, ExternalSource, ImportedSession } from "./types";
export { scanModelConfigs } from "./model-config";

const importers: SessionImporter[] = [
  claudeImporter,
  opencodeImporter,
  codexImporter,
  piImporter,
];

export async function scanAllSources(): Promise<{
  sessions: ExternalSessionSummary[];
  truncated: Partial<Record<ExternalSource, number>>;
}> {
  const truncated: Partial<Record<ExternalSource, number>> = {};
  const results = await Promise.all(
    importers.map(async (imp) => {
      try {
        if (imp.source === "codex") {
          const result = await scanCodexSessionsResult();
          if (result.truncated) truncated.codex = CODEX_SCAN_MAX_FILES;
          return result.sessions;
        }
        return await imp.scan();
      } catch {
        return [];
      }
    }),
  );
  return {
    sessions: results.flat().sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)),
    truncated,
  };
}

export async function convertSession(
  summary: ExternalSessionSummary,
): Promise<ImportedSession> {
  const importer = importers.find((imp) => imp.source === summary.source);
  if (!importer) throw new Error(`unknown import source: ${summary.source}`);
  return importer.convert(summary);
}

