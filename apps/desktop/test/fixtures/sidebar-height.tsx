import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { Sidebar } from "../../src/components/Sidebar";
import { useAppStore } from "../../src/stores/app-store";
import "../../src/styles/globals.css";

async function renderSidebar() {
  await i18n.use(initReactI18next).init({
    lng: "en",
    resources: { en: { translation: { nav: { recentSessions: "Recent sessions" } } } },
  });

  const projectPath = "/fixture/project";
  const calls: string[] = [];
  const sessions = Array.from({ length: 19 }, (_, index) => {
    const date = new Date(Date.UTC(2026, 0, 1, 0, 19 - index)).toISOString();
    return {
      id: `session-${index}`,
      title: `Session ${index}`,
      projectPath,
      createdAt: date,
      updatedAt: date,
    };
  });
  useAppStore.setState({
    page: "chat",
    sessions,
    openProjectPaths: [projectPath],
    sessionMeta: { "session-0": { pinned: true } },
    prefetchSession: async () => {},
    selectSession: async (id) => { calls.push(id); },
  });
  const root = createRoot(document.getElementById("root")!);
  flushSync(() => root.render(
    <div className="app-shell">
      <div className="app-shell-body">
        <Sidebar
          sidebarWidth={280}
          sidebarToggleShortcut=""
          onToggleSidebar={() => {}}
          onNewTask={() => {}}
          onWidthChange={() => {}}
          onWidthCommit={() => {}}
          onResizeCollapse={() => {}}
        />
      </div>
    </div>,
  ));
  return {
    calls,
    showMorePins() {
      const pins = [sessions[0], ...sessions.slice(-6)];
      useAppStore.setState({
        sessionMeta: Object.fromEntries(pins.map(({ id }) => [id, { pinned: true }])),
      });
    },
  };
}

Object.assign(window, { sidebarProbe: renderSidebar() });
