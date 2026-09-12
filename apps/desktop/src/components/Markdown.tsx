import {
  createContext,
  Fragment,
  isValidElement,
  memo,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ComponentProps,
  type RefObject,
  type ReactNode,
} from "react";
import ReactMarkdown, { type Components, type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import { lexer } from "marked";
import { useTranslation } from "react-i18next";
import type { ThemedToken } from "shiki";
import "katex/dist/katex.min.css";
import {
  IconCheck,
  IconCircleAlert,
  IconCode,
  IconCopy,
  IconExternal,
  IconGlobe,
  IconImage,
  IconWorkflow,
} from "./icons";
import { TooltipButton } from "./ui";
import { createPortal } from "react-dom";
import { api } from "../lib/api";
import { useAppStore } from "../stores/app-store";
import { useReferencedImageDataUrl } from "../lib/use-referenced-image-data-url";
import {
  remarkChatFileLinks,
  resolvePreviewTarget,
  safeDecodeUri,
  toWorkspaceRel,
} from "../lib/chat-links";
import {
  isClosedFencedCodeBlock,
  MAX_MERMAID_SOURCE_LENGTH,
  MermaidSourceTooLargeError,
  renderMermaidSvg,
} from "../lib/mermaid";
import {
  ensureLang,
  getHighlightVersion,
  resolveLang,
  subscribeHighlighter,
  themeForMode,
  tokenizeIncremental,
  type LineCache,
  type ThemeMode,
} from "../lib/shiki";

/*
 * Streaming-optimized chat markdown renderer.
 *
 * The source is split into top-level markdown blocks with marked's lexer and
 * each block renders through a memoized <ReactMarkdown>. While streaming only
 * the tail block's raw text changes, so every settled block skips re-parsing
 * entirely — total work stays linear in message length instead of quadratic.
 */

export function useCopy() {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = useCallback((text: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1500);
    });
  }, []);
  return { copied, copy };
}

/* ---------- theme (follows documentElement[data-theme]) ---------- */

const themeListeners = new Set<() => void>();
let themeObserver: MutationObserver | null = null;

