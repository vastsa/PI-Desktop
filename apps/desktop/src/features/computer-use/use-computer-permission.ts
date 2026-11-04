import { useCallback, useEffect, useRef, useState } from "react";
import { needsAccessibilityRequest, type ComputerCapabilities } from "@pi-desktop/shared";
import { computerUseApi } from "./computer-use-api";

/** Settings owns permission requests; focus/visibility only rechecks OS state. */
export function useComputerPermission() {
  const [capabilities, setCapabilities] = useState<ComputerCapabilities | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const mounted = useRef(false);
  const sequence = useRef(0);
  const pending = useRef(false);
  const refreshAfterRequest = useRef(false);

  const reportError = useCallback((error: unknown) => {
    const code = error instanceof Error && "code" in error && typeof error.code === "string"
      ? error.code : "INTERNAL";
    setErrorCode(code);
  }, []);

  const refresh = useCallback(async () => {
    if (!mounted.current) return;
    if (pending.current) {
      refreshAfterRequest.current = true;
      return;
    }
    const revision = ++sequence.current;
    try {
      const result = await computerUseApi.capabilities();
      if (!mounted.current || revision !== sequence.current) return;
      setCapabilities(result);
      if (!needsAccessibilityRequest(result)) {
        setWaiting(false);
        setErrorCode(null);
      }
    } catch (error) {
      if (mounted.current && revision === sequence.current) reportError(error);
    }
  }, [reportError]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const onFocus = () => { void refresh(); };
    const onVisibility = () => { if (!document.hidden) void refresh(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      mounted.current = false;
      sequence.current += 1;
      pending.current = false;
      refreshAfterRequest.current = false;
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refresh]);

  const requestPermission = useCallback(async () => {
    if (!mounted.current || pending.current || !capabilities || !needsAccessibilityRequest(capabilities)) return;
    pending.current = true;
    const revision = ++sequence.current;
    setRequesting(true);
    setWaiting(false);
    setErrorCode(null);
    try {
      const result = await computerUseApi.requestPermission();
      if (!mounted.current || revision !== sequence.current) return;
      setCapabilities(result);
      setWaiting(needsAccessibilityRequest(result));
    } catch (error) {
      if (mounted.current && revision === sequence.current) reportError(error);
    } finally {
      if (mounted.current && revision === sequence.current) {
        pending.current = false;
        setRequesting(false);
        // The system pane can return focus before the request IPC completes.
        if (refreshAfterRequest.current) {
          refreshAfterRequest.current = false;
          void refresh();
        }
      }
    }
  }, [capabilities, refresh, reportError]);

  return { capabilities, requesting, waiting, errorCode, requestPermission };
}
