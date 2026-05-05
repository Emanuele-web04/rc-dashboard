"use client";

// FILE: components/revenue-dashboard.tsx
// Purpose: Minimal Codex/Cursor-style RevenueCat operator console.
// Layer: Client component
// Exports: RevenueDashboard
// Depends on: lucide-react, lib/ranges, lib/demo-data, lib/chart-normalizer

import { useEffect, useMemo, useState } from "react";
import {
  ArrowDownRight,
  ArrowUpRight,
  Moon,
  RefreshCw,
  Settings as SettingsIcon,
  Sun,
  TriangleAlert
} from "lucide-react";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig
} from "@/components/ui/chart";
import { Switch } from "@/components/ui/switch";
import {
  Popover,
  PopoverContent,
  PopoverTrigger
} from "@/components/ui/popover";
import { DateRangePicker, type DateRange } from "@/components/ui/date-range-picker";
import {
  NET_CALCULATOR_DEFAULTS,
  NetCalculatorSheet,
  NetCalculatorTrigger,
  type NetCalculatorState
} from "@/components/net-calculator-sheet";
import { createDemoDashboard } from "@/lib/demo-data";
import {
  RANGE_OPTIONS,
  getRangeConfig,
  isPresetRangeKey,
  type RangeKey
} from "@/lib/ranges";
import type { ExtrasInputs } from "@/lib/tax-calculator";
import type { DashboardChart, DashboardPoint } from "@/lib/chart-normalizer";

// Apple/Google take a 15% revenue share on subscriptions after year one (and on
// Small Business Program apps). When the toggle is on we present *net* revenue
// (gross × 0.85) everywhere a currency value is rendered. Non-currency metrics
// (counts, percentages) pass through unchanged.
const APPLE_CUT = 0.15;
const NET_FACTOR = 1 - APPLE_CUT;

type RevenueCatOverviewMetric = {
  id: string;
  name: string;
  description?: string;
  unit?: string;
  period?: string;
  value: number;
  last_updated_at_iso8601?: string;
};

type RevenueCatOverview = {
  metrics?: RevenueCatOverviewMetric[];
};

type CurrencyCode = "USD" | "EUR";
const SOURCE_CURRENCY: CurrencyCode = "USD";
const FALLBACK_USD_TO_EUR_RATE = Number(process.env.NEXT_PUBLIC_USD_TO_EUR_RATE ?? "0.92");

type TodayPayload = {
  yesterdayUtcValue: number | null;
  todayUtcValue: number | null;
  todayUtcDate: string;
  asOfMs: number;
};

type DashboardResponse = Omit<ReturnType<typeof createDemoDashboard>, "overview"> & {
  configured: boolean;
  app?: {
    id: string;
    name: string;
    type?: string;
    iconUrl?: string;
  } | null;
  overview?: RevenueCatOverview | null;
  today?: TodayPayload | null;
  cached?: boolean;
  stale?: boolean;
  warning?: string;
};

// ─── ENTRY POINT ─────────────────────────────────────────────

// Per-range client cache. RevenueCat is queried in USD once; display currency
// conversion happens locally so toggling EUR cannot spend extra API quota.
const CLIENT_CACHE_TTL_MS = 60_000;
type CacheEntry = { payload: DashboardResponse; fetchedAt: number };

