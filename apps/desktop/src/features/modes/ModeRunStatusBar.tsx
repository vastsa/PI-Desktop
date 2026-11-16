import { Pause, Pencil, Play, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  isModeRunOpen,
  type ModeControlAction,
  type ModeResolveAction,
  type ModeRun,
  type ModeUpdateRequest,
} from "@pi-desktop/shared";
import { Badge, Button, TooltipButton } from "../../components/ui";
import { useAppStore } from "../../stores/app-store";
import { modesApi, type ModeRunControlResult } from "./modes-api";
import { useModesStore } from "./modes-store";
import { applyRunUpdate, refreshModeRun } from "./modes-sync";
import { modeDisplayLabel } from "./mode-picker-model";
import { ModeRunEditForm } from "./ModeRunEditForm";
import { ModeRunElapsed } from "./ModeRunElapsed";
import {
  MODE_RUN_STATE_LABEL_KEYS,
  modeControlRequest,
  modeErrorMessage,
  modeResolveRequest,
  modeRunControls,
  modeRunRounds,
  modeRunStateKey,
} from "./mode-run-model";
import "../../styles/modes.css";

const STATE_TONES = {
  running: "success",
  waitingApproval: "warning",
  blocked: "error",
  waitingInput: "neutral",
  error: "error",
  paused: "neutral",
  budgetExhausted: "warning",
} as const;

/** Reads the session's run when the session opens; pushes keep it current. */
export function useSessionModeRun(sessionId: string | null | undefined): ModeRun | null {
  const run = useModesStore((state) => (sessionId ? state.runs[sessionId] ?? null : null));
  useEffect(() => {
    if (!sessionId) return;
    void refreshModeRun(sessionId).catch((error: unknown) => {
      console.warn("[modes] run load failed", error);
    });
  }, [sessionId]);
  return run && isModeRunOpen(run.state) ? run : null;
}

/** Status and controls of the session's open staged run, above the composer. */
export function ModeRunStatusBar({ sessionId }: { sessionId: string }) {
  const run = useSessionModeRun(sessionId);
  if (!run) return null;
  return <ModeRunStatusPanel key={run.id} run={run} />;
}

export function ModeRunStatusPanel({ run }: { run: ModeRun }) {
  const { t } = useTranslation();
  const catalog = useModesStore((state) => state.catalog);
  const showToast = useAppStore((state) => state.showToast);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  /** The ending action waiting for confirmation, if any. */
  const [confirm, setConfirm] = useState<"stop" | "remove" | null>(null);
  const [editing, setEditing] = useState(false);
  const stateKey = modeRunStateKey(run);
  const controls = modeRunControls(run);
  const rounds = modeRunRounds(run);
  const label = modeDisplayLabel(t, run.modeId, catalog);

  // A new revision is a new decision point: an armed Stop does not carry over.
  useEffect(() => setConfirm(null), [run.revision]);

  const act = async (request: () => Promise<ModeRunControlResult>, after?: () => void) => {
    // One request per decision: a double click must not send a second one.
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const result = await request();
      applyRunUpdate(run.sessionId, result.run);
      after?.();
    } catch (error) {
      showToast(modeErrorMessage(t, error), { variant: "error" });
      void refreshModeRun(run.sessionId).catch(() => undefined);
    } finally {
      inFlight.current = false;
      setBusy(false);
      setConfirm(null);
    }
  };
  const control = (action: ModeControlAction) => act(() => modesApi.controlRun(modeControlRequest(run, action)));
  const resolve = (action: ModeResolveAction) => act(() => modesApi.resolveRun(modeResolveRequest(run, action)));
  const update = (request: ModeUpdateRequest) => act(() => modesApi.updateRun(request), () => setEditing(false));

  return (
    <section
      className="mode-run-bar"
      role="region"
      aria-label={t("modes.run.region")}
      aria-busy={busy}
      data-state={stateKey}
      data-testid="mode-run-bar"
    >
      <div className="mode-run-summary">
        <span className="mode-run-label">{label}</span>
        <span className="mode-run-stage" title={t("modes.run.stage")}>
          <span className="sr-only">{t("modes.run.stage")}: </span>
          {run.stageId}
        </span>
        <Badge tone={STATE_TONES[stateKey]} className="mode-run-state">
          {t(MODE_RUN_STATE_LABEL_KEYS[stateKey])}
        </Badge>
        <span className="mode-run-metrics">
          <span className="mode-run-rounds">
            {t("modes.run.rounds", { completed: rounds.completed, max: rounds.max })}
          </span>
          <ModeRunElapsed run={run} />
        </span>
        {run.lastError ? (
          <span className="mode-run-error" title={run.lastError}>
            {t("modes.run.lastError", { message: run.lastError })}
          </span>
        ) : null}
      </div>
      <div className="mode-run-actions">
        {confirm ? (
          <>
            <span className="mode-run-confirm" role="alert">
              {t(confirm === "stop" ? "modes.run.stopConfirm" : "modes.run.removeConfirm")}
            </span>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirm(null)}>
              {t("modes.run.cancel")}
            </Button>
            <Button size="sm" variant="primary" disabled={busy} onClick={() => void control(confirm)}>
              {t(confirm === "stop" ? "modes.run.stopConfirmAction" : "modes.run.removeConfirmAction")}
            </Button>
          </>
        ) : (
          <>
            {controls.approve ? (
              <Button size="sm" variant="primary" disabled={busy} onClick={() => void resolve("approve")}>
                {t("modes.run.approve")}
              </Button>
            ) : null}
            {controls.reject ? (
              <Button size="sm" disabled={busy} onClick={() => void resolve("reject")}>
                {t("modes.run.reject")}
              </Button>
            ) : null}
            {controls.pause ? (
              <TooltipButton className="icon-btn icon-btn-square" tooltip={t("modes.run.pause")} disabled={busy} onClick={() => void control("pause")}>
                <Pause size={14} aria-hidden="true" />
              </TooltipButton>
            ) : null}
            {controls.resume ? (
              <TooltipButton className="icon-btn icon-btn-square" tooltip={t("modes.run.resume")} disabled={busy} onClick={() => void control("resume")}>
                <Play size={14} aria-hidden="true" />
              </TooltipButton>
            ) : null}
            {controls.edit && !editing ? (
              <TooltipButton className="icon-btn icon-btn-square" tooltip={t("modes.run.edit")} disabled={busy} onClick={() => setEditing(true)}>
                <Pencil size={14} aria-hidden="true" />
              </TooltipButton>
            ) : null}
            {controls.remove ? (
              <TooltipButton className="icon-btn icon-btn-square" tooltip={t("modes.run.remove")} disabled={busy} onClick={() => setConfirm("remove")}>
                <Trash2 size={14} aria-hidden="true" />
              </TooltipButton>
            ) : null}
            {controls.stop ? (
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirm("stop")}>
                {t("modes.run.stop")}
              </Button>
            ) : null}
          </>
        )}
      </div>
      {editing ? (
        <ModeRunEditForm run={run} busy={busy} onSave={(request) => void update(request)} onCancel={() => setEditing(false)} />
      ) : null}
    </section>
  );
}
