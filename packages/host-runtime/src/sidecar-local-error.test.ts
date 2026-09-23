import { afterEach, expect, it } from "vitest";
import { AgentSidecar } from "./agent-sidecar.js";

const sidecars: AgentSidecar[] = [];
afterEach(async () => {
  await Promise.all(sidecars.splice(0).map((sidecar) => sidecar.dispose()));
});

// The bundled runtime tests exercise the sender. This real stdio boundary
// independently protects the production Host decoder from dropping provenance.
it.each(["context-validation", "context-estimation", "request-preparation"])(
  "preserves %s error attribution through the production sidecar receiver",
  async (phase) => {
    const data = {
      errorCode: "INTERNAL",
      retriable: false,
      details: { origin: "local", phase, causeName: "TypeError" },
    };
    const source = `
      const rl = require('node:readline').createInterface({ input: process.stdin });
      rl.on('line', line => {
        const request = JSON.parse(line);
        if (request.method === 'ping') {
          console.log(JSON.stringify({ id: request.id, result: { ok: true } }));
          return;
        }
        console.log(JSON.stringify({ id: request.id, error: {
          code: -32000, message: 'Local request preparation failed',
          data: ${JSON.stringify(data)}
        } }));
      });`;
    const sidecar = new AgentSidecar({
      launch: { command: process.execPath, args: ["-e", source] },
      onStderr: () => {},
    });
    sidecars.push(sidecar);

    await expect(sidecar.call("probe", {})).rejects.toMatchObject({
      code: -32000,
      errorCode: "INTERNAL",
      message: "Local request preparation failed",
      data,
    });
    expect(await sidecar.call("ping", {})).toEqual({ ok: true });
  },
);
