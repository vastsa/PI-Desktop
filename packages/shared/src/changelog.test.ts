import { describe, expect, it } from "vitest";
import {
  CHANGELOG,
  formatChangelogNotes,
  getChangelogEntry,
  normalizeChangelogVersion,
  resolveChangelogLocale,
} from "./changelog.js";

const STABLE_FROM = "0.1.1";

describe("changelog catalog", () => {
  it("keeps English and zh-CN version sets and highlight counts aligned", () => {
    const en = CHANGELOG.en;
    const zh = CHANGELOG["zh-CN"];
    expect(zh.map((e) => e.version)).toEqual(en.map((e) => e.version));
    for (let i = 0; i < en.length; i += 1) {
      expect(zh[i]?.highlights.length).toBe(en[i]?.highlights.length);
      expect(en[i]?.highlights.length).toBeGreaterThan(0);
    }
  });

  it("lists stable releases from 0.1.1 newest-first without pre-releases", () => {
    const versions = CHANGELOG.en.map((e) => e.version);
    expect(versions[0]).toBe("0.13.0");
    expect(versions.at(-1)).toBe(STABLE_FROM);
    // 0.11.1 is intentionally absent: that tag was pushed before the release
    // branch was complete, and 0.11.2 is the tag that actually ships its
    // highlights. The in-app changelog lists shipped releases, not tags.
    expect(versions).toEqual([
      "0.13.0",
      "0.12.4",
      "0.12.3",
      "0.12.2",
      "0.12.1",
      "0.12.0",
      "0.11.4",
      "0.11.3",
      "0.11.2",
      "0.11.0",
      "0.10.9",
      "0.10.8",
      "0.10.7",
      "0.10.6",
      "0.10.5",
      "0.10.4",
      "0.10.3",
      "0.10.2",
      "0.10.1",
      "0.10.0",
      "0.9.1",
      "0.9.0",
      "0.8.1",
      "0.8.0",
      "0.7.0",
      "0.6.0",
      "0.5.11",
      "0.5.10",
      "0.5.9",
      "0.5.8",
      "0.5.7",
      "0.5.6",
      "0.5.5",
      "0.5.4",
      "0.5.0",
      "0.4.3",
      "0.4.2",
      "0.4.1",
      "0.4.0",
      "0.3.0",
      "0.2.11",
      "0.2.10",
      "0.2.8",
      "0.2.7",
      "0.2.6",
      "0.2.5",
      "0.2.4",
      "0.2.3",
      "0.2.2",
      "0.2.1",
      "0.2.0",
      "0.1.1",
    ]);
    for (const version of versions) {
      expect(version).not.toMatch(/-/);
    }
  });

  it("normalizes versions and resolves locales", () => {
    expect(normalizeChangelogVersion(" v0.2.7 ")).toBe("0.2.7");
    expect(resolveChangelogLocale("zh-CN")).toBe("zh-CN");
    expect(resolveChangelogLocale("zh-TW")).toBe("zh-CN");
    expect(resolveChangelogLocale("en-US")).toBe("en");
    expect(resolveChangelogLocale()).toBe("en");
  });

  it("looks up and formats notes with English fallback", () => {
    const entry = getChangelogEntry("v0.1.1", "en");
    expect(entry?.version).toBe("0.1.1");
    const notes = formatChangelogNotes("0.2.7", "en");
    expect(notes).toMatch(/^• /);
    expect(notes?.split("\n").length).toBe(
      getChangelogEntry("0.2.7", "en")?.highlights.length,
    );
    expect(formatChangelogNotes("9.9.9", "en")).toBeUndefined();
    expect(formatChangelogNotes("0.2.0-rc.6", "en")).toBeUndefined();
  });
});
