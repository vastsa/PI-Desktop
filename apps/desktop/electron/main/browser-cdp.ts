import type { WebContents } from "electron";

/** Chrome DevTools Protocol revision attached to the work-panel guest. */
export const BROWSER_CDP_PROTOCOL = "1.3";

/**
 * Deny-by-default CDP methods the public `pi.browser.cdp` API may send.
 * Cookie, storage, target, and network-interception methods stay off this list.
 */
export const BROWSER_CDP_ALLOWLIST = new Set([
  "Page.enable",
  "Page.reload",
  "Page.captureScreenshot",
  "Page.getLayoutMetrics",
  "Page.bringToFront",
  "DOM.enable",
  "DOM.getDocument",
  "DOM.querySelector",
  "DOM.querySelectorAll",
  "DOM.getBoxModel",
  "DOM.describeNode",
  "DOM.scrollIntoViewIfNeeded",
  "DOM.getOuterHTML",
  "DOM.getAttributes",
  "Runtime.enable",
  "Runtime.evaluate",
  "Runtime.callFunctionOn",
  "Runtime.getProperties",
  "Runtime.awaitPromise",
  "Input.dispatchMouseEvent",
  "Input.dispatchKeyEvent",
  "Input.insertText",
  "Accessibility.enable",
  "Accessibility.getFullAXTree",
  "Accessibility.getPartialAXTree",
  "Console.enable",
]);

const MAX_EVALUATE_CHARS = 64 * 1024;
const MAX_CONSOLE_MESSAGES = 100;
const SCREENSHOT_MAX_WIDTH = 1280;

export type BrowserConsoleMessage = {
  type: string;
  text: string;
  timestamp: number;
};

export type AxNode = {
  nodeId?: string;
  ignored?: boolean;
  role?: { value?: string };
  name?: { value?: string };
  backendDOMNodeId?: number;
  childIds?: string[];
};

export type SnapshotResult = {
  tree: string;
  url: string;
  title: string;
};

export function isAllowedCdpMethod(method: string): boolean {
  return BROWSER_CDP_ALLOWLIST.has(method.trim());
}

/**
 * Flatten an accessibility tree into indented text with stable `eN` uids.
 * Ignored nodes are skipped; uids map to backend DOM node ids for click/fill.
 */
export function flattenAxTree(nodes: AxNode[]): {
  tree: string;
  uids: Map<string, number>;
} {
  const byId = new Map<string, AxNode>();
  for (const node of nodes) {
    if (typeof node.nodeId === "string") byId.set(node.nodeId, node);
  }
  const childIds = new Set<string>();
  for (const node of nodes) {
    for (const id of node.childIds ?? []) childIds.add(id);
  }
  const roots = nodes.filter(
    (node) => typeof node.nodeId === "string" && !childIds.has(node.nodeId),
  );
  const uids = new Map<string, number>();
  const lines: string[] = [];
  let next = 1;

  const walk = (node: AxNode, depth: number) => {
    if (!node.ignored) {
      const role = node.role?.value?.trim() || "Generic";
      const name = node.name?.value?.trim() ?? "";
      const uid = `e${next}`;
      next += 1;
      if (typeof node.backendDOMNodeId === "number") {
        uids.set(uid, node.backendDOMNodeId);
      }
      const label = name ? `${role} ${JSON.stringify(name)}` : role;
      lines.push(`${"  ".repeat(depth)}- ${uid} ${label}`);
    }
    for (const childId of node.childIds ?? []) {
      const child = byId.get(childId);
      if (child) walk(child, node.ignored ? depth : depth + 1);
    }
  };
  for (const root of roots) walk(root, 0);
  return { tree: lines.join("\n") || "(empty)", uids };
}

function consoleText(args: unknown): string {
  if (!Array.isArray(args)) return String(args ?? "");
  return args
    .map((arg) => {
      if (!arg || typeof arg !== "object") return String(arg);
      const record = arg as { value?: unknown; description?: string; type?: string };
      if (typeof record.value === "string") return record.value;
      if (record.value !== undefined) return String(record.value);
      if (typeof record.description === "string") return record.description;
      return record.type ?? "";
    })
    .filter(Boolean)
    .join(" ");
}

