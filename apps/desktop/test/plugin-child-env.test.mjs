import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { minimalChildEnv, pluginChildEnv } from "../electron/main/child-process-env.ts";
import { mcpProcessEnv } from "../electron/main/plugin-mcp.ts";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(here, "..");

/** Run `fn` with `patch` applied to `process.env`, restoring the host's values after. */
function withHostEnv(patch, fn) {
  const saved = new Map();
  for (const [key, value] of Object.entries(patch)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("a plugin process carries the identity a spawned binary resolves ~ with", () => {
  withHostEnv({ HOME: "/tmp/pi-home", USER: "pi-user", USERPROFILE: "/tmp/pi-home" }, () => {
    const env = pluginChildEnv("com.example.plugin");
    assert.equal(env.HOME, "/tmp/pi-home");
    assert.equal(env.USER, "pi-user");
    assert.equal(env.USERPROFILE, "/tmp/pi-home");
    assert.equal(env.PI_PLUGIN_ID, "com.example.plugin");
    // PATH still crosses, or a bare command name could never be found.
    assert.ok(typeof env.PATH === "string" && env.PATH.length > 0);
  });
});

test("a variable the host does not have stays absent instead of empty", () => {
  withHostEnv({ HOME: undefined, USER: undefined, USERPROFILE: undefined }, () => {
    const env = pluginChildEnv("com.example.plugin");
    // `HOME=""` is worse than no HOME: a binary that would fall back to getpwuid
    // resolves `~` against the working directory instead.
    assert.equal("HOME" in env, false);
    assert.equal("USER" in env, false);
    assert.equal("USERPROFILE" in env, false);
  });
  withHostEnv({ HOME: "" }, () => {
    assert.equal("HOME" in minimalChildEnv(), false);
  });
});

test("the child environment stays closed to host secrets", () => {
  withHostEnv({ PI_TEST_SECRET: "must-not-cross", OPENAI_API_KEY: "sk-must-not-cross" }, () => {
    const envs = [
      pluginChildEnv("com.example.plugin"),
      mcpProcessEnv("com.example.plugin", {}),
    ];
    for (const env of envs) {
      assert.equal(env.PI_TEST_SECRET, undefined);
      assert.equal(env.OPENAI_API_KEY, undefined);
    }
  });
});

test("a stdio MCP server gets the same identity, and declared values still win", () => {
  withHostEnv({ HOME: "/tmp/pi-home" }, () => {
    const env = mcpProcessEnv("com.example.plugin", { TOKEN: "t0ken" });
    assert.equal(env.HOME, "/tmp/pi-home");
    assert.equal(env.TOKEN, "t0ken");
    assert.equal(env.PI_PLUGIN_ID, "com.example.plugin");
  });
  // A plugin-declared value is the caller's explicit choice (D018), so it wins.
  withHostEnv({ HOME: "/tmp/pi-home" }, () => {
    assert.equal(mcpProcessEnv("com.example.plugin", { HOME: "/tmp/declared" }).HOME, "/tmp/declared");
  });
});

test("both plugin child environments are built from the one allowlist", () => {
  const runtimeSrc = readFileSync(join(desktopRoot, "electron/main/plugin-runtime.ts"), "utf8");
  const mcpSrc = readFileSync(join(desktopRoot, "electron/main/plugin-mcp.ts"), "utf8");
  const envSrc = readFileSync(join(desktopRoot, "electron/main/child-process-env.ts"), "utf8");
  assert.match(runtimeSrc, /env: pluginChildEnv\(pluginId\)/);
  assert.match(mcpSrc, /\.\.\.minimalChildEnv\(\)/);
  // A second private allowlist is how the identity variables went missing once.
  assert.doesNotMatch(runtimeSrc, /pluginProcessEnv/);
  assert.doesNotMatch(mcpSrc, /for \(const key of \["SystemRoot"/);
  assert.doesNotMatch(runtimeSrc, /for \(const key of \["PATH"/);
  assert.match(envSrc, /"HOME",\s*\n\s*"USER",\s*\n\s*"USERPROFILE",/);
});
