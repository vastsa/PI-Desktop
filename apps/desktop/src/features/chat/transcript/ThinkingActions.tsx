import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { UiMessage } from "@pi-desktop/shared";
import { Button } from "../../../components/ui";
import { api } from "../../../lib/api";
import { readThinkingMessageIds } from "../../../lib/thinking-history";
import { resolveShowThinking } from "../../../lib/thinking-visibility";
import { useAppStore } from "../../../stores/app-store";
import { useThinkingDisclosureActions } from "./disclosure";

/** Explicit history reads keep the operation independent of the DOM window. */
export function ThinkingActions({ sessionId, messages, onBeforeChange }: {
  sessionId: string;
  messages: UiMessage[];
  onBeforeChange: () => void;
}) {
  const { t } = useTranslation();
  const choices = useThinkingDisclosureActions();
  const showThinking = useAppStore((state) => resolveShowThinking(state.settings));
  const showToast = useAppStore((state) => state.showToast);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const lifetime = useRef<object | null>(null);
  useEffect(() => {
    lifetime.current = {};
    return () => { lifetime.current = null; };
  }, [sessionId]);

  const apply = async (open: boolean) => {
    if (!choices || pending.current) return;
    pending.current = true;
    setBusy(true);
    const owner = lifetime.current;
    try {
      const ids = await readThinkingMessageIds({
        sessionId, liveMessages: messages, readSession: api.getSession,
        isCurrent: () => Boolean(owner && lifetime.current === owner),
      });
      if (!ids) return;
      onBeforeChange();
      choices.setThinking(ids, open);
    } catch (error) {
      if (owner && lifetime.current === owner) {
        showToast(t("chat.thinkingActionFailed", {
          error: error instanceof Error ? error.message : String(error),
        }), { variant: "error" });
      }
    } finally {
      pending.current = false;
      if (owner && lifetime.current === owner) setBusy(false);
    }
  };

  if (!choices || !showThinking) return null;
  return <div className="transcript-thinking-actions" role="group" aria-label={t("chat.thinkingActions")} aria-busy={busy}>
    <Button variant="ghost" size="sm" disabled={busy} onClick={() => void apply(true)}>
      {t("chat.expandAllThinking")}
    </Button>
    <Button variant="ghost" size="sm" disabled={busy} onClick={() => void apply(false)}>
      {t("chat.collapseAllThinking")}
    </Button>
  </div>;
}
