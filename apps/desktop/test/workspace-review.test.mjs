import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

const {
  reviewChangeFromMessage,
  reviewChangesFromMessage,
  reviewChangesMetadataFromMessage,
  reviewChangesFromMessages,
  reviewCaptureFromMessage,
  withReviewChangeState,
} = await import("../src/lib/workspace-review.ts");

const review = (snapshotId, path, extra = {}) => ({
  version: 1,
  snapshotId,
  messageId: "shell-message",
  path,
  operation: "edit",
  status: "modified",
  state: "active",
  additions: 2,
  deletions: 1,
  hunks: [],
  reversible: true,
  ...extra,
});

const tool = (overrides = {}) => ({
  id: "shell-message",
  role: "tool",
  content: "",
  createdAt: "2026-09-20T00:00:00.000Z",
  toolName: "Bash",
  toolStatus: "success",
  toolResult: {
    details: {
      root: "workspace",
      reviews: [
        review("snapshot-html", "index.html"),
        review("snapshot-css", "styles.css"),
      ],
      reviewCapture: { status: "complete" },
    },
  },
  ...overrides,
});

test("legacy single review behavior is preserved", () => {
  const message = tool({
    toolName: "Edit",
    toolResult: {
      details: {
        root: "workspace",
        review: review("snapshot-legacy", "src/legacy.ts"),
      },
    },
  });

  assert.equal(reviewChangeFromMessage(message)?.snapshotId, "snapshot-legacy");
  assert.deepEqual(
    reviewChangesFromMessage(message).map((change) => change.path),
    ["src/legacy.ts"],
  );
});

test("executed Bash accepts valid reviews on success and error", () => {
  assert.deepEqual(
    reviewChangesFromMessage(tool()).map((change) => change.path),
    ["index.html", "styles.css"],
  );
  assert.deepEqual(
    reviewChangesFromMessage(tool({ toolStatus: "error" })).map(
      (change) => change.path,
    ),
    ["index.html", "styles.css"],
  );
  assert.equal(
    reviewChangesFromMessage(tool({ toolStatus: "denied" })).length,
    0,
  );
  assert.equal(
    reviewChangesFromMessage(tool({ toolStatus: "running" })).length,
    0,
  );
});

test("review records validate independently and dedupe by snapshot id", () => {
  const duplicate = review("snapshot-html", "index.html", { additions: 9 });
  const invalid = { ...review("snapshot-invalid", "bad.txt"), additions: -1 };
  const message = tool({
    toolResult: {
      details: {
        root: "workspace",
        review: review("snapshot-legacy", "legacy.txt"),
        reviews: [invalid, review("snapshot-html", "old.html"), duplicate],
        reviewCapture: { status: "complete" },
      },
    },
  });
  const changes = reviewChangesFromMessage(message);

  assert.deepEqual(
    changes.map((change) => change.snapshotId),
    ["snapshot-legacy", "snapshot-html"],
  );
  assert.equal(changes[1].path, "index.html");
  assert.equal(changes[1].additions, 9);

  const latest = reviewChangesFromMessages([
    message,
    tool({
      id: "later",
      toolResult: {
        details: {
          root: "workspace",
          reviews: [review("snapshot-html", "latest.html")],
          reviewCapture: { status: "complete" },
        },
      },
    }),
  ]);
  assert.equal(latest.find((entry) => entry.change.snapshotId === "snapshot-html")?.change.path, "latest.html");
});

test("capture metadata distinguishes complete, partial and legacy unavailable", () => {
  assert.equal(reviewCaptureFromMessage(tool()), "complete");
  assert.equal(
    reviewCaptureFromMessage(
      tool({
        toolResult: {
          details: {
            root: "workspace",
            reviews: [],
            reviewCapture: { status: "partial" },
          },
        },
      }),
    ),
    "partial",
  );
  assert.equal(
    reviewCaptureFromMessage(
      tool({ toolResult: { details: { exitCode: 0 } } }),
    ),
    "unavailable",
  );
  assert.equal(reviewCaptureFromMessage(tool({ toolStatus: "denied" })), null);
});

test("rollback state updates only the requested snapshot in review and reviews", () => {
  const message = tool({
    toolResult: {
      details: {
        root: "workspace",
        review: review("snapshot-html", "index.html"),
        reviews: [
          review("snapshot-html", "index.html"),
          review("snapshot-css", "styles.css"),
        ],
        reviewCapture: { status: "complete" },
      },
    },
  });
  const updated = withReviewChangeState(message, "rolledBack", "snapshot-css");
  const details = updated.toolResult.details;

  assert.equal(details.review.state, "active");
  assert.equal(details.reviews[0].state, "active");
  assert.equal(details.reviews[1].state, "rolledBack");
  assert.equal(reviewChangesFromMessage(updated)[1].state, "rolledBack");
});

