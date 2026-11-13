import { formatFileInsert } from "./composer-trigger.js";

/** Metadata is context only; tool admission still owns file access. */
export function appendLocalFileReferenceContext(
  content: string,
  files: ReadonlyArray<{ path: string; size?: number; localReference?: string }>,
): string {
  const references = files.filter(file => file.localReference).map(file =>
    `${formatFileInsert(file.path, "file").trim()} (${file.size} bytes)`).join("\n");
  if (!references) return content;
  const block = `Local file references (sizes recorded when sent; read relevant parts as needed using normal tool permissions):\n${references}`;
  return content.endsWith(block) ? content : [content, block].filter(Boolean).join("\n");
}
