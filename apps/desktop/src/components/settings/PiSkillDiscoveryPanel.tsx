import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { PiSkillDiscovery } from "@pi-desktop/shared";
import { api } from "../../lib/api";

export function PiSkillDiscoveryPanel() {
  const { t } = useTranslation();
  const [result, setResult] = useState<PiSkillDiscovery>({ candidates: [], errors: [] });
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setLoading(true);
    void api.discoverPiSkills().then(value => {
      if (active) setResult(value);
    }, reason => {
      if (active) setError(String(reason));
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [refresh]);
  async function enable(id: string) {
    setBusy(true);
    setError("");
    try {
      const imported = await api.importPiSkills(id);
      if (!imported.canceled) {
        if (imported.dependencies?.state === "failed") {
          setError(t("plugins.importExtensionDepsFailed", { id: imported.id, error: imported.dependencies.error }));
        }
        setRefresh(value => value + 1);
      }
    } catch (reason) {
      setError(String(reason));
      // Host registration can succeed before the runtime fails to start.
      // Rediscover so a registered import stays manageable through Plugins.
      setRefresh(value => value + 1);
    }
    finally { setBusy(false); }
  }
  return <section className="settings-card-block pi-skill-discovery" aria-label={t("plugins.piSkillsTitle")}>
    <h3 className="settings-card-heading">{t("plugins.piSkillsTitle")}</h3>
    <p className="settings-row-detail">{t("plugins.piSkillsHint")}</p>
    <button className="btn btn-secondary" disabled={loading || busy} onClick={() => { setError(""); setRefresh(value => value + 1); }}>{t("plugins.piSkillsRefresh")}</button>
    {loading ? <p role="status">{t("plugins.piSkillsLoading")}</p> : result.candidates.length === 0 ? <p>{t("plugins.piSkillsEmpty")}</p> : result.candidates.map(candidate => <div key={candidate.id} className="settings-row">
      <div className="settings-row-copy">
        <strong className="settings-row-title">{candidate.name}</strong>
        <div className="settings-row-detail">{candidate.path}</div>
        <div className="settings-row-detail">{candidate.skills.join(", ")}</div>
        {candidate.hasExtensions && <p>{t("plugins.piSkillsExecutable")}</p>}
      </div>
      <button className="btn btn-secondary" disabled={busy || candidate.imported} onClick={() => { void enable(candidate.id); }}>{t(candidate.imported ? "plugins.piSkillsImported" : "plugins.piSkillsImport")}</button>
    </div>)}
    {error && <p role="alert">{error}</p>}
    {result.errors.map(message => <p role="alert" key={message}>{message}</p>)}
  </section>;
}
