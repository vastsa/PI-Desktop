import { afterEach, expect, it, vi } from "vitest";
import { AgentSidecar, type SidecarHostLink } from "./agent-sidecar.js";

const childSource = `
  const rl = require('node:readline').createInterface({ input: process.stdin });
  const pending = new Map();
  rl.on('line', line => {
    const message = JSON.parse(line);
    if (message.method === 'probe') {
      const responseId = 'host-' + message.id;
      pending.set(responseId, message.id);
      console.log(JSON.stringify({ id: responseId, method: 'host.proxy', params: message.params }));
    } else if (pending.has(message.id)) {
      console.log(JSON.stringify({ ...message, id: pending.get(message.id) }));
      pending.delete(message.id);
    }
  });`;

const sidecars: AgentSidecar[] = [];
afterEach(async () => {
  await Promise.all(sidecars.splice(0).map((sidecar) => sidecar.dispose()));
});

it.each([
  "permissions.claimReview",
  "permissions.resolveReview",
  "permissions.setReviewCapability",
  "permissions.consumeLocalPermit",
  "permissions.takeoverReview",
  "permissions.clearSessionGrants",
  "permissions.revokeSessionGrant",
])("rejects forged sidecar %s requests before reaching host-core", async (method) => {
  const sidecar = new AgentSidecar({
    launch: { command: process.execPath, args: ["-e", childSource] },
    onStderr: () => {},
  });
  sidecars.push(sidecar);
  const hostCall = vi.fn(async () => ({ ok: true }));
  const host: SidecarHostLink = {
    call: hostCall,
    onNotification: () => () => {},
    onExit: () => () => {},
  };
  sidecar.setHost(host);

  await expect(sidecar.call("probe", {
    method,
    params: { sessionId: "session-a", requestId: "forged", token: "forged" },
  })).rejects.toMatchObject({ code: -32601 });
  expect(hostCall).not.toHaveBeenCalled();
});
