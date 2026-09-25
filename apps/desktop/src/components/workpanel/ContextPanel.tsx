import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatCompactTokenCount } from "@pi-desktop/shared";
import {
  CONTEXT_SNAPSHOT_STATUS_KEY,
  fallbackContextSnapshot,
  parseContextSnapshotStatus,
  type ContextPanelSnapshot,
} from "../../lib/context-panel";
import { latestTurnContextInspector } from "../../lib/latest-turn-context";
import { api } from "../../lib/api";
import { runExtensionCommand } from "../../lib/commands";
import { useAppStore } from "../../stores/app-store";
import { Button } from "../ui";

const EMPTY_COMPACTIONS: [] = [];

const CONTEXT_COMMANDS = [
  ["context-export", "Export"],
  ["context-import", "Import"],
  ["context-handoff", "Handoff"],
] as const;

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
  const [extensionSnapshot, setExtensionSnapshot] =
    useState<ContextPanelSnapshot | null>(null);
  const [packName, setPackName] = useState("");
  const [runningCommand, setRunningCommand] = useState<string | null>(null);

  const fallback = useMemo(() => {
    const inspector = latestTurnContextInspector(
      messages,
      providerModels,
      providers,
      compactions,
    );
    return inspector
      ? fallbackContextSnapshot(inspector.usage, inspector.contextWindow)
      : null;
  }, [compactions, messages, providerModels, providers]);

  useEffect(() => {
    setExtensionSnapshot(null);
    if (!activeSessionId) return undefined;
    return api.onExtensionStatus((event) => {
      if (
        event.sessionId !== activeSessionId ||
        event.key !== CONTEXT_SNAPSHOT_STATUS_KEY
      ) {
        return;
      }
      const snapshot = parseContextSnapshotStatus(event.text);
      if (snapshot) setExtensionSnapshot(snapshot);
    });
  }, [activeSessionId]);

  const snapshot = extensionSnapshot ?? fallback;
  const runPackCommand = async (command: string) => {
    setRunningCommand(command);
    try {
      await runExtensionCommand(command, packName.trim());
      showToast(
        t("panel.context.commandStarted", {
          defaultValue: "Context command started",
        }),
        { variant: "success" },
      );
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), {
        variant: "error",
      });
    } finally {
      setRunningCommand(null);
    }
  };

  const usedTokens = snapshot?.totalTokens ?? snapshot?.categories
    .filter((category) => category.key !== "free" && !category.deferred)
    .reduce((total, category) => total + category.tokens, 0) ?? 0;

  return (
    <div className="context-panel">
      {snapshot ? (
        <>
      <div className="context-panel-summary">
        <div>
          <h2>{t("panel.context.title", { defaultValue: "Context" })}</h2>
          <p>
            {snapshot.modelName ||
              t("panel.context.currentSession", {
                defaultValue: "Current session",
              })}
          </p>
        </div>
        <strong>
          {snapshot.unknownTotal ? "~" : ""}
          {formatCompactTokenCount(usedTokens)} /{" "}
          {formatCompactTokenCount(snapshot.contextWindow)}
        </strong>
      </div>

      <div className="context-panel-categories" role="list">
        {snapshot.categories.map((category) => (
          <div className="context-panel-category" role="listitem" key={category.key}>
            <div className="context-panel-category-label">
              <span>{category.label}</span>
              <span>
                {formatCompactTokenCount(category.tokens)} · {Math.round(category.percent)}%
              </span>
            </div>
            <div className="context-panel-meter" aria-hidden>
              <span style={{ width: `${Math.min(100, category.percent)}%` }} />
            </div>
          </div>
        ))}
      </div>
        </>
      ) : (
        <p className="context-panel-empty">
          {t("panel.context.noUsage", {
            defaultValue: "Context usage appears after the first model response.",
          })}
        </p>
      )}

      <div className="context-panel-actions">
        <label htmlFor="context-pack-name">
          {t("panel.context.packName", { defaultValue: "Context pack" })}
        </label>
        <input
          id="context-pack-name"
          className="field-input"
          value={packName}
          onChange={(event) => setPackName(event.target.value)}
          placeholder={t("panel.context.packPlaceholder", {
            defaultValue: "Optional pack name",
          })}
          spellCheck={false}
        />
        <div className="context-panel-action-buttons">
          {CONTEXT_COMMANDS.map(([command, label]) => (
            <Button
              key={command}
              type="button"
              size="sm"
              disabled={!activeSessionId || runningCommand !== null}
              onClick={() => void runPackCommand(command)}
            >
              {runningCommand === command
                ? t("common.loading", { defaultValue: "Working…" })
                : label}
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}
