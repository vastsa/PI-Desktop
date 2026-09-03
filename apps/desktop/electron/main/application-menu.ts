import { Menu, type MenuItemConstructorOptions } from "electron";
import {
  APP_NAME,
  KEYBOARD_SHORTCUTS,
  keybindingToElectronAccelerator,
  resolveKeybinding,
  type AppMenuCommand,
  type KeybindingOverrides,
  type KeyboardShortcutId,
  type NativeMenuAction,
  type ShortcutPlatform,
} from "@pi-desktop/shared";
import { en, resolveLocale, zhCN } from "@pi-desktop/i18n";

export type ApplicationMenuOptions = {
  platform?: NodeJS.Platform;
  locale?: string;
  keybindings?: KeybindingOverrides;
  /** Adds the devtools item to the View menu (settings.developerMode). */
  developerMode?: boolean;
  dispatch: (command: AppMenuCommand) => void;
  /** Executes configurable native menu actions when their shortcut is unbound. */
  dispatchNative: (action: NativeMenuAction) => void;
};

function appCommand(
  label: string,
  command: AppMenuCommand,
  dispatch: ApplicationMenuOptions["dispatch"],
  accelerator?: string,
): MenuItemConstructorOptions {
  return {
    label,
    accelerator,
    click: () => dispatch(command),
  };
}

function nativeAction(
  label: string,
  role: NonNullable<MenuItemConstructorOptions["role"]>,
  action: NativeMenuAction,
  accelerator: string | undefined,
  dispatchNative: ApplicationMenuOptions["dispatchNative"],
): MenuItemConstructorOptions {
  // Electron assigns a role's platform default whenever accelerator is absent.
  // A plain item keeps the command clickable without resurrecting that default.
  return accelerator
    ? { role, accelerator }
    : { label, click: () => dispatchNative(action) };
}

export function buildApplicationMenuTemplate({
  platform = process.platform,
  locale = "en",
  keybindings,
  developerMode = false,
  dispatch,
  dispatchNative,
}: ApplicationMenuOptions): MenuItemConstructorOptions[] {
  const isMac = platform === "darwin";
  const shortcutPlatform = platform as ShortcutPlatform;
  const labels = resolveLocale(locale) === "zh-CN" ? zhCN : en;
  const template: MenuItemConstructorOptions[] = [];
  const accelerator = (id: KeyboardShortcutId) => {
    const shortcut = KEYBOARD_SHORTCUTS.find((candidate) => candidate.id === id);
    return shortcut
      ? keybindingToElectronAccelerator(
          resolveKeybinding(shortcut, keybindings, shortcutPlatform),
          shortcutPlatform,
        )
      : undefined;
  };

  if (isMac) {
    template.push({
      label: APP_NAME,
      submenu: [
        { role: "about" },
        appCommand(labels.menu.checkForUpdates, "checkForUpdates", dispatch),
        { type: "separator" },
        appCommand(
          labels.menu.settings,
          "openSettings",
          dispatch,
          accelerator("openSettings"),
        ),
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    });
  }

  template.push(
    {
      label: labels.menu.file,
      submenu: [
        appCommand(labels.menu.newTask, "newTask", dispatch, accelerator("newTask")),
        appCommand(
          labels.menu.openProject,
          "openProject",
          dispatch,
          accelerator("openProject"),
        ),
        ...(!isMac
          ? ([
              { type: "separator" },
              appCommand(
                labels.menu.settings,
                "openSettings",
                dispatch,
                accelerator("openSettings"),
              ),
            ] satisfies MenuItemConstructorOptions[])
          : []),
        { type: "separator" },
        nativeAction(
          labels.menu.closeWindow,
          "close",
          "close",
          accelerator("closeWindow"),
          dispatchNative,
        ),
      ],
    },
    {
      label: labels.menu.edit,
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        ...(isMac
          ? ([
              { role: "pasteAndMatchStyle" },
              { role: "delete" },
            ] satisfies MenuItemConstructorOptions[])
          : []),
        { role: "selectAll" },
      ],
    },
    {
      label: labels.menu.view,
      submenu: [
        appCommand(labels.menu.search, "openSearch", dispatch, accelerator("openSearch")),
        appCommand(
          labels.menu.toggleSidebar,
          "toggleSidebar",
          dispatch,
          accelerator("toggleSidebar"),
        ),
        { type: "separator" },
        { role: "reload" },
        { type: "separator" },
        nativeAction(
          labels.menu.actualSize,
          "resetZoom",
          "resetZoom",
          accelerator("resetZoom"),
          dispatchNative,
        ),
        nativeAction(
          labels.menu.zoomIn,
          "zoomIn",
          "zoomIn",
          accelerator("zoomIn"),
          dispatchNative,
        ),
        nativeAction(
          labels.menu.zoomOut,
          "zoomOut",
          "zoomOut",
          accelerator("zoomOut"),
          dispatchNative,
        ),
        { type: "separator" },
        nativeAction(
          labels.menu.toggleFullScreen,
          "togglefullscreen",
          "toggleFullScreen",
          accelerator("toggleFullScreen"),
          dispatchNative,
        ),
        // Only surfaced with developer mode on, so the console stays out of
        // reach for regular users (settings.developerMode).
        ...(developerMode
          ? ([
              { type: "separator" },
              { role: "toggleDevTools", label: labels.menu.toggleDevTools },
            ] satisfies MenuItemConstructorOptions[])
          : []),
      ],
    },
    {
      label: labels.menu.window,
      submenu: [
        { role: "minimize" },
        ...(isMac
          ? ([
              { role: "zoom" },
              { type: "separator" },
              { role: "front" },
            ] satisfies MenuItemConstructorOptions[])
          : []),
      ],
    },
    {
      role: "help",
      label: labels.menu.help,
      submenu: [
        appCommand(labels.menu.appHelp, "openHelp", dispatch),
        appCommand(labels.menu.openLogs, "openLogs", dispatch),
        ...(!isMac
          ? ([
              { type: "separator" },
              appCommand(
                labels.menu.checkForUpdates,
                "checkForUpdates",
                dispatch,
              ),
            ] satisfies MenuItemConstructorOptions[])
          : []),
      ],
    },
  );

  return template;
}

export function installApplicationMenu(options: ApplicationMenuOptions) {
  if ((options.platform ?? process.platform) !== "darwin") {
    Menu.setApplicationMenu(null);
    return;
  }
  const template = buildApplicationMenuTemplate(options);
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
