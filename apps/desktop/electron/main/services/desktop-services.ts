import {
  nativeImage,
  Notification as SystemNotification,
  shell,
  type BrowserWindow,
} from "electron";
import {
  APP_NAME,
  type ComposerPasteFile,
} from "@pi-desktop/shared";
import type {
  PluginNativeNotificationInput,
  PluginNativeNotificationResult,
  PluginNotificationPermission,
} from "@pi-desktop/plugin-sdk";
import { ClipboardHistory } from "../clipboard-history";
import { parseAllowedExternalUrl } from "../safe-open-external";
import type { Logger } from "../logger";

const PLUGIN_NOTIFICATION_TIMEOUT_MS = 2_000;
const MAX_CLIPBOARD_IMAGE_PIXELS = 64_000_000;
const MAX_UNKNOWN_CLIPBOARD_IMAGE_BYTES = 8 * 1024 * 1024;

export function createDesktopServices({
  getLogger,
  getMainWindow,
}: {
  getLogger: () => Logger;
  getMainWindow: () => BrowserWindow | null;
}) {
  let pluginNotificationPermission: PluginNotificationPermission = "unknown";
  const pluginNativeNotifications = new Set<SystemNotification>();
  const clipboardHistory = new ClipboardHistory();

  const getPluginNotificationPermission =
    (): PluginNotificationPermission => {
      if (!SystemNotification.isSupported()) return "unsupported";
      return pluginNotificationPermission;
    };

  const showPluginNativeNotification = (
    input: PluginNativeNotificationInput,
  ): Promise<PluginNativeNotificationResult> => {
    if (!SystemNotification.isSupported()) {
      return Promise.resolve({ shown: false, permission: "unsupported" });
    }

    const title =
      String(input.title ?? "Plugin").trim().slice(0, 100) || "Plugin";
    const body = String(input.body ?? "").trim().slice(0, 240);

    return new Promise((resolve) => {
      const notification = new SystemNotification({ title, body });
      pluginNativeNotifications.add(notification);
      let settled = false;
      let timer: NodeJS.Timeout | undefined;

      const finish = (
        permission: PluginNotificationPermission,
        shown: boolean,
      ) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (permission === "granted" || permission === "denied") {
          pluginNotificationPermission = permission;
        }
        if (!shown) pluginNativeNotifications.delete(notification);
        resolve({ shown, permission });
      };

      notification.once("show", () => finish("granted", true));
      notification.once("close", () => pluginNativeNotifications.delete(notification));
      notification.once("click", () => {
        const window = getMainWindow();
        try {
          if (!window || window.isDestroyed()) return;
          if (window.isMinimized()) window.restore();
          window.show();
          window.focus();
        } finally {
          pluginNativeNotifications.delete(notification);
        }
      });
      (
        notification as unknown as {
          once: (
            event: string,
            listener: (...args: unknown[]) => void,
          ) => unknown;
        }
      ).once("failed", () => finish("denied", false));

      timer = setTimeout(() => {
        finish(getPluginNotificationPermission(), false);
      }, PLUGIN_NOTIFICATION_TIMEOUT_MS);

      try {
        notification.show();
      } catch {
        finish("denied", false);
      }
    });
  };

  const requestPluginNotificationPermission =
    async (): Promise<PluginNotificationPermission> => {
      const result = await showPluginNativeNotification({
        title: APP_NAME + " notifications",
        body: "Native notifications are enabled for this app.",
      });
      return result.permission;
    };

  const bytesFromPaste = (data: unknown): Uint8Array | null => {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    return null;
  };

  const imageDimensions = (
    data: Uint8Array,
  ): { width: number; height: number } | null => {
    if (
      data.byteLength >= 24 &&
      data[0] === 0x89 &&
      data[1] === 0x50 &&
      data[2] === 0x4e &&
      data[3] === 0x47
    ) {
      const view = new DataView(
        data.buffer,
        data.byteOffset,
        data.byteLength,
      );
      return { width: view.getUint32(16), height: view.getUint32(20) };
    }
    if (
      data.byteLength >= 10 &&
      data[0] === 0x47 &&
      data[1] === 0x49 &&
      data[2] === 0x46
    ) {
      const view = new DataView(
        data.buffer,
        data.byteOffset,
        data.byteLength,
      );
      return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
    }
    if (
      data.byteLength >= 30 &&
      data[0] === 0x52 &&
      data[1] === 0x49 &&
      data[2] === 0x46 &&
      data[3] === 0x46 &&
      data[8] === 0x57 &&
      data[9] === 0x45 &&
      data[10] === 0x42 &&
      data[11] === 0x50 &&
      data[12] === 0x56 &&
      data[13] === 0x50 &&
      data[14] === 0x38 &&
      data[15] === 0x58
    ) {
      return {
        width: 1 + data[24] + (data[25] << 8) + (data[26] << 16),
        height: 1 + data[27] + (data[28] << 8) + (data[29] << 16),
      };
    }
    if (data.byteLength >= 4 && data[0] === 0xff && data[1] === 0xd8) {
      const view = new DataView(
        data.buffer,
        data.byteOffset,
        data.byteLength,
      );
      let offset = 2;
      while (offset + 9 < data.byteLength) {
        if (data[offset] !== 0xff) {
          offset += 1;
          continue;
        }
        const marker = data[offset + 1];
        offset += 2;
        if (marker === 0xd8 || marker === 0xd9) continue;
        if (offset + 2 > data.byteLength) return null;
        const segmentLength = view.getUint16(offset);
        if (segmentLength < 2 || offset + segmentLength > data.byteLength) {
          return null;
        }
        if (
          (marker >= 0xc0 && marker <= 0xc3) ||
          (marker >= 0xc5 && marker <= 0xc7) ||
          (marker >= 0xc9 && marker <= 0xcb) ||
          (marker >= 0xcd && marker <= 0xcf)
        ) {
          if (segmentLength < 7) return null;
          return {
            width: view.getUint16(offset + 5),
            height: view.getUint16(offset + 3),
          };
        }
        offset += segmentLength;
      }
    }
    return null;
  };

  const recordPastedClipboardFiles = (files: ComposerPasteFile[]): void => {
    for (const file of files) {
      const bytes = bytesFromPaste(file?.data);
      if (!bytes) continue;
      const mimeType = typeof file.mimeType === "string" ? file.mimeType : "";
      if (file.recordHistory && mimeType.toLowerCase() === "text/plain") {
        clipboardHistory.recordText(new TextDecoder().decode(bytes));
        continue;
      }
      const isImage =
        mimeType.toLowerCase().startsWith("image/") ||
        /\.(avif|bmp|gif|heic|jpe?g|png|tiff?|webp)$/i.test(file.name ?? "");
      if (!isImage) continue;
      const dimensions = imageDimensions(bytes);
      if (
        (dimensions &&
          (dimensions.width < 1 ||
            dimensions.height < 1 ||
            dimensions.width * dimensions.height > MAX_CLIPBOARD_IMAGE_PIXELS)) ||
        (!dimensions && bytes.byteLength > MAX_UNKNOWN_CLIPBOARD_IMAGE_BYTES)
      ) {
        continue;
      }
      try {
        const image = nativeImage.createFromBuffer(Buffer.from(bytes));
        if (image.isEmpty()) continue;
        const size = image.getSize();
        if (size.width * size.height > MAX_CLIPBOARD_IMAGE_PIXELS) continue;
        clipboardHistory.recordImage({
          format: "png",
          data: new Uint8Array(image.toPNG()),
          width: size.width,
          height: size.height,
        });
      } catch {
        // Invalid image bytes must not make an otherwise valid paste fail.
      }
    }
  };

  const safeOpenExternal = async (rawUrl: unknown): Promise<void> => {
    const url = parseAllowedExternalUrl(rawUrl);
    if (!url) {
      getLogger().app("permission", "warn", "Blocked disallowed external protocol or URL", {
        data: {
          url: typeof rawUrl === "string" ? rawUrl.slice(0, 256) : String(rawUrl),
        },
      });
      throw new Error("DISALLOWED_EXTERNAL_URL");
    }
    await shell.openExternal(url);
  };

  return {
    clipboardHistory,
    getPluginNotificationPermission,
    showPluginNativeNotification,
    requestPluginNotificationPermission,
    recordPastedClipboardFiles,
    safeOpenExternal,
  };
}
