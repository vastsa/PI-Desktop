import type { BrowserWindow } from "electron";

export function nativeWindowHandle(window: BrowserWindow): string {
  const bytes = window.getNativeWindowHandle();
  if (bytes.length === 0) throw new Error("native window handle is unavailable");
  let handle = 0n;
  for (let index = bytes.length - 1; index >= 0; index -= 1) {
    const byte = bytes[index];
    if (byte === undefined) throw new Error("native window handle is invalid");
    handle = (handle << 8n) | BigInt(byte);
  }
  if (handle === 0n) throw new Error("native window handle is invalid");
  return handle.toString(10);
}
