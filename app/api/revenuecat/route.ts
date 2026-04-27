// FILE: app/api/revenuecat/route.ts
// Purpose: Server-only read proxy for RevenueCat chart and overview data.
// Layer: API Route
// Exports: GET
// Depends on: lib/revenuecat, lib/ranges, lib/chart-normalizer

import { NextResponse } from "next/server";
import { normalizeChart, type DashboardChart, type DashboardPoint } from "@/lib/chart-normalizer";
import { DEFAULT_CHARTS, getRevenueCatConfig, revenueCatFetch } from "@/lib/revenuecat";
import { getRangeConfig, type RangeKey } from "@/lib/ranges";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type DashboardPayload = {
  configured: boolean;
  projectId: string;
  app?: ProjectAppSummary | null;
  currency: string;
  range: ReturnType<typeof getRangeConfig>;
  overview: unknown;
  charts: DashboardChart[];
  fetchedAt: string;
  cached?: boolean;
  stale?: boolean;
  warning?: string;
};

type ProjectAppSummary = {
  id: string;
  name: string;
  type?: string;
  iconUrl?: string;
};

const CACHE_TTL_MS = 5 * 60 * 1000;
const STALE_TTL_MS = 30 * 60 * 1000;
const dashboardCache = new Map<string, { freshUntil: number; staleUntil: number; payload: DashboardPayload }>();
const projectCache = new Map<string, { expiresAt: number; projectId: string }>();
const appCache = new Map<string, { expiresAt: number; app: ProjectAppSummary | null }>();
const inflightDashboardRequests = new Map<string, Promise<DashboardPayload>>();
// Fetch the full chart set: first 6 power the headline KPIs + main/side trajectories,
// the rest fill the auxiliary matrix below. RevenueCat allows 15 chart req/min so 9 is safe.
const DASHBOARD_CHARTS = DEFAULT_CHARTS;

// ─── ENTRY POINT ─────────────────────────────────────────────

// Fetches overview plus the core chart set without exposing the secret API key.
export async function GET(request: Request) {
  const url = new URL(request.url);
  const rangeKey = (url.searchParams.get("range") ?? "28d") as RangeKey;
  const currency = url.searchParams.get("currency") ?? process.env.REVENUECAT_CURRENCY ?? "USD";
  const range = getRangeConfig(rangeKey);
  const config = getRevenueCatConfig();

  if (!config.apiKey) {
    return NextResponse.json(
      {
        configured: false,
        message: "Missing REVENUECAT_API_KEY in .env.local",
        range,
        currency,
        charts: []
      },
      { status: 200 }
    );
  }

  try {
    const apiKey = config.apiKey;
    const projectId = config.projectId ?? (await resolveFirstProjectId(apiKey));
    const cacheKey = `${projectId}:${currency}:${range.key}:${range.startDate ?? "all"}:${range.endDate ?? "now"}`;
    const cached = dashboardCache.get(cacheKey);

    if (cached && cached.freshUntil > Date.now()) {
      return NextResponse.json({ ...cached.payload, cached: true });
    }

    const inflight = inflightDashboardRequests.get(cacheKey);
    if (inflight) {
      return NextResponse.json({ ...(await inflight), cached: true });
    }

    const comparisonRange = getPreviousRange(range);
    const query = buildChartQuery(range, currency, comparisonRange);
    const request = fetchDashboardPayload(projectId, apiKey, currency, range, query);
    inflightDashboardRequests.set(cacheKey, request);
    const payload = await request.finally(() => inflightDashboardRequests.delete(cacheKey));
    const hasRateLimitedChart = payload.charts.some((chart) => chart.error?.includes("429"));

    if (hasRateLimitedChart && cached && cached.staleUntil > Date.now()) {
      return NextResponse.json({
        ...cached.payload,
        cached: true,
        stale: true,
        warning: "RevenueCat rate limit hit; showing cached data."
      });
    }

    if (!hasRateLimitedChart) {
      dashboardCache.set(cacheKey, {
        freshUntil: Date.now() + CACHE_TTL_MS,
        staleUntil: Date.now() + STALE_TTL_MS,
        payload
      });
    } else {
      payload.warning = "RevenueCat rate limit hit; some chart series may be temporarily unavailable.";
    }

    return NextResponse.json(payload);
  } catch (error) {
    const stale = findAnyStaleDashboard(range.key, currency);
    if (stale) {
      return NextResponse.json({
        ...stale.payload,
        cached: true,
        stale: true,
        warning: error instanceof Error ? error.message : "RevenueCat error; showing cached data."
      });
    }

    return NextResponse.json(
      {
        configured: true,
        message: error instanceof Error ? error.message : "Unknown RevenueCat API error",
        range,
        currency,
        charts: []
      },
      { status: 502 }
    );
  }
}

