import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { RootProvider } from "fumadocs-ui/provider/next";
import type { ReactNode } from "react";
import { source } from "@/lib/source";
import "./docs.css";

// The routing glyph from the site favicon (app/icon.svg) — a node splitting
// into a green/blue path — plus the brand wordmark, so the docs nav matches
// the marketing header (public/logo.svg) exactly.
const navTitle = (
  <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
    <svg viewBox="0 0 32 32" width="22" height="22" style={{ flexShrink: 0 }} aria-hidden>
      <defs>
        <linearGradient id="lcr-nav-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#0d1426" />
          <stop offset="1" stopColor="#060912" />
        </linearGradient>
        <radialGradient id="lcr-nav-glow" cx="0.32" cy="0.5" r="0.6">
          <stop offset="0" stopColor="#4fe39a" stopOpacity="0.32" />
          <stop offset="1" stopColor="#4fe39a" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect x="0.5" y="0.5" width="31" height="31" rx="7.5" fill="url(#lcr-nav-bg)" stroke="#273253" />
      <rect x="0.5" y="0.5" width="31" height="31" rx="7.5" fill="url(#lcr-nav-glow)" />
      <g fill="none" strokeLinecap="round" strokeWidth="2.6">
        <path d="M8 16 H15" stroke="#4fe39a" />
        <path d="M15 16 C20 16 20 9.5 24 9.5" stroke="#4fe39a" />
        <path d="M15 16 C20 16 20 22.5 24 22.5" stroke="#62a0ff" />
      </g>
      <circle cx="8" cy="16" r="3" fill="#4fe39a" />
      <circle cx="24" cy="9.5" r="2.7" fill="#4fe39a" />
      <circle cx="24" cy="22.5" r="2.3" fill="#62a0ff" />
    </svg>
    <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: "-0.02em" }}>
      <span style={{ color: "#e9eef9" }}>ai</span>
      <span style={{ color: "#4fe39a" }}>-lcr</span>
    </span>
  </div>
);

export const metadata = {
  title: "Docs — ai-lcr",
  description: "Integration guides for routing LLM calls to the cheapest provider.",
};

export default function Layout({ children }: { children: ReactNode }) {
  return (
    // The whole site is dark-only — globals.css hard-codes a dark <body>
    // background. Force fumadocs into dark mode so its prose foreground stays
    // light; a light theme would render near-black text on the dark body.
    <RootProvider
      theme={{ defaultTheme: "dark", forcedTheme: "dark", enableSystem: false }}
    >
      <DocsLayout
        tree={source.pageTree}
        // Logo returns to the marketing homepage — docs is a sub-section of the
        // main site, so clicking the brand should leave docs, not go to /docs.
        nav={{ title: navTitle, url: "/" }}
        // Connect back to the rest of the site from the docs top bar.
        links={[
          { text: "Status", url: "/status" },
          { text: "Prices", url: "/prices" },
        ]}
        githubUrl="https://github.com/victorzhrn/ai-lcr"
        themeSwitch={{ enabled: false }}
      >
        {children}
      </DocsLayout>
    </RootProvider>
  );
}
