/**
 * Capture-rig fixtures for the screenshot suite (electron/main, driven by
 * `PI_DESKTOP_CAPTURE=1`). Nothing here ships on the production code path:
 * `renderer-api.ts` only `import()`s this module the first time a fixture
 * method is called while `window.__PI_CAPTURE__` is set.
 *
 * Every method still checks `__PI_CAPTURE__` itself because several seed
 * fixtures are destructive (they replace transcript, sessions, or
 * monkey-patch `api.*` list calls) and must never run from a stray call.
 */
import type {
  McpServerRecord,
  McpServerStatus,
  PluginSummary,
  PluginTheme,
  ProjectRecord,
  SubagentDefinition,
  UserSkillRecord,
  UserSubagentRecord,
} from "@pi-desktop/shared";
import { useAppStore } from "../stores/app-store";
import { api } from "../lib/api";
import { browserPluginTab, toolWorkPanelTab } from "../lib/work-panel-tabs";

export type CaptureRigMethods = {
  openWorkPanelArtifact: (
    kind: "review" | "browser" | "file",
    resource?: string,
  ) => void;
  collapseWorkPanel: () => void;
  openWorkPanel: () => void;
  openNewWorkPanelTab: () => void;
  setWorkPanelWidth: (width: number) => void;
  seedTranscript: (count?: number) => void;
  seedReviewChanges: (count?: number) => void;
  seedRunRows: (count?: number) => void;
  seedDelegationRows: (count?: number) => void;
  seedPlugins: (count?: number) => void;
  seedExtensions: (count?: number) => void;
  seedPluginThemes: (count?: number) => void;
  seedNotifications: (count?: number) => void;
  seedSidebarStatuses: () => {
    selected: string;
    running: string;
    completed: string;
    failed: string;
  } | null;
  ensureVisualFixtures: () => Promise<void>;
};

export type CaptureRig = CaptureRigMethods & {
  /** Restores every store action and `api.*` call the fixtures replaced. */
  dispose: () => void;
};

