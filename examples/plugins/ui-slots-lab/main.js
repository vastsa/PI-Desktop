/**
 * UI Slots Lab — headless entry (`lab.ui-slots`).
 *
 * Owns what the renderer samples need from the plugin process: the
 * `lab_probe` agent tool (a `toolCard` only draws the plugin's own tools) and
 * the `plugin.call` methods the renderer lists in `rendererCallMethods`.
 */

const TOOL = "lab_probe";
const SLOW_MS = 1_500;
/** Past the host's 2s `plugin.call` budget, so a stall ends as a timeout. */
const STALL_MS = 5_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function onLoad() {
  await pi.agent.registerTool({
    name: TOOL,
    description:
      "UI Slots Lab probe. mode: ok (default) answers at once, slow after 1.5s, fail throws, crash answers but its card throws",
    risk: "low",
    schema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["ok", "slow", "fail", "crash"] },
        text: { type: "string" },
      },
    },
    execute: async (args) => {
      const mode = String(args?.mode ?? "ok");
      const text = String(args?.text ?? "");
      if (mode === "slow") await sleep(SLOW_MS);
      if (mode === "fail") throw new Error(`lab_probe failed on request: ${text}`);
      return { ok: true, mode, text, length: text.length };
    },
  });
}

async function onUnload() {
  await pi.agent.unregisterTool(TOOL);
}

/** The `plugin.call` target. Thrown codes reach the renderer unchanged. */
async function onRendererCall(method, args) {
  switch (method) {
    case "lab.echo":
      return { echo: args ?? null };
    case "lab.refuse":
      throw Object.assign(new Error("the lab refuses on request"), { code: "LAB_REFUSED" });
    case "lab.stall":
      await sleep(STALL_MS);
      return { late: true };
    default:
      throw Object.assign(new Error(`unknown lab method: ${method}`), { code: "LAB_UNKNOWN_METHOD" });
  }
}

module.exports = {
  onLoad,
  onUnload,
  onRendererCall,
};
