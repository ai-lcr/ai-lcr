import type { Metadata } from "next";
import { Bricolage_Grotesque, JetBrains_Mono, Hanken_Grotesk } from "next/font/google";
import PlausibleProvider from "next-plausible";
import "./globals.css";

const display = Bricolage_Grotesque({
  subsets: ["latin"],
  variable: "--font-display",
  display: "swap",
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

const body = Hanken_Grotesk({
  subsets: ["latin"],
  variable: "--font-body",
  display: "swap",
});

const description =
  "Route every model call to the cheapest provider that can serve it, fall back automatically on failure, and track real cost. One config across OpenRouter, Kunavo, fal & Runware. Built for the Vercel AI SDK.";

export const metadata: Metadata = {
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_SITE_URL ?? "https://ai-lcr.vercel.app"
  ),
  title: "ai-lcr — Least Cost Routing for LLMs",
  description,
  openGraph: {
    title: "ai-lcr — Least Cost Routing for LLMs",
    description,
    images: ["/ai-lcr-hero.svg"],
  },
  twitter: {
    card: "summary_large_image",
    title: "ai-lcr — Least Cost Routing for LLMs",
    description,
  },
  verification: {
    google: "UqGz5UGD4MAq8_l-V2YAGTpNqBTOHAOy9IixrLZzzgs",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${display.variable} ${mono.variable} ${body.variable}`}
    >
      <PlausibleProvider
        domain="ailcr.js.org"
        customDomain="https://plausible.ideamarketfit.com"
        trackOutboundLinks
        selfHosted
      >
        <body>{children}</body>
      </PlausibleProvider>
    </html>
  );
}
