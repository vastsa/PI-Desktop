#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import {
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { register } from "node:module";
import { isDeepStrictEqual } from "node:util";

import { PROTOCOL_VERSION } from "../packages/shared/dist/protocol.js";
import { assert, shortJson } from "./e2e/assert.mjs";
import { withScenario } from "./e2e/fixture.mjs";
import { configureSession, createSession } from "./e2e/session.mjs";
import { resolveHostBinary } from "./e2e/host.mjs";

register(new URL("../apps/desktop/test/helpers/ts-import-hooks.mjs", import.meta.url));
const { buildTranscriptEntries } = await import("../apps/desktop/src/lib/assistant-turns.ts");
const { summarizeTurnFileChanges } = await import("../apps/desktop/src/lib/turn-file-summary.ts");
const { reviewChangesFromMessages } = await import("../apps/desktop/src/lib/workspace-review.ts");

function summaryFor(messages) {
  const entry = buildTranscriptEntries(messages).entries.find((item) => item.kind === "assistant-turn");
  assert(entry, "reloaded assistant turn missing");
  const summary = summarizeTurnFileChanges(entry);
  return {
    fileCount: summary.fileCount,
    additions: summary.additions,
    deletions: summary.deletions,
    paths: summary.files.map((file) => file.path),
  };
}

const configuredHost = process.env.PI_DESKTOP_HOST_BIN?.trim();
if (!configuredHost) {
  throw new Error("PI_DESKTOP_HOST_BIN is required for the shell review E2E");
}

const configuredPath = resolve(configuredHost);
const configuredCandidates = [configuredPath];
if (process.platform === "win32" && !configuredPath.toLowerCase().endsWith(".exe")) {
  configuredCandidates.push(`${configuredPath}.exe`);
}
const hostBinary = resolveHostBinary();
assert(
  configuredCandidates.includes(hostBinary),
  `PI_DESKTOP_HOST_BIN did not resolve to the selected host: ${hostBinary}`,
);

const tempBase = resolve(process.env.PI_SCRATCH_DIR || tmpdir());
await mkdir(tempBase, { recursive: true });
const suiteRoot = await mkdtemp(join(tempBase, "pi-shell-review-"));

