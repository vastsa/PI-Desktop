/**
 * Byte size formatting for UI and CLI surfaces.
 *
 * Sizes step in binary (`1024`) but keep the customary `KB` / `MB` / `GB`
 * labels the product has always shown. Callers choose the fraction digits
 * per step because the existing surfaces deliberately differ: a file viewer
 * can afford one decimal on `MB`, a download progress readout uses two.
 */

export const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

export type ByteUnit = (typeof BYTE_UNITS)[number];

type ScaledByteUnit = Exclude<ByteUnit, "B">;

/** Per-unit defaults; two decimals keep neighbouring rows distinguishable. */
export const DEFAULT_BYTE_DECIMALS: Record<ScaledByteUnit, number> = {
  KB: 1,
  MB: 2,
  GB: 2,
  TB: 2,
};

export interface FormatBytesOptions {
  /**
   * Fraction digits per unit. A number applies to every unit above `B`; an
   * object sets them per unit and falls back to `DEFAULT_BYTE_DECIMALS` for
   * units it omits.
   */
  decimals?: number | Partial<Record<ScaledByteUnit, number>>;
  /** Largest unit to climb to. Defaults to `TB`. */
  maxUnit?: ByteUnit;
  /** Render whole bytes rounded instead of truncated. Defaults to `false`. */
  roundBytes?: boolean;
}

function unitIndex(bytes: number, maxIndex: number): number {
  let index = 0;
  while (index < maxIndex && Math.abs(bytes) >= 1024 ** (index + 1)) {
    index += 1;
  }
  return index;
}

function decimalsFor(
  unit: ScaledByteUnit,
  decimals: FormatBytesOptions["decimals"],
): number {
  const fallback = DEFAULT_BYTE_DECIMALS[unit];
  const configured =
    typeof decimals === "number" ? decimals : decimals?.[unit];
  if (configured === undefined || !Number.isInteger(configured)) {
    return fallback;
  }
  return configured >= 0 ? configured : fallback;
}

/**
 * Format a byte count as `512 B`, `1.5 KB`, `2.00 MB`.
 *
 * Non-finite input is treated as `0` so a missing size never renders as
 * `NaN KB`. A value above the largest unit stays in that unit (`2048 TB`)
 * rather than dropping the number. Negative sizes keep their sign and pick
 * the unit from their magnitude; callers that treat them as unknown should
 * short-circuit before calling.
 */
export function formatBytes(
  bytes: number,
  options: FormatBytesOptions = {},
): string {
  const maxIndex = Math.max(0, BYTE_UNITS.indexOf(options.maxUnit ?? "TB"));
  const size = Number.isFinite(bytes) ? bytes : 0;
  const index = unitIndex(size, maxIndex);

  if (index === 0) {
    const shown = options.roundBytes ? Math.round(size) : Math.trunc(size);
    return `${shown} B`;
  }

  const unit = BYTE_UNITS[index] as ScaledByteUnit;
  return `${(size / 1024 ** index).toFixed(decimalsFor(unit, options.decimals))} ${unit}`;
}
