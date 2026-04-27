// FILE: app/layout.tsx
// Purpose: Root document shell, font wiring, global metadata.
// Layer: Next.js App Router layout
// Exports: RootLayout, metadata
// Depends on: app/globals.css, geist/font

import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import "./globals.css";

export const metadata: Metadata = {
  title: "RevenueCat — operator console",
  description: "A minimal, read-only RevenueCat operator console."
};

// ─── ENTRY POINT ─────────────────────────────────────────────

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
