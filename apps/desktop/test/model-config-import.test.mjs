import { readMainSource } from "./helpers/source-contracts.mjs";
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
const { publicModelConfigCandidate } = await import("@pi-desktop/shared");

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

test("model settings embeds the model-config importer while retaining its protocol", async () => {
  const { readFile } = await import("node:fs/promises");
  const modelPage = await readFile(
    new URL("../src/components/settings/ModelConfigPage.tsx", import.meta.url),
    "utf8",
  );
  const modelImport = await readFile(
    new URL("../src/features/settings/imports/ModelConfigImportPanel.tsx", import.meta.url),
    "utf8",
  );
  const apiSource = await readFile(new URL("../src/lib/api.ts", import.meta.url), "utf8");
  const protocol = await readFile(
    new URL("../../../packages/shared/src/protocol.ts", import.meta.url),
    "utf8",
  );
  const mainSource = await readMainSource();
  assert.match(modelPage, /ImportToggleButton/);
  assert.match(modelPage, /<ModelConfigImportPanel \/>/);
  assert.match(modelImport, /scanImportModelConfigs/);
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

// Regression: issue #588. Reproduces the reporter's scenario — a stale
// cc-switch v18 pi snapshot missing one model, plus a newer ~/.pi/agent/models.json
// that lists all ten. The old code returned the snapshot under the "cc-switch"
// source and silently dropped the tenth model. The fix routes pi rows through
// the "pi" scanner so the authoritative file wins.
test("scanModelConfigs keeps the pi native config authoritative when a cc-switch snapshot exists", async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-cc-switch-pi-"));
  await mkdir(join(home, ".pi", "agent"), { recursive: true });
  await mkdir(join(home, ".cc-switch"), { recursive: true });

  // Newer, authoritative pi config with ten models.
  await writeFile(
    join(home, ".pi", "agent", "models.json"),
    JSON.stringify({
      providers: {
        "opencode-go": {
          name: "opencode-go",
          baseUrl: "https://api.oj.ink/v1",
          api: "openai-completions",
          apiKey: "sk-pi",
          models: Array.from({ length: 10 }, (_, i) => ({ id: `m${i + 1}` })),
        },
      },
    }),
  );

  // Stale cc-switch snapshot: same endpoint + key, only nine models, and a
  // renamed label that used to leak into the UI.
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(home, ".cc-switch", "cc-switch.db"));
  db.exec(
    "CREATE TABLE providers (id TEXT, app_type TEXT, name TEXT, settings_config TEXT)",
  );
  db.prepare("INSERT INTO providers VALUES (?, ?, ?, ?)").run(
    "opencode-go",
    "pi",
    "OpenCode Zen Go",
    JSON.stringify({
      baseUrl: "https://api.oj.ink/v1",
      api: "openai-completions",
      apiKey: "sk-pi",
      models: Array.from({ length: 9 }, (_, i) => ({ id: `m${i + 1}` })),
    }),
  );
  db.close();

  const drafts = await scanModelConfigs({ homeDir: home, env: {} });
  const piDrafts = drafts.filter((d) => d.source === "pi");
  const ccDrafts = drafts.filter((d) => d.source === "cc-switch");
  assert.equal(ccDrafts.length, 0, "no pi rows should surface under the cc-switch source");
  assert.equal(piDrafts.length, 1);
  assert.equal(piDrafts[0].externalId, "opencode-go");
  assert.equal(piDrafts[0].name, "opencode-go");
  assert.equal(piDrafts[0].modelIds.length, 10);
  assert.ok(piDrafts[0].modelIds.includes("m10"));
});

