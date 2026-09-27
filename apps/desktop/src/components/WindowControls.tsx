import { useEffect, useState } from "react";
import { Copy, Minus, Square, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";

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
      <button
        type="button"
        className="window-control-btn"
        title={t("window.minimize", "Minimize")}
        aria-label={t("window.minimize", "Minimize")}
        onClick={() => void api.windowControl("minimize")}
      >
        <Minus size={12} strokeWidth={1.5} aria-hidden />
      </button>
      <button
        type="button"
        className="window-control-btn"
        title={
          maximized
            ? t("window.restore", "Restore")
            : t("window.maximize", "Maximize")
        }
        aria-label={
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
          <Copy size={11} strokeWidth={1.4} aria-hidden />
        ) : (
          <Square size={10} strokeWidth={1.4} aria-hidden />
        )}
      </button>
      <button
        type="button"
        className="window-control-btn window-control-close"
        title={t("window.close", "Close")}
        aria-label={t("window.close", "Close")}
        onClick={() => void api.windowControl("close")}
      >
        <X size={12} strokeWidth={1.5} aria-hidden />
      </button>
    </div>
  );
}
