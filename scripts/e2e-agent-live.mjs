import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DesktopAgentRuntime } from "../packages/agent-runtime/dist/runtime.js";
import { HostClient } from "../packages/agent-runtime/dist/host-client.js";
import { PROTOCOL_VERSION } from "../packages/shared/dist/protocol.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const hostBin = join(root, "target/debug/pi-desktop-host-core");
const dataDir = mkdtempSync(join(tmpdir(), "pi-agent-live-"));
// No defaults on purpose: this script sends a real prompt with a real key, so
// the endpoint and model must be chosen explicitly by whoever runs it.
const REQUIRED_ENV = ["PI_DESKTOP_TEST_API_KEY", "PI_DESKTOP_TEST_BASE_URL", "PI_DESKTOP_TEST_MODEL"];
const missingEnv = REQUIRED_ENV.filter((name) => !process.env[name]?.trim());
if (missingEnv.length > 0) {
  console.error(`missing required environment variables: ${missingEnv.join(", ")}`);
  console.error(
    "Set PI_DESKTOP_TEST_API_KEY (provider API key), PI_DESKTOP_TEST_BASE_URL " +
      "(OpenAI-compatible base URL), and PI_DESKTOP_TEST_MODEL (model id) to run this live test.",
  );
  rmSync(dataDir, { recursive: true, force: true });
  process.exit(1);
}
const API_KEY = process.env.PI_DESKTOP_TEST_API_KEY;
const BASE_URL = process.env.PI_DESKTOP_TEST_BASE_URL;
const MODEL = process.env.PI_DESKTOP_TEST_MODEL;

if (!existsSync(hostBin)) {
  console.error(`missing host bin at ${hostBin}; run 'cargo build -p host-core' first`);
  rmSync(dataDir, { recursive: true, force: true });
  process.exit(1);
}

const host = new HostClient(hostBin, { PI_DESKTOP_DATA_DIR: dataDir });
await host.call("app.handshake", { protocolVersion: PROTOCOL_VERSION });
const provider = await host.call("providers.create", {
  name: "Live",
  baseUrl: BASE_URL,
  defaultModelId: MODEL,
  secretValue: API_KEY,
  type: "openai_compatible",
  protocol: "openai_compatible",
  authKind: "api_key_and_base_url",
});

const events = [];
const runtime = new DesktopAgentRuntime({
  host,
  sessionId: randomUUID(),
  mode: "chat",
  provider: {
    id: provider.provider.id,
    name: "Live",
    baseUrl: BASE_URL,
    modelId: MODEL,
    apiKey: API_KEY,
  },
  onEvent: (e) => {
    events.push(e.event.type);
    if (e.event.type === "message_update" && e.event.deltaText) {
      process.stdout.write(e.event.deltaText);
    }
    if (e.event.type === "message_end" && e.event.message.role === "assistant") {
      process.stdout.write("\n");
      console.log("assistant:", e.event.message.content.slice(0, 200));
    }
    if (e.event.type === "error") {
      console.error("error event", e.event.error);
    }
  },
});

console.log("prompting…");
await runtime.prompt("Reply with exactly: hello-from-pi-desktop");
await runtime.dispose();
await host.dispose();
rmSync(dataDir, { recursive: true, force: true });

const ok = events.includes("message_end") || events.includes("agent_end");
console.log("events:", events.join(" > "));
console.log(ok ? "PASS E2E-agent-live" : "FAIL E2E-agent-live");
process.exit(ok ? 0 : 1);
