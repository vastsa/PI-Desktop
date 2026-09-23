import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  allowInsecureUserEndpoints,
  assembleSkillInstall,
  BUILTIN_SKILL_CATALOG,
  GLOBAL_SCOPE,
  isSafeSkillSourceUrl,
  mergeSkillEntries,
  sanitizeSkillSources,
  validateSkillCatalogFile,
  type SkillCatalogCategory,
  type SkillCatalogEntry,
  type SkillMarketSource,
} from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import {
  IconBookOpen,
  IconChevronLeft,
  IconChevronRight,
  IconCode,
  IconDatabase,
  IconFileText,
  IconListChecks,
  IconX,
} from "../icons";
import { Field, Input, TooltipButton, cx } from "../ui";
import { LatestWinsGate } from "../../lib/latest-wins";
import {
  classifySkillMarketFailure,
  hasFakeIpFailure,
  hasPolicyFailure,
  hasUnresolvedFailure,
  skillMarketFailureDetail,
  type SkillMarketFailureKind,
} from "../../lib/skill-market-failure";

const CATEGORIES: readonly SkillCatalogCategory[] = [
  "workflow",
  "writing",
  "coding",
  "data",
  "docs",
];

/** Cards render in a scrolling settings pane, so the list is paginated. */
const PAGE_SIZE = 24;

const { skills } = validateSkillCatalogFile(BUILTIN_SKILL_CATALOG).catalog;

const CATEGORY_ICONS: Record<SkillCatalogCategory, typeof IconListChecks> = {
  workflow: IconListChecks,
  writing: IconFileText,
  coding: IconCode,
  data: IconDatabase,
  docs: IconBookOpen,
};

function CategoryGlyph({ entry, size }: { entry: SkillCatalogEntry; size: number }) {
  const category = entry.categories?.[0];
  const Icon = (category && CATEGORY_ICONS[category]) || IconFileText;
  return <Icon size={size} />;
}

type MarketItem = SkillCatalogEntry & { sourceId?: string };

/**
 * The part of a failed source's detail the list renders: the host the guard was
 * classifying, the guard's own reason, and the class of address it refused. The
 * main process sends these so the panel can name the refused host instead of
 * only the source label — a policy refusal is a statement about one address
 * (issue #419). The address itself is never sent.
 */
type RemoteFailureDetail = {
  host?: string;
  address?: string;
  reason?: string;
  addressKind?: string;
};

type RemoteState = {
  status: "idle" | "loading" | "ready" | "error";
  entries: MarketItem[];
  failed: string[];
  /** Why each named source failed, so a policy/DNS refusal can be explained. */
  failureKinds: Record<string, SkillMarketFailureKind>;
  /** Which host each of those names points at, so the refusal can name it. */
  failureDetails: Record<string, RemoteFailureDetail>;
  /**
   * Query-level failure reason (bridge or preload unavailable). Such a rejection
   * carries no per-source detail, and it used to be discarded with no trace.
   */
  queryError: string;
};

const REMOTE_IDLE: RemoteState = {
  status: "idle",
  entries: [],
  failed: [],
  failureKinds: {},
  failureDetails: {},
  queryError: "",
};

const SOURCES_STORAGE_KEY = "pi.skill-market.sources.v1";

function loadSources(allowInsecureHttp = false): SkillMarketSource[] {
  try {
    const raw = window.localStorage?.getItem(SOURCES_STORAGE_KEY);
    return raw ? sanitizeSkillSources(JSON.parse(raw), { allowInsecureHttp }) : [];
  } catch {
    return [];
  }
}

