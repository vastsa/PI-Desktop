import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { IconMonitor, IconX } from "../../components/icons";
import { Badge, Button, TooltipButton } from "../../components/ui";
import { AnchoredMenu } from "../../components/settings/AnchoredMenu";
import type { ComputerGrantView, ComputerTarget } from "@pi-desktop/shared";
import { useAppStore } from "../../stores/app-store";
import { computerUseApi } from "./computer-use-api";
import "../../styles/computer-use.css";

/**
 * The grant indicator and the only way to hand an application over
 * (ADR 0342 §4).
 *
 * The picker list comes from the host, including the windows it refuses, so a
 * window the user can see is either pickable or carries the reason it is not.
 * The model never appears in this flow: it cannot open the picker, cannot name
 * a target, and cannot dismiss the indicator.
 */
export function ComputerUseIndicator({ sessionId }: { sessionId: string | null }) {
  const { t } = useTranslation();
  // Read the switch here rather than threading it through the composer: the
  // indicator is the only consumer, and an absent setting means disabled.
  const enabled = useAppStore((state) => state.settings?.computerUse?.enabled === true);
  const [grant, setGrant] = useState<ComputerGrantView | null>(null);
  const [open, setOpen] = useState(false);
  const [targets, setTargets] = useState<ComputerTarget[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => computerUseApi.onGrantChanged(setGrant), []);

  useEffect(() => {
    if (!enabled) {
      setGrant(null);
      return;
    }
    let cancelled = false;
    void computerUseApi
      .grant()
      .then((result) => {
        if (!cancelled) setGrant(result.grant);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  const loadTargets = useCallback(() => {
    setTargets(null);
    setError(null);
    void computerUseApi
      .listTargets()
      .then((result) => setTargets(result.targets))
      .catch((failure: Error & { code?: string }) => {
        setTargets([]);
        setError(failure.code ?? "COMPUTER_PLATFORM_UNSUPPORTED");
      });
  }, []);

  const hand = useCallback(
    (targetId: string) => {
      if (!sessionId) return;
      setBusy(true);
      setError(null);
      void computerUseApi
        .createGrant({ targetId, sessionId })
        .then((created) => {
          setGrant(created);
          setOpen(false);
        })
        .catch((failure: Error & { code?: string }) => {
          setError(failure.code ?? "COMPUTER_ACTION_REJECTED");
        })
        .finally(() => setBusy(false));
    },
    [sessionId],
  );

  const stop = useCallback(() => {
    setBusy(true);
    void computerUseApi
      .revokeGrant("user")
      .then(() => setGrant(null))
      .catch(() => undefined)
      .finally(() => setBusy(false));
  }, []);

  if (!enabled) return null;

  if (grant && grant.state === "active") {
    return (
      <div className="computer-use-indicator" role="status">
        <IconMonitor size={14} aria-hidden="true" />
        <span className="computer-use-indicator-target">{grant.targetLabel}</span>
        <Badge tone={grant.capture === "a11y-and-pixels" ? "warning" : "neutral"}>
          {grant.capture === "a11y-and-pixels"
            ? t("computerUse.captureWithPixels")
            : t("computerUse.captureA11yOnly")}
        </Badge>
        <span className="computer-use-indicator-budget">
          {t("computerUse.stepsLeft", { count: grant.remainingBudget })}
        </span>
        <Button size="sm" variant="primary" onClick={stop} disabled={busy}>
          {t("computerUse.stop")}
        </Button>
      </div>
    );
  }

  return (
    <AnchoredMenu
      open={open}
      onClose={() => setOpen(false)}
      role="dialog"
      label={t("computerUse.pickTarget")}
      side="top"
      className="computer-use-control"
      menuClassName="computer-use-picker"
      trigger={(triggerRef) => (
        <TooltipButton
          ref={triggerRef}
          type="button"
          className="icon-btn icon-btn-square"
          tooltip={t("computerUse.pickTarget")}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => {
            const next = !open;
            setOpen(next);
            if (next) loadTargets();
          }}
        >
          <IconMonitor size={15} aria-hidden="true" />
        </TooltipButton>
      )}
    >
      <div className="computer-use-picker-body">
        <div className="computer-use-picker-title">{t("computerUse.pickTarget")}</div>
        <p className="computer-use-picker-hint">{t("computerUse.pickTargetHint")}</p>
        {error && <div className="computer-use-picker-error">{error}</div>}
        {targets === null && <div className="settings-hint">{t("computerUse.loadingTargets")}</div>}
        {targets?.length === 0 && !error && (
          <div className="settings-hint">{t("computerUse.noTargets")}</div>
        )}
        <ul className="computer-use-target-list">
          {(targets ?? []).map((target) => (
            <li key={target.targetId}>
              <button
                type="button"
                className="computer-use-target"
                disabled={busy || !!target.refusedReason || !sessionId}
                onClick={() => hand(target.targetId)}
              >
                <span className="computer-use-target-app">{target.appName}</span>
                <span className="computer-use-target-title">{target.title}</span>
                {target.refusedReason && (
                  <Badge tone="warning">{t(`computerUse.refused.${target.refusedReason}`)}</Badge>
                )}
              </button>
            </li>
          ))}
        </ul>
        {!sessionId && <div className="settings-hint">{t("computerUse.needSession")}</div>}
        <button type="button" className="computer-use-picker-close" onClick={() => setOpen(false)}>
          <IconX size={14} aria-hidden="true" />
          {t("computerUse.close")}
        </button>
      </div>
    </AnchoredMenu>
  );
}
