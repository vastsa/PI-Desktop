interface ImagePathNode {
  type: string;
  url?: string;
  children?: ImagePathNode[];
}

/** Recognition only: the host image reader remains responsible for containment. */
export function absoluteImagePath(source: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(source);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  return /^(?:[a-z]:[\\/]|\/(?!\/))[^\r\n]+$/i.test(decoded) ? decoded : null;
}

/** Encode drive letters before URL sanitization without allowing new protocols. */
export function remarkLocalImagePaths() {
  return (tree: ImagePathNode) => {
    const visit = (node: ImagePathNode) => {
      if (node.type === "image" && typeof node.url === "string") {
        const path = absoluteImagePath(node.url);
        if (path) node.url = encodeURIComponent(path);
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}
