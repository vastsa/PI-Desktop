import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { formatUserAgent } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { DESKTOP_AGENT_IDENTITY } from "../agent-identity.js";
import { decodeImageBase64 } from "./openai-images.js";
import { generateTestImage } from "./test-fixture.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9mQAAAAASUVORK5CYII=", "base64");

/** A PNG-signed payload whose base64 is well past the size that overflowed the old validator (#2128). */
function largePng(): Buffer {
  return Buffer.concat([png, Buffer.alloc(6 * 1024 * 1024, 0x5a)]);
}

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve) => server.close(() => resolve())))); });

describe("decodeImageBase64", () => {
  it("decodes a large payload without overflowing the stack (#2128)", () => {
    const bytes = largePng();
    const encoded = bytes.toString("base64");
    expect(encoded.length).toBeGreaterThan(8_000_000);
    expect(Buffer.from(decodeImageBase64(encoded)).equals(bytes)).toBe(true);
  });

  it.each(["QUJD", "QUJDRA==", "QUJDREU="])("accepts padded base64 %s", (data) => {
    expect(Buffer.from(decodeImageBase64(data))).toEqual(Buffer.from(data, "base64"));
  });

  it.each([
    "", // empty payload
    "QQ", // unpadded short quantum
    "QUI", // unpadded short quantum
    "QUJD!A==", // character outside the alphabet
    "QU=DRA==", // padding before the end
    "QUJ===", // three padding characters
    "Q===", // three padding characters in one quantum
    "QUJDR", // incomplete quantum
    "QUJD RA==", // whitespace
    "QUJD-A==", // base64url alphabet
    "====", // padding only
  ])("rejects malformed base64 %s", (data) => {
    expect(() => decodeImageBase64(data)).toThrow(expect.objectContaining({ errorCode: "IMAGE_INVALID_RESPONSE" }));
  });
});

/** A one-image endpoint that records each request's `User-Agent`. */
async function userAgentServer(): Promise<{ baseUrl: string; userAgents: (string | undefined)[] }> {
  const userAgents: (string | undefined)[] = [];
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain the request body */ }
    userAgents.push(req.headers["user-agent"]);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ b64_json: png.toString("base64") }] }));
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, userAgents };
}

it("identifies image requests with the client User-Agent chat requests send (#2238)", async () => {
  const { baseUrl, userAgents } = await userAgentServer();

  await generateTestImage({ baseUrl, modelId: "gpt-image-1.5" }, "A cup", new AbortController().signal);

  // Not the runtime's own default (`node`, or Chromium's browser string under
  // Electron `net.fetch`), which a bot filter in front of the vendor rejects.
  expect(userAgents).toEqual([formatUserAgent(DESKTOP_AGENT_IDENTITY)]);
  expect(userAgents[0]).toMatch(/^pi\//);
});

it("lets a configured User-Agent header replace the client one (#2238)", async () => {
  const { baseUrl, userAgents } = await userAgentServer();

  await generateTestImage({ baseUrl, modelId: "gpt-image-1.5", headers: { "user-agent": "custom/1.0" } },
    "A cup", new AbortController().signal);

  expect(userAgents).toEqual(["custom/1.0"]);
});

it("saves a large b64_json image returned by an OpenAI Images endpoint (#2128)", async () => {
  const bytes = largePng();
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain the request body */ }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ b64_json: bytes.toString("base64") }] }));
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;

  const image = await generateTestImage({ baseUrl, modelId: "gpt-image-1.5" }, "A cup", new AbortController().signal);

  expect(image.mimeType).toBe("image/png");
  expect(Buffer.from(image.bytes).equals(bytes)).toBe(true);
});