export function installCaptureRig(): CaptureRig {
  const originalRefreshNotifications =
    useAppStore.getState().refreshNotifications;
  const originalListPluginServices = api.listPluginServices;
  const originalMarketSearch = api.marketSearch;
  const originalMarketDetail = api.marketGetDetail;
  const originalListMcpServers = api.listMcpServers;
  const originalListUserSkills = api.listUserSkills;
  const originalListUserSubagents = api.listUserSubagents;
  const originalSubagentCatalog = api.subagentCatalog;
  const originalListProjects = api.listProjects;
  const methods: CaptureRigMethods = {
    openWorkPanelArtifact: (
      kind: "review" | "browser" | "file",
      resource?: string,
    ) => {
      if (!window.__PI_CAPTURE__) return;
      if (kind === "file" && resource) {
        useAppStore.getState().openFileInWorkPanel(resource);
        return;
      }
      if (kind === "browser") {
        useAppStore.getState().openWorkPanelTab(browserPluginTab(resource));
        return;
      }
      if (kind === "review") {
        useAppStore.getState().openWorkPanelTab(toolWorkPanelTab("review"));
      }
    },
    collapseWorkPanel: () => {
      if (!window.__PI_CAPTURE__) return;
      useAppStore.getState().collapseWorkPanel();
    },
    /**
     * Reveals the panel with whatever tabs the session already has — none, in
     * the capture suite, which is the point: this is how the no-resource
     * empty body is photographed. Production reaches it via `Cmd/Ctrl+J`.
     */
    openWorkPanel: () => {
      if (!window.__PI_CAPTURE__) return;
      useAppStore.getState().openWorkPanel();
    },
    openNewWorkPanelTab: () => {
      if (!window.__PI_CAPTURE__) return;
      useAppStore.getState().openNewWorkPanelTab();
    },
    setWorkPanelWidth: (width) => {
      if (!window.__PI_CAPTURE__) return;
      useAppStore.getState().setWorkPanelWidth(width);
    },
    seedTranscript: (count = 12) => {
      // Capture-only transcript fixture (conversation minimap scenes);
      // count 0 restores the empty transcript for later scenes.
      if (!window.__PI_CAPTURE__) return;
      if (count <= 0) {
        useAppStore.setState({ messages: [] });
        return;
      }
      const base = Date.parse("2026-07-20T09:00:00Z");
      const samples: [role: "user" | "assistant", content: string][] = [
        ["user", "帮我配置一下这个项目并启动"],
        [
          "assistant",
          "好的。先安装依赖并生成本地配置：\n\n1. `pnpm install`\n2. 复制 `.env.example` 为 `.env`\n3. `pnpm dev` 启动开发服务\n\n启动后默认监听 5173 端口。",
        ],
        ["user", "启动报错了，说找不到 host 二进制"],
        [
          "assistant",
          "这是因为 Rust 侧还没编译。运行 `cargo build -p pi-desktop-host-core`，产物会出现在 `target/debug/` 下，Electron 主进程会自动拾取。",
        ],
        ["user", "编译通过了，界面也起来了"],
        [
          "assistant",
          "很好。接下来可以在设置里添加模型提供方并保存 API 密钥，然后打开一个项目文件夹就能开始对话了。",
        ],
        ["user", "顺便把侧边栏最近会话按项目分组"],
        [
          "assistant",
          "已按项目路径分组：每组显示项目名与最近活动时间，未关联项目的会话归入“临时会话”。分组逻辑在 `sidebar-session-groups.ts`。",
        ],
        ["user", "分组标题的字号再小一点"],
        [
          "assistant",
          "已把分组标题从 `--text-sm` 调整为 `--text-2xs`，同时收紧了上下间距，现在与 PI-Desktop 的密度一致。",
        ],
        ["user", "最后跑一遍检查"],
        [
          "assistant",
          "`pnpm typecheck` 与样式令牌检查均通过，无回归。",
        ],
      ];
      const messages = Array.from(
        { length: Math.min(count, samples.length) },
        (_, i) => ({
          id: `capture-msg-${i}`,
          role: samples[i][0],
          content: samples[i][1],
          createdAt: new Date(base + i * 60_000).toISOString(),
          status: "complete" as const,
        }),
      );
      useAppStore.setState({ messages });
    },
    seedReviewChanges: (count = 4) => {
      // Capture-only review fixture (inline change rows + Review tab scenes).
      // The Review tab reads the session transcript, so the fixture is a set
      // of successful workspace Write/Edit tool messages carrying
      // `details.review`; count 0 restores the empty transcript.
      if (!window.__PI_CAPTURE__) return;
      if (count <= 0) {
        useAppStore.setState({ messages: [] });
        return;
      }
      const base = Date.parse("2026-08-14T09:00:00Z");
      const samples = [
        {
          tool: "Edit",
          path: "apps/desktop/src/components/workpanel/ReviewTab.tsx",
          operation: "edit",
          status: "modified",
          state: "active",
          additions: 4,
          deletions: 6,
          hunks: [
            {
              header: "@@ -25,9 +25,7 @@",
              lines: [
                { type: "context", text: '    <div className="review-toolbar">' },
                { type: "del", text: '      <span className="review-toolbar-icon">' },
                { type: "del", text: "        <IconDiff size={14} />" },
                { type: "del", text: "      </span>" },
                { type: "add", text: '      <span className="review-summary">' },
              ],
            },
          ],
        },
        {
          tool: "Write",
          path: "apps/desktop/src/lib/review-row-metrics.ts",
          operation: "write",
          status: "added",
          state: "active",
          additions: 12,
          deletions: 0,
          hunks: [
            {
              header: "@@ -0,0 +1,12 @@",
              lines: [
                { type: "add", text: "export const REVIEW_ROW_HEIGHT = 24;" },
                { type: "add", text: "export const REVIEW_MARK_WIDTH = 10;" },
              ],
            },
          ],
        },
        {
          tool: "Edit",
          path: "apps/desktop/src/styles/work-panel.css",
          operation: "edit",
          status: "deleted",
          state: "active",
          additions: 0,
          deletions: 9,
          hunks: [
            {
              header: "@@ -528,9 +528,0 @@",
              lines: [
                { type: "del", text: ".diff-file {" },
                { type: "del", text: "  border: 1px solid var(--ds-border-subtle);" },
                { type: "del", text: "}" },
              ],
            },
          ],
        },
        {
          tool: "Edit",
          path: "apps/desktop/src/styles/messages.css",
          operation: "edit",
          status: "modified",
          state: "rolledBack",
          additions: 3,
          deletions: 2,
          hunks: [
            {
              header: "@@ -269,4 +269,5 @@",
              lines: [
                { type: "context", text: ".review-change-card {" },
                { type: "del", text: "  border-radius: var(--radius-md);" },
                { type: "add", text: "  margin: 0 0 2px 24px;" },
              ],
            },
          ],
        },
      ];
      const messages = samples.slice(0, Math.min(count, samples.length)).flatMap(
        (sample, i) => [
          {
            id: `capture-review-user-${i}`,
            role: "user" as const,
            content:
              i === 0 ? "把审阅面板里每条改动的样式简化一下" : `继续第 ${i + 1} 处`,
            createdAt: new Date(base + i * 120_000).toISOString(),
            status: "complete" as const,
          },
          {
            id: `capture-review-${i}`,
            role: "tool" as const,
            content: "",
            createdAt: new Date(base + i * 120_000 + 30_000).toISOString(),
            toolName: sample.tool,
            toolStatus: "success" as const,
            toolArgs: { path: sample.path },
            toolResult: {
              details: {
                root: "workspace",
                review: {
                  version: 1,
                  snapshotId: `capture-snapshot-${i}`,
                  messageId: `capture-review-${i}`,
                  path: sample.path,
                  operation: sample.operation,
                  status: sample.status,
                  state: sample.state,
                  additions: sample.additions,
                  deletions: sample.deletions,
                  hunks: sample.hunks,
                  reversible: true,
                },
              },
            },
          },
        ],
      );
      useAppStore.setState({ messages: messages as any });
    },
    seedRunRows: (count = 3) => {
      // Capture-only run-row fixture (D226/D227 head scenes). A Bash tool
      // message per state: a command that exits 1 while its call reports
      // success — the case the head must not read as done (D227) — a success
      // with output, and one still running; count 0 restores the empty
      // transcript.
      if (!window.__PI_CAPTURE__) return;
      if (count <= 0) {
        useAppStore.setState({ messages: [] });
        return;
      }
      const base = Date.parse("2026-08-14T09:00:00Z");
      const samples = [
        {
          command: "pnpm test",
          status: "success" as const,
          details: {
            exitCode: 1,
            stdout: "desktop test 648 tests\n",
            stderr: "1 failing: run head keeps its caret\n",
          },
        },
        {
          command: "git log --oneline -6",
          status: "success" as const,
          details: {
            exitCode: 0,
            stdout: [
              "78cc1f3 test(desktop): photograph the panel's empty state",
              "df88040 docs(spec): record the no-resource empty state",
              "f81fb94 fix(desktop): give the work panel a real empty state",
              "6c8b2f0 feat(work-panel): toggle work panel visibility",
              "8f09cf9 refactor(desktop): flatten review change rows",
              "e408d88 fix(desktop): keep macOS in the Dock and Cmd+Tab",
            ].join("\n"),
            stderr: "",
          },
        },
        {
          command: "pnpm --filter @pi-desktop/desktop build",
          status: "running" as const,
          details: undefined,
        },
      ];
      const messages = samples.slice(0, Math.min(count, samples.length)).flatMap(
        (sample, i) => [
          {
            id: `capture-run-user-${i}`,
            role: "user" as const,
            content: i === 0 ? "跑一下测试" : `再跑 ${sample.command}`,
            createdAt: new Date(base + i * 120_000).toISOString(),
            status: "complete" as const,
          },
          {
            id: `capture-run-${i}`,
            role: "tool" as const,
            content: "",
            createdAt: new Date(base + i * 120_000 + 30_000).toISOString(),
            toolName: "Bash",
            toolStatus: sample.status,
            toolArgs: { command: sample.command },
            ...(sample.details ? { toolResult: { details: sample.details } } : {}),
          },
        ],
      );
      useAppStore.setState({ messages: messages as any });
    },
    seedDelegationRows: (count = 3) => {
      // Capture-only delegation fixture. One `Task` and a two-`Task` fan-out
      // in the same transcript, so the scene shows that a lone delegation now
      // gets the same card as a fan-out; count 0 restores the empty
      // transcript.
      if (!window.__PI_CAPTURE__) return;
      if (count <= 0) {
        useAppStore.setState({ messages: [] });
        return;
      }
      const base = Date.parse("2026-08-14T09:00:00Z");
      const delegation = (
        index: number,
        agent: string,
        description: string,
        status: string,
        runtimeMs: number,
      ) => ({
        id: `capture-task-${index}`,
        role: "tool" as const,
        content: "",
        createdAt: new Date(base + index * 60_000).toISOString(),
        toolName: "Task",
        toolCallId: `capture-call-${index}`,
        toolStatus: status === "running" ? "running" : "success",
        toolArgs: { agent, description, task: description },
        toolResult: {
          details: {
            delegationId: `capture-delegation-${index}`,
            status,
            // A running node ticks from `startedAt`, so a fixed fixture start
            // would render the days since the fixture date. Settled nodes take
            // their runtime from the pair.
            ...(status === "running"
              ? {}
              : {
                  startedAt: base + index * 60_000,
                  completedAt: base + index * 60_000 + runtimeMs,
                }),
            turns: 4,
            toolCalls: 9,
          },
        },
      });
      const delegateRow = (index: number, agent: string, path: string) => ({
        id: `capture-task-${index}-step`,
        role: "tool" as const,
        content: "",
        createdAt: new Date(base + index * 60_000 + 5_000).toISOString(),
        toolName: "Read",
        toolCallId: `capture-call-${index}-step`,
        toolStatus: "success" as const,
        toolArgs: { file_path: path },
        parentToolCallId: `capture-call-${index}`,
        agentName: agent,
      });
      const messages = [
        {
          id: "capture-task-user-0",
          role: "user" as const,
          content: "帮我审一下 store 的改动",
          createdAt: new Date(base - 30_000).toISOString(),
          status: "complete" as const,
        },
        delegation(0, "code-reviewer", "check the store diff", "completed", 32_000),
        delegateRow(0, "code-reviewer", "apps/desktop/src/stores/app-store.ts"),
        {
          id: "capture-task-answer-0",
          role: "assistant" as const,
          content: "审阅完成：队列按 id 丢弃请求，没有发现回归。",
          createdAt: new Date(base + 40_000).toISOString(),
          status: "complete" as const,
        },
        {
          id: "capture-task-user-1",
          role: "user" as const,
          content: "再并行看下 runtime 和 shared",
          createdAt: new Date(base + 55_000).toISOString(),
          status: "complete" as const,
        },
        delegation(1, "code-reviewer", "audit agent-runtime", "completed", 48_000),
        delegateRow(1, "code-reviewer", "packages/agent-runtime/src/runtime.ts"),
        delegation(2, "explorer", "map the shared protocol", "running", 0),
      ];
      useAppStore.setState({ messages: messages as any });
    },
    seedPlugins: (count = 4) => {
      // Capture-only plugins fixture (plugins index scenes); count 0 clears.
      // One sample per row group so the D169 bands are all exercised, and one
      // sample per new contribution kind so the capability/service chips do.
      if (!window.__PI_CAPTURE__) return;
      if (count <= 0) {
        useAppStore.setState({ plugins: [] });
        (api as any).listPluginServices = originalListPluginServices;
        (api as any).marketSearch = originalMarketSearch;
        (api as any).marketGetDetail = originalMarketDetail;
        return;
      }
      (api as any).marketGetDetail = async (id: string) => ({
        plugin: {
          id,
          name: "Git Insights",
          description: "Summarizes repository activity into a review panel.",
          author: "Pi Labs",
          latestVersion: "1.5.0",
          downloads: 12840,
          updatedAt: "2026-08-21T09:00:00.000Z",
          categories: ["productivity"],
          permissionSummary: ["fs.read", "fs.write", "ui.panel", "notify"],
          permissions: ["fs.read", "fs.write", "ui.panel", "notify"],
          verified: true,
          trust: "verified",
          installed: true,
          installedVersion: "1.4.2",
          updateAvailable: true,
          installable: true,
          homepage: "https://example.invalid/git-insights",
          repository: "https://github.com/example/git-insights",
          safetyNotes: "Writes only under docs/ and Markdown files in the workspace.",
          readmeMarkdown: "# Git Insights\n\nA review panel for repository activity.",
          versions: [
            {
              version: "1.5.0",
              publishedAt: "2026-08-21T09:00:00.000Z",
              changelog: "Adds a per-author heatmap.",
              shasum: "capture",
              url: "https://example.invalid/git-insights-1.5.0.piplug",
              size: 48210,
            },
            {
              version: "1.4.2",
              publishedAt: "2026-07-02T09:00:00.000Z",
              changelog: "Fixes a stale cache after branch switches.",
              shasum: "capture",
              url: "https://example.invalid/git-insights-1.4.2.piplug",
              size: 47100,
            },
          ],
        },
      });
      // The marketplace tab searches the catalog over IPC, which is offline
      // in the capture rig; stand in with a card per trust tier and state.
      (api as any).marketSearch = async () => ({
        plugins: [
          {
            id: "pi.git-insights",
            name: "Git Insights",
            description: "Summarizes repository activity into a review panel.",
            author: "Pi Labs",
            latestVersion: "1.5.0",
            downloads: 12840,
            updatedAt: "2026-08-21T09:00:00.000Z",
            categories: ["productivity"],
            permissionSummary: ["fs.read", "fs.write", "ui.panel"],
            verified: true,
            trust: "verified",
            installed: true,
            installedVersion: "1.4.2",
            updateAvailable: true,
            installable: true,
          },
          {
            id: "pi.markdown-tools",
            name: "Markdown Tools",
            description: "Formats tables and normalizes headings on demand.",
            author: "Community",
            latestVersion: "0.9.0",
            downloads: 3210,
            updatedAt: "2026-07-30T09:00:00.000Z",
            categories: ["editing"],
            permissionSummary: ["clipboard.read", "clipboard.write"],
            trust: "community",
            installed: true,
            installedVersion: "0.9.0",
            installable: true,
          },
          {
            id: "pi.deploy-preview",
            name: "Deploy Preview",
            description:
              "Builds a preview deployment for the current branch and links it in the transcript.",
            author: "Pi Labs",
            latestVersion: "0.4.1",
            downloads: 980,
            updatedAt: "2026-08-02T09:00:00.000Z",
            categories: ["productivity"],
            permissionSummary: ["net.fetch", "ui.panel"],
            verified: true,
            trust: "verified",
            installable: true,
          },
          {
            id: "pi.sql-explorer",
            name: "SQL Explorer",
            description: "Browse local databases and paste query results into chat.",
            author: "Data Tools",
            latestVersion: "2.1.0",
            downloads: 5602,
            updatedAt: "2026-08-15T09:00:00.000Z",
            categories: ["data"],
            permissionSummary: ["fs.read", "process.spawn"],
            trust: "community",
            installable: false,
          },
        ],
      });
      // The rows read service state straight from IPC, which reports nothing
      // for a fixture plugin; stand in for the supervisor here.
      (api as any).listPluginServices = async () => [
        {
          pluginId: "pi.git-insights",
          serviceId: "indexer",
          label: "Repository indexer",
          state: "running",
          restarts: 0,
        },
        {
          pluginId: "pi.markdown-tools",
          serviceId: "watcher",
          label: "Document watcher",
          state: "failed",
          restarts: 3,
          message: "start() threw: ENOENT",
        },
      ];
      const samples: PluginSummary[] = [
        {
          id: "pi.deploy-preview",
          name: "Deploy Preview",
          version: "0.4.1",
          enabled: true,
          source: "installed",
          status: "load_error",
          errorMessage: "Manifest declares net.fetch but the grant is missing.",
          permissions: ["net.fetch", "ui.panel"],
          capabilities: ["panel", "tools", "mcp"],
          author: "Pi Labs",
          description: "Builds a preview deployment for the current branch.",
        },
        {
          id: "pi.git-insights",
          name: "Git Insights",
          version: "1.4.2",
          enabled: true,
          source: "marketplace",
          status: "ready",
          permissions: ["fs.read", "fs.write", "ui.panel", "notify"],
          fs: {
            read: { root: "workspace", scope: ["**/*"] },
            write: { root: "workspace", scope: ["docs/**", "*.md"] },
          },
          capabilities: ["panel", "commands", "skills", "services", "bus"],
          author: "Pi Labs",
          description: "Summarizes repository activity into a review panel.",
          updateAvailable: {
            version: "1.5.0",
            shasum: "capture",
            url: "https://example.invalid/git-insights-1.5.0.piplug",
          },
        },
        {
          id: "pi.markdown-tools",
          name: "Markdown Tools",
          version: "0.9.0",
          enabled: true,
          source: "marketplace",
          status: "ready",
          permissions: ["clipboard.read", "clipboard.write", "ui.panel"],
          capabilities: ["commands", "themes", "services"],
          author: "Community",
          description: "Formats tables and normalizes headings on demand.",
          autoUpdate: true,
        },
        {
          id: "pi.scratchpad",
          name: "Scratchpad",
          version: "dev",
          enabled: false,
          source: "dev",
          status: "disabled",
          permissions: ["ui.panel"],
          author: "Local build",
          description: "A local panel for quick notes beside the transcript.",
        },
      ];
      useAppStore.setState({ plugins: samples.slice(0, count) });
    },
    seedExtensions: (count = 3) => {
      // Capture-only fixture for the Settings > Agent capability pages. Those
      // pages read
      // straight from IPC into local state rather than the store, so the rig
      // has to stand in for the host rather than seed a slice; count 0 puts
      // the real calls back.
      if (!window.__PI_CAPTURE__) return;
      if (count <= 0) {
        (api as any).listMcpServers = originalListMcpServers;
        (api as any).listUserSkills = originalListUserSkills;
        (api as any).listUserSubagents = originalListUserSubagents;
        (api as any).subagentCatalog = originalSubagentCatalog;
        (api as any).listProjects = originalListProjects;
        return;
      }
      const projects: ProjectRecord[] = [
        {
          id: 1,
          path: "/Users/pi/work/api",
          name: "api",
          pinned: true,
          createdAt: 0,
          lastOpenedAt: 0,
        },
        {
          id: 2,
          path: "/Users/pi/work/web",
          name: "web",
          pinned: false,
          createdAt: 0,
          lastOpenedAt: 0,
        },
        {
          id: 3,
          path: "/Users/pi/personal/site",
          name: "site",
          pinned: false,
          createdAt: 0,
          lastOpenedAt: 0,
        },
      ];
      // One server per connection state, so the row glyph's whole colour range
      // is exercised, and one per activation state.
      const stamp = "2026-08-04T09:00:00.000Z";
      const servers: McpServerRecord[] = (
        [
        {
          id: "context7",
          label: "Context7",
          level: "global",
          description: "Up-to-date library documentation.",
          transport: "stdio",
          command: "npx",
          args: ["-y", "@upstash/context7-mcp"],
          env: {},
          enabled: true,
          scope: { mode: "global", projects: [] },
        },
        {
          id: "linear",
          label: "Linear",
          level: "global",
          description: "Issues and cycles for the work tracker.",
          transport: "http",
          url: "https://mcp.linear.app/sse",
          headers: { Authorization: "Bearer •••" },
          enabled: true,
          scope: { mode: "projects", projects: ["/Users/pi/work/api"] },
        },
        {
          id: "postgres",
          label: "Postgres",
          level: "project",
          projectPath: "/Users/pi/work/api",
          description: "Runs read-only queries against the dev database.",
          transport: "stdio",
          command: "mcp-server-postgres",
          args: ["postgresql://localhost/dev"],
          env: {},
          enabled: true,
          scope: { mode: "projects", projects: [] },
        },
        {
          id: "figma",
          label: "Figma",
          level: "project",
          projectPath: "/Users/pi/work/api",
          description: "Reads frames and design tokens from a file.",
          transport: "stdio",
          command: "figma-mcp",
          args: [],
          env: {},
          enabled: false,
          scope: { mode: "global", projects: [] },
        },
        ] as Array<Omit<McpServerRecord, "createdAt" | "updatedAt">>
      ).map((server) => ({ ...server, createdAt: stamp, updatedAt: stamp }));
      const statuses: McpServerStatus[] = [
        {
          serverId: "context7",
          state: "ready",
          toolCount: 2,
          toolNames: ["resolve-library-id", "get-library-docs"],
          updatedAt: 0,
        },
        { serverId: "linear", state: "connecting", toolCount: 0, updatedAt: 0 },
        {
          serverId: "postgres",
          state: "failed",
          toolCount: 0,
          message: "spawn mcp-server-postgres ENOENT",
          updatedAt: 0,
        },
        { serverId: "figma", state: "idle", toolCount: 0, updatedAt: 0 },
      ];
      const skills: UserSkillRecord[] = [
        {
          id: "release-notes",
          name: "Release Notes",
          level: "global",
          description:
            "Turn a range of commits into release notes grouped by user-visible change.",
          enabled: true,
          scope: { mode: "global", projects: [] },
          source: "created",
          path: "/Users/pi/.agents/skills/release-notes/SKILL.md",
          sizeBytes: 2_412,
          createdAt: "2026-07-30T10:00:00.000Z",
          updatedAt: "2026-08-04T09:12:00.000Z",
        },
        {
          id: "api-review",
          name: "API Review",
          level: "project",
          projectPath: "/Users/pi/work/api",
          description:
            "Check a handler against the house rules for pagination, errors, and auth.",
          enabled: true,
          scope: { mode: "projects", projects: ["/Users/pi/work/api"] },
          source: "created",
          path: "/Users/pi/.agents/skills/api-review/SKILL.md",
          sizeBytes: 7_940,
          createdAt: "2026-07-12T10:00:00.000Z",
          updatedAt: "2026-08-01T16:30:00.000Z",
        },
        {
          id: "incident-writeup",
          name: "Incident Writeup",
          level: "global",
          description: "Draft a blameless postmortem from a timeline of events.",
          enabled: false,
          scope: { mode: "global", projects: [] },
          source: "imported",
          path: "/Users/pi/.agents/skills/incident-writeup/SKILL.md",
          sizeBytes: 118_400,
          createdAt: "2026-06-02T10:00:00.000Z",
          updatedAt: "2026-06-02T10:00:00.000Z",
        },
      ];
      // One global definition per state the row can report: active, customized,
      // builtin replacement, and turned off.
      const subagents: UserSubagentRecord[] = [
        {
          id: "log-reader",
          name: "log-reader",
          level: "global",
          description:
            "Read a build log end to end and report the first real failure with its file and line.",
          enabled: true,
          scope: { mode: "global", projects: [] },
          tools: ["Read", "Grep", "Bash"],
          maxTurns: 12,
          path: "/Users/pi/.agents/subagents/log-reader.md",
          sizeBytes: 1_840,
          createdAt: "2026-08-05T09:00:00.000Z",
          updatedAt: "2026-08-06T11:20:00.000Z",
        },
        {
          id: "schema-diff",
          name: "schema-diff",
          level: "global",
          description:
            "Compare the migration files on a branch against the committed schema and list what drifted.",
          enabled: true,
          scope: { mode: "global", projects: [] },
          tools: ["Read", "Glob", "Grep"],
          model: "anthropic/claude-haiku-4-5",
          thinkingLevel: "low",
          path: "/Users/pi/.agents/subagents/schema-diff.md",
          sizeBytes: 3_120,
          createdAt: "2026-07-28T09:00:00.000Z",
          updatedAt: "2026-08-02T14:05:00.000Z",
        },
        {
          id: "explorer",
          name: "explorer",
          level: "global",
          description: "My own explorer, with the repository's layout written into the prompt.",
          enabled: true,
          scope: { mode: "global", projects: [] },
          tools: ["Read", "Glob", "Grep"],
          maxTurns: 30,
          path: "/Users/pi/.agents/subagents/explorer.md",
          sizeBytes: 2_260,
          createdAt: "2026-08-01T09:00:00.000Z",
          updatedAt: "2026-08-01T09:00:00.000Z",
        },
        {
          id: "release-drafter",
          name: "release-drafter",
          level: "global",
          description: "Draft the release notes for a tag range, grouped by user-visible change.",
          enabled: false,
          scope: { mode: "global", projects: [] },
          tools: ["Read", "Grep"],
          path: "/Users/pi/.agents/subagents/release-drafter.md",
          sizeBytes: 980,
          createdAt: "2026-06-20T09:00:00.000Z",
          updatedAt: "2026-06-20T09:00:00.000Z",
        },
      ];
      // The effective catalog main would compute: global user documents replace
      // builtins by name, and the other builtins remain available.
      const catalog: SubagentDefinition[] = [
        {
          name: "log-reader",
          description: "A user-owned log reader, tuned for its CI output.",
          prompt: "You are log-reader.\n",
          tools: ["Read", "Grep"],
          maxTurns: 12,
          source: "user",
          filePath: "/Users/pi/.agents/subagents/log-reader.md",
        },
        {
          name: "explorer",
          description: "My own explorer, with the repository's layout written into the prompt.",
          prompt: "You are explorer.\n",
          tools: ["Read", "Glob", "Grep"],
          maxTurns: 30,
          source: "user",
          filePath: "/Users/pi/.agents/subagents/explorer.md",
        },
        {
          name: "code-reviewer",
          description:
            "Review a change for correctness, then report findings ranked by severity.",
          prompt: "You are code-reviewer.\n",
          tools: ["Read", "Glob", "Grep"],
          maxTurns: 24,
          source: "builtin",
        },
        {
          name: "test-runner",
          description: "Run the test suite, then report the first failure that is not flaky.",
          prompt: "You are test-runner.\n",
          tools: ["Read", "Glob", "Grep", "Bash"],
          maxTurns: 24,
          source: "builtin",
        },
      ];
      const rowsForQuery = <T extends { level?: string; projectPath?: string }>(
        rows: readonly T[],
        query: { level?: string; projectPath?: string } = {},
      ) =>
        rows.filter(
          (row) =>
            (!query.level || row.level === query.level) &&
            (!query.projectPath || !row.projectPath || row.projectPath === query.projectPath),
        );
      (api as any).listProjects = async () => ({ projects });
      (api as any).listMcpServers = async (query: { level?: string; projectPath?: string } = {}) => {
        const filtered = rowsForQuery(servers, query);
        return {
          servers: filtered,
          statuses: statuses.filter((status) => filtered.some((server) => server.id === status.serverId)),
        };
      };
      (api as any).listUserSkills = async (query: { level?: string; projectPath?: string } = {}) => ({
        skills: rowsForQuery(skills, query).slice(0, count),
      });
      (api as any).listUserSubagents = async () => ({ subagents });
      (api as any).subagentCatalog = async () => ({
        subagents: catalog,
        diagnostics: [],
        projectPath: "/Users/pi/work/api",
      });
    },
    seedPluginThemes: (count = 2) => {
      // Capture-only theme fixture: plugin themes share the built-in grid on
      // the general settings page, so the rig needs some to render.
      if (!window.__PI_CAPTURE__) return;
      if (count <= 0) {
        useAppStore.setState({ pluginThemes: [] });
        return;
      }
      const samples: PluginTheme[] = [
        {
          id: "plugin:pi.markdown-tools:midnight",
          pluginId: "pi.markdown-tools",
          themeId: "midnight",
          label: "Midnight",
          base: "dark",
          css: "",
        },
        {
          id: "plugin:pi.markdown-tools:parchment",
          pluginId: "pi.markdown-tools",
          themeId: "parchment",
          label: "Parchment",
          base: "light",
          css: "",
        },
      ];
      useAppStore.setState({ pluginThemes: samples.slice(0, count) });
    },
    seedNotifications: (count = 105) => {
      // Capture-only notification fixture; count 0 restores an empty inbox.
      if (!window.__PI_CAPTURE__) return;
      if (count <= 0) {
        useAppStore.setState({
          notifications: [],
          unreadNotificationCount: 0,
          refreshNotifications: originalRefreshNotifications,
        });
        return;
      }
      const now = Date.now();
      const titles = [
        "重新设计设置页面插件板块手机端 UI 布局并验证所有断点",
        "修复 host-core 启动失败并补充错误恢复测试",
        "同步代码",
      ];
      // The inbox lists failures only, so every fixture row is a failure.
      const notifications = Array.from({ length: count }, (_, index) => ({
        id: `capture-notification-${index}`,
        kind: "task.failed" as const,
        sessionId: `capture-session-${index}`,
        sessionTitle: titles[index] ?? `后台任务 ${index + 1}`,
        turnId: `capture-turn-${index}`,
        ...(index % 2 === 1 ? { errorCode: "MODEL_REQUEST_TIMEOUT" } : {}),
        createdAt: new Date(now - (index + 1) * 60_000).toISOString(),
        readAt: index === 2 ? new Date(now - 30_000).toISOString() : null,
      }));
      useAppStore.setState({
        notifications,
        unreadNotificationCount: notifications.reduce(
          (total, notification) => total + (notification.readAt ? 0 : 1),
          0,
        ),
        refreshNotifications: async () => undefined,
      });
    },
    seedSidebarStatuses: () => {
      if (!window.__PI_CAPTURE__) return null;
      const sessions = useAppStore.getState().sessions.slice(0, 4);
      if (sessions.length < 4) return null;
      const [selected, running, completed, failed] = sessions;
      useAppStore.setState({
        page: "chat",
        activeSessionId: selected.id,
        isRunning: false,
        runningSessions: { [running.id]: true },
        sessionOutcomes: {
          [completed.id]: "completed",
          [failed.id]: "failed",
        },
      });
      return {
        selected: selected.id,
        running: running.id,
        completed: completed.id,
        failed: failed.id,
      };
    },
    ensureVisualFixtures: async () => {
      // Destructive fixture seeding is capture-rig only; the rig sets
      // __PI_CAPTURE__ before invoking (see electron/main capture suite).
      if (!window.__PI_CAPTURE__) return;
      // Optical hero title length: short folder basenames under-ink vs Codex gold.
      const ws = useAppStore.getState().workspace;
      if (ws?.path) {
        const base = (ws.name || ws.path.split(/[\/]/).filter(Boolean).pop() || "").trim();
        if (base.length > 0 && base.length < 12) {
          useAppStore.setState({
            workspace: { ...ws, name: "PI-Desktop" },
          });
        }
      }
      // Seed representative session titles for capture residuals (data band).
      try {
        await useAppStore.getState().refreshSessions();
        const englishNoise = new Set([
          "Review open pull requests",
          "Tighten composer elevation",
          "Dark theme night plate",
          "Sidebar recents density",
          "Settings appearance polish",
          "Plugins empty state",
          "Fix TypeScript build errors",
          "Exploring repository structure",
        ]);
        for (const s of useAppStore.getState().sessions || []) {
          if (englishNoise.has((s.title || "").trim())) {
            try {
              await api.deleteSession(s.id);
            } catch {
              // ignore
            }
          }
        }
        await useAppStore.getState().refreshSessions();
        const existing = new Set(
          (useAppStore.getState().sessions || []).map((s) => (s.title || "").trim()),
        );
        const titles = [
          "同步代码",
          "你好",
          "终止进程里面有一个注册机的",
          "加一下",
          "帮我彻底卸载比特浏览器",
          "帮我配置一下这个项目并启动",
          "重新设计设置页面插件板块手机端ui布局",
          "制作台的布局重新设计，需要现代化简",
        ];
        for (const title of titles) {
          if (existing.has(title)) continue;
          if ((useAppStore.getState().sessions?.length ?? 0) >= 14) break;
          await api.createSession({ title });
          existing.add(title);
        }
        await useAppStore.getState().refreshSessions();
        const preferred = useAppStore
          .getState()
          .sessions.find((s) => (s.title || "").trim() === "同步代码");
        if (preferred) {
          try {
            const raw = localStorage.getItem("pi.desktop.pinnedSessions");
            const parsed = raw ? JSON.parse(raw) : [];
            const pins = Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
            if (!pins.includes(preferred.id)) {
              localStorage.setItem(
                "pi.desktop.pinnedSessions",
                JSON.stringify([preferred.id, ...pins].slice(0, 40)),
              );
            }
          } catch {
            // ignore
          }
          await useAppStore.getState().selectSession(preferred.id);
        }
      } catch {
        // optional capture-only fixture
      }
    },
  };
  return {
    ...methods,
    dispose: () => {
      useAppStore.setState({
        refreshNotifications: originalRefreshNotifications,
      });
      api.listPluginServices = originalListPluginServices;
      api.marketSearch = originalMarketSearch;
      api.marketGetDetail = originalMarketDetail;
      api.listMcpServers = originalListMcpServers;
      api.listUserSkills = originalListUserSkills;
      api.listUserSubagents = originalListUserSubagents;
      api.subagentCatalog = originalSubagentCatalog;
      api.listProjects = originalListProjects;
    },
  };
}
