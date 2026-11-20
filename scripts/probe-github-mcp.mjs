#!/usr/bin/env node
// Manual compatibility probe for a device-flow token from the fork's OAuth App.
const endpoint = "https://api.githubcopilot.com/mcp/";
const token = process.env.GITHUB_TOKEN;

async function message(response, id) {
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    const json = await response.json();
    if (json.id === id && json.result) return json.result;
    throw new Error("unexpected JSON-RPC response");
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffered = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) throw new Error("MCP stream ended before its response");
      buffered += value;
      for (let separator = /\r?\n\r?\n/.exec(buffered); separator; separator = /\r?\n\r?\n/.exec(buffered)) {
        const event = buffered.slice(0, separator.index);
        buffered = buffered.slice(separator.index + separator[0].length);
        const data = event.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5)).join("\n");
        if (!data) continue;
        const json = JSON.parse(data);
        if (json.id !== id) continue;
        if (!json.result) throw new Error("MCP JSON-RPC error");
        return json.result;
      }
      if (buffered.length > 1_000_000) throw new Error("MCP response is too large");
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

if (!token) {
  console.error("Set GITHUB_TOKEN to the device-flow token for this probe.");
  process.exitCode = 2;
} else {
  let protocolVersion = "2025-03-26";
  let sessionId;
  async function post(method, params, id) {
    const response = await fetch(endpoint, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "X-MCP-Toolsets": "issues,pull_requests",
        "MCP-Protocol-Version": protocolVersion,
        ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", method, params, id }),
    });
    console.log(`HTTP ${response.status}`);
    if (!response.ok) throw new Error("MCP request failed");
    sessionId = response.headers.get("mcp-session-id") ?? sessionId;
    return id === undefined ? undefined : message(response, id);
  }
  try {
    const initialized = await post("initialize", {
      protocolVersion, capabilities: {}, clientInfo: { name: "pi-desktop-github-probe", version: "1.0.0" },
    }, 1);
    protocolVersion = initialized.protocolVersion;
    await post("notifications/initialized");
    const result = await post("tools/list", {}, 2);
    for (const tool of result.tools) {
      if (/^[A-Za-z0-9_.-]+$/.test(tool.name) && !tool.name.includes(token)) console.log(tool.name);
    }
  } catch {
    console.error("GitHub MCP initialization or tool discovery failed.");
    process.exitCode = 1;
  }
}
