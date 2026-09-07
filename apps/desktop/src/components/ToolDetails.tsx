import { useTranslation } from "react-i18next";
import { HighlightedCode, useCopy } from "./Markdown";
import { IconCheck, IconCircleAlert, IconCopy, IconInfo } from "./icons";
import { cx } from "./ui";
import { toWorkspaceRel } from "../lib/chat-links";
import { useOpenPreviewTarget } from "../hooks/use-preview-target";
import { useAppStore } from "../stores/app-store";
import type { ToolBlock, ToolChip } from "../lib/tool-presentation";

/*
 * Renderer for the structured tool presentation (D192). Blocks arrive with a
 * semantic role; this layer owns the translated headings, the copy affordance
 * and the click-to-preview wiring. Shared by the transcript tool row and the
 * inline permission card so both read the same way.
 */

const BLOCK_LABEL_KEYS: Record<ToolBlock["role"], string> = {
  content: "chat.toolBlockContent",
  written: "chat.toolBlockWritten",
  command: "chat.toolBlockCommand",
  stdout: "chat.toolBlockStdout",
  stderr: "chat.toolBlockStderr",
  diff: "chat.toolBlockDiff",
  files: "chat.toolBlockFiles",
  matches: "chat.toolBlockMatches",
  details: "chat.toolBlockDetails",
  notice: "chat.toolBlockNotice",
  error: "chat.toolBlockError",
  output: "chat.toolOutput",
  input: "chat.toolInput",
};

function blockCopyText(block: ToolBlock): string {
  switch (block.kind) {
    case "code":
      return block.text;
    case "diff":
      return block.copy;
    case "files":
      return block.paths.join("\n");
    case "matches":
      return block.groups
        .flatMap((group) =>
          group.lines.map((line) => `${group.path}:${line.line}: ${line.text}`),
        )
        .join("\n");
    case "fields":
      return block.rows.map((row) => `${row.label}: ${row.value}`).join("\n");
    case "note":
      return block.code ? `${block.code}: ${block.text}` : block.text;
  }
}

