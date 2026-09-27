/**
 * Advisor — bundled first-party plugin (ADR 0174).
 *
 * Registers a zero-parameter reviewer tool once the user picks a model with
 * `/advisor`. Completions and session context go through public host APIs.
 */

const ADVISOR_SYSTEM = `You are a reviewer advising an executor coding agent.
You cannot call tools. Reply with a plan, a correction, or a stop signal.
Be specific and concise. Do not repeat the whole conversation.`;

const EFFORT_ORDINAL = {
  off: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
};

let toolRegistered = false;

function isDisabled(executorKey, effort, list) {
  if (!Array.isArray(list) || !executorKey) return false;
  const current = EFFORT_ORDINAL[effort] ?? 0;
  for (const entry of list) {
    if (typeof entry === "string" && entry === executorKey) return true;
    if (entry && typeof entry === "object" && entry.model === executorKey) {
      if (!entry.minEffort) return true;
      const min = EFFORT_ORDINAL[entry.minEffort] ?? 0;
      if (current > 0 && current >= min) return true;
    }
  }
  return false;
}

async function setToolRegistered(enabled) {
  if (enabled && !toolRegistered) {
    await pi.agent.registerTool({
      name: "advisor",
      description:
        "Ask a stronger reviewer model for a plan, a correction, or a stop signal. Takes no parameters; the host forwards the current conversation.",
      risk: "medium",
      schema: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        const settings = await pi.plugin.getSettings();
        const modelKey = String(settings.modelKey ?? "").trim();
        if (!modelKey) {
          return {
            error: "No advisor model is configured. The user can enable one with /advisor.",
          };
        }
        const executorKey = ctx?.modelKey;
        if (isDisabled(executorKey, ctx?.thinkingLevel, settings.disabledForModels)) {
          return { error: `Advisor disabled for ${executorKey}` };
        }
        const effort = String(settings.effort ?? "high");
        try {
          const result = await pi.agent.complete({
            modelKey,
            thinkingLevel: effort === "off" ? undefined : effort,
            system: ADVISOR_SYSTEM,
            includeSessionContext: true,
          });
          return {
            content: result.text,
            details: {
              advisorModel: result.modelKey,
              effort: result.thinkingLevel,
              usage: result.usage,
            },
          };
        } catch (error) {
          return { error: error?.message || String(error) };
        }
      },
    });
    toolRegistered = true;
    return;
  }
  if (!enabled && toolRegistered) {
    await pi.agent.unregisterTool("advisor");
    toolRegistered = false;
  }
}

async function applySelection(modelKey, effort) {
  const settings = await pi.plugin.getSettings();
  await pi.plugin.setSettings({
    ...settings,
    modelKey: modelKey ?? "",
    effort: effort ?? settings.effort ?? "high",
  });
  await setToolRegistered(Boolean(modelKey));
}

async function onLoad() {
  const settings = await pi.plugin.getSettings();
  await pi.commands.register({
    id: "advisor",
    title: "Advisor: pick reviewer",
    keywords: ["advisor", "reviewer"],
    run: async () => {
      await pi.ui.openPanel({ title: "Advisor" });
    },
  });
  await setToolRegistered(Boolean(String(settings.modelKey ?? "").trim()));
  pi.events.on("plugin:settingsChanged", async () => {
    const next = await pi.plugin.getSettings();
    await setToolRegistered(Boolean(String(next.modelKey ?? "").trim()));
  });
}

async function onUnload() {
  await pi.commands.unregister("advisor");
  if (toolRegistered) {
    await pi.agent.unregisterTool("advisor");
    toolRegistered = false;
  }
}

async function onPanelInvoke(channel, payload) {
  if (channel === "advisor.get") {
    const settings = await pi.plugin.getSettings();
    const models = await pi.models.list();
    return {
      modelKey: settings.modelKey || "",
      effort: settings.effort || "high",
      models,
    };
  }
  if (channel === "advisor.set") {
    const modelKey = String(payload?.modelKey ?? "").trim();
    const effort = String(payload?.effort ?? "high");
    await applySelection(modelKey, effort);
    const model = (await pi.models.list()).find((row) => row.key === modelKey);
    const label = model?.label || modelKey || "No advisor";
    await pi.ui.showToast(
      modelKey ? `Advisor: ${label}${effort && effort !== "off" ? `, ${effort}` : ""}` : "Advisor disabled",
    );
    return { ok: true, modelKey, effort };
  }
  if (channel === "advisor.clear") {
    await applySelection("", "off");
    await pi.ui.showToast("Advisor disabled");
    return { ok: true };
  }
  throw Object.assign(new Error(`unsupported panel channel: ${channel}`), { code: "UNSUPPORTED" });
}

module.exports = { onLoad, onUnload, onPanelInvoke };
