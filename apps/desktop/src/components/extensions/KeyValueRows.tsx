import { useId } from "react";
import { useTranslation } from "react-i18next";
import { cx } from "../ui";
import { IconPlus, IconX } from "../icons";

export type KeyValuePair = { key: string; value: string };

/**
 * Editable key/value rows for MCP env vars and HTTP headers.
 *
 * A textarea of `KEY=value` lines is cheaper to build and worse to use: it
 * offers no per-row delete, no alignment, and no way to mask a token. Rows keep
 * their own identity, so editing one credential never disturbs another.
 */
export function KeyValueRows({
  pairs,
  onChange,
  keyPlaceholder,
  valuePlaceholder,
  addLabel,
  secret,
}: {
  pairs: KeyValuePair[];
  onChange: (next: KeyValuePair[]) => void;
  keyPlaceholder: string;
  valuePlaceholder: string;
  addLabel: string;
  /** Masks values, for tokens the user would not want shoulder-surfed. */
  secret?: boolean;
}) {
  const { t } = useTranslation();
  const groupId = useId();

  const setAt = (index: number, patch: Partial<KeyValuePair>) => {
    onChange(pairs.map((pair, i) => (i === index ? { ...pair, ...patch } : pair)));
  };

  return (
    <div className="kv-rows">
      {pairs.map((pair, index) => (
        <div className="kv-row" key={`${groupId}-${index}`}>
          <input
            className="field-input kv-key"
            value={pair.key}
            placeholder={keyPlaceholder}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            aria-label={keyPlaceholder}
            onChange={(event) => setAt(index, { key: event.target.value })}
          />
          <input
            className="field-input kv-value"
            value={pair.value}
            type={secret ? "password" : "text"}
            placeholder={valuePlaceholder}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            aria-label={valuePlaceholder}
            onChange={(event) => setAt(index, { value: event.target.value })}
          />
          <button
            type="button"
            className="kv-remove"
            aria-label={t("extensions.mcp.removeRow")}
            title={t("extensions.mcp.removeRow")}
            onClick={() => onChange(pairs.filter((_, i) => i !== index))}
          >
            <IconX size={12} />
          </button>
        </div>
      ))}
      <button
        type="button"
        className={cx("kv-add", pairs.length === 0 && "is-first")}
        onClick={() => onChange([...pairs, { key: "", value: "" }])}
      >
        <IconPlus size={12} />
        {addLabel}
      </button>
    </div>
  );
}

/** Drops blank rows and collapses duplicates, last write winning. */
export function pairsToRecord(pairs: readonly KeyValuePair[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of pairs) {
    const key = pair.key.trim();
    if (!key) continue;
    out[key] = pair.value;
  }
  return out;
}

export function recordToPairs(record: Record<string, string> | undefined): KeyValuePair[] {
  return Object.entries(record ?? {}).map(([key, value]) => ({ key, value }));
}
