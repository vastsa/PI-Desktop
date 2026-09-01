import { describe, expect, it } from "vitest";
import { isLoopbackHost, resolveMcpRefs, validateMcpServer } from "./mcp-config.js";

function error(raw: unknown): string {
  const result = validateMcpServer(raw);
  if (result.ok) throw new Error("expected the server entry to be rejected");
  return result.error;
}

describe("validateMcpServer (stdio)", () => {
  it("accepts a bare command with args and env", () => {
    const result = validateMcpServer({
      id: "files",
      transport: "stdio",
      command: "mcp-files",
      args: ["--root", "."],
      env: { TOKEN: { setting: "token" }, MODE: "read" },
    });
    expect(result.ok).toBe(true);
  });

  it("accepts a plugin-relative command", () => {
    expect(validateMcpServer({ id: "a", transport: "stdio", command: "bin/server.js" }).ok).toBe(
      true,
    );
  });

  it("rejects absolute paths and parent traversal", () => {
    expect(error({ id: "a", transport: "stdio", command: "/usr/bin/x" })).toMatch(/absolute/);
    expect(error({ id: "a", transport: "stdio", command: "C:\\x.exe" })).toMatch(/absolute/);
    expect(error({ id: "a", transport: "stdio", command: "../x" })).toMatch(/\.\./);
  });

  it("rejects shell-shaped commands", () => {
    expect(error({ id: "a", transport: "stdio", command: "x && y" })).toMatch(/executable name/);
  });

  it("rejects http-only fields", () => {
    expect(
      error({ id: "a", transport: "stdio", command: "x", url: "https://example.com" }),
    ).toMatch(/must not set url/);
  });

  it("rejects bad env keys and reference shapes", () => {
    expect(error({ id: "a", transport: "stdio", command: "x", env: { "BAD-KEY": "1" } })).toMatch(
      /not allowed/,
    );
    expect(error({ id: "a", transport: "stdio", command: "x", env: { A: { setting: "" } } })).toMatch(
      /must be a string/,
    );
  });
});

describe("validateMcpServer (http)", () => {
  it("accepts https endpoints with header references", () => {
    const result = validateMcpServer({
      id: "remote",
      transport: "http",
      url: "https://example.com/mcp",
      headers: { Authorization: { setting: "apiKey" } },
    });
    expect(result.ok).toBe(true);
  });

  it("allows plain http endpoints, including LAN servers", () => {
    expect(validateMcpServer({ id: "a", transport: "http", url: "http://127.0.0.1:3000" }).ok).toBe(
      true,
    );
    expect(validateMcpServer({ id: "a", transport: "http", url: "http://192.168.1.20:8080/mcp" }).ok).toBe(
      true,
    );
    expect(validateMcpServer({ id: "a", transport: "http", url: "http://example.com" }).ok).toBe(
      true,
    );
  });

  it("rejects unsupported protocols, bad urls and stdio-only fields", () => {
    expect(error({ id: "a", transport: "http", url: "file:///etc/passwd" })).toMatch(
      /http or https/,
    );
    expect(error({ id: "a", transport: "http", url: "not a url" })).toMatch(/valid absolute url/);
    expect(error({ id: "a", transport: "http", url: "https://x", command: "y" })).toMatch(
      /must not set command/,
    );
  });
});

describe("validateMcpServer (shape)", () => {
  it("rejects bad ids and transports", () => {
    expect(error({ id: "9bad", transport: "stdio", command: "x" })).toMatch(/id must match/);
    expect(error({ id: "a", transport: "ws" })).toMatch(/transport must be/);
    expect(error(null)).toMatch(/must be an object/);
  });
});

describe("isLoopbackHost", () => {
  it("recognises loopback forms", () => {
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("127.9.9.9")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("10.0.0.1")).toBe(false);
  });
});

describe("resolveMcpRefs", () => {
  it("resolves literals and settings references", () => {
    expect(resolveMcpRefs({ A: "1", B: { setting: "b" } }, { b: 42 })).toEqual({
      ok: true,
      values: { A: "1", B: "42" },
    });
  });

  it("fails when a referenced setting is missing or not scalar", () => {
    const missing = resolveMcpRefs({ A: { setting: "a" } }, {});
    expect(missing).toEqual({ ok: false, error: 'setting "a" is not configured' });
    const object = resolveMcpRefs({ A: { setting: "a" } }, { a: { nested: true } });
    expect(object.ok).toBe(false);
  });

  it("returns an empty map for no declarations", () => {
    expect(resolveMcpRefs(undefined, {})).toEqual({ ok: true, values: {} });
  });
});