// ─── Query helpers ────────────────────────────────────────────

// Discovers a usable project id so a single API key can bootstrap the app.
async function resolveFirstProjectId(apiKey: string) {
  const keyFingerprint = apiKey.slice(-8);
  const cached = projectCache.get(keyFingerprint);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.projectId;
  }

  const projects = await revenueCatFetch("/projects", apiKey, { limit: "10" });
  const firstProject = Array.isArray(projects?.items) ? projects.items[0] : null;

  if (!firstProject?.id) {
    throw new Error("No RevenueCat project found. Set REVENUECAT_PROJECT_ID in .env.local.");
  }

  projectCache.set(keyFingerprint, {
    expiresAt: Date.now() + STALE_TTL_MS,
    projectId: String(firstProject.id)
  });

  return String(firstProject.id);
}

// Keeps the UI useful if RevenueCat rate-limits a refresh before fresh cache exists.
function findAnyStaleDashboard(rangeKey: RangeKey, currency: string) {
  for (const [key, cached] of dashboardCache.entries()) {
    if (key.includes(`:${currency}:${rangeKey}:`) && cached.staleUntil > Date.now()) {
      return cached;
    }
  }

  return null;
}

// Fetches the compact chart set used by the visible dashboard without over-spending the API rate limit.
async function fetchDashboardPayload(
  projectId: string,
  apiKey: string,
  currency: string,
  range: ReturnType<typeof getRangeConfig>,
  query: Record<string, string>
): Promise<DashboardPayload> {
  const app = await resolveProjectApp(projectId, apiKey);
  const overviewRequest =
    range.key === "28d"
      ? revenueCatFetch(`/projects/${projectId}/metrics/overview`, apiKey, { currency })
      : Promise.resolve(null);
  const [overview, ...rawCharts] = await Promise.all([
    overviewRequest,
    ...DASHBOARD_CHARTS.map((chart) =>
      revenueCatFetch(`/projects/${projectId}/charts/${chart.name}`, apiKey, query)
        .then((data) => normalizeChart(chart, data))
        .catch((error) => normalizeChart(chart, null, error))
    )
  ]);
  const charts = addMetricComparisons(rawCharts, range);

  return {
    configured: true,
    projectId,
    app,
    currency,
    range,
    overview,
    charts,
    fetchedAt: new Date().toISOString()
  };
}

// Reads the first configured app so the UI can show product identity instead of a raw project id.
async function resolveProjectApp(projectId: string, apiKey: string): Promise<ProjectAppSummary | null> {
  const cached = appCache.get(projectId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.app;
  }

  const apps = await revenueCatFetch(`/projects/${projectId}/apps`, apiKey, { limit: "10" });
  const firstApp = Array.isArray(apps?.items) ? apps.items[0] : null;
  const app = firstApp
    ? {
        id: String(firstApp.id),
        name: String(firstApp.name ?? firstApp.id),
        type: typeof firstApp.type === "string" ? firstApp.type : undefined,
        iconUrl: findIconUrl(firstApp)
      }
    : null;

  appCache.set(projectId, {
    expiresAt: Date.now() + STALE_TTL_MS,
    app
  });

  return app;
}

function findIconUrl(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (/icon|logo|image/i.test(key) && typeof nested === "string" && /^https?:\/\//.test(nested)) {
      return nested;
    }

    const found = findIconUrl(nested);
    if (found) {
      return found;
    }
  }

  return undefined;
}

