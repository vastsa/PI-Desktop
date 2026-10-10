#!/usr/bin/env node
/** Sample the composed Windows surface of production window helpers in isolation. */
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { assertDesktopBuild, repositoryRoot, resolveElectronBinary } from "./e2e/boot.mjs";

if (process.platform !== "win32") {
  console.log("SKIP window surface probe: requires a dedicated interactive Windows desktop");
  process.exit(0);
}

const root = repositoryRoot();
const { appDir } = assertDesktopBuild(root);
const { electronBinary } = resolveElectronBinary(root);
const fixtureDir = join(root, "scripts", "e2e", "fixtures", "window-surface");
const execFileAsync = promisify(execFile);
const temp = await mkdtemp(join(tmpdir(), "pi-window-surface-"));
const userArtifactDir = process.env.PI_DESKTOP_WINDOW_SURFACE_ARTIFACT_DIR;
const artifactDir = userArtifactDir
  ? resolve(userArtifactDir)
  : await mkdtemp(join(tmpdir(), "pi-window-surface-artifacts-"));
await mkdir(artifactDir, { recursive: true });

function waitForFixtureReady(child) {
  let output = "";
  let lineBuffer = "";
  let ready = false;
  let rejectReady;
  const result = new Promise((resolveReady, reject) => {
    rejectReady = reject;
    child.stdout.on("data", (chunk) => {
      const text = String(chunk);
      output = (output + text).slice(-8000);
      lineBuffer += text;
      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const value = JSON.parse(line);
          if (value.type === "ready") {
            ready = true;
            resolveReady(value);
            return;
          }
        } catch {
          // Keep non-JSON Electron output for a useful timeout diagnostic.
        }
      }
    });
    child.stderr.on("data", (chunk) => { output = (output + String(chunk)).slice(-8000); });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (!ready) reject(new Error(`Surface fixture exited before ready (${code ?? signal}): ${output}`));
    });
  });
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Surface fixture did not become ready: ${output}`)), 45_000);
  });
  return Promise.race([result, timeout]).finally(() => clearTimeout(timer));
}

async function stopFixture(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill();
  await Promise.race([exited, delay(5000)]);
}

async function runSurfaceCase(radius, backdropColor, backdropName) {
  const profile = join(temp, `profile-${radius}-${backdropName}`);
  const env = { ...process.env,
    PI_DESKTOP_ELECTRON_PACKAGE: join(appDir, "node_modules", "electron"),
    PI_DESKTOP_WINDOW_SHAPE: join(appDir, "electron", "main", "window-shape.ts"),
    PI_DESKTOP_WINDOW_NATIVE_CORNERS: join(appDir, "electron", "main", "window-native-corners.ts"),
    PI_DESKTOP_WINDOW_BACKGROUND: join(appDir, "electron", "main", "window-background.ts"),
    PI_DESKTOP_E2E_HOST_HELPER: join(root, "scripts", "e2e", "host.mjs"),
    PI_DESKTOP_SURFACE_PROFILE: profile,
    PI_DESKTOP_SURFACE_RADIUS: String(radius),
    PI_DESKTOP_SURFACE_BACKDROP: backdropColor,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronBinary, [fixtureDir, `--user-data-dir=${profile}`], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const fixture = await waitForFixtureReady(child);
    const screenshotPath = join(artifactDir, `${backdropName}-radius-${radius}.png`);
    const { stdout } = await execFileAsync("pwsh.exe", [
      "-NoLogo", "-NoProfile", "-File",
      join(root, "scripts", "e2e", "probe-window-surface.ps1"),
      String(child.pid),
      fixture.title,
      String(radius),
      backdropColor,
      screenshotPath,
    ], { timeout: 30_000, maxBuffer: 2_000_000 });
    const result = JSON.parse(stdout.trim());
    assert.equal(result.cornerMode, fixture.cornerMode, "fixture and screen probe agree on the Windows corner path");
    assert.equal(result.totalMismatches, 0, `${backdropName}, radius ${radius}: ${JSON.stringify(result.mismatches)}`);
    assert.ok(result.insideSamples > 0, `${backdropName}, radius ${radius}: interior samples`);
    if (result.cornerMode === "dwm-native") {
      assert.equal(result.nativeBackgroundSample, true, `${backdropName}, radius ${radius}: opaque alpha-composited window background`);
    }
    if (radius > 0) {
      assert.ok(result.outsideSamples > 0, `${backdropName}, radius ${radius}: exterior samples`);
      for (const [corner, values] of Object.entries(result.cornerResults)) {
        assert.ok(values.edgeBlendPixels > 0, `${backdropName}, radius ${radius}: ${corner} has an antialiased edge`);
      }
    }
    console.log(`PASS surface ${backdropName}, ${radius} DIP request (${result.cornerMode}): dpi=${result.dpi}, ` +
      `scale=${result.scaleFactor}, physical=${result.physicalBounds.width}x${result.physicalBounds.height}, ` +
      `edge blends=${result.edgeBlendPixels}, screenshot=${screenshotPath}`);
  } finally {
    await stopFixture(child);
  }
}

try {
  for (const [backdropName, backdropColor] of [
    ["light", "#eaf0f6"],
    ["dark", "#172b3f"],
  ]) {
    for (const radius of [0, 12, 24]) {
      await runSurfaceCase(radius, backdropColor, backdropName);
    }
  }
} finally {
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  console.log(`Window surface screenshots: ${artifactDir}`);
}
