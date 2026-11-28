import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ModelConfigImportCandidate } from "../../../lib/api";
import { api } from "../../../lib/api";
import { useAppStore } from "../../../stores/app-store";
import { Badge } from "../../../components/ui";
import {
  ImportGroup,
  ImportIdle,
  ImportResults,
  ImportRow,
  ImportToolbar,
  toggleKey,
  useGroupDisclosure,
} from "../import-workbench";

/* ---------------------------------------------------------------------------
 * Provider and model configuration
 * ------------------------------------------------------------------------- */

function hostOf(baseUrl: string | null): string {
  if (!baseUrl) return "";
  try {
    return new URL(baseUrl).host || baseUrl;
  } catch {
    return baseUrl.replace(/^https?:\/\//, "").split("/")[0] || baseUrl;
  }
}

export function ModelConfigImportPanel() {
  const { t } = useTranslation();
  const refreshProviders = useAppStore((s) => s.refreshProviders);
  const showToast = useAppStore((s) => s.showToast);
  const [candidates, setCandidates] = useState<ModelConfigImportCandidate[] | null>(
    null,
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const disclosure = useGroupDisclosure();
  const [scanning, setScanning] = useState(false);
  const [importing, setImporting] = useState(false);

  const keyOf = (candidate: ModelConfigImportCandidate) =>
    `${candidate.source}:${candidate.externalId}`;

  const scan = async () => {
    setScanning(true);
    try {
      const res = await api.scanImportModelConfigs();
      setCandidates(res.providers);
      setSelected(new Set());
      disclosure.reset();
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), { variant: "error" });
    } finally {
      setScanning(false);
    }
  };

  const runImport = async () => {
    if (!candidates) return;
    const items = candidates.filter((candidate) => selected.has(keyOf(candidate)));
    if (items.length === 0) return;
    setImporting(true);
    try {
      const res = await api.runImportModelConfigs(items);
      await refreshProviders();
      showToast(
        t("settings.importResult", {
          imported: res.imported,
          skipped: res.skipped,
          failed: res.failed,
        }),
        { variant: res.failed > 0 ? "error" : "success" },
      );
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), { variant: "error" });
    } finally {
      setImporting(false);
    }
  };

  const sourceLabels: Record<ModelConfigImportCandidate["source"], string> = useMemo(
    () => ({
      "claude-code": t("settings.importSourceClaudeCode"),
      opencode: t("settings.importSourceOpenCode"),
      codex: t("settings.importSourceCodex"),
      pi: t("settings.importSourcePi"),
      "cc-switch": t("settings.importSourceCcSwitch"),
    }),
    [t],
  );

  const groups = useMemo(() => {
    if (!candidates) return [];
    const grouped = new Map<
      ModelConfigImportCandidate["source"],
      ModelConfigImportCandidate[]
    >();
    for (const candidate of candidates) {
      const items = grouped.get(candidate.source) ?? [];
      items.push(candidate);
      grouped.set(candidate.source, items);
    }
    return [...grouped.entries()].map(([source, items]) => ({
      id: source,
      name: sourceLabels[source],
      items,
    }));
  }, [candidates, sourceLabels]);

  const allKeys = useMemo(() => (candidates ?? []).map(keyOf), [candidates]);
  const allSelected = allKeys.length > 0 && allKeys.every((k) => selected.has(k));

  const toggleKeys = (keys: string[], on: boolean) => {
    setSelected((previous) => {
      const next = new Set(previous);
      for (const key of keys) {
        if (on) next.add(key);
        else next.delete(key);
      }
      return next;
    });
  };

  return (
    <div className="import-workbench">
      {candidates === null ? (
        <ImportIdle
          description={t("settings.importModelsScanDesc")}
          onScan={() => void scan()}
          scanning={scanning}
        />
      ) : (
        <>
          <ImportToolbar
            found={t("settings.importModelsFound", { count: candidates.length })}
            selectedCount={selected.size}
            allSelected={allSelected}
            selectAllLabel={t("settings.importModelsSelectAll")}
            onToggleAll={(on) => toggleKeys(allKeys, on)}
            scanning={scanning}
            importing={importing}
            onScan={() => void scan()}
            onImport={() => void runImport()}
          />
          <ImportResults
            message={
              candidates.length === 0 ? t("settings.importModelsNone") : undefined
            }
          >
            <div className="import-groups">
              {groups.map((group, groupIndex) => {
                const groupKeys = group.items.map(keyOf);
                const groupSelected = groupKeys.filter((k) => selected.has(k)).length;
                const bodyId = `import-model-group-${groupIndex}`;
                return (
                  <ImportGroup
                    key={group.id}
                    bodyId={bodyId}
                    name={group.name}
                    count={group.items.length}
                    countLabel={t("settings.importModelsFound", {
                      count: group.items.length,
                    })}
                    expanded={disclosure.isExpanded(group.id)}
                    onToggle={() => disclosure.toggle(group.id)}
                    selection={{
                      label: t("settings.importModelsSelectGroup", { name: group.name }),
                      checked: groupSelected === groupKeys.length,
                      indeterminate:
                        groupSelected > 0 && groupSelected < groupKeys.length,
                      onChange: (on) => toggleKeys(groupKeys, on),
                    }}
                  >
                    {group.items.map((candidate) => {
                      const key = keyOf(candidate);
                      const host = hostOf(candidate.baseUrl);
                      return (
                        <ImportRow
                          key={key}
                          title={candidate.name}
                          meta={`${t("settings.importModelsCount", {
                            count: candidate.modelIds.length,
                          })}${host ? ` · ${host}` : ""}`}
                          checked={selected.has(key)}
                          onChange={(on) => setSelected((previous) => toggleKey(previous, key, on))}
                          badge={
                            <Badge tone={candidate.hasSecret ? "success" : "warning"}>
                              {candidate.hasSecret
                                ? t("settings.importModelsHasKey")
                                : t("settings.importModelsNoKey")}
                            </Badge>
                          }
                        />
                      );
                    })}
                  </ImportGroup>
                );
              })}
            </div>
          </ImportResults>
        </>
      )}
    </div>
  );
}
