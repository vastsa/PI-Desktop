import { describe, expect, it } from "vitest";
import { catalogEntryError, resolveCatalogEntry } from "./mcp-catalog.js";
import {
  guessCategory,
  isPublicIpLiteral,
  isSafeMarketSourceUrl,
  mapRegistryServer,
  mergeRegistryEntries,
  sanitizeMarketSources,
  registryIdFromName,
  type RegistryRecord,
} from "./mcp-registry.js";

const npmRecord: RegistryRecord = {
  server: {
    name: "com.pulsemcp/playwright-stealth",
    title: "Playwright Stealth",
    description: "Stealth browser automation",
    homepage: "https://pulsemcp.com",
    packages: [
      {
        registryType: "npm",
        identifier: "playwright-stealth-mcp-server",
        version: "1.2.3",
        runtimeHint: "npx",
        runtimeArguments: [{ value: "-y", type: "positional" }],
        environmentVariables: [
          { name: "STEALTH_MODE", description: "Enable stealth mode.", default: "false" },
          { name: "PROXY_URL", description: "Proxy URL." },
        ],
      },
    ],
  },
};

const pypiRecord: RegistryRecord = {
  server: {
    name: "io.github.example/fetch-mcp",
    packages: [
      {
        registryType: "pypi",
        identifier: "mcp-server-fetch",
        version: "2.4.0",
        runtimeArguments: [{ type: "positional", value: "--python" }, { type: "positional", value: "3.12" }],
        packageArguments: [{ type: "named", name: "--transport", value: "stdio" }],
      },
    ],
  },
};

const remoteRecord: RegistryRecord = {
  server: {
    name: "ac.inference.sh/mcp",
    title: "inference.sh",
    description: "run any ai model",
    remotes: [
      { type: "sse", url: "https://api.inference.sh/sse" },
      {
        type: "streamable-http",
        url: "https://api.inference.sh/mcp",
        headers: [
          { name: "Authorization", value: "Bearer ${TOKEN}" },
          { name: "X-Project", value: "${PROJECT}" },
        ],
      },
    ],
  },
};

/*
 * The official registry spells a header variable as `{name}` and declares it in
 * `variables` (see the `variables` description in the registry server schema,
 * which replaces the `{curly_braces}` keys of `value`). Records in the wild use
 * both that form and the `${NAME}` form the builtin catalog uses.
 */
const officialPlaceholderRecord: RegistryRecord = {
  server: {
    name: "io.github.example/cloud-toolkit",
    title: "Cloud Toolkit",
    description: "web search and page extraction",
    remotes: [
      {
        type: "streamable-http",
        url: "https://toolkit.example.com/mcp",
        headers: [
          {
            name: "Authorization",
            value: "Bearer {CLOUD_API_KEY}",
            isRequired: true,
            isSecret: true,
            variables: {
              CLOUD_API_KEY: {
                description: "Create a scoped key in the dashboard.",
                format: "string",
                isRequired: true,
                isSecret: true,
              },
            },
          },
        ],
      },
    ],
  },
};

const lowercasePlaceholderRecord: RegistryRecord = {
  server: {
    name: "ai.example/lowercase",
    title: "Lowercase",
    description: "a server whose variable name is not upper case",
    remotes: [
      {
        type: "streamable-http",
        url: "https://lowercase.example.com/mcp",
        headers: [{ name: "Authorization", value: "Bearer {api_key}" }],
      },
    ],
  },
};

describe("registryIdFromName", () => {
  it("slugifies reverse-dns names", () => {
    expect(registryIdFromName("com.pulsemcp/playwright-stealth")).toBe("com-pulsemcp-playwright-stealth");
    expect(registryIdFromName("ac.inference.sh/mcp")).toBe("ac-inference-sh-mcp");
  });

  it("keeps ids inside the host's id shape", () => {
    const id = registryIdFromName("io.github.1night/9tails-mcp");
    expect(id).toMatch(/^[a-z][a-z0-9_-]{0,63}$/);
  });
});

