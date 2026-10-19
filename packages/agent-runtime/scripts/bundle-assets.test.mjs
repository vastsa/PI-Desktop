import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { Worker } from "node:worker_threads";
import { expect, it } from "vitest";
import { bundleAgentRuntime } from "./bundle.mjs";

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type);
  const body = Buffer.concat([name, data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, checksum]);
}

function onePixelPng() {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0, 255]))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

it("bundles a runnable image-resize worker and its Photon WASM asset", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-runtime-image-resize-"));
  const bundle = join(root, "bundle");

  try {
    await bundleAgentRuntime(bundle);

    const workerPath = join(bundle, "chunks", "image-resize-worker.js");
    const wasm = await readFile(join(bundle, "chunks", "photon_rs_bg.wasm"));
    expect(wasm.byteLength).toBeGreaterThan(8);

    const worker = new Worker(workerPath);
    try {
      const responsePromise = once(worker, "message");
      const inputBytes = new Uint8Array(onePixelPng());
      worker.postMessage(
        {
          inputBytes,
          mimeType: "image/png",
          options: { maxWidth: 2_000, maxHeight: 2_000, maxBytes: 4.5 * 1024 * 1024 },
        },
        [inputBytes.buffer],
      );
      const [response] = await responsePromise;
      expect(response).toMatchObject({
        type: "pi:image-resize-response",
        result: { mimeType: "image/png", width: 1, height: 1, wasResized: false },
      });
    } finally {
      await worker.terminate();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
