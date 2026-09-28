import { useMemo, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { formatCompactTokenCount } from "@pi-desktop/shared";
import {
  contextCapacityView,
  contextSnapshotView,
  type ContextBreakdownRow,
} from "../../lib/context-panel";
import { contextOccupancyTokens } from "../../lib/context-usage";
import { getContextSnapshot, subscribeContextSnapshots } from "../../lib/context-snapshot-store";
import { latestTurnContextInspector } from "../../lib/latest-turn-context";
import { runExtensionCommand } from "../../lib/commands";
import { useAppStore } from "../../stores/app-store";
import { Button } from "../ui";

const EMPTY_COMPACTIONS: [] = [];

const CONTEXT_COMMANDS = [
  ["context-export", "Export", "Save the current context as a pack"],
  ["context-import", "Import", "Load a named context pack"],
  ["context-handoff", "Handoff", "Save a pack before switching models"],
] as const;

function CategoryRows({ rows }: { rows: ContextBreakdownRow[] }) {
  return (
    <div className="context-panel-categories" role="list">
      {rows.map((category) => (
        <div className="context-panel-category" role="listitem" key={category.key}>
          <div className="context-panel-category-label">
            <span>{category.label}</span>
            <span>{formatCompactTokenCount(category.tokens)} · {category.shareLabel}</span>
          </div>
          <div className="context-panel-meter" aria-hidden="true">
            <span style={{ width: `${category.sharePercent}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function ContextPanel() {
  const { t } = useTranslation();
  const activeSessionId = useAppStore((state) => state.activeSessionId);
  const messages = useAppStore((state) => state.messages);
  const providers = useAppStore((state) => state.providers);
  const providerModels = useAppStore((state) => state.providerModels);
  const compactions = useAppStore((state) =>
    state.activeSessionId
      ? state.sessionCompactions[state.activeSessionId] ?? EMPTY_COMPACTIONS
      : EMPTY_COMPACTIONS,
  );
  const showToast = useAppStore((state) => state.showToast);
  const snapshot = useSyncExternalStore(
    subscribeContextSnapshots,
    () => getContextSnapshot(activeSessionId),
  );
  const [packName, setPackName] = useState("");
  const [runningCommand, setRunningCommand] = useState<{
    sessionId: string;
    name: string;
  } | null>(null);

  const estimate = useMemo(() => {
    const inspector = latestTurnContextInspector(
      messages,
      providerModels,
      providers,
      compactions,
    );
    return inspector
      ? contextCapacityView(
          contextOccupancyTokens(inspector.usage),
          inspector.contextWindow,
        )
      : null;
  }, [compactions, messages, providerModels, providers]);
  const breakdown = snapshot ? contextSnapshotView(snapshot) : null;
  const capacity = breakdown?.capacity ?? estimate;
  const busy = runningCommand?.sessionId === activeSessionId;

  const runPackCommand = async (command: string) => {
    const sessionId = activeSessionId;
    if (!sessionId) return;
    setRunningCommand({ sessionId, name: command });
    try {
      await runExtensionCommand(command, packName.trim());
      // The extension itself reports export/import/handoff outcomes through ui.notify.
    } catch (error) {
      if (useAppStore.getState().activeSessionId === sessionId) {
        showToast(error instanceof Error ? error.message : String(error), {
          variant: "error",
        });
      }
    } finally {
      setRunningCommand((current) =>
        current?.sessionId === sessionId && current.name === command ? null : current,
      );
    }
  };

  return (
    <div className="context-panel">
      <section className="context-panel-overview" aria-label={t("panel.context.title", { defaultValue: "Context" })}>
        <div className="context-panel-heading">
          <h2>{t("panel.context.title", { defaultValue: "Context" })}</h2>
          <span className="context-panel-source">
            {snapshot
              ? t("panel.context.snapshotSource", { defaultValue: "Pi-Context · last turn" })
              : t("panel.context.estimateSource", { defaultValue: "Estimate only" })}
          </span>
        </div>
        <p className="context-panel-model">
          {snapshot?.modelName || t("panel.context.currentSession", { defaultValue: "Current session" })}
        </p>
        {capacity ? (
          <>
            <div className="context-panel-capacity">
              <strong>{snapshot?.unknownTotal ? "~" : ""}{capacity.percentLabel}</strong>
              <span>
                {formatCompactTokenCount(capacity.usedTokens)} /{" "}
                {formatCompactTokenCount(capacity.contextWindow)} {t("panel.context.tokens", { defaultValue: "tokens" })}
              </span>
            </div>
            <div
              className="context-panel-capacity-meter"
              role="meter"
              aria-label={t("panel.context.usedCapacity", { defaultValue: "Context used" })}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={capacity.usedPercent}
              aria-valuetext={`${capacity.percentLabel} ${t("panel.context.used", { defaultValue: "used" })}`}
            >
              {capacity.usedTokens > 0 ? <span style={{ width: `${capacity.usedPercent}%` }} /> : null}
            </div>
            <div className="context-panel-summary-stats">
              <span>{t("panel.context.used", { defaultValue: "Used" })} <strong>{formatCompactTokenCount(capacity.usedTokens)}</strong></span>
              <span>{t("panel.context.remaining", { defaultValue: "Remaining" })} <strong>{formatCompactTokenCount(capacity.remainingTokens)}</strong></span>
            </div>
          </>
        ) : (
          <p className="context-panel-no-usage">
            {t("panel.context.noUsage", { defaultValue: "Usage appears after the first model response." })}
          </p>
        )}
      </section>

      {breakdown ? (
        <section className="context-panel-breakdown" aria-label={t("panel.context.breakdown", { defaultValue: "Breakdown" })}>
          <div className="context-panel-section-heading">
            <h3>{t("panel.context.breakdown", { defaultValue: "Breakdown" })}</h3>
            <span>{formatCompactTokenCount(breakdown.categoryEstimateTokens)} {t("panel.context.estimatedTokens", { defaultValue: "est. tokens" })}</span>
          </div>
          {breakdown.estimateMismatch ? (
            <p className="context-panel-estimate-note">
              {t("panel.context.estimateMismatch", {
                defaultValue: "Category estimates may differ from the model usage above.",
              })}
            </p>
          ) : null}
          <CategoryRows rows={breakdown.active} />
          {breakdown.systemDetails.length > 0 ? (
            <div className="context-panel-system-details">
              <div className="context-panel-section-heading">
                <h4>{t("panel.context.systemDetails", { defaultValue: "Inside system prompt" })}</h4>
                <span>{t("panel.context.shareOfSystem", { defaultValue: "% of system prompt" })}</span>
              </div>
              <CategoryRows rows={breakdown.systemDetails} />
            </div>
          ) : null}
          {breakdown.inactive.length > 0 ? (
            <details className="context-panel-inactive">
              <summary>{t("panel.context.inactive", { defaultValue: "Not in context" })} · {breakdown.inactive.length}</summary>
              <ul>{breakdown.inactive.map((category) => <li key={category.key}>{category.label}</li>)}</ul>
            </details>
          ) : null}
          {breakdown.deferred.map((category) => (
            <p className="context-panel-deferred" key={category.key}>
              {category.label} · {t("panel.context.onDemand", { defaultValue: "available on demand" })}
            </p>
          ))}
        </section>
      ) : (
        <p className="context-panel-estimate" role="status">
          {t("panel.context.estimateHint", {
            defaultValue: "This is usage from the last request, not a category breakdown. Complete a turn with Pi-Context active for details.",
          })}
        </p>
      )}

      <section className="context-panel-actions" aria-label={t("panel.context.packs", { defaultValue: "Context packs" })}>
        <h3>{t("panel.context.packs", { defaultValue: "Context packs" })}</h3>
        <p>{t("panel.context.packsHint", { defaultValue: "Save context, restore a named pack, or prepare a model handoff." })}</p>
        <label htmlFor="context-pack-name">
          {t("panel.context.packName", { defaultValue: "Pack name" })}
        </label>
        <input
          id="context-pack-name"
          className="field-input"
          value={packName}
          onChange={(event) => setPackName(event.target.value)}
          placeholder={t("panel.context.packPlaceholder", { defaultValue: "Optional for Export and Handoff" })}
          spellCheck={false}
        />
        <div className="context-panel-action-buttons">
          {CONTEXT_COMMANDS.map(([command, label, hint]) => (
            <Button
              key={command}
              type="button"
              size="sm"
              title={hint}
              disabled={!activeSessionId || busy || (command === "context-import" && !packName.trim())}
              onClick={() => void runPackCommand(command)}
            >
              {busy && runningCommand?.name === command
                ? t("common.loading", { defaultValue: "Working…" })
                : label}
            </Button>
          ))}
        </div>
      </section>
    </div>
  );
}
