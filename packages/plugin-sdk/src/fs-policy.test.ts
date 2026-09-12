import { describe, expect, it } from "vitest";
import {
  fsGlobIgnoresCase,
  isDeniedFsPath,
  isFsPathInScope,
  isWholeTreePattern,
  matchFsGlob,
  parseFsPolicy,
} from "./fs-policy.js";

describe("matchFsGlob", () => {
  it("keeps a single star inside one segment", () => {
    expect(matchFsGlob("README.md", "*.md")).toBe(true);
    expect(matchFsGlob("docs/guide.md", "*.md")).toBe(false);
  });

  it("lets a double star cross separators", () => {
    expect(matchFsGlob("docs/a/b.md", "docs/**")).toBe(true);
    expect(matchFsGlob("docs/a.md", "docs/**")).toBe(true);
    expect(matchFsGlob("src/a.md", "docs/**")).toBe(false);
  });

  it("normalizes separators and leading ./", () => {
    expect(matchFsGlob("docs\\a.md", "./docs/*.md")).toBe(true);
  });

  it("treats a literal space in the pattern as a space", () => {
    // The matcher parks `**` on a sentinel; a real space must survive it.
    expect(matchFsGlob("my docs/a.md", "my docs/**")).toBe(true);
    expect(matchFsGlob("myXdocs/a.md", "my docs/**")).toBe(false);
  });

  it("does not let a regex metacharacter in the pattern widen it", () => {
    expect(matchFsGlob("axb", "a.b")).toBe(false);
    expect(matchFsGlob("a.b", "a.b")).toBe(true);
  });

  it("lets **/ match zero segments so src/**/*.ts admits src/a.ts", () => {
    expect(matchFsGlob("src/a.ts", "src/**/*.ts")).toBe(true);
    expect(matchFsGlob("src/a/b.ts", "src/**/*.ts")).toBe(true);
    expect(matchFsGlob("src/a/b/c.ts", "src/**/*.ts")).toBe(true);
    expect(matchFsGlob("src/a.js", "src/**/*.ts")).toBe(false);
    expect(matchFsGlob("lib/a.ts", "src/**/*.ts")).toBe(false);
    expect(matchFsGlob("a.ts", "**/*.ts")).toBe(true);
    expect(matchFsGlob("x/y/a.ts", "**/*.ts")).toBe(true);
  });

  it("never admits a path with a .. segment", () => {
    expect(matchFsGlob("src/../secret.ts", "src/**")).toBe(false);
    expect(matchFsGlob("../src/a.ts", "**/*.ts")).toBe(false);
    expect(matchFsGlob("src/..hidden.ts", "src/**")).toBe(true);
  });

  it("treats a trailing slash as the directory and everything under it", () => {
    expect(matchFsGlob("docs/a.md", "docs/")).toBe(true);
    expect(matchFsGlob("docs/a/b.md", "docs/")).toBe(true);
    expect(matchFsGlob("docs", "docs/")).toBe(true);
    expect(matchFsGlob("docs/", "docs/**")).toBe(true);
    expect(matchFsGlob("docs2/a.md", "docs/")).toBe(false);
  });

  it("ignores case only where the platform file system does", () => {
    expect(matchFsGlob("README.MD", "*.md", { ignoreCase: true })).toBe(true);
    expect(matchFsGlob("README.MD", "*.md", { ignoreCase: false })).toBe(false);
    expect(matchFsGlob("README.MD", "*.md")).toBe(fsGlobIgnoresCase());
    const platform = (globalThis as { process?: { platform?: string } }).process?.platform;
    expect(fsGlobIgnoresCase()).toBe(platform === "win32" || platform === "darwin");
  });
});

describe("isWholeTreePattern", () => {
  it("catches every spelling of everything", () => {
    for (const pattern of ["*", "**", "**/*", "*/**", "./**", "/*", "**/**", "./*"]) {
      expect(isWholeTreePattern(pattern), pattern).toBe(true);
    }
  });

  it("leaves a real scope alone", () => {
    for (const pattern of ["docs/**", "*.md", "dist/*", "a/**/*.ts"]) {
      expect(isWholeTreePattern(pattern), pattern).toBe(false);
    }
  });
});

