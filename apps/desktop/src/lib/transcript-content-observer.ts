type ContentListener = () => void;

/** One read batch per viewport frame, shared by its measured content shells. */
class TranscriptContentObserver {
  private readonly listeners = new Map<HTMLElement, ContentListener>();
  private readonly resize: ResizeObserver;
  private frame: number | null = null;

  private readonly viewport: HTMLElement;

  constructor(viewport: HTMLElement) {
    this.viewport = viewport;
    this.resize = new ResizeObserver(this.schedule);
    this.resize.observe(viewport);
    viewport.addEventListener("scroll", this.schedule, { passive: true });
    viewport.addEventListener("focusin", this.schedule);
    viewport.addEventListener("focusout", this.schedule);
    viewport.ownerDocument.addEventListener("selectionchange", this.schedule);
  }

  private readonly schedule = () => {
    if (this.frame !== null) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      for (const listener of this.listeners.values()) listener();
    });
  };

  add(element: HTMLElement, listener: ContentListener): () => void {
    this.listeners.set(element, listener);
    this.resize.observe(element);
    this.schedule();
    return () => {
      this.resize.unobserve(element);
      this.listeners.delete(element);
      if (this.listeners.size !== 0) return;
      this.resize.disconnect();
      this.viewport.removeEventListener("scroll", this.schedule);
      this.viewport.removeEventListener("focusin", this.schedule);
      this.viewport.removeEventListener("focusout", this.schedule);
      this.viewport.ownerDocument.removeEventListener("selectionchange", this.schedule);
      if (this.frame !== null) cancelAnimationFrame(this.frame);
      observers.delete(this.viewport);
    };
  }
}

const observers = new WeakMap<HTMLElement, TranscriptContentObserver>();

export function observeTranscriptContent(element: HTMLElement, listener: ContentListener): () => void {
  const viewport = element.closest<HTMLElement>(".thread-scroll");
  if (!viewport) return () => {};
  let observer = observers.get(viewport);
  if (!observer) {
    observer = new TranscriptContentObserver(viewport);
    observers.set(viewport, observer);
  }
  return observer.add(element, listener);
}
