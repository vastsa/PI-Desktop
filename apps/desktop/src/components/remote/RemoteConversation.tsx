import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SessionSummary } from "@pi-desktop/shared";
import { useTranscriptView } from "../../hooks/use-transcript-view";
import { api } from "../../lib/api";
import { headPermission } from "../../lib/pending-permissions";
import { sessionAllows } from "../../lib/remote-session-safety";
import { useAppStore } from "../../stores/app-store";
import { Button, Textarea } from "../ui";
import { AskToolCard } from "../AskToolCard";
import { headAsk } from "../../lib/pending-asks";
import { captureComposerDraft, deleteComposerDraft, readComposerDraft, markComposerDraftEdited, readComposerDraftRevision } from "../../lib/composer-draft-cache";
import "../../styles/remote-mvp.css";

/** Text-only remote transcript deliberately has no local file/URL/plugin actions. */
export function RemoteConversation({ session }: { session: SessionSummary }) {
  const { t } = useTranslation("remote");
  const transcript = useTranscriptView(session.id);
  const messages = transcript.messages;
  const running = useAppStore((state) => state.runningSessions[session.id] ?? false);
  const permission = useAppStore((state) => headPermission(state.pendingPermissions, session.id));
  const ask = useAppStore((state) => headAsk(state.pendingAsks, session.id));
  const [text, setText] = useState(() => readComposerDraft(session.id)?.text ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const live = useRef(true);
  const locked = useRef(false);
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useEffect(() => { if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }, [messages, permission]);
  const current = () => live.current && useAppStore.getState().activeSessionId === session.id;
  const run = async (action: () => Promise<void>) => {
    if (locked.current || !current()) return;
    locked.current = true;
    setBusy(true); setError(null);
    try { await action(); }
    catch (caught) { if (current()) setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { locked.current = false; if (current()) setBusy(false); }
  };
  const refresh = async () => {
    if (!sessionAllows(session, "canRefresh")) return;
    await useAppStore.getState().selectSession(session.id, { record: false });
  };
  return (
    <section className="chat-surface route-surface remote-conversation" aria-label={t("remote")}>
      <div className="remote-actions">
        <strong>{t("identity", { host: session.remoteHostLabel ?? session.remoteHostKey ?? t("remote"), workspace: session.remoteWorkspaceLabel ?? t("workspace") })}</strong>
        <Button variant="ghost" disabled={busy || !sessionAllows(session, "canRefresh")} onClick={() => void run(refresh)}>{t("refresh")}</Button>
        {session.remoteHostKey && <Button variant="ghost" disabled={busy} onClick={() => void run(async () => {
          await api.reconnectRemoteHost(session.remoteHostKey!);
          if (current()) await refresh();
        })}>{t("reconnect")}</Button>}
        <Button variant="ghost" onClick={() => {
          const store = useAppStore.getState(); store.setSettingsTab("remoteHosts"); store.setPage("settings");
        }}>{t("hostSettings")}</Button>
        <Button variant="ghost" disabled={!sessionAllows(session, "canReadWorkspace")} onClick={() => {
          if (current() && sessionAllows(session, "canReadWorkspace")) useAppStore.getState().openWorkPanel();
        }}>{t("files")} / {t("review")}</Button>
      </div>
      <p className="remote-hint">{t("readOnly")}</p>
      <div ref={scroll} className="remote-transcript" onScroll={() => {
        const node = scroll.current;
        if (node) follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
      }}>
        {transcript.hasMoreBefore && <Button variant="ghost" disabled={busy || transcript.loading} onClick={() => void run(async () => {
          await useAppStore.getState().loadTranscriptPage(session.id, "before");
        })}>{t("older")}</Button>}
        {messages.filter((message) => !message.modelSystem).map((message) => (
          <article key={message.id} className={`remote-message remote-message-${message.role}`}>
            <strong>{t(message.role)}{message.toolName ? ` · ${message.toolName}` : ""}</strong>
            <pre>{message.content || message.error?.message || (message.toolResult === undefined ? "" : JSON.stringify(message.toolResult, null, 2))}</pre>
            {message.thinking && <details><summary>{t("thinking")}</summary><pre>{message.thinking}</pre></details>}
          </article>
        ))}
        {transcript.hasMoreAfter && <Button variant="ghost" disabled={busy || transcript.loading} onClick={() => void run(async () => {
          await useAppStore.getState().loadTranscriptPage(session.id, "after");
        })}>{t("newer")}</Button>}
        {transcript.historical && <Button variant="ghost" disabled={busy} onClick={() => void run(async () => {
          await useAppStore.getState().returnToLatestTranscript(session.id);
        })}>{t("latest")}</Button>}
        {permission && <section className="permission-card" aria-label={t("approval")}>
          <strong>{t("approval")} · {permission.toolName}</strong>
          <p>{permission.reason}</p>
          <pre>{typeof permission.argsPreview === "string" ? permission.argsPreview : JSON.stringify(permission.argsPreview, null, 2)}</pre>
          <div className="remote-actions">
            {(["deny", "allow-once"] as const).map((decision) => <Button key={decision} disabled={busy} onClick={() => void run(async () => {
              await useAppStore.getState().resolvePermission(session.id, permission.requestId, decision);
            })}>{t(decision === "deny" ? "deny" : "allow")}</Button>)}
          </div>
        </section>}
        {ask && <AskToolCard key={ask.requestId} request={ask} />}
      </div>
      {error && <p className="remote-hint" role="alert">{error}</p>}
      {busy && <p className="remote-hint" role="status">{t("loading")}</p>}
      {running && <p className="remote-hint" role="status">{t("pending")}</p>}
      <form className="remote-composer" onSubmit={(event) => {
        event.preventDefault();
        if (!text.trim() || running || !sessionAllows(session, "canPrompt")) return;
        void run(async () => {
          const draftRevision = readComposerDraftRevision(session.id);
          const accepted = await useAppStore.getState().sendPrompt(text, undefined, session.id);
          if (accepted && readComposerDraftRevision(session.id) === draftRevision) deleteComposerDraft(session.id);
          if (!current()) return;
          if (accepted) setText(""); else setError(t("sendFailed"));
        });
      }}>
        <Textarea className="composer-input" aria-label={t("prompt")} placeholder={t("prompt")} rows={3}
          value={text} disabled={busy || !sessionAllows(session, "canPrompt")} onChange={(event) => {
            setText(event.target.value);
            markComposerDraftEdited(session.id);
            captureComposerDraft(session.id, event.target.value, []);
          }} />
        <div className="remote-actions">
          <Button type="submit" disabled={busy || running || !text.trim() || !sessionAllows(session, "canPrompt")}>{t("send")}</Button>
          <Button variant="secondary" disabled={busy || !running || !sessionAllows(session, "canStop")} onClick={() => void run(async () => {
            if (current() && sessionAllows(session, "canStop")) await useAppStore.getState().abort();
          })}>{t("stop")}</Button>
        </div>
      </form>
    </section>
  );
}
