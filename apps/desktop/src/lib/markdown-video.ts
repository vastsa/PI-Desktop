import { absoluteImagePath } from "./markdown-image-paths";
import { toWorkspaceRel } from "./chat-links";

export function isVideoReference(source: string): boolean {
  if (/^https?:\/\//i.test(source)) {
    try { return /\.(mp4|m4v|mov|webm|ogv)$/i.test(new URL(source).pathname); }
    catch { return false; }
  }
  try { return /\.(mp4|m4v|mov|webm|ogv)$/i.test(decodeURIComponent(source)); }
  catch { return false; }
}

/** Preserve scratch and Windows absolute refs; only the host authorizes a read. */
export function localVideoRef(source: string, root?: string | null, baseDir?: string): string | null {
  if (/^file:/i.test(source)) {
    try {
      const url = new URL(source);
      if (url.hostname || url.search || url.hash) return null;
      return absoluteImagePath(url.pathname.replace(/^\/([a-z]:\/)/i, "$1"));
    } catch { return null; }
  }
  const absolute = absoluteImagePath(source);
  if (absolute) return absolute;
  let decoded: string;
  try { decoded = decodeURIComponent(source); } catch { return null; }
  if (/^[a-z][\w+.-]*:|^[/\\]{2}|[\0\r\n]/i.test(decoded)) return null;
  return toWorkspaceRel(decoded, root, baseDir);
}

type VideoNode = { type: string; url?: string; children?: VideoNode[] };

/** Keep local video drive letters through markdown URL sanitization. */
export function remarkLocalVideoPaths() {
  return (tree: VideoNode) => {
    const visit = (node: VideoNode) => {
      if ((node.type === "link" || node.type === "image" || node.type === "definition") && node.url && isVideoReference(node.url)) {
        const path = /^file:/i.test(node.url)
          ? localVideoRef(node.url)
          : absoluteImagePath(node.url);
        if (path) node.url = encodeURIComponent(path);
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}
