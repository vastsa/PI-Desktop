#!/usr/bin/env node
/**
 * MCP market E2E (headless protocol-level).
 * Covers the market install path and the public-network boundary:
 *
 *   E2E-MCP-MARKET-INSTALL        builtin entry → mcp.upsert → record on disk
 *   E2E-MCP-MARKET-SEMANTICS      registry record → template keeps named
 *                                 arguments and required/optional envs
 *   E2E-MCP-MARKET-NET-BOUNDARY   the URL guard rejects loopback/private/
 *                                 mapped/ULA/link-local bypass forms
 *
 * Env: PI_DESKTOP_HOST_BIN (optional), DEBUG_HOST for tracing.
 * Deterministic: no live network access.
 */
import { spawn } from "node:child_process";
import { readNdjsonLines } from "../packages/shared/dist/ndjson.js";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION } from "../packages/shared/dist/protocol.js";
import {
  BUILTIN_MCP_CATALOG,
  GLOBAL_SCOPE,
  isPublicIpLiteral,
  isSafeMarketSourceUrl,
  mapRegistryServer,
  resolveCatalogEntry,
  validateMcpCatalogFile,
} from "../packages/shared/dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const hostBinCandidates = [];
const configuredHostBin = process.env.PI_DESKTOP_HOST_BIN?.trim();
if (configuredHostBin) {
  const configured = resolve(configuredHostBin);
  hostBinCandidates.push(configured);
  if (process.platform === "win32" && !configured.toLowerCase().endsWith(".exe")) {
    hostBinCandidates.push(`${configured}.exe`);
  }
}
const hostBinaryName = `pi-desktop-host-core${process.platform === "win32" ? ".exe" : ""}`;
hostBinCandidates.push(join(root, "target", "debug", hostBinaryName));
hostBinCandidates.push(join(root, "..", "..", "..", "target", "debug", hostBinaryName));
const hostBin = hostBinCandidates.find((candidate) => existsSync(candidate));

if (!hostBin) {
  console.error("host binary missing; tried:", hostBinCandidates.join(", "));
  process.exit(1);
}