/**
 * CDP session bound to one guest WebContents. Re-attaches when the view is
 * recreated. Snapshot uids are valid only until the next snapshot.
 */
export class BrowserCdp {
  private attachedId: number | null = null;
  private uids = new Map<string, number>();
  private messages: BrowserConsoleMessage[] = [];
  private onDebuggerMessage?: (
    event: unknown,
    method: string,
    params: unknown,
  ) => void;

  isAttached(wc: WebContents): boolean {
    return this.attachedId === wc.id && !wc.isDestroyed() && wc.debugger.isAttached();
  }

  async attach(wc: WebContents): Promise<void> {
    if (wc.isDestroyed()) {
      throw new Error("browser guest is not available");
    }
    if (this.isAttached(wc)) return;
    this.detach();
    if (!wc.debugger.isAttached()) {
      wc.debugger.attach(BROWSER_CDP_PROTOCOL);
    }
    this.attachedId = wc.id;
    this.onDebuggerMessage = (_event, method, params) => {
      if (method !== "Runtime.consoleAPICalled" && method !== "Console.messageAdded") {
        return;
      }
      const record = params && typeof params === "object" ? (params as Record<string, unknown>) : {};
      const type =
        typeof record.type === "string"
          ? record.type
          : typeof (record.message as { level?: string } | undefined)?.level === "string"
            ? (record.message as { level: string }).level
            : "log";
      const text =
        method === "Console.messageAdded"
          ? String((record.message as { text?: string } | undefined)?.text ?? "")
          : consoleText(record.args);
      this.messages.push({ type, text, timestamp: Date.now() });
      if (this.messages.length > MAX_CONSOLE_MESSAGES) this.messages.shift();
    };
    wc.debugger.on("message", this.onDebuggerMessage);
    await wc.debugger.sendCommand("Runtime.enable");
    await wc.debugger.sendCommand("Console.enable");
    await wc.debugger.sendCommand("Page.enable");
    await wc.debugger.sendCommand("DOM.enable");
    await wc.debugger.sendCommand("Accessibility.enable");
  }

  detach(wc?: WebContents): void {
    const target = wc && !wc.isDestroyed() ? wc : null;
    if (target?.debugger.isAttached()) {
      if (this.onDebuggerMessage) {
        target.debugger.off("message", this.onDebuggerMessage);
      }
      try {
        target.debugger.detach();
      } catch {
        // Already detached.
      }
    }
    this.onDebuggerMessage = undefined;
    this.attachedId = null;
    this.uids.clear();
  }

  async send(wc: WebContents, method: string, params?: unknown): Promise<unknown> {
    if (!isAllowedCdpMethod(method)) {
      throw Object.assign(new Error(`CDP method not allowed: ${method}`), {
        code: "PERMISSION_DENIED",
      });
    }
    await this.attach(wc);
    return wc.debugger.sendCommand(
      method,
      (params && typeof params === "object" ? params : {}) as Record<string, unknown>,
    );
  }

  async snapshot(wc: WebContents): Promise<SnapshotResult> {
    await this.attach(wc);
    const raw = (await wc.debugger.sendCommand("Accessibility.getFullAXTree")) as {
      nodes?: AxNode[];
    };
    const flattened = flattenAxTree(Array.isArray(raw?.nodes) ? raw.nodes : []);
    this.uids = flattened.uids;
    return {
      tree: flattened.tree,
      url: wc.getURL(),
      title: wc.getTitle(),
    };
  }

