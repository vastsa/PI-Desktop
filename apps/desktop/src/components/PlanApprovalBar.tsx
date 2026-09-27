import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import type {
  GlobalPermissionMode,
  PlanProposal,
  ProposalKind,
} from "@pi-desktop/shared";
import { useAppStore } from "../stores/app-store";
import { fileWorkPanelTab } from "../lib/work-panel-tabs";
import { PLAN_APPROVAL_DEFAULT_MODE } from "../lib/plan-mode-state";
import {
  readPlanApprovalMode,
  rememberPlanApprovalMode,
} from "../lib/plan-approval-preferences";
import {
  IconCheck,
  IconChevronDown,
  IconFileText,
} from "./icons";

const APPROVAL_MODES: readonly GlobalPermissionMode[] = [
  "ask",
  "accept-edits",
  "auto",
];

/**
 * Plan and Goal share this one approval bar; only the copy differs, so every
 * label is looked up under the proposal kind's i18n namespace (D198).
 */
const APPROVAL_MODE_LABELS: Record<GlobalPermissionMode, string> = {
  ask: "ask",
  "accept-edits": "acceptEdits",
  auto: "auto",
};

const APPROVE_LABELS: Record<GlobalPermissionMode, string> = {
  ask: "approveAsk",
  "accept-edits": "approveAcceptEdits",
  auto: "approveAuto",
};

function isApprovalMode(value: string | undefined): value is GlobalPermissionMode {
  return value === "ask" || value === "accept-edits" || value === "auto";
}

/** `plan.reject` or `goal.reject`, chosen by the approved contract kind. */
function copyKey(kind: ProposalKind, name: string): string {
  return `${kind}.${name}`;
}

