#!/usr/bin/env node
/**
 * Capability level-move E2E (headless protocol-level).
 * Covers moving one MCP server or skill between the global `.agents` directory
 * and a project's, over the same RPC surface Electron main drives:
 *
 *   E2E-CAPABILITY-move-across-levels
 *     the document leaves the source directory and arrives in the destination
 *     one, the enabled value follows it, the source keeps no orphaned state, a
 *     destination collision renames the arrival instead of overwriting or
 *     blocking, a skill's id is read back from the scan (it can come from the
 *     frontmatter name rather than the file name), a directory-shaped skill
 *     carries its resources, and the request guards reject an absent level or an
 *     absent project path.
 *
 * The GUI half of the documented scenario — the Settings row menu, the toast —
 * stays manual; this script is the half a headless run can prove.
 *
 * Env: PI_DESKTOP_HOST_BIN (optional), DEBUG_HOST for tracing.
 * Deterministic: no live network access.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION } from "../packages/shared/dist/protocol.js";

const SCENARIO = "E2E-CAPABILITY-move-across-levels";
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
function record(label, ok, detail = "") {
  results.push({ label, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${SCENARIO} · ${label}${detail ? " — " + detail : ""}`);
}

class Host {
  constructor(bin, dataDir, home) {
    this.child = spawn(bin, [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        HOME: home,
        PI_DESKTOP_DATA_DIR: dataDir,
        // Narrower than HOME: only the global capability root reads it, so the
        // fixture cannot leak into anything else the host resolves from home.
        PI_DESKTOP_AGENTS_DIR: join(home, ".agents"),
      },
    });
    this.pending = new Map();
    this.child.stderr.on("data", () => {});
    const rl = createInterface({ input: this.child.stdout });
    rl.on("line", (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.id != null && this.pending.has(String(msg.id))) {
        const pending = this.pending.get(String(msg.id));
        this.pending.delete(String(msg.id));
        if (msg.error) pending.reject(new Error(`${msg.error.code} ${msg.error.message}`));
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

const home = mkdtempSync(join(tmpdir(), "pi-capability-move-home-"));
const dataDir = mkdtempSync(join(tmpdir(), "pi-capability-move-data-"));
const projectA = mkdtempSync(join(tmpdir(), "pi-capability-move-a-"));
const projectB = mkdtempSync(join(tmpdir(), "pi-capability-move-b-"));
mkdirSync(join(home, ".agents"), { recursive: true });

const serverPath = (levelRoot, id) => join(levelRoot, ".agents", "servers", `${id}.json`);
const skillsDir = (levelRoot) => join(levelRoot, ".agents", "skills");

let host;
try {
  host = new Host(hostBin, dataDir, home);
  const handshake = await host.call("app.handshake", {
    protocolVersion: PROTOCOL_VERSION,
    client: "electron-main",
    clientVersion: "e2e",
    locale: "en",
  });
  if (handshake.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error(`handshake mismatch: ${JSON.stringify(handshake)}`);
  }

  // ── MCP: global → project, with the per-project disabled value travelling ──
  await host.call("mcp.upsert", {
    server: {
      id: "echo",
      label: "Echo",
      transport: "stdio",
      command: "npx",
      args: ["-y", "echo-mcp"],
    },
  });
  await host.call("mcp.setEnabled", {
    id: "echo",
    enabled: false,
    level: "global",
    projectPath: projectA,
  });
  const globalBefore = await host.call("mcp.list", { level: "global", projectPath: projectA });
  record(
    "mcp-override-is-per-project",
    globalBefore.servers.length === 1 &&
      globalBefore.servers[0].level === "global" &&
      globalBefore.servers[0].enabled === false,
    JSON.stringify(globalBefore.servers),
  );

  const movedServer = await host.call("mcp.transfer", {
    id: "echo",
    from: { level: "global", projectPath: projectA },
    to: { level: "project", projectPath: projectA },
  });
  record(
    "mcp-move-reports-its-own-owner-and-state",
    movedServer.server?.level === "project" &&
      movedServer.server?.projectPath === projectA &&
      movedServer.server?.id === "echo" &&
      movedServer.server?.enabled === false,
    JSON.stringify(movedServer.server),
  );
  record(
    "mcp-document-left-one-level-and-arrived-in-the-other",
    !existsSync(serverPath(home, "echo")) && existsSync(serverPath(projectA, "echo")),
    `global=${existsSync(serverPath(home, "echo"))} project=${existsSync(serverPath(projectA, "echo"))}`,
  );
  const [globalAfter, projectAfter] = await Promise.all([
    host.call("mcp.list", { level: "global" }),
    host.call("mcp.list", { level: "project", projectPath: projectA }),
  ]);
  record(
    "mcp-source-level-stops-listing-it",
    globalAfter.servers.length === 0 && projectAfter.servers.length === 1,
    `global=${globalAfter.servers.length} project=${projectAfter.servers.length}`,
  );
  const state = JSON.parse(readFileSync(join(dataDir, "agent-capabilities", "mcp.json"), "utf8"));
  const globalKeys = Object.keys(state.values ?? {}).filter((key) =>
    key.includes('"level":"global"'),
  );
  record(
    "mcp-move-leaves-no-orphaned-source-state",
    globalKeys.length === 0,
    globalKeys.join(", ") || "no global entries",
  );

  // ── MCP: a case-differing id is a collision, not an overwrite ─────────────
  // macOS and Windows return one file for `MyServer.json` and `myserver.json`.
  await host.call("mcp.upsert", {
    server: {
      id: "MyServer",
      label: "Shared",
      transport: "stdio",
      command: "npx",
      level: "project",
      projectPath: projectB,
    },
  });
  await host.call("mcp.upsert", {
    server: { id: "myserver", label: "Shared", transport: "stdio", command: "npx" },
  });
  const renamed = await host.call("mcp.transfer", {
    id: "myserver",
    from: { level: "global" },
    to: { level: "project", projectPath: projectB },
  });
  const survivor = JSON.parse(readFileSync(serverPath(projectB, "MyServer"), "utf8"));
  record(
    "mcp-case-differing-id-renames-instead-of-overwriting",
    renamed.server?.id === "myserver-2" &&
      renamed.server?.label === "Shared (2)" &&
      survivor.id === "MyServer" &&
      survivor.label === "Shared",
    JSON.stringify({ arrived: renamed.server?.id, survivor: survivor.id }),
  );

  // ── Skill: the scan, not the file name, decides the id ────────────────────
  // A Chinese name slugs to nothing, so the id falls back to the path stem, and
  // a same-named document at the other level collides with it. Planning the move
  // against the file stem alone would delete the source and then fail to find
  // the arrival, and a colliding id would let the scan hide one of the two.
  mkdirSync(join(skillsDir(home), "code-review"), { recursive: true });
  writeFileSync(
    join(skillsDir(home), "code-review", "SKILL.md"),
    "---\nname: 代码审查\n---\n\nGlobal copy.\n",
  );
  writeFileSync(join(skillsDir(home), "code-review", "scripts.sh"), "#!/bin/sh\necho hi\n");
  mkdirSync(join(skillsDir(projectA), "code-review"), { recursive: true });
  writeFileSync(
    join(skillsDir(projectA), "code-review", "SKILL.md"),
    "---\nname: 代码审查\n---\n\nProject copy.\n",
  );
  const globalSkills = await host.call("skills.list", { level: "global" });
  record(
    "skill-without-an-ascii-name-is-catalogued-under-its-path-stem",
    globalSkills.skills.length === 1 &&
      globalSkills.skills[0].id === "code-review" &&
      globalSkills.skills[0].name === "代码审查",
    JSON.stringify(globalSkills.skills),
  );

  const movedSkill = await host.call("skills.transfer", {
    id: "code-review",
    from: { level: "global" },
    to: { level: "project", projectPath: projectA },
  });
  record(
    "skill-move-succeeds-instead-of-erroring-after-deleting-the-source",
    movedSkill.skill?.level === "project" && movedSkill.skill?.projectPath === projectA,
    JSON.stringify(movedSkill.skill),
  );
  const bothSkills = await host.call("skills.list", { level: "project", projectPath: projectA });
  const ids = new Set(bothSkills.skills.map((row) => row.id.toLowerCase()));
  const names = new Set(bothSkills.skills.map((row) => row.name.toLowerCase()));
  record(
    "both-skills-stay-visible-under-distinct-ids-and-names",
    bothSkills.skills.length === 2 && ids.size === 2 && names.size === 2,
    JSON.stringify(bothSkills.skills.map((row) => `${row.id}:${row.name}`)),
  );
  const travelled = readdirSync(skillsDir(projectA)).filter((name) =>
    existsSync(join(skillsDir(projectA), name, "scripts.sh")),
  );
  record(
    "directory-skill-carries-its-resources",
    !existsSync(join(skillsDir(home), "code-review", "SKILL.md")) && travelled.length === 1,
    travelled.join(",") || "no resource file arrived",
  );

  // ── Skill: a rename rewrites one line and nothing else ────────────────────
  writeFileSync(
    join(skillsDir(home), "review.md"),
    "---\nname: Review\nlicense: MIT\n---\n\n## Step 1\n\n   indented\n",
  );
  await host.call("skills.create", {
    skill: { name: "Review", level: "project", projectPath: projectA, body: "Project copy.\n" },
  });
  const renamedSkill = await host.call("skills.transfer", {
    id: "review",
    from: { level: "global" },
    to: { level: "project", projectPath: projectA },
  });
  record(
    "skill-same-name-arrives-under-a-distinct-name",
    renamedSkill.skill?.name === "Review (2)" && renamedSkill.skill?.id !== "review",
    JSON.stringify({ id: renamedSkill.skill?.id, name: renamedSkill.skill?.name }),
  );
  record(
    "skill-rename-rewrites-only-the-name-line",
    readFileSync(renamedSkill.skill.path, "utf8") ===
      "---\nname: Review (2)\nlicense: MIT\n---\n\n## Step 1\n\n   indented\n",
    JSON.stringify(readFileSync(renamedSkill.skill.path, "utf8")),
  );

  const back = await host.call("skills.transfer", {
    id: renamedSkill.skill.id,
    from: { level: "project", projectPath: projectA },
    to: { level: "global" },
  });
  record(
    "skill-can-move-back-to-the-global-level",
    back.skill?.level === "global" &&
      back.skill?.name === "Review (2)" &&
      existsSync(join(skillsDir(home), `${back.skill.id}.md`)),
    JSON.stringify({ level: back.skill?.level, id: back.skill?.id }),
  );

  // ── Request guards ───────────────────────────────────────────────────────
  const rejects = async (label, params, pattern) => {
    try {
      await host.call("mcp.transfer", params);
      record(label, false, "call unexpectedly succeeded");
    } catch (error) {
      record(label, pattern.test(error.message), error.message);
    }
  };
  await rejects(
    "target-without-an-explicit-level-is-rejected",
    { id: "echo", from: { level: "project", projectPath: projectA }, to: { projectPath: projectB } },
    /INVALID_PARAMS|level/,
  );
  await rejects(
    "project-target-without-a-project-path-is-rejected",
    { id: "echo", from: { level: "project", projectPath: projectA }, to: { level: "project" } },
    /CAPABILITY_INVALID|projectPath/,
  );

  const sameMove = await host.call("mcp.transfer", {
    id: "echo",
    from: { level: "project", projectPath: projectA },
    to: { level: "project", projectPath: projectA },
  });
  record(
    "moving-to-the-same-directory-is-a-no-op",
    sameMove.server?.id === "echo" && existsSync(serverPath(projectA, "echo")),
    JSON.stringify(sameMove.server?.id),
  );

  const finalProject = await host.call("skills.list", { level: "project", projectPath: projectA });
  const finalGlobal = await host.call("skills.list", { level: "global" });
  const unique = (rows, pick) => {
    const values = rows.map((row) => String(pick(row)).toLowerCase());
    return new Set(values).size === values.length;
  };
  record(
    "no-level-holds-two-capabilities-under-one-id-or-name",
    unique(finalProject.skills, (row) => row.id) &&
      unique(finalProject.skills, (row) => row.name) &&
      unique(finalGlobal.skills, (row) => row.id) &&
      unique(finalGlobal.skills, (row) => row.name) &&
      unique(projectAfter.servers, (row) => row.id) &&
      unique(projectAfter.servers, (row) => row.label),
    JSON.stringify(finalProject.skills.map((row) => `${row.id}:${row.name}`)),
  );
} catch (error) {
  record("scenario-completed", false, error.stack ?? error.message);
} finally {
  host?.dispose();
  for (const dir of [home, dataDir, projectA, projectB]) {
    rmSync(dir, { recursive: true, force: true });
  }
}

const failed = results.filter((result) => !result.ok);
console.log(`\nSummary: ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
