import { describe, expect, it } from "vitest";
import { BUILTIN_SKILL_CATALOG } from "./skill-catalog-builtin.js";
import {
  skillEntryError,
  splitSkillDocument,
  toSkillInput,
  validateSkillCatalogFile,
  type SkillCatalogEntry,
} from "./skill-catalog.js";

const entry: SkillCatalogEntry = {
  id: "docx",
  name: "Word 文档",
  description: "处理 .docx",
  url: "https://raw.githubusercontent.com/anthropics/skills/main/skills/docx/SKILL.md",
  categories: ["docs"],
  verified: true,
};

describe("skillEntryError", () => {
  it("rejects bad ids and non-https urls", () => {
    expect(skillEntryError({ ...entry, id: "1bad" })).toContain("bad id");
    expect(skillEntryError({ ...entry, url: "http://x/SKILL.md" })).toContain("https");
    expect(skillEntryError({ ...entry, url: "not a url" })).toContain("parse");
    expect(skillEntryError(entry)).toBeNull();
  });
});

describe("splitSkillDocument", () => {
  it("strips frontmatter and extracts metadata", () => {
    const doc = '---\nname: Review\ndescription: Check code\n---\n\nDo it.\n';
    expect(splitSkillDocument(doc)).toEqual({ name: "Review", description: "Check code", body: "Do it.\n" });
  });

  it("keeps the whole text when there is no frontmatter", () => {
    expect(splitSkillDocument("Just do it.")).toEqual({ body: "Just do it." });
  });

  it("does not treat a later --- as frontmatter", () => {
    const doc = "intro\n\n---\n\nseparator\n";
    expect(splitSkillDocument(doc).body).toBe(doc);
  });
});

describe("toSkillInput", () => {
  it("prefers document metadata over the catalog entry", () => {
    const input = toSkillInput(entry, { name: "Frontmatter Name", body: "Body text" });
    expect(input).toMatchObject({ id: "docx", name: "Frontmatter Name", description: "处理 .docx", body: "Body text", enabled: true });
  });

  it("falls back to entry metadata when the document has none", () => {
    const input = toSkillInput(entry, { body: "Body" });
    expect(input.name).toBe("Word 文档");
    expect(input.description).toBe("处理 .docx");
  });
});

describe("validateSkillCatalogFile", () => {
  it("passes a valid file and skips broken entries", () => {
    const { catalog, warnings } = validateSkillCatalogFile({
      schemaVersion: 1,
      updatedAt: "2026-09-12",
      skills: [entry, { id: "broken" }, { ...entry, id: "dup" }, entry],
    });
    expect(catalog.skills.map((s) => s.id)).toEqual(["docx", "dup"]);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("broken");
  });
});

describe("BUILTIN_SKILL_CATALOG", () => {
  it("is valid with unique ids and live https documents", () => {
    const { catalog, warnings } = validateSkillCatalogFile(BUILTIN_SKILL_CATALOG);
    expect(warnings).toEqual([]);
    expect(catalog.skills.length).toBeGreaterThanOrEqual(8);
    expect(new Set(catalog.skills.map((s) => s.id)).size).toBe(catalog.skills.length);
    for (const skill of catalog.skills) {
      const liveHost =
        skill.url.startsWith("https://raw.githubusercontent.com/") ||
        skill.url.startsWith("https://cdn.jsdelivr.net/gh/");
      expect(liveHost).toBe(true);
      expect(skill.url.endsWith("SKILL.md")).toBe(true);
    }
  });
});