// Converts the dashboard range picker into RevenueCat chart query parameters.
function buildChartQuery(
  range: ReturnType<typeof getRangeConfig>,
  currency: string,
  comparisonRange: ReturnType<typeof getPreviousRange>
) {
  const query: Record<string, string> = {
    currency,
    realtime: "true",
    resolution: range.resolution
  };

  if (comparisonRange?.startDate ?? range.startDate) {
    query.start_date = comparisonRange?.startDate ?? range.startDate ?? "";
  }

  if (range.endDate) {
    query.end_date = range.endDate;
  }

  return query;
}

// ─── Period comparison helpers ───────────────────────────────

function addMetricComparisons(charts: DashboardChart[], range: ReturnType<typeof getRangeConfig>) {
  const comparisonRange = getPreviousRange(range);
  if (!range.startDate || !range.endDate || !comparisonRange) {
    return charts.map((chart) => attachMetric(chart, chart.data, null, null, false));
  }

  const splitCharts = charts.map((chart) => {
    const currentData = chart.data.filter((point) => point.date >= range.startDate!);
    const previousData = chart.data.filter(
      (point) => point.date >= comparisonRange.startDate && point.date <= comparisonRange.endDate
    );
    return { chart, currentData, previousData };
  });
  const hasPriorActivity = splitCharts.some(({ previousData }) =>
    previousData.some((point) => Math.abs(point.value) > 0)
  );

  return splitCharts.map(({ chart, currentData, previousData }) =>
    attachMetric(chart, currentData, previousData, comparisonRange.label, hasPriorActivity)
  );
}

function attachMetric(
  chart: DashboardChart,
  currentData: DashboardPoint[],
  previousData: DashboardPoint[] | null,
  comparisonLabel: string | null,
  hasPriorActivity: boolean
): DashboardChart {
  const currentValue = calculateMetricValue(chart.name, currentData);
  const previousValue = previousData ? calculateMetricValue(chart.name, previousData) : null;
  const valid = Boolean(comparisonLabel && hasPriorActivity && previousValue !== null && currentValue !== null);
  const delta = valid && currentValue !== null && previousValue !== null ? currentValue - previousValue : null;
  const percentDelta =
    delta !== null && previousValue !== null && previousValue !== 0
      ? (delta / Math.abs(previousValue)) * 100
      : null;

  return {
    ...chart,
    data: currentData,
    latest: currentData.at(-1)?.value ?? currentValue,
    previous: previousData?.at(-1)?.value ?? null,
    delta,
    metricValue: currentValue,
    metricScope: getMetricScope(chart.name),
    comparison: {
      label: comparisonLabel ?? "previous period",
      currentValue,
      previousValue,
      delta,
      percentDelta,
      valid
    }
  };
}

function calculateMetricValue(chartName: DashboardChart["name"], data: DashboardPoint[]) {
  if (data.length === 0) {
    return null;
  }

  if (chartName === "revenue" || chartName === "customers_new" || chartName === "actives_new") {
    return roundMetric(data.reduce((sum, point) => sum + point.value, 0));
  }

  if (chartName === "churn" || chartName === "refund_rate") {
    return roundMetric(data.reduce((sum, point) => sum + point.value, 0) / data.length);
  }

  return data.at(-1)?.value ?? null;
}

function getMetricScope(chartName: DashboardChart["name"]) {
  if (chartName === "revenue" || chartName === "customers_new" || chartName === "actives_new") {
    return "total in range";
  }

  if (chartName === "churn" || chartName === "refund_rate") {
    return "average in range";
  }

  return "current";
}

function getPreviousRange(range: ReturnType<typeof getRangeConfig>) {
  if (!range.startDate || !range.endDate || range.key === "all") {
    return null;
  }

  const start = parseDate(range.startDate);
  const end = parseDate(range.endDate);
  const days = Math.max(1, Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1);
  const previousEnd = addDays(start, -1);
  const previousStart = addDays(previousEnd, -(days - 1));

  return {
    startDate: formatDate(previousStart),
    endDate: formatDate(previousEnd),
    label: `previous ${range.shortLabel.toLowerCase()}`
  };
}

function parseDate(date: string) {
  return new Date(`${date}T00:00:00.000Z`);
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function formatDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function roundMetric(value: number) {
  return Math.round(value * 100) / 100;
}
