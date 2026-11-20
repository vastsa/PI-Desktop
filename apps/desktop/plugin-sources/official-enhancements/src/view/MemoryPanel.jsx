import React from "react";
import { memoryCopy, memoryError } from "./memory-copy.js";

const { useCallback, useEffect, useRef, useState } = React;
const SCOPES = ["user", "project"];
const EMPTY_DRAFT = { id: null, title: "", content: "", revision: null };

function contextKey(context) {
  return JSON.stringify([context?.sessionId ?? null, context?.projectKey ?? null]);
}

function Toggle({ label, hint, checked, disabled, onChange }) {
  return (
    <label className="memory-toggle">
      <span><span className="memory-label">{label}</span>{hint && <span className="memory-hint">{hint}</span>}</span>
      <input type="checkbox" role="switch" aria-label={label} checked={checked} disabled={disabled} onChange={onChange} />
    </label>
  );
}

/**
 * A settings surface for memory. The list and the editor sit side by side so a
 * long list never pushes the editor out of view, which the previous single
 * column did as soon as more than a few entries existed.
 */
export function MemoryPanel({ bridge, disabled = false, locale: panelLocale }) {
  const [snapshot, setSnapshot] = useState(null);
  const [standaloneLocale, setLocale] = useState("en");
  const locale = panelLocale ?? standaloneLocale;
  const [scope, setScope] = useState("user");
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [query, setQuery] = useState("");
  const [deleting, setDeleting] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState(null);
  const live = useRef(false);
  const sequence = useRef(0);
  const latest = useRef(null);
  const writing = useRef(false);
  const refreshPending = useRef(false);
  const editor = useRef(null);
  const copy = memoryCopy(locale);

  const accept = useCallback((next) => {
    const changed = latest.current && contextKey(latest.current.context) !== contextKey(next.context);
    latest.current = next;
    setSnapshot(next);
    if (changed) {
      setScope("user");
      setDraft(EMPTY_DRAFT);
      setDeleting(null);
      setQuery("");
      setNotice({ kind: "status", key: "contextChanged" });
    }
    return changed;
  }, []);

  const load = useCallback(async () => {
    if (disabled || !live.current) return;
    if (writing.current) { refreshPending.current = true; return; }
    const request = ++sequence.current;
    setLoading(true);
    try {
      const next = await bridge.invoke("memory.state", {});
      if (!live.current || request !== sequence.current) return;
      if (!next || next.ok === false) throw next ?? {};
      setNotice(null);
      accept(next);
    } catch (error) {
      if (live.current && request === sequence.current) {
        setNotice({ kind: "alert", error });
      }
    } finally {
      if (live.current && request === sequence.current) setLoading(false);
    }
  }, [bridge, disabled, accept]);

  useEffect(() => {
    live.current = true;
    const onFocus = () => void load();
    let localeEventSeen = false;
    const onAppearance = (appearance) => {
      localeEventSeen = true;
      if (live.current) setLocale(appearance?.locale || "en");
    };
    const unsubscribe = panelLocale == null ? bridge?.on?.("appearance:changed", onAppearance) : null;
    if (panelLocale == null) {
      bridge.invoke("app.getAppearance", {}).then((appearance) => {
        if (!localeEventSeen && live.current) setLocale(appearance?.locale || "en");
      }).catch(() => { /* Keep the English fallback when appearance is unavailable. */ });
    }
    window.addEventListener("focus", onFocus);
    void load();
    return () => {
      live.current = false;
      sequence.current += 1;
      window.removeEventListener("focus", onFocus);
      if (typeof unsubscribe === "function") unsubscribe();
      else if (panelLocale == null) bridge?.off?.("appearance:changed", onAppearance);
    };
  }, [bridge, load, panelLocale == null]);

  const mutate = useCallback(async (channel, payload, success, clearDraft = false) => {
    if (disabled || writing.current || !live.current) return;
    writing.current = true;
    const request = ++sequence.current;
    setSaving(true);
    setNotice(null);
    try {
      const next = await bridge.invoke(channel, payload);
      if (!live.current || request !== sequence.current) return;
      if (!next || next.ok === false) throw next ?? {};
      const changed = accept(next);
      if (clearDraft) { setDraft(EMPTY_DRAFT); setDeleting(null); }
      if (!changed) setNotice({ kind: "status", key: success });
    } catch (error) {
      if (live.current && request === sequence.current) {
        setNotice({ kind: "alert", error });
      }
    } finally {
      writing.current = false;
      if (live.current && request === sequence.current) {
        setSaving(false);
        if (refreshPending.current) { refreshPending.current = false; void load(); }
      }
    }
  }, [bridge, disabled, accept, load]);

  const busy = disabled || loading || saving;
  const settings = snapshot?.settings;
  const available = { user: true, project: Boolean(snapshot?.context?.projectKey) };
  const maxChars = snapshot?.limits?.[scope]?.contentChars ?? 2000;
  const valid = draft.content.trim().length > 0 && draft.content.length <= maxChars;
  const scoped = (snapshot?.entries ?? []).filter((entry) => entry.scope === scope);
  const filtered = scoped.filter((entry) => entry.content.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const proposals = snapshot?.proposals ?? [];
  const setOption = (key) => void mutate("memory.settings", { partial: { [key]: !settings[key] } }, "settingsSaved");
  const saveDraft = (event) => {
    event.preventDefault();
    if (!valid || !available[scope]) return;
    void mutate("memory.save", {
      context: snapshot.context, scope, title: draft.title, content: draft.content,
      ...(draft.id ? { id: draft.id, expectedRevision: draft.revision } : {}),
    }, "saved", true);
  };
  const startEdit = (entry) => {
    setDraft({ id: entry.id, title: entry.title ?? "", content: entry.content, revision: entry.revision });
    setDeleting(null);
    editor.current?.focus();
  };

  return (
    <section className="memory-panel" aria-labelledby="memory-heading" lang={locale}>
      <div className="memory-heading">
        <div><h2 id="memory-heading">{copy.title}</h2><p className="memory-hint">{copy.description}</p></div>
        <button type="button" disabled={busy} onClick={() => void load()}>{copy.refresh}</button>
      </div>
      {disabled ? <p role="status">{copy.unavailable}</p> : null}
      {loading && <p role="status">{copy.loading}</p>}
      {notice && <p className={`memory-notice memory-${notice.kind}`} role={notice.kind}>
        {notice.kind === "alert" ? memoryError(locale, notice.error) : copy[notice.key]}
      </p>}
      {settings && <>
        {snapshot.toolAvailable === false && <p className="memory-notice" role="status">{copy.toolsUnavailable}</p>}
        <Toggle label={copy.enabled} checked={settings.enabled} disabled={busy} onChange={() => setOption("enabled")} />
        {!settings.enabled && <p className="memory-hint">{copy.disabledHint}</p>}
        <fieldset disabled={busy} className="memory-options">
          <legend>{copy.scopeHeading}</legend>
          {SCOPES.map((level) => <Toggle key={level} label={copy[level]} hint={copy[`${level}Hint`]} checked={settings[`${level}Enabled`]} onChange={() => setOption(`${level}Enabled`)} />)}
        </fieldset>
        <div className="memory-ai-options">
          <Toggle label={copy.aiReadEnabled} hint={copy.aiReadHint} checked={settings.aiReadEnabled} disabled={busy || snapshot.toolAvailable === false} onChange={() => setOption("aiReadEnabled")} />
          <Toggle label={copy.aiWriteEnabled} hint={copy.aiWriteHint} checked={settings.aiWriteEnabled} disabled={busy || snapshot.toolAvailable === false} onChange={() => setOption("aiWriteEnabled")} />
        </div>
        <p className="memory-hint">{copy.privacy}</p>

        <section className="memory-proposals" aria-labelledby="memory-proposals-heading">
          <div className="memory-heading">
            <h3 id="memory-proposals-heading">{copy.proposals}</h3>
            <span className="memory-hint">{proposals.length}</span>
          </div>
          <p className="memory-hint">{copy.proposalHint}</p>
          {proposals.length === 0
            ? <p className="memory-hint">{copy.proposalNone}</p>
            : <ul className="memory-list">
              {proposals.map((proposal) => <li key={proposal.id} className="memory-entry memory-proposal">
                {proposal.title && <p className="memory-title">{proposal.title}</p>}
                <p className="memory-content">{proposal.content}</p>
                <div className="memory-actions">
                  <button className="memory-primary" type="button" disabled={busy}
                    onClick={() => void mutate("memory.acceptProposal", { id: proposal.id }, "proposalAccepted")}>{copy.proposalAccept}</button>
                  <button type="button" disabled={busy}
                    onClick={() => void mutate("memory.rejectProposal", { id: proposal.id }, "proposalRejected")}>{copy.proposalReject}</button>
                </div>
              </li>)}
            </ul>}
        </section>

        <div className="memory-heading"><h3>{copy.manage}</h3><span className="memory-hint">{copy.count(scoped.length)}</span></div>
        <label className="memory-field"><span>{copy.scope}</span>
          <select value={scope} disabled={busy} onChange={(event) => { setScope(event.target.value); setDraft(EMPTY_DRAFT); setDeleting(null); setQuery(""); }}>
            {SCOPES.map((level) => <option key={level} value={level} disabled={!available[level]}>{copy[level]}{available[level] ? "" : ` · ${copy.noProject}`}</option>)}
          </select>
        </label>
        {scope === "project" && <p className="memory-context">{copy.currentProject}: {snapshot.context.projectLabel || snapshot.context.projectKey}</p>}

        {/* Two panes: the entry list and the editor keep their own scroll, so a
            long list cannot push the form out of reach. */}
        <div className="memory-split">
          <div className="memory-pane memory-pane-list">
            <label className="memory-field"><span>{copy.search}</span><input type="search" value={query} disabled={busy} onChange={(event) => setQuery(event.target.value)} /></label>
            {filtered.length === 0 && <p className="memory-hint">{scoped.length ? copy.noResults : copy.empty}</p>}
            <ul className="memory-list">
              {filtered.map((entry) => <li key={entry.id} className={`memory-entry${draft.id === entry.id ? " memory-entry-active" : ""}`}>
                <button type="button" className="memory-entry-open" disabled={busy} onClick={() => startEdit(entry)}>
                  {entry.title && <span className="memory-title">{entry.title}</span>}
                  <span className="memory-content">{entry.content}</span>
                </button>
                <div className="memory-actions">
                  <span className="memory-hint">{entry.source === "ai" ? copy.ai : copy.manual} · {copy.revision(entry.revision)}</span>
                  <button type="button" disabled={busy} onClick={() => startEdit(entry)}>{copy.edit}</button>
                  <button type="button" disabled={busy} onClick={() => setDeleting(entry.id)}>{copy.remove}</button>
                </div>
                {deleting === entry.id && <div className="memory-delete" role="group" aria-label={copy.confirmDelete}>
                  <p>{copy.confirmDelete}</p>
                  <div className="memory-actions">
                    <button className="memory-danger" type="button" disabled={busy} onClick={() => void mutate("memory.delete", { context: snapshot.context, scope, id: entry.id, expectedRevision: entry.revision }, "deleted", true)}>{copy.confirm}</button>
                    <button type="button" disabled={busy} onClick={() => setDeleting(null)}>{copy.cancel}</button>
                  </div>
                </div>}
              </li>)}
            </ul>
          </div>
          <form className="memory-pane memory-pane-editor" onSubmit={saveDraft}>
            <label className="memory-field"><span>{copy.titleLabel}</span>
              <input type="text" value={draft.title} maxLength={200} disabled={busy || !available[scope]}
                onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))} />
            </label>
            <p className="memory-hint">{copy.titleHint}</p>
            <label className="memory-field"><span>{copy.content}</span>
              <textarea ref={editor} rows={6} value={draft.content} maxLength={maxChars} disabled={busy || !available[scope]} aria-describedby="memory-limit"
                onChange={(event) => setDraft((current) => ({ ...current, content: event.target.value }))} />
            </label>
            <div className="memory-actions">
              <span id="memory-limit" className="memory-hint">{draft.content.length} / {maxChars}</span>
              <button className="memory-primary" type="submit" disabled={busy || !valid || !available[scope]}>{saving ? copy.saving : draft.id ? copy.update : copy.add}</button>
              {draft.id && <button type="button" disabled={busy} onClick={() => setDraft(EMPTY_DRAFT)}>{copy.cancel}</button>}
            </div>
          </form>
        </div>
      </>}
    </section>
  );
}
