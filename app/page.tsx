// FILE: app/page.tsx
// Purpose: Renders the RevenueCat dashboard as the first and only app surface.
// Layer: Next.js page
// Exports: Home
// Depends on: components/revenue-dashboard

import { RevenueDashboard } from "@/components/revenue-dashboard";

// ─── ENTRY POINT ─────────────────────────────────────────────

export default function Home() {
  return <RevenueDashboard />;
}