// Curated defaults: each repo is auto-scanned, so every SKILL.md on its
// default branch becomes an installable entry and the catalogs grow with the
// repos. All seven were verified to publish SKILL.md files at scan time.
const DEFAULT_SKILL_SOURCES: SkillMarketSource[] = [
  { id: "anthropics-skills", name: "anthropics/skills", url: "https://github.com/anthropics/skills" },
  { id: "anthropics-plugins", name: "anthropics/claude-plugins-official", url: "https://github.com/anthropics/claude-plugins-official" },
  { id: "obra-superpowers", name: "obra/superpowers", url: "https://github.com/obra/superpowers" },
  { id: "wshobson-agents", name: "wshobson/agents", url: "https://github.com/wshobson/agents" },
  { id: "mattpocock-skills", name: "mattpocock/skills", url: "https://github.com/mattpocock/skills" },
  { id: "alirezarezvani-skills", name: "alirezarezvani/claude-skills", url: "https://github.com/alirezarezvani/claude-skills" },
  { id: "composio-awesome", name: "ComposioHQ/awesome-claude-skills", url: "https://github.com/ComposioHQ/awesome-claude-skills" },
];

function saveSources(sources: SkillMarketSource[]): void {
  try {
    window.localStorage?.setItem(SOURCES_STORAGE_KEY, JSON.stringify(sources));
  } catch {
    // Persistence is best-effort; the list stays alive for this session.
  }
}

/**
 * The market view of the skills settings page: browse catalog sources, install
 * with one click. An install only ever produces a regular user skill through
 * the existing create path, and the full document is previewed before
 * anything is saved.
 */
