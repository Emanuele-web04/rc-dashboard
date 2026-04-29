// FILE: app/api/revenuecat/route.ts
// Purpose: Server-only read proxy for RevenueCat chart and overview data.
// Layer: API Route
// Exports: GET
// Depends on: lib/revenuecat, lib/ranges, lib/chart-normalizer

import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import { normalizeChart, type DashboardChart, type DashboardPoint } from "@/lib/chart-normalizer";
import { DEFAULT_CHARTS, getRevenueCatConfig, revenueCatFetch } from "@/lib/revenuecat";
import { getRangeConfig, type RangeKey } from "@/lib/ranges";

// "Today" bridge: RevenueCat's API only exposes UTC daily buckets (no hourly,
// no timezone parameter — verified against v2 docs). To estimate revenue from
// the *user's* local midnight we ship the two most recent UTC daily revenue
// totals and let the client compute the overlap with their actual local day.
type TodayPayload = {
  yesterdayUtcValue: number | null;
  todayUtcValue: number | null;
  todayUtcDate: string;
  asOfMs: number;
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type DashboardPayload = {
  configured: boolean;
  // First selected project id (kept for backwards compatibility with the UI).
  projectId: string;
  // Selected project ids that were aggregated into this dashboard.
  projectIds: string[];
  // Available project ids (used to render the project selector in the UI).
  projects: Array<{ id: string; name: string }>;
  app?: ProjectAppSummary | null;
  currency: string;
  range: ReturnType<typeof getRangeConfig>;
  overview: unknown;
  charts: DashboardChart[];
  today: TodayPayload;
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

  if (!config.apiKey && !config.projectKeys && !config.projectId && !(config.projectIds && config.projectIds.length > 0)) {
    return NextResponse.json(
      {
        configured: false,
        message: "Missing RevenueCat credentials. Set REVENUECAT_PROJECT_KEYS (preferred) or REVENUECAT_API_KEY + REVENUECAT_PROJECT_ID/REVENUECAT_PROJECT_IDS in .env.local.",
        range,
        currency,
        charts: []
      },
      { status: 200 }
    );
  }

  try {
    const requestedProjectsParam = url.searchParams.get("projects");
    const requestedProjectIds = requestedProjectsParam
      ? requestedProjectsParam
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : null;

    const availableProjectIds: string[] = config.projectKeys
      ? Object.keys(config.projectKeys)
      : config.projectIds ?? (config.projectId ? [config.projectId] : []);

    const resolvedAvailableProjectIds =
      availableProjectIds.length > 0
        ? availableProjectIds
        : config.apiKey
          ? [await resolveFirstProjectId(config.apiKey)]
          : [];

    const selectedProjectIds =
      requestedProjectIds && requestedProjectIds.length > 0 ? requestedProjectIds.filter((id) => resolvedAvailableProjectIds.includes(id)) : resolvedAvailableProjectIds;

    if (selectedProjectIds.length === 0) {
      throw new Error("No RevenueCat project ids available for the current configuration/selection.");
    }

    const projectsKey = selectedProjectIds.slice().sort().join(",");
    const cacheKey = `${projectsKey}:${currency}:${range.key}:${range.startDate ?? "all"}:${range.endDate ?? "now"}`;
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
    const request = fetchDashboardPayload(selectedProjectIds, resolvedAvailableProjectIds, config, currency, range, query);
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

// Fetches and aggregates the compact chart set used by the visible dashboard.
// Supports multiple RevenueCat projects by summing/weighting bucket values.
async function fetchDashboardPayload(
  selectedProjectIds: string[],
  availableProjectIds: string[],
  config: ReturnType<typeof getRevenueCatConfig>,
  currency: string,
  range: ReturnType<typeof getRangeConfig>,
  query: Record<string, string>
): Promise<DashboardPayload> {
  const projectKeys = config.projectKeys ?? {};
  const projectNames = await resolveProjectNames(availableProjectIds, config);

  async function fetchProjectParts(projectId: string) {
    const projectApiKey = projectKeys[projectId] ?? config.apiKey;
    if (!projectApiKey) {
      throw new Error(`Missing api key for RevenueCat project ${projectId}. Add it to REVENUECAT_PROJECT_KEYS.`);
    }

    const overview =
      range.key === "28d"
        ? await revenueCatFetch(`/projects/${projectId}/metrics/overview`, projectApiKey, { currency }).catch(() => null)
        : null;

    const today = await fetchTodaySeries(projectId, projectApiKey, currency);

    const rawCharts = await Promise.all(
      DASHBOARD_CHARTS.map((chart) =>
        revenueCatFetch(`/projects/${projectId}/charts/${chart.name}`, projectApiKey, query)
          .then((data) => normalizeChart(chart, data))
          .catch((error) => normalizeChart(chart, null, error))
      )
    );

    return { projectId, projectApiKey, overview, today, rawCharts };
  }

  const projectParts = await Promise.all(selectedProjectIds.map((pid) => fetchProjectParts(pid)));

  const aggregatedRawCharts = aggregateChartsAcrossProjects(projectParts);
  const charts = addMetricComparisons(aggregatedRawCharts, range);

  const today = aggregateToday(projectParts.map((p) => p.today));

  const overview = aggregateOverview(range, projectParts.map((p) => p.overview), charts);

  const firstProjectId = selectedProjectIds[0];
  const firstProjectApiKey = projectParts[0]?.projectApiKey;
  const app = firstProjectId && firstProjectApiKey ? await resolveProjectApp(firstProjectId, firstProjectApiKey) : null;

  return {
    configured: true,
    projectId: firstProjectId,
    projectIds: selectedProjectIds,
    projects: availableProjectIds.map((id) => ({ id, name: projectNames[id] ?? "No name" })),
    app,
    currency,
    range,
    overview,
    charts,
    today,
    fetchedAt: new Date().toISOString()
  };
}

async function resolveProjectNames(
  projectIds: string[],
  config: ReturnType<typeof getRevenueCatConfig>
): Promise<Record<string, string>> {
  const names: Record<string, string> = {};
  const fileNames = await readProjectNamesFile();
  const attemptedKeys = new Set<string>();

  const candidateKeys = [
    ...(config.projectKeys ? Object.values(config.projectKeys) : []),
    ...(config.apiKey ? [config.apiKey] : [])
  ].filter(Boolean);

  for (const apiKey of candidateKeys) {
    if (attemptedKeys.has(apiKey)) continue;
    attemptedKeys.add(apiKey);

    try {
      const projects = await revenueCatFetch("/projects", apiKey, { limit: "100" });
      const items = Array.isArray(projects?.items) ? projects.items : [];
      for (const item of items) {
        const id = typeof item?.id === "string" ? item.id : null;
        const name = typeof item?.name === "string" ? item.name : null;
        if (id && name && projectIds.includes(id) && !names[id]) {
          names[id] = name;
        }
      }

      if (projectIds.every((id) => names[id])) {
        break;
      }
    } catch {
      // Missing `project_configuration:projects:read` is expected for some keys.
    }
  }

  for (const id of projectIds) {
    if (!names[id] && fileNames[id]) {
      names[id] = fileNames[id];
    }
  }

  return names;
}

async function readProjectNamesFile(): Promise<Record<string, string>> {
  try {
    const filePath = path.join(process.cwd(), "project-names.json");
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).filter(
        ([key, value]) => typeof key === "string" && typeof value === "string" && value.trim().length > 0
      )
    ) as Record<string, string>;
  } catch {
    return {};
  }
}

function aggregateToday(parts: TodayPayload[]) {
  const yesterdayValues = parts.map((p) => p.yesterdayUtcValue).filter((v): v is number => typeof v === "number");
  const todayValues = parts.map((p) => p.todayUtcValue).filter((v): v is number => typeof v === "number");

  const yesterdayUtcValue = yesterdayValues.length ? yesterdayValues.reduce((a, b) => a + b, 0) : null;
  const todayUtcValue = todayValues.length ? todayValues.reduce((a, b) => a + b, 0) : null;

  const todayUtcDate = parts.find((p) => p.todayUtcDate)?.todayUtcDate ?? parts[0]?.todayUtcDate ?? formatDate(new Date());
  return {
    yesterdayUtcValue,
    todayUtcValue,
    todayUtcDate,
    asOfMs: Date.now()
  };
}

function aggregateOverview(
  range: ReturnType<typeof getRangeConfig>,
  overviews: Array<any>,
  charts: DashboardChart[]
) {
  if (range.key !== "28d") return null;

  const metrics = new Map<string, any>();
  for (const overview of overviews) {
    const list: any[] = overview?.metrics;
    if (!Array.isArray(list)) continue;
    for (const metric of list) {
      if (!metric?.id) continue;
      const existing = metrics.get(metric.id);
      if (!existing) {
        metrics.set(metric.id, { ...metric });
        continue;
      }
      if (typeof metric.value === "number" && typeof existing.value === "number") {
        existing.value += metric.value;
      }
    }
  }

  // Replace key values with the KPI-derived chart metrics so the UI
  // doesn't depend on potentially missing overview ids per project.
  const metricByChartName: Partial<Record<DashboardChart["name"], number>> = {};
  for (const chart of charts) {
    if (typeof chart.metricValue === "number") metricByChartName[chart.name] = chart.metricValue;
  }
  const overviewIdByChartName: Partial<Record<DashboardChart["name"], string>> = {
    revenue: "revenue",
    mrr: "mrr",
    arr: "arr",
    actives: "active_subscriptions",
    churn: "churn",
    customers_new: "new_customers",
    actives_new: "active_subscriptions" // best-effort fallback if present
  };

  for (const [chartName, overviewId] of Object.entries(overviewIdByChartName) as Array<[string, string]>) {
    const v = (metricByChartName as any)[chartName];
    const entry = metrics.get(overviewId);
    if (entry && typeof v === "number") {
      entry.value = v;
    }
  }

  return {
    metrics: Array.from(metrics.values())
  };
}

function aggregateChartsAcrossProjects(projectParts: Array<{ projectId: string; rawCharts: DashboardChart[] }>) {
  const projectIds = projectParts.map((p) => p.projectId);
  const chartsByProject = new Map<string, Map<string, DashboardChart>>();
  for (const part of projectParts) {
    const m = new Map<string, DashboardChart>();
    for (const chart of part.rawCharts) m.set(chart.name, chart);
    chartsByProject.set(part.projectId, m);
  }

  const aggregatedCharts: DashboardChart[] = [];
  for (const def of DASHBOARD_CHARTS) {
    const chartName = def.name;

    // Collect all dates across selected projects for this chart.
    const dateSet = new Set<string>();
    const pointMapsByProject = new Map<string, Map<string, DashboardPoint>>();
    const errorByProject: string[] = [];

    for (const pid of projectIds) {
      const chart = chartsByProject.get(pid)?.get(chartName);
      if (chart?.error) errorByProject.push(chart.error);
      const m = new Map<string, DashboardPoint>();
      if (chart) {
        for (const pt of chart.data) {
          m.set(pt.date, pt);
          dateSet.add(pt.date);
        }
      }
      pointMapsByProject.set(pid, m);
    }

    const allDates = Array.from(dateSet).sort();
    const percentWeighted =
      chartName === "churn" ? "actives" : chartName === "refund_rate" ? "revenue" : null;

    // Precompute denominator maps for percent-weighted charts.
    const denominatorMapByProject: Map<string, Map<string, DashboardPoint>> | null =
      percentWeighted && chartsByProject.size > 0
        ? new Map(
            projectIds.map((pid) => {
              const denomChart = chartsByProject.get(pid)?.get(percentWeighted);
              const dm = new Map<string, DashboardPoint>();
              if (denomChart) {
                for (const pt of denomChart.data) dm.set(pt.date, pt);
              }
              return [pid, dm];
            })
          )
        : null;

    const data: DashboardPoint[] = allDates.map((date) => {
      let incomplete = false;

      if (percentWeighted) {
        let numerator = 0;
        let denom = 0;
        let churnOrRefundSum = 0;
        let count = 0;

        for (const pid of projectIds) {
          const pt = pointMapsByProject.get(pid)?.get(date);
          const dm = denominatorMapByProject?.get(pid);
          const denomPt = dm?.get(date);

          if (!pt) incomplete = true;
          if (!denomPt) incomplete = true;

          if (pt && denomPt) {
            numerator += pt.value * denomPt.value;
            denom += denomPt.value;
            if (pt.incomplete || denomPt.incomplete) incomplete = true;
          }

          if (pt) {
            churnOrRefundSum += pt.value;
            count += 1;
            if (pt.incomplete) incomplete = true;
          }
        }

        const value = denom > 0 ? numerator / denom : count > 0 ? churnOrRefundSum / count : 0;
        return { date, value, incomplete };
      }

      let sum = 0;
      let any = false;
      for (const pid of projectIds) {
        const pt = pointMapsByProject.get(pid)?.get(date);
        if (!pt) {
          incomplete = true;
          continue;
        }
        any = true;
        sum += pt.value;
        if (pt.incomplete) incomplete = true;
      }

      return { date, value: any ? sum : 0, incomplete };
    });

    const firstChartForMeta = projectParts.find((p) => p.rawCharts.some((c) => c.name === chartName))?.rawCharts.find(
      (c) => c.name === chartName
    );

    const error = errorByProject.find((e) => e?.includes("429")) ?? errorByProject[0] ?? undefined;

    aggregatedCharts.push({
      ...(firstChartForMeta ?? {
        ...def,
        displayName: def.label,
        yAxis: def.kind === "currency" ? "$" : def.kind === "percent" ? "%" : "",
        latest: null,
        previous: null,
        delta: null,
          summary: {},
        data: []
      }),
      data,
      error
    });
  }

  return aggregatedCharts;
}

// Fetches the last two UTC daily revenue buckets regardless of the dashboard's
// active range. The client uses these to weight by local-tz overlap and present
// a "since 00:00 local" estimate (since the API itself can't slice sub-daily).
async function fetchTodaySeries(
  projectId: string,
  apiKey: string,
  currency: string
): Promise<TodayPayload> {
  const now = new Date();
  const todayUtc = formatDate(now);
  const yesterdayUtc = formatDate(new Date(now.getTime() - 86_400_000));

  try {
    const raw = await revenueCatFetch(`/projects/${projectId}/charts/revenue`, apiKey, {
      currency,
      realtime: "true",
      resolution: "0",
      start_date: yesterdayUtc,
      end_date: todayUtc
    });
    const chart = normalizeChart(
      { name: "revenue", label: "Revenue", description: "", kind: "currency" },
      raw
    );
    const todayPoint = chart.data.find((p) => p.date === todayUtc) ?? chart.data.at(-1) ?? null;
    const yesterdayPoint =
      chart.data.find((p) => p.date === yesterdayUtc) ??
      (chart.data.length >= 2 ? chart.data.at(-2) ?? null : null);

    return {
      yesterdayUtcValue: yesterdayPoint?.value ?? null,
      todayUtcValue: todayPoint?.value ?? null,
      todayUtcDate: todayUtc,
      asOfMs: Date.now()
    };
  } catch {
    // Don't fail the whole dashboard for the Today tile; client falls back gracefully.
    return {
      yesterdayUtcValue: null,
      todayUtcValue: null,
      todayUtcDate: todayUtc,
      asOfMs: Date.now()
    };
  }
}

// Reads the first configured app so the UI can show product identity instead of a raw project id.
async function resolveProjectApp(projectId: string, apiKey: string): Promise<ProjectAppSummary | null> {
  const cached = appCache.get(projectId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.app;
  }

  // Not all read-only keys include `project_configuration:apps:read`.
  // In that case we keep the dashboard functional by returning `null` app identity.
  let apps: any = null;
  try {
    apps = await revenueCatFetch(`/projects/${projectId}/apps`, apiKey, { limit: "10" });
  } catch {
    apps = null;
  }
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
