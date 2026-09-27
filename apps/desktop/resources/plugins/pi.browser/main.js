/**
 * Browser — bundled first-party plugin (ADR 0170).
 *
 * The view is chrome only. The guest page and debugger stay host-owned and are
 * reached through the public `pi.browser.*` API gated by `browser.cdp`.
 */

const ACTIONS = [
  "navigate",
  "snapshot",
  "screenshot",
  "click",
  "fill",
  "evaluate",
  "console",
  "cdp",
];

export async function onLoad() {
  await pi.agent.registerTool({
    name: "Browser",
    description:
      "Drive PI-Desktop's work-panel browser via CDP: snapshot the accessibility tree, click/fill by uid, screenshot, evaluate JavaScript, read console output, or send an allowlisted raw CDP method. Call ToolSearch for \"browser\" or \"cdp\" to load this tool. Use BrowserPreview to open a workspace HTML file with live reload.",
    risk: "medium",
    schema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ACTIONS,
          description: "Operation to run against the visible work-panel guest.",
        },
        url: { type: "string", description: "http(s) URL for action=navigate." },
        path: {
          type: "string",
          description: "Workspace-relative HTML file for action=navigate.",
        },
        uid: {
          type: "string",
          description: "Snapshot uid (e1, e2, …) for click/fill.",
        },
        text: { type: "string", description: "Text to type for action=fill." },
        expression: {
          type: "string",
          description: "JavaScript for action=evaluate.",
        },
        method: { type: "string", description: "Allowlisted CDP method for action=cdp." },
        params: {
          type: "object",
          description: "CDP parameters for action=cdp.",
        },
        fullPage: {
          type: "boolean",
          description: "Capture the full page for action=screenshot.",
        },
        limit: {
          type: "number",
          description: "Max console messages for action=console.",
        },
      },
      required: ["action"],
    },
    execute: async (args) => {
      const action = String(args?.action ?? "").trim();
      switch (action) {
        case "navigate": {
          const state = await pi.browser.navigate({
            url: args?.url ? String(args.url) : undefined,
            path: args?.path ? String(args.path) : undefined,
          });
          return { ok: true, action, state };
        }
        case "snapshot":
          return { ok: true, action, ...(await pi.browser.snapshot()) };
        case "screenshot": {
          const shot = await pi.browser.screenshot({
            fullPage: args?.fullPage === true,
          });
          return {
            ok: true,
            action,
            text: shot.path
              ? `Captured screenshot (${shot.mimeType}) saved at ${shot.path}.`
              : `Captured screenshot (${shot.mimeType}).`,
            path: shot.path,
            mimeType: shot.mimeType,
            images: [{ mimeType: shot.mimeType, data: shot.data }],
          };
        }
        case "click":
          await pi.browser.click({ uid: String(args?.uid ?? "") });
          return { ok: true, action, uid: args?.uid };
        case "fill":
          await pi.browser.fill({
            uid: String(args?.uid ?? ""),
            text: String(args?.text ?? ""),
          });
          return { ok: true, action, uid: args?.uid };
        case "evaluate":
          return {
            ok: true,
            action,
            result: await pi.browser.evaluate({
              expression: String(args?.expression ?? ""),
            }),
          };
        case "console":
          return {
            ok: true,
            action,
            ...(await pi.browser.console({
              limit: typeof args?.limit === "number" ? args.limit : undefined,
            })),
          };
        case "cdp":
          return {
            ok: true,
            action,
            result: await pi.browser.cdp({
              method: String(args?.method ?? ""),
              params: args?.params,
            }),
          };
        default:
          return {
            ok: false,
            error: `unknown action "${action}"; use ${ACTIONS.join(", ")}`,
          };
      }
    },
  });
}

export async function onUnload() {
  await pi.agent.unregisterTool("Browser");
}
