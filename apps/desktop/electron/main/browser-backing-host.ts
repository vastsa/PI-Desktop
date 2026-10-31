import { BrowserWindow, type View } from "electron";

/** Keep background guests connected to Chromium without presenting a window. */
export class BrowserBackingHost {
  private window: BrowserWindow | null = null;
  private readonly surfaces = new Set<View>();

  attach(surface: View, size: { width: number; height: number }): BrowserWindow {
    let window = this.window;
    if (!window || window.isDestroyed()) {
      window = new BrowserWindow({
        show: false,
        skipTaskbar: true,
        width: Math.max(1024, size.width),
        height: Math.max(768, size.height),
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          backgroundThrottling: false,
        },
      });
      this.window = window;
    }
    const [width, height] = window.getContentSize();
    if (width < size.width || height < size.height) {
      window.setContentSize(Math.max(width, size.width), Math.max(height, size.height));
    }
    if (!window.contentView.children.includes(surface)) window.contentView.addChildView(surface);
    this.surfaces.add(surface);
    return window;
  }

  detach(surface: View): void {
    const window = this.window;
    if (window && !window.isDestroyed() && window.contentView.children.includes(surface)) {
      window.contentView.removeChildView(surface);
    }
    this.surfaces.delete(surface);
    if (this.surfaces.size === 0) {
      this.window = null;
      if (window && !window.isDestroyed()) window.destroy();
    }
  }
}
