import { describe, expect, it } from "vitest";
import { memoryPromptSection, memorySnapshotContext } from "./memory-prompt.js";
import { MEMORY_BLOCK_HEADERS } from "./memory-store.js";

describe("memoryPromptSection", () => {
  it("renders nothing when both stores are empty", () => {
    expect(memoryPromptSection(undefined)).toBeUndefined();
    expect(memoryPromptSection({ memory: [], user: [] })).toBeUndefined();
    // Whitespace-only entries are not content.
    expect(memoryPromptSection({ memory: ["   "], user: [] })).toBeUndefined();
  });

  it("renders both blocks with their headers", () => {
    const section = memoryPromptSection({
      memory: ["deploys go out on fridays"],
      user: ["prefers Chinese replies"],
    });
    expect(section).toContain("# Memory");
    expect(section).toContain(MEMORY_BLOCK_HEADERS.memory);
    expect(section).toContain(MEMORY_BLOCK_HEADERS.user);
    expect(section).toContain("- deploys go out on fridays");
    expect(section).toContain("- prefers Chinese replies");
  });

  it("renders only the target that has content", () => {
    const section = memoryPromptSection({ memory: [], user: ["prefers Chinese replies"] });
    expect(section).toContain(MEMORY_BLOCK_HEADERS.user);
    expect(section).not.toContain(MEMORY_BLOCK_HEADERS.memory);
  });

  it("says the snapshot is frozen so a mid-session write is not a surprise", () => {
    // The tool result echoes the new list; without this line the agent would
    // expect its own write to be visible in the prompt and could loop trying.
    const section = memoryPromptSection({ memory: ["a"], user: [] }) ?? "";
    expect(section).toContain("snapshot was taken when the session started");
    expect(section).toContain("will not appear here");
  });

  it("keeps memory above the user profile", () => {
    const section =
      memoryPromptSection({ memory: ["note"], user: ["profile"] }) ?? "";
    expect(section.indexOf(MEMORY_BLOCK_HEADERS.memory)).toBeLessThan(
      section.indexOf(MEMORY_BLOCK_HEADERS.user),
    );
  });
});

describe("memorySnapshotContext", () => {
  it("renders the snapshot for a user-message prefix", () => {
    const block = memorySnapshotContext({
      memory: ["PowerShell scripts must be UTF-8 with BOM"],
      user: ["prefers Chinese replies"],
    });
    expect(block).toContain("carried with this message");
    expect(block).toContain("- PowerShell scripts must be UTF-8 with BOM");
    expect(block).toContain("- prefers Chinese replies");
  });

  it("renders nothing when there is nothing to carry", () => {
    expect(memorySnapshotContext(undefined)).toBeUndefined();
    expect(memorySnapshotContext({ memory: [], user: [] })).toBeUndefined();
  });
});
