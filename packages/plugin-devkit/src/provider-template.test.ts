import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { check } from "./check.js";

it("checks a data-only provider template package without OAuth code permissions and rejects schema/permission drift", async () => {
  const dir = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "provider-template-devkit-"));
  const path = join(dir, "manifest.json");
  const template = { version: 1, id: "cloud", name: "Cloud", baseUrl: "https://api.example.com", authKind: "oauth", models: [{ id: "chat" }], oauth: {
    flow: "device_code", clientId: "public", tokenUrl: "https://auth.example.com/token", deviceAuthorizationUrl: "https://auth.example.com/device",
  } };
  const base = { schemaVersion: 1, id: "demo.templates", name: "Templates", version: "1.0.0", main: "main.js", permissions: ["provider.register"], contributes: { providerTemplates: [template] } };
  try {
    await writeFile(join(dir, "main.js"), "export {};\n");
    await writeFile(path, JSON.stringify(base));
    expect((await check(dir)).ok).toBe(true);
    const saved = await readFile(path, "utf8");
    for (const value of [
      { ...base, permissions: [] },
      { ...base, contributes: { providerTemplates: [{ ...template, oauth: { flow: "custom" } }] } },
      { ...base, contributes: { providerTemplates: [{ ...template, models: [{ id: "chat", unknown: true }] }] } },
      { ...base, contributes: { providerTemplates: [{ ...template, oauth: { ...template.oauth, clientSecret: "forbidden" } }] } },
    ]) {
      await writeFile(path, JSON.stringify(value));
      const result = await check(dir);
      expect(result.ok).toBe(false);
      expect(result.errors.some(error => error.code === "manifest.invalid")).toBe(true);
    }
    expect(JSON.parse(saved).contributes.providerTemplates[0]).toEqual(template);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
