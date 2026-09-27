import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { FsVideoSource } from "@pi-desktop/shared";
import { api } from "../lib/api";
import { localVideoRef } from "../lib/markdown-video";
import { useAppStore } from "../stores/app-store";
import { Button } from "./ui";

/** Local previews use a leased, range-capable stream rather than file:// URLs. */
export function MarkdownVideo({ source, label, baseDir }: { source: string; label?: ReactNode; baseDir?: string }) {
  const { t } = useTranslation();
  const root = useAppStore((s) => s.workspace?.path);
  const sessionId = useAppStore((s) => s.activeSessionId);
  const showToast = useAppStore((s) => s.showToast);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ key: string; video?: FsVideoSource; error?: boolean } | null>(null);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const remote = /^https:\/\//i.test(source);
  const ref = remote ? null : localVideoRef(source, root, baseDir);
  const key = JSON.stringify([source, root, sessionId, baseDir, attempt]);
  useEffect(() => {
    if (remote) return;
    let current = true;
    let url: string | null = null;
    const release = (value: string) => { void api.fsVideoRelease(value).catch(() => {}); };
    void (async () => {
      try {
        if (!ref) throw new Error("Invalid video reference");
        const match = (await api.fsResolveRef(ref, sessionId)).match;
        if (!match) throw new Error("Video not found");
        if (!current) return;
        const video = await api.fsVideoSource(match.absolutePath);
        if (!current) { release(video.url); return; }
        url = video.url;
        setResult({ key, video });
      } catch {
        if (current) setResult({ key, error: true });
      }
    })();
    return () => { current = false; if (url) release(url); };
  }, [key, ref, remote, sessionId]);
  const video = result?.key === key ? result.video : undefined;
  const error = (result?.key === key && result.error) || playbackError === key;
  const src = remote ? source : video?.url;
  const save = async () => {
    if (!video || saving) return;
    setSaving(true);
    try {
      const saved = await api.fsVideoSave(video.url);
      if (!saved.canceled) showToast(t("chat.video.saved"), { variant: "success" });
    } catch { showToast(t("chat.video.saveFailed"), { variant: "error" }); }
    finally { setSaving(false); }
  };
  return (
    <span className="chat-video">
      {src && <video key={`${key}:${src}`} controls playsInline preload="metadata" src={src} aria-label={t("chat.video.player")} onError={() => setPlaybackError(key)} />}
      {!src && !error && <span role="status">{t("common.loading")}</span>}
      {error && <span role="alert">{t("chat.video.previewFailed")}</span>}
      <span className="chat-video-actions">
        <span className="chat-video-name">{label || video?.name}</span>
        {video && <Button size="sm" variant="ghost" disabled={saving} onClick={() => void save()}>{t("chat.video.save")}</Button>}
        {error && <Button size="sm" variant="ghost" onClick={() => { setPlaybackError(null); setAttempt((value) => value + 1); }}>{t("chat.video.retry")}</Button>}
      </span>
    </span>
  );
}
