import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import type { FsEntry, FsReadResult } from "@pi-desktop/shared";
import { useAppStore } from "../../stores/app-store";
import { api } from "../../lib/api";
import { Markdown } from "../Markdown";
import { fileDirOf } from "../../lib/chat-links";
import { cx } from "../ui";
import {
  ensureLang,
  getHighlightVersion,
  resolveLang,
  subscribeHighlighter,
  themeForMode,
  tokenizeIncremental,
  type LineCache,
} from "../../lib/shiki";
import {
  IconChevronLeft,
  IconChevronRight,
  IconExternal,
  IconFileText,
  IconFolder,
} from "../icons";
import { WorkTabEmpty } from "./WorkTabEmpty";

const VIEWER_LINE_CAP = 5000;

const EXT_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  css: "css",
  html: "html",
  md: "markdown",
  rs: "rust",
  py: "python",
  go: "go",
  sh: "shellscript",
  zsh: "shellscript",
  bash: "shellscript",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  sql: "sql",
  swift: "swift",
  kt: "kotlin",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
};

function langForPath(path: string): string | null {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const lang = EXT_LANG[ext] ?? ext;
  return resolveLang(lang);
}

function isMarkdownPath(path: string): boolean {
  return /\.(?:md|markdown)$/i.test(path);
}

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function useThemeMode(): "light" | "dark" {
  return useSyncExternalStore(
    (notify) => {
      const observer = new MutationObserver(notify);
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-theme"],
      });
      return () => observer.disconnect();
    },
    () => (document.documentElement.dataset.theme === "light" ? "light" : "dark"),
  );
}

function HighlightedText({ path, content }: { path: string; content: string }) {
  const mode = useThemeMode();
  const highlightVersion = useSyncExternalStore(
    subscribeHighlighter,
    getHighlightVersion,
  );
  const lang = langForPath(path);
  const lines = useMemo(() => content.split("\n"), [content]);
  const capped = lines.length > VIEWER_LINE_CAP;
  const visible = useMemo(
    () => (capped ? lines.slice(0, VIEWER_LINE_CAP).join("\n") : content),
    [capped, lines, content],
  );

  const tokens = useMemo<LineCache | null>(() => {
    void highlightVersion;
    if (!lang) return null;
    ensureLang(lang);
    return tokenizeIncremental(null, visible, lang, themeForMode(mode));
  }, [lang, visible, mode, highlightVersion]);

  return (
    <pre className="file-viewer-code">
      {tokens
        ? tokens.tokens.map((row, i) => (
            <div className="file-viewer-line" key={i}>
              {row.length === 0
                ? "\n"
                : row.map((token, j) => (
                    <span key={j} style={{ color: token.color }}>
                      {token.content}
                    </span>
                  ))}
            </div>
          ))
        : visible.split("\n").map((line, i) => (
            <div className="file-viewer-line" key={i}>
              {line || "\n"}
            </div>
          ))}
      {capped && <div className="file-viewer-cap">…</div>}
    </pre>
  );
}

type DirState = { entries: FsEntry[]; error?: boolean };

// Module-level so a chat preview request fires once, not again on every
// files-tab remount (the tab unmounts when another tool is selected).
let handledFileRequestSeq = 0;

