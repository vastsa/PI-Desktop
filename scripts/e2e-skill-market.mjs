#!/usr/bin/env node
/**
 * Skill market E2E (headless protocol-level).
 * Covers the market install path, resource expansion and the URL boundary:
 *
 *   E2E-SKILL-MARKET-INSTALL      builtin entry → assembled document →
 *                                 skills.create → record on disk
 *   E2E-SKILL-MARKET-EXPANSION    adjacent resources expand into the body
 *   E2E-SKILL-MARKET-NET-BOUNDARY URL guard rejects loopback/private/mapped/
 *                                 ULA/link-local bypass forms
 *   E2E-SKILL-MARKET-ID-ALIGN     scanned ids match host valid_capability_id
 *   E2E-SKILL-MARKET-SIZE-LIMIT   expanded documents over 128KiB are flagged
 *
 * Env: PI_DESKTOP_HOST_BIN (optional), DEBUG_HOST for tracing.
 * Deterministic: no live network access.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION } from "../packages/shared/dist/protocol.js";
import { readNdjsonLines } from "../packages/shared/dist/ndjson.js";
import {
  BUILTIN_SKILL_CATALOG,
  GLOBAL_SCOPE,
  assembleSkillInstall,
  expandSkillResources,
  isSafeSkillSourceUrl,
  MAX_SKILL_DOCUMENT_BYTES,
  sanitizeSkillCatalogId,
  splitSkillDocument,
  validateSkillCatalogFile,
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

// ── E2E-SKILL-MARKET-NET-BOUNDARY ────────────────────────────────────────
{
  const bypass = [
    "https://localhost./x/catalog.json",
    "https://[::1]/catalog.json",
    "https://[::ffff:127.0.0.1]/catalog.json",
    "https://[fd00::1]/catalog.json",
    "https://[fe80::1]/catalog.json",
    "https://127.0.0.1/catalog.json",
    "https://10.0.0.8/catalog.json",
    "http://skills.example/catalog.json",
  ];
  const accepted = "https://cdn.jsdelivr.net/gh/anthropics/skills@main/skills/pdf/SKILL.md";
  const rejectedAll = bypass.every((url) => isSafeSkillSourceUrl(url) === false);
  record(
    "E2E-SKILL-MARKET-NET-BOUNDARY",
    rejectedAll && isSafeSkillSourceUrl(accepted),
    rejectedAll ? "8 bypass forms rejected, public CDN accepted" : "guard misclassification",
  );
}

// ── E2E-SKILL-MARKET-ID-ALIGN ────────────────────────────────────────────
{
  const ok =
    sanitizeSkillCatalogId("Frontend_Design", "skill-0") === "frontend-design" &&
    sanitizeSkillCatalogId("1-pdf", "skill-0") === "1-pdf" &&
    sanitizeSkillCatalogId("***", "skill-7") === "skill-7";
  record("E2E-SKILL-MARKET-ID-ALIGN", ok, ok ? "underscore and fallback ids match host" : "id mismatch");
}

// ── E2E-SKILL-MARKET-SIZE-LIMIT ──────────────────────────────────────────
{
  const small = assembleSkillInstall(
    { body: "Read FORMS.md.", resources: [{ path: "FORMS.md", body: "Forms." }] },
    { name: "pdf" },
  );
  const huge = assembleSkillInstall({ body: "x".repeat(MAX_SKILL_DOCUMENT_BYTES) }, { name: "huge" });
  const ok = small.tooLarge === false && small.body.includes("Attached resource: FORMS.md") && huge.tooLarge === true;
  record("E2E-SKILL-MARKET-SIZE-LIMIT", ok, ok ? "small expands, huge flagged" : "size gate broken");
}

// ── E2E-SKILL-MARKET-EXPANSION ───────────────────────────────────────────
{
  const doc = splitSkillDocument(
    "---\nname: pdf\ndescription: process PDFs\n---\n\nRead FORMS.md and REFERENCE.md.",
  );
  const resources = [
    { path: "FORMS.md", body: "# Forms\n\nForm handling guidance." },
    { path: "REFERENCE.md", body: "# Reference\n\nReference material." },
  ];
  const expanded = expandSkillResources(doc, resources);
  const ok =
    expanded.includes("Read FORMS.md and REFERENCE.md.") &&
    expanded.includes("# Attached resource: FORMS.md") &&
    expanded.includes("# Forms") &&
    expanded.includes("# Attached resource: REFERENCE.md");
  const clean = expandSkillResources(doc, []) === doc.body;
  record("E2E-SKILL-MARKET-EXPANSION", ok && clean, ok ? `${resources.length} resources inlined` : "expansion broken");
}

// ── E2E-SKILL-MARKET-INSTALL ─────────────────────────────────────────────
const home = mkdtempSync(join(tmpdir(), "pi-desktop-skl-e2e-"));
const dataDir = mkdtempSync(join(tmpdir(), "pi-desktop-skl-e2e-data-"));
let host = null;
try {
  const { catalog, warnings } = validateSkillCatalogFile(BUILTIN_SKILL_CATALOG);
  if (warnings.length || catalog.skills.length < 8) {
    record("E2E-SKILL-MARKET-INSTALL", false, `builtin catalog invalid: ${warnings.join("; ")}`);
  } else {
    host = new Host(hostBin, dataDir, home);
    await host.call("app.handshake", { protocolVersion: PROTOCOL_VERSION });

    // Deterministic document stands in for the CDN fetch: same split the
    // market performs before handing the body to skills.create.
    const raw = "---\nname: pdf\ndescription: process PDF files\n---\n\nProcess PDFs.";
    const document = splitSkillDocument(raw);
    const entry = catalog.skills.find((skill) => skill.id === "pdf");
    const assembled = assembleSkillInstall(document, entry);
    const created = await host.call("skills.create", {
      skill: {
        id: entry.id,
        name: assembled.name,
        description: assembled.description,
        body: assembled.body,
        level: "global",
        scope: GLOBAL_SCOPE,
        enabled: true,
      },
    });

    const recordPath = join(home, ".agents", "skills", "pdf.md");
    const onDisk = existsSync(recordPath) ? readFileSync(recordPath, "utf8") : "";
    const diskOk =
      onDisk.startsWith("---\n") &&
      onDisk.includes("name: pdf") &&
      onDisk.includes("description: process PDF files") &&
      onDisk.includes("Process PDFs.");
    const listed = await host.call("skills.list", { level: "global" });
    const row = (listed.skills ?? []).find((skill) => skill.id === "pdf");
    record(
      "E2E-SKILL-MARKET-INSTALL",
      !!created?.skill && diskOk && !!row,
      row ? JSON.stringify({ id: row.id, name: row.name, source: row.source }) : "not listed",
    );
  }
} catch (error) {
  record("E2E-SKILL-MARKET-INSTALL", false, error.message);
} finally {
  host?.dispose();
  setTimeout(() => rmSync(home, { recursive: true, force: true }), 200);
  rmSync(dataDir, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.ok);
console.log(`\nSummary: ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