// Regression: Settings → Models only read models.json, so providers connected
// through `pi /login` (auth.json only) never appeared in the Pi group. The scan
// now pairs auth.json API keys with Pi's cached catalog and fills keys that
// models.json references through an unresolved environment variable.
test("scanModelConfigs imports Pi auth-only providers and fills unresolved model keys", async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-agent-auth-import-"));
  const agentDir = join(home, ".pi", "agent");
  await mkdir(agentDir, { recursive: true });

  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        custom: {
          baseUrl: "https://custom.example/v1",
          api: "openai-completions",
          apiKey: "env:CUSTOM_KEY",
          models: [{ id: "custom-model" }],
        },
      },
    }),
  );
  await writeFile(
    join(agentDir, "auth.json"),
    JSON.stringify({
      custom: { type: "api_key", key: "sk-custom-auth" },
      deepseek: { type: "api_key", key: "sk-deepseek" },
      command: { type: "api_key", key: "!security find-generic-password" },
      codex: { type: "oauth", access: "oauth-access" },
    }),
  );
  await writeFile(
    join(agentDir, "models-store.json"),
    JSON.stringify({
      deepseek: {
        models: [
          {
            id: "deepseek-flash",
            api: "openai-completions",
            baseUrl: "https://api.deepseek.com",
            reasoning: true,
            contextWindow: 1000000,
            maxTokens: 384000,
          },
        ],
      },
      codex: {
        models: [
          {
            id: "gpt-6-sol",
            api: "openai-codex-responses",
            baseUrl: "https://chatgpt.com/backend-api",
          },
        ],
      },
    }),
  );

  const drafts = await scanModelConfigs({ homeDir: home, env: {} });
  const piDrafts = drafts.filter((draft) => draft.source === "pi");
  assert.deepEqual(
    piDrafts.map((draft) => draft.externalId).sort(),
    ["custom", "deepseek"],
  );
  assert.equal(piDrafts.find((draft) => draft.externalId === "custom")?.secretValue, "sk-custom-auth");
  assert.equal(piDrafts.find((draft) => draft.externalId === "deepseek")?.secretValue, "sk-deepseek");
  assert.ok(!piDrafts.some((draft) => draft.externalId === "codex"));
  assert.ok(!piDrafts.some((draft) => draft.externalId === "command"));
  assert.ok(
    !JSON.stringify(piDrafts.map((draft) => publicModelConfigCandidate(draft))).includes(
      "sk-custom-auth",
    ),
  );
  assert.ok(
    !JSON.stringify(piDrafts.map((draft) => publicModelConfigCandidate(draft))).includes(
      "sk-deepseek",
    ),
  );
});

// Regression: readPi originally used `promise ?? fallbackPromise`, which never
// awaited the left side and therefore never read the documented ~/.pi fallback.
test("scanModelConfigs reads Pi fallback files directly under ~/.pi", async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-fallback-import-"));
  const configDir = join(home, ".pi");
  await mkdir(configDir, { recursive: true });

  await writeFile(
    join(configDir, "models.json"),
    JSON.stringify({
      providers: {
        legacy: {
          baseUrl: "https://legacy.example/v1",
          api: "openai-completions",
          apiKey: "env:LEGACY_KEY",
          models: [{ id: "legacy-model" }],
        },
      },
    }),
  );
  await writeFile(
    join(configDir, "auth.json"),
    JSON.stringify({
      legacy: { type: "api_key", key: "sk-legacy" },
      "auth-only": { type: "api_key", key: "sk-auth-only" },
    }),
  );
  await writeFile(
    join(configDir, "models-store.json"),
    JSON.stringify({
      "auth-only": {
        models: [
          {
            id: "auth-model",
            api: "openai-completions",
            baseUrl: "https://auth.example/v1",
          },
        ],
      },
    }),
  );

  const drafts = (await scanModelConfigs({ homeDir: home, env: {} })).filter(
    (draft) => draft.source === "pi",
  );
  assert.deepEqual(
    drafts.map((draft) => draft.externalId).sort(),
    ["auth-only", "legacy"],
  );
  assert.equal(
    drafts.find((draft) => draft.externalId === "legacy")?.secretValue,
    "sk-legacy",
  );
  assert.equal(
    drafts.find((draft) => draft.externalId === "auth-only")?.secretValue,
    "sk-auth-only",
  );
});
