import { useEffect, useId, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ModeDocumentValidation, ModeSkillsResult } from "@pi-desktop/shared";
import { Badge, Button, Field, Input, SegmentedControl, Textarea } from "../../components/ui";
import { useArmedDelete } from "../../hooks/use-armed-delete";
import { useAppStore } from "../../stores/app-store";
import { SettingsCard } from "../settings/primitives";
import { modesApi } from "./modes-api";
import { setModeCatalog, useModesStore } from "./modes-store";
import { refreshModeCatalog } from "./modes-sync";
import { modeErrorMessage } from "./mode-run-model";
import {
  bundleDraftDirty,
  bundleDraftFrom,
  bundleReferencesChanged,
  disabledSkillsAfterToggle,
  modeDocumentFormat,
  modeSettingsTabs,
  newBundleDraft,
  newBundleProblem,
  setBundleList,
  type ModeBundleDraft,
  type ModeDocumentFormat,
  type ModeSettingsTab,
} from "./mode-bundle-model";
import {
  duplicateModeSource,
  labelFromModeId,
  modeEntryDiagnostic,
  modeEntryKey,
  newModeIdProblem,
  rejectedValidation,
  settingsModeEntries,
  type NewModeIdProblem,
} from "./modes-settings-model";
import { ModeTab, SkillsTab, SubagentsTab } from "./ModeBundleTabs";
import { useModeSourceValidation } from "./use-mode-source-validation";
import "../../styles/modes.css";

/** Settings → Modes owns the catalog, detail navigation, and shared draft. */

/** The document open in the editor; `saved: false` is a new or duplicated one. */
type OpenDocument = {
  id: string;
  builtin: boolean;
  filePath?: string;
  format: ModeDocumentFormat;
  saved: boolean;
};

type IdForm = { purpose: "new" | "duplicate"; value: string };

const ID_PROBLEM_KEYS: Record<NewModeIdProblem, string> = {
  invalid: "modes.settings.idInvalid",
  reserved: "modes.settings.idReserved",
  taken: "modes.settings.idTaken",
};

const TAB_LABEL_KEYS: Record<ModeSettingsTab, string> = {
  mode: "modes.settings.tabMode",
  prompt: "modes.settings.promptTitle",
  subagents: "modes.settings.tabSubagents",
  skills: "modes.settings.tabSkills",
};