const results = [];
function record(id, ok, detail = "") {
  results.push({ id, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${id}${detail ? " — " + detail : ""}`);
}

class Host {
  constructor(bin, dataDir, home) {
    this.child = spawn(bin, [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        HOME: home,
        PI_DESKTOP_DATA_DIR: dataDir,
      },
    });
    this.pending = new Map();
    this.child.stderr.on("data", () => {});
    readNdjsonLines(this.child.stdout, (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.id != null && this.pending.has(String(msg.id))) {
        const pending = this.pending.get(String(msg.id));
        this.pending.delete(String(msg.id));
        if (msg.error) pending.reject(new Error(JSON.stringify(msg.error)));
        else pending.resolve(msg.result);
      }
    });
    this.child.on("exit", (code) => {
      for (const pending of this.pending.values()) {
        pending.reject(new Error(`host exited code=${code}`));
      }
      this.pending.clear();
    });
  }
  call(method, params = {}) {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(String(id), { resolve, reject });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      setTimeout(() => {
        if (this.pending.has(String(id))) {
          this.pending.delete(String(id));
          reject(new Error(`timeout ${method}`));
        }
      }, 30_000);
    });
  }
  dispose() {
    this.child.kill("SIGTERM");
  }
}

// ── E2E-MCP-MARKET-NET-BOUNDARY ──────────────────────────────────────────
{
  const bypass = [
    "https://localhost./x",
    "https://[::1]/x",
    "https://[::ffff:127.0.0.1]/x",
    "https://[fd00::1]/x",
    "https://[fe80::1]/x",
    "https://[fec0::1]/x",
    "https://127.0.0.1/x",
    "https://10.1.2.3/x",
    "https://192.0.0.1/x",
    "https://198.18.0.1/x",
    "https://240.0.0.1/x",
    "https://192.168.1.1/x",
    "https://[2001:2::1]/x",
    "https://user:pass@example.com/x",
    "http://registry.example/x",
  ];
  const accepted = "https://registry.modelcontextprotocol.io/v0/servers";
  const rejectedAll = bypass.every((url) => isSafeMarketSourceUrl(url) === false);
  const publicOk =
    isSafeMarketSourceUrl(accepted) &&
    isSafeMarketSourceUrl("https://[2606:4700::1]/x") &&
    isPublicIpLiteral("2606:4700:4700::1111");
  record(
    "E2E-MCP-MARKET-NET-BOUNDARY",
    rejectedAll && publicOk,
    rejectedAll && publicOk ? "15 bypass forms rejected, public accepted" : "guard misclassification"
  );
}

// ── E2E-MCP-MARKET-SEMANTICS ─────────────────────────────────────────────
{
  const semanticsRecord = {
    server: {
      name: "io.github.example/semantics",
      description: "semantics probe",
      packages: [
        {
          registryType: "npm",
          identifier: "semantics-mcp",
          version: "1.2.3",
          runtimeHint: "npx",
          runtimeArguments: [{ type: "positional", value: "-y" }],
          packageArguments: [
            { type: "named", name: "--port", value: "8080" },
            { type: "named", name: "--verbose" },
          ],
          environmentVariables: [
            { name: "REQUIRED_KEY", description: "needed", isRequired: true },
            { name: "OPT_KEY", isRequired: false, default: "off" },
          ],
        },
      ],
    },
  };
  const entry = mapRegistryServer(semanticsRecord);
  const argsOk =
    JSON.stringify(entry?.args) ===
    JSON.stringify(["-y", "semantics-mcp@1.2.3", "--port", "8080", "--verbose"]);
  const specs = entry?.requiredEnv ?? [];
  const envOk =
    specs.find((s) => s.name === "REQUIRED_KEY") &&
    !specs.find((s) => s.name === "REQUIRED_KEY")?.optional &&
    specs.find((s) => s.name === "OPT_KEY")?.optional === true &&
    specs.find((s) => s.name === "OPT_KEY")?.defaultValue === "off";
  record("E2E-MCP-MARKET-SEMANTICS", !!entry && argsOk && envOk, JSON.stringify({ args: entry?.args, env: specs }));
}

// ── E2E-MCP-MARKET-INSTALL ───────────────────────────────────────────────
const home = mkdtempSync(join(tmpdir(), "pi-desktop-mcp-e2e-"));
const dataDir = mkdtempSync(join(tmpdir(), "pi-desktop-mcp-e2e-data-"));
let host = null;
try {
  const { catalog, warnings } = validateMcpCatalogFile(BUILTIN_MCP_CATALOG);
  const catalogOk = warnings.length === 0 && catalog.servers.length >= 8;
  if (!catalogOk) {
    record("E2E-MCP-MARKET-INSTALL", false, `builtin catalog invalid: ${warnings.join("; ")}`);
  } else {
    host = new Host(hostBin, dataDir, home);
    await host.call("app.handshake", { protocolVersion: PROTOCOL_VERSION });

    const entry = catalog.servers.find((server) => server.id === "memory");
    const input = resolveCatalogEntry(entry);
    await host.call("mcp.upsert", { server: { ...input, level: "global", scope: GLOBAL_SCOPE } });
    const listed = await host.call("mcp.list", { level: "global" });
    const row = (listed.servers ?? []).find((server) => server.id === "memory");

    const recordPath = join(home, ".agents", "servers", "memory.json");
    const onDisk = existsSync(recordPath)
      ? JSON.parse(readFileSync(recordPath, "utf8"))
      : null;
    const diskOk =
      onDisk?.command === "npx" &&
      JSON.stringify(onDisk?.args) === JSON.stringify(["-y", "@modelcontextprotocol/server-memory"]);
    record(
      "E2E-MCP-MARKET-INSTALL",
      !!row && row.enabled === true && diskOk,
      row ? JSON.stringify({ command: row.command, args: row.args, enabled: row.enabled }) : "not listed",
    );
  }
} catch (error) {
  record("E2E-MCP-MARKET-INSTALL", false, error.message);
} finally {
  host?.dispose();
  setTimeout(() => rmSync(home, { recursive: true, force: true }), 200);
  rmSync(dataDir, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.ok);
console.log(`\nSummary: ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
