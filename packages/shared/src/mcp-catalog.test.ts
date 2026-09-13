import { describe, expect, it } from "vitest";
import {
  catalogEntryError,
  collectCatalogPlaceholders,
  resolveCatalogEntry,
  validateMcpCatalogFile,
  type McpCatalogEntry,
} from "./mcp-catalog.js";

const stdioTemplate: McpCatalogEntry = {
  id: "github-tools",
  name: "GitHub Tools",
  description: "仓库操作",
  transport: "stdio",
  command: "npx",
  args: ["-y", "@example/server-${GITHUB_PAT}"],
  env: { GITHUB_TOKEN: "${GITHUB_TOKEN}" },
  requiredEnv: [
    { name: "GITHUB_PAT", description: "token" },
    { name: "GITHUB_TOKEN", description: "token" },
  ],
};

const httpTemplate: McpCatalogEntry = {
  id: "github-remote",
  name: "GitHub Remote",
  transport: "http",
  url: "https://api.example.com/mcp/",
  headers: { Authorization: "Bearer ${GITHUB_PAT}" },
  requiredEnv: [{ name: "GITHUB_PAT", description: "pat" }],
};

describe("collectCatalogPlaceholders", () => {
  it("collects from stdio args and env, deduped and sorted", () => {
    expect(collectCatalogPlaceholders(stdioTemplate)).toEqual(["GITHUB_PAT", "GITHUB_TOKEN"]);
  });

  it("collects from http headers", () => {
    expect(collectCatalogPlaceholders(httpTemplate)).toEqual(["GITHUB_PAT"]);
  });

  it("handles adjacent placeholders", () => {
    const entry: McpCatalogEntry = {
      id: "adjacent",
      name: "Adjacent",
      transport: "stdio",
      command: "${A}${B}",
      requiredEnv: [
        { name: "A" },
        { name: "B" },
      ],
    };
    expect(collectCatalogPlaceholders(entry)).toEqual(["A", "B"]);
  });

  it("ignores non-placeholder dollar usage and lowercase names", () => {
    const entry: McpCatalogEntry = {
      id: "dollar",
      name: "Dollar",
      transport: "stdio",
      command: "cost $5 and ${lower} only",
      args: [],
    };
    expect(collectCatalogPlaceholders(entry)).toEqual([]);
  });
});

describe("catalogEntryError", () => {
  it("rejects ids that do not start with a letter", () => {
    expect(
      catalogEntryError({ ...stdioTemplate, id: "1bad" }),
    ).toContain("bad id");
    expect(
      catalogEntryError({ ...stdioTemplate, id: "has space" }),
    ).toContain("bad id");
  });

  it("requires command for stdio and forbids ..", () => {
    expect(
      catalogEntryError({ ...stdioTemplate, command: undefined }),
    ).toContain("requires command");
    expect(
      catalogEntryError({ ...stdioTemplate, command: "npx/../x" }),
    ).toContain("..");
  });

  it("requires https url for http entries", () => {
    expect(
      catalogEntryError({ ...httpTemplate, url: undefined }),
    ).toContain("requires url");
    expect(
      catalogEntryError({ ...httpTemplate, url: "http://api.example.com/mcp/" }),
    ).toContain("https");
    expect(
      catalogEntryError({ ...httpTemplate, url: "not a url" }),
    ).toContain("parse");
  });

  it("rejects placeholders that requiredEnv does not declare", () => {
    const entry: McpCatalogEntry = {
      id: "undeclared",
      name: "Undeclared",
      transport: "stdio",
      command: "npx",
      args: ["-y", "pkg-${UNDECLARED}"],
    };
    expect(catalogEntryError(entry)).toContain("UNDECLARED");
  });

  it("accepts a valid entry", () => {
    expect(catalogEntryError(stdioTemplate)).toBeNull();
    expect(catalogEntryError(httpTemplate)).toBeNull();
  });
});

