import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const electron = require(process.env.PI_DESKTOP_ELECTRON_PACKAGE);
const { app, BrowserWindow, WebContentsView, screen } = electron;
const { installWindowShape } = await import(
  pathToFileURL(process.env.PI_DESKTOP_WINDOW_SHAPE).href
);
const { installWindows11CornerController, usesWindows11NativeCorners } = await import(
  pathToFileURL(process.env.PI_DESKTOP_WINDOW_NATIVE_CORNERS).href
);
const { applyMainWindowBackground, mainWindowBackgroundOptions } = await import(
  pathToFileURL(process.env.PI_DESKTOP_WINDOW_BACKGROUND).href
);

const radius = Number(process.env.PI_DESKTOP_SURFACE_RADIUS);
const backdropColor = process.env.PI_DESKTOP_SURFACE_BACKDROP;
const title = "PI Desktop Surface Candidate";
let backdropWindow;
let mainWindow;
let host;

function dataUrl(markup) {
  return `data:text/html;charset=utf-8,${encodeURIComponent(markup)}`;
}

function mainPage() {
  return dataUrl(`<!doctype html>
    <html><head><meta charset="utf-8"><style>
      * { box-sizing: border-box; }
      html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: transparent; }
      body { display: flex; }
      .half { position: absolute; top: 0; width: calc(50% - 24px); height: 100%; }
      .light { left: 0; background: #f6f6f6; }
      .dark { right: 0; background: #181818; }
      .window-background-swatch { position: fixed; z-index: 2; left: calc(50% - 24px); top: calc(50% - 24px); width: 48px; height: 48px; }
    </style></head><body><div class="half light"></div><div class="half dark"></div><div class="window-background-swatch"></div></body></html>`);
}

function childPage() {
  return dataUrl(`<!doctype html>
    <html><head><meta charset="utf-8"><style>
      html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: #d61f69; }
    </style></head><body></body></html>`);
}

app.whenReady().then(async () => {
  if (process.platform !== "win32") throw new Error("surface fixture requires Windows");
  if (!Number.isInteger(radius) || radius < 0 || radius > 24) {
    throw new Error(`invalid fixture radius: ${process.env.PI_DESKTOP_SURFACE_RADIUS}`);
  }

  const display = screen.getPrimaryDisplay();
  const windows11NativeCorners = usesWindows11NativeCorners(
    process.platform,
    process.getSystemVersion(),
  );
  const fixtureBackground = windows11NativeCorners ? "#00000080" : "#fafafa";
  const { workArea } = display;
  const width = Math.min(840, workArea.width - 40);
  const height = Math.min(600, workArea.height - 40);
  if (width < 320 || height < 240) throw new Error("primary display is too small for the fixture");

  backdropWindow = new BrowserWindow({
    x: workArea.x,
    y: workArea.y,
    width: workArea.width,
    height: workArea.height,
    frame: false,
    focusable: false,
    skipTaskbar: true,
    resizable: false,
    backgroundColor: backdropColor,
  });
  backdropWindow.showInactive();

  mainWindow = new BrowserWindow({
    x: workArea.x + Math.floor((workArea.width - width) / 2),
    y: workArea.y + Math.floor((workArea.height - height) / 2),
    width,
    height,
    minWidth: Math.min(800, workArea.width),
    minHeight: Math.min(560, workArea.height),
    title,
    frame: false,
    thickFrame: false,
    resizable: true,
    show: false,
    ...mainWindowBackgroundOptions(
      process.platform,
      fixtureBackground,
      windows11NativeCorners,
      "#ffffff",
    ),
  });
  mainWindow.webContents.on("page-title-updated", (event) => event.preventDefault());
  if (windows11NativeCorners) {
    const { Host, resolveHostBinary } = await import(
      pathToFileURL(process.env.PI_DESKTOP_E2E_HOST_HELPER).href
    );
    process.env.PI_DESKTOP_ELECTRON_PID = String(process.pid);
    host = new Host(resolveHostBinary(), process.env.PI_DESKTOP_SURFACE_PROFILE);
    await host.start();
    await installWindows11CornerController(
      mainWindow,
      radius,
      () => host,
      screen,
      { app: (...args) => console.error(...args) },
    );
  } else {
    installWindowShape(mainWindow, radius, screen);
  }
  applyMainWindowBackground(
    mainWindow,
    process.platform,
    fixtureBackground,
    windows11NativeCorners,
    "#ffffff",
  );

  const childView = new WebContentsView({
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  mainWindow.contentView.addChildView(childView);
  // Let the child view extend beyond the parent bounds at the lower-right so
  // the pixel probe verifies the common content-view clip on native children.
  childView.setBounds({ x: width - 48, y: height - 48, width: 96, height: 96 });

  await Promise.all([
    mainWindow.loadURL(mainPage()),
    childView.webContents.loadURL(childPage()),
  ]);
  mainWindow.show();
  mainWindow.focus();

  process.stdout.write(`${JSON.stringify({
    type: "ready",
    processId: process.pid,
    title,
    width,
    height,
    radius,
    backdropColor,
    scaleFactor: display.scaleFactor,
    cornerMode: windows11NativeCorners ? "dwm-native" : "legacy-shape",
  })}\n`);
});

app.on("before-quit", () => {
  if (host) void host.stop().catch((error) => console.error("host cleanup failed", error));
});
app.on("window-all-closed", () => app.quit());
