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
    .toMatchObject({ stdout: "ok", code: 0, killed: false });
  owner.abort();
  expect(() => managedExec(process.execPath, ["-e", "process.exit(9)"], tmpdir(), owner.signal))
    .toThrow();
});
