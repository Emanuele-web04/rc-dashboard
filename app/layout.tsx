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

// Inlined so the theme is applied before first paint — avoids a light/dark flash
// on hydration. Reads `rc-theme` from localStorage, then falls back to the OS
// preference. Writes the result to `documentElement[data-theme]` synchronously.
const themeInitScript = `(function(){try{var s=localStorage.getItem("rc-theme");var p=window.matchMedia("(prefers-color-scheme: dark)").matches;var t=s||(p?"dark":"light");document.documentElement.setAttribute("data-theme",t);}catch(e){}})();`;

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
