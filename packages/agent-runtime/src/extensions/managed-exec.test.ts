import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { managedExec } from "./managed-exec.js";

it("cancels an owned process tree after an explicit readiness signal", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-owned-exec-"));
  const ready = join(root, "ready.json");
  const owner = new AbortController();
  const childSource = `require('node:fs').writeFileSync(${JSON.stringify(ready)}, JSON.stringify([process.ppid,process.pid])); setInterval(()=>{},1000);`;
  const parentSource = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childSource)}],{stdio:'inherit'}); setInterval(()=>{},1000);`;
  const pending = managedExec(process.execPath, ["-e", parentSource], root, owner.signal);
  try {
    await expect.poll(() => existsSync(ready)).toBe(true);
    const pids: number[] = JSON.parse(readFileSync(ready, "utf8"));
    owner.abort();
    expect((await pending).killed).toBe(true);
    for (const pid of pids) await expect.poll(() => {
      try { process.kill(pid, 0); return true; } catch { return false; }
    }).toBe(false);
  } finally {
    owner.abort();
    await pending;
    rmSync(root, { recursive: true, force: true });
  }
});

it("never starts an already-cancelled exec and keeps normal command output", async () => {
  const owner = new AbortController();
  expect(await managedExec(process.execPath, ["-e", "process.stdout.write('ok')"], tmpdir(), owner.signal))
    .toMatchObject({ stdout: "ok", code: 0, killed: false, truncated: false });
  owner.abort();
  expect(() => managedExec(process.execPath, ["-e", "process.exit(9)"], tmpdir(), owner.signal))
    .toThrow();
});

it("decodes a multi-byte character split across output chunks", async () => {
  const owner = new AbortController();
  // "中" is three UTF-8 bytes; write them as two separate chunks.
  const source = "const b=Buffer.from('中文');process.stdout.write(b.subarray(0,1));setTimeout(()=>process.stdout.write(b.subarray(1)),50);";
  expect(await managedExec(process.execPath, ["-e", source], tmpdir(), owner.signal))
    .toMatchObject({ stdout: "中文", code: 0, killed: false, truncated: false });
});

it("terminates a command whose combined output exceeds maxBuffer and reports truncation", async () => {
  const owner = new AbortController();
  const source = "process.stderr.write('ee');setInterval(()=>process.stdout.write('x'.repeat(1024)),5);";
  const result = await managedExec(process.execPath, ["-e", source], tmpdir(), owner.signal, { maxBuffer: 2048 });
  expect(result.truncated).toBe(true);
  expect(result.killed).toBe(true);
  expect(result.code).not.toBe(0);
  expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(2048);
});

it("drops an incomplete UTF-8 suffix at the truncation boundary", async () => {
  const owner = new AbortController();
  const source = "process.stdout.write(Buffer.from('aé'));setInterval(()=>{},1000);";
  const result = await managedExec(process.execPath, ["-e", source], tmpdir(), owner.signal, { maxBuffer: 2 });
  expect(result).toMatchObject({ stdout: "a", truncated: true });
});

it("resolves a missing executable as a failed command with the spawn error", async () => {
  const owner = new AbortController();
  const result = await managedExec("pi-desktop-missing-executable-e2e", [], tmpdir(), owner.signal);
  expect(result.code).toBe(1);
  expect(result.truncated).toBe(false);
  expect(result.stderr).toContain("ENOENT");
});

it("rejects an invalid maxBuffer before spawning", () => {
  const owner = new AbortController();
  expect(() => managedExec(process.execPath, ["-e", ""], tmpdir(), owner.signal, { maxBuffer: -1 })).toThrow(RangeError);
});
