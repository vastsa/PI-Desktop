/** SVG can be previewed locally, but must not be sent as a raw model image. */
export const SVG_MIME_TYPE = "image/svg+xml";

/** MIME parameters and legacy filename metadata must not bypass the SVG fallback. */
export function isSvgAttachment(
  mimeType: string | undefined,
  ...names: (string | undefined)[]
): boolean {
  return (
    mimeType?.split(";", 1)[0]?.trim().toLowerCase() === SVG_MIME_TYPE ||
    names.some((name) => typeof name === "string" && /\.svg$/i.test(name.trim()))
  );
}
