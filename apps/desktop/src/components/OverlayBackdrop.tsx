import { useEffect, useRef, type HTMLAttributes } from "react";

/** Dismiss only a press/release on this backdrop, never a drag across its content. */
export function OverlayBackdrop({
  onClick,
  onPointerDownCapture,
  onPointerUpCapture,
  onPointerCancelCapture,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  const press = useRef<{ pointerId: number; released: boolean } | null>(null);
  useEffect(() => {
    const reset = () => { press.current = null; };
    window.addEventListener("blur", reset);
    return () => window.removeEventListener("blur", reset);
  }, []);

  return (
    <div
      {...props}
      onPointerDownCapture={(event) => {
        press.current = event.target === event.currentTarget && event.button === 0 && event.isPrimary
          ? { pointerId: event.pointerId, released: false }
          : null;
        onPointerDownCapture?.(event);
      }}
      onPointerUpCapture={(event) => {
        if (press.current?.pointerId === event.pointerId && event.target === event.currentTarget) {
          press.current.released = true;
        } else {
          press.current = null;
        }
        onPointerUpCapture?.(event);
      }}
      onPointerCancelCapture={(event) => {
        press.current = null;
        onPointerCancelCapture?.(event);
      }}
      onClick={(event) => {
        const intentional = press.current?.released && event.target === event.currentTarget;
        press.current = null;
        if (intentional) onClick?.(event);
      }}
    />
  );
}
