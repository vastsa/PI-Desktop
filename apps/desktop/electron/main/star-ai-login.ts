import { BrowserWindow, session, type Session } from "electron";
import { STARAI_COOKIE, STARAI_ORIGIN, STARAI_REFRESH, starAiError } from "./star-ai-session";
import { attachStarAiLoginTheme, readStarAiLoginTheme } from "./star-ai-login-theme";

export function starAiPartition() {
  const partition = session.fromPartition("persist:starai-account");
  partition.setPermissionCheckHandler(() => false);
  partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  return partition;
}

export async function hasStarAiCookie(partition: Session) {
  const cookies = await partition.cookies.get({ name: STARAI_COOKIE, url: STARAI_ORIGIN + STARAI_REFRESH });
  return cookies.some((cookie) => cookie.hostOnly && cookie.httpOnly && cookie.domain === new URL(STARAI_ORIGIN).hostname);
}

async function loginOrigins(partition: Session) {
  const origins = new Set([STARAI_ORIGIN]);
  try {
    const response = await partition.fetch(STARAI_ORIGIN + "/api/status", {
      redirect: "error", credentials: "omit", signal: AbortSignal.timeout(4_000),
    });
    if (!response.ok) return origins;
    const { data } = await response.json();
    if (data.github_oauth === true) origins.add("https://github.com");
    if (data.discord_oauth === true) origins.add("https://discord.com");
    if (data.linuxdo_oauth === true) origins.add("https://connect.linux.do");
    if (data.telegram_oauth === true) origins.add("https://oauth.telegram.org");
    const endpoints: unknown[] = [data.oidc_authorization_endpoint];
    if (Array.isArray(data.custom_oauth_providers)) {
      for (const provider of data.custom_oauth_providers) endpoints.push(provider?.authorization_endpoint);
    }
    for (const endpoint of endpoints) {
      if (typeof endpoint !== "string" || !endpoint) continue;
      const url = new URL(endpoint);
      if (url.protocol === "https:" && !url.username && !url.password) origins.add(url.origin);
    }
  } catch { /* The first-party password flow remains available when status is offline. */ }
  return origins;
}

/** The upstream sign-in page owns passwords, second factors and identity-provider redirects. */
export async function openStarAiLogin(parent: BrowserWindow | null, partition: Session, canOpen?: () => boolean): Promise<void> {
  const [origins, theme] = await Promise.all([loginOrigins(partition), readStarAiLoginTheme(parent)]);
  if (parent?.isDestroyed() || (canOpen && !canOpen())) {
    throw starAiError("STARAI_LOGIN_DEFERRED", "Waiting for the main window to regain focus.");
  }
  const window = new BrowserWindow({
    width: 520, height: 720, parent: parent ?? undefined, modal: !!parent,
    autoHideMenuBar: true, title: "StarAI", show: false, backgroundColor: theme.background,
    webPreferences: { session: partition, sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false },
  });
  const contents = window.webContents;
  attachStarAiLoginTheme(window, parent, theme);
  const allowed = (address: string) => {
    try { const url = new URL(address); return origins.has(url.origin) && !url.username && !url.password; }
    catch { return false; }
  };
  contents.setWindowOpenHandler(({ url }) => {
    if (allowed(url)) void contents.loadURL(url).catch(() => {});
    return { action: "deny" };
  });
  contents.on("will-navigate", (event) => { if (!allowed(event.url)) event.preventDefault(); });
  contents.on("will-redirect", (event) => { if (event.isMainFrame && !allowed(event.url)) event.preventDefault(); });
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      partition.cookies.off("changed", onCookie);
      clearTimeout(timeout);
      if (!window.isDestroyed()) window.destroy();
      if (error) reject(error); else resolve();
    };
    const onCookie = (_event: Electron.Event, cookie: Electron.Cookie, _cause: string, removed: boolean) => {
      if (!removed && cookie.name === STARAI_COOKIE && cookie.domain === new URL(STARAI_ORIGIN).hostname &&
          cookie.hostOnly && cookie.httpOnly && cookie.path === "/api/user/auth") finish();
    };
    const timeout = setTimeout(() => finish(starAiError("STARAI_LOGIN_CANCELLED", "StarAI sign-in timed out.")), 10 * 60_000);
    partition.cookies.on("changed", onCookie);
    window.once("closed", () => finish(starAiError("STARAI_LOGIN_CANCELLED", "StarAI sign-in was cancelled.")));
    void window.loadURL(STARAI_ORIGIN + "/sign-in").catch(() => {
      finish(starAiError("STARAI_UNAVAILABLE", "Unable to open the StarAI sign-in page."));
    });
  });
}