describe("resolveCatalogEntry", () => {
  it("maps a zero-placeholder stdio entry to a server input", () => {
    const entry: McpCatalogEntry = {
      id: "memory",
      name: "Memory",
      description: "记忆",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-memory"],
    };
    expect(resolveCatalogEntry(entry)).toEqual({
      id: "memory",
      label: "Memory",
      description: "记忆",
      enabled: true,
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-memory"],
      env: {},
    });
  });

  it("maps an http entry with resolved headers", () => {
    const input = resolveCatalogEntry(httpTemplate, { GITHUB_PAT: "tok" });
    expect(input.transport).toBe("http");
    expect(input.url).toBe("https://api.example.com/mcp/");
    expect(input.headers).toEqual({ Authorization: "Bearer tok" });
  });

  it("substitutes values into stdio args and env", () => {
    const input = resolveCatalogEntry(stdioTemplate, {
      GITHUB_PAT: "pat-value",
      GITHUB_TOKEN: "tok-value",
    });
    expect(input.args).toEqual(["-y", "@example/server-pat-value"]);
    expect(input.env).toEqual({ GITHUB_TOKEN: "tok-value" });
  });

  it("throws when a required value is missing", () => {
    expect(() => resolveCatalogEntry(httpTemplate, {})).toThrow("GITHUB_PAT");
  });

  it("drops optional values that stay empty", () => {
    const entry: McpCatalogEntry = {
      id: "optional-env",
      name: "Optional Env",
      transport: "stdio",
      command: "npx",
      args: [],
      env: { EXTRA: "${EXTRA_KEY}" },
      requiredEnv: [{ name: "EXTRA_KEY", optional: true }],
    };
    const input = resolveCatalogEntry(entry, {});
    expect(input.env).toEqual({});
    const filled = resolveCatalogEntry(entry, { EXTRA_KEY: "x" });
    expect(filled.env).toEqual({ EXTRA: "x" });
  });

  it("prefers explicit values over defaultValue", () => {
    const entry: McpCatalogEntry = {
      id: "defaults",
      name: "Defaults",
      transport: "stdio",
      command: "serve",
      args: ["${ROOT}"],
      requiredEnv: [{ name: "ROOT", defaultValue: "~" }],
    };
    expect(resolveCatalogEntry(entry, {}).args).toEqual(["~"]);
    expect(resolveCatalogEntry(entry, { ROOT: "/tmp" }).args).toEqual(["/tmp"]);
  });
});

describe("validateMcpCatalogFile", () => {
  it("passes a valid file through unchanged", () => {
    const file = {
      schemaVersion: 1,
      updatedAt: "2026-09-12T00:00:00Z",
      servers: [stdioTemplate, httpTemplate],
    };
    const { catalog, warnings } = validateMcpCatalogFile(file);
    expect(warnings).toEqual([]);
    expect(catalog.servers).toHaveLength(2);
    expect(catalog.schemaVersion).toBe(1);
  });

  it("reports a missing servers array and keeps an empty catalog", () => {
    const { catalog, warnings } = validateMcpCatalogFile({ schemaVersion: 1 });
    expect(catalog.servers).toEqual([]);
    expect(warnings).toContain("catalog has no servers array");
  });

  it("skips invalid entries and duplicates as warnings", () => {
    const file = {
      schemaVersion: 1,
      updatedAt: "",
      servers: [
        stdioTemplate,
        { id: "broken", name: "Broken", transport: "stdio" },
        httpTemplate,
      ],
    };
    const { catalog, warnings } = validateMcpCatalogFile(file);
    expect(catalog.servers.map((entry) => entry.id)).toEqual(["github-tools", "github-remote"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("broken");
  });

  it("skips a duplicate id after the first occurrence", () => {
    const file = {
      schemaVersion: 1,
      updatedAt: "",
      servers: [httpTemplate, { ...httpTemplate, name: "Copy" }],
    };
    const { catalog, warnings } = validateMcpCatalogFile(file);
    expect(catalog.servers).toHaveLength(1);
    expect(warnings.join("\n")).toContain("duplicate id");
  });
});