test("session review history includes delegate records with original identities", () => {
  const parent = tool();
  const nested = tool({
    id: "nested-edit",
    toolName: "Edit",
    parentToolCallId: "parent-task-call",
    toolResult: {
      details: {
        root: "workspace",
        review: review("snapshot-nested", "delegate.ts"),
      },
    },
  });
  const orphan = tool({
    id: "orphan-edit",
    toolName: "Edit",
    parentToolCallId: "missing-task-call",
    toolResult: {
      details: {
        root: "workspace",
        review: review("snapshot-orphan", "orphan.ts"),
      },
    },
  });
  const rolledBack = tool({
    ...nested,
    toolResult: {
      details: {
        root: "workspace",
        review: review("snapshot-nested", "delegate.ts", {
          state: "rolledBack",
        }),
      },
    },
  });

  const entries = reviewChangesFromMessages([parent, nested, orphan, rolledBack]);
  assert.deepEqual(
    entries.map((entry) => entry.change.path),
    ["index.html", "styles.css", "orphan.ts", "delegate.ts"],
  );
  const delegateEntry = entries.at(-1);
  assert.equal(delegateEntry.message, rolledBack);
  assert.equal(delegateEntry.change.snapshotId, "snapshot-nested");
  assert.equal(delegateEntry.change.state, "rolledBack");
});

test("only Bash records with an exact .gradle path segment are hidden", () => {
  const bash = tool({
    toolResult: {
      details: {
        root: "workspace",
        reviews: [
          review("gradle-root", ".gradle/caches/root.bin", { binary: true }),
          review("gradle-nested", "module\\.gradle\\cache.bin", { binary: true }),
          review("gradle-prefix", ".gradle-cache/kept.bin", { binary: true }),
          review("gradle-basename", "module/.gradle", { binary: true }),
          review("binary", "assets/kept.bin", {
            binary: true,
            additions: 0,
            deletions: 0,
          }),
        ],
        reviewCapture: { status: "complete" },
      },
    },
  });
  const explicitEdit = tool({
    toolName: "Edit",
    toolResult: {
      details: {
        root: "workspace",
        review: review("explicit-gradle", ".gradle/explicit.txt"),
      },
    },
  });
  const explicitWrite = tool({
    toolName: "Write",
    toolResult: {
      details: {
        root: "workspace",
        review: review("explicit-gradle-write", "module/.gradle/explicit.txt"),
      },
    },
  });

  assert.deepEqual(
    reviewChangesFromMessage(bash).map((change) => change.path),
    [".gradle-cache/kept.bin", "module/.gradle", "assets/kept.bin"],
  );
  assert.deepEqual(
    reviewChangesMetadataFromMessage(bash).map((change) => change.path),
    [".gradle-cache/kept.bin", "module/.gradle", "assets/kept.bin"],
  );
  assert.equal(reviewChangeFromMessage(explicitEdit)?.path, ".gradle/explicit.txt");
  assert.equal(
    reviewChangeFromMessage(explicitWrite)?.path,
    "module/.gradle/explicit.txt",
  );
});

test("metadata parse matches full records without loading hunks", () => {
  const hunks = [
    {
      header: "@@ -1 +1 @@",
      lines: [
        { type: "del", text: "old" },
        { type: "add", text: "next" },
      ],
    },
  ];
  const invalid = { ...review("snapshot-invalid", "bad.txt"), additions: -1 };
  const malformed = { version: 2, snapshotId: "legacy", path: "legacy.txt" };
  const message = tool({
    toolResult: {
      details: {
        root: "workspace",
        review: review("snapshot-legacy", "legacy.txt", { hunks }),
        reviews: [
          invalid,
          malformed,
          review("snapshot-html", "index.html", { hunks, additions: 9 }),
        ],
        reviewCapture: { status: "complete" },
      },
    },
  });
  const full = reviewChangesFromMessage(message);
  const metadata = reviewChangesMetadataFromMessage(message);

  assert.deepEqual(
    metadata.map((change) => change.snapshotId),
    full.map((change) => change.snapshotId),
  );
  assert.deepEqual(
    metadata.map(({ hunks: _hunks, ...change }) => change),
    full.map(({ hunks: _hunks, ...change }) => change),
  );
  assert.equal(full[0].hunks.length, 1);
  assert.equal("hunks" in metadata[0], false);
  assert.equal(reviewChangesFromMessage(tool({ toolStatus: "denied" })).length, 0);
  assert.equal(reviewChangesMetadataFromMessage(tool({ toolStatus: "denied" })).length, 0);
});
