import { Fragment } from "react";
import { searchMatchRanges } from "../lib/session-search";

export function SearchHighlight({ text, query }: { text: string; query: string }) {
  const ranges = searchMatchRanges(text, query);
  let end = 0;
  return (
    <>
      {ranges.map(([start, next]) => {
        const before = text.slice(end, start);
        end = next;
        return (
          <Fragment key={start}>
            {before}
            <mark className="search-hit">{text.slice(start, next)}</mark>
          </Fragment>
        );
      })}
      {text.slice(end)}
    </>
  );
}
