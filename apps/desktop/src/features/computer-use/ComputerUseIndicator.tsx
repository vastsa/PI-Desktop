import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { IconMonitor } from "../../components/icons";
import { Badge, Button } from "../../components/ui";
import type { ComputerGrantView } from "@pi-desktop/shared";
import { useAppStore } from "../../stores/app-store";
import { computerUseApi } from "./computer-use-api";
import "../../styles/computer-use.css";

/**
 * The grant indicator: what the agent is operating, and how to stop it
 * (ADR 0342 §4, ADR 0344).
 *
 * There is nothing to choose here. The grant covers the desktop and is minted
 * by the host on the agent's first call, so this surface exists only to make
 * the capability visible while it is live and to end it: Stop revokes the grant
 * and aborts the turn that holds it, because revoking alone would let the same
 * turn immediately ask for another one.
 */
export function ComputerUseIndicator({
  sessionId,
  abort,
}: {
  sessionId: string | null;
  /** Aborts the active session's turn. Stop is not just a revoke. */
  abort: () => Promise<void>;
}) {
  const { t } = useTranslation();
  // Read the switch here rather than threading it through the composer: the
  // indicator is the only consumer, and an absent setting means disabled.
  const enabled = useAppStore((state) => state.settings?.computerUse?.enabled === true);
  const [grant, setGrant] = useState<ComputerGrantView | null>(null);
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

  const stop = useCallback(async () => {
    setBusy(true);
    try {
      await computerUseApi.revokeGrant("user").catch(() => undefined);
      setGrant(null);
      // Only the turn the user is looking at: aborting someone else's session
      // from this button would stop work they never asked to stop.
      if (grant && sessionId && grant.sessionId === sessionId) await abort().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }, [abort, grant, sessionId]);

  if (!enabled || !grant || grant.state !== "active") return null;

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
      <Button size="sm" variant="primary" onClick={() => void stop()} disabled={busy}>
        {t("computerUse.stop")}
      </Button>
    </div>
  );
}
