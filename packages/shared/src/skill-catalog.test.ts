import { describe, expect, it } from "vitest";
import { BUILTIN_SKILL_CATALOG } from "./skill-catalog-builtin.js";
import {
  assembleSkillInstall,
  expandSkillResources,
  isSafeSkillSourceUrl,
  MAX_SKILL_DOCUMENT_BYTES,
  sanitizeSkillCatalogId,
  sanitizeSkillSources,
  skillEntryError,
  splitSkillDocument,
  toSkillInput,
  validateSkillCatalogFile,
  type SkillCatalogEntry,
} from "./skill-catalog.js";

const entry: SkillCatalogEntry = {
  id: "docx",
  name: "Word documents",
  description: "Handle .docx",
  url: "https://raw.githubusercontent.com/anthropics/skills/main/skills/docx/SKILL.md",
  categories: ["docs"],
  verified: true,
};

describe("skillEntryError", () => {
  it("rejects illegal ids and non-https urls", () => {
    expect(skillEntryError({ ...entry, id: "has_underscore" })).toContain("bad id");
    expect(skillEntryError({ ...entry, id: "Bad" })).toContain("bad id");
    expect(skillEntryError({ ...entry, url: "http://x/SKILL.md" })).toContain("https");
    expect(skillEntryError({ ...entry, url: "not a url" })).toContain("parse");
    expect(skillEntryError(entry)).toBeNull();
    expect(skillEntryError({ ...entry, id: "1-pdf" })).toBeNull();
  });
});

describe("sanitizeSkillCatalogId", () => {
  it("matches host valid_capability_id", () => {
    expect(sanitizeSkillCatalogId("Frontend_Design", "skill-0")).toBe("frontend-design");
    expect(sanitizeSkillCatalogId("1-pdf", "skill-0")).toBe("1-pdf");
    expect(sanitizeSkillCatalogId("***", "skill-7")).toBe("skill-7");
  });
});

