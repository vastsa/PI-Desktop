/**
 * PI-Desktop subagent registry e2e (headless protocol-level, D202).
 * Drives the real host-core binary over its NDJSON RPC pipe against a throwaway
 * data dir and temporary HOME, then feeds the global documents it wrote through
 * the real loader. This script is intentionally not run by local validation.
 *
 * Env:
 *  PI_DESKTOP_HOST_BIN (optional)
 */
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { PROTOCOL_VERSION } from "../packages/shared/dist/protocol.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const hostBinaryName = `pi-desktop-host-core${process.platform === "win32" ? ".exe" : ""}`;
const hostBinCandidates = [];
const configuredHostBin = process.env.PI_DESKTOP_HOST_BIN?.trim();
if (configuredHostBin) {
  const configured = resolve(configuredHostBin);
  hostBinCandidates.push(configured);
  if (process.platform === "win32" && !configured.toLowerCase().endsWith(".exe")) {
    hostBinCandidates.push(`${configured}.exe`);
  }
}
hostBinCandidates.push(join(root, "target", "debug", hostBinaryName));
const hostBin = hostBinCandidates.find((candidate) => existsSync(candidate));
if (!hostBin) {
  console.error("host binary missing; tried:", hostBinCandidates.join(", "));
  process.exit(1);
}

const dataDir = mkdtempSync(join(tmpdir(), "pi-subagent-data-"));
const homeDir = mkdtempSync(join(tmpdir(), "pi-subagent-home-"));
const projectA = mkdtempSync(join(tmpdir(), "pi-project-a-"));
const projectB = mkdtempSync(join(tmpdir(), "pi-project-b-"));
const agentsDir = join(homeDir, ".agents", "subagents");
const previousHome = process.env.HOME;
const previousUserProfile = process.env.USERPROFILE;
// host-core's dirs::home_dir and the runtime's homedir() must resolve to the
// throwaway home, otherwise this protocol test could touch the real account.
process.env.HOME = homeDir;
process.env.USERPROFILE = homeDir;

const host = spawn(hostBin, [], {
  env: {
    ...process.env,
    HOME: homeDir,
    USERPROFILE: homeDir,
    PI_DESKTOP_DATA_DIR: dataDir,
    RUST_LOG: "error",
  },
  stdio: ["pipe", "pipe", "pipe"],
});
host.stderr.on("data", (chunk) => {
  const text = String(chunk).trim();
  if (text) console.error("[host]", text);
});

let seq = 0;
const pending = new Map();
let buffer = "";
host.stdout.on("data", (chunk) => {
  buffer += String(chunk);
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.id != null && pending.has(message.id)) {
      const { resolve: settle } = pending.get(message.id);
      pending.delete(message.id);
      settle(message);
    }
  }
});
host.on("exit", (code, signal) => {
  for (const [id, { reject }] of pending) {
    pending.delete(id);
    reject(new Error(`host exited code=${code} signal=${signal}`));
  }
});

const call = (method, params = {}) =>
  new Promise((settle, reject) => {
    const id = ++seq;
    pending.set(id, { resolve: settle, reject });
    host.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`timeout: ${method}`));
      }
    }, 30_000);
  });

