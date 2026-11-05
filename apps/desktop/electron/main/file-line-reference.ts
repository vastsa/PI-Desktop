import { realpathSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { projectFolderPaths } from "./workspace-roots.ts";

export function fileLinePathInProject(path: string, projectPath: string | null): boolean {
  if (typeof path !== "string" || !isAbsolute(path) || path.length > 4096 || /[\0\r\n]/.test(path)) return false;
  const canonical = (value: string) => {
    try { return realpathSync(value); } catch { return value; }
  };
  const target = canonical(path);
  return projectFolderPaths(projectPath).some(root => {
    const contains = (base: string, candidate: string) => {
      const child = relative(base, candidate);
      return child !== "" && child !== ".." && !/^\.\.[/\\]/.test(child) && !isAbsolute(child);
    };
    return contains(root, path) && contains(canonical(root), target);
  });
}
