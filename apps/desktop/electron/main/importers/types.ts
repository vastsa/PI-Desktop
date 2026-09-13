export type ExternalSource = "claude-code" | "opencode" | "codex" | "pi";

export interface ExternalSessionSummary {
  source: ExternalSource;
  externalId: string;
  title: string;
  projectPath: string | null;
  model: string | null;
  createdAt: string;
  updatedAt: string;
  /**
   * Exact item count for fully scanned files; null when the file was too
   * large to scan without sampling (the UI renders an em dash). Transient
   * scan metadata only — imported sessions always know their real count.
   */
  messageCount: number | null;
  filePath: string;
}

export interface ImportedUiMessage {
  id: string;
  role: string;
  content: string;
  createdAt: string;
  status?: string;
  toolName?: string;
  toolCallId?: string;
  toolStatus?: string;
  toolArgs?: unknown;
  toolResult?: unknown;
  isError?: boolean;
}

export interface ImportedSession {
  session: {
    id: string;
    title: string;
    projectPath: string | null;
    modelId: string | null;
    providerId: string | null;
    mode: string;
    createdAt: string;
    updatedAt: string;
  };
  messages: ImportedUiMessage[];
}

export interface SessionImporter {
  source: ExternalSource;
  scan(): Promise<ExternalSessionSummary[]>;
  convert(summary: ExternalSessionSummary): Promise<ImportedSession>;
}

/** Deterministic session id so re-importing the same source session is a no-op. */
export function importedSessionId(source: ExternalSource, externalId: string): string {
  return `import-${source}-${externalId}`;
}

export function toIso(value: string | number | undefined | null, fallback?: string): string {
  if (value !== undefined && value !== null) {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
    // A provided-but-invalid timestamp is data corruption (truncated jsonl,
    // out-of-range numbers): surface it instead of silently rewriting the
    // session's history to the import moment (#265). Absent values stay
    // silent — those are normal in optional fields.
    console.warn(
      `[importers] unparsable timestamp ${JSON.stringify(value)}; using ${
        fallback ? "the provided fallback" : "the import time"
      }`,
    );
  }
  return fallback ?? new Date().toISOString();
}

export function truncateTitle(text: string, max = 48): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return "";
  return t.length > max ? `${t.slice(0, max)}…` : t;
}