export function RevenueDashboard() {
  // Initial state always uses defaults so SSR/static output is deterministic
  // (avoids hydration mismatches). The URL is read in a post-mount effect
  // below, then state updates flow back into the URL via replaceState.
  const [rangeKey, setRangeKey] = useState<RangeKey>("28d");
  // Custom range stays mounted in state independently of `rangeKey` so we can
  // remember the operator's last picker selection while they sample preset
  // tabs. Tapping the picker trigger restores it; tapping a preset tab keeps
  // it around but inactive.
  const [customRange, setCustomRange] = useState<DateRange | null>(null);
  const [currency, setCurrency] = useState<CurrencyCode>("USD");
  const [cache, setCache] = useState<Record<string, CacheEntry>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [appleCut, setAppleCut] = useState(false);
  const [usdToEurRate, setUsdToEurRate] = useState(() => getFallbackUsdToEurRate());
  // Locale-specific feature flag. Off by default so the dashboard ships
  // generic for OSS use; users opt in via the Settings popover and the
  // Italian forfettario calculator (button + sheet) becomes visible.
  // Persisted via URL (`?it=1`) for shareable demo links + localStorage
  // (`rc-italian-taxes`) for personal preference across visits.
  const [italianTaxes, setItalianTaxes] = useState(false);
  // Net-in-pocket calculator state. Sheet open/close is intentionally *not*
  // persisted — it's transient UI; only the chosen tax knobs survive reloads
  // (via URL params for shareability, falling back to localStorage).
  const [calcOpen, setCalcOpen] = useState(false);
  const [calcState, setCalcState] = useState<NetCalculatorState>(NET_CALCULATOR_DEFAULTS);
  // Latch flips true after URL → state hydration completes. Until then we
  // skip the state → URL writer to avoid clobbering an incoming `?range=7d`
  // with the default `28d` during the first commit.
  const [hydratedFromUrl, setHydratedFromUrl] = useState(false);

  // URL → state, once on mount. Falls back to the localStorage-remembered
  // `appleCut` preference when no `?cut=` param is present so power users
  // don't re-toggle on every fresh visit, while shareable links with `?cut=1`
  // still take precedence.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);

    // Custom range hydrates from `?from=…&to=…` and only "wins" when
    // `?range=custom` is also set — otherwise we'd auto-promote a stale
    // pair of dates left in the URL after the operator switched back to
    // a preset tab in another tab/window.
    const fromUrl = params.get("from");
    const toUrl = params.get("to");
    if (isIsoDateString(fromUrl) && isIsoDateString(toUrl) && fromUrl <= toUrl) {
      setCustomRange({ from: fromUrl, to: toUrl });
    }

    const rangeFromUrl = params.get("range");
    if (rangeFromUrl === "custom" && isIsoDateString(fromUrl) && isIsoDateString(toUrl)) {
      setRangeKey("custom");
    } else if (isPresetRangeKey(rangeFromUrl)) {
      setRangeKey(rangeFromUrl);
    }

    const currencyFromUrl = params.get("currency");
    if (currencyFromUrl === "USD" || currencyFromUrl === "EUR") {
      setCurrency(currencyFromUrl);
    }

    const cutFromUrl = params.get("cut");
    if (cutFromUrl === "1" || cutFromUrl === "0") {
      setAppleCut(cutFromUrl === "1");
    } else {
      try {
        if (localStorage.getItem("rc-apple-cut") === "1") setAppleCut(true);
      } catch {
        /* private mode etc. — leave default false. */
      }
    }

    const italianFromUrl = params.get("it");
    if (italianFromUrl === "1" || italianFromUrl === "0") {
      setItalianTaxes(italianFromUrl === "1");
    } else {
      try {
        if (localStorage.getItem("rc-italian-taxes") === "1") setItalianTaxes(true);
      } catch {
        /* noop */
      }
    }

    // Calculator knobs hydrate from two layers:
    //   1. localStorage (`rc-calc`, JSON-encoded full state) → personal prefs
    //      that survive across visits without polluting the URL.
    //   2. URL params → take precedence so shared links (e.g. "?reg=startup&inpsm=fixed")
    //      override the stored prefs.
    // Extras stay localStorage-only on purpose: 8 amounts × 2 fields would
    // bloat the URL beyond shareability.
    const next: NetCalculatorState = readStoredCalcState();

    const regimeUrl = params.get("reg");
    if (regimeUrl === "startup" || regimeUrl === "regime") next.regime = regimeUrl;

    const inpsUrl = params.get("inps");
    if (inpsUrl === "full" || inpsUrl === "partial") next.inps = inpsUrl;

    const tierUrl = params.get("apt");
    if (tierUrl === "sbp" || tierUrl === "standard") next.appleTier = tierUrl;

    const inpsModeUrl = params.get("inpsm");
    if (inpsModeUrl === "fixed" || inpsModeUrl === "percent") next.inpsMode = inpsModeUrl;

    const inpsFixedUrl = params.get("inpsf");
    if (inpsFixedUrl !== null) {
      const parsed = Number(inpsFixedUrl);
      if (Number.isFinite(parsed) && parsed >= 0) next.inpsFixed = parsed;
    }

    setCalcState(next);

    setHydratedFromUrl(true);
  }, []);

  // Keep the EUR toggle fresh without coupling it to RevenueCat's chart quota.
  // The API route caches provider responses and falls back to the env rate.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const response = await fetch("/api/fx?base=USD&target=EUR", { cache: "no-store" });
        const payload = await response.json();
        const nextRate = Number(payload?.rate);
        if (!cancelled && response.ok && Number.isFinite(nextRate) && nextRate > 0) {
          setUsdToEurRate(nextRate);
        }
      } catch {
        /* Keep the configured fallback rate if FX lookup fails. */
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // state → URL. Uses history.replaceState (not router.replace / pushState):
  //   - no Next.js navigation → no React re-render cycle
  //   - no new history entry → back button still leaves the dashboard cleanly
  // Default values are deleted from the URL so it stays minimal until the
  // operator actually changes something.
  useEffect(() => {
    if (!hydratedFromUrl) return;
    const url = new URL(window.location.href);
    setOrDelete(url.searchParams, "range", rangeKey, "28d");
    setOrDelete(url.searchParams, "currency", currency, "USD");
    setOrDelete(url.searchParams, "cut", appleCut ? "1" : "0", "0");
    setOrDelete(url.searchParams, "it", italianTaxes ? "1" : "0", "0");
    // `from`/`to` only ride the URL when the custom range is the *active*
    // selection. Keeping them strictly tied to `range=custom` avoids a stale
    // `?from=…` lingering after the operator switches back to a preset tab.
    if (rangeKey === "custom" && customRange) {
      url.searchParams.set("from", customRange.from);
      url.searchParams.set("to", customRange.to);
    } else {
      url.searchParams.delete("from");
      url.searchParams.delete("to");
    }
    // Calculator-specific params are only meaningful when the Italian-taxes
    // feature is enabled. Strip them otherwise so the URL stays minimal for
    // OSS users who never touch this feature, and to avoid leaking stale
    // calc settings in shared links.
    if (italianTaxes) {
      setOrDelete(url.searchParams, "reg", calcState.regime, NET_CALCULATOR_DEFAULTS.regime);
      setOrDelete(url.searchParams, "inps", calcState.inps, NET_CALCULATOR_DEFAULTS.inps);
      setOrDelete(url.searchParams, "apt", calcState.appleTier, NET_CALCULATOR_DEFAULTS.appleTier);
      setOrDelete(url.searchParams, "inpsm", calcState.inpsMode, NET_CALCULATOR_DEFAULTS.inpsMode);
      setOrDelete(
        url.searchParams,
        "inpsf",
        String(calcState.inpsFixed),
        String(NET_CALCULATOR_DEFAULTS.inpsFixed)
      );
    } else {
      url.searchParams.delete("reg");
      url.searchParams.delete("inps");
      url.searchParams.delete("apt");
      url.searchParams.delete("inpsm");
      url.searchParams.delete("inpsf");
    }
    window.history.replaceState(null, "", url.toString());
  }, [rangeKey, currency, appleCut, italianTaxes, calcState, customRange, hydratedFromUrl]);

  function handleAppleCutChange(next: boolean) {
    setAppleCut(next);
    // localStorage stays as the "remembered preference" fallback for fresh
    // visits without an explicit `?cut=` param.
    try {
      localStorage.setItem("rc-apple-cut", next ? "1" : "0");
    } catch {
      /* noop */
    }
  }

  function handleItalianTaxesChange(next: boolean) {
    setItalianTaxes(next);
    // Auto-close the calculator drawer if the feature is being disabled —
    // otherwise the sheet would stay mounted but with its trigger gone,
    // which is a confusing intermediate state.
    if (!next) setCalcOpen(false);
    try {
      localStorage.setItem("rc-italian-taxes", next ? "1" : "0");
    } catch {
      /* noop */
    }
  }

  // Mirror the Apple-cut handler: state changes flow through here so we can
  // persist the user's calculator config across reloads. URL sync happens
  // automatically via the state→URL effect above; localStorage gets the
  // full state (incl. extras + amounts) as a single JSON blob to keep the
  // schema flexible without growing per-field key counts.
  function handleCalcStateChange(next: NetCalculatorState) {
    setCalcState(next);
    try {
      localStorage.setItem("rc-calc", JSON.stringify(next));
    } catch {
      /* noop */
    }
  }

  // Custom dates are part of the cache key so flipping between two custom
  // ranges (or back to a preset and forward) keeps each result independently
  // memoized rather than clobbering the previous one.
  const customSuffix =
    rangeKey === "custom" && customRange ? `:${customRange.from}:${customRange.to}` : "";
  const cacheKey = `${rangeKey}${customSuffix}`;
  const cached = cache[cacheKey];
  const rawData = cached?.payload;
  const displayRawData = useMemo(
    () => (rawData ? convertDisplayCurrency(rawData, currency, usdToEurRate) : rawData),
    [rawData, currency, usdToEurRate]
  );
  // Single transform point: scale every currency-shaped field by NET_FACTOR
  // when the toggle is on. Downstream components stay agnostic to the cut.
  const data = useMemo(
    () => (displayRawData ? applyAppleCut(displayRawData, appleCut) : displayRawData),
    [displayRawData, appleCut]
  );

  // Calculator gross input is always derived from displayRawData (never from `data`)
  // so the Apple cut toggle in the topbar stays purely a *display* concern —
  // the calculator subtracts its own commission internally based on the
  // chosen tier (sbp/standard) and would otherwise double-count.
  const calcGross = useMemo(() => extractGrossPeriod(displayRawData), [displayRawData]);
  const calcPeriodDays = useMemo(() => extractPeriodDays(displayRawData), [displayRawData]);

  // Hooks must be unconditional; guard against `data` being undefined during skeleton.
  // Headline strip = first 5 charts (revenue, mrr, arr, actives, churn) + a synthetic
  // "Today" cell injected at index 4 → 6 cells total. Side mini charts skip revenue
  // (since it's the main chart) and stop before the matrix block.
  const headlineCharts = useMemo(() => data?.charts.slice(0, 5) ?? [], [data]);
  const sideCharts = useMemo(() => data?.charts.slice(1, 5) ?? [], [data]);
  const matrixCharts = useMemo(() => data?.charts.slice(5) ?? [], [data]);
  const mainChart = data?.charts[0];
  const overviewById = useMemo(() => {
    return new Map((data?.overview?.metrics ?? []).map((metric) => [metric.id, metric]));
  }, [data]);

  useEffect(() => {
    const stored = cached;
    const isFresh = stored && Date.now() - stored.fetchedAt < CLIENT_CACHE_TTL_MS;

    if (isFresh) {
      setIsLoading(false);
      setError(null);
      return;
    }

    setIsLoading(true);
    setError(null);

    const controller = new AbortController();
    let cancelled = false;

    (async () => {
      try {
        const apiQuery = new URLSearchParams({ range: rangeKey, currency: SOURCE_CURRENCY });
        if (rangeKey === "custom" && customRange) {
          apiQuery.set("from", customRange.from);
          apiQuery.set("to", customRange.to);
        }
        const response = await fetch(`/api/revenuecat?${apiQuery.toString()}`, {
          signal: controller.signal,
          cache: "no-store"
        });
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload.message ?? "Unable to load RevenueCat data.");
        }
        if (cancelled) return;
        const demoRange = getRangeConfig(rangeKey, customRange ?? undefined);
        const next: DashboardResponse = payload.configured
          ? payload
          : { ...createDemoDashboard(demoRange), app: null, currency: SOURCE_CURRENCY };
        setCache((prev) => ({ ...prev, [cacheKey]: { payload: next, fetchedAt: Date.now() } }));
      } catch (loadError) {
        if (cancelled || (loadError as Error).name === "AbortError") return;
        setError(loadError instanceof Error ? loadError.message : "Unknown dashboard error");
        // Fall back to demo data only if we have nothing else cached for this key.
        if (!stored) {
          const fallback: DashboardResponse = {
            ...createDemoDashboard(getRangeConfig(rangeKey, customRange ?? undefined)),
            app: null,
            currency: SOURCE_CURRENCY
          };
          setCache((prev) => ({ ...prev, [cacheKey]: { payload: fallback, fetchedAt: Date.now() } }));
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
    // Depending on `cached` (the entry for *this* key) means an unrelated range's
    // fetch completing won't accidentally re-trigger this effect.
  }, [cacheKey, rangeKey, currency, cached]);

  const noticeMessage =
    error ??
    data?.warning ??
    (data && !data.configured
      ? data.message ?? "Demo data — set REVENUECAT_API_KEY to go live."
      : null);

  return (
    <div className="shell">
      <TopBar
        rangeKey={rangeKey}
        setRangeKey={setRangeKey}
        customRange={customRange}
        onCustomRangeChange={(next) => {
          setCustomRange(next);
          setRangeKey("custom");
        }}
        currency={currency}
        setCurrency={setCurrency}
        appleCut={appleCut}
        onAppleCutChange={handleAppleCutChange}
        italianTaxes={italianTaxes}
        onItalianTaxesChange={handleItalianTaxesChange}
        onOpenCalculator={() => setCalcOpen(true)}
        isLoading={isLoading}
        configured={data?.configured ?? false}
        fetchedAt={data?.fetchedAt}
        projectId={data?.projectId}
        app={data?.app ?? null}
      />

      {italianTaxes && (
        <NetCalculatorSheet
          open={calcOpen}
          onOpenChange={setCalcOpen}
          state={calcState}
          onStateChange={handleCalcStateChange}
          grossPeriod={calcGross}
          periodDays={calcPeriodDays}
          periodLabel={data?.range.label ?? getRangeConfig(rangeKey).label}
          currency={currency}
        />
      )}

      {noticeMessage && <Notice message={noticeMessage} />}

      <div className="content">
        {!data ? (
          <DashboardSkeleton range={getRangeConfig(rangeKey, customRange ?? undefined)} />
        ) : (
          <>
            <section className="section" aria-label="Headline metrics">
              <SectionHead num="01" title="Headline metrics" meta={data.range.label} />
              <div className="kpi-strip">
                {headlineCharts.slice(0, 4).map((chart) => (
                  <KpiCell
                    key={chart.name}
                    chart={chart}
                    currency={data.currency}
                    overviewMetric={overviewById.get(getOverviewMetricId(chart.name))}
                    rangeKey={data.range.key}
                  />
                ))}
                {mainChart && (
                  <TodayKpiCell
                    today={data.today ?? null}
                    revenueChart={mainChart}
                    currency={data.currency}
                  />
                )}
                {headlineCharts.slice(4).map((chart) => (
                  <KpiCell
                    key={chart.name}
                    chart={chart}
                    currency={data.currency}
                    overviewMetric={overviewById.get(getOverviewMetricId(chart.name))}
                    rangeKey={data.range.key}
                  />
                ))}
              </div>
            </section>

            {mainChart && (
              <section className="section" aria-label="Trajectory">
                <SectionHead num="02" title="Trajectory" meta={`${mainChart.label.toLowerCase()} · ${data.range.label.toLowerCase()}`} />
                <div className="chart-row">
                  <div className="chart-main">
                    <div className="chart-main-head">
                      <div className="chart-main-title">
                        <span className="chart-main-eye">{mainChart.description}</span>
                        <span className="chart-main-name">{mainChart.label}</span>
                      </div>
                      <MainStat chart={mainChart} currency={data.currency} />
                    </div>
                    <Plot
                      data={mainChart.data}
                      height={280}
                      kind={mainChart.kind}
                      currency={data.currency}
                      chartName={mainChart.name}
                      chartLabel={mainChart.label}
                    />
                  </div>
                  <div className="chart-side">
                    {/* Slot order mirrors the headline strip: mrr, arr, actives,
                        Today (synthetic, where Active Trials used to live), churn. */}
                    {sideCharts.slice(0, 3).map((chart) => (
                      <MiniChart key={chart.name} chart={chart} currency={data.currency} />
                    ))}
                    <TodayMiniChart
                      today={data.today ?? null}
                      revenueChart={mainChart}
                      currency={data.currency}
                    />
                    {sideCharts.slice(3).map((chart) => (
                      <MiniChart key={chart.name} chart={chart} currency={data.currency} />
                    ))}
                  </div>
                </div>
              </section>
            )}

            {matrixCharts.length > 0 && (
              <section className="section" aria-label="Auxiliary metrics">
                <SectionHead num="03" title="Auxiliary metrics" meta={`${matrixCharts.length} series`} />
                <div className="matrix">
                  {matrixCharts.map((chart) => (
                    <MatrixCell key={chart.name} chart={chart} currency={data.currency} />
                  ))}
                </div>
              </section>
            )}

            <section className="section" aria-label="Overview endpoint">
              <SectionHead num="04" title="Overview endpoint" meta={`${data.overview?.metrics?.length ?? 0} fields`} />
              <OverviewTable overview={data.overview} currency={data.currency} />
            </section>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Top bar ──────────────────────────────────────────────────

function TopBar({
  rangeKey,
  setRangeKey,
  customRange,
  onCustomRangeChange,
  currency,
  setCurrency,
  appleCut,
  onAppleCutChange,
  italianTaxes,
  onItalianTaxesChange,
  onOpenCalculator,
  isLoading,
  configured,
  fetchedAt,
  projectId,
  app
}: {
  rangeKey: RangeKey;
  setRangeKey: (range: RangeKey) => void;
  customRange: DateRange | null;
  onCustomRangeChange: (range: DateRange) => void;
  currency: CurrencyCode;
  setCurrency: (currency: CurrencyCode) => void;
  appleCut: boolean;
  onAppleCutChange: (next: boolean) => void;
  italianTaxes: boolean;
  onItalianTaxesChange: (next: boolean) => void;
  onOpenCalculator: () => void;
  isLoading: boolean;
  configured: boolean;
  fetchedAt?: string;
  projectId?: string;
  app?: DashboardResponse["app"];
}) {
  const appName = app?.name ?? projectId ?? "demo";

  return (
    <header className="topbar">
      <div className="topbar-inner">
        <div className="brand">
          <span className="brand-mark app-mark">
            {app?.iconUrl ? <img src={app.iconUrl} alt="" /> : getAppInitials(appName)}
          </span>
          <span className="brand-name">{appName}</span>
          {app?.type && <span className="brand-project">{formatAppType(app.type)}</span>}
        </div>

        <div className="topbar-spacer" />

        {italianTaxes && <NetCalculatorTrigger onClick={onOpenCalculator} />}

        <AppleCutToggle checked={appleCut} onCheckedChange={onAppleCutChange} />

        <div className="tabs currency-tabs" role="tablist" aria-label="Display currency">
          {(["USD", "EUR"] as CurrencyCode[]).map((option) => (
            <button
              key={option}
              type="button"
              role="tab"
              aria-selected={option === currency}
              data-active={option === currency}
              className="tab"
              onClick={() => setCurrency(option)}
            >
              {option}
            </button>
          ))}
        </div>

        <div className="tabs" role="tablist" aria-label="Date range">
          {RANGE_OPTIONS.map((option) => (
            <button
              key={option.key}
              type="button"
              role="tab"
              aria-selected={option.key === rangeKey}
              data-active={option.key === rangeKey}
              className="tab"
              onClick={() => setRangeKey(option.key)}
            >
              {option.shortLabel}
            </button>
          ))}
        </div>

        <DateRangePicker
          value={customRange}
          onChange={onCustomRangeChange}
          active={rangeKey === "custom"}
        />

        <ThemeToggle />
        <SettingsMenu
          italianTaxes={italianTaxes}
          onItalianTaxesChange={onItalianTaxesChange}
        />

        <div className="topbar-meta" data-loading={isLoading} aria-live="polite">
          {isLoading ? (
            <RefreshCw size={12} strokeWidth={2} />
          ) : (
            <span className="topbar-dot" data-live={configured} />
          )}
          {/* Timestamp always renders. While loading we fall back to `new Date()` so the
              column width is stable and the layout doesn't jump when data lands. */}
          <span suppressHydrationWarning>{formatDateTime(fetchedAt)}</span>
        </div>
      </div>
    </header>
  );
}

// Reads/writes the same `rc-theme` localStorage key that the inline init script
// in app/layout.tsx uses, so toggle state stays in sync across reloads with no flash.
function ThemeToggle() {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const initial = (document.documentElement.getAttribute("data-theme") as "light" | "dark" | null) ?? "light";
    setTheme(initial);
    setMounted(true);
  }, []);

  function toggle() {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem("rc-theme", next);
    } catch {
      /* storage may be blocked (private mode); ignore. */
    }
  }

  // Render a placeholder before mount so the icon doesn't flicker between sun/moon.
  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={toggle}
      aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
      title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
    >
      {mounted ? (
        theme === "dark" ? <Sun size={14} strokeWidth={1.8} /> : <Moon size={14} strokeWidth={1.8} />
      ) : (
        <Moon size={14} strokeWidth={1.8} />
      )}
    </button>
  );
}

// Topbar settings popover. Currently hosts a single feature flag
// ("Italian taxes" → forfettario calculator), but the layout is built so we
// can add more locale/feature toggles without changing the trigger or the
// container, just append rows. Uses shadcn Popover (Radix Dialog under the
// hood) so focus management, click-outside and escape behaviour come for
// free without polluting the dashboard with extra global listeners.
function SettingsMenu({
  italianTaxes,
  onItalianTaxesChange
}: {
  italianTaxes: boolean;
  onItalianTaxesChange: (next: boolean) => void;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="theme-toggle settings-toggle"
          aria-label="Open settings"
          title="Settings"
        >
          <SettingsIcon size={14} strokeWidth={1.8} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={6}
        className="settings-popover"
      >
        <div className="settings-eyebrow">SETTINGS</div>
        <div className="settings-section">
          <div className="settings-section-title">Locale features</div>
          <SettingsRow
            label="Italian taxes"
            hint="Show forfettario net-in-pocket calculator"
            checked={italianTaxes}
            onCheckedChange={onItalianTaxesChange}
            ariaLabel="Toggle Italian forfettario tax calculator"
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}

function SettingsRow({
  label,
  hint,
  checked,
  onCheckedChange,
  ariaLabel
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  ariaLabel: string;
}) {
  return (
    <label className="settings-row">
      <div className="settings-row-text">
        <span className="settings-row-label">{label}</span>
        {hint && <span className="settings-row-hint">{hint}</span>}
      </div>
      <Switch
        size="sm"
        checked={checked}
        onCheckedChange={onCheckedChange}
        aria-label={ariaLabel}
      />
    </label>
  );
}

function Notice({ message }: { message: string }) {
  return (
    <div className="notice" role="status">
      <TriangleAlert size={14} />
      <span className="notice-label">notice</span>
      <span>{message}</span>
    </div>
  );
}

// Inline topbar control. Visually weighted to match the segmented currency/range
// tabs (same border, height, mono 11px label) so it reads as a sibling control,
// not a foreign UI. When ON every currency value renders as gross × 0.85 (see
// applyAppleCut). The −15% marker turns accent-tinted to confirm active state.
function AppleCutToggle({
  checked,
  onCheckedChange
}: {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
}) {
  return (
    <label className="topbar-toggle" data-active={checked}>
      <span className="topbar-toggle-label">APPLE&apos;S CUT</span>
      <span className="topbar-toggle-pct">−15%</span>
      <Switch
        size="sm"
        checked={checked}
        onCheckedChange={onCheckedChange}
        aria-label="Apply Apple's 15% cut to revenue figures"
      />
    </label>
  );
}

// Converts the USD RevenueCat payload into the selected display currency without
// touching count/percent metrics. This keeps currency toggles off the API path.
function convertDisplayCurrency(
  data: DashboardResponse,
  currency: CurrencyCode,
  usdToEurRate: number
): DashboardResponse {
  if (currency === SOURCE_CURRENCY) {
    return data.currency === SOURCE_CURRENCY ? data : { ...data, currency: SOURCE_CURRENCY };
  }

  const factor = getDisplayCurrencyRate(currency, usdToEurRate);
  return scaleCurrencyValues(data, factor, currency);
}

// Returns a new DashboardResponse with every currency-shaped numeric scaled by
// NET_FACTOR when `enabled` is true. Pure / immutable so memoization stays
// correct. Counts and percentages are passed through unchanged. Comparison
// `percentDelta` doesn't need scaling because both sides shrink by the same
// factor, leaving the ratio identical.
function applyAppleCut(data: DashboardResponse, enabled: boolean): DashboardResponse {
  if (!enabled) return data;
  return scaleCurrencyValues(data, NET_FACTOR, data.currency as CurrencyCode);
}

// Scales only currency-shaped dashboard values and preserves ratio metrics.
function scaleCurrencyValues(data: DashboardResponse, factor: number, currency: CurrencyCode): DashboardResponse {
  const scale = (n: number | null | undefined) => (n == null ? n ?? null : n * factor);

  const charts = data.charts.map((chart) => {
    if (chart.kind !== "currency") return chart;
    return {
      ...chart,
      data: chart.data.map((point) => ({ ...point, value: point.value * factor })),
      latest: scale(chart.latest),
      previous: scale(chart.previous),
      delta: scale(chart.delta),
      metricValue: scale(chart.metricValue),
      comparison: chart.comparison
        ? {
            ...chart.comparison,
            currentValue: scale(chart.comparison.currentValue),
            previousValue: scale(chart.comparison.previousValue),
            delta: scale(chart.comparison.delta)
          }
        : chart.comparison
    };
  });

  const today = data.today
    ? {
        ...data.today,
        yesterdayUtcValue: scale(data.today.yesterdayUtcValue),
        todayUtcValue: scale(data.today.todayUtcValue)
      }
    : data.today;

  // Overview metrics expose a `unit` field; treat anything currency-flavoured
  // ("$", "USD", "EUR", "€") as scalable. Counts ("subscriptions", "people")
  // and percent ("%") pass through as-is.
  const overview = data.overview
    ? {
        ...data.overview,
        metrics: data.overview.metrics?.map((metric) => {
          const unit = metric.unit ?? "";
          const isCurrency = /[$€£¥]/.test(unit) || /usd|eur|gbp|jpy/i.test(unit);
          if (!isCurrency) return metric;
          return {
            ...metric,
            unit: currency,
            value: typeof metric.value === "number" ? metric.value * factor : metric.value
          };
        })
      }
    : data.overview;

  return { ...data, currency, charts, today, overview };
}

function getDisplayCurrencyRate(currency: CurrencyCode, usdToEurRate: number) {
  if (currency === "EUR") {
    return Number.isFinite(usdToEurRate) && usdToEurRate > 0 ? usdToEurRate : getFallbackUsdToEurRate();
  }

  return 1;
}

function getFallbackUsdToEurRate() {
  return Number.isFinite(FALLBACK_USD_TO_EUR_RATE) && FALLBACK_USD_TO_EUR_RATE > 0
    ? FALLBACK_USD_TO_EUR_RATE
    : 0.92;
}

// ─── Section primitives ───────────────────────────────────────

function SectionHead({ num, title, meta }: { num: string; title: string; meta?: string }) {
  return (
    <div className="section-head">
      <div className="section-title">
        <span className="section-title-num">{num}</span>
        <h2>{title}</h2>
      </div>
      {meta && <span className="section-meta">{meta}</span>}
    </div>
  );
}

// ─── Skeleton ─────────────────────────────────────────────────
// Mirrors the live dashboard's grid so layout doesn't jump when data lands.

function DashboardSkeleton({ range }: { range: ReturnType<typeof getRangeConfig> }) {
  return (
    <>
      <section className="section" aria-busy="true" aria-label="Loading headline metrics">
        <SectionHead num="01" title="Headline metrics" meta={range.label} />
        <div className="kpi-strip">
          {Array.from({ length: 6 }).map((_, i) => (
            <article key={i} className="kpi-cell">
              <span className="skel skel--sm" style={{ width: 64 }} />
              <span className="skel skel--lg" style={{ width: 110, marginTop: 8 }} />
              <span className="skel skel--sm" style={{ width: 90, marginTop: 8 }} />
            </article>
          ))}
        </div>
      </section>

      <section className="section" aria-busy="true" aria-label="Loading trajectory">
        <SectionHead num="02" title="Trajectory" meta={range.label.toLowerCase()} />
        <div className="chart-row">
          <div className="chart-main">
            <div className="chart-main-head">
              <div className="chart-main-title">
                <span className="skel skel--sm" style={{ width: 180 }} />
                <span className="skel skel--md" style={{ width: 110, marginTop: 6 }} />
              </div>
              <span className="skel skel--lg" style={{ width: 130 }} />
            </div>
            <div className="skel skel--block" style={{ height: 280, marginTop: 8 }} />
          </div>
          <div className="chart-side">
            {Array.from({ length: 5 }).map((_, i) => (
              <article key={i} className="chart-mini">
                <div className="chart-mini-head">
                  <span className="skel skel--sm" style={{ width: 90 }} />
                  <span className="skel skel--sm" style={{ width: 60 }} />
                </div>
                <div className="skel skel--block" style={{ height: 32 }} />
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="section" aria-busy="true" aria-label="Loading auxiliary metrics">
        <SectionHead num="03" title="Auxiliary metrics" meta="3 series" />
        <div className="matrix">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="matrix-cell">
              <div className="matrix-head">
                <div className="matrix-title">
                  <span className="skel skel--sm" style={{ width: 110 }} />
                  <span className="skel skel--sm" style={{ width: 200, marginTop: 6 }} />
                </div>
                <span className="skel skel--md" style={{ width: 80 }} />
              </div>
              <div className="skel skel--block" style={{ height: 140, marginTop: 8 }} />
            </div>
          ))}
        </div>
      </section>

      <section className="section" aria-busy="true" aria-label="Loading overview">
        <SectionHead num="04" title="Overview endpoint" />
        <div className="overview">
          <div className="overview-head">
            <span>Metric</span>
            <span style={{ textAlign: "right" }}>Value</span>
            <span style={{ textAlign: "right" }}>Period</span>
          </div>
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="overview-row">
              <span className="skel skel--sm" style={{ width: 140 }} />
              <span className="skel skel--sm" style={{ width: 80, justifySelf: "end" }} />
              <span className="skel skel--sm" style={{ width: 50, justifySelf: "end" }} />
            </div>
          ))}
        </div>
      </section>
    </>
  );
}

