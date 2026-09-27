/**
 * Maximum raw image size that may be embedded in a provider request.
 *
 * MiniMax's OpenAI-compatible endpoint accepts one image up to 10 MB. Keep
 * the bound decimal and shared by Electron main and the sidecar so a replay
 * cannot take a different transport path from a fresh prompt.
 */
export const MAX_INLINE_IMAGE_BYTES = 10_000_000;
