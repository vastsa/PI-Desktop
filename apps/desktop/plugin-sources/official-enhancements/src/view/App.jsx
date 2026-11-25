import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { watchAppearance } from "./appearance.js";
import { panelCopy, panelError, panelLocale } from "./copy.js";
import { MemoryPanel } from "./MemoryPanel.jsx";

const bridge = window.pluginBridge;
const EXPECTED_API = 4;
const INPUT = "w-full rounded-lg border border-line bg-surface-sunken px-2.5 py-1.5 text-xs text-ink outline-none transition focus:border-ink-faint disabled:opacity-50";
const SECONDARY = "rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-ink-muted transition hover:bg-surface-sunken disabled:opacity-40";
const PROMPT_KEYS = ["predictionPrompt", "enhancementPrompt", "titlePrompt"];
const promptDraft = (settings) => Object.fromEntries(PROMPT_KEYS.map((key) => [key, settings[key] ?? ""]));

async function invoke(channel, payload = {}) {
  try {
    const result = await bridge.invoke(channel, payload);
    return result?.ok === false ? { error: result } : { data: result };
  } catch (error) {
    return { error: error ?? {} };
  }
}

function Capability({ copy, title, description, enabled, busy, onToggle, children }) {
  const label = enabled ? copy.on : copy.off;
  return <section className="rounded-xl border border-line bg-surface p-4">
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
        <p className="mt-0.5 text-xs text-ink-muted">{description}</p>
      </div>
      <button type="button" role="switch" aria-checked={enabled} aria-label={copy.switchLabel(title, label)}
        disabled={busy} onClick={onToggle}
        className={`shrink-0 rounded-full px-3 py-1 text-xs font-medium transition disabled:opacity-50 ${enabled ? "bg-accent text-accent-ink" : "border border-line bg-transparent text-ink-muted hover:bg-surface-sunken"}`}>
        {label}
      </button>
    </div>
    {enabled && <div className="mt-3 space-y-3">{children}</div>}
  </section>;
}

function Field({ label, hint, children }) {
  return <label className="block">
    <span className="mb-1 block text-xs font-medium text-ink-muted">{label}</span>
    {children}
    {hint && <span className="mt-1 block text-[11px] text-ink-faint">{hint}</span>}
  </label>;
}

function PromptEditor({ copy, value, onChange, maxChars, hint, disabled }) {
  return <Field label={<span className="flex justify-between gap-2">
    {copy.instruction}<span className="text-[10px] text-ink-faint">{value.length} / {maxChars}</span>
  </span>} hint={hint}>
    <textarea className={`${INPUT} h-24 resize-y font-mono text-[11px] leading-relaxed`}
      value={value} spellCheck={false} disabled={disabled} maxLength={maxChars}
      onChange={(event) => onChange(event.target.value)} />
  </Field>;
}

function Status({ status, copy }) {
  if (!status) return null;
  const tone = status.error ? "text-danger" : status.muted ? "text-ink-muted" : "text-ok";
  const text = status.error ? panelError(copy, status.error) : typeof copy[status.key] === "function"
    ? copy[status.key](status.value) : copy[status.key];
  return <p className={`text-[11px] ${tone}`} aria-live="polite">{text}</p>;
}

function ModelPicker({ copy, models, allLevels, value, thinkingLevel, onChange, disabled, inheritLabel, hint }) {
  const selected = models.find((model) => model.key === value);
  const levels = selected ? selected.thinkingLevels ?? [] : allLevels;
  return <div className="space-y-3">
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label={copy.model} hint={!models.length && copy.noModels}>
        <select className={INPUT} value={value} disabled={disabled || !models.length}
          onChange={(event) => onChange({ modelKey: event.target.value, thinkingLevel: "" })}>
          <option value="">{inheritLabel}</option>
          {models.map((model) => <option key={model.key} value={model.key}>
            {model.providerName ? `${model.label} (${model.providerName})` : model.label}
          </option>)}
        </select>
      </Field>
      <Field label={copy.thinking} hint={selected && !selected.supportsReasoning && copy.noReasoning}>
        <select className={INPUT} value={thinkingLevel} disabled={disabled || !levels.length}
          onChange={(event) => onChange({ modelKey: value, thinkingLevel: event.target.value })}>
          <option value="">{copy.modelDefault}</option>
          {levels.map((level) => <option key={level} value={level}>{copy.levels[level] ?? level}</option>)}
        </select>
      </Field>
    </div>
    {hint && <p className="text-[11px] text-ink-faint">{hint}</p>}
  </div>;
}

