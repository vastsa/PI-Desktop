import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";

/** Controlled external input; all mutation snapshots and persisted messages use real Host RPC. */
export async function seedReviewHistory(host, directory) {
  const root = join(directory, "workspace"); await mkdir(root, { recursive: true });
  const session = (await host.call("session.create", { title: "Review test", projectPath: root, mode: "agent" })).session;
  const other = (await host.call("session.create", { title: "Other test", projectPath: root, mode: "agent" })).session;
  await host.call("session.configure", { id: session.id, mode: "agent", permissionMode: "auto" });
  let serial = 0;
  const append = (message, turnId) => host.call("session.appendMessage", { sessionId: session.id, message, turnId });
  const begin = async (id, title) => {
    const { turnId } = await host.call("session.beginTurn", { sessionId: session.id });
    await append({ id, role: "user", content: title, createdAt: new Date().toISOString() }, turnId);
    return turnId;
  };
  const end = turnId => host.call("session.endTurn", { turnId, status: "completed", createNotification: false });
  const mutate = async (turnId, path, content, parentToolCallId) => {
    const id = `review-call-${++serial}`;
    const result = await host.call("tools.execute", { sessionId: session.id, turnId, toolCallId: id, toolName: "Write", args: { path, content }, mode: "agent" });
    if (!result.ok || !result.content.review) throw new Error("Fixture Write must produce review: " + JSON.stringify(result));
    const message = { id, role: "tool", content: "", createdAt: new Date().toISOString(), toolName: "Write", toolCallId: id, toolStatus: "success", toolResult: { details: result.content }, ...(parentToolCallId ? { parentToolCallId } : {}) };
    await append(message, turnId);
    return message;
  };
  const original = Array.from({ length: 3100 }, (_, i) => `const line_${String(i + 1).padStart(3, "0")} = ${i + 1};`).join("\n") + "\n";
  await writeFile(join(root, "long.ts"), original);
  const firstTurn = await begin("round-one", "完善轮次审阅并统一子代理修改");
  await append({ id: "task-row", role: "tool", content: "", createdAt: new Date().toISOString(), toolName: "Task", toolCallId: "review-task", toolStatus: "success" }, firstTurn);
  const changed = original.replace("line_030 = 30", "line_030 = 300").replace("line_080 = 80", "line_080 = 800");
  const first = await mutate(firstTurn, "long.ts", changed);
  await mutate(firstTurn, "long.ts", changed.replace("line_040 = 40", "line_040 = 400"), "review-task");
  await mutate(firstTurn, "child.md", "# Unified review\n\nDelegate output belongs to this conversation.\n", "review-task");
  const outsidePath = join(directory, "outside", "review-open-tests-source.mjs");
  await mutate(firstTurn, outsidePath, "export const outside = true;\n");
  await end(firstTurn);
  const second = await begin("round-two", "新增最近修改的测试文件");
  await mutate(second, "latest.txt", "Latest modified round\n"); await end(second);
  const third = await begin("round-no-edit", "只讨论方案，不修改文件"); await end(third);
  // The disk is no longer the historical after image. Context must remain immutable.
  await writeFile(join(root, "long.ts"), "external-current-only\n");
  return {
    session, other, round: "round-one", latest: "round-two", firstSnapshot: first.toolResult.details.review.snapshotId,
    lateMessage: { ...first, id: "late-refresh" },
    async appendLate() { return mutate(firstTurn, "late.txt", "Late old delegate\n", "review-task"); },
    startRunning: () => begin("round-running", "运行中首次修改测试"),
    writeRunning: turnId => mutate(turnId, "running.txt", "First modification in the running round\n"),
    endRunning: end,
    readCurrent: () => readFile(join(root, "long.ts"), "utf8"),
    resetCurrent: () => writeFile(join(root, "long.ts"), changed.replace("line_040 = 40", "line_040 = 400")),
  };
}