describe("splitSkillDocument", () => {
  it("strips frontmatter and extracts metadata", () => {
    const doc = "---\nname: Review\ndescription: Check code\n---\n\nDo it.\n";
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
    expect(input).toMatchObject({
      id: "docx",
      name: "Frontmatter Name",
      description: "Handle .docx",
      body: "Body text",
      enabled: true,
    });
  });

  it("falls back to entry metadata when the document has none", () => {
    const input = toSkillInput(entry, { body: "Body" });
    expect(input.name).toBe("Word documents");
    expect(input.description).toBe("Handle .docx");
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

  it("sanitizes underscored ids without mutating the input", () => {
    const raw = { ...entry, id: "Foo_Bar" };
    const { catalog, warnings } = validateSkillCatalogFile({ skills: [raw] });
    expect(raw.id).toBe("Foo_Bar");
    expect(catalog.skills[0].id).toBe("foo-bar");
    expect(warnings).toEqual([]);
  });
});

describe("BUILTIN_SKILL_CATALOG", () => {
  it("is valid with unique ids, English names, and live https documents", () => {
    const { catalog, warnings } = validateSkillCatalogFile(BUILTIN_SKILL_CATALOG);
    expect(warnings).toEqual([]);
    expect(catalog.skills.length).toBeGreaterThanOrEqual(8);
    expect(new Set(catalog.skills.map((s) => s.id)).size).toBe(catalog.skills.length);
    for (const skill of catalog.skills) {
      expect(/[^\u0000-\u007f]/.test(skill.name)).toBe(false);
      const liveHost =
        skill.url.startsWith("https://raw.githubusercontent.com/") ||
        skill.url.startsWith("https://cdn.jsdelivr.net/gh/");
      expect(liveHost).toBe(true);
      expect(skill.url.endsWith("SKILL.md")).toBe(true);
    }
  });
});

describe("expandSkillResources", () => {
  it("returns the body untouched without resources", () => {
    expect(expandSkillResources({ body: "Body." }, [])).toBe("Body.");
  });

  it("appends each resource as a fenced appendix", () => {
    const out = expandSkillResources({ body: "Main body." }, [
      { path: "FORMS.md", body: "Forms content." },
      { path: "scripts/run.md", body: "Run it." },
    ]);
    expect(out).toContain("Main body.");
    expect(out).toContain("# Attached resource: FORMS.md");
    expect(out).toContain("Forms content.");
    expect(out).toContain("# Attached resource: scripts/run.md");
  });
});

describe("assembleSkillInstall", () => {
  it("expands resources and reports the host document size", () => {
    const assembled = assembleSkillInstall(
      { name: "pdf", body: "Read FORMS.md.", resources: [{ path: "FORMS.md", body: "Forms." }] },
      { name: "pdf" },
    );
    expect(assembled.body).toContain("Read FORMS.md.");
    expect(assembled.body).toContain("# Attached resource: FORMS.md");
    expect(assembled.tooLarge).toBe(false);
  });

  it("flags documents that would exceed the host byte cap", () => {
    const assembled = assembleSkillInstall(
      { body: "x".repeat(MAX_SKILL_DOCUMENT_BYTES) },
      { name: "huge" },
    );
    expect(assembled.tooLarge).toBe(true);
    expect(assembled.bytes).toBeGreaterThan(MAX_SKILL_DOCUMENT_BYTES);
  });
});

/**
 * A skill market source URL is an address the user typed into a settings field,
 * so their own machine and their own LAN are reachable. A document URL that
 * arrives *inside* a catalog is content the app did not receive from them and
 * keeps the public-only policy in `skill-market-scan.ts` instead.
 */
describe("skill market source URLs", () => {
  it("accepts a source the user runs on loopback or the LAN", () => {
    expect(isSafeSkillSourceUrl("https://127.0.0.1/catalog.json")).toBe(true);
    expect(isSafeSkillSourceUrl("https://192.168.1.5:8443/catalog.json")).toBe(true);
    expect(isSafeSkillSourceUrl("https://nas.local/catalog.json")).toBe(true);
    expect(isSafeSkillSourceUrl("https://[fd00::1]/catalog.json")).toBe(true);
    expect(isSafeSkillSourceUrl("https://cdn.jsdelivr.net/gh/x/SKILL.md")).toBe(true);
  });

  it("keeps the classes that name no service, and cloud metadata, refused", () => {
    expect(isSafeSkillSourceUrl("https://169.254.169.254/catalog.json")).toBe(false);
    expect(isSafeSkillSourceUrl("https://100.100.100.200/catalog.json")).toBe(false);
    expect(isSafeSkillSourceUrl("https://metadata.google.internal/catalog.json")).toBe(false);
    expect(isSafeSkillSourceUrl("https://[2001:db8::1]/catalog.json")).toBe(false);
    expect(isSafeSkillSourceUrl("https://user:pass@example.com/catalog.json")).toBe(false);
    expect(isSafeSkillSourceUrl("file:///etc/passwd")).toBe(false);
  });

  it("wants the stored opt-in before a plaintext source is accepted", () => {
    expect(isSafeSkillSourceUrl("http://10.0.0.7:8080/catalog.json")).toBe(false);
    expect(
      isSafeSkillSourceUrl("http://10.0.0.7:8080/catalog.json", { allowInsecureHttp: true }),
    ).toBe(true);
    // The opt-in is the only thing the flag buys: it never admits a class the
    // user could not have meant.
    expect(
      isSafeSkillSourceUrl("http://169.254.169.254/catalog.json", { allowInsecureHttp: true }),
    ).toBe(false);
  });

  it("repairs a persisted source list under the same policy", () => {
    const ids = (list: ReturnType<typeof sanitizeSkillSources>) =>
      list.map((source) => source.id);
    expect(
      ids(
        sanitizeSkillSources([
          { id: "lan", name: "LAN", url: "https://192.168.1.5:8443/catalog.json" },
          { id: "meta", name: "Meta", url: "https://169.254.169.254/catalog.json" },
          { id: "plain", name: "Plain", url: "http://10.0.0.7:8080/catalog.json" },
        ]),
      ),
    ).toEqual(["lan"]);
    expect(
      ids(
        sanitizeSkillSources(
          [
            { id: "lan", name: "LAN", url: "https://192.168.1.5:8443/catalog.json" },
            { id: "plain", name: "Plain", url: "http://10.0.0.7:8080/catalog.json" },
          ],
          { allowInsecureHttp: true },
        ),
      ),
    ).toEqual(["lan", "plain"]);
  });
});
