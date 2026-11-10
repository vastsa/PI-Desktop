const captures = new Set<() => void>();

/** Live editors own serialization; explicit refresh requests a synchronous snapshot. */
export function registerRendererRefreshCapture(capture: () => void): () => void {
  captures.add(capture);
  return () => { captures.delete(capture); };
}
export function captureLiveRendererDrafts(): void {
  for (const capture of captures) capture();
}