// ─── KPI cell ─────────────────────────────────────────────────

function KpiCell({
  chart,
  currency,
  overviewMetric,
  rangeKey
}: {
  chart: DashboardChart;
  currency: string;
  overviewMetric?: RevenueCatOverviewMetric;
  rangeKey: RangeKey;
}) {
  const metric = getHeadlineMetric(chart, overviewMetric, rangeKey);

  return (
    <article className="kpi-cell">
      <span className="kpi-label">{chart.label}</span>
      <span className="kpi-value">{formatMetric(metric.value, chart.kind, currency)}</span>
      <ComparisonBadge chart={chart} currency={currency} fallback={metric.scope} />
    </article>
  );
}

// "Today" tile: revenue accumulated since 00:00 in the user's *local* timezone.
//
// RevenueCat's chart API only exposes UTC daily buckets (no hourly resolution,
// no tz parameter — confirmed against v2 docs). To approximate "since local
// midnight" we take the two most recent UTC daily revenue totals (provided by
// the server's `today` payload) and weight them by how much of each UTC day
// falls inside the user's [local-midnight, now] window. Within the borrowed
// slice we assume revenue is distributed roughly uniformly — defensible for
// the typical 0–6h window most timezones need.
function TodayKpiCell({
  today,
  revenueChart,
  currency
}: {
  today: TodayPayload | null;
  revenueChart: DashboardChart;
  currency: string;
}) {
  const value = useLocalDayRevenue(today, revenueChart);
  return (
    <article className="kpi-cell">
      <span className="kpi-label">Today</span>
      <span className="kpi-value">{formatMetric(value, "currency", currency)}</span>
      <div className="kpi-meta">
        <span className="kpi-context">since 00:00 local</span>
      </div>
    </article>
  );
}

