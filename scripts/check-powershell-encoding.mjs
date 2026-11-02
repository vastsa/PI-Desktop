#!/usr/bin/env node
/**
 * PowerShell encoding check: every tracked .ps1 must be UTF-8, and must carry a
 * BOM whenever it contains non-ASCII characters.
 *
 * Usage:
 *   node scripts/check-powershell-encoding.mjs
 *   pnpm check:powershell-encoding
 *
 * Why this gate exists
 * --------------------
 * Windows PowerShell 5.1 reads a BOM-less script using the system ANSI code
 * page (936/GBK on Chinese Windows). Any non-ASCII byte — typically a Chinese
 * comment — is then decoded as garbage. Because the mis-decoding happens before
 * parsing, the damage shows up as bogus syntax errors far away from the real
 * cause: a `#` comment line can swallow a quote and break the next here-string.
 * The reported error names English identifiers, so the actual encoding problem
 * is easy to misdiagnose.
 *
 * Rules
 * -----
 *   1. Every in-scope .ps1 must be valid UTF-8.
 *   2. A .ps1 containing non-ASCII characters must start with a UTF-8 BOM
 *      (EF BB BF), so PowerShell 5.1 decodes it as UTF-8.
 *   3. A pure-ASCII .ps1 needs no BOM (either state is accepted).
 *
 * A UTF-16 (LE/BE) file is reported separately: it is not UTF-8 and PowerShell
 * handles it inconsistently across hosts.
 *
 * Scope
 * -----
 * The repository itself, excluding build output, dependencies and caches:
 * node_modules, dist, release, target, .git, vendored plugin payloads.
 *
 * Fix
 * ---
 * Re-save the file as "UTF-8 with BOM" in the editor, or:
 *   pwsh -NoProfile -Command "$p='path\to.ps1'; $t=[IO.File]::ReadAllText($p); [IO.File]::WriteAllText($p,$t,(New-Object Text.UTF8Encoding($true)))"
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));

const BOM_UTF8 = Buffer.from([0xef, 0xbb, 0xbf]);
const BOM_UTF16LE = Buffer.from([0xff, 0xfe]);
const BOM_UTF16BE = Buffer.from([0xfe, 0xff]);

/** @param {Buffer} buf */
function hasPrefix(buf, prefix) {
  return buf.length >= prefix.length && buf.subarray(0, prefix.length).equals(prefix);
}

/**
 * Returns true when the buffer contains any byte outside plain ASCII.
 * Worked on raw bytes so a mis-decoded file is still detected correctly.
 * @param {Buffer} buf
 */
function hasNonAsciiBytes(buf) {
  for (let i = 0; i < buf.length; i += 1) {
    if (buf[i] > 0x7f) {
      return true;
    }
  }
  return false;
}

/**
 * Strict UTF-8 validation by round-trip. A BOM, if present, is excluded.
 * @param {Buffer} buf
 */
function isValidUtf8(buf) {
  const body = hasPrefix(buf, BOM_UTF8) ? buf.subarray(BOM_UTF8.length) : buf;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(body);
    return true;
  } catch {
    return false;
  }
}

/** @type {string[]} */
const failures = [];
/** @type {string[]} */
const bomsAddedOk = [];
let checkedCount = 0;

/**
 * Lists the .ps1 files this repository actually maintains.
 *
 * Git is the authority, not a directory walk: vendored plugin payloads under
 * apps/desktop/resources/plugins/ are gitignored and regenerated from the
 * marketplace catalog, so their encoding is the upstream author's concern and
 * must not fail this gate.
 *
 * Falls back to a filesystem walk (with the usual build/dependency excludes)
 * when git is unavailable, so the check still runs in an exported tarball.
 *
 * @returns {string[]} absolute paths
 */
function listScripts() {
  try {
    const out = execFileSync("git", ["ls-files", "-z", "*.ps1"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    return out
      .split("\0")
      .filter((rel) => rel.length > 0)
      .map((rel) => path.join(root, rel));
  } catch {
    /** @type {string[]} */
    const found = [];
    /** @param {string} dir */
    const walk = (dir) => {
      /** @type {import("node:fs").Dirent[]} */
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!EXCLUDED_DIRS.has(entry.name)) {
            walk(full);
          }
          continue;
        }
        if (entry.isFile() && entry.name.toLowerCase().endsWith(".ps1")) {
          found.push(full);
        }
      }
    };
    walk(root);
    return found;
  }
}

/** @param {string} full */
function checkFile(full) {
  const rel = path.relative(root, full).split(path.sep).join("/");
  checkedCount += 1;
  /** @type {Buffer} */
  let buf;
  try {
    buf = readFileSync(full);
  } catch (error) {
    failures.push(`${rel}: cannot be read (${/** @type {Error} */ (error).message})`);
    return;
  }

  if (buf.length === 0) {
    return;
  }

  if (hasPrefix(buf, BOM_UTF16LE) || hasPrefix(buf, BOM_UTF16BE)) {
    failures.push(
      `${rel}: UTF-16 encoded — save as UTF-8 with BOM so Windows PowerShell 5.1 decodes it deterministically`,
    );
    return;
  }

  if (!isValidUtf8(buf)) {
    failures.push(
      `${rel}: not valid UTF-8 (likely ANSI/GBK) — re-save as UTF-8 with BOM`,
    );
    return;
  }

  const hasBom = hasPrefix(buf, BOM_UTF8);
  const nonAscii = hasNonAsciiBytes(buf);

  if (nonAscii && !hasBom) {
    failures.push(
      `${rel}: contains non-ASCII text but has no UTF-8 BOM — Windows PowerShell 5.1 will decode it as the system ANSI code page and corrupt it (Chinese comments become garbage and can cause bogus syntax errors). Re-save as UTF-8 with BOM.`,
    );
    return;
  }

  if (hasBom) {
    bomsAddedOk.push(rel);
  }
}

for (const scriptPath of listScripts()) {
  checkFile(scriptPath);
}

if (failures.length > 0) {
  console.error("PowerShell encoding check failed:\n");
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  console.error(
    `\n${failures.length} file(s) need attention. Store PowerShell scripts in this repository`,
  );
  console.error(
    "as UTF-8 with BOM whenever they contain non-ASCII characters (see the powershell-encoding skill).",
  );
  console.error("Then re-run: pnpm check:powershell-encoding");
  process.exit(1);
}

console.log(
  `PowerShell encoding check passed (${checkedCount} script(s) scanned, ${bomsAddedOk.length} UTF-8-with-BOM verified).`,
);
