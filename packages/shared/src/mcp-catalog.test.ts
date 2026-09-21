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

  it("resolves only legacy URL tokens alongside header-local variables", () => {
    const entry: McpCatalogEntry = {
      ...httpTemplate,
      url: "https://api.example.com/${REGION}/{token}?literal=${token}",
      headers: { Authorization: "Bearer {token}" },
      headerBindings: { Authorization: { "{token}": { input: "token" } } },
      requiredEnv: [{ name: "REGION" }, { name: "token" }],
    };
    expect(collectCatalogPlaceholders({ ...entry, headers: {}, headerBindings: undefined })).toEqual(["REGION"]);
    const input = resolveCatalogEntry(entry, { REGION: "eu", token: "synthetic-secret" });
    expect(input.url).toBe("https://api.example.com/eu/{token}?literal=${token}");
    expect(input.headers).toEqual({ Authorization: "Bearer synthetic-secret" });
    expect(() => resolveCatalogEntry(entry, { token: "synthetic-secret" })).toThrow("missing value for REGION");
  });

  it.each(["{token}", "${token}"])("keeps unbound %s literal in a partial header binding map", (token) => {
    const entry: McpCatalogEntry = {
      ...httpTemplate,
      headers: { Authorization: `Bearer ${token}`, "X-Unbound": token },
      headerBindings: { Authorization: { [token]: { input: "token" } } },
      requiredEnv: [{ name: "token", defaultValue: "synthetic-default" }],
    };
    expect(catalogEntryError(entry)).toBeNull();
    expect(collectCatalogPlaceholders(entry)).toEqual(["token"]);
    expect(resolveCatalogEntry(entry, { token: "synthetic-secret" }).headers).toEqual({
      Authorization: "Bearer synthetic-secret", "X-Unbound": token,
    });
    expect(resolveCatalogEntry(entry).headers).toEqual({
      Authorization: "Bearer synthetic-default", "X-Unbound": token,
    });
  });

  it("does not discover or require an unbound header token in explicit binding mode", () => {
    const entry: McpCatalogEntry = {
      ...httpTemplate,
      headers: { Authorization: "Bearer {token}", "X-Unbound": "${UNBOUND}" },
      headerBindings: { Authorization: { "{token}": { input: "key" } } },
      requiredEnv: [{ name: "key" }],
    };
    expect(collectCatalogPlaceholders(entry)).toEqual(["key"]);
    expect(catalogEntryError(entry)).toBeNull();
    expect(resolveCatalogEntry(entry, { key: "synthetic-secret" }).headers).toEqual({
      Authorization: "Bearer synthetic-secret", "X-Unbound": "${UNBOUND}",
    });
  });

  it.each<NonNullable<McpCatalogEntry["headerBindings"]>>([{}, { Authorization: {} }])("treats an empty binding map as explicit mode: %j", (headerBindings) => {
    const entry: McpCatalogEntry = {
      ...httpTemplate,
      headers: { Authorization: "Bearer ${TOKEN}", "X-Unbound": "{TOKEN}" },
      headerBindings,
      requiredEnv: [{ name: "TOKEN", defaultValue: "synthetic-default" }],
    };
    expect(collectCatalogPlaceholders(entry)).toEqual([]);
    expect(catalogEntryError(entry)).toBeNull();
    expect(resolveCatalogEntry(entry).headers).toEqual(entry.headers);
    expect(resolveCatalogEntry(entry, { TOKEN: "synthetic-secret" }).headers).toEqual(entry.headers);
    expect(resolveCatalogEntry({ ...entry, requiredEnv: [{ name: "TOKEN" }] }).headers).toEqual(entry.headers);
  });

  it("ignores inherited header bindings instead of falling back to global inputs", () => {
    const entry: McpCatalogEntry = {
      ...httpTemplate,
      headers: { Authorization: "Bearer {token}" },
      headerBindings: Object.create({ Authorization: { "{token}": { input: "token" } } }),
      requiredEnv: [{ name: "token" }],
    };
    expect(collectCatalogPlaceholders(entry)).toEqual([]);
    expect(resolveCatalogEntry(entry, { token: "synthetic-secret" }).headers).toEqual(entry.headers);
  });

  it("preserves legacy dollar and declared brace headers without binding metadata", () => {
    const entry: McpCatalogEntry = {
      ...httpTemplate,
      headers: { Authorization: "Bearer ${TOKEN}", "X-Token": "{TOKEN}" },
      requiredEnv: [{ name: "TOKEN" }],
    };
    expect(collectCatalogPlaceholders(entry)).toEqual(["TOKEN"]);
    expect(resolveCatalogEntry(entry, { TOKEN: "synthetic-secret" }).headers).toEqual({
      Authorization: "Bearer synthetic-secret", "X-Token": "synthetic-secret",
    });
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
  it("rejects malformed collection fields without exposing them to the renderer", () => {
    const malformed = [
      { ...stdioTemplate, id: "bad-categories", categories: "web" },
      { ...stdioTemplate, id: "bad-args", args: ["--ok", 1] },
      { ...stdioTemplate, id: "bad-env", env: { TOKEN: 1 } },
      { ...stdioTemplate, id: "bad-required-env", requiredEnv: [{ name: "TOKEN", optional: "yes" }] },
      { ...httpTemplate, id: "private-http", url: "https://127.0.0.1/mcp" },
    ];
    expect(() => validateMcpCatalogFile({ servers: malformed })).not.toThrow();
    const { catalog, warnings } = validateMcpCatalogFile({ servers: malformed });
    expect(catalog.servers).toEqual([]);
    expect(warnings).toHaveLength(malformed.length);
    expect(warnings.join("\n")).toContain("categories");
    expect(warnings.join("\n")).toContain("public https");
  });
});


describe("header-local token bindings", () => {
  const entry: McpCatalogEntry = {
    id: "scoped", name: "Scoped", transport: "http", url: "https://example.com/mcp",
    headers: { "X-Test": "{literal} {input} {fixed}" },
    headerBindings: { "X-Test": { "{input}": { input: "key" }, "{fixed}": { value: "{input}" } } },
    requiredEnv: [{ name: "key" }],
  };

  it("collects editable references only and preserves literal replacements", () => {
    expect(collectCatalogPlaceholders(entry)).toEqual(["key"]);
    expect(resolveCatalogEntry(entry, { key: "synthetic" }).headers).toEqual({
      "X-Test": "{literal} synthetic {input}",
    });
  });

  it("validates input references and binding shapes", () => {
    expect(catalogEntryError({ ...entry, requiredEnv: [] })).toContain("placeholder key is not declared");
    for (const headerBindings of [
      { "X-Unknown": {} },
      { "X-Test": { "{input}": { input: "key", value: "both" } } },
      { "X-Test": { "{input}": { input: 3 } } },
      { "X-Test": { invalid: { value: "literal" } } },
    ]) expect(catalogEntryError({ ...entry, headerBindings })).not.toBeNull();
    expect(catalogEntryError({ ...entry, transport: "stdio", command: "node" })).toContain("requires http");
  });
});
