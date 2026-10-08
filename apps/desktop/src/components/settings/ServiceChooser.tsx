/**
 * Where a new AI service starts: every way to connect, on one searchable page
 * (D625).
 *
 * The old form opened on a closed Service menu, and subscriptions had their
 * own button and dialog further down the page, so the first decision was
 * where to look rather than what to connect. Subscriptions and API-key
 * services now sit side by side as tiles; the custom endpoint leads its
 * group, because it is the one choice that needs no preset found first.
 * Filtering never talks to the host.
 */
import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import type { OAuthVendor } from "@pi-desktop/shared";
import { cx, Input, TooltipButton } from "../ui";
import { IconPlus, IconSearch } from "../icons";
import { ServiceMonogram } from "./ServiceMonogram";
import {
  CUSTOM_SERVICE,
  customServiceOption,
  filterServiceOptions,
  jevServiceOption,
  namedServiceOptions,
  type PluginProviderServiceOption,
} from "./service-catalog";

export type ServiceChooserProps = {
  /** Vendors that sign in with an account; absent or empty hides the group. */
  vendors?: readonly OAuthVendor[] | null;
  /** The service the form was showing, marked when the user comes back. */
  current?: string;
  disabled?: boolean;
  onPickService: (id: string) => void;
  onPickSubscription?: (vendor: OAuthVendor) => void;
  /** Offers the classifier group; a new service, never an existing row. */
  showClassifiers?: boolean;
  /** API-key providers contributed by enabled plugins, grouped by category. */
  pluginProviders?: readonly PluginProviderServiceOption[];
  /** Selects an existing plugin-owned provider row for key setup. */
  onPickPluginProvider?: (providerId: string, pluginName: string) => void;
};

type SubscriptionOption = { vendor: OAuthVendor; haystack: string };

const TILE_SELECTOR = "[data-service-tile]";

