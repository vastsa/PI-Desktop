/** Controlled JSON-RPC peer for checkpoint lifecycle tests; data is temporary. */
const { createInterface } = require("node:readline");
const { readFile, rename, writeFile } = require("node:fs/promises");
const { join } = require("node:path");

const root = process.env.PI_DESKTOP_DATA_DIR;
const started = [];
const startWaiters = new Map();
const saveWaiters = new Map();
const held = new Map();
const saved = new Set();
const key = (sessionId, id) => `${sessionId}:${id}`;
const checkpointPath = (sessionId) => join(root, `${sessionId}.inflight.json`);
function waiter(map, id) {
  if (!map.has(id)) map.set(id, Promise.withResolvers());
  return map.get(id);
}
function send(response) { process.stdout.write(JSON.stringify(response) + "\n"); }

async function handle({ id, method, params = {} }) {
  try {
    let result = {};
    if (method === "session.saveInflightMessage") {
      const identity = key(params.sessionId, params.message.id);
      started.push({ sessionId: params.sessionId, id: params.message.id });
      waiter(startWaiters, identity).resolve();
      if (params.message.id === "held" || params.message.id === "old") {
        await waiter(held, identity).promise;
      }
      const target = checkpointPath(params.sessionId);
      const temporary = `${target}.${params.message.id}.tmp`;
      await writeFile(temporary, JSON.stringify(params));
      await rename(temporary, target);
      saved.add(identity);
      waiter(saveWaiters, identity).resolve();
    } else if (method === "fixture.waitStarted") {
      await waiter(startWaiters, key(params.sessionId, params.id)).promise;
    } else if (method === "fixture.waitSaved") {
      const identity = key(params.sessionId, params.id);
      if (!saved.has(identity)) await waiter(saveWaiters, identity).promise;
    } else if (method === "fixture.release") {
      waiter(held, key(params.sessionId, params.id)).resolve();
    } else if (method === "fixture.state") {
      result = { started };
    } else if (method === "fixture.read") {
      result = JSON.parse(await readFile(checkpointPath(params.sessionId), "utf8"));
    } else if (method !== "app.handshake") {
      throw new Error(`unexpected fixture method: ${method}`);
    }
    send({ jsonrpc: "2.0", id, result });
  } catch (error) {
    send({ jsonrpc: "2.0", id, error: { code: -32603, message: error.message } });
  }
}

// A --require preload receives stdin before Node's stdin script entry point.
// EOF has the same shutdown meaning as the real host.
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => { if (line.trim()) void handle(JSON.parse(line)); });
lines.on("close", () => process.exit(0));