function MainStat({ chart, currency }: { chart: DashboardChart; currency: string }) {
  const metric = getRangeMetric(chart);

  return (
    <div className="chart-main-stat">
      <strong>{formatMetric(metric.value, chart.kind, currency)}</strong>
      <ComparisonBadge chart={chart} currency={currency} fallback={metric.scope} />
    </div>
  );
}

function MiniChart({ chart, currency }: { chart: DashboardChart; currency: string }) {
  // Mirror the headline KPI tone on both the value text *and* the sparkline,
  // so e.g. churn-up reads red end-to-end (number + line) instead of the line
  // staying green while only the number turns red. `data-tone` is consumed by
  // both `.chart-mini-value` and `.spark-line` in globals.css.
  const tone = getComparisonTone(chart);
  return (
    <article className="chart-mini">
      <div className="chart-mini-head">
        <span className="chart-mini-label">{chart.label}</span>
        <span className="chart-mini-value" data-tone={tone}>
          {formatMetric(getRangeMetric(chart).value, chart.kind, currency)}
        </span>
      </div>
      <Sparkline data={chart.data} className="chart-mini-spark" tone={tone} />
    </article>
  );
}

// Side-panel twin of TodayKpiCell. Same TZ-aware "since local midnight" value,
// rendered with the revenue trajectory underneath so it visually integrates
// with the other side mini charts.
function TodayMiniChart({
  today,
  revenueChart,
  currency
}: {
  today: TodayPayload | null;
  revenueChart: DashboardChart;
  currency: string;
}) {
  const value = useLocalDayRevenue(today, revenueChart);
  return (
    <article className="chart-mini">
      <div className="chart-mini-head">
        <span className="chart-mini-label">Today</span>
        <span className="chart-mini-value">{formatMetric(value, "currency", currency)}</span>
      </div>
      <Sparkline data={revenueChart.data} className="chart-mini-spark" />
    </article>
  );
}

