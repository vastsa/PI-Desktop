"use strict";

const fs = require("node:fs/promises");
const { join } = require("node:path");
const { randomUUID } = require("node:crypto");
const { DEFAULTS, LIMITS, fail, validateDocument } = require("./model.js");

/** The one document shape this build reads and writes. */
function emptyDocument() {
  return { schemaVersion: 3, settings: { ...DEFAULTS }, entries: [], proposals: [] };
}

// The service serializes operations. Only rename publishes a new snapshot.
function createStore(getDataPath) {
  let cached = null;
  let directory = null;

  async function location() {
    directory ??= await getDataPath();
    if (typeof directory !== "string" || !directory) fail("UNAVAILABLE", "The host did not provide a private data directory.");
    return join(directory, "memory.v1.json");
  }

  async function read() {
    if (cached) return structuredClone(cached);
    const path = await location();
    try {
      // Read through one handle, and never allocate an unbounded corrupt file.
      const handle = await fs.open(path, "r");
      try {
        const stat = await handle.stat();
        if (stat.size > LIMITS.fileBytes) fail("STORAGE_INVALID", "Memory storage exceeds its size limit. It was not overwritten.");
        const bytes = Buffer.alloc(Math.min(stat.size + 1, LIMITS.fileBytes + 1));
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
        if (bytesRead !== stat.size) fail("STORAGE_INVALID", "Memory storage changed while being read. Retry after reloading the plugin.");
        cached = validateDocument(JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")));
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (error.code === "ENOENT") cached = emptyDocument();
      else if (error instanceof SyntaxError) fail("STORAGE_INVALID", "Memory storage contains invalid JSON. It was not overwritten.");
      else if (error.code?.startsWith("MEMORY_")) throw error;
      else fail("STORAGE_IO", "Memory storage could not be read. Check the plugin data directory permissions.");
    }
    return structuredClone(cached);
  }

  async function write(next, guard) {
    validateDocument(next);
    const text = JSON.stringify(next, null, 2) + "\n";
    if (Buffer.byteLength(text) > LIMITS.fileBytes) fail("CAPACITY", "Memory storage is full. Remove unused records first.");
    const path = await location();
    const temp = `${path}.${randomUUID()}.tmp`;
    let created = false;
    try {
      await guard();
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const handle = await fs.open(temp, "wx", 0o600);
      created = true;
      try {
        await handle.writeFile(text, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await guard();
      await fs.rename(temp, path);
      created = false;
      cached = structuredClone(next);
    } catch (error) {
      if (error.code?.startsWith("MEMORY_")) throw error;
      fail("STORAGE_IO", "Memory could not be saved. The previous snapshot was retained.");
    } finally {
      if (created) {
        try { await fs.unlink(temp); }
        catch (error) { if (error.code !== "ENOENT") console.error("[official-enhancements] memory temporary-file cleanup failed"); }
      }
    }
  }

  return { read, write };
}

module.exports = { createStore };
