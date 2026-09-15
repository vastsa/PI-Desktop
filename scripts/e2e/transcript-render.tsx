import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { en } from "@pi-desktop/i18n";
import type { UiMessage } from "@pi-desktop/shared";
import { LiveMessageMeta } from "../../apps/desktop/src/features/chat/transcript/shared";
import { AssistantTurn } from "../../apps/desktop/src/features/chat/transcript/AssistantTurn";
import { buildTranscriptEntries } from "../../apps/desktop/src/lib/assistant-turns";

declare global {
  var __activityGroupRenders: string[];
  var transcriptRenderProbe: () => Promise<unknown>;
}

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

const createdAt = "2026-09-13T00:00:00.000Z";
const message = (
  id: string,
  role: UiMessage["role"],
  content: string,
  extra: Partial<UiMessage> = {},
): UiMessage => ({ id, role, content, createdAt, ...extra });

/** Real React DOM + production transcript components; no component/hook mocks. */
globalThis.transcriptRenderProbe = async () => {
  const i18n = createInstance();
  await i18n.init({
    lng: "en",
    resources: { en: { translation: en } },
    interpolation: { escapeValue: false },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const renderErrors: unknown[] = [];
  const root = createRoot(container, {
    onUncaughtError: (error) => {
      renderErrors.push(error);
    },
  });
  const render = (messages: UiMessage[]) => {
    const entry = buildTranscriptEntries(messages).entries.find(
      (item) => item.kind === "assistant-turn",
    );
    assert(entry?.kind === "assistant-turn", "assistant turn missing");
    flushSync(() =>
      root.render(
        <I18nextProvider i18n={i18n}>
          <AssistantTurn entry={entry} isActive />
        </I18nextProvider>,
      ),
    );
    assert(
      renderErrors.length === 0,
      `React render failed: ${renderErrors.map(String).join("; ")}`,
    );
  };
  try {
    const groups = 100;
    let messages = [message("user", "user", "Inspect the workspace")];
    for (let index = 0; index < groups; index++) {
      messages.push(
        message(`tool-${index}`, "tool", "done", {
          toolName: "Bash",
          toolCallId: `call-${index}`,
          toolStatus: "success",
          toolArgs: { command: `printf step-${index}` },
          toolResult: { details: { stdout: "done", exitCode: 0 } },
        }),
      );
      messages.push(
        message(`answer-${index}`, "assistant", `Finished step ${index}.`),
      );
    }
    render(messages);
    globalThis.__activityGroupRenders = [];
    const startedAt = performance.now();
    for (let update = 0; update < 20; update++) {
      messages = [...messages];
      messages[messages.length - 1] = {
        ...messages.at(-1)!,
        content: `Streaming fragment ${update}`,
        status: "streaming",
      };
      render(messages);
    }
    const textUpdateRenders = globalThis.__activityGroupRenders.length;
    const textUpdateDurationMs = performance.now() - startedAt;
    assert(
      container.textContent?.includes("Streaming fragment 19"),
      `streaming tail did not update: ${container.textContent?.slice(-500)}, renders=${textUpdateRenders}`,
    );
    assert(
      textUpdateRenders === 0,
      `${groups} unchanged activity groups rendered ${textUpdateRenders} times across 20 text updates`,
    );

    globalThis.__activityGroupRenders = [];
    messages = [...messages];
    messages[1] = {
      ...messages[1],
      toolArgs: { command: "printf changed-command" },
    };
    render(messages);
    assert(
      globalThis.__activityGroupRenders.join(",") === "tool-0",
      "changed tool group did not render exactly once",
    );
    assert(
      container.textContent?.includes("changed-command"),
      "changed tool row not visible",
    );

    // Keep Task's own message stable: a later lifecycle result must still
    // update its terminal status and timing (#238), unlike unrelated text.
    const start = Date.now() - 12_000;
    const task = message("task", "tool", "started", {
      toolName: "Task",
      toolCallId: "task-call",
      toolStatus: "success",
      toolArgs: { agent: "explorer", task: "Inspect a module" },
      toolResult: {
        details: {
          delegationId: "delegate",
          status: "running",
          startedAt: start,
        },
      },
    });
    let lifecycle = message("wait", "tool", "running", {
      toolName: "TaskWait",
      toolCallId: "wait-call",
      toolStatus: "success",
      toolResult: {
        details: {
          delegations: [
            { delegationId: "delegate", status: "running", startedAt: start },
          ],
        },
      },
    });
    const taskMessages = () => [
      message("user", "user", "Delegate"),
      task,
      message("between", "assistant", "Waiting"),
      lifecycle,
      message("tail", "assistant", "Continuing"),
    ];
    render(taskMessages());
    assert(
      container.querySelector(".has-subagents")?.classList.contains("active"),
      "running Task group is not active",
    );
    globalThis.__activityGroupRenders = [];
    lifecycle = {
      ...lifecycle,
      content: "completed",
      toolResult: {
        details: {
          delegations: [
            {
              delegationId: "delegate",
              status: "completed",
              startedAt: start,
              completedAt: start + 2_000,
            },
          ],
        },
      },
    };
    render(taskMessages());
    assert(
      globalThis.__activityGroupRenders.includes("task"),
      "Task group ignored a lifecycle status update",
    );
    const topology = container.querySelector(".has-subagents");
    const taskDuration = () => container
      .querySelector(".has-subagents .subagent-activity-metrics")
      ?.textContent?.split("·").at(-1)?.trim();
    assert(
      taskDuration() === "2s",
      "Task completion timing did not update to 2s",
    );
    assert(
      !topology?.classList.contains("active"),
      "completed Task group is still active",
    );

    globalThis.__activityGroupRenders = [];
    lifecycle = {
      ...lifecycle,
      toolResult: {
        details: {
          delegations: [
            {
              delegationId: "delegate",
              status: "completed",
              startedAt: start,
              completedAt: start + 4_000,
            },
          ],
        },
      },
    };
    render(taskMessages());
    assert(
      globalThis.__activityGroupRenders.includes("task"),
      "Task group ignored a timing-only update",
    );
    assert(
      taskDuration() === "4s",
      "Task completion timing did not update to 4s",
    );

    // E2E-CHAT-live-generation-throughput: real timers, hook and DOM.
    const showLive = (content: string, thinking = "", toolRunning = false, id = "live") => {
      flushSync(() => root.render(<I18nextProvider i18n={i18n}><LiveMessageMeta
        message={message(id, "assistant", content, { thinking, status: "streaming" })}
        toolRunning={toolRunning}
      /></I18nextProvider>));
    };
    const pause = () => new Promise((resolve) => setTimeout(resolve, 300));
    showLive("");
    assert(container.textContent?.includes("Waiting for output"), "missing waiting phase");
    for (let i = 1; i <= 5; i++) {
      showLive("", "x".repeat(i * 80));
      await pause();
    }
    assert(container.textContent?.includes("Thinking"), "missing thinking phase");
    assert(container.querySelector(".throughput")?.textContent?.includes("≈"), "live estimate missing");
    showLive("answer", "x".repeat(400));
    assert(container.textContent?.includes("Generating"), "missing generation phase");
    showLive("answer", "x".repeat(400), true);
    assert(container.textContent?.includes("Running tools"), "missing tool phase");
    assert(container.querySelector(".throughput")?.textContent?.includes("Last:"), "retained rate presented as current");
    assert(container.querySelector('.throughput[data-stale="true"]'), "tool rate not dimmed");
    await pause();
    showLive("", "", false, "next");
    assert(container.textContent?.includes("Waiting for output"), "next request reuses old phase");
    render([message("real-thinking", "assistant", "", { thinking: "Reasoning only", status: "streaming" })]);
    assert(container.querySelector('[data-generation-phase="thinking"]'), "thinking activity did not reach live meta row");
    render([
      message("real-thinking", "assistant", "", { thinking: "Reasoning only", status: "complete" }),
      message("real-tool", "tool", "", { toolName: "Bash", toolStatus: "running" }),
    ]);
    assert(container.querySelector('[data-generation-phase="tool"]'), "tool lifecycle did not reach live meta row");


    return {
      ok: true,
      groups,
      textUpdates: 20,
      textUpdateRenders,
      changedToolRenders: 1,
      taskLifecycleUpdated: true,
      taskTimingUpdated: true,
      liveThroughputPhases: true,
      textUpdateDurationMs,
    };
  } finally {
    flushSync(() => root.unmount());
    container.remove();
  }
};
