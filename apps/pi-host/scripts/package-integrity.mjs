import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Standard sha256sum records, restricted to unambiguous relative file names. */
export function writePackageManifest(root) {
  const records = [];
  function visit(directory, prefix = "") {
    for (const name of readdirSync(directory).sort()) {
      const relative = prefix + name;
      if (!/^[A-Za-z0-9_./@+-]+$/.test(relative) || relative.split("/").some((part) => part === "." || part === "..")) {
        throw new Error(`Unsafe package path: ${relative}`);
      }
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (stat.isDirectory()) visit(path, `${relative}/`);
      else if (stat.isFile()) {
        if (relative !== "SHA256SUMS") records.push(`${createHash("sha256").update(readFileSync(path)).digest("hex")}  ${relative}\n`);
      } else throw new Error(`Non-regular package file: ${relative}`);
    }
  }
  visit(root);
  writeFileSync(join(root, "SHA256SUMS"), records.join(""));
}