describe("mapRegistryServer", () => {
  it("maps an npm package to an npx stdio template with env placeholders", () => {
    const entry = mapRegistryServer(npmRecord);
    expect(entry).not.toBeNull();
    expect(entry!.transport).toBe("stdio");
    expect(entry!.command).toBe("npx");
    expect(entry!.args).toEqual(["-y", "playwright-stealth-mcp-server@1.2.3"]);
    expect(entry!.env).toEqual({
      STEALTH_MODE: "${STEALTH_MODE}",
      PROXY_URL: "${PROXY_URL}",
    });
    const specs = entry!.requiredEnv!;
    expect(specs.find((spec) => spec.name === "STEALTH_MODE")?.defaultValue).toBe("false");
    expect(specs.find((spec) => spec.name === "PROXY_URL")?.defaultValue).toBeUndefined();
    expect(catalogEntryError(entry!)).toBeNull();
  });

  it("maps a pypi package to uvx with a prerequisite note", () => {
    const entry = mapRegistryServer(pypiRecord);
    expect(entry!.transport).toBe("stdio");
    expect(entry!.command).toBe("uvx");
    expect(entry!.args).toEqual(["--python", "3.12", "mcp-server-fetch==2.4.0", "--transport", "stdio"]);
    expect(entry!.prerequisites?.join(" ")).toContain("uv");
    expect(catalogEntryError(entry!)).toBeNull();
  });

  it("maps a remote-only record to an https http entry", () => {
    const entry = mapRegistryServer(remoteRecord);
    expect(entry!.transport).toBe("http");
    expect(entry!.url).toBe("https://api.inference.sh/mcp");
    expect(entry!.headers).toEqual({
      Authorization: "Bearer ${TOKEN}",
      "X-Project": "${PROJECT}",
    });
    expect(entry!.requiredEnv).toEqual([{ name: "PROJECT" }, { name: "TOKEN" }]);
    expect(entry!.name).toBe("inference.sh");
    expect(catalogEntryError(entry!)).toBeNull();
  });

  it("maps a remote record's official {curly_braces} header variables", () => {
    const entry = mapRegistryServer(officialPlaceholderRecord);
    expect(entry).not.toBeNull();
    expect(entry!.headers).toEqual({ Authorization: "Bearer {CLOUD_API_KEY}" });
    expect(entry!.requiredEnv).toEqual([
      { name: "CLOUD_API_KEY", description: "Create a scoped key in the dashboard." },
    ]);
    expect(catalogEntryError(entry!)).toBeNull();
  });

  it("accepts a lowercase variable name", () => {
    const entry = mapRegistryServer(lowercasePlaceholderRecord);
    expect(entry!.requiredEnv).toEqual([{ name: "api_key" }]);
    expect(catalogEntryError(entry!)).toBeNull();
    const input = resolveCatalogEntry(entry!, { api_key: "k-lower-1" });
    expect(input.headers).toEqual({ Authorization: "Bearer k-lower-1" });
  });

  it("marks a declared header variable optional when it is not required", () => {
    const record: RegistryRecord = JSON.parse(JSON.stringify(officialPlaceholderRecord));
    record.server!.remotes![0].headers![0].variables!.CLOUD_API_KEY = {
      description: "Optional project selector.",
      isRequired: false,
    };
    const entry = mapRegistryServer(record);
    expect(entry!.requiredEnv).toEqual([
      { name: "CLOUD_API_KEY", description: "Optional project selector.", optional: true },
    ]);
  });

  it("resolves an official {curly_braces} header into the sent value, not the placeholder", () => {
    const entry = mapRegistryServer(officialPlaceholderRecord)!;
    const input = resolveCatalogEntry(entry, { CLOUD_API_KEY: "sk-live-123" });
    expect(input.headers).toEqual({ Authorization: "Bearer sk-live-123" });
  });

  it("resolves a builtin ${NAME} header without leaving a stray dollar", () => {
    const entry = mapRegistryServer(remoteRecord)!;
    const input = resolveCatalogEntry(entry, { TOKEN: "t-1", PROJECT: "p-9" });
    expect(input.headers).toEqual({
      Authorization: "Bearer t-1",
      "X-Project": "p-9",
    });
  });

  it("refuses to resolve an official header whose value is missing", () => {
    const entry = mapRegistryServer(officialPlaceholderRecord)!;
    expect(() => resolveCatalogEntry(entry, {})).toThrow(/missing value for CLOUD_API_KEY/);
  });

  it("drops records without a runnable form", () => {
    const ociOnly: RegistryRecord = {
      server: {
        name: "io.github.example/docker-only",
        packages: [{ registryType: "oci", identifier: "docker.io/example/mcp" }],
      },
    };
    expect(mapRegistryServer(ociOnly)).toBeNull();
    expect(mapRegistryServer({})).toBeNull();
    expect(mapRegistryServer({ server: { name: "io.github.example/http-only", remotes: [{ url: "http://x/mcp" }] } })).toBeNull();
    expect(
      mapRegistryServer({
        server: { name: "io.github.example/sse-only", remotes: [{ type: "sse", url: "https://example.com/sse" }] },
      }),
    ).toBeNull();
    expect(
      mapRegistryServer({
        server: { name: "io.github.example/private", remotes: [{ type: "streamable-http", url: "https://127.0.0.1/mcp" }] },
      }),
    ).toBeNull();
  });
});

describe("guessCategory", () => {
  it("maps keyword families to their category", () => {
    expect(guessCategory({ name: "io.github.x/demo", description: "Structured Docker operations" })).toBe("devtools");
    expect(guessCategory({ name: "com.x/postgres-query", description: "Run SQL" })).toBe("data");
    expect(guessCategory({ name: "com.x/notion-todo", description: "Tasks in Notion" })).toBe("productivity");
    expect(guessCategory({ name: "com.x/playwright-browser", description: "Drive a browser" })).toBe("web");
    expect(guessCategory({ name: "com.x/context7", description: "Library docs and context" })).toBe("docs");
  });

  it("assigns a category to every mapped registry entry", () => {
    // inference.sh matches no keyword family, so the devtools fallback applies.
    const entry = mapRegistryServer(remoteRecord);
    expect(entry!.categories).toEqual(["devtools"]);
  });
});