function quotePowerShell(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function quotePosix(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function shellQuote(value) {
  return process.platform === "win32"
    ? quotePowerShell(value)
    : quotePosix(value);
}

function assertCompleteCapture(content, expectedCount, label) {
  assert(content?.root === "workspace", `${label}: root ${shortJson(content)}`);
  assert(
    content?.reviewCapture?.status === "complete",
    `${label}: capture ${shortJson(content?.reviewCapture)}`,
  );
  assert(
    Array.isArray(content?.reviews) && content.reviews.length === expectedCount,
    `${label}: reviews ${shortJson(content?.reviews)}`,
  );
  return content.reviews;
}

function reviewsByPath(reviews) {
  return new Map(reviews.map((review) => [review.path, review]));
}

function assertAdded(review, path) {
  assert(review?.path === path, `missing added review ${path}: ${shortJson(review)}`);
  assert(review.version === 1, `${path}: version ${review.version}`);
  assert(review.operation === "write", `${path}: operation ${review.operation}`);
  assert(review.status === "added", `${path}: status ${review.status}`);
  assert(review.state === "active", `${path}: state ${review.state}`);
  assert(review.additions === 1, `${path}: additions ${review.additions}`);
  assert(review.deletions === 0, `${path}: deletions ${review.deletions}`);
  assert(review.reversible === true, `${path}: not reversible`);
  assert(typeof review.snapshotId === "string" && review.snapshotId.length > 0, `${path}: snapshot`);
}

async function executeBash(host, sessionId, shell, command, toolCallId = randomUUID()) {
  const result = await host.call(
    "tools.execute",
    {
      sessionId,
      toolCallId,
      toolName: "Bash",
      args: { command },
      mode: "agent",
      expectedCommandShellId: shell.id,
      expectedCommandShellDialect: shell.dialect,
      timeoutMs: 15_000,
    },
    25_000,
  );
  assert(result.toolCallId === toolCallId, `Bash identity: ${shortJson(result)}`);
  assert(result.commandShellId === shell.id, `Bash shell: ${shortJson(result)}`);
  return result;
}

function copyCommand(sources) {
  if (process.platform === "win32") {
    return sources
      .map(({ source, target }) =>
        `Copy-Item -LiteralPath ${shellQuote(source)} -Destination ${shellQuote(target)}`,
      )
      .join("; ");
  }
  return sources
    .map(({ source, target }) => `cp -- ${shellQuote(source)} ${shellQuote(target)}`)
    .join(" && ");
}

function renameDeleteCommand() {
  if (process.platform === "win32") {
    return [
      `Move-Item -LiteralPath ${shellQuote("rename-me.txt")} -Destination ${shellQuote("renamed.txt")}`,
      `Remove-Item -LiteralPath ${shellQuote("delete-me.txt")}`,
    ].join("; ");
  }
  return [
    `mv -- ${shellQuote("rename-me.txt")} ${shellQuote("renamed.txt")}`,
    `rm -- ${shellQuote("delete-me.txt")}`,
  ].join(" && ");
}

function failureCommand() {
  if (process.platform === "win32") {
    return `Set-Content -LiteralPath ${shellQuote("reviewed/failure.txt")} -Value ${shellQuote("failed")}; exit 7`;
  }
  return `printf '%s\\n' ${shellQuote("failed")} > ${shellQuote("reviewed/failure.txt")}; exit 7`;
}

function readOnlyCommand() {
  if (process.platform === "win32") {
    return `Get-Content -LiteralPath ${shellQuote("dirty.txt")} | Out-Null`;
  }
  return `cat -- ${shellQuote("dirty.txt")} >/dev/null`;
}

function persistedReviews(detail, messageId) {
  const message = detail?.session?.messages?.find((item) => item.id === messageId);
  assert(message, `persisted tool message missing: ${shortJson(detail?.session?.messages)}`);
  const details = message.toolResult?.details;
  assert(details?.root === "workspace", `persisted root: ${shortJson(details ?? null)}`);
  assert(details?.reviewCapture?.status === "complete", `persisted capture: ${shortJson(details ?? null)}`);
  assert(Array.isArray(details?.reviews), `persisted reviews: ${shortJson(details ?? null)}`);
  return details.reviews;
}

async function appendNativeToolMessage(host, sessionId, toolName, toolCallId, args, result, parentToolCallId) {
  const message = {
    id: toolCallId,
    role: "tool",
    ...(parentToolCallId ? { parentToolCallId, agentName: "fixer" } : {}),
    content: JSON.stringify(result.content, null, 2),
    createdAt: new Date().toISOString(),
    status: "complete",
    toolName,
    toolCallId,
    toolStatus: result.ok ? "success" : "error",
    toolArgs: args,
    toolResult: {
      content: [{ type: "text", text: JSON.stringify(result.content, null, 2) }],
      details: result.content,
    },
  };
  await host.call("session.appendMessage", { sessionId, message });
  return message;
}

function assertReviewIdentity(actual, expected) {
  for (const field of ["version", "snapshotId", "messageId", "path", "operation", "status", "state", "additions", "deletions", "reversible"]) {
    assert(actual?.[field] === expected[field], `display lost review field ${field}`);
  }
  assert(Array.isArray(actual.hunks), "display review hunks lost their array shape");
}

async function scenario({ host, dataDir, workspace }) {
  const toolCatalog = await host.call("tools.list");
  assert(
    toolCatalog?.tools?.some((tool) => tool.name === "Bash"),
    `Bash missing from tools.list: ${shortJson(toolCatalog)}`,
  );

  const shellCatalog = await host.call("commandShells.list");
  const shell = shellCatalog?.effective;
  assert(shell?.available === true, `no effective shell: ${shortJson(shellCatalog)}`);
  const expectedDialect = process.platform === "win32" ? "powershell" : "posix";
  assert(shell.dialect === expectedDialect, `shell dialect: ${shortJson(shellCatalog)}`);
  assert(
    shellCatalog.choices?.some(
      (choice) => choice.id === shell.id && choice.dialect === shell.dialect && choice.available,
    ),
    `effective shell absent from choices: ${shortJson(shellCatalog)}`,
  );

  const created = await createSession(host, workspace, "Shell review E2E");
  const session = await configureSession(host, created, "agent", "auto");
  assert(session.permissionMode === "auto", `permission mode: ${shortJson(session)}`);

  const sessionScratch = join(dataDir, "scratch", session.id);
  const reviewedDir = join(workspace, "reviewed");
  await mkdir(sessionScratch, { recursive: true });
  await mkdir(reviewedDir, { recursive: true });

  const sources = [
    { name: "app.html", content: "<!doctype html>\n" },
    { name: "app.css", content: "body { color: #123456; }\n" },
    { name: "app.js", content: 'console.log("review");\n' },
  ].map((file) => ({
    ...file,
    source: join(sessionScratch, file.name),
    target: `reviewed/${file.name}`,
  }));
  for (const file of sources) writeFileSync(file.source, file.content, "utf8");

  writeFileSync(join(workspace, "dirty.txt"), "preexisting dirty content\n", "utf8");
  writeFileSync(join(workspace, "rename-me.txt"), "rename content\n", "utf8");
  writeFileSync(join(workspace, "delete-me.txt"), "delete content\n", "utf8");

  const copyToolCallId = randomUUID();
  const verboseCopyCommand = copyCommand(sources) + (process.platform === "win32"
    ? "; [Console]::Write(('x' * 80000))"
    : "; printf '%80000s' ''");
  const copied = await executeBash(
    host,
    session.id,
    shell,
    verboseCopyCommand,
    copyToolCallId,
  );
  assert(copied.ok === true, `copy failed: ${shortJson(copied)}`);
  assert(copied.content?.exitCode === 0, `copy exit: ${shortJson(copied.content)}`);
  const copyReviews = assertCompleteCapture(copied.content, 3, "copy");
  const copyByPath = reviewsByPath(copyReviews);
  for (const file of sources) assertAdded(copyByPath.get(file.target), file.target);
  assert(!copyByPath.has("dirty.txt"), `unchanged dirty file captured: ${shortJson(copyReviews)}`);

  const noOp = await executeBash(host, session.id, shell, readOnlyCommand());
  assert(noOp.ok === true && noOp.content?.exitCode === 0, `no-op failed: ${shortJson(noOp)}`);
  assertCompleteCapture(noOp.content, 0, "read-only no-op");

  const failed = await executeBash(host, session.id, shell, failureCommand());
  assert(failed.ok === false, `nonzero shell stayed successful: ${shortJson(failed)}`);
  assert(failed.content?.exitCode === 7, `nonzero exit changed: ${shortJson(failed)}`);
  const failedReviews = assertCompleteCapture(failed.content, 1, "nonzero write");
  assertAdded(failedReviews[0], "reviewed/failure.txt");

  const moved = await executeBash(host, session.id, shell, renameDeleteCommand());
  assert(moved.ok === true, `rename/delete failed: ${shortJson(moved)}`);
  const movedByPath = reviewsByPath(assertCompleteCapture(moved.content, 3, "rename/delete"));
  assert(movedByPath.get("rename-me.txt")?.status === "deleted", shortJson(moved.content));
  assert(movedByPath.get("renamed.txt")?.status === "added", shortJson(moved.content));
  assert(movedByPath.get("delete-me.txt")?.status === "deleted", shortJson(moved.content));

  const message = await appendNativeToolMessage(
    host, session.id, "Bash", copyToolCallId,
    { command: verboseCopyCommand }, copied,
  );
  assert(persistedReviews(await host.call("session.get", { id: session.id }), message.id).length === 3, "reviews missing before restart");

  const largeMessages = [];
  let writeTag;
  for (const toolName of ["Write", "Edit"]) {
    const largeText = `${toolName}:` + "large recorded diff ".repeat(5000);
    const args = toolName === "Write"
      ? { path: "reviewed/large.txt", content: largeText }
      : { path: "reviewed/large.txt", tag: writeTag, ops: `PUT 1.=1:\n+${largeText}` };
    const toolCallId = randomUUID();
    const result = await host.call("tools.execute", {
      sessionId: session.id, toolCallId, toolName, args, mode: "agent",
    });
    assert(result.ok === true && result.content?.review, `${toolName} review producer failed: ${shortJson(result)}`);
    writeTag = result.content.tag;
    const saved = await appendNativeToolMessage(host, session.id, toolName, toolCallId, args, result);
    largeMessages.push({ message: saved, review: result.content.review });
  }

  const finalMessage = {
    id: randomUUID(), role: "assistant", content: "Finished the file updates.",
    createdAt: new Date().toISOString(), status: "complete",
  };
  await host.call("session.appendMessage", { sessionId: session.id, message: finalMessage });
  const liveSummary = summaryFor([message, ...largeMessages.map((item) => item.message), finalMessage]);
  assert(liveSummary.fileCount === 4, "native workflow did not produce four distinct files");

  await host.restart(PROTOCOL_VERSION);
  const limitedOptions = { id: session.id, contentLimit: 64 * 1024 };
  const displayed = await host.call("session.get", limitedOptions);
  assert(isDeepStrictEqual(summaryFor(displayed.session.messages), liveSummary), "capped reopen changed the rendered turn file summary");
  const afterRestart = persistedReviews(displayed, message.id);
  assert(afterRestart.length === 3, `reviews missing after restart: ${shortJson(afterRestart)}`);
  for (const expected of copyReviews) {
    assertReviewIdentity(reviewsByPath(afterRestart).get(expected.path), expected);
  }
  for (const { message: saved, review: expected } of largeMessages) {
    const loaded = displayed.session.messages.find((item) => item.id === saved.id);
    assert(loaded?.toolResult?.details?.root === "workspace", "display lost workspace root");
    assertReviewIdentity(loaded.toolResult.details.review, expected);
    assert(JSON.stringify(loaded.toolResult).length < JSON.stringify(saved.toolResult).length, "large result was not bounded for display");
    const full = (await host.call("session.get", { id: session.id })).session.messages.find((item) => item.id === saved.id);
    assert(isDeepStrictEqual(full.toolResult, saved.toolResult), "display projection changed persisted evidence");
  }

  const jsReview = reviewsByPath(afterRestart).get("reviewed/app.js");
  writeFileSync(join(workspace, "reviewed", "app.js"), "user changed after tool\n", "utf8");
  const conflict = await host.call("review.rollback", {
    sessionId: session.id,
    snapshotId: jsReview.snapshotId,
  });
  assert(conflict.status === "conflict", `expected rollback conflict: ${shortJson(conflict)}`);
  assert(
    readFileSync(join(workspace, "reviewed", "app.js"), "utf8") === "user changed after tool\n",
    "conflict rollback overwrote user content",
  );

  const cssReview = reviewsByPath(afterRestart).get("reviewed/app.css");
  const rollback = await host.call("review.rollback", {
    sessionId: session.id,
    snapshotId: cssReview.snapshotId,
  });
  assert(rollback.status === "rolledBack", `rollback failed: ${shortJson(rollback)}`);
  assert(!existsSync(join(workspace, "reviewed", "app.css")), "rolled-back add still exists");
  assert(existsSync(join(workspace, "reviewed", "app.html")), "sibling HTML was removed");
  assert(existsSync(join(workspace, "reviewed", "app.js")), "sibling JS was removed");
  assert(readFileSync(join(workspace, "dirty.txt"), "utf8") === "preexisting dirty content\n", "dirty file changed");

  const finalReviews = reviewsByPath(
    persistedReviews(await host.call("session.get", limitedOptions), message.id),
  );
  assert(finalReviews.get("reviewed/app.css")?.state === "rolledBack", shortJson([...finalReviews.values()]));
  assert(finalReviews.get("reviewed/app.html")?.state === "active", shortJson([...finalReviews.values()]));
  assert(finalReviews.get("reviewed/app.js")?.state === "active", shortJson([...finalReviews.values()]));
  await delegatedEditsScenario(host, workspace, shell);
}

async function delegatedEditsScenario(host, workspace, shell) {
  const created = await createSession(host, workspace, "Delegated source review E2E");
  const session = await configureSession(host, created, "agent", "auto");
  const taskCallId = randomUUID();
  const append = (message) => host.call("session.appendMessage", {
    sessionId: session.id,
    message: { createdAt: new Date().toISOString(), status: "complete", ...message },
  });
  await append({ id: randomUUID(), role: "user", content: "Update the source and build it." });
  await append({
    id: taskCallId, role: "tool", content: "Started fixer", toolName: "Task",
    toolCallId: taskCallId, toolStatus: "success", toolArgs: { agent: "fixer" },
  });
  await mkdir(join(workspace, "src"), { recursive: true });
  writeFileSync(join(workspace, "src/Main.java"), "before\n");
  const read = await host.call("tools.execute", {
    sessionId: session.id, toolCallId: randomUUID(), toolName: "Read",
    args: { path: "src/Main.java" }, mode: "agent",
  });
  assert(read.ok && read.content?.tag, "native read did not return the edit anchor");
  const delegated = [];
  for (const [toolName, args] of [
    ["Write", { path: "src/Feature.java", content: "feature\n" }],
    ["Edit", { path: "src/Main.java", tag: read.content.tag, ops: "PUT 1.=1:\n+after" }],
  ]) {
    const toolCallId = randomUUID();
    const result = await host.call("tools.execute", {
      sessionId: session.id, toolCallId, toolName, args, mode: "agent",
    });
    assert(result.ok && result.content?.review, `delegated ${toolName} missing native review`);
    const message = await appendNativeToolMessage(
      host, session.id, toolName, toolCallId, args, result, taskCallId,
    );
    delegated.push({ message, review: result.content.review });
  }
  // Cache writes and a real source write occur in the same native shell interval.
  const cacheDirs = [".gradle/8.4/fileHashes", "module/.gradle"];
  for (const dir of cacheDirs) {
    await mkdir(join(workspace, dir), { recursive: true });
    writeFileSync(join(workspace, dir, "state.lock"), Buffer.from([0, 1]));
  }
  const binarySource = join(workspace, "reviewed/cache-source.bin");
  writeFileSync(binarySource, Buffer.from([0, 2]));
  const command = copyCommand([
    ...cacheDirs.map((dir) => ({ source: binarySource, target: `${dir}/state.lock` })),
    { source: join(workspace, "src/Feature.java"), target: "src/Shell.java" },
  ]);
  const built = await executeBash(host, session.id, shell, command);
  const shellReviews = assertCompleteCapture(built.content, 1, "source with Gradle caches");
  assert(shellReviews[0].path === "src/Shell.java", "cache displaced actual shell edit");
  await appendNativeToolMessage(host, session.id, "Bash", built.toolCallId, { command }, built);
  await append({ id: randomUUID(), role: "assistant", content: "Source updated and built." });

  await host.restart(PROTOCOL_VERSION);
  const options = { id: session.id, contentLimit: 64 * 1024 };
  const displayed = (await host.call("session.get", options)).session.messages;
  const summary = summaryFor(displayed);
  assert(isDeepStrictEqual([...summary.paths].sort(), ["src/Feature.java", "src/Main.java", "src/Shell.java"]), "delegated source edits missing after restart");
  assert(summary.additions === 3 && summary.deletions === 1, "delegated line counts lost");
  const reviewEntries = reviewChangesFromMessages(displayed);
  assert(reviewEntries.length === 3, "Review panel and turn summary disagree");
  for (const { message, review } of delegated) {
    const loaded = displayed.find((item) => item.id === message.id);
    assert(loaded?.parentToolCallId === taskCallId, "delegated parent identity lost on reload");
    assertReviewIdentity(loaded?.toolResult?.details?.review, review);
    assert(reviewEntries.some((entry) => entry.message.id === message.id && entry.change.snapshotId === review.snapshotId), "Review navigation lost delegated identity");
  }
  const feature = delegated.find((item) => item.review.path === "src/Feature.java").review;
  const rollback = await host.call("review.rollback", { sessionId: session.id, snapshotId: feature.snapshotId });
  assert(rollback.status === "rolledBack", "parent session cannot roll back delegated snapshot");
  assert(!existsSync(join(workspace, "src/Feature.java")), "delegated add was not rolled back");
  const main = delegated.find((item) => item.review.path === "src/Main.java").review;
  writeFileSync(join(workspace, "src/Main.java"), "later user edit\n");
  const conflict = await host.call("review.rollback", { sessionId: session.id, snapshotId: main.snapshotId });
  assert(conflict.status === "conflict", "delegated rollback failed to guard newer contents");
  assert(readFileSync(join(workspace, "src/Main.java"), "utf8") === "later user edit\n", "delegated rollback overwrote user contents");
  await host.restart(PROTOCOL_VERSION);
  const reloaded = (await host.call("session.get", options)).session.messages;
  assert(reviewChangesFromMessages(reloaded).find((entry) => entry.change.snapshotId === feature.snapshotId)?.change.state === "rolledBack", "delegated rollback state not persisted");
}

try {
  await withScenario(
    "e2e-shell-review",
    scenario,
    hostBinary,
    suiteRoot,
    PROTOCOL_VERSION,
  );
  console.log("PASS e2e-shell-review");
} catch (error) {
  console.error("FAIL e2e-shell-review:", error?.stack || error);
  process.exitCode = 1;
} finally {
  await rm(suiteRoot, {
    recursive: true,
    force: true,
    maxRetries: 8,
    retryDelay: 100,
  });
}
