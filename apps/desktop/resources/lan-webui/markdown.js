// LAN WebUI safe Markdown: a GFM subset rendered straight to DOM nodes.
// No HTML passthrough, no remote fetches (images become placeholders) and
// only absolute http(s) links. Regexes avoid lookbehind for older Safari.
"use strict";

(() => {
  const { el, icon } = window.LanKit;

  // A backtick fence's info string may not contain backticks (GFM).
  const FENCE = /^ {0,3}(?:(`{3,})([^`]*)|(~{3,})(.*))$/;
  const HEADING = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
  const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
  const QUOTE = /^ {0,3}>\s?(.*)$/;
  const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
  const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
  const INLINE = new RegExp([
    /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/.source, // 1-2 code span
    /!\[([^\]]*)\]\(((?:[^()]|\([^()]*\))*)\)/.source, // 3-4 image
    /\[([^\]]+)\]\(\s*<?((?:[^\s()<>]|\([^\s()<>]*\))+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/.source, // 5-6 link (one level of balanced parens)
    /\*\*(?=\S)([\s\S]*?\S)\*\*/.source, // 7 strong
    /__(?=\S)([\s\S]*?\S)__/.source, // 8 strong
    /~~(?=\S)([\s\S]*?\S)~~/.source, // 9 strike
    /\*(?=[^\s*])([\s\S]*?[^\s*])\*/.source, // 10 emphasis
    /(https?:\/\/[^\s<>]*[^\s<>.,;:!?'")\]}*_~])/.source, // 11 bare URL
    /\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/.source, // 12 escape
  ].join("|"), "g");
  const MAX_DEPTH = 4;

  const leading = (line) => line.length - line.trimStart().length;
  const text = (value) => document.createTextNode(value);

  function safeHref(href) {
    try {
      const url = new URL(href);
      return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
    } catch {
      return null;
    }
  }

  function inline(source, options, depth = 0) {
    if (depth > MAX_DEPTH) return [text(source)];
    const out = [];
    const pattern = new RegExp(INLINE.source, "g");
    let last = 0;
    let match;
    while ((match = pattern.exec(source))) {
      if (match.index > last) out.push(text(source.slice(last, match.index)));
      last = pattern.lastIndex;
      const nested = (value) => inline(value, options, depth + 1);
      if (match[1] !== undefined) {
        const code = match[2];
        out.push(el("code", { text: code.length > 2 && code.startsWith(" ") && code.endsWith(" ") ? code.slice(1, -1) : code }));
      } else if (match[4] !== undefined) {
        out.push(el("span", { class: "md-image" }, [icon("image", "xs"), el("span", { text: match[3] || options.labels.image })]));
      } else if (match[5] !== undefined) {
        const href = safeHref(match[6]);
        out.push(href
          ? el("a", { href, target: "_blank", rel: "noopener noreferrer" }, nested(match[5]))
          : el("span", {}, nested(match[5])));
      } else if (match[7] !== undefined || match[8] !== undefined) {
        out.push(el("strong", {}, nested(match[7] ?? match[8])));
      } else if (match[9] !== undefined) {
        out.push(el("del", {}, nested(match[9])));
      } else if (match[10] !== undefined) {
        out.push(el("em", {}, nested(match[10])));
      } else if (match[11] !== undefined) {
        const href = safeHref(match[11]);
        out.push(href ? el("a", { href, target: "_blank", rel: "noopener noreferrer", text: match[11] }) : text(match[11]));
      } else {
        out.push(text(match[12]));
      }
    }
    if (last < source.length) out.push(text(source.slice(last)));
    return out;
  }

  function startsBlock(lines, index) {
    const line = lines[index];
    return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || ITEM.test(line) || isTable(lines, index);
  }
  const isTable = (lines, index) => lines[index].includes("|") && index + 1 < lines.length && lines[index + 1].includes("-") && TABLE_SEP.test(lines[index + 1]);

  function paragraph(lines, options) {
    const node = el("p");
    lines.forEach((line, index) => {
      const hard = / {2,}$|\\$/.test(line);
      node.append(...inline(line.replace(/\\$/, "").trim(), options));
      if (index < lines.length - 1) node.append(hard ? el("br") : text("\n"));
    });
    return node;
  }

  function codeBlock(code, lang, options) {
    return el("div", { class: "code-block" }, [
      el("div", { class: "code-head" }, [
        el("span", { class: "code-lang", text: lang.toLowerCase() }),
        el("button", {
          type: "button",
          class: "icon-btn code-copy",
          "aria-label": options.labels.copyCode,
          onclick: (event) => options.onCopy(code, event.currentTarget),
        }, icon("copy", "sm")),
      ]),
      el("pre", {}, el("code", { text: code })),
    ]);
  }

  /** Split a table row on unescaped pipes outside code spans. */
  function cells(row) {
    const trimmed = row.trim().replace(/^\|/, "").replace(/\|$/, "");
    const out = [];
    let current = "";
    let ticks = false;
    for (let i = 0; i < trimmed.length; i += 1) {
      const char = trimmed[i];
      if (char === "\\" && trimmed[i + 1] === "|") {
        current += "|";
        i += 1;
      } else if (char === "`") {
        ticks = !ticks;
        current += char;
      } else if (char === "|" && !ticks) {
        out.push(current.trim());
        current = "";
      } else {
        current += char;
      }
    }
    out.push(current.trim());
    return out;
  }

  function table(lines, start, parent, options) {
    const head = cells(lines[start]);
    const align = cells(lines[start + 1]).map((cell) => (cell.endsWith(":") ? (cell.startsWith(":") ? "center" : "right") : ""));
    const body = el("tbody");
    let i = start + 2;
    while (i < lines.length && lines[i].trim() && lines[i].includes("|")) {
      const row = cells(lines[i]);
      body.append(el("tr", {}, head.map((_, column) => el("td", { class: align[column] ? `align-${align[column]}` : undefined }, inline(row[column] ?? "", options)))));
      i += 1;
    }
    parent.append(el("div", { class: "table-wrap" }, el("table", {}, [
      el("thead", {}, el("tr", {}, head.map((cell, column) => el("th", { class: align[column] ? `align-${align[column]}` : undefined }, inline(cell, options))))),
      body,
    ])));
    return i;
  }

  function list(lines, start, parent, options) {
    const first = ITEM.exec(lines[start]);
    const indent = first[1].length;
    const ordered = /\d/.test(first[2]);
    const node = el(ordered ? "ol" : "ul");
    if (ordered && Number.parseInt(first[2], 10) !== 1) node.setAttribute("start", String(Number.parseInt(first[2], 10)));
    const sameList = (line) => {
      const match = ITEM.exec(line);
      return Boolean(match) && match[1].length === indent && /\d/.test(match[2]) === ordered;
    };
    let i = start;
    while (i < lines.length && sameList(lines[i])) {
      const match = ITEM.exec(lines[i]);
      const contentIndent = match[1].length + match[2].length + 1;
      const body = [match[3]];
      i += 1;
      while (i < lines.length) {
        const line = lines[i];
        if (!line.trim()) {
          if (i + 1 < lines.length && lines[i + 1].trim() && leading(lines[i + 1]) > indent) {
            body.push("");
            i += 1;
            continue;
          }
          break;
        }
        if (leading(line) > indent) {
          body.push(line.slice(Math.min(contentIndent, leading(line))));
          i += 1;
          continue;
        }
        if (startsBlock(lines, i)) break;
        body.push(line);
        i += 1;
      }
      const item = el("li");
      blocks(body, item, options);
      node.append(item);
      let next = i;
      while (next < lines.length && !lines[next].trim()) next += 1;
      if (next < lines.length && sameList(lines[next])) i = next;
      else break;
    }
    parent.append(node);
    return i;
  }

  function blocks(lines, parent, options) {
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) {
        i += 1;
        continue;
      }
      const fence = FENCE.exec(line);
      if (fence) {
        const marker = fence[1] ?? fence[3];
        const lang = (fence[2] ?? fence[4]).trim().split(/\s+/)[0];
        const close = new RegExp(`^ {0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}\\s*$`);
        const code = [];
        i += 1;
        while (i < lines.length && !close.test(lines[i])) code.push(lines[i++]);
        i += 1;
        parent.append(codeBlock(code.join("\n"), lang, options));
        continue;
      }
      const heading = HEADING.exec(line);
      if (heading) {
        parent.append(el(`h${heading[1].length}`, {}, inline(heading[2], options)));
        i += 1;
        continue;
      }
      if (RULE.test(line)) {
        parent.append(el("hr"));
        i += 1;
        continue;
      }
      if (QUOTE.test(line)) {
        const inner = [];
        while (i < lines.length && lines[i].trim() && QUOTE.test(lines[i])) inner.push(QUOTE.exec(lines[i++])[1]);
        const quote = el("blockquote");
        blocks(inner, quote, options);
        parent.append(quote);
        continue;
      }
      if (ITEM.test(line)) {
        i = list(lines, i, parent, options);
        continue;
      }
      if (isTable(lines, i)) {
        i = table(lines, i, parent, options);
        continue;
      }
      const para = [line];
      i += 1;
      while (i < lines.length && lines[i].trim() && !startsBlock(lines, i)) para.push(lines[i++]);
      parent.append(paragraph(para, options));
    }
  }

  /**
   * @param {string} source
   * @param {{ labels: { copyCode: string, image: string }, onCopy(text: string, button: HTMLElement): void }} options
   */
  function render(source, options) {
    const fragment = document.createDocumentFragment();
    blocks(String(source).replace(/\r\n?/g, "\n").split("\n"), fragment, options);
    return fragment;
  }

  window.LanMarkdown = { render };
})();
