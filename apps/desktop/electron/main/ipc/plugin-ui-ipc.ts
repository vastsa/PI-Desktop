import { existsSync } from "node:fs";
import { join } from "node:path";
import { IPC, type PluginScenicThemesDestinationMeta, type PluginViewMeta } from "@pi-desktop/shared";
import { normalizeThemeAssetPath, pluginThemeId, resolvePluginLocalizedString, themeAssetUrl } from "@pi-desktop/plugin-sdk";
import type { BrowserHost } from "../browser-host";
import { BROWSER_PLUGIN_ID, BROWSER_VIEW_ID } from "../browser-host";
import type { PluginRuntime } from "../plugin-runtime";
import { resolveInsidePlugin as resolveInsidePluginRoot } from "../plugin-runtime";
import { PluginViewHost, pluginViewKey } from "../plugin-view-host";
import { PluginPanelHost } from "../plugin-panel-host";
import type { PluginPanelTheme } from "../../shared/plugin-panel-chrome";
import type { IpcRegistrar } from "./types";

export type PluginUiIpcDependencies = {
  registrar: IpcRegistrar;
  plugins: PluginRuntime;
  browserHost: BrowserHost;
  pluginViews: PluginViewHost;
  pluginPanels: PluginPanelHost;
  pluginActiveInProject: (pluginId: string, projectPath: string | null | undefined) => boolean;
  currentWorkspacePath: () => string | null;
  getUpdaterLocale: () => string;
  getPluginPanelTheme: () => PluginPanelTheme;
};

