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
  IconImage,
  IconWorkflow,
} from "./icons";
import { useAppStore } from "../stores/app-store";
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
        <button
          className={`code-copy-btn ${copied ? "copied" : ""}`}
          aria-label={t("chat.copy")}
          title={copied ? t("chat.copied") : t("chat.copy")}
          onClick={() => copy(code)}
        >
          {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
        </button>
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
            <button
              type="button"
              className={`mermaid-action-btn${showSource ? " active" : ""}`}
              aria-label={
                showSource ? t("chat.showDiagram") : t("chat.showDiagramSource")
              }
              title={
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
            </button>
          ) : null}
          <button
            type="button"
            className={`mermaid-action-btn${copied ? " copied" : ""}`}
            aria-label={t("chat.copyDiagramSource")}
            title={copied ? t("chat.copied") : t("chat.copyDiagramSource")}
            onClick={() => copy(code)}
          >
            {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
          </button>
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
  const root = useAppStore((s) => s.workspace?.path);
  const baseDir = useContext(MarkdownBaseDirContext);
  const openFile = useAppStore((s) => s.openFileInWorkPanel);
  const openUrl = useAppStore((s) => s.openUrlInWorkPanel);
  // Plain click previews in the work panel (browser tab for http(s), files
  // viewer for workspace paths). Modified clicks fall through to _blank,
  // which main routes to shell.openExternal; in-window navigation is blocked.
  const onClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (!href) return;
    if (/^https?:\/\//i.test(href)) {
      e.preventDefault();
      openUrl(href);
      return;
    }
    const rel = toWorkspaceRel(safeDecodeUri(href), root, baseDir);
    if (rel) {
      e.preventDefault();
      openFile(rel);
    }
  };
  return (
    <a {...rest} href={href} onClick={onClick} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

/**
 * Local image references can't load over the renderer origin; render them as
 * a chip that opens the files-tab image viewer instead of a broken <img>.
 * Remote images render inline and click through to the browser tab.
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
  if (/^https?:\/\//i.test(source)) {
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
  const rel = toWorkspaceRel(safeDecodeUri(source), root, baseDir);
  if (rel) {
    return (
      <button
        type="button"
        className="chat-image-chip"
        title={fileTitle}
        onClick={() => openFile(rel)}
      >
        <IconImage size={14} aria-hidden />
        <span>{alt || rel.split("/").pop()}</span>
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
