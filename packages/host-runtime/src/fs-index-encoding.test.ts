import * as childProcess from "node:child_process";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { getWorkspaceFileIndex, searchWorkspaceFiles } from "./fs-index.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof childProcess>(),
  spawn: vi.fn(),
}));

afterEach(() => vi.clearAllMocks());

it.each([1, 2, 3, 7])("preserves UTF-8 file names across %i-byte Git chunks", async (chunkSize) => {
  const stdout = new PassThrough();
  const child = new childProcess.ChildProcess();
  child.stdout = stdout;
  vi.mocked(childProcess.spawn).mockReturnValueOnce(child);
  stdout.on("end", () => child.emit("close", 0));

  const paths = ["README.md", "src/café.ts", "src/竞赛.ts", "src/🚀.ts"];
  const output = Buffer.from([...paths, "node_modules/pkg/竞赛.ts", ""].join("\0"));
  const root = `/pi-index-encoding-${chunkSize}`;
  const pending = getWorkspaceFileIndex(root);
  for (let offset = 0; offset < output.length; offset += chunkSize) {
    stdout.write(output.subarray(offset, offset + chunkSize));
  }
  stdout.end();

  const index = await pending;
  expect(index.truncated).toBe(false);
  expect(index.entries.filter((entry) => entry.kind === "file").map((entry) => entry.path).sort())
    .toEqual([...paths].sort());
  expect(index.entries).toContainEqual({ path: "src", kind: "dir" });
  expect((await searchWorkspaceFiles(root, "竞赛")).entries)
    .toEqual([{ path: "src/竞赛.ts", kind: "file" }]);
});