// Estimates revenue between the user's local midnight and *now* by combining
// RC's UTC daily buckets — see TodayKpiCell for the constraint this works
// around. Returns null only when both buckets are missing. The hook keeps the
// number ticking forward by re-evaluating once a minute.
function useLocalDayRevenue(today: TodayPayload | null, revenueChart: DashboardChart): number | null {
  // Re-render once a minute so the displayed number doesn't go stale at 23:59 →
  // 00:01 boundaries (the bucket weighting flips when local midnight passes).
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  // Server-provided dedicated 2-day series is the source of truth. Fall back to
  // the main revenue chart's last two daily points when present (covers offline
  // demo + non-daily ranges where the dedicated fetch may have been missed).
  let yesterdayUtc = today?.yesterdayUtcValue ?? null;
  let todayUtc = today?.todayUtcValue ?? null;
  if (yesterdayUtc === null && todayUtc === null) {
    const last = revenueChart.data.at(-1);
    const prev = revenueChart.data.at(-2);
    if (last?.value !== undefined) todayUtc = last.value;
    if (prev?.value !== undefined) yesterdayUtc = prev.value;
  }
  if (yesterdayUtc === null && todayUtc === null) return null;

  const now = new Date();
  const localMidnightMs = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0).getTime();
  const utcMidnightTodayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0);
  const utcMidnightYesterdayMs = utcMidnightTodayMs - 86_400_000;
  const nowMs = now.getTime();

  // Window we want: [localMidnight, now]. Compute its overlap with each UTC
  // bucket, then assume uniform within-bucket distribution to weight the share.
  const yesterdayOverlapMs = Math.max(
    0,
    Math.min(nowMs, utcMidnightTodayMs) - Math.max(localMidnightMs, utcMidnightYesterdayMs)
  );
  const yesterdayShare = yesterdayOverlapMs / 86_400_000;

  // Today's UTC bucket value covers [utcMidnightToday, ~now]. We treat it as a
  // partial bucket whose width = (now − utcMidnightToday).
  const todayBucketMs = Math.max(1, nowMs - utcMidnightTodayMs);
  const todayOverlapMs = Math.max(0, nowMs - Math.max(localMidnightMs, utcMidnightTodayMs));
  const todayShare = todayOverlapMs / todayBucketMs;

  const ySafe = yesterdayUtc ?? 0;
  const tSafe = todayUtc ?? 0;
  return Math.round((ySafe * yesterdayShare + tSafe * todayShare) * 100) / 100;
}

