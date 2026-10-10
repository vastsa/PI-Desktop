import type { ScheduledRunChange, SessionSummary } from "@pi-desktop/shared";
import { normalizeProjectPath } from "./sidebar-session-groups";
import { isAutomationSession } from "./session-origin";

/**
 * What a project row reports while its session list is collapsed (issue #1441):
 * how many conversations of that project are running, whether any of them is
 * waiting for the reader, how many scheduled-task runs are running, and which
 * results are still unread.
 *
 * Everything here is state the renderer already holds — the project row's own
 * conversations, the unfiltered session list (automation transcripts stay in the
 * store even though the sidebar drops them), the running map, the shared unread
 * outcome helper, and the pending interactive prompts — so a project row needs
 * no event, cache, or extra host read to render its status. Callers compute it
 * at the render site, the same shape the project delete confirmation already
 * uses.
 */
export type SidebarProjectStatus = {
  /** Conversations under this project that are running right now. */
  running: number;
  /** Scheduled-task runs of this project that are running right now. */
  scheduledRunning: number;
  /** Sessions that cannot continue until the reader answers (permission/ask/plan). */
  needsAttention: number;
  /** Unread finished results, using the row badge's own "not looked at yet" rule. */
  finished: number;
  /** Unread failed results. */
  failed: number;
  /** Running conversations plus scheduled runs: the number the badge shows. */
  total: number;
  /** Nothing of this project runs any more, and at least one result is unread. */
  settled: boolean;
};

export function projectRunningStatus(input: {
  /** The project row's listed conversations. */
  sessions: readonly Pick<SessionSummary, "id">[];
  /** Every session in the store, including automation transcripts. */
  allSessions: readonly Pick<
    SessionSummary,
    "id" | "projectPath" | "scheduledRun"
  >[];
  /** The project this row stands for. */
  projectPath: string;
  runningSessions: Readonly<Record<string, boolean>>;
  /** Unread terminal results per session (see `latestSessionOutcomes`). */
  outcomes: Readonly<Record<string, "completed" | "failed">>;
  /** Sessions holding a pending permission, ask, or plan. */
  attentionSessionIds?: Iterable<string>;
  /** Live scheduled runs, from the broadcast the shell subscribes to. */
  scheduledRuns?: readonly Pick<
    ScheduledRunChange,
    "runId" | "sessionId" | "status" | "projectPath"
  >[];
}): SidebarProjectStatus {
  const attention = new Set(input.attentionSessionIds ?? []);
  const project = normalizeProjectPath(input.projectPath ? input.projectPath : null);

  let running = 0;
  let scheduledRunning = 0;
  let needsAttention = 0;
  let finished = 0;
  let failed = 0;

  const countResult = (sessionId: string) => {
    const outcome = input.outcomes[sessionId];
    if (outcome === "completed") finished += 1;
    else if (outcome === "failed") failed += 1;
  };

  // Listed conversations: automation transcripts never appear here.
  for (const session of input.sessions) {
    if (attention.has(session.id)) needsAttention += 1;
    if (input.runningSessions[session.id]) running += 1;
    countResult(session.id);
  }

  // Automation transcripts that are still in the store, plus the live scheduled
  // runs the renderer learned about from the broadcast. A run is counted once:
  // the store path wins because it carries the session's own running state.
  const automationSessions = new Set<string>();
  for (const session of input.allSessions) {
    if (!isAutomationSession(session)) continue;
    if (!project || normalizeProjectPath(session.projectPath) !== project) continue;
    automationSessions.add(session.id);
    if (attention.has(session.id)) needsAttention += 1;
    if (input.runningSessions[session.id]) scheduledRunning += 1;
    countResult(session.id);
  }

  for (const run of input.scheduledRuns ?? []) {
    if (!project || normalizeProjectPath(run.projectPath ?? null) !== project) continue;
    if (run.status === "running") {
      if (!automationSessions.has(run.sessionId)) scheduledRunning += 1;
      continue;
    }
    if (!automationSessions.has(run.sessionId)) countResult(run.sessionId);
  }

  const total = running + scheduledRunning;
  const results = finished + failed;
  return {
    running,
    scheduledRunning,
    needsAttention,
    finished,
    failed,
    total,
    settled: total === 0 && results > 0,
  };
}