export function ModesSettingsPage() {
  const { t } = useTranslation();
  const catalog = useModesStore((state) => state.catalog);
  const showToast = useAppStore((state) => state.showToast);
  const [open, setOpen] = useState<OpenDocument | null>(null);
  const [tab, setTab] = useState<ModeSettingsTab>("mode");
  const [idForm, setIdForm] = useState<IdForm | null>(null);
  const [busyModeId, setBusyModeId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [roleSelection, setRoleSelection] = useState<string | null>(null);
  const [skills, setSkills] = useState<ModeSkillsResult | null>(null);

  // A legacy document is one Markdown source; a bundle is a map plus the
  // documents it names. They are separate drafts so neither tab shows the
  // other's text.
  const [legacyDraft, setLegacyDraft] = useState("");
  const [legacySaved, setLegacySaved] = useState("");
  const [bundleDraft, setBundleDraft] = useState<ModeBundleDraft | null>(null);
  const [bundleSaved, setBundleSaved] = useState<ModeBundleDraft | null>(null);

  const readTicket = useRef(0);
  const skillsTicket = useRef(0);
  const tabsId = useId();
  const pageHeading = useRef<HTMLHeadingElement>(null);
  const { armed, setArmed } = useArmedDelete();
  const editable = !!open;
  const removable = !!open && open.saved && (!open.builtin || !!open.filePath);

  const tabs = modeSettingsTabs(open?.format ?? "bundle");
  const activeTab: ModeSettingsTab = tabs.includes(tab) ? tab : "mode";
  const isBundle = open?.format === "bundle";

  const busy = busyModeId !== null;
  const controlsDisabled = busy || loading;
  const dirty = !!open && (!open.saved || (isBundle
    ? bundleDraftDirty(bundleDraft, bundleSaved)
    : legacyDraft !== legacySaved));
  const { validation, pending, record } = useModeSourceValidation(
    isBundle ? null : (open?.id ?? null),
    legacyDraft,
    editable && !isBundle,
  );

  useEffect(() => {
    void refreshModeCatalog().catch((error: unknown) => {
      console.warn("[modes] catalog load failed", error);
    });
    return () => { readTicket.current += 1; };
  }, []);

  const openId = open?.id;
  const formOpen = idForm !== null;
  useEffect(() => {
    if (!formOpen) pageHeading.current?.focus();
  }, [openId, formOpen]);
  const entries = settingsModeEntries(catalog);
  const discardAllowed = () => !dirty || window.confirm(t("modes.settings.discardConfirm"));

  /** Read one mode's documents, tagged so a stale answer is dropped. */
  const loadMode = async (id: string): Promise<boolean> => {
    const ticket = ++readTicket.current;
    setLoading(true);
    setIdForm(null);
    setArmed(null);
    try {
      const document = await modesApi.read(id);
      if (ticket !== readTicket.current) return false;
      const format = modeDocumentFormat(document);
      const draft = format === "bundle" ? bundleDraftFrom(await modesApi.readBundle(id)) : null;
      if (ticket !== readTicket.current) return false;

      setBundleDraft(draft);
      setBundleSaved(draft);
      setLegacyDraft(draft ? "" : document.source);
      setLegacySaved(draft ? "" : document.source);
      setSkills(null);
      setRoleSelection(null);
      setOpen({
        id: document.id,
        builtin: document.builtin,
        format,
        saved: true,
        ...(document.filePath ? { filePath: document.filePath } : {}),
      });
      setTab("mode");
      if (draft) void loadSkills(id, ticket);
      return true;
    } catch (error) {
      if (ticket === readTicket.current) showToast(modeErrorMessage(t, error), { variant: "error" });
      return false;
    } finally {
      if (ticket === readTicket.current) setLoading(false);
    }
  };

  /** The mode's skills folder and its rows; guarded by the same read ticket. */
  const loadSkills = async (id: string, ticket: number) => {
    const request = ++skillsTicket.current;
    const current = () => ticket === readTicket.current && request === skillsTicket.current;
    try {
      const state = await modesApi.skills(id);
      if (current() && state.modeId === id) setSkills(state);
    } catch (error) {
      if (current()) {
        console.warn("[modes] skills load failed", error);
        setSkills(null);
      }
    }
  };

  const openEntry = (modeId: string) => {
    if (modeId !== busyModeId && discardAllowed()) void loadMode(modeId);
  };

  const backToCatalog = () => {
    if (!discardAllowed()) return;
    readTicket.current += 1;
    setLoading(false);
    setIdForm(null);
    setOpen(null);
    setRoleSelection(null);
    setSkills(null);
    setArmed(null);
  };

  const idProblem = idForm ? newModeIdProblem(idForm.value.trim(), catalog) : null;

  // New modes are YAML bundles. Only legacy duplication starts another draft;
  // a saved bundle's Duplicate goes through the host's file-copy boundary.
  const submitIdForm = async () => {
    if (!idForm || idProblem || controlsDisabled) return;
    const id = idForm.value.trim();
    if (idForm.purpose === "new" && !discardAllowed()) return;
    if (idForm.purpose === "duplicate") {
      await duplicateMode(id);
      return;
    }
    readTicket.current += 1;
    setOpen({ id, builtin: false, format: "bundle", saved: false });
    setBundleDraft(
      newBundleDraft({
        id,
        label: labelFromModeId(id),
        description: t("modes.settings.templateDescription"),
        prompt: t("modes.settings.templatePrompt"),
      }),
    );
    setBundleSaved(null);
    setLegacyDraft("");
    setLegacySaved("");
    setRoleSelection(null);
    setSkills(null);
    setTab("mode");
    setIdForm(null);
  };

  /** Copy the saved bundle through the host, then open it if still selected. */
  const duplicateMode = async (id: string) => {
    if (!open) return;
    if (!isBundle) {
      duplicateLegacy(id);
      return;
    }
    if (!open.saved || !discardAllowed()) return;
    const ticket = readTicket.current;
    setBusyModeId(open.id);
    try {
      const next = await modesApi.copy({ fromId: open.id, toId: id });
      if (next) setModeCatalog(next);
      if (ticket === readTicket.current && (await loadMode(id))) {
        showToast(t("modes.settings.duplicated", { id }), { variant: "success" });
      }
    } catch (error) {
      if (ticket === readTicket.current) showToast(modeErrorMessage(t, error), { variant: "error" });
    } finally {
      setBusyModeId(null);
    }
  };

  const duplicateLegacy = (id: string) => {
    readTicket.current += 1;
    const source = duplicateModeSource(legacyDraft, id);
    setOpen({ id, builtin: false, format: "legacy", saved: false });
    setLegacyDraft(source);
    setLegacySaved("");
    setBundleDraft(null);
    setBundleSaved(null);
    setIdForm(null);
    setTab("mode");
  };
  const save = async () => {
    if (!open || controlsDisabled || !dirty) return;
    // A saved mode's write only touches the documents its map already names.
    // Changing that set would leave the old documents behind and write over
    // whatever sits at the new path — including files the mode does not manage.
    if (open.format === "bundle" && bundleDraft && bundleReferencesChanged(bundleDraft, bundleSaved)) {
      showToast(t("modes.settings.referencesFixed"), { variant: "error" });
      return;
    }
    const ticket = readTicket.current;
    setBusyModeId(open.id);
    try {
      if (open.format === "bundle") {
        if (!bundleDraft) return;
        const next = await modesApi.writeBundle({
          id: open.id,
          source: bundleDraft.source,
          prompt: bundleDraft.prompt,
          agents: bundleDraft.agents,
        });
        if (next) setModeCatalog(next);
        if (ticket !== readTicket.current) return;
        const filePath = next?.modes.find((entry) => entry.id === open.id && !entry.reserved)?.filePath;
        setBundleSaved(bundleDraft);
        setOpen((current) =>
          current?.id === open.id ? { ...current, saved: true, ...(filePath ? { filePath } : {}) } : current,
        );
        void loadSkills(open.id, ticket);
      } else {
        const source = legacyDraft;
        const next = await modesApi.write({ id: open.id, source });
        if (next) setModeCatalog(next);
        if (ticket !== readTicket.current) return;
        const filePath = next?.modes.find((entry) => entry.id === open.id && !entry.reserved)?.filePath;
        setLegacySaved(source);
        setOpen((current) =>
          current?.id === open.id ? { ...current, saved: true, ...(filePath ? { filePath } : {}) } : current,
        );
      }
      showToast(t("modes.settings.saved"), { variant: "success" });
    } catch (error) {
      if (ticket !== readTicket.current) return;
      const rejected = rejectedValidation(error);
      if (rejected && !isBundle) record(legacyDraft, rejected);
      showToast(modeErrorMessage(t, error), { variant: "error" });
    } finally {
      setBusyModeId(null);
    }
  };

  const saveSkill = async (id: string, enabled: boolean) => {
    if (!open?.saved || controlsDisabled || !bundleSaved || !bundleDraft || skills?.modeId !== open.id) return;
    const ticket = readTicket.current;
    const disabledSkills = disabledSkillsAfterToggle(bundleSaved.source, id, enabled);
    setBusyModeId(open.id);
    try {
      const next = await modesApi.saveBundleSettings({ id: open.id, disabledSkills });
      if (next) setModeCatalog(next);
      if (ticket !== readTicket.current) return;
      // The host saved only this setting; do not replace unsaved text in the other tabs.
      const contents = bundleDraftFrom(await modesApi.readBundle(open.id));
      if (ticket !== readTicket.current) return;
      setBundleSaved(contents);
      setBundleDraft({
        source: bundleDraft.source === bundleSaved.source ? contents.source : setBundleList(
          bundleDraft.source, "disabledSkills", disabledSkillsAfterToggle(bundleDraft.source, id, enabled),
        ),
        prompt: bundleDraft.prompt === bundleSaved.prompt ? contents.prompt : bundleDraft.prompt,
        agents: bundleDraft.agents === bundleSaved.agents ? contents.agents : bundleDraft.agents,
      });
      await loadSkills(open.id, ticket);
      if (ticket === readTicket.current) showToast(t("modes.settings.saved"), { variant: "success" });
    } catch (error) {
      if (ticket === readTicket.current) showToast(modeErrorMessage(t, error), { variant: "error" });
    } finally {
      setBusyModeId(null);
    }
  };

  const openSkills = async () => {
    if (!open?.saved || controlsDisabled) return;
    const ticket = readTicket.current;
    setBusyModeId(open.id);
    try {
      await modesApi.openSkillsDirectory(open.id);
      if (ticket === readTicket.current) await loadSkills(open.id, ticket);
    } catch (error) {
      if (ticket === readTicket.current) showToast(modeErrorMessage(t, error), { variant: "error" });
    } finally {
      setBusyModeId(null);
    }
  };

  const remove = async () => {
    if (!open || !removable || controlsDisabled) return;
    if (armed !== open.id) {
      setArmed(open.id);
      return;
    }
    setArmed(null);
    const ticket = readTicket.current;
    setBusyModeId(open.id);
    try {
      const next = await modesApi.remove(open.id);
      if (next) setModeCatalog(next);
      if (ticket !== readTicket.current) return;
      if (open.builtin) {
        if (await loadMode(open.id)) showToast(t("modes.settings.restored"), { variant: "success" });
      } else {
        readTicket.current += 1;
        setOpen(null);
        setLegacyDraft("");
        setLegacySaved("");
        setBundleDraft(null);
        setBundleSaved(null);
        setRoleSelection(null);
        setSkills(null);
        showToast(t("modes.settings.deleted"), { variant: "success" });
      }
    } catch (error) {
      if (ticket === readTicket.current) showToast(modeErrorMessage(t, error), { variant: "error" });
    } finally {
      setBusyModeId(null);
    }
  };

  const openLabel = open
    ? catalog?.modes.find((entry) => entry.id === open.id && !entry.reserved)?.label ||
      labelFromModeId(open.id)
    : "";
  const knownErrors = !isBundle && !!validation && validation.errors.length > 0;
  // A mode that has never been saved has no directory yet, so its first save
  // must be able to create one: a `promptFile` and its text are both required.
  const firstSaveProblem = isBundle && !bundleSaved && bundleDraft ? newBundleProblem(bundleDraft) : null;
  const saveBlocked = knownErrors || !!firstSaveProblem;
  const tabOptions = tabs.map((value) => ({
    value,
    label: t(TAB_LABEL_KEYS[value]),
    id: `${tabsId}-tab-${value}`,
    controls: `${tabsId}-panel-${value}`,
  }));

  return (
    <div className="settings-stack modes-settings-page" data-testid="modes-settings">
      {idForm ? (
        <>
          <div className="modes-settings-breadcrumb">
            <Button size="sm" variant="ghost" onClick={backToCatalog}>
              <ChevronLeft size={14} aria-hidden="true" />
              {t("modes.settings.listTitle")}
            </Button>
          </div>
        <SettingsCard title={t(idForm.purpose === "new" ? "modes.settings.newMode" : "modes.settings.duplicate")}>
          <ModeIdForm
            t={t}
            form={idForm}
            problem={idForm.value.trim() ? idProblem : null}
            disabled={controlsDisabled}
            onChange={(value) => setIdForm({ ...idForm, value })}
            onSubmit={() => void submitIdForm()}
            onCancel={() => { setIdForm(null); }}
          />
        </SettingsCard>
        </>
      ) : !open ? (
        <>
          <div className="modes-settings-page-head">
            <h2 ref={pageHeading} tabIndex={-1}>{t("modes.settings.listTitle")}</h2>
            <Button size="sm" variant="primary" disabled={controlsDisabled} onClick={() => setIdForm({ purpose: "new", value: "" })}>
              {t("modes.settings.newMode")}
            </Button>
          </div>
          {(["builtin", "user"] as const).map((source) => {
            const group = entries.filter((entry) => entry.source === source);
            if (!group.length) return null;
            const title = t(source === "builtin" ? "modes.settings.builtin" : "modes.settings.user");
            return (
              <SettingsCard key={source} title={title}>
                <div className="modes-settings-list" role="list" aria-label={title}>
                  {group.map((entry) => {
                    const diagnostic = modeEntryDiagnostic(catalog, entry);
                    return (
                      <div role="listitem" key={modeEntryKey(entry)}>
                        <Button
                          type="button"
                          variant="ghost"
                          className="modes-settings-row"
                          aria-disabled={entry.reserved || busyModeId === entry.id || undefined}
                          title={diagnostic.errors[0] ?? (entry.reserved ? t("modes.settings.reservedHint") : undefined)}
                          data-mode-id={entry.id}
                          onClick={() => { if (!entry.reserved) openEntry(entry.id); }}
                        >
                          <span className="modes-settings-row-copy">{entry.label || entry.id}</span>
                          {entry.customized && <Badge>{t("modes.settings.customized")}</Badge>}
                          {entry.staged && <Badge>{t("modes.settings.staged")}</Badge>}
                          {entry.reserved ? <Badge tone="warning">{t("modes.settings.reserved")}</Badge>
                            : !entry.available ? <Badge tone="error">{t("modes.settings.unavailable")}</Badge> : null}
                          <ChevronRight size={14} aria-hidden="true" />
                        </Button>
                      </div>
                    );
                  })}
                </div>
              </SettingsCard>
            );
          })}
          {catalog?.directory && <div className="modes-settings-path" data-testid="modes-directory">{catalog.directory}</div>}
        </>
      ) : (
        <>
          <div className="modes-settings-breadcrumb">
            <Button size="sm" variant="ghost" onClick={backToCatalog}>
              <ChevronLeft size={14} aria-hidden="true" />
              {t("modes.settings.listTitle")}
            </Button>
          </div>
          <div className="modes-settings-page-head">
            <h2 ref={pageHeading} tabIndex={-1}>{openLabel}</h2>
            <div className="modes-settings-editor-actions">
              <Button size="sm" variant="ghost" disabled={controlsDisabled || (isBundle && !open.saved)} onClick={() => setIdForm({ purpose: "duplicate", value: "" })}>
                {t("modes.settings.duplicate")}
              </Button>
              {removable && (
                <Button size="sm" variant="ghost" disabled={controlsDisabled} onClick={() => void remove()}>
                  {open.builtin
                    ? t(armed === open.id ? "modes.settings.restoreConfirm" : "modes.settings.restore")
                    : t(armed === open.id ? "modes.settings.deleteConfirm" : "modes.settings.delete")}
                </Button>
              )}
              <Button size="sm" variant="primary" disabled={controlsDisabled || !dirty || saveBlocked} onClick={() => void save()}>
                {busy ? t("modes.settings.saving") : t("modes.settings.save")}
              </Button>
            </div>
          </div>
          <div className="modes-settings-tabs" data-testid="modes-tabs" data-mode-id={open.id}>
            <SegmentedControl
              value={activeTab}
              onChange={(next) => { setTab(next); setRoleSelection(null); }}
              options={tabOptions}
              label={openLabel}
              disabled={loading}
              role="tablist"
            />
          </div>
          {tabOptions.map(({ value, id, controls }) => (
        <div
          key={value}
          id={controls}
          role="tabpanel"
          aria-labelledby={id}
          hidden={activeTab !== value}
          className={activeTab === value ? "settings-stack" : undefined}
        >
          {value === activeTab && (value === "mode" || value === "prompt") && (isBundle ? (
            bundleDraft && <ModeTab
              draft={bundleDraft}
              setDraft={setBundleDraft}
              section={value}
              disabled={controlsDisabled}
            />
          ) : (
            <SettingsCard title={t("modes.settings.tabMode")}>
              <div className="modes-settings-tab-field">
                <Textarea
                  className="modes-settings-source"
                  value={legacyDraft}
                  aria-label={t("modes.settings.source")}
                  disabled={controlsDisabled}
                  onChange={(event) => setLegacyDraft(event.target.value)}
                />
              </div>
              <ModeValidationPanel t={t} validation={validation} pending={pending} />
            </SettingsCard>
          ))}
          {value === activeTab && value === "subagents" && bundleDraft && (
            <SubagentsTab
              draft={bundleDraft}
              setDraft={setBundleDraft}
              selected={roleSelection}
              onSelect={setRoleSelection}
              disabled={controlsDisabled}
            />
          )}
          {value === activeTab && value === "skills" && (
            <SkillsTab
              state={skills}
              busy={controlsDisabled || !open.saved}
              onOpen={() => void openSkills()}
              onToggle={(id, enabled) => void saveSkill(id, enabled)}
            />
          )}
        </div>
          ))}
        </>
      )}
    </div>
  );
}

function ModeIdForm({
  t,
  form,
  problem,
  disabled,
  onChange,
  onSubmit,
  onCancel,
}: {
  t: (key: string) => string;
  form: IdForm;
  problem: NewModeIdProblem | null;
  disabled: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const empty = !form.value.trim();
  return (
    <form
      className="modes-settings-new"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <Field label={t("modes.settings.newModeId")}>
        <Input
          value={form.value}
          autoFocus
          disabled={disabled}
          maxLength={40}
          aria-invalid={problem ? true : undefined}
          onChange={(event) => onChange(event.target.value)}
        />
      </Field>
      <Button type="submit" size="sm" variant="primary" disabled={disabled || empty || !!problem}>
        {t(form.purpose === "new" ? "modes.settings.create" : "modes.settings.duplicate")}
      </Button>
      <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={onCancel}>
        {t("modes.settings.cancel")}
      </Button>
      {problem ? (
        <span className="modes-settings-validation-errors" role="alert">
          {t(ID_PROBLEM_KEYS[problem])}
        </span>
      ) : null}
    </form>
  );
}

function ModeValidationPanel({
  t,
  validation,
  pending,
}: {
  t: (key: string) => string;
  validation: ModeDocumentValidation | null;
  pending: boolean;
}) {
  return (
    <div className="modes-settings-validation" role="status" aria-live="polite" data-testid="modes-validation">
      {pending ? <span className="modes-settings-validation-ok">{t("modes.settings.validating")}</span> : null}
      {validation && validation.errors.length > 0 ? (
        <div className="modes-settings-validation-errors">
          <span>{t("modes.settings.errors")}</span>
          <ul>
            {validation.errors.map((error, index) => (
              <li key={`${index}:${error}`}>{error}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {validation && validation.warnings.length > 0 ? (
        <div className="modes-settings-validation-warnings">
          <span>{t("modes.settings.warnings")}</span>
          <ul>
            {validation.warnings.map((warning, index) => (
              <li key={`${index}:${warning}`}>{warning}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {validation && validation.errors.length === 0 && validation.warnings.length === 0 ? (
        <span className="modes-settings-validation-ok">{t("modes.settings.valid")}</span>
      ) : null}
    </div>
  );
}
