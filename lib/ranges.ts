// FILE: lib/ranges.ts
// Purpose: Centralizes dashboard date ranges and RevenueCat resolution choices.
// Layer: Utility
// Exports: RANGE_OPTIONS, getRangeConfig, isPresetRangeKey
// Depends on: date-fns

import { format, subDays, subMonths } from "date-fns";

// "custom" is a free-form range driven by the date picker. It never appears
// in RANGE_OPTIONS (tabs) — only the picker writes it. Code that hydrates
// a key from a URL must call isPresetRangeKey() before trusting it as a tab.
export type RangeKey = "7d" | "28d" | "3m" | "6m" | "all" | "custom";

export type RangeConfig = {
  key: RangeKey;
  label: string;
  shortLabel: string;
  startDate?: string;
  endDate?: string;
  resolution: "0" | "1" | "2";
};

export type CustomRange = { from: string; to: string };

export const RANGE_OPTIONS: Array<Pick<RangeConfig, "key" | "label" | "shortLabel">> = [
  { key: "7d", label: "Last 7 days", shortLabel: "7D" },
  { key: "28d", label: "Last 28 days", shortLabel: "28D" },
  { key: "3m", label: "Last 3 months", shortLabel: "3M" },
  { key: "6m", label: "Last 6 months", shortLabel: "6M" },
  { key: "all", label: "All time", shortLabel: "All" }
];

export function isPresetRangeKey(value: string | null): value is Exclude<RangeKey, "custom"> {
  return value !== null && RANGE_OPTIONS.some((option) => option.key === value);
}

// ─── ENTRY POINT ─────────────────────────────────────────────

// Maps a range key to UTC date strings accepted by RevenueCat chart endpoints.
// For "custom" the caller must pass explicit `custom.from`/`custom.to` (yyyy-MM-dd);
// resolution is auto-picked from the span so we don't blow past RC's bucket limits.
export function getRangeConfig(key: RangeKey, custom?: CustomRange): RangeConfig {
  const today = new Date();
  const endDate = format(today, "yyyy-MM-dd");

  switch (key) {
    case "7d":
      return rangeWithStart(key, "Last 7 days", "7D", subDays(today, 6), endDate, "0");
    case "3m":
      return rangeWithStart(key, "Last 3 months", "3M", subMonths(today, 3), endDate, "1");
    case "6m":
      return rangeWithStart(key, "Last 6 months", "6M", subMonths(today, 6), endDate, "1");
    case "all":
      return {
        key,
        label: "All time",
        shortLabel: "All",
        resolution: "2"
      };
    case "custom":
      return buildCustomRange(custom);
    case "28d":
    default:
      return rangeWithStart("28d", "Last 28 days", "28D", subDays(today, 27), endDate, "0");
  }
}

// Custom ranges fall back to the 28-day default when the picker dates are
// missing (e.g. a `range=custom` URL with no `from`/`to` — could be a hand-edit).
// Better to render *something* sensible than fail the dashboard fetch entirely.
function buildCustomRange(custom?: CustomRange): RangeConfig {
  if (!custom?.from || !custom?.to) {
    const today = new Date();
    return rangeWithStart("28d", "Last 28 days", "28D", subDays(today, 27), format(today, "yyyy-MM-dd"), "0");
  }

  const start = new Date(`${custom.from}T00:00:00Z`);
  const end = new Date(`${custom.to}T00:00:00Z`);
  const days = Math.max(1, Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1);

  // Resolution heuristic mirrors the preset tabs: ≤45d daily, ≤180d weekly,
  // anything longer rolls up to monthly so RC doesn't return 365+ daily buckets.
  const resolution: RangeConfig["resolution"] = days <= 45 ? "0" : days <= 180 ? "1" : "2";

  const sameYear = start.getUTCFullYear() === end.getUTCFullYear();
  const sameMonth = sameYear && start.getUTCMonth() === end.getUTCMonth();
  const longLabel = `${format(start, "MMM d, yyyy")} – ${format(end, "MMM d, yyyy")}`;
  const shortLabel = sameMonth
    ? `${format(start, "MMM d")}–${format(end, "d")}`
    : sameYear
      ? `${format(start, "MMM d")} – ${format(end, "MMM d")}`
      : `${format(start, "MMM d, yy")} – ${format(end, "MMM d, yy")}`;

  return {
    key: "custom",
    label: longLabel,
    shortLabel,
    startDate: custom.from,
    endDate: custom.to,
    resolution
  };
}

// Keeps date formatting consistent for every bounded range.
function rangeWithStart(
  key: RangeKey,
  label: string,
  shortLabel: string,
  start: Date,
  endDate: string,
  resolution: RangeConfig["resolution"]
): RangeConfig {
  return {
    key,
    label,
    shortLabel,
    startDate: format(start, "yyyy-MM-dd"),
    endDate,
    resolution
  };
}