describe("mergeRegistryEntries", () => {
  it("keeps builtin first and skips remote id collisions", () => {
    const builtin = [
      { id: "context7", name: "Context7", transport: "stdio" as const, command: "npx" },
    ];
    const remote = [
      { id: "context7", name: "Context7 copy", transport: "stdio" as const, command: "npx" },
      { id: "deepwiki", name: "DeepWiki", transport: "http" as const, url: "https://mcp.deepwiki.com/mcp" },
    ];
    const merged = mergeRegistryEntries(builtin, remote);
    expect(merged.map((entry) => entry.id)).toEqual(["context7", "deepwiki"]);
  });
});

describe("registry argument and env semantics", () => {
  it("keeps named arguments with name and value", () => {
    const record: RegistryRecord = {
      server: {
        name: "io.github.example/named-args",
        packages: [
          {
            registryType: "npm",
            identifier: "named-args-mcp",
            runtimeHint: "npx",
            runtimeArguments: [{ type: "positional", value: "-y" }],
            packageArguments: [
              { type: "named", name: "--port", value: "8080" },
              { type: "named", name: "--verbose" },
            ],
          },
        ],
      },
    };
    const entry = mapRegistryServer(record)!;
    expect(entry.args).toEqual(["-y", "named-args-mcp", "--port", "8080", "--verbose"]);
  });

  it("maps isRequired to optional and keeps registry values as defaults", () => {
    const record: RegistryRecord = {
      server: {
        name: "io.github.example/env-req",
        packages: [
          {
            registryType: "npm",
            identifier: "env-req-mcp",
            environmentVariables: [
              { name: "REQUIRED_KEY", description: "Needed", isRequired: true },
              { name: "OPT_KEY", isRequired: false, default: "off" },
              { name: "FIXED", isRequired: false, value: "preset" },
            ],
          },
        ],
      },
    };
    const entry = mapRegistryServer(record)!;
    const specs = entry.requiredEnv ?? [];
    expect(specs.find((s) => s.name === "REQUIRED_KEY")?.optional).toBeUndefined();
    expect(specs.find((s) => s.name === "OPT_KEY")?.optional).toBe(true);
    expect(specs.find((s) => s.name === "OPT_KEY")?.defaultValue).toBe("off");
    expect(specs.find((s) => s.name === "FIXED")?.defaultValue).toBe("preset");
  });
});

describe("isPublicHostname / isPublicIpLiteral edge cases", () => {
  it("rejects trailing-dot and smuggeled private hosts", () => {
    expect(isSafeMarketSourceUrl("https://localhost./x")).toBe(false);
    expect(isSafeMarketSourceUrl("https://localhost.example./x")).toBe(true); // public dot-FQDN ok
    expect(isSafeMarketSourceUrl("https://[::ffff:127.0.0.1]/")).toBe(false);
    expect(isSafeMarketSourceUrl("https://[fd00::1]/")).toBe(false);
    expect(isSafeMarketSourceUrl("https://[fe80::1]/")).toBe(false);
    expect(isSafeMarketSourceUrl("https://[::1]/")).toBe(false);
    expect(isSafeMarketSourceUrl("https://127.0.0.1/x")).toBe(false);
    expect(isSafeMarketSourceUrl("https://10.1.2.3/x")).toBe(false);
    expect(isSafeMarketSourceUrl("https://[2001:db8::1]/")).toBe(false);
    expect(isSafeMarketSourceUrl("https://[2606:4700::1]/")).toBe(true);
    expect(isSafeMarketSourceUrl("https://registry.example/x")).toBe(true);
  });
});

describe("sanitizeMarketSources", () => {
  it("restores the canonical official source and caps custom sources", () => {
    const sources = sanitizeMarketSources([
      { id: "official", name: "attacker", url: "https://evil.example/catalog", kind: "catalog" },
      ...Array.from({ length: 20 }, (_, index) => ({
        id: `custom-${index}`,
        name: `Source ${index}`,
        url: `https://source-${index}.example/catalog`,
        kind: "catalog" as const,
      })),
    ]);
    expect(sources[0]).toMatchObject({
      id: "official",
      url: "https://registry.modelcontextprotocol.io/v0/servers",
      kind: "registry",
      builtin: true,
    });
    expect(sources).toHaveLength(16);
  });

  it("rejects embedded source credentials", () => {
    expect(
      sanitizeMarketSources([
        { id: "custom-auth", name: "Auth", url: "https://user:pass@example.com/catalog", kind: "catalog" },
      ]),
    ).toHaveLength(1);
  });
});
