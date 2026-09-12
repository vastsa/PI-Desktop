import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import { IconClose, IconCopy, IconMinus, IconSquare } from "./icons";
import { TooltipButton } from "./ui";

/**
 * Renderer-drawn window controls for Windows/Linux (D-frameless chrome).
 *
 * macOS keeps native inset traffic lights; other platforms run a frameless
 * window, so minimize/maximize/close live here — flat Codex-style glyph
 * buttons pinned to the top-right of the 46px titlebar band. The main shell
 * can contain the controls in the conversation pane while Settings keeps them
 * fixed to the full window.
 */
export function WindowControls({
  contained = false,
}: {
  contained?: boolean;
} = {}) {
  const { t } = useTranslation();
  const platform = window.piDesktop?.platform ?? "darwin";
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (platform === "darwin") return;
    let mounted = true;
    void api.windowControl("getState").then((state) => {
      if (mounted) setMaximized(state.maximized);
    }).catch(() => undefined);
    const unsubscribe = api.onWindowMaximized((e) =>
      setMaximized(e.maximized),
    );
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [platform]);

  if (platform === "darwin") return null;

  return (
    <div
      className={`window-controls no-drag${
        contained ? " window-controls-in-pane" : ""
      }`}
    >
      <TooltipButton
        type="button"
        className="window-control-btn"
        tooltip={t("window.minimize", "Minimize")}
        ariaLabel={t("window.minimize", "Minimize")}
        onClick={() => void api.windowControl("minimize")}
      >
        <IconMinus size={12} strokeWidth={1.5} aria-hidden />
      </TooltipButton>
      <TooltipButton
        type="button"
        className="window-control-btn"
        tooltip={
          maximized
            ? t("window.restore", "Restore")
            : t("window.maximize", "Maximize")
        }
        ariaLabel={
          maximized
            ? t("window.restore", "Restore")
            : t("window.maximize", "Maximize")
        }
        onClick={() =>
          void api.windowControl("toggleMaximize").then((r) =>
            setMaximized(r.maximized),
          )
        }
      >
        {maximized ? (
          <IconCopy size={11} strokeWidth={1.4} aria-hidden />
        ) : (
          <IconSquare size={10} strokeWidth={1.4} aria-hidden />
        )}
      </TooltipButton>
      <TooltipButton
        type="button"
        className="window-control-btn window-control-close"
        tooltip={t("window.close", "Close")}
        ariaLabel={t("window.close", "Close")}
        onClick={() => void api.windowControl("close")}
      >
        <IconClose size={12} strokeWidth={1.5} aria-hidden />
      </TooltipButton>
    </div>
  );
}
