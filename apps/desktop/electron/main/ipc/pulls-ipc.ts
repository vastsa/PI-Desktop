import { spawn } from "node:child_process";
import { IPC } from "@pi-desktop/shared";
import type { HostProcess } from "../host-process";
import type { IpcRegistrar } from "./types";

export type PullsIpcDependencies = {
  registrar: IpcRegistrar;
  getHost: () => HostProcess | null;
};

export function registerPullsIpc({
  registrar,
  getHost,
}: PullsIpcDependencies): void {
  registrar.handle(IPC.invoke.pullsList, async () => {
    const host = getHost();
    if (!host) throw new Error("host unavailable");
    const res = (await host.call("workspace.get")) as {
      workspace: { path: string; name: string } | null;
    };
    const cwd = res.workspace?.path;
    if (!cwd) {
      return { pulls: [], error: "NO_WORKSPACE" as const };
    }
    const run = (cmd: string, args: string[]) =>
      new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
        const child = spawn(cmd, args, { cwd, env: process.env });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (data) => (stdout += String(data)));
        child.stderr.on("data", (data) => (stderr += String(data)));
        child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
        child.on("error", (error) =>
          resolve({ code: 1, stdout: "", stderr: String(error) }),
        );
      });
    const result = await run("gh", [
      "pr",
      "list",
      "--limit",
      "30",
      "--json",
      "number,title,url,author,headRefName,baseRefName,updatedAt,isDraft",
    ]);
    if (result.code !== 0) {
      return {
        pulls: [],
        error: result.stderr.trim() || result.stdout.trim() || "GH_FAILED",
      };
    }
    try {
      const pulls = JSON.parse(result.stdout || "[]") as Array<Record<string, unknown>>;
      return {
        pulls: pulls.map((pull) => ({
          number: Number(pull.number),
          title: String(pull.title || ""),
          url: String(pull.url || ""),
          author:
            typeof pull.author === "object" && pull.author
              ? String((pull.author as { login?: unknown }).login || "")
              : undefined,
          headRefName: pull.headRefName ? String(pull.headRefName) : undefined,
          baseRefName: pull.baseRefName ? String(pull.baseRefName) : undefined,
          updatedAt: pull.updatedAt ? String(pull.updatedAt) : undefined,
          isDraft: Boolean(pull.isDraft),
        })),
      };
    } catch (error) {
      return { pulls: [], error: error instanceof Error ? error.message : String(error) };
    }
  });
}