function BlockHead({ label, copy }: { label: string; copy: string }) {
  const { copied, copy: run } = useCopy();
  const { t } = useTranslation();
  return (
    <div className="tool-row-section-head">
      <span>{label}</span>
      <button
        className={cx("tool-row-copy", copied && "copied")}
        aria-label={`${t("chat.copy")} ${label}`}
        title={copied ? t("chat.copied") : t("chat.copy")}
        onClick={() => run(copy)}
      >
        {copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
      </button>
    </div>
  );
}

function MoreNote({ hidden }: { hidden: number }) {
  const { t } = useTranslation();
  if (hidden <= 0) return null;
  return (
    <div className="tool-block-more">
      {t("chat.toolBlockMore", { count: hidden })}
    </div>
  );
}

/** A workspace path list (Glob results, plugin string arrays). */
function FileList({ paths }: { paths: string[] }) {
  const { t } = useTranslation();
  const root = useAppStore((s) => s.workspace?.path);
  const openTarget = useOpenPreviewTarget();
  return (
    <div className="tool-file-list">
      {paths.map((path, index) => {
        const rel = toWorkspaceRel(path, root);
        if (!rel) {
          return (
            <span className="tool-file-item" key={`${path}-${index}`}>
              {path}
            </span>
          );
        }
        return (
          <button
            type="button"
            className="tool-file-item is-linked"
            key={`${path}-${index}`}
            title={t("chat.previewFile")}
            onClick={() => openTarget({ kind: "file", path: rel })}
          >
            {path}
          </button>
        );
      })}
    </div>
  );
}

/** Grep hits grouped by file: the path opens, each line keeps its number. */
function MatchList({ block }: { block: Extract<ToolBlock, { kind: "matches" }> }) {
  const { t } = useTranslation();
  const root = useAppStore((s) => s.workspace?.path);
  const openTarget = useOpenPreviewTarget();
  return (
    <div className="tool-match-list">
      {block.groups.map((group, index) => {
        const rel = toWorkspaceRel(group.path, root);
        return (
          <div className="tool-match-group" key={`${group.path}-${index}`}>
            {rel ? (
              <button
                type="button"
                className="tool-match-path is-linked"
                title={t("chat.previewFile")}
                onClick={() => openTarget({ kind: "file", path: rel })}
              >
                {group.path}
              </button>
            ) : (
              <span className="tool-match-path">{group.path}</span>
            )}
            {group.lines.map((line, lineIndex) => (
              <div className="tool-match-line" key={`${line.line}-${lineIndex}`}>
                <span className="tool-match-line-no">{line.line}</span>
                <span className="tool-match-line-text">{line.text}</span>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

function BlockBody({ block }: { block: ToolBlock }) {
  switch (block.kind) {
    case "code":
      return (
        <pre className={cx("tool-row-content", block.tone === "error" && "is-error")}>
          {block.highlight ? (
            <HighlightedCode code={block.text} lang={block.lang} />
          ) : (
            block.text
          )}
        </pre>
      );
    case "diff":
      return (
        <div className="tool-diff">
          <div className="diff-hunk">
            {block.lines.map((line, index) => (
              <div className={cx("diff-line", line.type)} key={index}>
                <span className="diff-line-sign" aria-hidden>
                  {line.type === "add" ? "+" : line.type === "del" ? "−" : " "}
                </span>
                <span className="diff-line-text">{line.text}</span>
              </div>
            ))}
          </div>
          <MoreNote hidden={block.hidden} />
        </div>
      );
    case "files":
      return (
        <>
          <FileList paths={block.paths} />
          <MoreNote hidden={block.hidden} />
        </>
      );
    case "matches":
      return (
        <>
          <MatchList block={block} />
          <MoreNote hidden={block.hidden} />
        </>
      );
    case "fields":
      return (
        <dl className="tool-fields">
          {block.rows.map((row) => (
            <div className="tool-field" key={row.label}>
              <dt className="tool-field-label">{row.label}</dt>
              <dd className="tool-field-value">{row.value}</dd>
            </div>
          ))}
        </dl>
      );
    case "note":
      return (
        <div className={cx("tool-note", block.role === "error" && "is-error")}>
          {block.role === "error" ? (
            <IconCircleAlert size={13} />
          ) : (
            <IconInfo size={13} />
          )}
          <span className="tool-note-text">
            {block.code ? `${block.text} (${block.code})` : block.text}
          </span>
        </div>
      );
  }
}

export function ToolDetailBlocks({
  blocks,
  plain = false,
}: {
  blocks: ToolBlock[];
  plain?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <>
      {blocks.map((block, index) => {
        const label = block.label ?? t(BLOCK_LABEL_KEYS[block.role]);
        return (
          <section
            className={cx("tool-block", plain && "is-plain")}
            key={`${block.role}-${block.label ?? index}`}
          >
            {plain ? (
              // A run row's body is the output and nothing else (D227), so the
              // heading and its frame are gone. The channel still needs a name
              // for anyone who cannot see that stderr is the tinted one.
              <span className="sr-only">{label}</span>
            ) : (
              <BlockHead label={label} copy={blockCopyText(block)} />
            )}
            <BlockBody block={block} />
          </section>
        );
      })}
    </>
  );
}

const CHIP_LABEL_KEYS: Record<ToolChip["role"], string> = {
  exit: "chat.toolChipExit",
  matches: "chat.toolChipMatches",
  files: "chat.toolChipFiles",
  replacements: "chat.toolChipReplacements",
  truncated: "chat.toolChipTruncated",
  scratch: "chat.toolChipScratch",
  size: "chat.toolChipSize",
};

/** Collapsed-row outcome badges: exit code, hit counts, truncation. */
export function ToolChips({ chips }: { chips: ToolChip[] }) {
  const { t } = useTranslation();
  if (chips.length === 0) return null;
  return (
    <span className="tool-row-chips">
      {chips.map((chip) => (
        <span
          className={cx("tool-chip", chip.role === "exit" && "is-error")}
          key={chip.role}
        >
          {t(CHIP_LABEL_KEYS[chip.role], {
            ...("count" in chip ? { count: chip.count } : {}),
            ...("text" in chip ? { size: chip.text } : {}),
          })}
        </span>
      ))}
    </span>
  );
}
