import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SessionPermissionGrant } from "@pi-desktop/shared";
import { api } from "../../../lib/api";

/** Host-owned grants are read afresh whenever the permission menu opens. */
export function SessionPermissionGrants({ sessionId, open }: { sessionId: string; open: boolean }) {
  const { t } = useTranslation();
  const [grants, setGrants] = useState<SessionPermissionGrant[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const generation = useRef<symbol | undefined>(undefined);
  const identity = useRef({ sessionId, open });
  identity.current = { sessionId, open };

  useEffect(() => {
    if (!open) return;
    const current = Symbol(sessionId);
    generation.current = current;
    const stillCurrent = () => generation.current === current && identity.current.open &&
      identity.current.sessionId === sessionId;
    let active = true;
    setGrants([]);
    setError(false);
    setBusy(false);
    setLoading(true);
    void api.listSessionPermissionGrants(sessionId).then(({ grants: next }) => {
      if (active && stillCurrent()) setGrants(next);
    }).catch(() => {
      if (active && stillCurrent()) setError(true);
    }).finally(() => {
      if (active && stillCurrent()) setLoading(false);
    });
    return () => {
      active = false;
      if (generation.current === current) generation.current = undefined;
    };
  }, [open, sessionId]);

  const revoke = async (grantId?: string) => {
    if (busy) return;
    const current = generation.current;
    if (!current || !identity.current.open || identity.current.sessionId !== sessionId) return;
    const stillCurrent = () => generation.current === current && identity.current.open &&
      identity.current.sessionId === sessionId;
    setBusy(true);
    setError(false);
    try {
      if (grantId) await api.revokeSessionPermissionGrant(sessionId, grantId);
      else await api.clearSessionPermissionGrants(sessionId);
      if (!stillCurrent()) return;
      const result = await api.listSessionPermissionGrants(sessionId);
      if (stillCurrent()) setGrants(result.grants);
    } catch {
      if (stillCurrent()) setError(true);
    } finally {
      if (stillCurrent()) setBusy(false);
    }
  };

  return (
    <div className="composer-permission-grants" role="group" aria-label={t("permission.grantsTitle")}>
      <span className="composer-plus-item" role="presentation">{t("permission.grantsTitle")}</span>
      {loading ? <span className="composer-plus-item" role="status">{t("permission.grantsLoading")}</span> : null}
      {error ? <span className="composer-plus-item" role="alert">{t("permission.grantsError")}</span> : null}
      {!loading && !error && grants.length === 0
        ? <span className="composer-plus-item">{t("permission.grantsEmpty")}</span> : null}
      {grants.map((grant) => (
        <button key={grant.id} type="button" role="menuitem" className="composer-plus-item"
          title={grant.label} disabled={busy}
          aria-label={t("permission.revokeGrant", { scope: grant.label })}
          onClick={() => void revoke(grant.id)}>
          <span className="flex-1 text-left">{grant.label}<small className="block text-text-muted">{t("permission.grantActor", { actor: grant.actorId })}</small></span>
          <span>{t("permission.revoke")}</span>
        </button>
      ))}
      {grants.length > 0 ? (
        <button type="button" role="menuitem" className="composer-plus-item" disabled={busy}
          onClick={() => void revoke()}>{t("permission.clearGrants")}</button>
      ) : null}
    </div>
  );
}
