import assert from "node:assert/strict";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const hmac = (key, value) => createHmac("sha256", key).update(value).digest();
const credentials = {
  accessKeyId: "fixture-access-key",
  secretAccessKey: "fixture-secret-key",
  sessionToken: "fixture-session-token",
  region: "us-east-1",
  bucket: "config-sync-fixture",
  pathStyle: true,
};

// Independent verifier: no production signer is imported by this server.
function verifySignature(request, body) {
  const match = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([a-f0-9]{64})$/.exec(request.headers.authorization ?? "");
  if (!match) return false;
  const [, accessKey, day, region, signedHeaders, signature] = match;
  const names = signedHeaders.split(";");
  const timestamp = request.headers["x-amz-date"];
  if (accessKey !== credentials.accessKeyId || region !== credentials.region ||
      !timestamp?.startsWith(day) || !/^\d{8}T\d{6}Z$/.test(timestamp) ||
      request.headers["x-amz-content-sha256"] !== sha256(body) ||
      request.headers["x-amz-security-token"] !== credentials.sessionToken ||
      [...names].sort().join(";") !== signedHeaders || new Set(names).size !== names.length) return false;
  const required = ["host", "x-amz-date", "x-amz-content-sha256", "x-amz-security-token"];
  for (const name of ["if-match", "if-none-match"]) {
    if (request.headers[name]) required.push(name);
  }
  if (required.some((name) => !names.includes(name))) return false;
  const canonicalHeaders = names.map((name) => {
    const value = request.headers[name];
    return typeof value === "string" ? `${name}:${value.trim().replace(/\s+/g, " ")}\n` : "";
  }).join("");
  const canonical = [request.method, request.url, "", canonicalHeaders, signedHeaders, sha256(body)].join("\n");
  const scope = `${day}/${region}/s3/aws4_request`;
  const toSign = `AWS4-HMAC-SHA256\n${timestamp}\n${scope}\n${sha256(canonical)}`;
  const key = hmac(hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`, day), region), "s3"), "aws4_request");
  return timingSafeEqual(hmac(key, toSign), Buffer.from(signature, "hex"));
}

export async function startS3Fixture(prefix) {
  const objects = new Map();
  const requests = [];
  let failureStatus = null;
  let rejectedSignatures = 0;
  const errors = [];
  const server = createServer((request, response) => {
    const send = (status, body = Buffer.alloc(0), headers = {}) => {
      response.writeHead(status, { "Content-Length": body.length, ...headers });
      response.end(body);
    };
    void (async () => {
      const chunks = [];
      let length = 0;
      for await (const chunk of request) {
        length += chunk.length;
        if (length > 64 * 1024 * 1024) return send(413);
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);
      if (!verifySignature(request, body)) {
        rejectedSignatures += 1;
        return send(403);
      }
      const path = decodeURIComponent(request.url.slice(1));
      if (!path.startsWith(`${credentials.bucket}/${prefix}/`)) return send(403);
      const key = path.slice(credentials.bucket.length + 1);
      requests.push({ method: request.method, key });
      if (failureStatus) return send(failureStatus);
      const existing = objects.get(key);
      switch (request.method) {
        case "GET":
          return existing ? send(200, existing.body, { ETag: existing.etag }) : send(404);
        case "PUT": {
          const none = request.headers["if-none-match"];
          const match = request.headers["if-match"];
          if ((!none && !match) || (none && match)) return send(400);
          if ((none === "*" && existing) || (match && existing?.etag !== match)) return send(412);
          const etag = `"${sha256(body)}"`;
          objects.set(key, { body, etag });
          return send(200, Buffer.alloc(0), { ETag: etag });
        }
        case "DELETE":
          objects.delete(key);
          return send(204);
        default:
          return send(405);
      }
    })().catch((error) => {
      errors.push(error);
      if (!response.headersSent) send(500);
      else response.destroy();
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    connection: { ...credentials, endpoint: `http://127.0.0.1:${server.address().port}`, prefix },
    failWith(status) { failureStatus = status; },
    async inventory() { return [...objects.keys()].sort(); },
    async inspect(markers) {
      assert.ok(objects.size > 0, "encrypted objects must exist");
      for (const { body } of objects.values()) {
        assert.ok(markers.every((marker) => !body.includes(Buffer.from(marker))), "remote plaintext leaked");
      }
      assert.equal(rejectedSignatures, 0, "all Host requests must have valid SigV4 signatures");
      assert.ok(requests.some(({ method }) => method === "DELETE"), "probe must clean up");
      assert.ok(requests.filter(({ method }) => method === "DELETE").every(({ key }) => key.startsWith(`${prefix}/probe/`)), "normal runs must not collect cloud objects");
      return { objects: objects.size, requests: requests.length, ciphertext: true, signatures: true };
    },
    async cleanup() {
      objects.clear();
      return { remaining: objects.size, versions: 0 };
    },
    async close() {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      if (errors.length) throw new AggregateError(errors, "S3 fixture failed");
    },
  };
}
