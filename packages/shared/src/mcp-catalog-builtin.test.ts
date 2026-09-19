import { describe, expect, it } from "vitest";
import { BUILTIN_MCP_CATALOG } from "./mcp-catalog-builtin.js";
import { resolveCatalogEntry, validateMcpCatalogFile } from "./mcp-catalog.js";

describe("BUILTIN_MCP_CATALOG", () => {
  it("is valid with zero warnings and unique ids", () => {
    const { catalog, warnings } = validateMcpCatalogFile(BUILTIN_MCP_CATALOG);
    expect(warnings).toEqual([]);
    expect(catalog.servers).toHaveLength(16);
    expect(new Set(catalog.servers.map((entry) => entry.id)).size).toBe(16);
  });

  it("keeps the offline-first promise: at least five zero-config entries", () => {
    const zeroConfig = BUILTIN_MCP_CATALOG.servers.filter(
      (entry) => !(entry.requiredEnv?.length ?? 0),
    );
    expect(zeroConfig.length).toBeGreaterThanOrEqual(5);
  });

  it("uses a cwd-relative filesystem root instead of a shell-only tilde", () => {
    const filesystem = BUILTIN_MCP_CATALOG.servers.find((entry) => entry.id === "filesystem");
    expect(filesystem?.requiredEnv?.find((item) => item.name === "MCP_FS_ROOT")?.defaultValue).toBe(".");
  });

  it("resolves the Firecrawl key into the launcher environment, never the argv", () => {
    const firecrawl = BUILTIN_MCP_CATALOG.servers.find((entry) => entry.id === "firecrawl");
    const resolved = resolveCatalogEntry(firecrawl!, { FIRECRAWL_API_KEY: "fc-test-key" });
    expect(resolved).toMatchObject({
      transport: "stdio",
      command: "npx",
      args: ["-y", "firecrawl-mcp"],
      env: { FIRECRAWL_API_KEY: "fc-test-key" },
    });
    expect(resolved.args).not.toContain("fc-test-key");
    expect(() => resolveCatalogEntry(firecrawl!)).toThrow(/FIRECRAWL_API_KEY/);
  });
});
