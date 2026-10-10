import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import type { FsEntry, FsReadResult, SessionSummary, WorkspaceDiff } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { sessionAllows } from "../../lib/remote-session-safety";
import { useAppStore } from "../../stores/app-store";
import { Button, SegmentedControl } from "../ui";
import "../../styles/remote-mvp.css";

export function RemoteWorkspace({ session, width, exiting, onExitAnimationEnd }: {
  session: SessionSummary; width: number; exiting?: boolean; onExitAnimationEnd?: () => void;
}) {
  const { t } = useTranslation("remote");
  const [tab, setTab] = useState<"files" | "review">("files");
  const [directory, setDirectory] = useState("");
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [file, setFile] = useState<{ path: string; read: FsReadResult } | null>(null);
  const [diff, setDiff] = useState<WorkspaceDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; generation.current++; }; }, []);
  const current = (request: number) => alive.current && generation.current === request
    && useAppStore.getState().activeSessionId === session.id;
  useEffect(() => {
    const request = ++generation.current;
    if (!sessionAllows(session, "canReadWorkspace")) return;
    setBusy(true); setError(null); setFile(null); setEntries([]); setDiff(null);
    const read = async () => {
      try {
        if (tab === "files") {
          const result = await api.remoteWorkspaceList(session.id, directory);
          if (current(request)) setEntries(result.entries);
        } else {
          const result = await api.remoteWorkspaceDiff(session.id);
          if (current(request)) setDiff(result);
        }
      } catch (caught) { if (current(request)) setError(caught instanceof Error ? caught.message : String(caught)); }
      finally { if (current(request)) setBusy(false); }
    };
    void read();
    return () => { generation.current++; };
  }, [session.id, session.capabilities?.canReadWorkspace, directory, tab, revision]);
  const open = async (entry: FsEntry) => {
    if (busy || !sessionAllows(session, "canReadWorkspace") || useAppStore.getState().activeSessionId !== session.id) return;
    if (!entry.name || /[/\\\0]/.test(entry.name) || entry.name === "." || entry.name === "..") return;
    const path = directory ? `${directory}/${entry.name}` : entry.name;
    if (entry.kind === "dir") { setDirectory(path); return; }
    const request = ++generation.current;
    setBusy(true); setError(null); setFile(null);
    try {
      const read = await api.remoteWorkspaceRead(session.id, path);
      if (current(request)) setFile({ path, read });
    } catch (caught) { if (current(request)) setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { if (current(request)) setBusy(false); }
  };
  return (
    <aside className={`work-panel remote-workspace${exiting ? " is-exiting" : ""}`}
      style={{ "--work-panel-width": `${width}px` } as CSSProperties}
      onAnimationEnd={(event) => { if (event.target === event.currentTarget && exiting) onExitAnimationEnd?.(); }}
      aria-label={t("workspace")}>
      <div className="remote-actions">
        <SegmentedControl value={tab} onChange={setTab} label={t("workspace")}
          options={[{ value: "files", label: t("files") }, { value: "review", label: t("review") }]} />
        <Button variant="ghost" disabled={busy} onClick={() => setRevision((value) => value + 1)}>{t("refresh")}</Button>
        <Button variant="ghost" onClick={() => useAppStore.getState().collapseWorkPanel()}>{t("close")}</Button>
      </div>
      <p className="remote-hint">{t("identity", { host: session.remoteHostLabel ?? session.remoteHostKey, workspace: session.remoteWorkspaceLabel ?? t("workspace") })}</p>
      <div className="remote-workspace-content" aria-busy={busy}>
        {!sessionAllows(session, "canReadWorkspace") && <p>{t("readOnly")}</p>}
        {busy && <p role="status">{t("loading")}</p>}
        {error && <p role="alert">{error}</p>}
        {tab === "files" && <>
          <div className="remote-actions">
            <code>{directory || "/"}</code>
            <Button variant="ghost" disabled={busy || !directory} onClick={() => setDirectory(directory.split("/").slice(0, -1).join("/"))}>{t("parent")}</Button>
          </div>
          {!busy && !error && entries.length === 0 && <p>{t("emptyFiles")}</p>}
          <div className="settings-stack">{entries.map((entry) => <Button variant="ghost" key={entry.name} disabled={busy}
            onClick={() => void open(entry)}>{entry.name}{entry.kind === "dir" ? "/" : ""}</Button>)}</div>
          {file && <section><h3>{file.path}</h3>{file.read.kind === "text"
            ? <pre>{file.read.content}</pre>
            : <p>{t(file.read.kind === "tooLarge" ? "truncated" : "binary")}</p>}</section>}
        </>}
        {tab === "review" && diff && <>
          {diff.files.length === 0 && <p>{t("noChanges")}</p>}
          {diff.truncated && <p>{t("truncated")}</p>}
          {diff.files.map((item) => <section key={item.path}>
            <h3>{item.path} (+{item.additions} / -{item.deletions})</h3>
            {item.binary && <p>{t("binary")}</p>}{item.tooLarge && <p>{t("truncated")}</p>}
            <pre>{item.hunks.map((hunk) => `${hunk.header}\n${hunk.lines.map((line) => `${line.type === "add" ? "+" : line.type === "del" ? "-" : " "}${line.text}`).join("\n")}`).join("\n")}</pre>
          </section>)}
        </>}
      </div>
    </aside>
  );
}