describe("isDeniedFsPath", () => {
  it("refuses credential files wherever they sit", () => {
    for (const path of [
      ".env",
      ".env.local",
      "apps/web/.env",
      ".npmrc",
      "packages/x/.npmrc",
      "certs/server.pem",
      ".ssh/id_rsa",
      "backup/.ssh/config",
      "id_ed25519",
      ".git/config",
      ".git",
      "vendor/.aws/credentials",
    ]) {
      expect(isDeniedFsPath(path), path).toBe(true);
    }
  });

  it("leaves ordinary files alone", () => {
    for (const path of [
      "README.md",
      "src/index.ts",
      "docs/environment.md",
      "dist/bundle.js",
      "environments/prod.yaml",
    ]) {
      expect(isDeniedFsPath(path), path).toBe(false);
    }
  });

  it("cannot be dodged by casing or separators", () => {
    expect(isDeniedFsPath("apps\\web\\.ENV")).toBe(true);
    expect(isDeniedFsPath("./.git/HEAD")).toBe(true);
  });
});

describe("isFsPathInScope", () => {
  it("admits a path matched by any glob", () => {
    expect(isFsPathInScope("docs/a.md", ["dist/**", "docs/**"])).toBe(true);
    expect(isFsPathInScope("src/a.ts", ["dist/**", "docs/**"])).toBe(false);
  });

  it("admits nothing for an empty scope", () => {
    expect(isFsPathInScope("docs/a.md", [])).toBe(false);
  });
});

describe("parseFsPolicy", () => {
  it("treats an absent field as an empty policy", () => {
    expect(parseFsPolicy(undefined)).toEqual({ ok: true, policy: {} });
    expect(parseFsPolicy(null)).toEqual({ ok: true, policy: {} });
  });

  it("defaults the root to the workspace and normalizes the scope", () => {
    const result = parseFsPolicy({ write: { scope: ["./docs/**", "docs/**"] } });
    expect(result.ok).toBe(true);
    expect(result.policy?.write).toEqual({ root: "workspace", scope: ["docs/**"] });
  });

  it("lets read cover the whole tree but not write or delete", () => {
    expect(parseFsPolicy({ read: { scope: ["**/*"] } }).ok).toBe(true);
    for (const mode of ["write", "delete"] as const) {
      const result = parseFsPolicy({ [mode]: { scope: ["**/*"] } });
      expect(result.ok, mode).toBe(false);
      expect(result.error).toMatch(/must not cover the whole root/);
    }
  });

  it("accepts the userSelected root", () => {
    expect(parseFsPolicy({ read: { root: "userSelected" } }).policy?.read?.root).toBe(
      "userSelected",
    );
    expect(parseFsPolicy({ read: { root: "anywhere" } }).ok).toBe(false);
  });

  it("only lets delete claim its own writes", () => {
    expect(parseFsPolicy({ delete: { own: true } }).policy?.delete?.own).toBe(true);
    const result = parseFsPolicy({ write: { own: true, scope: ["docs/**"] } });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/does not support "own"/);
  });

  it("rejects a scope that reaches outside its root", () => {
    for (const pattern of ["/etc/**", "../**", "C:/Users/**", "a/../../b"]) {
      const result = parseFsPolicy({ write: { scope: [pattern] } });
      expect(result.ok, pattern).toBe(false);
    }
  });

  it("rejects unknown modes and malformed rules", () => {
    expect(parseFsPolicy({ execute: {} }).error).toMatch(/not a recognized mode/);
    expect(parseFsPolicy({ read: [] }).error).toMatch(/must be an object/);
    expect(parseFsPolicy({ read: { scope: "docs/**" } }).error).toMatch(/must be an array/);
    expect(parseFsPolicy([]).error).toMatch(/fs must be an object/);
  });
});
