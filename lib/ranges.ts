// FILE: lib/ranges.ts
// Purpose: Centralizes dashboard date ranges and RevenueCat resolution choices.
// Layer: Utility
// Exports: RANGE_OPTIONS, getRangeConfig
// Depends on: date-fns

import { format, subDays, subMonths } from "date-fns";

export type RangeKey = "7d" | "28d" | "3m" | "6m" | "all";

export type RangeConfig = {
  key: RangeKey;
  label: string;
  shortLabel: string;
  startDate?: string;
  endDate?: string;
  resolution: "0" | "1" | "2";
};

export const RANGE_OPTIONS: Array<Pick<RangeConfig, "key" | "label" | "shortLabel">> = [
  { key: "7d", label: "Last 7 days", shortLabel: "7D" },
  { key: "28d", label: "Last 28 days", shortLabel: "28D" },
  { key: "3m", label: "Last 3 months", shortLabel: "3M" },
  { key: "6m", label: "Last 6 months", shortLabel: "6M" },
  { key: "all", label: "All time", shortLabel: "All" }
];

// ─── ENTRY POINT ─────────────────────────────────────────────

// Maps a range key to UTC date strings accepted by RevenueCat chart endpoints.
export function getRangeConfig(key: RangeKey): RangeConfig {
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
    case "28d":
    default:
      return rangeWithStart("28d", "Last 28 days", "28D", subDays(today, 27), endDate, "0");
  }
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
