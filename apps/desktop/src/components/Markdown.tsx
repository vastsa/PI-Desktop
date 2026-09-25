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
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import {
  advanceMarkdownBlocks,
  emptyMarkdownBlockCache,
  markdownRemarkPlugins,
} from "../lib/markdown-blocks";
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
import { ContextMenu, useContextMenu } from "./ContextMenu";
import { PluginBlockRenderer } from "./PluginBlockRenderer";
import { blockRendererCandidate } from "../lib/block-renderer";
import { useSlotEntryForKey } from "../plugins/renderer-slots/use-slots";
import { MarkdownTable } from "./MarkdownTable";
import { markdownTableData } from "../lib/markdown-table";
import { api } from "../lib/api";
import { openHttpUrl } from "../lib/open-http-url";
import {
  rehypeSourcePositions,
  sourcePositionProps,
  type SourcePositionProps,
} from "../lib/markdown-source";
import {
  normalizeLatexMathDelimiters,
  remarkLatexBracketDisplay,
} from "../lib/latex-math";
import { useAppStore } from "../stores/app-store";
import { useReferencedImageDataUrl } from "../lib/use-referenced-image-data-url";
import { absoluteImagePath, remarkLocalImagePaths } from "../lib/markdown-image-paths";
import { useOpenChatFileRef } from "../hooks/use-preview-target";
import {
  useChatFileMenuItems,
  type ChatFileMenuTarget,
} from "../hooks/use-chat-file-menu";
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
 * The source is split with the rendering grammar, and each block renders
 * through a memoized <ReactMarkdown>. Streaming re-parses the growing tail
 * while retaining the completed prefix; a long unclosed block still has to
 * be parsed in full until its boundary is known. A source carrying link or
 * footnote definitions opts out of splitting altogether — `markdown-blocks`
 * states why, and why that trade is the right one.
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
  return useSyncExternalStore(subscribeTheme, getThemeSnapshot, getThemeSnapshot);
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
  const version = useSyncExternalStore(
    subscribeHighlighter,
    getHighlightVersion,
    getHighlightVersion,
  );
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

