import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { PullRequestSummary } from "@pi-desktop/shared";
import { useAppStore } from "../stores/app-store";
import { api } from "../lib/api";
import { Badge, Button, Panel } from "../components/ui";
import { IconExternal, IconPullRequest } from "../components/icons";

type Filter = "open" | "draft" | "all";

export function PullRequestsPage() {
  const { t } = useTranslation();
  const workspace = useAppStore((s) => s.workspace);
  const openProject = useAppStore((s) => s.openProject);
  const newSession = useAppStore((s) => s.newSession);
  const setPage = useAppStore((s) => s.setPage);
  const sendPrompt = useAppStore((s) => s.sendPrompt);
  const [pulls, setPulls] = useState<PullRequestSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<Filter>("open");

  const refresh = async () => {
    setLoading(true);
    try {
      const res = await api.listPullRequests();
      setPulls(res.pulls || []);
      setError(res.error || null);
    } catch (e) {
      setPulls([]);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, [workspace?.path]);

  const filtered = useMemo(() => {
    if (filter === "all") return pulls;
    if (filter === "draft") return pulls.filter((p) => p.isDraft);
    return pulls.filter((p) => !p.isDraft);
  }, [pulls, filter]);

  const counts = useMemo(() => {
    const draft = pulls.filter((p) => p.isDraft).length;
    return {
      open: pulls.length - draft,
      draft,
      all: pulls.length,
    };
  }, [pulls]);

  return (
    <div className="thread-scroll">
      <div className="page-frame">
        <div className="page-header">
          <div>
            <h1 className="page-title">{t("pulls.title")}</h1>
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" disabled={loading} onClick={() => void refresh()}>
              {loading ? "…" : t("pulls.refresh")}
            </Button>
            {workspace?.path ? (
              <Button
                variant="primary"
                onClick={async () => {
                  await newSession();
                  setPage("chat");
                  await sendPrompt(
                    "List open pull requests and current branch status for this repository. Summarize what needs review.",
                  );
                }}
              >
                {t("pulls.review")}
              </Button>
            ) : null}
          </div>
        </div>

        {workspace?.path ? (
          <div className="dest-toolbar">
            <div className="dest-filters" role="tablist" aria-label={t("pulls.filters")}>
              {(
                [
                  ["open", t("pulls.filterOpen"), counts.open],
                  ["draft", t("pulls.filterDraft"), counts.draft],
                  ["all", t("pulls.filterAll"), counts.all],
                ] as const
              ).map(([id, label, count]) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={filter === id}
                  className={`dest-filter ${filter === id ? "active" : ""}`}
                  onClick={() => setFilter(id)}
                >
                  {label}
                  <span className="ml-1 text-text-muted">{count}</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {!workspace?.path ? (
          <Panel className="page-card page-empty">
            <div className="page-empty-icon">
              <IconPullRequest size={20} />
            </div>
            <div className="text-base-plus font-medium">{t("pulls.emptyTitle")}</div>
            <Button className="mt-5" variant="primary" onClick={() => void openProject()}>
              {t("project.open")}
            </Button>
          </Panel>
        ) : filtered.length === 0 ? (
          <Panel className="page-card page-empty">
            <div className="page-empty-icon">
              <IconPullRequest size={20} />
            </div>
            <div className="text-base-plus font-medium">{t("pulls.emptyTitle")}</div>
            {error && error !== "NO_WORKSPACE" ? (
              <div className="mt-2 max-w-md text-md text-text-secondary">{error}</div>
            ) : null}
          </Panel>
        ) : (
          <div className="dest-list">
            {filtered.map((pr) => (
              <div key={pr.number} className="dest-row">
                <div className="dest-row-icon">
                  <IconPullRequest size={16} />
                </div>
                <div className="dest-row-body">
                  <div className="dest-row-title">
                    <span className="font-mono text-sm font-normal text-text-muted">
                      #{pr.number}
                    </span>
                    <span className="min-w-0 truncate">{pr.title}</span>
                    {pr.isDraft ? <Badge tone="warning">{t("pulls.draft")}</Badge> : (
                      <Badge tone="success">{t("pulls.open")}</Badge>
                    )}
                  </div>
                  <div className="dest-row-meta">
                    {[
                      pr.author,
                      pr.headRefName && pr.baseRefName
                        ? `${pr.headRefName} → ${pr.baseRefName}`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                </div>
                <div className="dest-row-actions">
                  <button
                    type="button"
                    className="icon-btn"
                    title={pr.url}
                    onClick={() => window.open(pr.url, "_blank")}
                  >
                    <IconExternal size={15} />
                  </button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={async () => {
                      await newSession();
                      setPage("chat");
                      await sendPrompt(
                        `Review pull request #${pr.number}${pr.title ? ` (${pr.title})` : ""}. Summarize changes, risks, and suggested next steps.`,
                      );
                    }}
                  >
                    {t("pulls.review")}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
