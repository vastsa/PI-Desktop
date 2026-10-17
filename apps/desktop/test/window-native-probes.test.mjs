import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const helper = fileURLToPath(new URL("../../../scripts/e2e/window-probe-geometry.ps1", import.meta.url));
const monitor = [0, 0, 2560, 1600];

function probe(cases) {
  return JSON.parse(execFileSync("pwsh.exe", ["-NoLogo", "-NoProfile", "-Command", `
    $ErrorActionPreference = 'Stop'
    . '${helper.replaceAll("'", "''")}'
    $cases = [Console]::In.ReadToEnd() | ConvertFrom-Json
    @($cases | ForEach-Object {
      Get-FullscreenProbeGeometry -WindowBounds $_.window -MonitorBounds $_.monitor -TaskbarBounds $_.taskbar
    }) | ConvertTo-Json -Depth 4 -Compress
  `], { input: JSON.stringify(cases), encoding: "utf8", windowsHide: true }));
}

test("native fullscreen probes visible and auto-hidden taskbars inside the physical monitor", {
  skip: process.platform !== "win32",
}, () => {
  const cases = [
    { taskbar: [0, 1516, 2560, 1600], point: [1280, 1558] },
    { taskbar: [0, 1598, 2560, 1682], point: [1280, 1599] },
    { taskbar: [0, -82, 2560, 2], point: [1280, 0] },
    { taskbar: [-82, 0, 2, 1600], point: [0, 800] },
    { taskbar: [2558, 0, 2642, 1600], point: [2559, 800] },
    { taskbar: [0, 1600, 2560, 1684], point: [1280, 1599] },
  ];
  const results = probe(cases.map(({ taskbar }) => ({ window: monitor, monitor, taskbar })));
  for (const [index, result] of results.entries()) {
    assert.deepEqual(result.point, cases[index].point);
    assert.equal(result.coversMonitor, true);
  }
});

test("native fullscreen coverage rejects work-area bounds and supports negative monitor origins", {
  skip: process.platform !== "win32",
}, () => {
  const results = probe([
    { window: [0, 0, 2560, 1516], monitor, taskbar: [0, 1516, 2560, 1600] },
    { window: [0, 0, 2559, 1600], monitor, taskbar: [2558, 0, 2642, 1600] },
    { window: [-1920, -1080, 0, 0], monitor: [-1920, -1080, 0, 0], taskbar: [-1920, -2, 0, 46] },
  ]);
  assert.equal(results[0].coversMonitor, false);
  assert.equal(results[1].coversMonitor, false);
  assert.deepEqual(results[2], { coversMonitor: true, point: [-960, -1] });
});
