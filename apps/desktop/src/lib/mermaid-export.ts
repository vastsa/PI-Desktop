/** Freeze variable-dependent declarations using each preview element's context. */
function materializeVariables(root: Element, preview: SVGSVGElement): void {
  const exported = [root, ...root.querySelectorAll("*")];
  const rendered = [preview, ...preview.querySelectorAll("*")];
  if (exported.length !== rendered.length || exported.some((node, index) => node.localName !== rendered[index].localName)) {
    throw new Error("Mermaid preview does not match exported SVG");
  }
  const copies = new Map(rendered.map((node, index) => [node, exported[index]]));
  const hasVariable = (value: string) => /var\s*\(/i.test(value);
  const freeze = (renderedNode: Element, property: string) => {
    const copy = copies.get(renderedNode);
    if (copy instanceof SVGElement) {
      const value = getComputedStyle(renderedNode).getPropertyValue(property);
      copy.style.setProperty(property, value, "important");
    }
  };
  for (const [index, copy] of exported.entries()) {
    const original = rendered[index];
    if (copy instanceof SVGElement) {
      for (const property of Array.from(copy.style)) {
        if (hasVariable(copy.style.getPropertyValue(property))) freeze(original, property);
      }
    }
    for (const attribute of Array.from(copy.attributes)) {
      if (attribute.name !== "style" && hasVariable(attribute.value) && CSS.supports(attribute.name, attribute.value)) {
        const value = getComputedStyle(original).getPropertyValue(attribute.name);
        if (value) copy.setAttribute(attribute.name, value);
        else copy.removeAttribute(attribute.name);
      }
    }
  }
  for (const style of root.querySelectorAll("style")) {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(style.textContent ?? "");
    const visit = (rules: CSSRuleList) => {
      for (const rule of Array.from(rules)) {
        if (rule instanceof CSSStyleRule) {
          for (const property of Array.from(rule.style)) {
            if (!hasVariable(rule.style.getPropertyValue(property))) continue;
            const targets = [...preview.querySelectorAll(rule.selectorText)];
            if (preview.matches(rule.selectorText)) targets.unshift(preview);
            for (const target of targets) freeze(target, property);
            // The resolved inline declaration wins; no app token is needed.
            rule.style.removeProperty(property);
          }
        } else if ("cssRules" in rule) {
          visit((rule as CSSGroupingRule).cssRules);
        }
      }
    };
    visit(sheet.cssRules);
    style.textContent = Array.from(sheet.cssRules, (rule) => rule.cssText).join("\n");
  }
}

/** Serialize sanitized SVG without changing the live preview or relying on app CSS. */
export function standaloneMermaidSvg(svg: string, preview: SVGSVGElement): string {
  const document = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = document.documentElement;
  if (root.localName !== "svg" || document.querySelector("parsererror")) {
    throw new Error("Invalid Mermaid SVG");
  }
  root.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  materializeVariables(root, preview);
  // Mermaid uses a responsive percentage width in-app. Preserve its natural
  // dimensions when the SVG is opened as a file or imported into an editor.
  const viewBox = root.getAttribute("viewBox")?.trim().split(/[\s,]+/).map(Number);
  if (viewBox?.length === 4 && viewBox.every(Number.isFinite) && viewBox[2] > 0 && viewBox[3] > 0) {
    root.setAttribute("width", String(viewBox[2]));
    root.setAttribute("height", String(viewBox[3]));
  }
  return new XMLSerializer().serializeToString(root);
}

export function downloadMermaidSvg(svg: string): void {
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
  const link = document.createElement("a");
  try {
    link.href = url;
    link.download = "diagram.svg";
    document.body.append(link);
    link.click();
  } finally {
    link.remove();
    // Chromium consumes the URL after the click returns.
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