function MatrixCell({ chart, currency }: { chart: DashboardChart; currency: string }) {
  const metric = getRangeMetric(chart);

  return (
    <div className="matrix-cell">
      <div className="matrix-head">
        <div className="matrix-title">
          <div className="matrix-label">{chart.label}</div>
          <div className="matrix-desc">{chart.description}</div>
        </div>
        <div className="matrix-stat">
          <span className="matrix-value">{formatMetric(metric.value, chart.kind, currency)}</span>
          <ComparisonBadge chart={chart} currency={currency} fallback={metric.scope} />
        </div>
      </div>
      <Plot
        data={chart.data}
        height={140}
        kind={chart.kind}
        currency={currency}
        chartName={chart.name}
        chartLabel={chart.label}
        compact
      />
    </div>
  );
}

function ComparisonBadge({
  chart,
  currency,
  fallback
}: {
  chart: DashboardChart;
  currency: string;
  fallback: string;
}) {
  const comparison = chart.comparison;
  const tone = getComparisonTone(chart);

  if (!comparison?.valid || comparison.delta === null) {
    return (
      <div className="kpi-meta">
        <span className="kpi-context">{fallback}</span>
      </div>
    );
  }

  return (
    <div className="kpi-meta">
      <span className="kpi-delta" data-tone={tone}>
        {comparison.delta > 0 && <ArrowUpRight size={11} strokeWidth={2.4} />}
        {comparison.delta < 0 && <ArrowDownRight size={11} strokeWidth={2.4} />}
        {formatComparisonDelta(chart, currency)}
      </span>
      <span className="kpi-context">vs {comparison.label}</span>
    </div>
  );
}

// ─── Overview table ───────────────────────────────────────────

function OverviewTable({
  overview,
  currency
}: {
  overview?: RevenueCatOverview | null;
  currency: string;
}) {
  const metrics = overview?.metrics ?? [];

  if (metrics.length === 0) {
    return (
      <div className="overview">
        <div className="overview-head">
          <span>Metric</span>
          <span style={{ textAlign: "right" }}>Value</span>
          <span style={{ textAlign: "right" }}>Period</span>
        </div>
        <p className="empty">Overview metrics will populate once REVENUECAT_API_KEY is configured.</p>
      </div>
    );
  }

  return (
    <div className="overview">
      <div className="overview-head">
        <span>Metric</span>
        <span style={{ textAlign: "right" }}>Value</span>
        <span style={{ textAlign: "right" }}>Period</span>
      </div>
      {metrics.map((metric) => (
        <div className="overview-row" key={metric.id}>
          <div className="overview-name">
            <strong>{metric.name}</strong>
            <span className="overview-id">{metric.id}</span>
          </div>
          <span className="overview-value">{formatOverviewValue(metric, currency)}</span>
          <span className="overview-period">{metric.period ?? "—"}</span>
        </div>
      ))}
    </div>
  );
}

// ─── Recharts plot (shadcn ChartContainer + interactive tooltip) ───