function TitleLength({ copy, limits, value, disabled, onSave }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  return <Field label={copy.titleLength} hint={copy.titleLengthHint(limits.min, limits.max)}>
    <input type="number" className={INPUT} min={limits.min} max={limits.max} value={draft} disabled={disabled}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
      onBlur={async () => {
        const next = draft.trim() === "" ? value : Number(draft);
        const normalized = Number.isFinite(next) ? Math.min(limits.max, Math.max(limits.min, Math.round(next))) : value;
        setDraft(String(normalized));
        if (normalized !== value && !await onSave(normalized)) setDraft(String(value));
      }} />
  </Field>;
}

function App() {
  const [locale, setLocale] = useState("en");
  const copy = panelCopy(locale);
  useEffect(() => watchAppearance(bridge, (appearance) => {
    const next = panelLocale(appearance?.locale);
    document.documentElement.lang = next;
    document.title = panelCopy(next).title;
    setLocale(next);
  }), []);

  const [state, setState] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [pending, setPending] = useState("");
  const writing = useRef(false);
  const [status, setStatus] = useState(null);
  const [prompts, setPrompts] = useState(null);
  const [promptStatus, setPromptStatus] = useState(null);
  const [testResult, setTestResult] = useState(null);
  const [testing, setTesting] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await invoke("enhancements.panelState");
    setLoadError(error ?? null);
    if (data) {
      setState(data);
      setPrompts((current) => current ?? promptDraft(data.settings ?? {}));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const settings = state?.settings;
  const stale = (state?.apiVersion ?? 0) < EXPECTED_API;
  const busy = !!pending || stale;
  const dirtyKeys = prompts && settings ? PROMPT_KEYS.filter((key) => prompts[key] !== (settings[key] ?? "")) : [];

  async function save(partial, isPrompt = false) {
    if (!settings || stale || writing.current) return false;
    writing.current = true;
    setPending(isPrompt ? "prompts" : "settings");
    const report = isPrompt ? setPromptStatus : setStatus;
    report(null);
    try {
      const { data, error } = await invoke("enhancements.saveSettings", partial);
      if (error) {
        report({ error });
        return false;
      }
      const saved = data?.settings;
      const keys = Object.keys(partial);
      const dropped = keys.filter((key) => !saved || !Object.hasOwn(saved, key));
      if (dropped.length) {
        report({ key: "dropped", value: dropped });
        await load();
        return false;
      }
      setState((current) => ({ ...current, settings: saved }));
      if (isPrompt) {
        setPrompts(promptDraft(saved));
        report({ key: "promptSaved", value: keys.length });
      } else report({ key: "saved" });
      return true;
    } finally {
      writing.current = false;
      setPending("");
    }
  }

  async function testModel() {
    setTesting(true);
    setTestResult(null);
    const { data, error } = await invoke("enhancements.testModel");
    setTesting(false);
    setTestResult(error ? { error } : { key: "reached", value: data });
  }

  if (loadError) return <div className="flex flex-col gap-3 p-4">
    <p className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">{copy.loadError(panelError(copy, loadError))}</p>
    <button type="button" className={`self-start ${SECONDARY}`} onClick={() => void load()}>{copy.retry}</button>
  </div>;
  if (!settings || !prompts) return <div className="p-4 text-xs text-ink-muted">{copy.loading}</div>;

  const models = state.models ?? [];
  const sessionLabel = models.find((model) => model.key === state.sessionModelKey)?.label || state.sessionModelKey || copy.appModel;
  function picker(prefix, inheritLabel, hint) {
    return <ModelPicker copy={copy} models={models} allLevels={state.thinkingLevels ?? []}
      value={settings[`${prefix}ModelKey`]} thinkingLevel={settings[`${prefix}ThinkingLevel`]}
      disabled={busy} inheritLabel={inheritLabel} hint={hint}
      onChange={({ modelKey, thinkingLevel }) => void save({ [`${prefix}ModelKey`]: modelKey, [`${prefix}ThinkingLevel`]: thinkingLevel })} />;
  }
  function editor(key, hint) {
    return <PromptEditor copy={copy} value={prompts[key]} maxChars={state.promptMaxChars ?? 8000} hint={hint} disabled={busy}
      onChange={(value) => setPrompts((current) => ({ ...current, [key]: value }))} />;
  }
  const toggle = (key) => () => {
    if (key === "promptEnhancementEnabled") setTestResult(null);
    void save({ [key]: !settings[key] });
  };
  const warningClass = "rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[11px] text-danger";

  return <div className="flex flex-col gap-3">
    {stale && <div role="alert" className={warningClass}>
      <p className="font-semibold">{copy.staleTitle}</p><p className="mt-1">{copy.staleHint}</p>
    </div>}
    <Status copy={copy} status={status} />
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-base font-semibold text-ink">{copy.title}</h1>
        <p className="mt-0.5 text-xs text-ink-muted">{copy.intro}</p>
        <Status copy={copy} status={promptStatus} />
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        {dirtyKeys.length > 0 && <span className="text-[10px] text-ink-faint">{copy.unsaved}</span>}
        <button type="button" className={SECONDARY} disabled={!state.promptDefaults || busy} title={copy.defaultsHint}
          onClick={() => { setPrompts(promptDraft(state.promptDefaults)); setPromptStatus({ key: "defaultsLoaded", muted: true }); }}>
          {copy.defaults}
        </button>
        <button type="button" className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-accent-ink transition hover:opacity-85 disabled:opacity-40"
          disabled={!dirtyKeys.length || busy} title={copy.saveHint}
          onClick={() => void save(Object.fromEntries(dirtyKeys.map((key) => [key, prompts[key]])), true)}>
          {pending === "prompts" ? copy.saving : copy.save}
        </button>
      </div>
    </header>

    <MemoryPanel bridge={bridge} disabled={stale} locale={locale} />
    <Capability copy={copy} title={copy.suggestion} description={copy.suggestionDescription}
      enabled={settings.predictionsEnabled} busy={busy} onToggle={toggle("predictionsEnabled")}>
      {picker("prediction", copy.sessionModel(sessionLabel), copy.suggestionHint(state.suggestionsPerMinute ?? 3))}
      {state.suggestionSupported === false && <p className={warningClass}>{copy.suggestionUnsupported}</p>}
      {state.suggestionFailure && <p className={warningClass}>{copy.suggestionFailure(state.suggestionFailure)}</p>}
      {editor("predictionPrompt", copy.suggestionPromptHint)}
    </Capability>
    <Capability copy={copy} title={copy.enhancement} description={copy.enhancementDescription}
      enabled={settings.promptEnhancementEnabled} busy={busy} onToggle={toggle("promptEnhancementEnabled")}>
      {picker("enhancement", copy.appModel)}
      <button type="button" className={SECONDARY} disabled={testing || busy} onClick={() => void testModel()}>
        {testing ? copy.testing : copy.test}
      </button>
      {editor("enhancementPrompt", copy.enhancementPromptHint)}
      <Status copy={copy} status={testResult} />
    </Capability>
    <Capability copy={copy} title={copy.titles} description={copy.titlesDescription}
      enabled={settings.titlesEnabled} busy={busy} onToggle={toggle("titlesEnabled")}>
      {picker("title", copy.sessionModel(sessionLabel), copy.titlesHint(state.titlesPerMinute ?? 3))}
      <TitleLength copy={copy} limits={state.titleMaxCharsLimit ?? { min: 16, max: 80 }} value={settings.titleMaxChars}
        disabled={busy} onSave={(value) => save({ titleMaxChars: value })} />
      {editor("titlePrompt", copy.titlePromptHint)}
    </Capability>
    <p className="pb-1 text-[11px] leading-relaxed text-ink-faint">{copy.privacy}</p>
  </div>;
}

createRoot(document.getElementById("root")).render(<App />);
