import { createContext, createElement, type ReactElement, type ReactNode, useContext } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

type RichNodeProps = {
  children?: ReactNode;
  alt?: string;
  checked?: boolean;
};

function spanBlock(className: string) {
  return ({ children }: RichNodeProps) =>
    createElement("span", { className }, children);
}

type AskToolListKind = "ordered" | "unordered";
const AskToolListContext = createContext<AskToolListKind>("unordered");

function AskToolList({
  kind,
  children,
}: {
  kind: AskToolListKind;
  children?: ReactNode;
}) {
  return createElement(
    AskToolListContext.Provider,
    { value: kind },
    createElement(
      "span",
      { className: `asktool-rich-list asktool-rich-list-${kind}`, role: "list" },
      children,
    ),
  );
}

function AskToolListItem({ children }: { children?: ReactNode }) {
  const kind = useContext(AskToolListContext);
  return createElement(
    "span",
    { className: "asktool-rich-list-item", role: "listitem" },
    createElement("span", {
      className: "asktool-rich-list-marker",
      "aria-hidden": true,
      ...(kind === "unordered" ? { children: "•" } : {}),
    }),
    children,
  );
}

const safeMarkdownComponents: Components = {
  a: ({ children }) =>
    createElement("span", { className: "asktool-rich-link" }, children),
  blockquote: spanBlock("asktool-rich-quote"),
  code: ({ children }) =>
    createElement("code", { className: "asktool-rich-code" }, children),
  h1: spanBlock("asktool-rich-heading"),
  h2: spanBlock("asktool-rich-heading"),
  h3: spanBlock("asktool-rich-heading"),
  h4: spanBlock("asktool-rich-heading"),
  h5: spanBlock("asktool-rich-heading"),
  h6: spanBlock("asktool-rich-heading"),
  hr: () => createElement("span", { className: "asktool-rich-rule", "aria-hidden": true }),
  img: ({ alt }) =>
    alt
      ? createElement("span", { className: "asktool-rich-image-alt" }, alt)
      : null,
  input: ({ checked }) =>
    createElement(
      "span",
      { className: "asktool-rich-task-marker", "aria-hidden": true },
      checked ? "✓" : "○",
    ),
  li: ({ children }) => createElement(AskToolListItem, null, children),
  ol: ({ children }) => createElement(AskToolList, { kind: "ordered" }, children),
  p: spanBlock("asktool-rich-paragraph"),
  pre: spanBlock("asktool-rich-pre"),
  table: spanBlock("asktool-rich-table"),
  tbody: spanBlock("asktool-rich-table-row"),
  td: spanBlock("asktool-rich-table-cell"),
  tfoot: spanBlock("asktool-rich-table-row"),
  th: spanBlock("asktool-rich-table-cell"),
  thead: spanBlock("asktool-rich-table-row"),
  tr: spanBlock("asktool-rich-table-row"),
  ul: ({ children }) => createElement(AskToolList, { kind: "unordered" }, children),
};

/** Safe Markdown projection for asktool text that can appear inside a button. */
export function AskToolRichText({ source }: { source: string }): ReactElement {
  return createElement(ReactMarkdown, {
    components: safeMarkdownComponents,
    remarkPlugins: [remarkGfm],
    skipHtml: true,
    children: source,
  });
}
