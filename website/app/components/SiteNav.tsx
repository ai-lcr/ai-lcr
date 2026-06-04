// Shared site header — the canonical top navigation used on /prices, /status,
// and any non-homepage page so every page can reach Docs and the header looks
// identical to the homepage. The homepage (app/page.tsx) keeps its own richer
// nav with the live star count + version; this mirrors its link set and styling.

const REPO = "victorzhrn/ai-lcr";
const GITHUB_URL = `https://github.com/${REPO}`;
const NPM_URL = "https://www.npmjs.com/package/ai-lcr";
const DOCS_URL = "/docs";

function LogoMark() {
  return (
    <svg className="brand__mark" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M5.5 12 H11" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M11 12 C15 12 15.5 6 19 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M11 12 C15 12 15.5 18 19 18" stroke="var(--blue)" strokeWidth="2" strokeLinecap="round" />
      <circle cx="5" cy="12" r="2.6" fill="currentColor" />
      <circle cx="19.4" cy="6" r="2.3" fill="currentColor" />
      <circle cx="19.4" cy="18" r="2" fill="var(--blue)" />
    </svg>
  );
}

function GitHubIcon() {
  return (
    <svg className="icon" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

function NpmIcon() {
  return (
    <svg className="icon" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M0 0v16h16V0H0Zm13 13h-2V5H8v8H3V3h10v10Z" />
    </svg>
  );
}

/** Which nav item represents the current page (gets aria-current). */
type Current = "status" | "prices" | "docs" | null;

export default function SiteNav({ current = null }: { current?: Current }) {
  const mark = (id: Current) => (current === id ? { "aria-current": "page" as const } : {});
  return (
    <nav className="nav">
      <div className="wrap nav__row">
        <a className="brand" href="/" style={{ textDecoration: "none", color: "inherit" }}>
          <LogoMark />
          <span className="brand__word">ai<b>-lcr</b></span>
        </a>
        <div className="nav__links">
          <a href="/status" title="Provider status" {...mark("status")}>
            <span className="live-dot" />
            <span className="label-hide">Status</span>
          </a>
          <a href="/prices" title="Cheapest provider per model" {...mark("prices")}>
            <span className="label-hide">Prices</span>
          </a>
          <a className="nav__docs" href={DOCS_URL} {...mark("docs")}>
            <span className="label-hide">Docs</span>
          </a>
          <a href={NPM_URL} target="_blank" rel="noreferrer">
            <NpmIcon />
            <span className="label-hide">npm</span>
          </a>
          <a href={GITHUB_URL} target="_blank" rel="noreferrer">
            <GitHubIcon />
            <span className="label-hide">GitHub</span>
          </a>
        </div>
      </div>
    </nav>
  );
}
