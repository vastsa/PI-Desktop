import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { check } from "./check.js";
import { TEMPLATE_NAMES, scaffold } from "./templates.js";

const created: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-devkit-"));
  created.push(dir);
  return dir;
}

afterEach(async () => {
  while (created.length) {
    await rm(created.pop()!, { recursive: true, force: true });
  }
});

async function patchManifest(
  dir: string,
  mutate: (manifest: Record<string, any>) => void,
): Promise<void> {
  const path = join(dir, "manifest.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  mutate(manifest);
  await writeFile(path, JSON.stringify(manifest, null, 2), "utf8");
}

describe("scaffold", () => {
  it.each(TEMPLATE_NAMES)("produces a %s plugin that checks clean", async (template) => {
    const dir = join(await tempDir(), "my-plugin");
    const result = await scaffold({ dir, template });

    expect(result.id).toBe("local.my-plugin");
    expect(result.name).toBe("My Plugin");
    expect(result.files).toContain("manifest.json");
    expect(result.files).toContain("main.js");

    const checked = await check(dir);
    expect(checked.errors).toEqual([]);
    expect(checked.ok).toBe(true);
    expect(checked.manifest?.id).toBe("local.my-plugin");
  });

  it("wires each template's declared contributions", async () => {
    const panelDir = join(await tempDir(), "panel");
    await scaffold({ dir: panelDir, template: "panel-basic" });
    const panel = await check(panelDir);
    expect(panel.manifest?.ui?.panel).toBe("renderer/index.html");
    expect(panel.manifest?.permissions).toEqual(["ui.panel"]);
    const panelHtml = await readFile(join(panelDir, "renderer/index.html"), "utf8");
    expect(panelHtml).toContain('meta name="pi-plugin-chrome" content="v2"');
    expect(panelHtml).toContain("--pi-plugin-titlebar-height");
    expect(panelHtml).toContain("exactly a transparent 46px drag band");
    expect(panelHtml).toContain("band is not clickable outside the capsule");
    expect(panelHtml).toContain("visible panel header belongs");
    expect(panelHtml).not.toContain("#4f7cff");

    const fullDir = join(await tempDir(), "full");
    await scaffold({ dir: fullDir, template: "full-demo" });
    const full = await check(fullDir);
    expect(full.manifest?.contributes?.agentTools?.[0]?.name).toBe("echo_text");
    expect(full.manifest?.contributes?.skills).toEqual(["skills/full.md"]);
    expect(full.manifest?.permissions).toContain("agent.prompt.inject");
    expect(full.manifest?.contributes?.settings?.[0]?.key).toBe("greeting");
  });

  it("front-matters generated skill documents", async () => {
    const dir = join(await tempDir(), "skills-only");
    await scaffold({ dir, template: "skill-pack" });
    const doc = await readFile(join(dir, "skills/skills-only.md"), "utf8");
    expect(doc.startsWith("---\n")).toBe(true);
    expect(doc).toContain("name: Skills Only");
    expect((await check(dir)).warnings.map((w) => w.code)).not.toContain(
      "skill.no-frontmatter",
    );
  });

  it("honours an explicit id and name", async () => {
    const dir = join(await tempDir(), "whatever");
    const result = await scaffold({
      dir,
      template: "panel-basic",
      id: "demo.custom",
      name: "Custom Panel",
    });
    expect(result.id).toBe("demo.custom");
    expect((await check(dir)).manifest?.name).toBe("Custom Panel");
  });

  it("refuses a non-empty directory", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "keep.txt"), "mine", "utf8");
    await expect(scaffold({ dir, template: "panel-basic" })).rejects.toThrow(/not empty/);
  });

  it("rejects an unusable plugin id", async () => {
    const dir = join(await tempDir(), "bad");
    await expect(
      scaffold({ dir, template: "panel-basic", id: "../escape" }),
    ).rejects.toThrow(/must match/);
  });

  it("rejects an unknown template", async () => {
    const dir = join(await tempDir(), "unknown");
    await expect(
      scaffold({ dir, template: "nope" as never }),
    ).rejects.toThrow(/unknown template/);
  });
});

