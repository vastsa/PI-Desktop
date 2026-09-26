type MarkdownNode = {
  type?: unknown;
  url?: unknown;
  children?: unknown;
};

const WRAPPED_HTTP_DESTINATION = /^\(\[[^\]\r\n]+\]\((https?:\/\/\S+)\)\)$/i;

function normalizeWrappedHttpDestination(url: string): string | null {
  return WRAPPED_HTTP_DESTINATION.exec(url)?.[1] ?? null;
}

function normalizeLinks(node: unknown): void {
  if (Array.isArray(node)) {
    for (const child of node) normalizeLinks(child);
    return;
  }
  if (node === null || typeof node !== "object") return;

  const current = node as MarkdownNode;
  if (current.type === "link" && typeof current.url === "string") {
    const normalized = normalizeWrappedHttpDestination(current.url);
    if (normalized) current.url = normalized;
  }
  normalizeLinks(current.children);
}

/**
 * Repair a nested linked-host wrapper in an HTTP(S) Markdown destination
 * before rehype-sanitize validates the URL. Other link destinations are kept
 * unchanged, so this cannot enable additional protocols.
 */
export function remarkNormalizeWrappedMarkdownLinkDestinations() {
  return (tree: unknown) => normalizeLinks(tree);
}
