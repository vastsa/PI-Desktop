/**
 * Block samples: the `toolCard` of the plugin's own `lab_probe` tool and the
 * `blockRenderer` for `lab.ui-slots:chart` fences.
 *
 * Both have a way to fail the contract on purpose, which must hand the block
 * back to the host: a `lab_probe` call with `mode: "crash"` makes its card
 * throw, a chart whose first line is `crash` throws, and one whose first line
 * is `tall` draws past the host's height clamp.
 */
import { createElement as h } from "react";
import { SessionTag } from "./lab.mjs";

/** Taller than the host's 4000px block clamp. */
const TALL_PX = 5_000;

function json(value) {
  return value === undefined ? "—" : JSON.stringify(value);
}

function errorText(error) {
  if (typeof error === "string") return error;
  return typeof error?.message === "string" ? error.message : json(error);
}

export function ProbeCard({ toolName, toolCallId, toolArgs, toolStatus, toolResult, toolError, durationMs, sessionId }) {
  if (toolArgs?.mode === "crash") throw new Error("lab: toolCard crashed on request");
  return h("div", { className: "lab-card", "data-lab": "toolCard", "data-lab-status": toolStatus, "data-lab-session": sessionId },
    h("div", { className: "lab-head" },
      h("strong", null, `UI Slots Lab · ${toolName}`),
      h("span", { className: `lab-pill lab-${toolStatus}` }, toolStatus),
      h(SessionTag, { sessionId })),
    h("div", { className: "lab-facts" },
      h("span", { "data-lab-call": toolCallId }, `call ${toolCallId.slice(0, 12)}`),
      typeof durationMs === "number" ? h("span", null, `${durationMs}ms`) : null),
    h("code", { className: "lab-code" }, `args ${json(toolArgs)}`),
    toolStatus === "running"
      ? h("div", { className: "lab-quiet" }, "running…")
      : toolStatus === "error"
        ? h("div", { className: "lab-error", "data-lab-error": "" }, errorText(toolError))
        : h("code", { className: "lab-code", "data-lab-output": "" }, `result ${json(toolResult)}`));
}

/** `label,value` lines; a line whose value is not a number is skipped. */
function bars(source) {
  return source.split("\n").flatMap((line) => {
    const [label, raw] = line.split(",");
    const value = Number(raw);
    return label && raw !== undefined && Number.isFinite(value) ? [{ label: label.trim(), value }] : [];
  });
}

export function ChartBlock({ language, source }) {
  const first = source.split("\n")[0]?.trim();
  if (first === "crash") throw new Error("lab: blockRenderer crashed on request");
  const rows = bars(source);
  const max = Math.max(1, ...rows.map((row) => row.value));
  return h("div", { className: "lab-card", "data-lab": "blockRenderer", "data-lab-language": language },
    h("div", { className: "lab-head" },
      h("strong", null, "UI Slots Lab · blockRenderer"),
      h("code", null, language)),
    rows.length
      ? h("div", { className: "lab-bars" },
          rows.map((row, index) =>
            h("div", { key: index, className: "lab-bar-row" },
              h("span", { className: "lab-bar-label" }, row.label),
              h("span", { className: "lab-bar", style: { width: `${(row.value / max) * 100}%` } }),
              h("span", { className: "lab-bar-value" }, String(row.value)))))
      : h("div", { className: "lab-quiet" }, "no label,value lines"),
    first === "tall" ? h("div", { "data-lab-tall": "", style: { height: TALL_PX } }) : null);
}
