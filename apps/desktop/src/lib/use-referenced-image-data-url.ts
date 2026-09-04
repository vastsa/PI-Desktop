import { useEffect, useState } from "react";
import { api } from "./api";
import { useAppStore } from "../stores/app-store";

/**
 * Module-level cache so revisiting the same message (or rendering the same
 * local Markdown image in a list) does not re-read the file every commit.
 * The key includes the workspace root, so a relative path in one project can
 * never show another project's file, and the byte budget keeps the renderer
 * from retaining unbounded base64 payloads.
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
 * Load a referenced image (workspace-relative path, `attachments/<sha256>`, or
 * absolute scratch/attachment path) into a bounded data URL for in-chat
 * display. The host validates containment and size; failures resolve to null
 * so callers can fall back to a chip.
 */
export function useReferencedImageDataUrl(
  ref: string | null | undefined,
  mimeType?: string,
): string | null {
  const workspaceRoot = useAppStore((s) => s.workspace?.path ?? null);
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  useEffect(() => {
    const key = typeof ref === "string" ? ref.trim() : "";
    if (!key) {
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
