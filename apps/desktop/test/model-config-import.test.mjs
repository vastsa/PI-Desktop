import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { scanModelConfigs } = await import("../electron/main/importers/model-config.ts");

test("scanModelConfigs reads Claude Code, OpenCode, Codex, and Pi stores", async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-model-import-"));
  await mkdir(join(home, ".claude"), { recursive: true });
  await mkdir(join(home, ".config", "opencode"), { recursive: true });
  await mkdir(join(home, ".local", "share", "opencode"), { recursive: true });
  await mkdir(join(home, ".codex"), { recursive: true });
  await mkdir(join(home, ".pi", "agent"), { recursive: true });

  await writeFile(
    join(home, ".claude", "settings.json"),
    JSON.stringify({
      env: {
        ANTHROPIC_API_KEY: "sk-claude",
        ANTHROPIC_BASE_URL: "https://proxy.example",
      },
      model: "claude-sonnet",
    }),
  );
  await writeFile(
    join(home, ".config", "opencode", "opencode.json"),
    JSON.stringify({
      provider: {
        ink: {
          npm: "@ai-sdk/openai-compatible",
          name: "ink",
          options: { baseURL: "https://api.oj.ink/v1", apiKey: "sk-oc" },
          models: { "mimo-v2.5": { name: "mimo-v2.5" } },
        },
      },
    }),
  );
  await writeFile(
    join(home, ".codex", "config.toml"),
    `model = "llama3"
[model_providers.local]
name = "Local"
base_url = "http://127.0.0.1:11434/v1"
api_key = "ollama"
wire_api = "chat"
`,
  );
  await writeFile(
    join(home, ".pi", "agent", "models.json"),
    JSON.stringify({
      providers: {
        custom: {
          baseUrl: "https://pi.example/v1",
          api: "openai-completions",
          apiKey: "sk-pi",
          models: [{ id: "pi-model" }],
        },
      },
    }),
  );

  const drafts = await scanModelConfigs({ homeDir: home, env: {} });
  assert.deepEqual(
    drafts.map((d) => `${d.source}:${d.externalId}`).sort(),
    ["claude-code:default", "codex:local", "opencode:ink", "pi:custom"].sort(),
  );
  assert.equal(
    drafts.find((d) => d.source === "claude-code")?.secretValue,
    "sk-claude",
  );
  assert.ok(!JSON.stringify(drafts.map((d) => ({ ...d, secretValue: undefined }))).includes("sk-claude"));
});

test("scanModelConfigs returns nothing when the home directory is empty", async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-model-import-empty-"));
  const drafts = await scanModelConfigs({ homeDir: home, env: {} });
  assert.deepEqual(drafts, []);
});

test("settings import and protocol expose model-config import independently of sessions", async () => {
  const { readFile } = await import("node:fs/promises");
  const settingsPage = await readFile(
    new URL("../src/pages/SettingsPage.tsx", import.meta.url),
    "utf8",
  );
  const apiSource = await readFile(new URL("../src/lib/api.ts", import.meta.url), "utf8");
  const protocol = await readFile(
    new URL("../../../packages/shared/src/protocol.ts", import.meta.url),
    "utf8",
  );
  const mainSource = await readFile(
    new URL("../electron/main/index.ts", import.meta.url),
    "utf8",
  );
  assert.match(settingsPage, /scanImportModelConfigs/);
  assert.match(settingsPage, /ModelConfigImportPanel/);
  assert.match(apiSource, /modelConfigImportScan/);
  assert.match(protocol, /pi-desktop\/modelConfig\/importScan/);
  assert.match(mainSource, /providers\.create/);
  assert.match(mainSource, /providers\.getSecret/);
  assert.match(mainSource, /secretValue: draft\.secretValue/);
  assert.match(mainSource, /publicModelConfigCandidate/);
});

test("scanModelConfigs keeps same-endpoint CC Switch profiles with different keys", async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-cc-switch-import-"));
  await mkdir(join(home, ".claude"), { recursive: true });
  await mkdir(join(home, ".cc-switch"), { recursive: true });
  await writeFile(
    join(home, ".claude", "settings.json"),
    JSON.stringify({
      env: {
        ANTHROPIC_API_KEY: "sk-cc",
        ANTHROPIC_BASE_URL: "https://cc.example/v1",
      },
      model: "claude-sonnet",
    }),
  );
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(home, ".cc-switch", "cc-switch.db"));
  db.exec(
    "CREATE TABLE providers (id TEXT, app_type TEXT, name TEXT, settings_config TEXT)",
  );
  db.prepare("INSERT INTO providers VALUES (?, ?, ?, ?)").run(
    "packy",
    "claude",
    "Packy",
    JSON.stringify({
      env: {
        ANTHROPIC_API_KEY: "sk-cc",
        ANTHROPIC_BASE_URL: "https://cc.example/v1",
        ANTHROPIC_MODEL: "claude-sonnet",
      },
    }),
  );
  db.prepare("INSERT INTO providers VALUES (?, ?, ?, ?)").run(
    "other",
    "claude",
    "Other",
    JSON.stringify({
      env: {
        ANTHROPIC_API_KEY: "sk-other",
        ANTHROPIC_BASE_URL: "https://cc.example/v1",
        ANTHROPIC_MODEL: "claude-haiku",
      },
    }),
  );
  db.close();

  const drafts = await scanModelConfigs({ homeDir: home, env: {} });
  assert.deepEqual(
    drafts.map((d) => `${d.source}:${d.externalId}`).sort(),
    ["cc-switch:claude:other", "cc-switch:claude:packy"].sort(),
  );
  assert.equal(drafts.find((d) => d.externalId === "claude:packy")?.name, "Packy");
  assert.equal(drafts.find((d) => d.externalId === "claude:packy")?.secretValue, "sk-cc");
  assert.equal(drafts.find((d) => d.externalId === "claude:other")?.secretValue, "sk-other");
});
