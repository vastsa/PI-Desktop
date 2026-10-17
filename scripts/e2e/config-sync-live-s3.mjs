import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const helper = fileURLToPath(new URL("./config-sync-s3-admin.py", import.meta.url));

export async function openLiveS3(envFile, prefix) {
  const fields = parseEnv(await readFile(envFile, "utf8"));
  for (const name of ["S3_HOST", "S3_REGION", "S3_BUCKET", "S3_ACCESS_KEY", "S3_SECRET_KEY", "S3_DOMAIN_MODE"]) {
    if (!fields[name]) throw new Error(`Missing required ${name}`);
  }
  if (!["true", "false"].includes(fields.S3_DOMAIN_MODE)) throw new Error("S3_DOMAIN_MODE must be true or false");
  const endpoint = new URL(fields.S3_HOST.includes("://") ? fields.S3_HOST : `https://${fields.S3_HOST}`);
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== "/") {
    throw new Error("Live S3 requires an HTTPS origin without userinfo, query or path");
  }
  const connection = {
    endpoint: endpoint.origin, region: fields.S3_REGION, bucket: fields.S3_BUCKET, prefix,
    accessKeyId: fields.S3_ACCESS_KEY, secretAccessKey: fields.S3_SECRET_KEY,
    sessionToken: fields.S3_SESSION_TOKEN || "", pathStyle: fields.S3_DOMAIN_MODE === "false",
  };
  const admin = (operation, extra = {}) => new Promise((resolve, reject) => {
    const child = execFile("python3", [helper], { timeout: 300_000, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout) => {
      let value;
      try { value = JSON.parse(stdout); } catch { reject(new Error("S3 admin failed without a safe result")); return; }
      if (error || value.ok !== true) {
        const failure = new Error("S3 test administration failed");
        failure.safeStatus = Number.isInteger(value.status) ? value.status : undefined;
        reject(failure);
      } else resolve(value.result);
    });
    child.stdin.on("error", () => reject(new Error("S3 admin input channel failed")));
    child.stdin.end(JSON.stringify({ operation, connection, ...extra }));
  });
  // Must succeed BEFORE any Host receives the destination. Failed preflight
  // never grants cleanup ownership of a possibly existing namespace.
  const prepared = await admin("prepare");
  assert.equal(prepared.empty, true);
  return {
    connection,
    async inventory() { return (await admin("inventory")).keys; },
    async inspect(markers) { return admin("inspect", { markers }); },
    async cleanup() { return admin("cleanup", { ownedEmptyNamespace: true }); },
    async close() {},
  };
}