export function ServiceChooser({
  vendors,
  current,
  disabled = false,
  onPickService,
  onPickSubscription,
  showClassifiers = false,
  pluginProviders = [],
  onPickPluginProvider,
}: ServiceChooserProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  const serviceOptions = useMemo(
    () => [customServiceOption(t), ...namedServiceOptions(t)],
    [t],
  );
  const subscriptionOptions = useMemo<SubscriptionOption[]>(
    () =>
      onPickSubscription && vendors
        ? vendors.map((vendor) => ({
            vendor,
            haystack:
              `${vendor.name} ${vendor.loginLabel ?? ""} ${vendor.vendorId}`.toLowerCase(),
          }))
        : [],
    [onPickSubscription, vendors],
  );

  // Jev is offered where a service is added: an existing row cannot be turned
  // into a classifier, so this group stays out of that flow.
  const classifierOptions = useMemo(
    () => (showClassifiers ? [jevServiceOption(t)] : []),
    [showClassifiers, t],
  );

  const visibleServices = useMemo(
    () => filterServiceOptions(serviceOptions, query),
    [query, serviceOptions],
  );
  const visibleSubscriptions = useMemo(
    () => filterServiceOptions(subscriptionOptions, query),
    [query, subscriptionOptions],
  );
  const visibleClassifiers = useMemo(
    () => filterServiceOptions(classifierOptions, query),
    [classifierOptions, query],
  );
  const visiblePluginProviders = useMemo(
    () => filterServiceOptions(pluginProviders, query),
    [pluginProviders, query],
  );
  const pluginProviderGroups = useMemo(() => {
    const groups = new Map<string, PluginProviderServiceOption[]>();
    for (const option of visiblePluginProviders) {
      const group = groups.get(option.category) ?? [];
      group.push(option);
      groups.set(option.category, group);
    }
    return [...groups].map(([category, options]) => ({ category, options }));
  }, [visiblePluginProviders]);
  const nothingMatches =
    visibleServices.length === 0 &&
    visibleSubscriptions.length === 0 &&
    visibleClassifiers.length === 0 &&
    visiblePluginProviders.length === 0;

  // Enter prefers a service the pick only moves to the key field for: the
  // classifier keeps the same dialog, while a subscription leaves it.
  const enterTarget = query.trim()
    ? visibleServices[0]
      ? `service:${visibleServices[0].id}`
      : visiblePluginProviders[0]
        ? `plugin:${visiblePluginProviders[0].id}`
        : visibleClassifiers[0]
        ? `service:${visibleClassifiers[0].id}`
        : visibleSubscriptions[0]
          ? `subscription:${visibleSubscriptions[0].vendor.vendorId}`
          : ""
    : "";

  const pickService = (id: string) => {
    if (!disabled) onPickService(id);
  };
  const pickPluginProvider = (providerId: string) => {
    const option = visiblePluginProviders.find((candidate) => candidate.id === providerId);
    if (!disabled && option) onPickPluginProvider?.(providerId, option.pluginName);
  };
  const pickSubscription = (vendor: OAuthVendor) => {
    if (!disabled) onPickSubscription?.(vendor);
  };

  const pickEnterTarget = () => {
    if (visibleServices[0]) pickService(visibleServices[0].id);
    else if (visiblePluginProviders[0]) pickPluginProvider(visiblePluginProviders[0].id);
    else if (visibleClassifiers[0]) pickService(visibleClassifiers[0].id);
    else if (visibleSubscriptions[0]) pickSubscription(visibleSubscriptions[0].vendor);
    else pickService(CUSTOM_SERVICE);
  };

  const tiles = () => [
    ...(gridRef.current?.querySelectorAll<HTMLButtonElement>(TILE_SELECTOR) ?? []),
  ];

  /**
   * Left and right walk the tiles in reading order; up and down go to the
   * nearest tile in the row above or below, so the grid keeps its columns at
   * any width. Up from the first row returns to the search field.
   */
  const onTileKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const all = tiles();
    const index = all.indexOf(event.currentTarget);
    if (index === -1) return;
    let next: HTMLButtonElement | undefined;
    if (event.key === "ArrowRight") next = all[index + 1];
    else if (event.key === "ArrowLeft") next = all[index - 1];
    else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const down = event.key === "ArrowDown";
      const origin = event.currentTarget.getBoundingClientRect();
      const originX = origin.left + origin.width / 2;
      let bestScore = Number.POSITIVE_INFINITY;
      for (const tile of all) {
        const box = tile.getBoundingClientRect();
        const rowGap = down ? box.top - origin.bottom : origin.top - box.bottom;
        if (rowGap < -1) continue;
        const score = rowGap * 1000 + Math.abs(box.left + box.width / 2 - originX);
        if (score < bestScore) {
          bestScore = score;
          next = tile;
        }
      }
      if (!next && !down) {
        event.preventDefault();
        searchRef.current?.focus();
        return;
      }
    } else return;
    if (!next) return;
    event.preventDefault();
    next.focus();
  };

  return (
    <div className="service-chooser">
      <div className="service-chooser-search">
        <IconSearch size={14} aria-hidden />
        <Input
          ref={searchRef}
          value={query}
          autoFocus
          autoComplete="off"
          disabled={disabled}
          placeholder={t("settings.searchService")}
          aria-label={t("settings.searchService")}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              pickEnterTarget();
            } else if (event.key === "ArrowDown") {
              event.preventDefault();
              tiles()[0]?.focus();
            }
          }}
        />
      </div>

      <div className="service-chooser-groups" ref={gridRef}>
        {nothingMatches ? (
          <div className="service-chooser-empty">
            <span>{t("settings.noServiceMatches")}</span>
            <button
              type="button"
              className="service-chooser-empty-action"
              disabled={disabled}
              onClick={() => pickService(CUSTOM_SERVICE)}
            >
              {t("settings.useCustomEndpoint")}
            </button>
          </div>
        ) : null}

        {visibleSubscriptions.length > 0 ? (
          <section className="service-chooser-group" aria-labelledby="service-chooser-subscriptions">
            <h4 id="service-chooser-subscriptions" className="service-chooser-group-title">
              {t("settings.chooserSubscriptions")}
            </h4>
            <div className="service-chooser-grid">
              {/* Every OAuth-capable vendor; existing accounts do not disable a
                  vendor, because one vendor can hold several accounts. */}
              {visibleSubscriptions.map(({ vendor }) => {
                const detail = vendor.loginLabel ||
                  (vendor.isSubscription ? t("settings.vendorSubscription") : "");
                const existing = vendor.accounts.length > 0
                  ? t("settings.vendorExistingAccounts", { count: vendor.accounts.length })
                  : "";
                return (
                  <button
                    key={vendor.vendorId}
                    type="button"
                    data-service-tile
                    data-subscription-vendor-id={vendor.vendorId}
                    className={cx(
                      "service-chooser-tile",
                      enterTarget === `subscription:${vendor.vendorId}` && "is-active",
                    )}
                    disabled={disabled}
                    onKeyDown={onTileKeyDown}
                    onClick={() => pickSubscription(vendor)}
                  >
                    <ServiceMonogram name={vendor.name} />
                    <span className="service-chooser-tile-copy">
                      <span className="service-chooser-tile-name">{vendor.name}</span>
                      {detail || existing ? (
                        <span className="service-chooser-tile-detail">
                          {[detail, existing].filter(Boolean).join(" · ")}
                        </span>
                      ) : null}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        ) : null}

        {visibleServices.length > 0 ? (
          <section className="service-chooser-group" aria-labelledby="service-chooser-api-keys">
            <h4 id="service-chooser-api-keys" className="service-chooser-group-title">
              {t("settings.chooserApiKeys")}
            </h4>
            <div className="service-chooser-grid">
              {visibleServices.map((option) => {
                const isCustom = option.id === CUSTOM_SERVICE;
                return (
                  <button
                    key={option.id}
                    type="button"
                    data-service-tile
                    data-service-id={option.id}
                    className={cx(
                      "service-chooser-tile",
                      enterTarget === `service:${option.id}` && "is-active",
                    )}
                    aria-current={option.id === current ? "true" : undefined}
                    disabled={disabled}
                    onKeyDown={onTileKeyDown}
                    onClick={() => pickService(option.id)}
                  >
                    {isCustom ? (
                      <span className="service-monogram" aria-hidden>
                        <IconPlus size={14} />
                      </span>
                    ) : (
                      <ServiceMonogram name={option.label} />
                    )}
                    <span className="service-chooser-tile-copy">
                      <span className="service-chooser-tile-name">{option.label}</span>
                      <span className="service-chooser-tile-detail">
                        {isCustom ? t("settings.customEndpointDesc") : option.endpoint}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        ) : null}

        {pluginProviderGroups.map(({ category, options }, index) => (
          <section
            key={`${category}-${index}`}
            className="service-chooser-group"
            aria-labelledby={`service-chooser-plugin-category-${index}`}
            data-plugin-provider-category={category}
          >
            <h4
              id={`service-chooser-plugin-category-${index}`}
              className="service-chooser-group-title"
            >
              {category}
            </h4>
            <div className="service-chooser-grid">
              {options.map((option) => (
                <TooltipButton
                  key={option.id}
                  type="button"
                  data-service-tile
                  data-plugin-provider-id={option.id}
                  tooltip={option.description}
                  tooltipClassName="ui-tooltip-help"
                  ariaLabel={option.label}
                  aria-description={option.description || undefined}
                  className={cx(
                    "service-chooser-tile",
                    enterTarget === `plugin:${option.id}` && "is-active",
                  )}
                  disabled={disabled || !onPickPluginProvider}
                  onKeyDown={onTileKeyDown}
                  onClick={() => pickPluginProvider(option.id)}
                >
                  <ServiceMonogram name={option.label} />
                  <span className="service-chooser-tile-copy">
                    <span className="service-chooser-tile-name">{option.label}</span>
                  </span>
                </TooltipButton>
              ))}
            </div>
          </section>
        ))}

        {visibleClassifiers.length > 0 ? (
          <section className="service-chooser-group" aria-labelledby="service-chooser-classifiers">
            <h4 id="service-chooser-classifiers" className="service-chooser-group-title">
              {t("settings.chooserClassifiers")}
            </h4>
            <div className="service-chooser-grid">
              {/* A classifier answers structured questions rather than holding a
                  conversation: it carries a key and no model list. */}
              {visibleClassifiers.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  data-service-tile
                  data-service-id={option.id}
                  className={cx(
                    "service-chooser-tile",
                    enterTarget === `service:${option.id}` && "is-active",
                  )}
                  aria-current={option.id === current ? "true" : undefined}
                  disabled={disabled}
                  onKeyDown={onTileKeyDown}
                  onClick={() => pickService(option.id)}
                >
                  <ServiceMonogram name={option.label} />
                  <span className="service-chooser-tile-copy">
                    <span className="service-chooser-tile-name">{option.label}</span>
                    <span className="service-chooser-tile-detail">{option.endpoint}</span>
                  </span>
                </button>
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </div>
  );
}
