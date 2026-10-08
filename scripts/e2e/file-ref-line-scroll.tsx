import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { IPC } from "@pi-desktop/shared";
import { catalogs, flattenCatalog } from "@pi-desktop/i18n";
import { Markdown } from "../../apps/desktop/src/components/Markdown";
import { FilesTab } from "../../apps/desktop/src/components/workpanel/FilesTab";
import { LinkifiedText } from "../../apps/desktop/src/features/chat/transcript/shared";
import { useAppStore } from "../../apps/desktop/src/stores/app-store";
import { splitChatText } from "../../apps/desktop/src/lib/chat-links";

const targetPath = "src/scroll-target.txt";
const targetLine = 65;
const content = Array.from({ length: 90 }, (_, index) => `line ${index + 1}`).join("\n");
const resolveRefs: string[] = [];
const readPaths: string[] = [];
const scrollCalls: Array<{ line: string | undefined; block?: string }> = [];
const pluginEnableCalls: string[] = [];
let pluginViews: Array<{ pluginId: string; viewId: string }> = [];
let fileManagerPlugin = {
  id: "pi.file-manager",
  bundled: true,
  enabled: false,
  permissions: ["ui.view"],
  scope: { mode: "global", projects: [] as string[] },
};

window.piDesktop = {
  platform: "darwin",
  channels: IPC,
  on: () => () => {},
  async invoke(channel, ...args) {
    const input = args[0] as Record<string, unknown> | undefined;
    if (channel === IPC.invoke.fsResolveRef) {
      const ref = String(input?.ref ?? "");
      resolveRefs.push(ref);
      const relativePath = ref === "核查报告.md" ? ref : targetPath;
      return {
        ok: true,
        data: {
          match: {
            root: "workspace",
            relativePath,
            absolutePath: `/workspace/${relativePath}`,
            matchedBy: "exact-relative",
            projectRoot: { path: "/workspace", name: "Fixture", primary: true },
          },
        },
      };
    }
    if (channel === IPC.invoke.pluginViews) {
      return { ok: true, data: pluginViews };
    }
    if (channel === IPC.invoke.pluginList) {
      return { ok: true, data: { plugins: [fileManagerPlugin] } };
    }
    if (channel === IPC.invoke.pluginEnable) {
      const pluginId = String(args[0] ?? "");
      pluginEnableCalls.push(pluginId);
      fileManagerPlugin = { ...fileManagerPlugin, enabled: true };
      pluginViews = [{ pluginId, viewId: "manager" }];
      return { ok: true, data: undefined };
    }
    if (channel === IPC.invoke.fsList) {
      return { ok: true, data: { entries: [] } };
    }
    if (channel === IPC.invoke.fsRead) {
      const path = String(input?.path ?? "");
      readPaths.push(path);
      return { ok: true, data: { kind: "text", content, size: content.length } };
    }
    throw new Error(`Unexpected file viewer IPC: ${channel}`);
  },
};

useAppStore.setState({
  workspace: { path: "/workspace", name: "Fixture" },
  activeSessionId: "fixture-session",
  pluginViews: [],
  workPanelOpen: false,
  workPanelTabs: [],
  activeWorkPanelTabId: null,
  workPanelFileRequest: null,
});

const nativeScrollIntoView = HTMLElement.prototype.scrollIntoView;
if (!nativeScrollIntoView) throw new Error("Chromium scrollIntoView is unavailable");
HTMLElement.prototype.scrollIntoView = function (options?: ScrollIntoViewOptions) {
  scrollCalls.push({
    line: this.getAttribute("data-line") ?? undefined,
    block: options?.block,
  });
  nativeScrollIntoView.call(this, options);
};

