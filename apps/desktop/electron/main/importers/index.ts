import { claudeImporter } from "./claude";
import { codexImporter } from "./codex";
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

export async function scanAllSources(): Promise<ExternalSessionSummary[]> {
  const results = await Promise.all(
    importers.map(async (imp) => {
      try {
        return await imp.scan();
      } catch {
        return [];
      }
    }),
  );
  return results
    .flat()
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export async function convertSession(
  summary: ExternalSessionSummary,
): Promise<ImportedSession> {
  const importer = importers.find((imp) => imp.source === summary.source);
  if (!importer) throw new Error(`unknown import source: ${summary.source}`);
  return importer.convert(summary);
}
