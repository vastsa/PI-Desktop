import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { ThemedToken } from "shiki";
import type { NumberedReviewLine } from "../lib/review-history";
import { reviewLineNumber } from "../lib/review-history";
import { langForPath } from "../lib/tool-presentation";
import { TokenLine, useHighlightedTokens } from "./Markdown";
import { cx } from "./ui";

type Hunk = { header: string; lines: NumberedReviewLine[] };
type HunkProps = { hunk: Hunk; path: string; numbered: boolean; highlightCode: boolean };

/** A hunk has two independent grammar streams; diff headers/EOF markers are not source. */
function sourceViews(hunk: Hunk) {
  const before: string[] = [], after: string[] = [];
  const indices = hunk.lines.map(line => {
    const marker = line.text === "\\ No newline at end of file";
    return {
      before: marker || line.type === "add" ? null : before.push(line.text) - 1,
      after: marker || line.type === "del" ? null : after.push(line.text) - 1,
    };
  });
  return { before: before.join("\n"), after: after.join("\n"), indices };
}

/** Only the local Review reader opts in; inline/legacy diffs never load a grammar. */
export function ReviewDiffHunk(props: HunkProps) {
  return props.highlightCode ? <HighlightedHunk {...props} /> : <HunkLines hunk={props.hunk} numbered={props.numbered} />;
}

function HighlightedHunk({ hunk, path, numbered }: HunkProps) {
  const views = useMemo(() => sourceViews(hunk), [hunk]);
  const language = langForPath(path);
  const before = useHighlightedTokens(views.before, language);
  const after = useHighlightedTokens(views.after, language);
  const tokens = hunk.lines.map((line, index) => {
    const position = views.indices[index];
    return line.type === "del" ? before?.[position.before ?? -1] : after?.[position.after ?? -1];
  });
  return <HunkLines hunk={hunk} numbered={numbered} tokens={tokens} />;
}

function HunkLines({ hunk, numbered, tokens }: {
  hunk: Hunk; numbered: boolean; tokens?: (ThemedToken[] | undefined)[];
}) {
  const { t } = useTranslation();
  return <div className="diff-hunk">
    <div className="diff-line hunk"><span className="diff-line-text">{hunk.header}</span></div>
    {hunk.lines.map((line, index) => {
      const number = reviewLineNumber(line), rowTokens = tokens?.[index];
      return <div className={cx("diff-line", line.type)} key={index}>
        {numbered && <span className="review-line-number" data-side={line.type === "del" ? "old" : "new"}
          aria-label={number === null ? undefined : t(line.type === "del" ? "panel.review.oldLine" : "panel.review.newLine", { line: number })}>
          {number}
        </span>}
        {!numbered && <span className="diff-line-sign" aria-hidden>
          {line.type === "add" ? "+" : line.type === "del" ? "−" : " "}
        </span>}
        <span className="diff-line-text">{rowTokens ? <TokenLine line={rowTokens} /> : line.text}</span>
      </div>;
    })}
  </div>;
}