function subscribeTheme(listener: () => void): () => void {
  if (!themeObserver) {
    themeObserver = new MutationObserver(() => {
      for (const cb of themeListeners) cb();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
  }
  themeListeners.add(listener);
  return () => {
    themeListeners.delete(listener);
  };
}

function getThemeSnapshot(): ThemeMode {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

function useThemeMode(): ThemeMode {
  return useSyncExternalStore(subscribeTheme, getThemeSnapshot);
}

/* ---------- syntax highlighting ---------- */

function tokenStyle(token: ThemedToken): CSSProperties | undefined {
  const fontStyle = token.fontStyle ?? 0;
  if (!token.color && !fontStyle) return undefined;
  const style: CSSProperties = {};
  if (token.color) style.color = token.color;
  if (fontStyle & 1) style.fontStyle = "italic";
  if (fontStyle & 2) style.fontWeight = "bold";
  if (fontStyle & 4) style.textDecoration = "underline";
  return style;
}

/* Rows are cached by reference in the line cache, so settled lines memo-skip. */
const TokenLine = memo(function TokenLine({ line }: { line: ThemedToken[] }) {
  return (
    <>
      {line.map((token, i) => (
        <span key={i} style={tokenStyle(token)}>
          {token.content}
        </span>
      ))}
    </>
  );
});

function useHighlightedTokens(
  code: string,
  lang: string,
): ThemedToken[][] | null {
  const resolved = resolveLang(lang);
  const mode = useThemeMode();
  const version = useSyncExternalStore(subscribeHighlighter, getHighlightVersion);
  useEffect(() => {
    if (resolved) ensureLang(resolved);
  }, [resolved]);
  const cacheRef = useRef<LineCache | null>(null);
  return useMemo(() => {
    if (!resolved) return null;
    const next = tokenizeIncremental(
      cacheRef.current,
      code,
      resolved,
      themeForMode(mode),
    );
    cacheRef.current = next;
    return next?.tokens ?? null;
    // `version` re-runs this once the language finishes lazy-loading.
  }, [code, resolved, mode, version]);
}

/**
 * Tokenized code body (no chrome). Shared with the transcript's tool result
 * blocks so both use the one incremental highlighter cache.
 */
export function HighlightedCode({
  code,
  lang,
}: {
  code: string;
  lang: string;
}) {
  const tokens = useHighlightedTokens(code, lang);
  if (!tokens) return <>{code}</>;
  return (
    <>
      {tokens.map((line, i) => (
        <Fragment key={i}>
          {i > 0 ? "\n" : null}
          <TokenLine line={line} />
        </Fragment>
      ))}
    </>
  );
}

function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const { t } = useTranslation();
  const { copied, copy } = useCopy();
  return (
    <div className="code-block">
      <div className="code-block-head">
        <span className="code-block-lang">{lang || "text"}</span>
        <TooltipButton
          className={`code-copy-btn ${copied ? "copied" : ""}`}
          tooltip={copied ? t("chat.copied") : t("chat.copy")}
          ariaLabel={t("chat.copy")}
          onClick={() => copy(code)}
        >
          {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
        </TooltipButton>
      </div>
      <pre>
        <code>
          <HighlightedCode code={code} lang={lang} />
        </code>
      </pre>
    </div>
  );
}

function useNearViewport(ref: RefObject<HTMLDivElement | null>): boolean {
  const [nearViewport, setNearViewport] = useState(false);
  useEffect(() => {
    if (nearViewport) return;
    const element = ref.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      setNearViewport(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setNearViewport(true);
        observer.disconnect();
      },
      { rootMargin: "240px 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [nearViewport, ref]);
  return nearViewport;
}

function MermaidBlock({ code }: { code: string }) {
  const { t } = useTranslation();
  const theme = useThemeMode();
  const reactId = useId();
  const renderId = useMemo(
    () => `mermaid-${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}`,
    [reactId],
  );
  const rootRef = useRef<HTMLDivElement>(null);
  const nearViewport = useNearViewport(rootRef);
  const renderedSourceRef = useRef("");
  const [svg, setSvg] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<"invalid" | "too-large" | null>(null);
  const [showSource, setShowSource] = useState(false);
  const { copied, copy } = useCopy();

  useEffect(() => {
    setShowSource(false);
  }, [code]);

  useEffect(() => {
    if (!nearViewport) return;
    if (code.length > MAX_MERMAID_SOURCE_LENGTH) {
      setSvg("");
      setLoading(false);
      setError("too-large");
      return;
    }

    let active = true;
    if (renderedSourceRef.current !== code) setSvg("");
    setLoading(true);
    setError(null);
    void renderMermaidSvg({ id: renderId, source: code, theme })
      .then((nextSvg) => {
        if (!active) return;
        renderedSourceRef.current = code;
        setSvg(nextSvg);
        setLoading(false);
      })
      .catch((cause: unknown) => {
        if (!active) return;
        setSvg("");
        setLoading(false);
        setError(
          cause instanceof MermaidSourceTooLargeError ? "too-large" : "invalid",
        );
      });
    return () => {
      active = false;
    };
  }, [code, nearViewport, renderId, theme]);

  const sourceVisible = showSource || error !== null;
  const statusLabel =
    error === "too-large"
      ? t("chat.diagramTooLarge")
      : t("chat.diagramUnavailable");

  return (
    <div
      ref={rootRef}
      className={`mermaid-block${error ? " error" : ""}`}
      aria-busy={loading}
    >
      <div className="mermaid-block-head">
        <span className="mermaid-block-title">
          <IconWorkflow size={13} aria-hidden />
          <span>mermaid</span>
        </span>
        <div className="mermaid-block-actions">
          {svg && !error ? (
            <TooltipButton
              type="button"
              className={`mermaid-action-btn${showSource ? " active" : ""}`}
              tooltip={
                showSource ? t("chat.showDiagram") : t("chat.showDiagramSource")
              }
              ariaLabel={
                showSource ? t("chat.showDiagram") : t("chat.showDiagramSource")
              }
              aria-pressed={showSource}
              onClick={() => setShowSource((value) => !value)}
            >
              {showSource ? (
                <IconWorkflow size={13} />
              ) : (
                <IconCode size={13} />
              )}
            </TooltipButton>
          ) : null}
          <TooltipButton
            type="button"
            className={`mermaid-action-btn${copied ? " copied" : ""}`}
            tooltip={copied ? t("chat.copied") : t("chat.copyDiagramSource")}
            ariaLabel={t("chat.copyDiagramSource")}
            onClick={() => copy(code)}
          >
            {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
          </TooltipButton>
        </div>
      </div>
      <div className="mermaid-block-body">
        {error ? (
          <div className="mermaid-block-error" role="status">
            <IconCircleAlert size={14} aria-hidden />
            <span>{statusLabel}</span>
          </div>
        ) : null}
        {sourceVisible ? (
          <pre className="mermaid-source">
            <code>{code}</code>
          </pre>
        ) : svg ? (
          <div
            className={`mermaid-svg${loading ? " refreshing" : ""}`}
            role="img"
            aria-label={t("chat.mermaidDiagram")}
            // Mermaid strict mode output is sanitized again in renderMermaidSvg.
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        ) : (
          <div
            className="mermaid-loading"
            role="status"
            aria-label={t("chat.diagramRendering")}
          >
            <span aria-hidden />
            <span aria-hidden />
            <span aria-hidden />
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------- react-markdown component overrides ---------- */

const MarkdownBlockContext = createContext({
  closedFence: false,
  renderDiagrams: true,
});

const MarkdownBaseDirContext = createContext("");

function extractCode(children: ReactNode): { code: string; lang: string } | null {
  const element = Array.isArray(children)
    ? children.find((child) => isValidElement(child))
    : children;
  if (!isValidElement(element)) return null;
  const props = element.props as { className?: unknown; children?: unknown };
  const className = typeof props.className === "string" ? props.className : "";
  const lang = /language-(\S+)/.exec(className)?.[1] ?? "";
  const raw = props.children;
  const code =
    typeof raw === "string"
      ? raw
      : Array.isArray(raw) && raw.every((part) => typeof part === "string")
        ? raw.join("")
        : null;
  if (code === null) return null;
  return { code: code.replace(/\n$/, ""), lang };
}

function PreBlock({
  node: _node,
  children,
  ...rest
}: ComponentProps<"pre"> & { node?: unknown }) {
  const { closedFence, renderDiagrams } = useContext(MarkdownBlockContext);
  const info = extractCode(children);
  if (!info) return <pre {...rest}>{children}</pre>;
  if (
    renderDiagrams &&
    closedFence &&
    info.lang.toLowerCase() === "mermaid"
  ) {
    return <MermaidBlock code={info.code} />;
  }
  return <CodeBlock code={info.code} lang={info.lang} />;
}

/** Preview-in-panel tooltip for file and URL chat references. */
function usePreviewTitle(kind: "file" | "url"): string {
  const { t } = useTranslation();
  return kind === "file" ? t("chat.previewFile") : t("chat.previewUrl");
}

/**
 * Inline code that names a workspace file (or URL) opens in the work panel;
 * everything else stays a plain code chip. Fenced blocks never reach this
 * component — PreBlock intercepts them.
 */
function InlineCode({
  node: _node,
  className,
  children,
  ...rest
}: ComponentProps<"code"> & { node?: unknown }) {
  const root = useAppStore((s) => s.workspace?.path);
  const baseDir = useContext(MarkdownBaseDirContext);
  const openFile = useAppStore((s) => s.openFileInWorkPanel);
  const openUrl = useAppStore((s) => s.openUrlInWorkPanel);
  const text = typeof children === "string" ? children : null;
  const target =
    text && !className && !text.includes("\n")
      ? resolvePreviewTarget(text, root, baseDir)
      : null;
  const fileTitle = usePreviewTitle("file");
  const urlTitle = usePreviewTitle("url");
  if (!target) {
    return (
      <code className={className} {...rest}>
        {children}
      </code>
    );
  }
  return (
    <button
      type="button"
      className="chat-code-link"
      title={target.kind === "file" ? fileTitle : urlTitle}
      onClick={() =>
        target.kind === "file" ? openFile(target.path) : openUrl(target.url)
      }
    >
      <code className={className} {...rest}>
        {children}
      </code>
    </button>
  );
}

function Anchor({
  node: _node,
  children,
  href,
  ...rest
}: ComponentProps<"a"> & { node?: unknown }) {
  const { t } = useTranslation();
  const root = useAppStore((s) => s.workspace?.path);
  const baseDir = useContext(MarkdownBaseDirContext);
  const openFile = useAppStore((s) => s.openFileInWorkPanel);
  const openUrl = useAppStore((s) => s.openUrlInWorkPanel);
  const showToast = useAppStore((s) => s.showToast);
  const linkOpenTarget = useAppStore((s) => s.settings?.linkOpenTarget ?? "workpanel");

  const [menuPosition, setMenuPosition] = useState<{ top: number; left: number } | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const anchorRef = useRef<HTMLAnchorElement | null>(null);

  useEffect(() => {
    if (!menuPosition) return;
    const close = () => setMenuPosition(null);
    const onPointerDown = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close();
      requestAnimationFrame(() => anchorRef.current?.focus());
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", onKeyDown);
    const focusFrame = requestAnimationFrame(() => {
      menuRef.current
        ?.querySelector<HTMLButtonElement>('[role="menuitem"]')
        ?.focus();
    });
    return () => {
      cancelAnimationFrame(focusFrame);
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [menuPosition]);

  const onContextMenu = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (!href || !/^https?:\/\//i.test(href)) return;
    e.preventDefault();
    e.stopPropagation();
    const x = Math.min(e.clientX, window.innerWidth - 200);
    const y = Math.min(e.clientY + 4, window.innerHeight - 150);
    setMenuPosition({ top: y, left: x });
  };

  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]:not(:disabled)',
      ),
    );
    if (!items.length) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) %
            items.length;
    items[next]?.focus();
  };

  const copyLink = async () => {
    setMenuPosition(null);
    if (!href) return;
    try {
      await navigator.clipboard.writeText(href);
      showToast(t("settings.linkCopied", { defaultValue: "Link copied to clipboard" }), {
        variant: "success",
      });
    } catch {
      showToast(
        t("settings.linkCopyFailed", { defaultValue: "Couldn't copy link address" }),
        { variant: "error" },
      );
    }
  };

  // Plain click previews in the work panel (or external browser based on setting).
  // Modified clicks fall through to _blank, which main routes to shell.openExternal.
  const onClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (!href) return;
    if (/^https?:\/\//i.test(href)) {
      e.preventDefault();
      if (linkOpenTarget === "external") {
        void api.browserOpenExternal(href);
      } else {
        openUrl(href);
      }
      return;
    }
    const rel = toWorkspaceRel(safeDecodeUri(href), root, baseDir);
    if (rel) {
      e.preventDefault();
      openFile(rel);
    }
  };
  return (
    <>
      <a
        ref={anchorRef}
        {...rest}
        href={href}
        onClick={onClick}
        onContextMenu={onContextMenu}
        target="_blank"
        rel="noopener noreferrer"
      >
        {children}
      </a>
      {menuPosition &&
        createPortal(
          <div
            ref={menuRef}
            className="sidebar-row-menu sidebar-floating-menu"
            role="menu"
            onKeyDown={onMenuKeyDown}
            style={{
              top: menuPosition.top,
              left: menuPosition.left,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenuPosition(null);
                if (href) void api.browserOpenExternal(href);
              }}
            >
              <IconExternal size={14} />
              {t("settings.linkContextMenuOpenExternal", { defaultValue: "Open in default browser" })}
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenuPosition(null);
                if (href) openUrl(href);
              }}
            >
              <IconGlobe size={14} />
              {t("settings.linkContextMenuOpenWorkpanel", { defaultValue: "Open in work panel" })}
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => void copyLink()}
            >
              <IconCopy size={14} />
              {t("settings.linkContextMenuCopy", { defaultValue: "Copy link address" })}
            </button>
          </div>,
          document.body,
        )}
    </>
  );
}

/**
 * Local image references can't load over the renderer origin; the host
 * resolves them into a bounded data URL so they render inline. Missing,
 * escaped, or oversized files fall back to a chip. Remote images render
 * inline and click through to the browser tab.
 */
function MarkdownImage({
  node: _node,
  src,
  alt,
  ...rest
}: ComponentProps<"img"> & { node?: unknown }) {
  const root = useAppStore((s) => s.workspace?.path);
  const baseDir = useContext(MarkdownBaseDirContext);
  const openFile = useAppStore((s) => s.openFileInWorkPanel);
  const openUrl = useAppStore((s) => s.openUrlInWorkPanel);
  const fileTitle = usePreviewTitle("file");
  const urlTitle = usePreviewTitle("url");
  const source = typeof src === "string" ? src : "";
  const isRemote = /^https?:/i.test(source);
  const decoded = safeDecodeUri(source);
  const rel = isRemote ? null : toWorkspaceRel(decoded, root, baseDir);
  const attachmentRef =
    !isRemote && /^attachments\/[0-9a-f]{64}$/i.test(decoded.replace(/\\/g, "/"))
      ? decoded.replace(/\\/g, "/")
      : null;
  const localRef = rel ?? attachmentRef;
  // Always run the hook before any branch so hook order stays stable when a
  // streaming src flips between remote and local. Remote images pass null.
  const dataUrl = useReferencedImageDataUrl(isRemote ? null : localRef);
  if (isRemote) {
    return (
      <img
        {...rest}
        src={source}
        alt={alt ?? ""}
        className="chat-image-remote"
        title={urlTitle}
        onClick={() => openUrl(source)}
      />
    );
  }
  if (dataUrl) {
    return (
      <img
        {...rest}
        src={dataUrl}
        alt={alt ?? ""}
        className="chat-image-local"
        title={rel ? fileTitle : source}
        onClick={localRef ? () => openFile(localRef) : undefined}
      />
    );
  }
  if (localRef) {
    return (
      <button
        type="button"
        className="chat-image-chip"
        title={fileTitle}
        onClick={() => openFile(localRef)}
      >
        <IconImage size={14} aria-hidden />
        <span>{alt || localRef.split("/").pop()}</span>
      </button>
    );
  }
  return <img {...rest} src={source} alt={alt ?? ""} />;
}

function Table({
  node: _node,
  children,
  ...rest
}: ComponentProps<"table"> & { node?: unknown }) {
  return (
    <div className="table-wrap">
      <table {...rest}>{children}</table>
    </div>
  );
}

/** Inline audio player for audio URLs in markdown. */
function AudioBlock({
  node: _node,
  src,
  ...rest
}: ComponentProps<"audio"> & { node?: unknown }) {
  const source = typeof src === "string" ? src : "";
  return (
    <div className="chat-audio">
      <audio controls preload="metadata" src={source} {...rest} />
    </div>
  );
}

/** Inline video player for video URLs in markdown. */
function VideoBlock({
  node: _node,
  src,
  ...rest
}: ComponentProps<"video"> & { node?: unknown }) {
  const source = typeof src === "string" ? src : "";
  return (
    <div className="chat-video">
      <video controls preload="metadata" src={source} {...rest} />
    </div>
  );
}

const markdownComponents: Components = {
  pre: PreBlock,
  code: InlineCode,
  a: Anchor,
  img: MarkdownImage,
  audio: AudioBlock,
  video: VideoBlock,
  table: Table,
};

const staticRemarkPlugins = [remarkGfm, remarkMath];

// Extend the default schema only for the media elements rendered above.
const sanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    img: [...(defaultSchema.attributes?.img || []), "src", "alt", "title", "className"],
    audio: ["src", "controls", "preload", "className"],
    video: ["src", "controls", "preload", "className", "poster"],
    source: ["src", "type"],
  },
  tagNames: [
    ...(defaultSchema.tagNames || []),
    "audio",
    "video",
    "source",
  ],
};

const rehypePlugins = [rehypeRaw, [rehypeSanitize, sanitizeSchema], rehypeKatex] as Options["rehypePlugins"];

/* ---------- block splitting ---------- */

function parseBlocks(source: string): string[] {
  const blocks: string[] = [];
  for (const token of lexer(source)) {
    const raw = token.raw;
    if (!raw) continue;
    // Fold blank-line runs into the previous block so joining blocks
    // reconstructs the source and block boundaries stay append-stable.
    if (token.type === "space" && blocks.length > 0) {
      blocks[blocks.length - 1] += raw;
    } else {
      blocks.push(raw);
    }
  }
  return blocks;
}

/*
 * Incremental re-lex: while streaming appends text, all blocks before the
 * last are settled (markdown blocks never merge backwards across a completed
 * boundary), so only the tail block is re-lexed each frame.
 */
function useBlocks(source: string): string[] {
  const cacheRef = useRef({ consumed: "", blocks: [] as string[] });
  return useMemo(() => {
    const cache = cacheRef.current;
    let stable: string[] = [];
    let tail = source;
    if (
      cache.blocks.length > 0 &&
      source.length >= cache.consumed.length &&
      source.startsWith(cache.consumed)
    ) {
      stable = cache.blocks.slice(0, -1);
      const lastStart =
        cache.consumed.length - cache.blocks[cache.blocks.length - 1].length;
      tail = source.slice(lastStart);
    }
    const blocks = tail ? [...stable, ...parseBlocks(tail)] : stable;
    cacheRef.current = { consumed: source, blocks };
    return blocks;
  }, [source]);
}

const Block = memo(function MarkdownBlock({
  raw,
  renderDiagrams,
  workspaceRoot,
  baseDir,
}: {
  raw: string;
  renderDiagrams: boolean;
  workspaceRoot?: string | null;
  baseDir?: string;
}) {
  const context = useMemo(
    () => ({
      closedFence: isClosedFencedCodeBlock(raw),
      renderDiagrams,
    }),
    [raw, renderDiagrams],
  );
  const remarkPlugins = useMemo(
    () => [
      ...staticRemarkPlugins,
      remarkChatFileLinks(workspaceRoot, baseDir),
    ],
    [workspaceRoot, baseDir],
  );
  return (
    <MarkdownBlockContext.Provider value={context}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={markdownComponents}
      >
        {raw}
      </ReactMarkdown>
    </MarkdownBlockContext.Provider>
  );
});

export const Markdown = memo(function Markdown({
  source,
  renderDiagrams = true,
  baseDir,
}: {
  source: string;
  renderDiagrams?: boolean;
  /** Workspace-relative directory of the source file, for `./` / `../` links. */
  baseDir?: string;
}) {
  const workspaceRoot = useAppStore((s) => s.workspace?.path);
  const blocks = useBlocks(source);
  return (
    <MarkdownBaseDirContext.Provider value={baseDir ?? ""}>
      {blocks.map((raw, i) => (
        <Block
          key={i}
          raw={raw}
          renderDiagrams={renderDiagrams}
          workspaceRoot={workspaceRoot}
          baseDir={baseDir}
        />
      ))}
    </MarkdownBaseDirContext.Provider>
  );
});
