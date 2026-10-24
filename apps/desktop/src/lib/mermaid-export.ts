/** Convert already-sanitized Mermaid output into a standalone SVG document. */
export function standaloneMermaidSvg(svg: string): string {
  const document = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = document.documentElement;
  if (root.localName !== "svg" || document.querySelector("parsererror")) {
    throw new Error("Invalid Mermaid SVG");
  }
  root.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  // The preview inherits this app token; external viewers do not have it.
  const font = getComputedStyle(window.document.documentElement).getPropertyValue("--font-sans").trim() || "sans-serif";
  for (const style of root.querySelectorAll("style")) {
    style.textContent = style.textContent?.replaceAll("var(--font-sans)", () => font) ?? "";
  }
  for (const element of [root, ...root.querySelectorAll("[style]")]) {
    const style = element.getAttribute("style");
    if (style) element.setAttribute("style", style.replaceAll("var(--font-sans)", () => font));
  }
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
