import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../stores/app-store";
import { api } from "../lib/api";
import { isHtmlFilePath, toWorkspaceRel, type ChatPreviewTarget } from "../lib/chat-links";
import { openHttpUrl } from "../lib/open-http-url";
import {
  FILE_MANAGER_PLUGIN_TAB,
  fileManagerPluginTab,
  hasPluginView,
} from "../lib/work-panel-tabs";

/**
 * Open one target the transcript named.
 *
 * A file never opens its own path directly. It goes through the same
 * completion the message body uses (`useOpenChatFileRef`, ADR 0262), so the
 * surface that named the file stops deciding where it shows: a tool row's
 * summary and a tool result's file/match list land in the bundled file view on
 * a project file exactly like a chat chip, and fall back the same way when the
 * view, the file, or the reference is not there. One opener for the whole
 * transcript is also what keeps a shorthand honest — a click opens the file
 * that matched, or reports that nothing did. HTTP(S) URLs follow the Link
 * open destination setting.
 */
export function useOpenPreviewTarget() {
  const openFileRef = useOpenChatFileRef();
  return useCallback(
    (target: ChatPreviewTarget) =>
      target.kind === "file" ? openFileRef(target.path) : openHttpUrl(target.url),
    [openFileRef],
  );
}

/** Dot-relative references resolve against the markdown file being viewed. */
function isDotRelative(path: string): boolean {
  return path.startsWith("./") || path.startsWith("../");
}

/**
 * Where a chat file reference actually landed.
 *
 * The reference is completed in the main process first, because the token is
 * routinely a shorthand: an agent that works on `/root/dir/openimage.js` names
 * only `openimage.js` in its reply, and the open project answers before the
 * session's own scratch store does.
 *
 * Completion also picks how the file is addressed. A file in the project's
 * **primary** folder travels as a project-relative path, exactly as before; a
 * file in any other folder of the same project group (ADR 0249) can only be
 * named by its absolute path, and the file view switches its own folder to the
 * one that contains it. Scratch and attachment files are absolute too.
 *
 * A reference that matches nothing is reported here, once, so every action
 * built on a reference stays honest about a shorthand that resolved to
 * nothing instead of acting on a differently named file.
 */
export type ResolvedChatFileRef = {
  /** The address the host accepts for this reference. */
  path: string;
  /** The absolute path; the one spelling that resolves from anywhere. */
  absolutePath: string;
  /** Project-relative spelling; null when the file sits outside the project. */
  relativePath: string | null;
  /** True for a match inside a folder the open project registers (ADR 0249). */
  inProject: boolean;
  /** True when that folder is the project's primary one. */
  primary: boolean;
};

function useResolveChatFileRef() {
  const { t } = useTranslation();
  const workspacePath = useAppStore((s) => s.workspace?.path ?? null);
  const sessionId = useAppStore((s) => s.activeSessionId);
  const showToast = useAppStore((s) => s.showToast);

  return useCallback(
    async (
      path: string,
      baseDir?: string,
    ): Promise<ResolvedChatFileRef | null> => {
      const raw = String(path ?? "").trim();
      if (!raw) return null;
      // `./x` and `../x` are the one shape the caller resolves better than the
      // main process can: the base is the markdown file on screen, which only
      // the caller knows. Everything else is completed against the roots.
      const anchored = isDotRelative(raw)
        ? toWorkspaceRel(raw, workspacePath, baseDir)
        : null;
      let match = null;
      try {
        match = (await api.fsResolveRef(anchored ?? raw, sessionId)).match;
      } catch {
        match = null;
      }
      if (!match) {
        showToast(t("chat.fileRefMissing", { name: raw }), { variant: "error" });
        return null;
      }
      if (match.root !== "workspace") {
        return {
          path: match.absolutePath,
          absolutePath: match.absolutePath,
          relativePath: null,
          inProject: false,
          primary: false,
        };
      }
      // A project group can hold several folders, and a relative path always
      // means the primary one, so a file from a sibling folder travels by its
      // absolute path and the file view switches to that folder (ADR 0263).
      const primary = match.projectRoot ? match.projectRoot.primary : true;
      return {
        path: primary ? match.relativePath : match.absolutePath,
        absolutePath: match.absolutePath,
        relativePath: match.relativePath,
        inProject: true,
        primary,
      };
    },
    [sessionId, showToast, t, workspacePath],
  );
}