export function SkillMarketPanel({
  installedIds,
  onBack,
  onInstalled,
}: {
  installedIds: readonly string[];
  onBack: () => void;
  onInstalled: (id: string) => void;
}) {
  const { t } = useTranslation();
  const showToast = useAppStore((state) => state.showToast);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<"all" | SkillCatalogCategory>("all");
  const [page, setPage] = useState(1);
  const [jump, setJump] = useState("");
  const [installFor, setInstallFor] = useState<MarketItem | null>(null);
  const [documentBody, setDocumentBody] = useState<string | null>(null);
  const [documentTooLarge, setDocumentTooLarge] = useState(false);
  const [previewFailure, setPreviewFailure] = useState<{
    kind: SkillMarketFailureKind;
    detail: string;
  } | null>(null);
  const [installing, setInstalling] = useState(false);
  const previewGate = useRef(new LatestWinsGate());
  const [sources, setSources] = useState<SkillMarketSource[]>(loadSources);
  // Whether a plaintext hop to a user-supplied source is allowed, from the
  // stored `networkPolicy`: the panel re-validates its persisted list with the
  // same rule the main process applies to the request.
  const [allowInsecureSources, setAllowInsecureSources] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [draftSource, setDraftSource] = useState<{ name: string; url: string }>({
    name: "",
    url: "",
  });
  const [remote, setRemote] = useState<RemoteState>(REMOTE_IDLE);

  useEffect(() => {
    let cancelled = false;
    void api
      .getSettings()
      .then((settings) => {
        if (cancelled) return;
        const insecure = allowInsecureUserEndpoints(settings);
        setAllowInsecureSources(insecure);
        if (insecure) setSources(loadSources(true));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    saveSources(sources);
  }, [sources]);

  // Closing the sheet (cancel, overlay, X) must invalidate any in-flight
  // preview response so a slow A cannot land after reopen.
  useEffect(() => {
    if (!installFor) previewGate.current.invalidate();
  }, [installFor]);

  // Catalog sources are searched live (debounced); built-in picks render
  // immediately and stay as the offline floor when all sources are down.
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      setRemote((current) =>
        current.status === "idle" || current.status === "ready"
          ? {
              status: "loading",
              entries: current.entries,
              failed: current.failed,
              failureKinds: current.failureKinds,
              failureDetails: current.failureDetails,
              queryError: current.queryError,
            }
          : current,
      );
      api
        .searchSkillMarket(search, [...DEFAULT_SKILL_SOURCES, ...sources])
        .then((result) => {
          if (!cancelled) {
            const failed = result.failedSources ?? [];
            const entries = result.entries ?? [];
            setRemote({
              status: entries.length === 0 && failed.length > 0 ? "error" : "ready",
              entries,
              failed,
              failureKinds: result.failureKinds ?? {},
              failureDetails: result.failureDetails ?? {},
              queryError: "",
            });
          }
        })
        .catch((error: unknown) => {
          if (!cancelled) {
            setRemote({
              status: "error",
              entries: [],
              failed: [],
              failureKinds: {},
              failureDetails: {},
              queryError: skillMarketFailureDetail(error),
            });
          }
        });
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [search, sources]);

  const sourceName = (id?: string) =>
    id
      ? [...DEFAULT_SKILL_SOURCES, ...sources].find((source) => source.id === id)?.name
      : undefined;

  const visible = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    const matches = (entry: SkillCatalogEntry) => {
      if (category !== "all" && !(entry.categories ?? []).includes(category)) return false;
      if (!query) return true;
      return [entry.name, entry.description, entry.author]
        .filter(Boolean)
        .some((text) => text!.toLocaleLowerCase().includes(query));
    };
    return mergeSkillEntries(
      skills.filter(matches),
      remote.entries.filter(matches),
    ) as MarketItem[];
  }, [remote.entries, search, category]);

  const totalPages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const paged = useMemo(
    () => visible.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE),
    [visible, currentPage],
  );

  const loadDocument = (entry: MarketItem) => {
    const token = previewGate.current.begin();
    setDocumentBody(null);
    setDocumentTooLarge(false);
    setPreviewFailure(null);
    api
      .fetchSkillMarketDocument(entry)
      .then((document) => {
        if (!previewGate.current.isCurrent(token)) return;
        const assembled = assembleSkillInstall(document, entry);
        setDocumentBody(assembled.body);
        setDocumentTooLarge(assembled.tooLarge);
      })
      .catch((error: unknown) => {
        if (!previewGate.current.isCurrent(token)) return;
        // Swallowing this left the sheet on a null body, so the install button
        // sat disabled behind the word "Loading…" with no reason and no way to
        // try again — the dead end issue #419 reports.
        setPreviewFailure({
          kind: classifySkillMarketFailure(error),
          detail: skillMarketFailureDetail(error),
        });
      });
  };

  const openInstall = (entry: MarketItem) => {
    setInstallFor(entry);
    loadDocument(entry);
  };

  const retryPreview = () => {
    if (installFor) loadDocument(installFor);
  };

  const install = async () => {
    if (!installFor || installing) return;
    setInstalling(true);
    try {
      const document = await api.fetchSkillMarketDocument(installFor);
      const assembled = assembleSkillInstall(document, installFor);
      if (assembled.tooLarge) {
        setDocumentBody(assembled.body);
        setDocumentTooLarge(true);
        showToast(t("settings.sklm.documentTooLarge"), { variant: "error" });
        return;
      }
      const created = await api.createUserSkill({
        id: installFor.id,
        name: assembled.name,
        description: assembled.description,
        body: assembled.body,
        level: "global",
        scope: GLOBAL_SCOPE,
        enabled: true,
      });
      showToast(t("settings.sklm.installSuccess", { name: assembled.name }), {
        variant: "success",
      });
      onInstalled(created.skill?.id ?? installFor.id);
      setInstallFor(null);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setInstalling(false);
    }
  };

  const removeSource = (id: string) =>
    setSources((current) => current.filter((source) => source.id !== id));

  const addSource = () => {
    const url = draftSource.url.trim();
    if (!isSafeSkillSourceUrl(url, { allowInsecureHttp: allowInsecureSources })) {
      showToast(t("settings.sklm.sourceUnsafe"), { variant: "error" });
      return;
    }
    const fallbackName = url.replace(/^https:\/\//, "").split("/")[0] || url;
    setSources((current) => [
      ...current,
      { id: `custom-${Date.now().toString(36)}`, name: draftSource.name.trim() || fallbackName, url },
    ]);
    setDraftSource({ name: "", url: "" });
  };

  // A bare `remoteError` could not tell a policy refusal from a dead host, and
  // one `policy` bucket could not tell an address the guard *judged* from a
  // resolver that never answered — nor the target's own address from the fake-IP
  // placeholder a local proxy invents for it. The four now carry different copy,
  // and each failure names the host it is about.
  const remoteErrorText = () => {
    if (remote.queryError) return t("settings.sklm.remoteErrorQuery");
    if (hasPolicyFailure(remote.failureKinds)) return t("settings.sklm.remoteErrorPolicy");
    if (hasFakeIpFailure(remote.failureKinds)) return t("settings.sklm.remoteErrorFakeIp");
    if (hasUnresolvedFailure(remote.failureKinds)) return t("settings.sklm.remoteErrorUnresolved");
    return t("settings.sklm.remoteError");
  };

  /**
   * One label per failed source, naming the host the guard actually classified
   * when the main process reported one. A source label alone ("anthropics/skills")
   * cannot say what was refused, and for a refusal the host *is* the message.
   */
  const failedSourceLabels = () =>
    remote.failed.map((name) => {
      const host = remote.failureDetails[name]?.host;
      return host ? t("settings.sklm.failureSourceHost", { name, host }) : name;
    });

  /**
   * A refusal on a proxy-invented address is the one case where the fix is a
   * setting rather than a source. Naming both the host and the address turns
   * "the app blocked it" into "your proxy answered 198.18.0.1 for github.com",
   * which is what lets a user recognise fake-IP mode (issue #419). Falls back to
   * the plain sentence when the guard reported no address to show.
   */
  const fakeIpFailureText = () => {
    const name = remote.failed.find((entry) => remote.failureKinds[entry] === "fake-ip");
    const detail = name ? remote.failureDetails[name] : undefined;
    if (!detail?.host || !detail.address) return t("settings.sklm.fakeIpHintPlain");
    return t("settings.sklm.fakeIpHint", { host: detail.host, address: detail.address });
  };

  const sourcesSheet = sourcesOpen ? (
    <div
      className="overlay ext-sheet-overlay sklm-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) setSourcesOpen(false);
      }}
    >
      <div
        className="dialog ext-sheet sklm-sheet"
        role="dialog"
        aria-modal
        aria-labelledby="sklm-sources-title"
      >
        <div className="ext-sheet-head">
          <div>
            <h3 id="sklm-sources-title" className="ext-sheet-title">
              {t("settings.sklm.manageSources")}
            </h3>
            <p className="ext-sheet-sub">{t("settings.sklm.sourcesHint")}</p>
          </div>
          <TooltipButton
            type="button"
            className="ext-sheet-close"
            ariaLabel={t("common.close")}
            tooltip={t("common.close")}
            onClick={() => setSourcesOpen(false)}
          >
            <IconX size={14} />
          </TooltipButton>
        </div>

        <div className="ext-sheet-body">
          <ul className="sklm-source-list">
            {DEFAULT_SKILL_SOURCES.map((source) => (
              <li key={source.id} className="sklm-source">
                <span className="sklm-glyph is-coding" aria-hidden>
                  <IconCode size={16} />
                </span>
                <div className="sklm-source-body">
                  <span className="sklm-name">{source.name}</span>
                  <code className="sklm-cmd">{source.url}</code>
                </div>
                <span className="sklm-badge">GitHub</span>
              </li>
            ))}
            {sources.map((source) => (
              <li key={source.id} className="sklm-source">
                <span className="sklm-glyph is-docs" aria-hidden>
                  <IconBookOpen size={16} />
                </span>
                <div className="sklm-source-body">
                  <span className="sklm-name">{source.name}</span>
                  <code className="sklm-cmd">{source.url}</code>
                </div>
                <button
                  type="button"
                  className="sklm-install is-ghost"
                  onClick={() => removeSource(source.id)}
                >
                  {t("extensions.mcp.remove")}
                </button>
              </li>
            ))}
          </ul>

          <div className="sklm-source-form">
            <Input
              value={draftSource.name}
              placeholder={t("settings.sklm.namePlaceholder")}
              onChange={(event) =>
                setDraftSource((current) => ({ ...current, name: event.target.value }))
              }
            />
            <Input
              value={draftSource.url}
              placeholder={t("settings.sklm.urlHint")}
              onChange={(event) =>
                setDraftSource((current) => ({ ...current, url: event.target.value }))
              }
            />
            <button type="button" className="sklm-install" onClick={addSource}>
              {t("settings.sklm.addSource")}
            </button>
          </div>
        </div>

        <div className="ext-sheet-actions">
          <span className="ext-sheet-note">{t("settings.sklm.sheetNote")}</span>
          <div className="ext-sheet-actions-end">
            <button
              type="button"
              className="sklm-install is-ghost"
              onClick={() => setSourcesOpen(false)}
            >
              {t("common.close")}
            </button>
          </div>
        </div>
      </div>
    </div>
  ) : null;

  const installSheet = installFor ? (
    <div
      className="overlay ext-sheet-overlay sklm-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !installing) setInstallFor(null);
      }}
    >
      <div className="dialog ext-sheet sklm-sheet" role="dialog" aria-modal aria-labelledby="sklm-sheet-title">
        <div className="ext-sheet-head">
          <div className="sklm-sheet-head">
            <span
              className={cx("sklm-glyph", `is-${installFor.categories?.[0] ?? "docs"}`)}
              aria-hidden
            >
              <CategoryGlyph entry={installFor} size={18} />
            </span>
            <div>
              <h3 id="sklm-sheet-title" className="ext-sheet-title">
                {installFor.name}
              </h3>
              <p className="ext-sheet-sub">{installFor.description}</p>
            </div>
          </div>
          <TooltipButton
            type="button"
            className="ext-sheet-close"
            ariaLabel={t("common.close")}
            tooltip={t("common.close")}
            onClick={() => setInstallFor(null)}
          >
            <IconX size={14} />
          </TooltipButton>
        </div>

        <div className="ext-sheet-body">
          <div className="ext-field-group">
            <div className="ext-field-label">{t("settings.sklm.willInstall")}</div>
            <code className="sklm-cmd is-block">{installFor.url}</code>
          </div>

          <div className="ext-field-group">
            <div className="ext-field-label">{t("settings.sklm.preview")}</div>
            {previewFailure ? (
              <p className="sklm-note is-error" role="alert">
                {t(
                  previewFailure.kind === "policy"
                    ? "settings.sklm.previewPolicyError"
                    : previewFailure.kind === "fake-ip"
                      ? "settings.sklm.previewFakeIpError"
                      : previewFailure.kind === "unresolved"
                        ? "settings.sklm.previewResolveError"
                        : "settings.sklm.previewError",
                )}
              </p>
            ) : (
              <pre className="sklm-preview">{documentBody ?? t("common.loading")}</pre>
            )}
            {previewFailure?.kind === "policy" ? (
              <p className="sklm-note">{t("settings.sklm.proxyHint")}</p>
            ) : null}
            {previewFailure?.kind === "fake-ip" ? (
              <p className="sklm-note">{t("settings.sklm.fakeIpHintPlain")}</p>
            ) : null}
            {previewFailure?.kind === "unresolved" ? (
              <p className="sklm-note">{t("settings.sklm.dnsHint")}</p>
            ) : null}
            {previewFailure?.detail ? (
              <p className="sklm-note">
                <span className="sklm-note-label">{t("settings.sklm.failureDetail")}</span>
                {previewFailure.detail}
              </p>
            ) : null}
            {previewFailure ? (
              <button
                type="button"
                className="sklm-install is-ghost"
                onClick={retryPreview}
                disabled={installing}
              >
                {t("settings.sklm.retryPreview")}
              </button>
            ) : null}
            {documentTooLarge ? <p className="sklm-note">{t("settings.sklm.documentTooLarge")}</p> : null}
          </div>

          {installFor.notes ? (
            <p className="sklm-note">
              <span className="sklm-note-label">{t("settings.sklm.notes")}</span>
              {installFor.notes}
            </p>
          ) : null}
        </div>

        <div className="ext-sheet-actions">
          <span className="ext-sheet-note">{t("settings.sklm.sheetNote")}</span>
          <div className="ext-sheet-actions-end">
            <button
              type="button"
              className="sklm-install is-ghost"
              onClick={() => setInstallFor(null)}
              disabled={installing}
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className="sklm-install"
              onClick={() => void install()}
              disabled={installing || documentBody === null || documentTooLarge}
            >
              {installing ? t("common.saving") : t("settings.sklm.install")}
            </button>
          </div>
        </div>
      </div>
    </div>
  ) : null;

  return (
    <div className="sklm">
      <div className="sklm-head">
        <div className="sklm-head-copy">
          <button type="button" className="sklm-back" onClick={onBack}>
            <IconChevronLeft size={14} />
            {t("settings.sklm.back")}
          </button>
          <h3 className="sklm-title">{t("settings.sklm.title")}</h3>
          <p className="sklm-subtitle">{t("settings.sklm.subtitle")}</p>
        </div>
        <div className="sklm-head-actions">
          <button type="button" className="sklm-back" onClick={() => setSourcesOpen(true)}>
            {t("settings.sklm.manageSources")} ·{" "}
            {[...DEFAULT_SKILL_SOURCES, ...sources].length}
          </button>
        </div>
        <div className="sklm-search">
          <Input
            className="sklm-search-input"
            value={search}
            placeholder={t("settings.sklm.searchPlaceholder")}
            aria-label={t("settings.sklm.searchPlaceholder")}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
          />
        </div>
      </div>

      {remote.status === "loading" ? (
        <p className="sklm-status" role="status">
          {t("settings.sklm.remoteLoading")}
        </p>
      ) : null}
      {remote.status === "error" ? (
        <>
          <p className="sklm-status is-error" role="status">
            {remoteErrorText()}
          </p>
          {remote.failed.length ? (
            <p className="sklm-status">{failedSourceLabels().join(", ")}</p>
          ) : null}
          {remote.queryError ? (
            <p className="sklm-status">
              <span className="sklm-note-label">{t("settings.sklm.failureDetail")}</span>
              {remote.queryError}
            </p>
          ) : null}
          {hasPolicyFailure(remote.failureKinds) ? (
            <p className="sklm-status">{t("settings.sklm.proxyHint")}</p>
          ) : null}
          {hasFakeIpFailure(remote.failureKinds) ? (
            <p className="sklm-status">{fakeIpFailureText()}</p>
          ) : null}
          {hasUnresolvedFailure(remote.failureKinds) ? (
            <p className="sklm-status">{t("settings.sklm.dnsHint")}</p>
          ) : null}
        </>
      ) : null}
      {remote.status === "ready" && remote.failed.length ? (
        <>
          <p className="sklm-status">
            {t("settings.sklm.remotePartial", { names: failedSourceLabels().join(", ") })}
          </p>
          {hasPolicyFailure(remote.failureKinds) ? (
            <p className="sklm-status">{t("settings.sklm.proxyHint")}</p>
          ) : null}
          {hasFakeIpFailure(remote.failureKinds) ? (
            <p className="sklm-status">{fakeIpFailureText()}</p>
          ) : null}
          {hasUnresolvedFailure(remote.failureKinds) ? (
            <p className="sklm-status">{t("settings.sklm.dnsHint")}</p>
          ) : null}
        </>
      ) : null}

      <div className="sklm-cats" role="tablist" aria-label={t("settings.sklm.title")}>
        {(["all", ...CATEGORIES] as const).map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={category === id}
            className={cx("sklm-chip", category === id && "is-active")}
            onClick={() => {
              setCategory(id);
              setPage(1);
            }}
          >
            {id === "all"
              ? t("settings.sklm.categoryAll")
              : t(`settings.sklm.category.${id}`)}
          </button>
        ))}
      </div>

      <div className="sklm-list" role="list">
        {paged.length === 0 ? (
          <p className="sklm-empty">{t("settings.sklm.empty")}</p>
        ) : (
          paged.map((entry, index) => {
            const installed = installedIds.includes(entry.id);
            return (
              <article
                key={entry.id}
                role="listitem"
                className="sklm-card"
                style={{ "--stagger": Math.min(index, 8) } as CSSProperties}
              >
                <span
                  className={cx("sklm-glyph", `is-${entry.categories?.[0] ?? "docs"}`)}
                  aria-hidden
                >
                  <CategoryGlyph entry={entry} size={17} />
                </span>
                <div className="sklm-card-body">
                  <div className="sklm-card-title">
                    <span className="sklm-name">{entry.name}</span>
                    {entry.verified ? (
                      <span className="sklm-badge is-verified">
                        ✓ {t("settings.sklm.verified")}
                      </span>
                    ) : null}
                    {entry.sourceId ? (
                      <span className="sklm-badge is-remote">
                        {sourceName(entry.sourceId) ?? t("settings.sklm.remoteBadge")}
                      </span>
                    ) : null}
                    {(entry.categories ?? []).slice(0, 1).map((id) => (
                      <span key={id} className="sklm-badge">
                        {t(`settings.sklm.category.${id}`)}
                      </span>
                    ))}
                  </div>
                  <code className="sklm-cmd">{entry.author ?? entry.id}</code>
                  <p className="sklm-desc">{entry.description || ""}</p>
                </div>
                <div className="sklm-card-actions">
                  <button
                    type="button"
                    className={cx("sklm-install", installed && "is-installed")}
                    disabled={installed}
                    title={entry.homepage}
                    onClick={() => openInstall(entry)}
                  >
                    {installed
                      ? t("settings.sklm.installed")
                      : t("settings.sklm.install")}
                  </button>
                </div>
              </article>
            );
          })
        )}
      </div>

      {totalPages > 1 ? (
        <div className="sklm-pager">
          <button
            type="button"
            className="sklm-page-btn"
            disabled={currentPage <= 1}
            aria-label={t("settings.sklm.pagePrev")}
            onClick={() => setPage(currentPage - 1)}
          >
            <IconChevronLeft size={14} />
          </button>

          {(() => {
            const wanted = new Set<number>([1, 2, totalPages, totalPages - 1]);
            for (let p = currentPage - 2; p <= currentPage + 2; p += 1) {
              if (p >= 1 && p <= totalPages) wanted.add(p);
            }
            const ordered = [...wanted].sort((a, b) => a - b);
            const items: Array<number | "…"> = [];
            let previous = 0;
            for (const p of ordered) {
              if (p - previous > 1) items.push("…");
              items.push(p);
              previous = p;
            }
            return items.map((item, index) =>
              item === "…" ? (
                <span key={`gap-${index}`} className="sklm-page-ellipsis">
                  …
                </span>
              ) : (
                <button
                  key={item}
                  type="button"
                  className={cx("sklm-page-btn", item === currentPage && "is-active")}
                  onClick={() => setPage(item)}
                >
                  {item}
                </button>
              ),
            );
          })()}

          <span className="sklm-page-info">
            {t("settings.sklm.pageInfo", {
              page: currentPage,
              pages: totalPages,
              total: visible.length,
            })}
          </span>

          <input
            className="sklm-page-jump field-input"
            type="text"
            inputMode="numeric"
            value={jump}
            placeholder={String(currentPage)}
            aria-label={t("settings.sklm.pageJump")}
            onChange={(event) => setJump(event.target.value.replace(/\D/g, ""))}
            onKeyDown={(event) => {
              if (event.key === "Enter") doJump();
            }}
          />
          <button
            type="button"
            className="sklm-page-btn"
            disabled={currentPage >= totalPages}
            aria-label={t("settings.sklm.pageNext")}
            onClick={() => setPage(currentPage + 1)}
          >
            <IconChevronRight size={14} />
          </button>
        </div>
      ) : null}

      {/* The settings shell carries a transform, which would turn the
          overlay's `position: fixed` into shell-relative positioning — portal
          both sheets to <body> so they always cover the window. */}
      {installSheet && createPortal(installSheet, document.body)}
      {sourcesSheet && createPortal(sourcesSheet, document.body)}
    </div>
  );

  function doJump() {
    const target = Number.parseInt(jump, 10);
    if (Number.isNaN(target)) {
      setJump("");
      return;
    }
    setPage(Math.min(totalPages, Math.max(1, target)));
    setJump("");
  }
}
