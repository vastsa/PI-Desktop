import { describe, expect, it } from "vitest";
import { remoteMutationIdentity } from "./remote-workspace.js";

describe("remote mutation bookkeeping", () => {
  it("uses POSIX lexical paths and host identity without consulting local canonical paths", () => {
    expect(remoteMutationIdentity({ hostKey: "ssh-a", path: "/remote/project" }, "src/../README.md"))
      .toBe('["ssh-a","/remote/project/README.md"]');
    expect(remoteMutationIdentity({ hostKey: "ssh-b", path: "/remote/project" }, "README.md"))
      .not.toBe(remoteMutationIdentity({ hostKey: "ssh-a", path: "/remote/project" }, "README.md"));
    expect(remoteMutationIdentity({ hostKey: "ssh-a", path: "/remote/project" }, "Readme.md"))
      .not.toBe(remoteMutationIdentity({ hostKey: "ssh-a", path: "/remote/project" }, "README.md"));
  });
});
