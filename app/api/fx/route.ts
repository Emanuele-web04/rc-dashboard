// FILE: app/api/fx/route.ts
// Purpose: Server-side FX proxy for display-only currency conversion.
// Layer: API Route
// Exports: GET
// Depends on: Frankfurter/ECB exchange-rate data via native fetch

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type FxPayload = {
  base: string;
  target: string;
  rate: number;
  source: string;
  date?: string;
  cached?: boolean;
};

const DEFAULT_USD_TO_EUR_RATE = Number(process.env.NEXT_PUBLIC_USD_TO_EUR_RATE ?? "0.92");
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const fxCache = new Map<string, { expiresAt: number; payload: FxPayload }>();

// ─── ENTRY POINT ─────────────────────────────────────────────

// Returns a USD→EUR rate for browser display conversion without exposing a
// third-party dependency throughout the client code.
export async function GET(request: Request) {
  const url = new URL(request.url);
  const base = normalizeCurrency(url.searchParams.get("base") ?? "USD");
  const target = normalizeCurrency(url.searchParams.get("target") ?? "EUR");

  if (!base || !target) {
    return NextResponse.json({ message: "Invalid currency code." }, { status: 400 });
  }

  if (base === target) {
    return NextResponse.json({
      base,
      target,
      rate: 1,
      source: "identity"
    });
  }

  const cacheKey = `${base}:${target}`;
  const cached = fxCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return NextResponse.json({ ...cached.payload, cached: true });
  }

  try {
    const payload = await fetchFrankfurterRate(base, target);
    fxCache.set(cacheKey, {
      expiresAt: Date.now() + CACHE_TTL_MS,
      payload
    });
    return NextResponse.json(payload);
  } catch (error) {
    const fallbackRate = getFallbackRate(base, target);
    if (fallbackRate !== null) {
      return NextResponse.json({
        base,
        target,
        rate: fallbackRate,
        source: "env-fallback",
        message: error instanceof Error ? error.message : "Unable to fetch FX rate."
      });
    }

    return NextResponse.json(
      { message: error instanceof Error ? error.message : "Unable to fetch FX rate." },
      { status: 502 }
    );
  }
}

// ─── Provider helpers ────────────────────────────────────────

// Frankfurter mirrors ECB reference rates and supports arbitrary base/target
// pairs, keeping the app free of API keys for this lightweight display need.
async function fetchFrankfurterRate(base: string, target: string): Promise<FxPayload> {
  const endpoint = new URL("https://api.frankfurter.dev/v1/latest");
  endpoint.searchParams.set("base", base);
  endpoint.searchParams.set("symbols", target);

  const response = await fetch(endpoint, {
    headers: {
      Accept: "application/json"
    },
    next: {
      revalidate: CACHE_TTL_MS / 1000
    }
  });

  if (!response.ok) {
    throw new Error(`FX provider ${response.status}: ${response.statusText}`);
  }

  const payload = await response.json();
  const rate = Number(payload?.rates?.[target]);

  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error(`FX provider did not return a valid ${base}/${target} rate.`);
  }

  return {
    base,
    target,
    rate,
    source: "frankfurter-ecb",
    date: typeof payload?.date === "string" ? payload.date : undefined
  };
}

function normalizeCurrency(value: string) {
  const normalized = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(normalized) ? normalized : null;
}

function getFallbackRate(base: string, target: string) {
  if (base === "USD" && target === "EUR") {
    return validFallback(DEFAULT_USD_TO_EUR_RATE);
  }

  if (base === "EUR" && target === "USD") {
    const usdToEur = validFallback(DEFAULT_USD_TO_EUR_RATE);
    return usdToEur ? 1 / usdToEur : null;
  }

  return null;
}

function validFallback(value: number) {
  return Number.isFinite(value) && value > 0 ? value : null;
}
