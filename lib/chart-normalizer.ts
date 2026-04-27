// FILE: lib/chart-normalizer.ts
// Purpose: Converts RevenueCat chart responses into a stable UI-friendly shape.
// Layer: Data adapter
// Exports: normalizeChart
// Depends on: lib/revenuecat

import type { ChartDefinition } from "@/lib/revenuecat";

export type DashboardPoint = {
  date: string;
  value: number;
  incomplete?: boolean;
};

export type DashboardChart = ChartDefinition & {
  displayName: string;
  yAxis: string;
  latest: number | null;
  previous: number | null;
  delta: number | null;
  metricValue?: number | null;
  metricScope?: string;
  comparison?: {
    label: string;
    currentValue: number | null;
    previousValue: number | null;
    delta: number | null;
    percentDelta: number | null;
    valid: boolean;
  };
  data: DashboardPoint[];
  summary: Record<string, unknown>;
  lastComputedAt?: string;
  error?: string;
};

type RevenueCatChartPayload = {
  display_name?: string;
  yaxis?: string;
  yaxis_currency?: string;
  measures?: Array<{
    chartable?: boolean;
    display_name?: string;
    unit?: string;
  }>;
  values?: unknown[];
  summary?: Record<string, unknown>;
  last_computed_at?: number;
};

// ─── ENTRY POINT ─────────────────────────────────────────────

// Accepts the loose RevenueCat chart payload because chart shapes vary by type.
export function normalizeChart(
  definition: ChartDefinition,
  payload: RevenueCatChartPayload | null,
  error?: unknown
): DashboardChart {
  const measureIndex = getPrimaryMeasureIndex(payload);
  const data = payload?.values?.map((point) => normalizePoint(point, measureIndex)).filter(isPoint) ?? [];
  const latest =
    data.at(-1)?.value ??
    extractNumericSummary(payload?.summary, payload?.measures?.[measureIndex]?.display_name ?? payload?.display_name) ??
    null;
  const previous = data.at(-2)?.value ?? null;
  const delta = latest !== null && previous !== null ? latest - previous : null;

  return {
    ...definition,
    displayName: payload?.display_name ?? definition.label,
    yAxis: payload?.yaxis ?? payload?.yaxis_currency ?? "",
    latest,
    previous,
    delta,
    data,
    summary: payload?.summary ?? {},
    lastComputedAt: payload?.last_computed_at
      ? new Date(payload.last_computed_at).toISOString()
      : undefined,
    error: error instanceof Error ? error.message : undefined
  };
}

// ─── Point parsing ────────────────────────────────────────────

// RevenueCat standard charts return arrays; this keeps object variants usable too.
function normalizePoint(raw: unknown, measureIndex: number): DashboardPoint | null {
  if (Array.isArray(raw)) {
    // Convention: [unix_seconds_timestamp, measure_0, measure_1, ..., "incomplete"?]
    // Pick out the timestamp by magnitude (Unix seconds since 2001 are > 1e9), then
    // index into the remaining numerics by the chart's chartable measure index.
    const timestampIdx = raw.findIndex(
      (value) => typeof value === "number" && (value as number) > 1_000_000_000
    );
    const timestamp = timestampIdx >= 0 ? (raw[timestampIdx] as number) : null;

    const measureValues = raw
      .map((value, index) => (index === timestampIdx ? null : value))
      .filter((value) => typeof value === "number") as number[];

    const value =
      typeof measureValues[measureIndex] === "number"
        ? measureValues[measureIndex]
        : measureValues.at(-1) ?? null;

    if (timestamp !== null && typeof value === "number") {
      return {
        date: toDateLabel(timestamp),
        value,
        incomplete: raw.includes("incomplete")
      };
    }
  }

  if (raw && typeof raw === "object") {
    const record = raw as Record<string, unknown>;
    const pointMeasure = firstNumber(record, ["measure"]);
    if (pointMeasure !== null && pointMeasure !== measureIndex) {
      return null;
    }

    const timestamp = firstNumber(record, ["cohort", "timestamp", "date", "start_date", "end_date", "time"]);
    const value =
      firstNumber(record, ["value", "amount", "total", "count", "current"]) ??
      readMeasureFromArray(record.values, measureIndex) ??
      readMeasureFromArray(record.measures, measureIndex);

    if (timestamp !== null && value !== null) {
      return {
        date: toDateLabel(timestamp),
        value,
        incomplete: Boolean(record.incomplete)
      };
    }
  }

  return null;
}

// Some object-style points carry their measures in a nested array; pull the right column.
function readMeasureFromArray(raw: unknown, measureIndex: number): number | null {
  if (!Array.isArray(raw)) {
    return null;
  }
  const numerics = raw.filter((value) => typeof value === "number") as number[];
  if (typeof numerics[measureIndex] === "number") {
    return numerics[measureIndex];
  }
  return numerics.at(-1) ?? null;
}

// RevenueCat v3 returns multiple measures per date; the chartable measure is the line we want.
function getPrimaryMeasureIndex(payload: RevenueCatChartPayload | null) {
  const chartableIndex = payload?.measures?.findIndex((measure) => measure.chartable);
  return chartableIndex !== undefined && chartableIndex >= 0 ? chartableIndex : 0;
}

function isPoint(point: DashboardPoint | null): point is DashboardPoint {
  return point !== null && Number.isFinite(point.value);
}

function firstNumber(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    if (typeof record[key] === "number") {
      return record[key] as number;
    }
  }

  return null;
}

// Converts RevenueCat millisecond timestamps, second timestamps, or ISO strings.
function toDateLabel(timestamp: number | string) {
  if (typeof timestamp === "string") {
    return timestamp.slice(0, 10);
  }

  const milliseconds = timestamp > 10_000_000_000 ? timestamp : timestamp * 1000;
  return new Date(milliseconds).toISOString().slice(0, 10);
}

// Summary-only responses still deserve a KPI value if RevenueCat supplies one.
function extractNumericSummary(summary?: Record<string, unknown>, preferredKey?: string) {
  if (!summary) {
    return null;
  }

  for (const bucket of ["total", "average", "value", "current"]) {
    const nested = summary[bucket];
    if (nested && typeof nested === "object") {
      const nestedRecord = nested as Record<string, unknown>;
      const preferredValue = preferredKey ? nestedRecord[preferredKey] : undefined;
      if (typeof preferredValue === "number") {
        return preferredValue;
      }

      const firstNumeric = Object.values(nestedRecord).find((value) => typeof value === "number");
      if (typeof firstNumeric === "number") {
        return firstNumeric;
      }
    }
  }

  for (const key of ["total", "average", "value", "current"]) {
    if (typeof summary[key] === "number") {
      return summary[key] as number;
    }
  }

  return null;
}
