import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { withPlausibleProxy } from "next-plausible";
import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();

// The parent repo (the npm package) has its own lockfile, so pin the
// workspace root to this folder to avoid Next picking the wrong root.
const here = dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  turbopack: { root: here },
  // pg is a native Node client — keep it out of the bundle so it loads at runtime.
  serverExternalPackages: ["pg"],
};

const plausibleConfig = withPlausibleProxy({
  customDomain: "https://plausible.ideamarketfit.com",
})(withMDX(nextConfig));

const plausibleRewrites = plausibleConfig.rewrites!;
// Events use the POST handler; keep script proxying and remove the external rewrite.
plausibleConfig.rewrites = async () => {
  const rewrites = await plausibleRewrites();
  const keep = (rules: { source: string }[] = []) =>
    rules.filter(({ source }) => source !== "/proxy/api/event");
  if (Array.isArray(rewrites)) return keep(rewrites) as typeof rewrites;
  return {
    beforeFiles: keep(rewrites.beforeFiles),
    afterFiles: keep(rewrites.afterFiles),
    fallback: keep(rewrites.fallback),
  } as typeof rewrites;
};

export default plausibleConfig;