function Plot({
  data,
  height,
  kind,
  currency,
  chartName,
  chartLabel,
  compact = false
}: {
  data: DashboardPoint[];
  height: number;
  kind: DashboardChart["kind"];
  currency: string;
  chartName: string;
  chartLabel: string;
  compact?: boolean;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const chartConfig = {
    value: {
      label: chartLabel,
      color: "var(--accent)"
    }
  } satisfies ChartConfig;

  const series = data.map((point) => ({
    date: point.date,
    value: point.value
  }));

  const gradientId = `area-${chartName}`;

  if (!mounted) {
    return <div style={{ height, width: "100%" }} aria-hidden />;
  }

  return (
    <ChartContainer
      config={chartConfig}
      className="!aspect-auto w-full"
      style={{ height }}
    >
      <AreaChart
        data={series}
        margin={{ top: 6, right: 8, left: compact ? 0 : 4, bottom: 0 }}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-value)" stopOpacity={0.16} />
            <stop offset="80%" stopColor="var(--color-value)" stopOpacity={0.02} />
            <stop offset="100%" stopColor="var(--color-value)" stopOpacity={0} />
          </linearGradient>
        </defs>

        {!compact && (
          <CartesianGrid
            vertical={false}
            stroke="var(--grid)"
            strokeDasharray="0"
          />
        )}

        <XAxis
          dataKey="date"
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={32}
          interval="preserveStartEnd"
          tick={{ fontFamily: "var(--font-mono)", fontSize: 10, fill: "var(--fg-faint)" }}
          tickFormatter={(value: string) => shortDate(value)}
          hide={compact}
        />

        <YAxis
          width={compact ? 0 : 44}
          tickLine={false}
          axisLine={false}
          tickMargin={6}
          tickCount={4}
          tick={{ fontFamily: "var(--font-mono)", fontSize: 10, fill: "var(--fg-faint)" }}
          tickFormatter={(value: number) => shortMetric(value, kind, currency)}
          hide={compact}
        />

        <ChartTooltip
          cursor={{ stroke: "var(--fg-faint)", strokeDasharray: "3 3", strokeWidth: 1 }}
          content={
            <ChartTooltipContent
              indicator="line"
              labelFormatter={(label) => longDate(String(label))}
              formatter={(value, _name, item) => (
                <div className="flex flex-1 items-center justify-between gap-6">
                  <span className="text-muted-foreground">{chartLabel}</span>
                  <span className="text-foreground font-mono font-medium tabular-nums">
                    {formatMetric(Number(value), kind, currency)}
                  </span>
                  {item?.payload?.date ? null : null}
                </div>
              )}
            />
          }
        />

        <Area
          type="monotone"
          dataKey="value"
          stroke="var(--color-value)"
          strokeWidth={compact ? 1.6 : 1.8}
          fill={`url(#${gradientId})`}
          activeDot={{ r: 3.5, stroke: "var(--bg-elev)", strokeWidth: 1.5, fill: "var(--color-value)" }}
          dot={false}
          isAnimationActive={false}
        />
      </AreaChart>
    </ChartContainer>
  );
}

// ─── SVG sparkline ────────────────────────────────────────────

