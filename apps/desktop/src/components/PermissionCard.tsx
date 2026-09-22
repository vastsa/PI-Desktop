import { useEffect, useMemo, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import {
  permissionSecondsLeft,
  type PendingPermission,
} from "../lib/pending-permissions";
import { getToolPromptName } from "../lib/tool-display";
import { useAppStore } from "../stores/app-store";
import { buildToolPresentation } from "../lib/tool-presentation";
import { ToolDetailBlocks } from "./ToolDetails";
import { Button } from "./ui";

export function PermissionCard({
  permission,
  queued = 0,
}: {
  permission: PendingPermission;
  /** Requests waiting behind this one; the user answers them in order. */
  queued?: number;
}) {
  const { t } = useTranslation();
  const resolvePermission = useAppStore((state) => state.resolvePermission);
  const showToast = useAppStore((state) => state.showToast);
  const workspace = useAppStore((state) =>
    state.sessions.find((session) => session.id === permission.sessionId)?.projectPath,
  );
  const [secondsLeft, setSecondsLeft] = useState(() =>
    permissionSecondsLeft(permission.receivedAt),
  );
  const [resolving, setResolving] = useState(false);
  const timeoutHandled = useRef(false);

  const restoreComposerFocus = () => {
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLTextAreaElement>(".composer-input")?.focus();
    });
  };

  const resolve = async (
    decision: "allow-once" | "allow-session" | "deny",
  ) => {
    if (resolving) return;
    setResolving(true);
    try {
      await resolvePermission(permission.sessionId, permission.requestId, decision);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), {
        variant: "error",
      });
      setResolving(false);
    } finally {
      restoreComposerFocus();
    }
  };

  useEffect(() => {
    timeoutHandled.current = false;
    const update = () => setSecondsLeft(permissionSecondsLeft(permission.receivedAt));
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [permission.receivedAt, permission.requestId]);

  useEffect(() => {
    if (secondsLeft > 0 || timeoutHandled.current || resolving) return;
    timeoutHandled.current = true;
    void resolve("deny");
  }, [resolving, secondsLeft]);

  // Same structured presentation as the transcript tool rows: a command reads
  // as shell, file content as code, everything else as labeled fields.
  const argBlocks = useMemo(
    () =>
      buildToolPresentation({
        toolName: permission.toolName,
        toolArgs: permission.argsPreview,
      }),
    [permission.argsPreview, permission.toolName],
  );
  const risk = (permission.risk || "high") as "low" | "medium" | "high";

  return (
    <section
      className={`permission-card risk-${risk}`}
      role="region"
      aria-label={t("permission.title")}
    >
      <div className="permission-card-header">
        <span className="permission-card-title" role="status" aria-live="polite">
          {t("permission.title")}
        </span>
        {queued > 0 ? (
          <span className="permission-card-queued">
            {t("permission.queued", { count: queued })}
          </span>
        ) : null}
        <span className={`permission-risk risk-${risk}`}>
          {t(`permission.risk.${risk}`)}
        </span>
      </div>
      {permission.agentName ? (
        <div className="permission-card-agent">
          {t("permission.fromSubagent", { agent: permission.agentName })}
        </div>
      ) : null}
      <div className="permission-card-prompt">
        <Trans
          i18nKey="permission.allowPrompt"
          values={{ tool: getToolPromptName(permission.toolName) }}
          components={{ highlight: <span className="text-text-primary" /> }}
        />
      </div>
      {permission.reason ? (
        <div className="permission-card-reason">{permission.reason}</div>
      ) : null}
      {argBlocks.length > 0 ? (
        <div className="permission-card-args">
          <ToolDetailBlocks blocks={argBlocks} />
        </div>
      ) : null}
      <div className="permission-card-meta">
        <span title={workspace}>
          {t("permission.workspace", {
            workspace: workspace || t("permission.temporarySession"),
          })}
        </span>
        <span role="timer">
          {t("permission.countdown", { seconds: secondsLeft })}
        </span>
      </div>
      <div className="permission-card-actions">
        <Button
          variant="ghost"
          disabled={resolving}
          onClick={() => void resolve("deny")}
        >
          {t("permission.deny")}
        </Button>
        <Button
          variant="secondary"
          disabled={resolving}
          onClick={() => void resolve("allow-session")}
        >
          {t("permission.allowSession")}
        </Button>
        <Button
          variant="primary"
          disabled={resolving}
          onClick={() => void resolve("allow-once")}
        >
          {t("permission.allowOnce")}
        </Button>
      </div>
    </section>
  );
}