const i18n = createInstance();
void i18n
  .use(initReactI18next)
  .init({
    lng: "en",
    fallbackLng: "en",
    keySeparator: false,
    resources: { en: { translation: flattenCatalog(catalogs.en) } },
    interpolation: { escapeValue: false },
  })
  .then(() => {
    const root = createRoot(document.getElementById("root")!);
    flushSync(() =>
      root.render(
        <I18nextProvider i18n={i18n}>
          <div className="fixture-chat">
            <LinkifiedText text={`Review ${targetPath}:${targetLine}:4.`} />
          </div>
          <div className="fixture-markdown">
            <Markdown source="[核查报告.md](核查报告.md)" renderDiagrams={false} />
          </div>
          <FilesTab />
        </I18nextProvider>,
      ),
    );

    window.fileRefLineScrollProbe = async () => {
      const until = async (predicate: () => boolean, label: string) => {
        for (let frame = 0; frame < 180; frame++) {
          if (predicate()) return true;
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
        return false;
      };

      const markdownLink = document.querySelector<HTMLAnchorElement>(
        ".fixture-markdown a",
      );
      if (!markdownLink) throw new Error("Markdown file link did not render");
      markdownLink.click();
      const managerStarted = await until(
        () =>
          pluginEnableCalls.length === 1 &&
          useAppStore.getState().workPanelTabs.some(
            (tab) => tab.id === "plugin:pi.file-manager/manager",
          ),
        "on-demand File Manager tab",
      );
      if (!managerStarted) {
        throw new Error(
          `Markdown click did not start the File Manager: ${JSON.stringify({
            pluginEnableCalls,
            workPanelTabs: useAppStore.getState().workPanelTabs,
          })}`,
        );
      }
      const fileManagerTab = useAppStore.getState().workPanelTabs.find(
        (tab) => tab.id === "plugin:pi.file-manager/manager",
      );

      if (!(await until(
        () => Boolean(document.querySelector<HTMLButtonElement>(".chat-file-chip")),
        "verified transcript chip",
      ))) throw new Error("The verified file reference chip did not render");
      document.querySelector<HTMLButtonElement>(".chat-file-chip")!.click();
      if (!(await until(
        () => Boolean(document.querySelector(".file-viewer-path")) && readPaths.length > 0,
        "host viewer file load",
      ))) throw new Error(`Host file viewer did not load: ${JSON.stringify({ resolveRefs, readPaths, request: useAppStore.getState().workPanelFileRequest })}`);
      await until(() => scrollCalls.length > 0, "host viewer line scroll");

      const viewer = document.querySelector<HTMLElement>(".file-viewer-body");
      const line = viewer?.querySelector<HTMLElement>(`[data-line="${targetLine}"]`);
      if (!viewer || !line) throw new Error("The requested source line was not rendered");
      const viewerRect = viewer.getBoundingClientRect();
      const lineRect = line.getBoundingClientRect();
      const request = useAppStore.getState().workPanelFileRequest;
      return {
        fileManagerAvailable: useAppStore.getState().pluginViews.some(
          (view) => view.pluginId === "pi.file-manager" && view.viewId === "manager",
        ),
        pluginEnableCalls,
        fileManagerLocation: fileManagerTab?.location ?? null,
        selectedPath: document.querySelector(".file-viewer-path")?.textContent,
        segments: splitChatText(`Review ${targetPath}:${targetLine}:4.`, "/workspace"),
        resolveRefs,
        readPaths,
        request,
        scrollCall: scrollCalls.at(-1) ?? null,
        scrollTop: viewer.scrollTop,
        targetLineVisible: lineRect.top >= viewerRect.top && lineRect.bottom <= viewerRect.bottom,
      };
    };
  })
  .catch((error: unknown) => {
    console.error(error);
    throw error;
  });

declare global {
  interface Window {
    piDesktop?: {
      platform: NodeJS.Platform;
      channels: typeof IPC;
      on: (channel: string, listener: (...args: unknown[]) => void) => () => void;
      invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
    };
    fileRefLineScrollProbe: () => Promise<{
      fileManagerAvailable: boolean;
      pluginEnableCalls: string[];
      fileManagerLocation: string | null;
      selectedPath: string | null | undefined;
      segments: unknown[];
      resolveRefs: string[];
      readPaths: string[];
      request: { path: string; line?: number; column?: number } | null;
      scrollCall: { line: string | undefined; block?: string } | undefined;
      scrollTop: number;
      targetLineVisible: boolean;
    }>;
  }
}
