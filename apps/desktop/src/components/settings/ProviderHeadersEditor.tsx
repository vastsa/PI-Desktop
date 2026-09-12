import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { useTranslation } from "react-i18next";
import { APP_VERSION } from "@pi-desktop/shared";
import {
  KeyValueRows,
  pairsToRecord,
  type KeyValuePair,
} from "../extensions/KeyValueRows";
import { IconCheck, IconCopy } from "../icons";
import { Button, Select } from "../ui";

type HeaderPreset = {
  key: string;
  value: string;
};

const HEADER_PRESETS: HeaderPreset[] = [
  { key: "User-Agent", value: `pi-desktop/${APP_VERSION}` },
  { key: "X-Client-Name", value: "PI-Desktop" },
  { key: "X-Title", value: "PI-Desktop" },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseImportedHeaders(value: unknown): KeyValuePair[] {
  const source =
    isRecord(value) && isRecord(value.headers)
      ? value.headers
      : value;
  if (!isRecord(source)) throw new Error("invalid headers");

  return Object.entries(source).map(([key, headerValue]) => {
    if (typeof headerValue !== "string") throw new Error("invalid header value");
    return { key, value: headerValue };
  });
}

function mergeHeaderPairs(
  current: KeyValuePair[],
  imported: KeyValuePair[],
): KeyValuePair[] {
  const next = [...current];
  for (const pair of imported) {
    const existing = next.findIndex(
      (item) => item.key.trim().toLowerCase() === pair.key.trim().toLowerCase(),
    );
    if (existing === -1) next.push(pair);
    else if (!next[existing].value.trim()) next[existing] = pair;
  }
  return next;
}

export function ProviderHeadersEditor({
  pairs,
  onChange,
}: {
  pairs: KeyValuePair[];
  onChange: (next: KeyValuePair[]) => void;
}) {
  const { t } = useTranslation();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importError, setImportError] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(copyTimer.current), []);

  const addPreset = (key: string) => {
    const preset = HEADER_PRESETS.find((item) => item.key === key);
    if (!preset) return;
    const exists = pairs.some(
      (item) => item.key.trim().toLowerCase() === preset.key.toLowerCase(),
    );
    if (!exists) onChange([...pairs, preset]);
  };

  const copyHeaders = () => {
    void navigator.clipboard.writeText(JSON.stringify(pairsToRecord(pairs), null, 2)).then(
      () => {
        setCopied(true);
        window.clearTimeout(copyTimer.current);
        copyTimer.current = window.setTimeout(() => setCopied(false), 1500);
      },
      () => undefined,
    );
  };

  const importJson = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    try {
      const imported = parseImportedHeaders(JSON.parse(await file.text()));
      onChange(mergeHeaderPairs(pairs, imported));
      setImportError(false);
    } catch {
      setImportError(true);
    }
  };

  return (
    <div className="provider-setup-headers">
      <div className="provider-setup-headers-toolbar">
        <div className="provider-setup-headers-label">{t("settings.headers")}</div>
        <div className="provider-setup-headers-actions">
          <Select
            className="provider-setup-header-preset"
            aria-label={t("settings.addCommonHeader")}
            value=""
            onChange={(event) => addPreset(event.target.value)}
          >
            <option value="">{t("settings.addCommonHeader")}</option>
            {HEADER_PRESETS.map((preset) => (
              <option key={preset.key} value={preset.key}>
                {preset.key}
              </option>
            ))}
          </Select>
          <Button
            variant="ghost"
            size="sm"
            className="provider-setup-header-import"
            onClick={() => fileInputRef.current?.click()}
          >
            {t("settings.importHeadersJson")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className={`provider-setup-header-copy${copied ? " is-copied" : ""}`}
            onClick={copyHeaders}
            aria-label={
              copied ? t("settings.headersJsonCopied") : t("settings.copyHeadersJson")
            }
            title={
              copied ? t("settings.headersJsonCopied") : t("settings.copyHeadersJson")
            }
          >
            {copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
            {copied ? t("settings.headersJsonCopied") : t("settings.copyHeadersJson")}
          </Button>
          <input
            ref={fileInputRef}
            className="provider-setup-header-file"
            type="file"
            accept="application/json,.json"
            aria-label={t("settings.importHeadersJson")}
            onChange={(event) => void importJson(event)}
          />
        </div>
      </div>
      {importError ? (
        <div className="provider-setup-header-error" role="alert">
          {t("settings.headersImportError")}
        </div>
      ) : null}
      <div className="provider-setup-header-list">
        <KeyValueRows
          pairs={pairs}
          onChange={onChange}
          keyPlaceholder={t("settings.headerName")}
          valuePlaceholder={t("settings.headerValue")}
          addLabel={t("settings.addHeader")}
        />
      </div>
    </div>
  );
}
