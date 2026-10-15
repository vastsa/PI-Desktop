import { execFile } from "node:child_process";
import type { symlink } from "node:fs";
import { join } from "node:path";

/**
 * Classify each path as a junction, a directory symlink, or a file symlink,
 * reading the reparse point — not its target — so dangling links classify
 * too. A directory attribute alone cannot tell these apart (#1686): a
 * directory symlink carries it just like a junction does, which used to
 * rewrite every `mklink /D` link into a junction and wedged the migration on
 * UNC-targeted links that junctions cannot point at.
 */
export async function storageLinkTypes(paths: string[]): Promise<Array<symlink.Type | undefined>> {
  if (process.platform !== "win32") return paths.map(() => undefined);
  if (!paths.length) return [];
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot) throw new Error("Windows system directory is unavailable.");
  // One statement: -Command joins on semicolons, and a semicolon between an
  // `if` and its `elseif` breaks PowerShell's statement structure.
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)",
    "$paths = ConvertFrom-Json ([Console]::In.ReadToEnd())",
    "$types = @(foreach ($path in $paths) { $type = 'file'; try { $item = Get-Item -LiteralPath $path -Force; if ($item.LinkType -eq 'Junction') { $type = 'junction' } elseif ($item.LinkType -eq 'SymbolicLink') { $target = [string]$item.Target; if ($target -and -not [IO.Path]::IsPathRooted($target)) { $target = Join-Path $item.DirectoryName $target }; if ($target -and (Test-Path -LiteralPath $target -ErrorAction SilentlyContinue)) { if (([IO.File]::GetAttributes($target) -band [IO.FileAttributes]::Directory) -ne 0) { $type = 'dir' } else { $type = 'file' } } elseif (($item.Attributes -band [IO.FileAttributes]::Directory) -ne 0) { $type = 'dir' } else { $type = 'file' } } else { if (([IO.File]::GetAttributes($path) -band [IO.FileAttributes]::Directory) -ne 0) { $type = 'junction' } else { $type = 'file' } } } catch { $type = if (([IO.File]::GetAttributes($path) -band [IO.FileAttributes]::Directory) -ne 0) { 'dir' } else { 'file' } }; $type })",
    "ConvertTo-Json -InputObject $types -Compress",
  ].join("; ");
  const output = await new Promise<string>((resolve, reject) => {
    const child = execFile(join(systemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => error ? reject(error) : resolve(stdout));
    child.stdin?.on("error", reject);
    child.stdin?.end(JSON.stringify(paths));
  });
  const types: unknown = JSON.parse(output);
  if (!Array.isArray(types) || types.length !== paths.length
    || !types.every((type): type is symlink.Type => type === "junction" || type === "dir" || type === "file")) {
    throw new Error("Could not determine Windows storage link types.");
  }
  return types;
}