/** Register plugin panels, work-panel views, themes and services. */
export function registerPluginUiIpc({
  registrar,
  plugins,
  browserHost,
  pluginViews,
  pluginPanels,
  pluginActiveInProject,
  currentWorkspacePath,
  getUpdaterLocale,
  getPluginPanelTheme,
}: PluginUiIpcDependencies): void {
  const handle = (channel: string, fn: (...args: any[]) => Promise<any>) => {
    registrar.handle(channel, fn);
  };
  handle(IPC.invoke.pluginOpenPanel, async (id: string) => {
    const loaded = plugins.getLoaded(id);
    if (!loaded) throw new Error("plugin not loaded");
    const manifest = loaded.manifest;
    if (!manifest.ui?.panel) throw new Error("plugin has no panel");
    if (!(loaded.permissions.has("ui.panel"))) {
      throw new Error("PERMISSION_DENIED: ui.panel");
    }
    const htmlPath = resolveInsidePluginRoot(loaded.path, manifest.ui.panel);
    if (!htmlPath) throw new Error("plugin panel must stay inside the plugin");
    await pluginPanels.open({
      pluginId: id,
      title: resolvePluginLocalizedString(manifest.ui.title, getUpdaterLocale(), manifest.name),
      locale: getUpdaterLocale(),
      theme: getPluginPanelTheme(),
      shape: manifest.ui.shape,
      alwaysOnTop: manifest.ui.alwaysOnTop,
      resizable: manifest.ui.resizable,
      width: manifest.ui.width ?? 480,
      height: manifest.ui.height ?? 360,
      htmlPath,
    });
    return { ok: true };
  });

  /**
   * Work panel views a plugin contributes (ADR 0104).
   *
   * Unlike `pluginThemes`, this list *is* filtered by activation scope: a theme
   * is one global app setting, but a view is something the plugin does inside a
   * project, so a project-scoped plugin must not offer its view elsewhere.
   */
  handle(IPC.invoke.pluginViews, async () => {
    const workspacePath = currentWorkspacePath();
    const views: PluginViewMeta[] = [];
    for (const loaded of plugins.listLoaded()) {
      const pluginId = loaded.manifest.id;
      if (!loaded.permissions.has("ui.view")) continue;
      if (!pluginActiveInProject(pluginId, workspacePath)) continue;
      const contributed = loaded.manifest.contributes?.views ?? [];
      contributed.forEach((view, index) => {
        if (!view?.id || !view.entry) return;
        // The manifest is validated at install, but a development plugin's
        // files change under us; a missing entry must not become a blank pane.
        if (!existsSync(join(loaded.path, view.entry))) return;
        views.push({
          pluginId,
          viewId: view.id,
          ref: pluginViewKey(pluginId, view.id),
          title: resolvePluginLocalizedString(view.title, getUpdaterLocale(), view.id),
          pluginName: loaded.manifest.name,
          icon: view.icon,
          order: Number.isFinite(view.order) ? Number(view.order) : index,
        });
      });
    }
    // Stable order across refreshes: declared order first, then plugin name, so
    // the menu never reshuffles under the pointer when an unrelated plugin
    // loads.
    return views.sort(
      (a, b) =>
        a.order - b.order ||
        a.pluginName.localeCompare(b.pluginName) ||
        a.viewId.localeCompare(b.viewId),
    );
  });

  handle(IPC.invoke.pluginScenicThemesDestinations, async () => {
    const destinations: PluginScenicThemesDestinationMeta[] = [];
    for (const loaded of plugins.listLoaded()) {
      if (!loaded.permissions.has("ui.settings") || !loaded.permissions.has("ui.theme")) continue;
      const scenicThemes = loaded.manifest.contributes?.scenicThemes;
      if (!scenicThemes) continue;
      const pluginId = loaded.manifest.id;
      const cards: PluginScenicThemesDestinationMeta["themes"] = [];
      let valid = true;
      for (const card of scenicThemes.themes) {
        const contribution = (loaded.manifest.contributes?.themes ?? []).find((theme) => theme.id === card.themeId);
        const namespacedThemeId = pluginThemeId(pluginId, card.themeId);
        const theme = plugins.getThemes().find((candidate) => candidate.id === namespacedThemeId);
        const previewAsset = normalizeThemeAssetPath(card.previewAsset);
        const ownsTheme = theme?.pluginId === pluginId;
        const ownsPreview = !!contribution && !!previewAsset && (contribution.assets ?? []).some((asset) => normalizeThemeAssetPath(asset) === previewAsset);
        const blur = contribution?.variables?.find((variable) => variable.name === "--nexus-backdrop-blur");
        const validBlur = blur?.type === "length" && blur.unit === "px" && blur.min === 0 && blur.max === 20 && Number.isInteger(blur.default);
        if (!ownsTheme || !ownsPreview || !validBlur) {
          valid = false;
          break;
        }
        const stored = plugins.getThemeVariableValue(pluginId, namespacedThemeId, "--nexus-backdrop-blur");
        const currentBlur = typeof stored === "number" && Number.isInteger(stored) && stored >= 0 && stored <= 20 ? stored : blur.default;
        cards.push({
          themeId: namespacedThemeId,
          label: resolvePluginLocalizedString(card.label, getUpdaterLocale(), card.themeId),
          description: resolvePluginLocalizedString(card.description, getUpdaterLocale(), ""),
          previewUrl: themeAssetUrl(pluginId, previewAsset),
          blur: currentBlur,
          blurDefault: blur.default,
        });
      }
      if (!valid || !cards.length) continue;
      destinations.push({
        pluginId,
        destinationId: scenicThemes.id,
        ref: pluginViewKey(pluginId, scenicThemes.id),
        label: resolvePluginLocalizedString(scenicThemes.label, getUpdaterLocale(), scenicThemes.id),
        description: resolvePluginLocalizedString(scenicThemes.description, getUpdaterLocale(), ""),
        pluginName: loaded.manifest.name,
        icon: "palette",
        keywords: (scenicThemes.keywords ?? []).map((keyword) => resolvePluginLocalizedString(keyword, getUpdaterLocale(), "")),
        themes: cards,
      });
    }
    return destinations.sort((a, b) => a.pluginName.localeCompare(b.pluginName) || a.destinationId.localeCompare(b.destinationId));
  });

  handle(IPC.invoke.pluginScenicThemesSetBlur, async (payload: { pluginId?: string; themeId?: string; blur?: unknown }) => {
    const pluginId = String(payload?.pluginId ?? "");
    const themeId = String(payload?.themeId ?? "");
    const blur = payload?.blur;
    if (!Number.isInteger(blur) || (blur as number) < 0 || (blur as number) > 20) {
      throw new Error("INVALID_ARGUMENT: blur must be an integer from 0 to 20");
    }
    const loaded = plugins.getLoaded(pluginId);
    const destination = loaded?.manifest.contributes?.scenicThemes;
    if (!loaded || !destination || !loaded.permissions.has("ui.settings") || !loaded.permissions.has("ui.theme")) {
      throw new Error("PERMISSION_DENIED: scenic theme controls unavailable");
    }
    const owned = destination.themes.some((card) => pluginThemeId(pluginId, card.themeId) === themeId);
    if (!owned) throw new Error("NOT_FOUND: scenic theme not found");
    await plugins.setScenicThemeBlur(pluginId, themeId, blur as number);
    return { ok: true };
  });


  handle(
    IPC.invoke.pluginViewOpen,
    async (payload: {
      pluginId?: string;
      viewId?: string;
      sessionId?: string;
      location?: string;
      tabId?: string;
    }) => {
      const pluginId = String(payload?.pluginId ?? "");
      const viewId = String(payload?.viewId ?? "");
      const sessionId = String(payload?.sessionId ?? "").trim();
      const location = String(payload?.location ?? "").trim();
      const isBrowserView = pluginId === BROWSER_PLUGIN_ID && viewId === BROWSER_VIEW_ID;
      const loaded = plugins.getLoaded(pluginId);
      if (!loaded) throw new Error("plugin not loaded");
      if (!loaded.permissions.has("ui.view")) {
        throw new Error("PERMISSION_DENIED: ui.view");
      }
      if (!pluginActiveInProject(pluginId, currentWorkspacePath())) {
        throw new Error("plugin is not active in this project");
      }
      const view = (loaded.manifest.contributes?.views ?? []).find(
        (candidate) => candidate?.id === viewId,
      );
      if (!view) throw new Error("plugin has no such view");
      const htmlPath = join(loaded.path, view.entry);
      if (!existsSync(htmlPath)) throw new Error("view entry missing");
      if (isBrowserView && sessionId) {
        browserHost.setChromeSession(sessionId, typeof payload.tabId === "string" ? payload.tabId : undefined, location);
      }
      pluginViews.open({
        pluginId,
        viewId,
        locale: getUpdaterLocale(),
        theme: getPluginPanelTheme(),
        htmlPath,
        netDomains: loaded.manifest.net?.domains?.map((domain) => String(domain)),
        // The browser view owns an address bar and its own history, so its
        // location keeps going through `browserHost`; every other contributed
        // view receives the opener's subject untouched (D320 follow-up).
        ...(isBrowserView || !location ? {} : { location }),
      });
      return { ok: true };
    },
  );

  handle(
    IPC.invoke.pluginViewClose,
    async (payload: { pluginId?: string; viewId?: string; sessionId?: string; tabId?: string }) => {
      if (payload.pluginId === BROWSER_PLUGIN_ID && payload.viewId === BROWSER_VIEW_ID && typeof payload.sessionId === "string") {
        if (typeof payload.tabId === "string") browserHost.closeTab(payload.sessionId, payload.tabId);
        else browserHost.closeSession(payload.sessionId);
        return { ok: true };
      }
      pluginViews.close(String(payload?.pluginId ?? ""), String(payload?.viewId ?? ""));
      return { ok: true };
    },
  );

  handle(
    IPC.invoke.pluginViewSetBounds,
    async (payload: { x: number; y: number; width: number; height: number }) => {
      pluginViews.setBounds(payload ?? { x: 0, y: 0, width: 0, height: 0 });
      return { ok: true };
    },
  );

  handle(
    IPC.invoke.pluginViewSetVisible,
    async (payload: {
      pluginId?: string;
      viewId?: string;
      visible?: boolean;
      sessionId?: string;
    }) => {
      const pluginId = String(payload?.pluginId ?? "");
      const viewId = String(payload?.viewId ?? "");
      const sessionId = String(payload?.sessionId ?? "").trim();
      if (
        payload?.visible === true &&
        sessionId &&
        pluginId === BROWSER_PLUGIN_ID &&
        viewId === BROWSER_VIEW_ID
      ) {
        browserHost.setChromeSession(sessionId);
      }
      pluginViews.setVisible(pluginId, viewId, payload?.visible === true);
      return { ok: true };
    },
  );

  // Plugin themes: the renderer needs the sanitized CSS itself, so this
  // channel returns the payload rather than only the catalog.
  //
  // Deliberately *not* scope-filtered. The selected theme is one global app
  // setting, so filtering here would make the whole window repaint when the
  // user opened a different folder, and strand them on a theme that no longer
  // resolves. Project scope governs what a plugin may *do* in a project, not
  // how the app looks.
  handle(IPC.invoke.pluginThemes, async () => plugins.getThemes());

  // Resident service supervision state; refreshed on the pluginChanged event.
  handle(IPC.invoke.pluginServices, async () => plugins.getServiceStates());
}