/**
 * Open a file reference the conversation mentioned.
 *
 * A workspace `.html` page in the primary folder stays with the side browser
 * (ADR 0163): it is a page to run, not a file to read. A project file opens in
 * the bundled file view when that view is installed and on the host file tab
 * otherwise; scratch and attachment files live outside the project and always
 * take the host file tab.
 */
export function useOpenChatFileRef() {
  const resolveRef = useResolveChatFileRef();
  const pluginViews = useAppStore((s) => s.pluginViews);
  const openFile = useAppStore((s) => s.openFileInWorkPanel);
  const openUrl = useAppStore((s) => s.openUrlInWorkPanel);
  const openTab = useAppStore((s) => s.openWorkPanelTab);

  const fileViewAvailable = useMemo(
    () => hasPluginView(pluginViews, FILE_MANAGER_PLUGIN_TAB),
    [pluginViews],
  );

  return useCallback(
    (path: string, baseDir?: string, mimeType?: string) => {
      void (async () => {
        const resolved = await resolveRef(path, baseDir);
        if (!resolved) return;
        if (
          resolved.inProject &&
          resolved.primary &&
          resolved.relativePath &&
          isHtmlFilePath(resolved.relativePath)
        ) {
          openUrl(resolved.relativePath);
          return;
        }
        if (resolved.inProject && fileViewAvailable) {
          openTab(fileManagerPluginTab(resolved.path));
          return;
        }
        openFile(resolved.path, mimeType);
      })();
    },
    [fileViewAvailable, openFile, openTab, openUrl, resolveRef],
  );
}

/**
 * Show a file reference in the system file manager.
 *
 * It travels through the same completion and the same address rule a click
 * uses (`useOpenChatFileRef`), so a right-click never reveals a differently
 * named file that happens to sit in the same folder: a reference that matched
 * nothing says so instead.
 */
export function useRevealChatFileRef() {
  const { t } = useTranslation();
  const resolveRef = useResolveChatFileRef();
  const showToast = useAppStore((s) => s.showToast);

  return useCallback(
    (path: string, baseDir?: string) => {
      void (async () => {
        const resolved = await resolveRef(path, baseDir);
        if (!resolved) return;
        try {
          await api.fsReveal(resolved.path);
        } catch {
          showToast(t("chat.fileRevealFailed"), { variant: "error" });
        }
      })();
    },
    [resolveRef, showToast, t],
  );
}

/**
 * Copy a reference as an address a user can paste somewhere else.
 *
 * "Full" is the absolute path, the one spelling that resolves from any working
 * directory. "Relative" is the project-relative spelling, and only a file
 * inside the open project has one: a scratch or attachment file says so
 * instead of handing back an absolute path under a name that promises
 * something else.
 */
export function useCopyChatFileRef() {
  const { t } = useTranslation();
  const resolveRef = useResolveChatFileRef();
  const showToast = useAppStore((s) => s.showToast);

  return useCallback(
    (
      path: string,
      baseDir: string | undefined,
      kind: "absolute" | "relative",
    ) => {
      void (async () => {
        const resolved = await resolveRef(path, baseDir);
        if (!resolved) return;
        const value =
          kind === "absolute" ? resolved.absolutePath : resolved.relativePath;
        if (!value) {
          showToast(t("chat.relativePathUnavailable"), { variant: "error" });
          return;
        }
        try {
          await navigator.clipboard.writeText(value);
          showToast(t("chat.copied"), { variant: "success" });
        } catch {
          showToast(t("chat.copyFailed"), { variant: "error" });
        }
      })();
    },
    [resolveRef, showToast, t],
  );
}
