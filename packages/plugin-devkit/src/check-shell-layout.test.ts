import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PERMISSION_RISK } from "../../../apps/desktop/src/features/plugins/model.js";
import { check } from "./check.js";
import { scaffold } from "./templates.js";

const created: string[] = [];

async function fixture(source: string, permissions: string[] = []): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-devkit-shell-"));
  created.push(root);
  const dir = join(root, "plugin");
  await scaffold({ dir, template: "panel-basic" });
  const manifestPath = join(dir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.permissions = [...manifest.permissions, ...permissions];
  await writeFile(manifestPath, JSON.stringify(manifest));
  await writeFile(join(dir, manifest.main), source);
  return dir;
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("shell layout permission", () => {
  it.each(["shell.setSidebar", "shell.setWorkPanel", "workPanel.activateTab"])(
    "warns when %s is called without ui.shell",
    async (method) => {
      const dir = await fixture(`export async function onLoad() { await pi.${method}({}); }`);
      const result = await check(dir);
      expect(result.ok).toBe(true);
      const warning = result.warnings.find((item) => item.code === "permission.shell-missing");
      expect(warning?.message).toContain(method);
      expect(warning?.message).toContain('"ui.shell"');
    },
  );

  it("accepts ui.shell and recognizes mutations as use of the permission", async () => {
    const dir = await fixture(
      'export async function onLoad() { await pi.shell.setSidebar({ collapsed: true }); }',
      ["ui.shell"],
    );
    const result = await check(dir);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings.some((item) => item.code === "permission.shell-missing")).toBe(false);
    expect(result.warnings.some((item) => item.code === "permission.unused" && item.message.includes('"ui.shell"'))).toBe(false);
  });

  it("does not require a grant for reads or layout subscriptions", async () => {
    const dir = await fixture(`export async function onLoad() {
      await pi.shell.getLayout();
      await pi.workPanel.listTabs();
      pi.events.on("shell:layout", () => {});
    }`);
    const result = await check(dir);
    expect(result.ok).toBe(true);
    expect(result.warnings.some((item) => item.code === "permission.shell-missing")).toBe(false);
  });

  it("does not count read access as use of a declared mutation grant", async () => {
    const dir = await fixture(
      "export async function onLoad() { await pi.shell.getLayout(); await pi.workPanel.listTabs(); }",
      ["ui.shell"],
    );
    const result = await check(dir);
    expect(result.warnings.some((item) => item.code === "permission.unused" && item.message.includes('"ui.shell"'))).toBe(true);
  });

  it("labels the medium-risk grant in every shipped locale", async () => {
    expect(PERMISSION_RISK["ui.shell"]).toBe("medium");
    const locales = import.meta.glob<Record<string, { plugins: {
      permissions: Record<string, string>;
      permissionHelp: Record<string, string>;
    } }>>("../../i18n/src/locales/*/index.ts");
    expect(Object.keys(locales)).toHaveLength(9);
    for (const load of Object.values(locales)) {
      const resource = Object.values(await load())[0];
      expect(resource.plugins.permissions["ui.shell"]).toBeTruthy();
      expect(resource.plugins.permissionHelp["ui.shell"]).toBeTruthy();
    }
  });
});