describe("check", () => {
  async function scaffolded(template: (typeof TEMPLATE_NAMES)[number] = "full-demo") {
    const dir = join(await tempDir(), "plugin");
    await scaffold({ dir, template });
    return dir;
  }

  it("reports a missing manifest", async () => {
    const result = await check(await tempDir());
    expect(result.ok).toBe(false);
    expect(result.errors[0].code).toBe("manifest.missing");
  });

  it("reports unparseable JSON", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "manifest.json"), "{ not json", "utf8");
    expect((await check(dir)).errors[0].code).toBe("manifest.invalid-json");
  });

  it("reports a manifest missing required fields", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "manifest.json"), JSON.stringify({ id: "x" }), "utf8");
    expect((await check(dir)).errors[0].code).toBe("manifest.invalid");
  });

  it("reports a missing entry file", async () => {
    const dir = await scaffolded("agent-tool-basic");
    await rm(join(dir, "main.js"));
    expect((await check(dir)).errors.map((e) => e.code)).toContain("main.missing");
  });

  it("reports a missing panel file", async () => {
    const dir = await scaffolded("panel-basic");
    await rm(join(dir, "renderer/index.html"));
    expect((await check(dir)).errors.map((e) => e.code)).toContain("panel.missing");
  });

  it("reports a missing skill file", async () => {
    const dir = await scaffolded("skill-pack");
    await rm(join(dir, "skills/plugin.md"));
    expect((await check(dir)).errors.map((e) => e.code)).toContain("skill.missing");
  });

  it("reports an empty skill file", async () => {
    const dir = await scaffolded("skill-pack");
    await writeFile(join(dir, "skills/plugin.md"), "   \n", "utf8");
    expect((await check(dir)).errors.map((e) => e.code)).toContain("skill.empty");
  });

  it("reports a skill path escaping the plugin directory", async () => {
    const dir = await scaffolded("skill-pack");
    await patchManifest(dir, (m) => {
      m.contributes.skills = ["../outside.md"];
    });
    // The SDK's own contribution validator rejects the escape first, so check
    // stops at the manifest — the same containment rule host-core applies.
    const result = await check(dir);
    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.code)).toContain("manifest.invalid");
    expect(result.errors[0]?.message).toMatch(/contributes\.skills path/);
  });

  it("accepts the object form of a skill entry", async () => {
    const dir = await scaffolded("skill-pack");
    await patchManifest(dir, (m) => {
      m.contributes.skills = [{ path: "skills/plugin.md", id: "custom" }];
    });
    expect((await check(dir)).ok).toBe(true);
  });

  it("reports an unknown permission", async () => {
    const dir = await scaffolded("panel-basic");
    await patchManifest(dir, (m) => {
      m.permissions = ["ui.panel", "fs.delete.everything"];
    });
    expect((await check(dir)).errors.map((e) => e.code)).toContain("permission.unknown");
  });

  it("requires agent.tool.register for contributed tools", async () => {
    const dir = await scaffolded("agent-tool-basic");
    await patchManifest(dir, (m) => {
      m.permissions = [];
    });
    expect((await check(dir)).errors.map((e) => e.code)).toContain(
      "permission.tools-missing",
    );
  });

  it("requires ui.panel for a contributed panel", async () => {
    const dir = await scaffolded("panel-basic");
    await patchManifest(dir, (m) => {
      m.permissions = [];
    });
    expect((await check(dir)).errors.map((e) => e.code)).toContain(
      "permission.panel-missing",
    );
  });

  it("rejects symlinks, which host-core refuses to copy", async () => {
    const dir = await scaffolded("panel-basic");
    await symlink(join(dir, "main.js"), join(dir, "link.js"));
    expect((await check(dir)).errors.map((e) => e.code)).toContain("package.symlink");
  });

  it("warns about high-risk permissions", async () => {
    const dir = await scaffolded("full-demo");
    expect((await check(dir)).warnings.map((w) => w.code)).toContain(
      "permission.high-risk",
    );
  });

  it("warns that a pre-scope fs permission is downgraded", async () => {
    const dir = await scaffolded("full-demo");
    await patchManifest(dir, (m) => {
      m.permissions = ["ui.panel", "agent.tool.register", "fs.read.workspace"];
      delete m.fs;
    });
    const warnings = (await check(dir)).warnings;
    expect((await check(dir)).errors).toEqual([]);
    expect(warnings.map((w) => w.code)).toContain("permission.legacy-fs");
    expect(warnings.find((w) => w.code === "permission.legacy-fs")?.message).toContain(
      "fs.read",
    );
  });

  it("warns when fs.write or fs.delete carries no scope", async () => {
    const dir = await scaffolded("full-demo");
    await patchManifest(dir, (m) => {
      delete m.fs;
    });
    const warnings = (await check(dir)).warnings.filter(
      (w) => w.code === "permission.fs-no-scope",
    );
    expect(warnings.map((w) => w.message.match(/fs\.\w+/)?.[0])).toEqual([
      "fs.write",
      "fs.delete",
    ]);
  });

  it("warns when skills are declared without agent.prompt.inject", async () => {
    const dir = await scaffolded("skill-pack");
    await patchManifest(dir, (m) => {
      m.permissions = [];
    });
    expect((await check(dir)).warnings.map((w) => w.code)).toContain(
      "permission.skills-inert",
    );
  });

  it("warns about a declared permission the entry never uses", async () => {
    const dir = await scaffolded("panel-basic");
    await patchManifest(dir, (m) => {
      m.permissions = ["ui.panel", "clipboard.read"];
    });
    const warnings = (await check(dir)).warnings;
    expect(warnings.map((w) => w.code)).toContain("permission.unused");
    expect(warnings.find((w) => w.code === "permission.unused")?.message).toContain(
      "clipboard.read",
    );
  });

  it("warns when the manifest contributes nothing", async () => {
    const dir = await tempDir();
    await writeFile(
      join(dir, "manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: "demo.bare",
        name: "Bare",
        version: "0.1.0",
        main: "main.js",
      }),
      "utf8",
    );
    await writeFile(join(dir, "main.js"), "module.exports = {};\n", "utf8");
    expect((await check(dir)).warnings.map((w) => w.code)).toContain("contributes.empty");
  });

  it("ignores node_modules when counting package contents", async () => {
    const dir = await scaffolded("panel-basic");
    await mkdir(join(dir, "node_modules/dep"), { recursive: true });
    await writeFile(join(dir, "node_modules/dep/index.js"), "x".repeat(1024), "utf8");
    const result = await check(dir);
    expect(result.ok).toBe(true);
    // manifest.json, main.js, renderer/index.html, README.md
    expect(result.fileCount).toBe(4);
  });
});