export function FilesTab() {
  const { t } = useTranslation();
  const workspace = useAppStore((s) => s.workspace);
  const fileRequest = useAppStore((s) => s.workPanelFileRequest);
  const root = workspace?.path ?? null;

  const [dirs, setDirs] = useState<Record<string, DirState>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [file, setFile] = useState<FsReadResult | null>(null);
  const [fileError, setFileError] = useState(false);

  // Workspace switches reset all browsing state. Guarded so it only fires on
  // an actual root change: an unconditional [root] effect also runs on the
  // StrictMode remount, wiping the selection a chat file request just made
  // (first click landed on the tree instead of the file).
  const prevRoot = useRef(root);
  useEffect(() => {
    if (prevRoot.current === root) return;
    prevRoot.current = root;
    setDirs({});
    setExpanded(new Set());
    setSelected(null);
    setFile(null);
    setFileError(false);
  }, [root]);

  const loadDir = useCallback(
    async (rel: string) => {
      if (!root) return;
      try {
        const res = await api.fsList(rel);
        setDirs((prev) => ({ ...prev, [rel]: { entries: res.entries } }));
      } catch {
        setDirs((prev) => ({ ...prev, [rel]: { entries: [], error: true } }));
      }
    },
    [root],
  );

  useEffect(() => {
    if (root && !dirs[""]) void loadDir("");
  }, [root, dirs, loadDir]);

  const toggleDir = useCallback(
    (rel: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(rel)) {
          next.delete(rel);
        } else {
          next.add(rel);
        }
        return next;
      });
      if (!dirs[rel]) void loadDir(rel);
    },
    [dirs, loadDir],
  );

  const openFile = useCallback(async (rel: string) => {
    setSelected(rel);
    setFile(null);
    setFileError(false);
    try {
      setFile(await api.fsRead(rel));
    } catch {
      setFileError(true);
    }
  }, []);

  // Chat-initiated previews: open the file and expand its ancestor folders
  // so "back" lands on a tree that reveals it.
  useEffect(() => {
    if (!fileRequest || !root) return;
    if (fileRequest.seq === handledFileRequestSeq) return;
    handledFileRequestSeq = fileRequest.seq;
    const parts = fileRequest.path.split("/").slice(0, -1);
    const ancestors: string[] = [];
    let acc = "";
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part;
      ancestors.push(acc);
    }
    setExpanded((prev) => new Set([...prev, ...ancestors]));
    for (const dir of ancestors) void loadDir(dir);
    void openFile(fileRequest.path);
  }, [fileRequest, root, loadDir, openFile]);

  const renderDir = (rel: string, depth: number): React.ReactNode => {
    const state = dirs[rel];
    if (!state) {
      return (
        <div
          className="file-tree-note"
          style={{ paddingLeft: 12 + depth * 14 }}
          key={`${rel}:loading`}
        >
          {t("panel.files.loading")}
        </div>
      );
    }
    if (state.entries.length === 0) {
      return (
        <div
          className="file-tree-note"
          style={{ paddingLeft: 12 + depth * 14 }}
          key={`${rel}:empty`}
        >
          {state.error ? t("panel.files.error") : t("panel.files.empty")}
        </div>
      );
    }
    return state.entries.map((entry) => {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.kind === "dir") {
        const open = expanded.has(childRel);
        return (
          <div key={childRel}>
            <button
              type="button"
              className="file-tree-row"
              style={{ paddingLeft: 12 + depth * 14 }}
              onClick={() => toggleDir(childRel)}
            >
              <span className={cx("file-tree-caret", open && "open")} aria-hidden>
                <IconChevronRight size={12} />
              </span>
              <IconFolder size={14} />
              <span className="file-tree-name">{entry.name}</span>
            </button>
            {open && renderDir(childRel, depth + 1)}
          </div>
        );
      }
      return (
        <button
          key={childRel}
          type="button"
          className={cx("file-tree-row", selected === childRel && "active")}
          style={{ paddingLeft: 12 + depth * 14 + 16 }}
          onClick={() => void openFile(childRel)}
          title={childRel}
        >
          <IconFileText size={14} />
          <span className="file-tree-name">{entry.name}</span>
        </button>
      );
    });
  };

  if (!root) {
    return (
      <WorkTabEmpty
        icon={IconFolder}
        title={t("panel.files.noWorkspace")}
        body={t("panel.files.noWorkspaceHint")}
      />
    );
  }

  if (selected !== null) {
    return (
      <div className="file-viewer">
        <div className="file-viewer-header">
          <button
            type="button"
            className="icon-btn"
            onClick={() => {
              setSelected(null);
              setFile(null);
            }}
            title={t("panel.files.back")}
          >
            <IconChevronLeft size={14} />
          </button>
          <span className="file-viewer-path" title={selected}>
            {selected}
          </span>
          {file && <span className="file-viewer-size">{formatSize(file.size)}</span>}
          <button
            type="button"
            className="icon-btn"
            onClick={() => void api.fsReveal(selected)}
            title={t("panel.files.reveal")}
          >
            <IconExternal size={14} />
          </button>
        </div>
        <div className="file-viewer-body">
          {fileError ? (
            <WorkTabEmpty icon={IconFileText} title={t("panel.files.error")} />
          ) : !file ? (
            <div className="file-tree-note">{t("panel.files.loading")}</div>
          ) : file.kind === "text" && isMarkdownPath(selected) ? (
            <div className="file-viewer-markdown prose-chat">
              <Markdown source={file.content ?? ""} baseDir={fileDirOf(selected)} />
            </div>
          ) : file.kind === "text" ? (
            <HighlightedText path={selected} content={file.content ?? ""} />
          ) : file.kind === "image" ? (
            <div className="file-viewer-image">
              <img src={file.dataUrl} alt={selected} />
            </div>
          ) : (
            <WorkTabEmpty
              icon={IconFileText}
              title={
                file.kind === "tooLarge"
                  ? t("panel.files.tooLarge")
                  : t("panel.files.binary")
              }
            />
          )}
        </div>
      </div>
    );
  }

  return <div className="file-tree">{renderDir("", 0)}</div>;
}
