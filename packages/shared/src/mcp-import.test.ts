import { describe, expect, it } from "vitest";
import {
  isLoopbackMcpUrl,
  isNonLoopbackHttpMcpUrl,
  mcpImportId,
  parseMcpImport,
} from "./mcp-import.js";

describe("parseMcpImport", () => {
  it("reads the mcpServers document every MCP README prints", () => {
    const result = parseMcpImport(
      JSON.stringify({
        mcpServers: {
          context7: { command: "npx", args: ["-y", "@upstash/context7-mcp"] },
        },
      }),
    );

    expect(result.skipped).toEqual([]);
    expect(result.servers).toEqual([
      {
        id: "context7",
        label: "context7",
        description: undefined,
        transport: "stdio",
        command: "npx",
        args: ["-y", "@upstash/context7-mcp"],
        env: {},
      },
    ]);
  });

  it("accepts the bare map and the `servers` spelling of it", () => {
    const bare = parseMcpImport('{"a": {"command": "a-cmd"}, "b": {"command": "b-cmd"}}');
    expect(bare.servers.map((s) => s.id)).toEqual(["a", "b"]);

    const alt = parseMcpImport('{"servers": {"a": {"command": "a-cmd"}}}');
    expect(alt.servers.map((s) => s.id)).toEqual(["a"]);
  });

  it("accepts one server object on its own", () => {
    const result = parseMcpImport('{"id": "solo", "command": "solo-cmd"}');
    expect(result.servers).toHaveLength(1);
    expect(result.servers[0]).toMatchObject({ id: "solo", transport: "stdio", command: "solo-cmd" });
  });

  // A `url` is the only reliable signal: half the configs in the wild omit `type`.
  it("infers http from a url even with no declared type", () => {
    const result = parseMcpImport(
      '{"mcpServers": {"remote": {"url": "https://mcp.example.com/sse", "headers": {"Authorization": "Bearer x"}}}}',
    );
    expect(result.servers[0]).toEqual({
      id: "remote",
      label: "remote",
      description: undefined,
      transport: "http",
      url: "https://mcp.example.com/sse",
      headers: { Authorization: "Bearer x" },
    });
  });

  it("honours a declared sse type that carries no url by reporting it", () => {
    const result = parseMcpImport('{"mcpServers": {"broken": {"type": "sse"}}}');
    expect(result.servers).toEqual([]);
    expect(result.skipped).toEqual([{ id: "broken", reason: "an http server requires url" }]);
  });

  it("reports a stdio entry with no command instead of importing it", () => {
    const result = parseMcpImport('{"mcpServers": {"empty": {"args": ["-y"]}}}');
    expect(result.servers).toEqual([]);
    expect(result.skipped).toEqual([{ id: "empty", reason: "a stdio server requires command" }]);
  });

  it("skips entries the source marked disabled", () => {
    const result = parseMcpImport('{"mcpServers": {"off": {"command": "x", "disabled": true}}}');
    expect(result.servers).toEqual([]);
    expect(result.skipped).toEqual([{ id: "off", reason: "marked disabled" }]);
  });

  it("coerces non-string env and header values, and drops non-string args", () => {
    const result = parseMcpImport(
      '{"mcpServers": {"s": {"command": "x", "args": ["a", 2, null], "env": {"PORT": 8080, "DEBUG": true, "OBJ": {}}}}}',
    );
    expect(result.servers[0]).toMatchObject({
      args: ["a"],
      env: { PORT: "8080", DEBUG: "true" },
    });
  });

  it("caps the import and says what it left out", () => {
    const many = Object.fromEntries(
      Array.from({ length: 35 }, (_, i) => [`s${i}`, { command: "x" }]),
    );
    const result = parseMcpImport(JSON.stringify({ mcpServers: many }));
    expect(result.servers).toHaveLength(32);
    expect(result.skipped).toHaveLength(3);
    expect(result.skipped[0].reason).toMatch(/32 server import limit/);
  });

  it("explains bad input rather than returning an empty result", () => {
    expect(() => parseMcpImport("{oops")).toThrow(/not valid JSON/);
    expect(() => parseMcpImport("[]")).toThrow(/expected a JSON object/);
    expect(() => parseMcpImport('{"mcpServers": {}}')).toThrow(/no MCP servers found/);
  });
});

describe("mcpImportId", () => {
  it("keeps an already-valid key", () => {
    expect(mcpImportId("context7", 0)).toBe("context7");
  });

  it("replaces characters host-core rejects", () => {
    expect(mcpImportId("my server.v2", 0)).toBe("my-server-v2");
  });

  it("falls back to a positional id when nothing usable is left", () => {
    expect(mcpImportId("7-eleven", 0)).toBe("server-1");
    expect(mcpImportId("...", 4)).toBe("server-5");
  });
});

describe("isLoopbackMcpUrl", () => {
  it("accepts the local names and the whole 127 block", () => {
    expect(isLoopbackMcpUrl("http://localhost:3000/sse")).toBe(true);
    expect(isLoopbackMcpUrl("http://127.0.0.1:3000")).toBe(true);
    expect(isLoopbackMcpUrl("http://127.9.9.9/mcp")).toBe(true);
    expect(isLoopbackMcpUrl("http://[::1]:3000")).toBe(true);
  });

  it("rejects remote hosts and hosts that merely look local", () => {
    expect(isLoopbackMcpUrl("http://mcp.example.com")).toBe(false);
    expect(isLoopbackMcpUrl("http://localhost.example.com")).toBe(false);
    expect(isLoopbackMcpUrl("http://127.0.0.1.example.com")).toBe(false);
    expect(isLoopbackMcpUrl("not a url")).toBe(false);
  });
});

describe("isNonLoopbackHttpMcpUrl", () => {
  it("identifies LAN HTTP endpoints for the security warning", () => {
    expect(isNonLoopbackHttpMcpUrl("http://192.168.1.20:8080/mcp")).toBe(true);
    expect(isNonLoopbackHttpMcpUrl("http://mcp.example.com/mcp")).toBe(true);
    expect(isNonLoopbackHttpMcpUrl("http://127.0.0.1:8080/mcp")).toBe(false);
    expect(isNonLoopbackHttpMcpUrl("https://mcp.example.com/mcp")).toBe(false);
    expect(isNonLoopbackHttpMcpUrl("not a url")).toBe(false);
  });
});