export function PlanApprovalBar({ proposal }: { proposal: PlanProposal }) {
  const { t } = useTranslation();
  const resolvePlan = useAppStore((state) => state.resolvePlan);
  const showToast = useAppStore((state) => state.showToast);
  const openWorkPanelTabForSession = useAppStore(
    (state) => state.openWorkPanelTabForSession,
  );
  const [menuOpen, setMenuOpen] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [approvalMode, setApprovalMode] = useState<GlobalPermissionMode>(
    readPlanApprovalMode(),
  );
  const menuRef = useRef<HTMLDivElement>(null);
  const chevronRef = useRef<HTMLButtonElement>(null);
  const kind: ProposalKind = proposal.kind === "goal" ? "goal" : "plan";
  const copy = (name: string) => t(copyKey(kind, name));
  const artifactPath = proposal.artifact?.relativePath?.trim() || null;
  const isPending = proposal.status === "pending";
  const busy = resolving;

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setMenuOpen(false);
      requestAnimationFrame(() => chevronRef.current?.focus());
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    const focusFrame = requestAnimationFrame(() => {
      const selected = menuRef.current?.querySelector<HTMLButtonElement>(
        '[role="menuitemradio"][aria-checked="true"]',
      );
      (selected ??
        menuRef.current?.querySelector<HTMLButtonElement>(
          '[role="menuitemradio"]',
        ))?.focus();
    });
    return () => {
      cancelAnimationFrame(focusFrame);
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  useEffect(() => {
    setApprovalMode(readPlanApprovalMode());
    setMenuOpen(false);
  }, [proposal.id]);

  useEffect(() => {
    setResolving(false);
  }, [proposal.id]);

  const focusComposer = () => {
    if (useAppStore.getState().activeSessionId !== proposal.sessionId) return;
    requestAnimationFrame(() => {
      document.querySelector<HTMLTextAreaElement>(".composer-input")?.focus();
    });
  };

  const resolve = async (
    action: "approve" | "reject",
    targetPermissionMode?: GlobalPermissionMode,
  ) => {
    if (busy || !isPending) return;
    setMenuOpen(false);
    if (action === "approve") {
      const selectedMode = targetPermissionMode ?? PLAN_APPROVAL_DEFAULT_MODE;
      setApprovalMode(selectedMode);
      rememberPlanApprovalMode(selectedMode);
    }
    setResolving(true);
    try {
      const identity = {
        proposalId: proposal.id,
        sessionId: proposal.sessionId,
        turnId: proposal.turnId,
        toolCallId: proposal.toolCallId,
        version: proposal.version,
      };
      await resolvePlan(
        action === "approve"
          ? {
              ...identity,
              action,
              targetPermissionMode:
                targetPermissionMode ?? PLAN_APPROVAL_DEFAULT_MODE,
            }
          : { ...identity, action },
      );
      focusComposer();
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), {
        variant: "error",
      });
      setResolving(false);
    }
  };

  const openArtifact = () => {
    if (!artifactPath) return;
    openWorkPanelTabForSession(
      proposal.sessionId,
      fileWorkPanelTab(artifactPath),
    );
  };

  const onMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setMenuOpen(false);
      requestAnimationFrame(() => chevronRef.current?.focus());
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      const target = event.target as HTMLElement;
      const mode = target.closest<HTMLButtonElement>(
        '[data-approval-mode]',
      )?.dataset.approvalMode;
      if (isApprovalMode(mode)) {
        event.preventDefault();
        setApprovalMode(mode);
        void resolve("approve", mode);
      }
      return;
    }
    if (!(["ArrowDown", "ArrowUp", "Home", "End"] as string[]).includes(event.key)) {
      return;
    }
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>(
        '[role="menuitemradio"]',
      ) ?? [],
    );
    if (!items.length) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    let next = current;
    if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    else if (event.key === "ArrowDown") {
      next = current < 0 ? 0 : (current + 1) % items.length;
    } else if (event.key === "ArrowUp") {
      next = current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length;
    }
    items[next]?.focus();
  };

  return (
    <section
      className="plan-approval-bar"
      role="region"
      aria-label={copy("approvalRegion")}
      aria-busy={busy}
      data-kind={kind}
      data-status={proposal.status}
      data-execution-state={proposal.executionState || ""}
      data-testid="plan-approval-bar"
    >
      <span className="sr-only" role="status" aria-live="polite">
        {copy("readyAnnouncement")}
      </span>
      <div className="plan-approval-copy">
        <h2 className="plan-approval-title">
          {proposal.title.trim() || copy("untitled")}
        </h2>
        <div className="plan-approval-details">
          {artifactPath ? (
            <button
              type="button"
              className="plan-approval-artifact"
              data-testid="plan-open-artifact"
              aria-label={t(copyKey(kind, "openArtifactLabel"), {
                path: artifactPath,
              })}
              title={artifactPath}
              onClick={openArtifact}
            >
              <IconFileText size={14} aria-hidden />
              <span className="plan-approval-artifact-label">
                {copy("openArtifact")}
              </span>
              <span className="plan-approval-artifact-path">
                {artifactPath}
              </span>
            </button>
          ) : null}
        </div>
      </div>
      {isPending ? (
        <div className="plan-approval-actions">
          <button
            type="button"
            className="plan-approval-reject"
            disabled={busy}
            onClick={() => void resolve("reject")}
          >
            {copy("reject")}
          </button>
          <div
            ref={menuRef}
            className="plan-approval-split"
            onKeyDown={onMenuKeyDown}
          >
            <button
              type="button"
              className="plan-approval-approve-main"
              disabled={busy}
              aria-label={copy(APPROVE_LABELS[approvalMode])}
              onClick={() => void resolve("approve", approvalMode)}
            >
              {resolving
                ? copy("approving")
                : copy(APPROVE_LABELS[approvalMode])}
            </button>
            <button
              ref={chevronRef}
              type="button"
              className="plan-approval-approve-menu"
              disabled={busy}
              aria-label={copy("chooseApprovalMode")}
              title={copy("chooseApprovalMode")}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
            >
              <IconChevronDown size={13} aria-hidden />
            </button>
            {menuOpen ? (
              <div
                className="plan-approval-menu"
                role="menu"
                aria-label={copy("chooseApprovalMode")}
              >
                {APPROVAL_MODES.map((candidate) => (
                  <button
                    key={candidate}
                    type="button"
                    className="plan-approval-menu-item"
                    role="menuitemradio"
                    aria-checked={approvalMode === candidate}
                    data-approval-mode={candidate}
                    disabled={busy}
                    onClick={() => {
                      setApprovalMode(candidate);
                      void resolve("approve", candidate);
                    }}
                  >
                    <span>{copy(APPROVAL_MODE_LABELS[candidate])}</span>
                    {approvalMode === candidate ? (
                      <IconCheck size={13} aria-hidden />
                    ) : null}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}
