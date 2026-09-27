/** Pick which vendor to sign in to; the same vendor can be picked repeatedly. */
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import type { OAuthVendor } from "@pi-desktop/shared";
import { Button } from "../ui";

export function VendorPickerDialog({
  vendors,
  onPick,
  onClose,
}: {
  /** Every OAuth-capable vendor; existing accounts do not disable a vendor. */
  vendors: OAuthVendor[];
  onPick: (vendor: OAuthVendor) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="overlay provider-dialog-overlay" role="presentation">
      <div
        className="dialog oauth-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="vendor-picker-title"
      >
        <h3 id="vendor-picker-title" className="provider-dialog-title">
          {t("settings.vendorPickTitle")}
        </h3>
        <div className="oauth-status">{t("settings.vendorPickDesc")}</div>
        <div className="oauth-options">
          {vendors.map((vendor) => (
            <button
              key={vendor.vendorId}
              type="button"
              className="oauth-option"
              onClick={() => onPick(vendor)}
            >
              <span className="oauth-option-label">{vendor.name}</span>
              {/* The vendor's own call to action when it has one; otherwise
                  say whether this is a subscription rather than pay-per-use. */}
              {vendor.loginLabel || vendor.isSubscription ? (
                <span className="oauth-option-desc">
                  {vendor.loginLabel || t("settings.vendorSubscription")}
                  {vendor.accounts.length > 0
                    ? ` · ${t("settings.vendorExistingAccounts", {
                        count: vendor.accounts.length,
                      })}`
                    : ""}
                </span>
              ) : vendor.accounts.length > 0 ? (
                <span className="oauth-option-desc">
                  {t("settings.vendorExistingAccounts", {
                    count: vendor.accounts.length,
                  })}
                </span>
              ) : null}
            </button>
          ))}
        </div>
        <div className="provider-dialog-actions">
          <Button variant="ghost" onClick={onClose}>
            {t("settings.cancel")}
          </Button>
        </div>
      </div>
    </div>
  );
}
