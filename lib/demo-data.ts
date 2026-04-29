// FILE: lib/demo-data.ts
// Purpose: Provides deterministic demo data while RevenueCat credentials are absent.
// Layer: Fixture
// Exports: createDemoDashboard
// Depends on: lib/revenuecat, lib/ranges

import { format, subDays } from "date-fns";
import { normalizeChart, type DashboardChart } from "@/lib/chart-normalizer";
import { DEFAULT_CHARTS } from "@/lib/revenuecat";
import type { RangeConfig } from "@/lib/ranges";

// ─── ENTRY POINT ─────────────────────────────────────────────

// Builds local sample charts so the dashboard layout remains inspectable pre-config.
export function createDemoDashboard(range: RangeConfig) {
  const points = range.key === "7d" ? 7 : range.key === "28d" ? 28 : range.key === "3m" ? 13 : 26;

  const charts = DEFAULT_CHARTS.map((chart, chartIndex) => {
    const values = Array.from({ length: points }, (_, index) => {
      const date = subDays(new Date(), points - index - 1);
      const baseline = chart.kind === "currency" ? 1200 + chartIndex * 380 : 35 + chartIndex * 7;
      const wave = Math.sin(index / 2.2 + chartIndex) * (chart.kind === "percent" ? 1.8 : 12);
      const trend = index * (chart.kind === "percent" ? 0.08 : 2.6);
      return [date.getTime(), Math.max(0, Math.round((baseline + wave + trend) * 100) / 100)];
    });

    return normalizeChart(chart, {
      display_name: chart.label,
      yaxis: chart.kind === "currency" ? "$" : chart.kind === "percent" ? "%" : "",
      values,
      summary: {}
    });
  });

  // Demo "today" payload mirrors the live shape so TodayKpiCell/TodayMiniChart
  // can compute a local-midnight estimate even before credentials are configured.
  const revenueChart = charts[0];
  const todayUtcValue = revenueChart?.data.at(-1)?.value ?? null;
  const yesterdayUtcValue = revenueChart?.data.at(-2)?.value ?? null;
  const now = new Date();
  const todayUtcDate = format(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())), "yyyy-MM-dd");

  return {
    configured: false,
    message: "Add REVENUECAT_API_KEY to .env.local to replace demo data.",
    projectId: "demo",
    projectIds: ["demo"],
    projects: [{ id: "demo", name: "demo" }],
    currency: "USD",
    range,
    overview: null,
    charts: charts as DashboardChart[],
    today: {
      yesterdayUtcValue,
      todayUtcValue,
      todayUtcDate,
      asOfMs: now.getTime()
    },
    fetchedAt: format(new Date(), "yyyy-MM-dd'T'HH:mm:ss.SSSxxx")
  };
}
