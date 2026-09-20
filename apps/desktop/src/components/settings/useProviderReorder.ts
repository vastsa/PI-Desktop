import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ProviderPublic } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { useCardReorder } from "../../hooks/use-card-reorder";
import { reorderItem, type ReorderPlacement } from "../../lib/list-reorder";

/** Preview a released move while saving; restore the accepted list on failure. */
export function useProviderReorder(providers: ProviderPublic[], busy: boolean) {
  const { t } = useTranslation();
  const [saving, setSaving] = useState(false);
  const pending = useRef(false);
  const [draft, setDraft] = useState<ProviderPublic[] | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const move = async (id: string, targetId: string, placement: ReorderPlacement) => {
    if (pending.current || busy) return;
    const next = reorderItem(providers, id, targetId, placement);
    if (next === providers) return;
    pending.current = true;
    setSaving(true);
    setDraft(next);
    try {
      await api.reorderProviders({ id, targetId, placement });
      await useAppStore.getState().refreshProviders();
    } catch (error) {
      useAppStore.getState().showToast(
        t("settings.providerOrderFailed", { error: error instanceof Error ? error.message : String(error) }),
        { variant: "error" },
      );
    } finally {
      pending.current = false;
      if (mounted.current) { setSaving(false); setDraft(null); }
    }
  };
  const reorder = useCardReorder(draft ?? providers, busy || saving, (id, target, placement) => {
    void move(id, target, placement);
  });
  return { ...reorder, saving, providers: draft ?? providers };
}
