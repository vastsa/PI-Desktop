/** Project selections narrow the existing enabled/scoped capability catalog. */
export type ProjectCapabilities = {
  /** Omitted inherits the catalog; an empty array explicitly selects none. */
  skillIds?: string[];
  mcpServerIds?: string[];
};

export type ProjectAgentSettings = {
  capabilities?: ProjectCapabilities;
  /** App-owned Markdown, stored by the host separately from repository files. */
  instructions?: string;
};

export type ProjectCapabilityOption = { id: string; name: string; description?: string };
export type ProjectCapabilityCatalog = {
  skills: ProjectCapabilityOption[];
  mcpServers: ProjectCapabilityOption[];
};

export const MAX_PROJECT_INSTRUCTIONS_BYTES = 32 * 1024;
export const MAX_PROJECT_CAPABILITY_IDS = 512;
const encoder = new TextEncoder();

export function projectCapabilityAllowed(ids: readonly string[] | undefined, id: string): boolean {
  return ids === undefined || ids.includes(id);
}

/** Invalid persisted selections must never silently expand into an unrestricted catalog. */
export function parseProjectCapabilities(value: unknown): ProjectCapabilities | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid project capabilities");
  }
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== "skillIds" && key !== "mcpServerIds")) {
    throw new Error("Unknown project capability field");
  }
  const result: ProjectCapabilities = {};
  for (const key of ["skillIds", "mcpServerIds"] as const) {
    const ids = input[key];
    if (ids === undefined) continue;
    if (!Array.isArray(ids) || ids.length > MAX_PROJECT_CAPABILITY_IDS ||
      ids.some((id) => typeof id !== "string" || !id.trim() ||
        encoder.encode(id).length > 512 || /[\u0000-\u001f\u007f-\u009f]/u.test(id))) {
      throw new Error(`Invalid project ${key}`);
    }
    result[key] = [...new Set(ids as string[])];
  }
  return result;
}

export function parseProjectAgentSettings(input: {
  capabilities?: unknown;
  instructions?: unknown;
}): ProjectAgentSettings {
  const capabilities = parseProjectCapabilities(input.capabilities);
  if (input.instructions !== undefined && (typeof input.instructions !== "string" ||
    encoder.encode(input.instructions).length > MAX_PROJECT_INSTRUCTIONS_BYTES)) {
    throw new Error("Project instructions must be Markdown of at most 32768 UTF-8 bytes");
  }
  return {
    ...(capabilities !== undefined ? { capabilities } : {}),
    ...(typeof input.instructions === "string" ? { instructions: input.instructions } : {}),
  };
}
