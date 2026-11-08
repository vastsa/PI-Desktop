import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const launcher = fileURLToPath(new URL("./with-openbox.sh", import.meta.url));

test("waits for the WM claim, forwards the probe failure and reaps Openbox", { skip: process.platform === "win32" }, (t) => {
  const fixture = mkdtempSync(join(tmpdir(), "pi-openbox-readiness-"));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const executable = (name, source) => writeFileSync(join(fixture, name), `#!/bin/sh\n${source}\n`, { mode: 0o755 });
  executable("openbox", 'echo "$$" > "$WM_FIXTURE/pid"\nexec sleep 60');
  // A live WM process has not claimed the display on the first query.
  executable("xprop", `if [ ! -e "$WM_FIXTURE/polled" ]; then
    touch "$WM_FIXTURE/polled"
    exit 0
  fi
  touch "$WM_FIXTURE/ready"
  echo '_NET_SUPPORTING_WM_CHECK(WINDOW): window id # 0x200001'`);
  executable("probe", '[ -e "$WM_FIXTURE/ready" ] || exit 99\nexit 37');
  const env = { ...process.env, PATH: `${fixture}:${process.env.PATH}`, WM_FIXTURE: fixture };
  const result = spawnSync("sh", [launcher, "probe"], { env, encoding: "utf8", timeout: 5_000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 37, result.stderr);
  const pid = Number(readFileSync(join(fixture, "pid"), "utf8"));
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });

  executable("openbox", "exit 1");
  executable("xprop", "exit 1");
  const failed = spawnSync("sh", [launcher, "probe"], { env, encoding: "utf8", timeout: 5_000 });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /Openbox exited before claiming/);
});