function Sparkline({
  data,
  className,
  tone
}: {
  data: DashboardPoint[];
  className?: string;
  tone?: "pos" | "neg" | "muted";
}) {
  if (data.length < 2) {
    return <svg className={className} viewBox="0 0 100 28" preserveAspectRatio="none" />;
  }

  const values = data.map((point) => point.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const w = 100;
  const h = 26;
  const pad = 2;

  const path = data
    .map((point, index) => {
      const x = (index / (data.length - 1)) * w;
      const y = h - pad - ((point.value - min) / span) * (h - pad * 2);
      return `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");

  return (
    <svg className={className} viewBox="0 0 100 28" preserveAspectRatio="none">
      <path d={path} className="spark-line" data-tone={tone} />
    </svg>
  );
}

// ─── Formatters ───────────────────────────────────────────────

function formatMetric(value: number | null, kind: DashboardChart["kind"], currency: string) {
  if (value === null || Number.isNaN(value)) {
    return "—";
  }

  if (kind === "currency") {
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency,
      maximumFractionDigits: Math.abs(value) >= 1000 ? 0 : 2
    }).format(value);
  }

  if (kind === "percent") {
    return `${value.toFixed(Math.abs(value) < 10 ? 2 : 1)}%`;
  }

  return new Intl.NumberFormat("en", { maximumFractionDigits: 0 }).format(value);
}

function shortMetric(value: number, kind: DashboardChart["kind"], currency: string) {
  if (kind === "currency") {
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency,
      notation: "compact",
      maximumFractionDigits: 1
    }).format(value);
  }

  if (kind === "percent") {
    return `${value.toFixed(0)}%`;
  }

  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function formatDateTime(value?: string) {
  // Always return a formatted timestamp so the topbar slot has a stable width
  // even before the first response lands (prevents layout shift on data arrival).
  const target = value ? new Date(value) : new Date();
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(target);
}

function shortDate(iso: string) {
  // ISO-like "yyyy-mm-dd" → "Mon dd"
  const [, m, d] = iso.split("-");
  if (!m || !d) return iso;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[Number(m) - 1] ?? m} ${Number(d)}`;
}

function getAppInitials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "RC";
}

function formatAppType(type: string) {
  return type.replaceAll("_", " ");
}

function longDate(iso: string) {
  const [y, m, d] = iso.split("-");
  if (!y || !m || !d) return iso;
  const date = new Date(Number(y), Number(m) - 1, Number(d));
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("en", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric"
  }).format(date);
}

function formatOverviewValue(metric: RevenueCatOverviewMetric, currency: string) {
  const unit = metric.unit ?? "";
  const isCurrency = /[$€£¥]/.test(unit) || /usd|eur|gbp|jpy/i.test(unit);

  if (isCurrency) {
    return new Intl.NumberFormat("en", {
      style: "currency",
      currency,
      maximumFractionDigits: 0
    }).format(metric.value);
  }
  if (metric.unit === "%") {
    return `${metric.value.toFixed(2)}%`;
  }
  return new Intl.NumberFormat("en", { maximumFractionDigits: 2 }).format(metric.value);
}

type ScopedMetric = {
  value: number | null;
  scope: string;
};

function getHeadlineMetric(
  chart: DashboardChart,
  overviewMetric: RevenueCatOverviewMetric | undefined,
  rangeKey: RangeKey
): ScopedMetric {
  if (chart.metricValue !== undefined) {
    return {
      value: chart.metricValue,
      scope: chart.metricScope ?? getLatestScope(chart)
    };
  }

  if (rangeKey === "28d" && overviewMetric) {
    return { value: overviewMetric.value, scope: overviewMetric.description?.toLowerCase() || "overview" };
  }

  return getRangeMetric(chart);
}

function getRangeMetric(chart: DashboardChart): ScopedMetric {
  if (chart.metricValue !== undefined) {
    return {
      value: chart.metricValue,
      scope: chart.metricScope ?? getLatestScope(chart)
    };
  }

  const summaryValue = getRangeSummaryValue(chart);

  if (summaryValue !== null) {
    return {
      value: summaryValue,
      scope: getSummaryScope(chart)
    };
  }

  return {
    value: chart.latest,
    scope: getLatestScope(chart)
  };
}

function getRangeSummaryValue(chart: DashboardChart) {
  const preferredKeys: Partial<Record<DashboardChart["name"], string>> = {
    revenue: "Revenue",
    customers_new: "New Customers",
    actives_new: "New Paid Subscriptions",
    churn: "Churn Rate",
    refund_rate: "Refund Rate"
  };
  const preferredKey = preferredKeys[chart.name] ?? chart.displayName ?? chart.label;
  const bucket = chart.name === "churn" || chart.name === "refund_rate" ? "average" : "total";
  const preferred = readNestedSummaryNumber(chart.summary, bucket, preferredKey);

  if (preferred !== null) {
    return preferred;
  }

  if (
    chart.name === "revenue" ||
    chart.name === "customers_new" ||
    chart.name === "actives_new"
  ) {
    return readFirstNestedSummaryNumber(chart.summary, "total");
  }

  if (chart.name === "churn" || chart.name === "refund_rate") {
    return readFirstNestedSummaryNumber(chart.summary, "average");
  }

  return null;
}

function getSummaryScope(chart: DashboardChart) {
  if (chart.name === "churn" || chart.name === "refund_rate") {
    return "average in range";
  }

  return "total in range";
}

function getLatestScope(chart: DashboardChart) {
  if (
    chart.name === "mrr" ||
    chart.name === "arr" ||
    chart.name === "actives"
  ) {
    return "current";
  }

  return "latest point";
}

// Strict yyyy-MM-dd guard for URL hydration. Anything that isn't a real
// calendar date (typo'd `2026-13-40`, empty string, prose) gets rejected so
// it never flows into the cache key or the API query.
function isIsoDateString(value: string | null): value is string {
  if (!value) return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

// Keeps the URL minimal: only writes a param when its value differs from the
// dashboard default. Used by the state → URL effect to avoid noisy URLs like
// `?range=28d&currency=USD&cut=0` when the operator hasn't changed anything.
function setOrDelete(params: URLSearchParams, key: string, value: string, defaultValue: string) {
  if (value === defaultValue) {
    params.delete(key);
  } else {
    params.set(key, value);
  }
}

function getComparisonTone(chart: DashboardChart): "pos" | "neg" | "muted" {
  const delta = chart.comparison?.valid ? chart.comparison.delta : null;
  if (delta === null || delta === 0) {
    return "muted";
  }

  const lowerIsBetter = chart.name === "churn" || chart.name === "refund_rate";
  const goodDirection = lowerIsBetter ? delta < 0 : delta > 0;
  return goodDirection ? "pos" : "neg";
}

function formatComparisonDelta(chart: DashboardChart, currency: string) {
  const delta = chart.comparison?.delta;
  if (delta === null || delta === undefined) {
    return "—";
  }

  const sign = delta > 0 ? "+" : "";
  if (chart.kind === "percent") {
    return `${sign}${delta.toFixed(Math.abs(delta) < 10 ? 2 : 1)}pp`;
  }

  return `${sign}${formatMetric(delta, chart.kind, currency)}`;
}

function readNestedSummaryNumber(summary: Record<string, unknown>, bucket: string, key: string) {
  const nested = summary[bucket];
  if (!nested || typeof nested !== "object") {
    return null;
  }

  const value = (nested as Record<string, unknown>)[key];
  return typeof value === "number" ? value : null;
}

function readFirstNestedSummaryNumber(summary: Record<string, unknown>, bucket: string) {
  const nested = summary[bucket];
  if (!nested || typeof nested !== "object") {
    return null;
  }

  const value = Object.values(nested as Record<string, unknown>).find((entry) => typeof entry === "number");
  return typeof value === "number" ? value : null;
}

// Reads the calculator state from localStorage if present. Defensive against
// shape drift (older blobs missing newer fields, hand-edited values) by
// validating each field individually and merging into the current defaults
// rather than blindly trusting JSON.parse. On any error we fall back to
// defaults — the user can always re-enter their preferences.
function readStoredCalcState(): NetCalculatorState {
  if (typeof window === "undefined") return NET_CALCULATOR_DEFAULTS;
  try {
    const raw = localStorage.getItem("rc-calc");
    if (!raw) return NET_CALCULATOR_DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<NetCalculatorState>;
    return mergeCalcState(NET_CALCULATOR_DEFAULTS, parsed);
  } catch {
    return NET_CALCULATOR_DEFAULTS;
  }
}

// Validates each known field; unknown / malformed values fall back to the
// default. This isolates the trust boundary between localStorage (untrusted)
// and the rest of the app (typed).
function mergeCalcState(base: NetCalculatorState, patch: Partial<NetCalculatorState>): NetCalculatorState {
  const out: NetCalculatorState = { ...base, extras: { ...base.extras } };

  if (patch.regime === "startup" || patch.regime === "regime") out.regime = patch.regime;
  if (patch.inpsMode === "fixed" || patch.inpsMode === "percent") out.inpsMode = patch.inpsMode;
  if (patch.inps === "full" || patch.inps === "partial") out.inps = patch.inps;
  if (patch.appleTier === "sbp" || patch.appleTier === "standard") out.appleTier = patch.appleTier;

  if (typeof patch.inpsFixed === "number" && Number.isFinite(patch.inpsFixed) && patch.inpsFixed >= 0) {
    out.inpsFixed = patch.inpsFixed;
  }

  if (patch.extras && typeof patch.extras === "object") {
    out.extras = mergeExtras(base.extras, patch.extras);
  }

  return out;
}

function mergeExtras(base: ExtrasInputs, patch: Partial<ExtrasInputs>): ExtrasInputs {
  const out: ExtrasInputs = {
    bollo: { ...base.bollo },
    commercialista: { ...base.commercialista },
    pecFirma: { ...base.pecFirma },
    cciaa: { ...base.cciaa }
  };
  for (const key of ["bollo", "commercialista", "pecFirma", "cciaa"] as const) {
    const incoming = patch[key];
    if (incoming && typeof incoming === "object") {
      if (typeof incoming.enabled === "boolean") out[key].enabled = incoming.enabled;
      if (typeof incoming.amount === "number" && Number.isFinite(incoming.amount) && incoming.amount >= 0) {
        out[key].amount = incoming.amount;
      }
    }
  }
  return out;
}

// Sum of every revenue point in the chart's window — works across daily,
// weekly and monthly resolutions because RC's bucket value is the per-bucket
// total. We pass `rawData` (never the appleCut-applied `data`) so the
// calculator owns the commission split.
function extractGrossPeriod(rawData: DashboardResponse | undefined): number | null {
  if (!rawData) return null;
  const revenueChart = rawData.charts.find((chart) => chart.name === "revenue") ?? rawData.charts[0];
  if (!revenueChart || revenueChart.data.length === 0) return null;
  return revenueChart.data.reduce((acc, point) => acc + point.value, 0);
}

// Period length for annualization. Prefers the range's explicit start/end
// dates; for "all" (no startDate) falls back to the first→last data point
// distance, with a +1 to count both endpoints inclusively.
function extractPeriodDays(rawData: DashboardResponse | undefined): number {
  if (!rawData) return 0;
  const range = rawData.range;
  if (range.startDate && range.endDate) {
    const start = new Date(range.startDate);
    const end = new Date(range.endDate);
    return Math.max(1, Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1);
  }
  const points = rawData.charts.find((chart) => chart.name === "revenue")?.data ?? rawData.charts[0]?.data;
  if (points && points.length >= 2) {
    const first = new Date(points[0].date);
    const last = new Date(points[points.length - 1].date);
    return Math.max(1, Math.round((last.getTime() - first.getTime()) / 86_400_000) + 1);
  }
  return 0;
}

// RevenueCat's overview endpoint uses ids that mostly match v2 chart slugs.
// This mapping is now identity-by-default; the explicit map exists for any future drift.
function getOverviewMetricId(chartName: DashboardChart["name"]) {
  const overviewMetricIds: Partial<Record<DashboardChart["name"], string>> = {
    revenue: "revenue",
    mrr: "mrr",
    arr: "arr",
    actives: "active_subscriptions",
    churn: "churn",
    customers_new: "new_customers"
  };
  return overviewMetricIds[chartName] ?? chartName;
}
