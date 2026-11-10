import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { IconRefresh } from "../../components/icons";
import { TooltipButton } from "../../components/ui";
import { useAppStore } from "../../stores/app-store";
import { cancelRendererRefresh, refreshRenderer } from "./renderer-refresh";

export function RendererRefreshButton({ className, reload }: { className?: string; reload?: () => void }) {
  const { t } = useTranslation();
  const [refreshing, setRefreshing] = useState(false);
  const latched = useRef(false);
  const deadline = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(deadline.current), []);
  const failed = () => {
    window.clearTimeout(deadline.current);
    try {
      cancelRendererRefresh();
    } catch (error) {
      console.warn("Refresh checkpoint cleanup failed", error instanceof Error ? error.name : "UnknownError");
    }
    latched.current = false;
    setRefreshing(false);
    useAppStore.getState().showToast(t("app.refreshFailed"), { variant: "error" });
  };
  const refresh = () => {
    if (latched.current) return;
    latched.current = true;
    setRefreshing(true);
    // A cancelled navigation returns normally. If this document survives,
    // release the button and expose a retry instead of leaving it grey forever.
    deadline.current = window.setTimeout(failed, 10_000);
    try {
      refreshRenderer(reload);
    } catch (error) {
      console.warn("Interface refresh aborted", error instanceof Error ? error.name : "UnknownError");
      failed();
    }
  };
  return <TooltipButton type="button" className={className} disabled={refreshing}
    tooltip={t("app.refreshHint")} ariaLabel={t("app.refreshInterface")} onClick={refresh}>
    <IconRefresh size={15} />
  </TooltipButton>;
}
