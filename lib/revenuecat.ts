// FILE: lib/revenuecat.ts
// Purpose: Defines RevenueCat API access, chart catalog, and fetch error handling.
// Layer: Service client
// Exports: DEFAULT_CHARTS, getRevenueCatConfig, revenueCatFetch, ChartDefinition
// Depends on: native fetch
//
// Chart slugs MUST match the RevenueCat v2 enum at /projects/{id}/charts/{chart_name}.
// Verified against https://www.revenuecat.com/docs/api-v2 (2026-04).

export const REVENUECAT_API_BASE = "https://api.revenuecat.com/v2";

export type ChartDefinition = {
  // RevenueCat v2 chart slug used as the URL path component.
  name:
    | "revenue"
    | "mrr"
    | "arr"
    | "actives"
    | "churn"
    | "customers_new"
    | "actives_new"
    | "refund_rate";
  label: string;
  description: string;
  kind: "currency" | "number" | "percent";
};

// Chart order matters: first six populate the headline KPI strip + main chart.
export const DEFAULT_CHARTS: ChartDefinition[] = [
  {
    name: "revenue",
    label: "Revenue",
    description: "Gross revenue net of refunds and chargebacks.",
    kind: "currency"
  },
  {
    name: "mrr",
    label: "MRR",
    description: "Monthly recurring revenue at end of period.",
    kind: "currency"
  },
  {
    name: "arr",
    label: "ARR",
    description: "Annual recurring revenue at end of period.",
    kind: "currency"
  },
  {
    name: "actives",
    label: "Active subscriptions",
    description: "Currently paid, accessible subscriptions.",
    kind: "number"
  },
  {
    name: "churn",
    label: "Churn",
    description: "Subscription churn rate over the period.",
    kind: "percent"
  },
  {
    name: "customers_new",
    label: "New customers",
    description: "Customers acquired in the selected period.",
    kind: "number"
  },
  {
    name: "actives_new",
    label: "New paid subscriptions",
    description: "Newly paid subscriptions started in period.",
    kind: "number"
  },
  {
    name: "refund_rate",
    label: "Refund rate",
    description: "Refund share of revenue over time.",
    kind: "percent"
  }
];

// ─── ENTRY POINT ─────────────────────────────────────────────

export function getRevenueCatConfig() {
  const apiKey = process.env.REVENUECAT_API_KEY;

  const projectId = process.env.REVENUECAT_PROJECT_ID || undefined;
  const projectIds = (process.env.REVENUECAT_PROJECT_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // Expected format: "projectId:apiKey,projectId2:apiKey2"
  // (also accepts "projectId=apiKey" pairs).
  const projectKeysRaw = (process.env.REVENUECAT_PROJECT_KEYS ?? "").trim();
  const projectKeys: Record<string, string> = {};
  if (projectKeysRaw) {
    for (const pair of projectKeysRaw.split(",").map((s) => s.trim()).filter(Boolean)) {
      const [id, key] = pair.includes("=") ? pair.split("=", 2) : pair.split(":", 2);
      if (!id || !key) continue;
      projectKeys[id.trim()] = key.trim();
    }
  }

  return {
    apiKey,
    projectId,
    projectIds: projectIds.length ? projectIds : undefined,
    projectKeys: Object.keys(projectKeys).length ? projectKeys : undefined
  };
}

// Performs an authenticated RevenueCat GET and returns parsed JSON.
export async function revenueCatFetch(
  path: string,
  apiKey: string,
  query: Record<string, string> = {}
) {
  const url = new URL(`${REVENUECAT_API_BASE}${path}`);

  for (const [key, value] of Object.entries(query)) {
    if (value) {
      url.searchParams.set(key, value);
    }
  }

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json"
    },
    next: {
      revalidate: 60
    }
  });

  if (!response.ok) {
    const payload = await safeReadJson(response);
    const message = payload?.message ?? payload?.error ?? response.statusText;
    throw new Error(`RevenueCat ${response.status}: ${message}`);
  }

  return response.json();
}

// Reads error bodies without hiding the original HTTP status.
async function safeReadJson(response: Response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
