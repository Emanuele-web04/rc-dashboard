// FILE: next.config.ts
// Purpose: Holds the minimal Next.js runtime configuration for the dashboard.
// Layer: Config
// Exports: nextConfig
// Depends on: next

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // RevenueCat's Charts & Metrics API is tightly rate-limited; avoid dev-only
  // StrictMode effect replays causing duplicate dashboard fetches.
  reactStrictMode: false
};

export default nextConfig;
