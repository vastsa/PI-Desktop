import { describe, expect, it } from "vitest";
import { catalogEntryError } from "./mcp-catalog.js";
import {
  guessCategory,
  mapRegistryServer,
  mergeRegistryEntries,
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
    description: "Fetch pages",
    packages: [{ registryType: "pypi", identifier: "mcp-server-fetch" }],
  },
};

const remoteRecord: RegistryRecord = {
  server: {
    name: "ac.inference.sh/mcp",
    title: "inference.sh",
    description: "run any ai model",
    remotes: [{ type: "streamable-http", url: "https://api.inference.sh/mcp" }],
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
    expect(entry!.args).toEqual(["-y", "playwright-stealth-mcp-server"]);
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
    expect(entry!.args).toEqual(["mcp-server-fetch"]);
    expect(entry!.prerequisites?.join(" ")).toContain("uv");
    expect(catalogEntryError(entry!)).toBeNull();
  });

  it("maps a remote-only record to an https http entry", () => {
    const entry = mapRegistryServer(remoteRecord);
    expect(entry!.transport).toBe("http");
    expect(entry!.url).toBe("https://api.inference.sh/mcp");
    expect(entry!.name).toBe("inference.sh");
    expect(catalogEntryError(entry!)).toBeNull();
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
