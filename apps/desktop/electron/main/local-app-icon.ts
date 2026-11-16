/**
 * Platform icon lookup for discovered applications.
 *
 * macOS: `app.getFileIcon(bundle, { size: "small" })` returns the generic
 * bundle placeholder for every `.app`, so each application rendered the same
 * blank square. The Quick Look thumbnail of a bundle is its real icon, so it
 * is tried first and the native file icon is only the fallback. The `large`
 * file-icon size is still never requested: it triggered a native startup
 * SIGTRAP on macOS.
 *
 * Every native capability is injected so the selection stays unit-testable.
 */

/** Minimal image handle; `NativeImage` from Electron satisfies it. */
export interface PlatformIconImage {
  isEmpty(): boolean;
  toDataURL(): string;
}

export interface PlatformIconProviders {
  /** `nativeImage.createThumbnailFromPath` (macOS / Windows only). */
  thumbnail(target: string, size: number): Promise<PlatformIconImage>;
  /** `app.getFileIcon(target, { size: "small" })`. */
  fileIcon(target: string): Promise<PlatformIconImage>;
}

/**
 * Thumbnail edge in device pixels. The tile draws the icon at 48 CSS px, so
 * 96 stays sharp on a 2x display; the encoded PNG stays well under the 32 KiB
 * per-icon budget (measured: p90 ~15 KiB across the stock /Applications set).
 */
export const MAC_APP_ICON_THUMBNAIL_SIZE = 96;

function usable(image: PlatformIconImage | null | undefined): PlatformIconImage | null {
  if (!image) return null;
  try {
    return image.isEmpty() ? null : image;
  } catch {
    return null;
  }
}

async function attempt(
  load: () => Promise<PlatformIconImage>,
): Promise<PlatformIconImage | null> {
  try {
    return usable(await load());
  } catch {
    return null;
  }
}

/** Resolve the best available icon, or `null` when the platform has none. */
export async function loadPlatformIcon(
  platform: string,
  target: string,
  providers: PlatformIconProviders,
): Promise<PlatformIconImage | null> {
  if (platform === "darwin" && target.trim().toLowerCase().endsWith(".app")) {
    const thumbnail = await attempt(() =>
      providers.thumbnail(target, MAC_APP_ICON_THUMBNAIL_SIZE),
    );
    if (thumbnail) return thumbnail;
  }
  return attempt(() => providers.fileIcon(target));
}
