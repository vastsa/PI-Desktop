/**
 * Copy local providers to a paired SSH host (D625). A freshly installed host
 * has no models, so this is how the user makes its sessions answer. The
 * dialog offers only the rows main will accept (`isSyncableProvider`) and
 * says plainly that their API keys travel with them. Nothing syncs until the
 * user confirms.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { isSyncableProvider, type ProviderImportSummary } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { useBlockingOverlay } from "../../lib/blocking-overlay";
import { portalToBody } from "../../lib/portal-visibility";
import { useAppStore } from "../../stores/app-store";
import { Badge, Button, TooltipButton } from "../../components/ui";
import { IconClose } from "../../components/icons";

export type SyncProvidersDialogProps = {
  hostKey: string;
  hostLabel: string;
  onClose: () => void;
  onSynced: (summary: ProviderImportSummary) => void;
  onError: (error: unknown) => void;
};

export function SyncProvidersDialog({
  hostKey,
  hostLabel,
  onClose,
  onSynced,
  onError,
}: SyncProvidersDialogProps) {
  const { t } = useTranslation();
  useBlockingOverlay();
  const providers = useAppStore((state) => state.providers);
  const localDefaultId = useAppStore((state) => state.settings?.defaultProviderId);
  // The local default leads, so "first selected" is the default by default.
  const candidates = useMemo(() => {
    const syncable = providers.filter(isSyncableProvider);
    const lead = syncable.filter((provider) => provider.id === localDefaultId);
    return [...lead, ...syncable.filter((provider) => provider.id !== localDefaultId)];
  }, [providers, localDefaultId]);
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(localDefaultId && candidates.some((p) => p.id === localDefaultId) ? [localDefaultId] : []),
  );
  const [setDefault, setSetDefault] = useState(true);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const closedRef = useRef(false);

  useEffect(() => {
    closedRef.current = false;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (!busyRef.current) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      closedRef.current = true;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  const toggle = (id: string, checked: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });

  const sync = async () => {
    if (busyRef.current || selected.size === 0) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const summary = await api.syncRemoteHostProviders({
        hostKey,
        providerIds: candidates.filter((p) => selected.has(p.id)).map((p) => p.id),
        setDefault,
      });
      if (closedRef.current) return;
      onSynced(summary);
      onClose();
    } catch (error) {
      if (!closedRef.current) onError(error);
    } finally {
      busyRef.current = false;
      if (!closedRef.current) setBusy(false);
    }
  };

  const dialogId = "sync-remote-providers-dialog";
  const dialog = (
    <div
      className="overlay session-rename-dialog-overlay"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget && !busyRef.current) onClose();
      }}
    >
      <div
        className="dialog session-rename-dialog remote-session-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${dialogId}-title`}
        aria-describedby={`${dialogId}-description`}
        aria-busy={busy || undefined}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="session-rename-dialog-head">
          <div className="session-rename-dialog-heading">
            <h2 id={`${dialogId}-title`} className="session-rename-dialog-title">
              {t("settings.remoteHosts.syncTitle", { host: hostLabel })}
            </h2>
            <p id={`${dialogId}-description`} className="session-rename-dialog-description">
              {t("settings.remoteHosts.syncDescription")}
            </p>
          </div>
          <TooltipButton
            type="button"
            className="session-rename-dialog-close"
            tooltip={t("remote.cancel")}
            ariaLabel={t("remote.cancel")}
            disabled={busy}
            onClick={onClose}
          >
            <IconClose size={16} />
          </TooltipButton>
        </div>
        <div className="remote-session-dialog-body">
          {candidates.length === 0 ? (
            <div className="remote-session-dialog-empty">{t("settings.remoteHosts.syncEmpty")}</div>
          ) : (
            <div className="remote-sync-provider-list">
              {candidates.map((provider) => (
                <label key={provider.id} className="settings-config-sync-category">
                  <input
                    type="checkbox"
                    checked={selected.has(provider.id)}
                    disabled={busy}
                    onChange={(event) => toggle(provider.id, event.target.checked)}
                  />
                  <span>{provider.name}</span>
                  {provider.id === localDefaultId ? (
                    <Badge tone="neutral">{t("settings.remoteHosts.syncLocalDefault")}</Badge>
                  ) : null}
                </label>
              ))}
              <label className="settings-config-sync-category remote-sync-provider-default">
                <input
                  type="checkbox"
                  checked={setDefault}
                  disabled={busy}
                  onChange={(event) => setSetDefault(event.target.checked)}
                />
                <span>{t("settings.remoteHosts.syncSetDefault")}</span>
              </label>
            </div>
          )}
          <div className="session-rename-dialog-actions">
            <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
              {t("remote.cancel")}
            </Button>
            <Button
              type="button"
              variant="primary"
              disabled={busy || selected.size === 0}
              onClick={() => void sync()}
            >
              {busy ? t("settings.remoteHosts.syncRunning") : t("settings.remoteHosts.syncAction")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );

  return typeof document === "undefined" ? dialog : portalToBody(dialog);
}