  async screenshot(
    wc: WebContents,
    input: { fullPage?: boolean } = {},
  ): Promise<{ mimeType: string; data: string }> {
    await this.attach(wc);
    let clip: { x: number; y: number; width: number; height: number; scale: number } | undefined;
    if (input.fullPage) {
      const metrics = (await wc.debugger.sendCommand("Page.getLayoutMetrics")) as {
        contentSize?: { width?: number; height?: number };
        cssContentSize?: { width?: number; height?: number };
      };
      const size = metrics.cssContentSize ?? metrics.contentSize ?? { width: 0, height: 0 };
      const width = Math.max(1, Number(size.width) || 1);
      const height = Math.max(1, Number(size.height) || 1);
      const scale = width > SCREENSHOT_MAX_WIDTH ? SCREENSHOT_MAX_WIDTH / width : 1;
      clip = { x: 0, y: 0, width, height, scale };
    }
    const result = (await wc.debugger.sendCommand("Page.captureScreenshot", {
      format: "jpeg",
      quality: 70,
      ...(clip ? { clip, captureBeyondViewport: true } : {}),
    })) as { data?: string };
    if (typeof result?.data !== "string" || !result.data) {
      throw new Error("screenshot produced no data");
    }
    return { mimeType: "image/jpeg", data: result.data };
  }

  async click(wc: WebContents, uid: string): Promise<void> {
    const backendNodeId = this.requireUid(uid);
    await this.attach(wc);
    await wc.debugger.sendCommand("DOM.scrollIntoViewIfNeeded", { backendNodeId });
    const model = (await wc.debugger.sendCommand("DOM.getBoxModel", { backendNodeId })) as {
      model?: { content?: number[] };
    };
    const quad = model.model?.content;
    if (!Array.isArray(quad) || quad.length < 8) {
      throw Object.assign(new Error(`no box model for ${uid}`), { code: "NOT_FOUND" });
    }
    const x = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
    const y = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
    await wc.debugger.sendCommand("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
    await wc.debugger.sendCommand("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
  }

  async fill(wc: WebContents, uid: string, text: string): Promise<void> {
    const backendNodeId = this.requireUid(uid);
    await this.attach(wc);
    const resolved = (await wc.debugger.sendCommand("DOM.resolveNode", { backendNodeId })) as {
      object?: { objectId?: string };
    };
    const objectId = resolved.object?.objectId;
    if (!objectId) {
      throw Object.assign(new Error(`could not resolve ${uid}`), { code: "NOT_FOUND" });
    }
    await wc.debugger.sendCommand("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function (value) {
        this.focus();
        if ("value" in this) {
          this.value = value;
          this.dispatchEvent(new Event("input", { bubbles: true }));
          this.dispatchEvent(new Event("change", { bubbles: true }));
          return;
        }
        this.textContent = value;
        this.dispatchEvent(new Event("input", { bubbles: true }));
      }`,
      arguments: [{ value: text }],
    });
  }

  async evaluate(wc: WebContents, expression: string): Promise<unknown> {
    await this.attach(wc);
    const result = (await wc.debugger.sendCommand("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })) as {
      result?: { value?: unknown; description?: string; type?: string };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    };
    if (result.exceptionDetails) {
      const message =
        result.exceptionDetails.exception?.description ||
        result.exceptionDetails.text ||
        "evaluation failed";
      throw Object.assign(new Error(message), { code: "TOOL_FAILED" });
    }
    const value = result.result?.value ?? result.result?.description ?? null;
    const serialized = JSON.stringify(value);
    if (serialized && serialized.length > MAX_EVALUATE_CHARS) {
      return {
        truncated: true,
        value: serialized.slice(0, MAX_EVALUATE_CHARS),
      };
    }
    return value;
  }

  console(limit = 50): BrowserConsoleMessage[] {
    const cap = Math.min(MAX_CONSOLE_MESSAGES, Math.max(1, Math.floor(limit) || 50));
    return this.messages.slice(-cap);
  }

  private requireUid(uid: string): number {
    const id = this.uids.get(uid.trim());
    if (typeof id !== "number") {
      throw Object.assign(
        new Error(`unknown or stale uid "${uid}"; call snapshot first`),
        { code: "INVALID_ARGUMENT" },
      );
    }
    return id;
  }
}