const results = [];
const check = (label, ok, detail = "") => {
  results.push({ label, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

try {
  const hello = await call("app.handshake", { protocolVersion: PROTOCOL_VERSION });
  check(
    "handshake accepted",
    hello.result?.protocolVersion === PROTOCOL_VERSION,
    `host ${hello.result?.version}`,
  );

  const created = await call("agents.create", {
    name: "Log Reader",
    description: "Read build logs and report the first real failure.",
    tools: ["Read", "Grep", "Bash"],
    body: "You are log-reader. Read the log and report the first real failure.\n",
  });
  const record = created.result?.subagent;
  check("agents.create returns a record", !!record, JSON.stringify(record?.id));
  check(
    "the name is slugified into the Task handle",
    record?.id === "log-reader" && record?.name === "log-reader",
    `id=${record?.id} name=${record?.name}`,
  );
  check(
    "the tool grant round-trips",
    JSON.stringify(record?.tools) === JSON.stringify(["Read", "Grep", "Bash"]),
    JSON.stringify(record?.tools),
  );

  const entries = readdirSync(agentsDir).sort();
  check(
    "the global registry writes ~/.agents/subagents/<id>.md",
    entries.includes("log-reader.md") && !entries.includes("registry.json"),
    entries.join(", "),
  );
  const document = readFileSync(join(agentsDir, "log-reader.md"), "utf8");
  check(
    "the document carries the frontmatter the loader reads",
    /^---\n/.test(document) &&
      /name: log-reader/.test(document) &&
      /tools: \[Read, Grep, Bash\]/.test(document),
    JSON.stringify(document.split("\n").slice(0, 6).join(" | ")),
  );

  const dup = await call("agents.create", {
    name: "log-reader",
    description: "A second one.",
    body: "Body.\n",
  });
  check(
    "a duplicate name is refused with SUBAGENT_INVALID",
    dup.error?.data?.errorCode === "SUBAGENT_INVALID",
    `${dup.error?.code}/${dup.error?.data?.errorCode}: ${dup.error?.message}`,
  );

  const activeA = await call("agents.active", { projectPath: projectA });
  const activeB = await call("agents.active", { projectPath: projectB });
  check(
    "one global definition is active in every project",
    activeA.result?.subagents?.length === 1 && activeB.result?.subagents?.length === 1,
    `A=${activeA.result?.subagents?.length} B=${activeB.result?.subagents?.length}`,
  );

  await call("agents.setEnabled", { id: "log-reader", enabled: false });
  const off = await call("agents.active", { projectPath: projectA });
  check(
    "a disabled global definition is not active anywhere",
    off.result?.subagents?.length === 0,
    `${off.result?.subagents?.length} active`,
  );
  await call("agents.setEnabled", { id: "log-reader", enabled: true });

  const read = await call("agents.read", { id: "log-reader" });
  check(
    "read returns the body for the editor",
    /report the first real failure/.test(read.result?.body ?? ""),
    JSON.stringify((read.result?.body ?? "").slice(0, 40)),
  );

  // The registry allows 64 user documents; the runtime catalog remains capped
  // separately at 16 definitions when it builds the model-facing menu.
  let capError = null;
  for (let i = 0; i < 64; i += 1) {
    const extra = await call("agents.create", {
      name: `filler-${i}`,
      description: "Filler.",
      body: "Body.\n",
    });
    if (extra.error) {
      capError = { at: i, error: extra.error };
      break;
    }
  }
  const full = await call("agents.list");
  check(
    "the global registry caps at 64 documents",
    full.result?.subagents?.length === 64 && capError?.at === 63,
    `${full.result?.subagents?.length} stored, refused on filler ${capError?.at}: ${capError?.error?.message}`,
  );

  for (let i = 0; i < 63; i += 1) await call("agents.remove", { id: `filler-${i}` });
  const trimmed = await call("agents.list");
  check(
    "remove deletes the record and its document",
    trimmed.result?.subagents?.length === 1 && !readdirSync(agentsDir).includes("filler-0.md"),
    readdirSync(agentsDir).join(", "),
  );

  const { loadSubagentDefinitions } = await import(
    join(root, "packages", "agent-runtime", "dist", "index.js")
  );
  const readActive = async (projectPath) => {
    const active = await call("agents.active", { projectPath });
    return active.result.subagents.map((entry) => ({
      id: entry.id,
      document: readFileSync(entry.path, "utf8"),
      filePath: entry.path,
    }));
  };
  const userDocuments = await readActive(projectA);
  const merged = await loadSubagentDefinitions(projectA, { userDocuments });
  const byName = new Map(merged.definitions.map((definition) => [definition.name, definition]));
  check(
    "the global registry document reaches the loader as a user definition",
    byName.get("log-reader")?.source === "user",
    `source=${byName.get("log-reader")?.source}`,
  );
  check(
    "the four builtins remain available beside it",
    ["explorer", "code-reviewer", "test-runner", "fixer"].every(
      (name) => byName.get(name)?.source === "builtin",
    ),
    [...byName.keys()].join(", "),
  );
  check(
    "the declared tools survive the round trip to the loader",
    JSON.stringify(byName.get("log-reader")?.tools) ===
      JSON.stringify(["Read", "Grep", "Bash"]),
    JSON.stringify(byName.get("log-reader")?.tools),
  );

  await call("agents.create", {
    name: "explorer",
    description: "My own explorer.",
    tools: ["Read", "Glob"],
    body: "You are my explorer.\n",
  });
  const merged2 = await loadSubagentDefinitions(projectB, {
    userDocuments: await readActive(projectB),
  });
  const explorer = merged2.definitions.find((definition) => definition.name === "explorer");
  check(
    "a global user copy of a builtin outranks the builtin",
    explorer?.source === "user" && explorer?.description === "My own explorer.",
    `source=${explorer?.source}`,
  );
  check(
    "the loader reports no diagnostics for well-formed documents",
    merged2.diagnostics.length === 0,
    merged2.diagnostics.join(" / "),
  );

  const broken = await loadSubagentDefinitions(null, {
    userDocuments: [{ id: "broken", document: "no frontmatter at all\n" }],
  });
  check(
    "a malformed user document becomes a diagnostic without losing builtins",
    broken.diagnostics.length === 1 && broken.definitions.length === 4,
    `${broken.diagnostics.length} diagnostic(s), ${broken.definitions.length} definitions: ${broken.diagnostics[0]}`,
  );
} catch (error) {
  check("the run completed", false, String(error));
} finally {
  host.stdin.end();
  host.kill();
  for (const dir of [dataDir, homeDir, projectA, projectB]) {
    rmSync(dir, { recursive: true, force: true });
  }
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = previousUserProfile;
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
