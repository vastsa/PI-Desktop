import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import { Button, cx } from "../ui";

type TerminalStatus = "connecting" | "connected" | "failed" | "exited";
type RemoteTerminalEvent = Parameters<Parameters<typeof api.onRemoteTerminalEvent>[0]>[0];

function decodeBase64(value: string): Uint8Array {
  const binary = globalThis.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function encodeBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return globalThis.btoa(binary);
}

function applyEvent(
  event: RemoteTerminalEvent,
  terminalId: string,
  terminal: Terminal,
  setStatus: (status: TerminalStatus) => void,
  setExitCode: (code: number | null) => void,
): boolean {
  if (event.terminalId !== terminalId) return false;
  if (event.type === "output") {
    terminal.write(decodeBase64(event.output));
    return false;
  }
  if (event.state === "exited") {
    setExitCode(event.code ?? null);
    setStatus("exited");
  } else if (event.state === "closed") {
    setStatus("failed");
  } else {
    return false;
  }
  return true;
}

/** A renderer for a PTY owned by the selected remote Host. */
export function RemoteTerminalTab({
  sessionId,
  hostKey,
  hostLabel,
  openRequestId,
  blocked = false,
  onTerminalId,
}: {
  sessionId: string;
  hostKey: string;
  hostLabel: string;
  openRequestId: string;
  blocked?: boolean;
  onTerminalId?: (
    sessionId: string,
    openRequestId: string,
    terminalId: string,
  ) => void;
}) {
  const { t } = useTranslation();
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const onTerminalIdRef = useRef(onTerminalId);
  const blockedRef = useRef(blocked);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<TerminalStatus>("connecting");
  const [exitCode, setExitCode] = useState<number | null>(null);

  onTerminalIdRef.current = onTerminalId;
  blockedRef.current = blocked;

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;

    let live = true;
    let ready = false;
    let activeTerminalId: string | null = null;
    const pendingEvents: RemoteTerminalEvent[] = [];
    let inputSubscription: { dispose: () => void } | null = null;
    let lastSize = { cols: 0, rows: 0 };

    const style = getComputedStyle(surface);
    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: "var(--font-mono, ui-monospace, monospace)",
      fontSize: 13,
      screenReaderMode: true,
      theme: {
        background: style.getPropertyValue("--ds-bg-primary").trim(),
        foreground: style.getPropertyValue("--ds-text-primary").trim(),
        cursor: style.getPropertyValue("--ds-text-primary").trim(),
        selectionBackground: style.getPropertyValue("--ds-bg-active").trim(),
      },
      scrollback: 5000,
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(surface);
    terminalRef.current = terminal;
    fitRef.current = fit;
    fit.fit();

    const receive = (event: RemoteTerminalEvent) => {
      if (!live || event.sessionId !== sessionId) return;
      if (!ready) {
        pendingEvents.push(event);
        return;
      }
      if (activeTerminalId) {
        const ended = applyEvent(event, activeTerminalId, terminal, setStatus, setExitCode);
        if (ended) {
          inputSubscription?.dispose();
          inputSubscription = null;
        }
      }
    };
    const unsubscribe = api.onRemoteTerminalEvent(receive);
    const unsubscribeHost = api.onSessionsChanged((event) => {
      if (event.hostKey !== hostKey) return;
      if (event.reason === "remote.host.reconnecting") {
        setStatus("connecting");
      } else if (event.reason === "remote.host.error") {
        setStatus("failed");
      } else if (event.reason === "remote.host.reconnected") {
        setAttempt((value) => value + 1);
      }
    });

    const resize = () => {
      if (!live) return;
      try {
        fit.fit();
      } catch {
        return;
      }
      const cols = terminal.cols;
      const rows = terminal.rows;
      if (!ready || !activeTerminalId || cols < 1 || rows < 1) return;
      if (lastSize.cols === cols && lastSize.rows === rows) return;
      lastSize = { cols, rows };
      void api
        .remoteTerminalResize({ sessionId, terminalId: activeTerminalId, cols, rows })
        .catch(() => {
          if (live) setStatus("failed");
        });
    };
    const resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(resize);
    resizeObserver?.observe(surface);

    setStatus("connecting");
    setExitCode(null);
    void api
      .remoteTerminalOpen({
        sessionId,
        openRequestId,
        cols: Math.max(1, terminal.cols),
        rows: Math.max(1, terminal.rows),
      })
      .then((opened) => {
        // Tab switches only detach this view. Even if open resolves after the
        // component unmounts, the tab still owns the PTY and explicit close
        // from WorkPanel is the only path that terminates it.
        if (!live) {
          onTerminalIdRef.current?.(sessionId, openRequestId, opened.terminalId);
          return;
        }
        activeTerminalId = opened.terminalId;
        lastSize = { cols: opened.cols, rows: opened.rows };
        terminal.write(decodeBase64(opened.replay));
        ready = true;
        let ended = false;
        for (const event of pendingEvents.splice(0)) {
          ended = applyEvent(event, opened.terminalId, terminal, setStatus, setExitCode) || ended;
        }
        setStatus((current) => current === "connecting" ? "connected" : current);
        onTerminalIdRef.current?.(sessionId, openRequestId, opened.terminalId);
        if (!ended) {
          inputSubscription = terminal.onData((data) => {
            if (!live || !ready) return;
            // Input is a mutation and is sent once. Reconnect never resends it.
            void api
              .remoteTerminalInput({
                sessionId,
                terminalId: opened.terminalId,
                data: encodeBase64(data),
              })
              .catch(() => {
                if (live) setStatus("failed");
              });
          });
        }
        if (!blockedRef.current) terminal.focus();
        resize();
      })
      .catch(() => {
        if (live) setStatus("failed");
      });

    return () => {
      live = false;
      ready = false;
      unsubscribe();
      unsubscribeHost();
      resizeObserver?.disconnect();
      inputSubscription?.dispose();
      terminal.dispose();
      fit.dispose();
      terminalRef.current = null;
      fitRef.current = null;
      // Unmounting detaches the renderer only. The PTY stays alive for this
      // tab's next activation; explicit tab close is handled by WorkPanel.
    };
  }, [attempt, hostKey, openRequestId, sessionId]);

  useEffect(() => {
    if (blocked) terminalRef.current?.blur();
    else {
      fitRef.current?.fit();
    }
  }, [blocked]);

  const statusLabel = status === "connecting"
    ? t("panel.terminal.connecting")
    : status === "connected"
      ? t("panel.terminal.connected")
      : status === "exited"
        ? t("panel.terminal.exited", { code: exitCode ?? "?" })
        : t("panel.terminal.failed");

  return (
    <section className={cx("remote-terminal", blocked && "is-blocked")}>
      <header className="remote-terminal-header">
        <span className="remote-terminal-host">{t("panel.terminal.host", { host: hostLabel })}</span>
        <span className={cx("remote-terminal-status", `is-${status}`)} role="status">
          {statusLabel}
        </span>
      </header>
      <div className="remote-terminal-surface" ref={surfaceRef} aria-label={t("panel.tabs.terminal")} />
      {status === "failed" && (
        <div className="remote-terminal-error" role="alert">
          <span>{t("panel.terminal.failed")}</span>
          <Button type="button" variant="secondary" onClick={() => setAttempt((value) => value + 1)}>
            {t("panel.terminal.retry")}
          </Button>
        </div>
      )}
    </section>
  );
}
