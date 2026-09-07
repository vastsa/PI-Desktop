import { useEffect, useState } from "react";
import { api } from "./api";
import { useAppStore } from "../stores/app-store";

/**
 * Module-level cache so revisiting the same message does not re-read the
 * file. The key includes the workspace root so a relative path in one
 * project cannot show another project's file.
 */
const dataUrlCache = new Map<string, string>();
const DATA_URL_CACHE_ENTRIES = 50;
const DATA_URL_CACHE_MAX_BYTES = 40 * 1024 * 1024;
let dataUrlCacheBytes = 0;

function cacheKey(workspaceRoot: string | null, ref: string): string {
  return `${workspaceRoot ?? ""}\u0000${ref}`;
}

function rememberDataUrl(key: string, dataUrl: string) {
  const existing = dataUrlCache.get(key);
  if (existing !== undefined) {
    dataUrlCacheBytes -= existing.length;
    dataUrlCache.delete(key);
  }
  dataUrlCacheBytes += dataUrl.length;
  dataUrlCache.set(key, dataUrl);
  while (
    dataUrlCache.size > DATA_URL_CACHE_ENTRIES ||
    dataUrlCacheBytes > DATA_URL_CACHE_MAX_BYTES
  ) {
    const oldest = dataUrlCache.keys().next().value;
    if (oldest === undefined) break;
    const value = dataUrlCache.get(oldest);
    if (value !== undefined) dataUrlCacheBytes -= value.length;
    dataUrlCache.delete(oldest);
  }
}

/**
 * Load a contained image ref into a bounded data URL. Host containment
 * (workspace, scratch, attachments) is the gate; failures resolve to null.
 */
export function useReferencedImageDataUrl(
  ref: string | null | undefined,
  mimeType?: string,
): string | null {
  const workspaceRoot = useAppStore((s) => s.workspace?.path ?? null);
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  useEffect(() => {
    const key = typeof ref === "string" ? ref.trim() : "";
    if (!key || /^https?:/i.test(key) || /^data:/i.test(key) || /^blob:/i.test(key)) {
      setDataUrl(null);
      return;
    }
    const cacheKeyForRef = cacheKey(workspaceRoot, key);
    const cached = dataUrlCache.get(cacheKeyForRef);
    if (cached !== undefined) {
      setDataUrl(cached);
      return;
    }
    let current = true;
    setDataUrl(null);
    void api
      .fsReadImageDataUrl(key, mimeType)
      .then((result) => {
        const next = result.kind === "image" && result.dataUrl ? result.dataUrl : null;
        if (next) rememberDataUrl(cacheKeyForRef, next);
        if (current) setDataUrl(next);
      })
      .catch(() => {
        if (current) setDataUrl(null);
      });
    return () => {
      current = false;
    };
  }, [ref, mimeType, workspaceRoot]);
  return dataUrl;
}