function CodeBlock({ code, lang, ...position }: { code: string; lang: string } & SourcePositionProps) {
  const { t } = useTranslation();
  const { copied, copy } = useCopy();
  return (
    <div className="code-block" {...position}>
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

function MermaidBlock({ code, ...position }: { code: string } & SourcePositionProps) {
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
      {...position}
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
  originalRaw: "",
});

const MarkdownBaseDirContext = createContext("");

/**
 * File references inside one rendered markdown tree share a single menu.
 *
 * A chip, a link and a local image all name files the same way and offer the
 * same items (`useChatFileMenuItems`), so the tree owns one surface instead of
 * one per reference. The default is `null` for a tree rendered outside
 * `Markdown`; a reference there keeps the platform's own menu rather than
 * offering an action that could not run.
 */
const MarkdownFileMenuContext = createContext<OpenMarkdownFileMenu | null>(null);

type OpenMarkdownFileMenu = (
  event: React.MouseEvent<HTMLElement>,
  target: ChatFileMenuTarget,
) => void;

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
}: ComponentProps<"pre"> & SourcePositionProps & { node?: unknown }) {
  const { closedFence, renderDiagrams } = useContext(MarkdownBlockContext);
  const info = extractCode(children);
  // Hooks stay unconditional: the fence language and closed-ness can flip
  // between streaming renders, so the lookup must run on every render.
  const blockEntry = useSlotEntryForKey(
    "blockRenderer",
    closedFence ? blockRendererCandidate(info?.lang ?? "") : undefined,
  );
  if (!info) return <pre {...rest}>{children}</pre>;
  if (
    renderDiagrams &&
    closedFence &&
    info.lang.toLowerCase() === "mermaid"
  ) {
    return <MermaidBlock code={info.code} {...sourcePositionProps(rest)} />;
  }
  if (blockEntry) {
    return (
      <PluginBlockRenderer
        key={blockEntry.id}
        entry={blockEntry}
        language={info.lang}
        source={info.code}
        sourcePosition={sourcePositionProps(rest)}
        fallback={
          <CodeBlock code={info.code} lang={info.lang} {...sourcePositionProps(rest)} />
        }
      />
    );
  }
  return <CodeBlock code={info.code} lang={info.lang} {...sourcePositionProps(rest)} />;
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
  const openFileRef = useOpenChatFileRef();
  const openFileMenu = useContext(MarkdownFileMenuContext);
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
        target.kind === "file"
          ? openFileRef(text ?? target.path, baseDir)
          : openHttpUrl(target.url)
      }
      onContextMenu={
        target.kind === "file" && openFileMenu
          ? (event) =>
              openFileMenu(event, { path: text ?? target.path, baseDir })
          : undefined
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
  const openFileRef = useOpenChatFileRef();
  const openFileMenu = useContext(MarkdownFileMenuContext);
  const openUrl = useAppStore((s) => s.openUrlInWorkPanel);
  const showToast = useAppStore((s) => s.showToast);

  const { contextMenu, openContextMenu, closeContextMenu } = useContextMenu();

  /*
    Copying reports through the toast host: the menu closes the moment the item
    runs, so there is no button left to carry its own copied state.
  */
  const copyLink = async (target: string) => {
    try {
      await navigator.clipboard.writeText(target);
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

  /*
    A link keeps the renderer's own menu instead of the platform's so both
    destinations the app can send it to stay one press away. The surface is the
    shared pointer-anchored menu, which measures before it reveals, clamps inside
    the viewport, and owns dismissal and arrow-key navigation; only the items are
    link-specific. A file link has one destination of its own, and that item is
    the one the tree's menu already carries.
  */
  const onContextMenu = (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (!href) return;
    if (!/^https?:\/\//i.test(href)) {
      /*
        A file link names the same reference a chip does, so it offers the same
        action on the file's folder. `./` and `../` resolve against the markdown
        file on screen, which is the base this row already holds.
      */
      const rel = toWorkspaceRel(safeDecodeUri(href), root, baseDir);
      if (!rel || !openFileMenu) return;
      openFileMenu(event, { path: rel, baseDir });
      return;
    }
    const target = href;
    openContextMenu(event, {
      items: [
        {
          id: "open-external",
          label: t("settings.linkContextMenuOpenExternal", {
            defaultValue: "Open in default browser",
          }),
          icon: <IconExternal size={14} />,
          onSelect: () => void api.browserOpenExternal(target),
        },
        {
          id: "open-workpanel",
          label: t("settings.linkContextMenuOpenWorkpanel", {
            defaultValue: "Open in work panel",
          }),
          icon: <IconGlobe size={14} />,
          onSelect: () => openUrl(target),
        },
        {
          id: "copy-address",
          label: t("settings.linkContextMenuCopy", {
            defaultValue: "Copy link address",
          }),
          icon: <IconCopy size={14} />,
          separatorBefore: true,
          onSelect: () => void copyLink(target),
        },
      ],
    });
  };

  // Plain click follows Link open destination. Modifier clicks fall through
  // to _blank, which main routes to shell.openExternal.

  const onClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (!href) return;
    if (/^https?:\/\//i.test(href)) {
      e.preventDefault();
      openHttpUrl(href);
      return;
    }
    const rel = toWorkspaceRel(safeDecodeUri(href), root, baseDir);
    if (rel) {
      e.preventDefault();
      openFileRef(rel, baseDir);
    }
  };
  return (
    <>
      <a
        {...rest}
        href={href}
        onClick={onClick}
        onContextMenu={onContextMenu}
        target="_blank"
        rel="noopener noreferrer"
      >
        {children}
      </a>
      <ContextMenu state={contextMenu} onClose={closeContextMenu} />
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
}: ComponentProps<"img"> & SourcePositionProps & { node?: unknown }) {
  const root = useAppStore((s) => s.workspace?.path);
  const baseDir = useContext(MarkdownBaseDirContext);
  const openFileRef = useOpenChatFileRef();
  const openFileMenu = useContext(MarkdownFileMenuContext);
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
  const localRef = (isRemote ? null : absoluteImagePath(source)) ?? rel ?? attachmentRef;
  // Always run the hook before any branch so hook order stays stable when a
  // streaming src flips between remote and local. Remote images pass null.
  const dataUrl = useReferencedImageDataUrl(isRemote ? null : localRef);

  /*
    A file the renderer can already show is still a file whose folder the user
    may want, so a local image carries the same menu its chip fallback does.
  */
  const onLocalContextMenu =
    localRef && openFileMenu
      ? (event: React.MouseEvent<HTMLElement>) =>
          openFileMenu(event, { path: localRef, baseDir })
      : undefined;
  if (isRemote) {
    return (
      <img
        {...rest}
        src={source}
        alt={alt ?? ""}
        className="chat-image-remote"
        title={urlTitle}
        onClick={() => openHttpUrl(source)}
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
        onClick={localRef ? () => openFileRef(localRef, baseDir) : undefined}
        onContextMenu={onLocalContextMenu}
      />
    );
  }
  if (localRef) {
    return (
      <button
        type="button"
        className="chat-image-chip"
        {...sourcePositionProps(rest)}
        title={fileTitle}
        onClick={() => openFileRef(localRef, baseDir)}
        onContextMenu={onLocalContextMenu}
      >
        <IconImage size={14} aria-hidden />
        <span>{alt || localRef.split("/").pop()}</span>
      </button>
    );
  }
  return <img {...rest} src={source} alt={alt ?? ""} />;
}

function Table({
  node,
  children,
  ...rest
}: ComponentProps<"table"> & { node?: Parameters<typeof markdownTableData>[0] }) {
  const { originalRaw } = useContext(MarkdownBlockContext);
  const data = useMemo(
    () => node ? markdownTableData(node, originalRaw) : null,
    [node, originalRaw],
  );
  const table = (
    <div className="table-wrap">
      <table {...rest}>{children}</table>
    </div>
  );
  return data ? <MarkdownTable {...data}>{table}</MarkdownTable> : table;
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

// The grammar the block splitter parses with, plus the renderer-only rewrite
// of local image paths. `remarkLocalImagePaths` transforms URLs and moves no
// block boundary, so the splitter has no reason to run it.
const staticRemarkPlugins = [...markdownRemarkPlugins, remarkLocalImagePaths];

// Extend the default schema only for the media elements rendered above, plus
// `remark-math`'s math classes on `<code>`: the default `language-*` allow list
// drops `math-display`, which leaves `rehype-katex` rendering TeX `\[ … \]`
// (single-line or mid-paragraph) as inline math instead of display math.
const sanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [["className", /^language-./, "math-inline", "math-display"]],
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

/*
 * Splitting and its streaming reuse live in `markdown-blocks`, which owns the
 * rules a slice has to satisfy before it can be parsed on its own.
 */
function useBlocks(source: string): string[] {
  const cacheRef = useRef(emptyMarkdownBlockCache);
  return useMemo(() => {
    cacheRef.current = advanceMarkdownBlocks(cacheRef.current, source);
    return cacheRef.current.blocks;
  }, [source]);
}

const Block = memo(function MarkdownBlock({
  raw,
  originalRaw,
  sourceOffset,
  renderDiagrams,
  workspaceRoot,
  baseDir,
}: {
  raw: string;
  originalRaw: string;
  sourceOffset: number;
  renderDiagrams: boolean;
  workspaceRoot?: string | null;
  baseDir?: string;
}) {
  const context = useMemo(
    () => ({
      closedFence: isClosedFencedCodeBlock(raw),
      renderDiagrams,
      originalRaw,
    }),
    [raw, originalRaw, renderDiagrams],
  );
  const remarkPlugins = useMemo(
    () => [
      ...staticRemarkPlugins,
      // `originalRaw` still carries the TeX `\[ … \]` delimiters so the
      // bracket-display plugin can promote them to display math after
      // remark-math parses the pre-normalized `$$ … $$` form.
      remarkLatexBracketDisplay(originalRaw),
      remarkChatFileLinks(workspaceRoot, baseDir),
    ],
    [originalRaw, workspaceRoot, baseDir],
  );
  const positionedRehypePlugins = useMemo(
    () => [...rehypePlugins!, [rehypeSourcePositions, { offset: sourceOffset }]] as Options["rehypePlugins"],
    [sourceOffset],
  );
  return (
    <MarkdownBlockContext.Provider value={context}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={positionedRehypePlugins}
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

  /*
    One menu for every file reference in this tree. Its blocks are memoized and
    rendered through the same component map, so the surface is asked for by the
    reference the pointer chose and owned here, where it outlives a block that
    streaming may replace.
  */
  const fileMenuItems = useChatFileMenuItems();
  const {
    contextMenu: fileMenu,
    openContextMenu: openFileMenu,
    closeContextMenu: closeFileMenu,
  } = useContextMenu();
  const openMarkdownFileMenu = useCallback<OpenMarkdownFileMenu>(
    (event, target) => openFileMenu(event, { items: fileMenuItems(target) }),
    [fileMenuItems, openFileMenu],
  );
  // Keep normalization length-preserving so source anchors and the bracket
  // display plugin still address the original text. Block splitting uses the
  // same math grammar as rendering, including unclosed streaming math blocks.
  const normalizedSource = useMemo(
    () => normalizeLatexMathDelimiters(source),
    [source],
  );
  const blocks = useBlocks(normalizedSource);
  let sourceOffset = 0;
  return (
    <MarkdownFileMenuContext.Provider value={openMarkdownFileMenu}>
      <MarkdownBaseDirContext.Provider value={baseDir ?? ""}>
        {blocks.map((raw, i) => {
          const start = sourceOffset;
          sourceOffset = start + raw.length;
          const originalRaw = source.slice(start, start + raw.length);
          return (
            <Block
              key={i}
              raw={raw}
              originalRaw={originalRaw}
              sourceOffset={start}
              renderDiagrams={renderDiagrams}
              workspaceRoot={workspaceRoot}
              baseDir={baseDir}
            />
          );
        })}
      </MarkdownBaseDirContext.Provider>
      <ContextMenu state={fileMenu} onClose={closeFileMenu} />
    </MarkdownFileMenuContext.Provider>
  );
});
