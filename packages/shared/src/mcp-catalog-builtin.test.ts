import { describe, expect, it } from "vitest";
import { BUILTIN_MCP_CATALOG } from "./mcp-catalog-builtin.js";
import { validateMcpCatalogFile } from "./mcp-catalog.js";

describe("BUILTIN_MCP_CATALOG", () => {
  it("is valid with zero warnings and unique ids", () => {
    const { catalog, warnings } = validateMcpCatalogFile(BUILTIN_MCP_CATALOG);
    expect(warnings).toEqual([]);
    expect(catalog.servers).toHaveLength(15);
    expect(new Set(catalog.servers.map((entry) => entry.id)).size).toBe(15);
  });

  it("keeps the offline-first promise: at least five zero-config entries", () => {
    const zeroConfig = BUILTIN_MCP_CATALOG.servers.filter(
      (entry) => !(entry.requiredEnv?.length ?? 0),
    );
    expect(zeroConfig.length).toBeGreaterThanOrEqual(5);
  });
});
