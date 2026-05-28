import Switchboard from "./components/Switchboard";
import CopyInstall from "./components/CopyInstall";

const REPO = "victorzhrn/ai-lcr";
const PKG = "ai-lcr";
const GITHUB_URL = `https://github.com/${REPO}`;
const NPM_URL = `https://www.npmjs.com/package/${PKG}`;
const DOCS_URL = `${GITHUB_URL}#readme`;

const FALLBACK_VERSION = "0.0.1";

// Revalidate hourly so star count + version stay live without a redeploy.
export const revalidate = 3600;

async function getStars(): Promise<number | null> {
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}`, {
      next: { revalidate },
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!r.ok) return null;
    const d = await r.json();
    return typeof d.stargazers_count === "number" ? d.stargazers_count : null;
  } catch {
    return null;
  }
}

async function getVersion(): Promise<string | null> {
  try {
    const r = await fetch(`https://registry.npmjs.org/${PKG}/latest`, {
      next: { revalidate },
    });
    if (!r.ok) return null;
    const d = await r.json();
    return typeof d.version === "string" ? d.version : null;
  } catch {
    return null;
  }
}

function fmtStars(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, "") + "k";
  return String(n);
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

function StarIcon() {
  return (
    <svg className="icon" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M8 .9l2.1 4.46 4.9.62-3.62 3.34.95 4.85L8 11.99 3.67 14.16l.95-4.85L1 5.97l4.9-.61z" />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg className="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
      <path d="M4 12 12 4M6 4h6v6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default async function Home() {
  const [stars, version] = await Promise.all([getStars(), getVersion()]);
  const displayVersion = version ?? FALLBACK_VERSION;

  return (
    <>
      <nav className="nav">
        <div className="wrap nav__row">
          <div className="brand">
            <LogoMark />
            <span className="brand__word">ai<b>-lcr</b></span>
          </div>
          <div className="nav__links">
            <a href="/status" title="Provider status">
              <span className="live-dot" />
              <span className="label-hide">Status</span>
            </a>
            <a className="nav__docs" href={DOCS_URL} target="_blank" rel="noreferrer">
              <span className="label-hide">Docs</span>
            </a>
            <a href={NPM_URL} target="_blank" rel="noreferrer">
              <NpmIcon />
              <span className="label-hide">npm</span>
              <span className="count count--ver">v{displayVersion}</span>
            </a>
            <a href={GITHUB_URL} target="_blank" rel="noreferrer">
              <GitHubIcon />
              <span className="label-hide">GitHub</span>
              {stars !== null && (
                <span className="count">
                  <StarIcon />
                  {fmtStars(stars)}
                </span>
              )}
            </a>
          </div>
        </div>
      </nav>

      <main className="wrap">
        <section className="hero">
          <span className="eyebrow reveal">
            <span className="dot" />
            Least Cost Routing · for LLMs
          </span>

          <h1 className="h1 reveal" style={{ animationDelay: "0.06s" }}>
            The <span className="accent">cheapest path</span> for every model you call.
          </h1>

          <p className="sub reveal" style={{ animationDelay: "0.14s" }}>
            <strong>Route each call to the cheapest provider that can serve it</strong>, and
            fall back automatically when one fails. One config across OpenRouter,
            Kunavo, fal &amp; Runware — lowest price per token, every time. Built for the
            Vercel AI SDK.
          </p>

          <div className="reveal" style={{ animationDelay: "0.2s" }}>
            <CopyInstall />
          </div>

          <div className="cta reveal" style={{ animationDelay: "0.26s" }}>
            <a className="btn btn--primary" href={GITHUB_URL} target="_blank" rel="noreferrer">
              <GitHubIcon />
              Star on GitHub
              {stars !== null && (
                <span className="btn__count">
                  <StarIcon />
                  {fmtStars(stars)}
                </span>
              )}
            </a>
            <a className="btn btn--ghost" href={NPM_URL} target="_blank" rel="noreferrer">
              <NpmIcon />
              npm
              <span className="btn__ver">v{displayVersion}</span>
              <ArrowIcon />
            </a>
          </div>
        </section>

        <section className="stage reveal" style={{ animationDelay: "0.34s" }}>
          <div className="console">
            <div className="console__bar">
              <div className="console__dots">
                <i /><i /><i />
              </div>
              <span className="console__title">
                <b>ai-lcr</b> · live routing
              </span>
              <span className="console__live">
                <i /> LIVE
              </span>
            </div>
            <Switchboard />
          </div>
          <p className="caption">
            Each request takes the <b>cheapest healthy provider</b> — when one goes
            offline, traffic reroutes mid-flight to the next cheapest. No dropped calls.
          </p>
        </section>

        <section className="stats">
          <div className="stat reveal" style={{ "--accent": "var(--green)", animationDelay: "0.1s" } as React.CSSProperties}>
            <div className="num">−30%</div>
            <div className="lbl">on Anthropic + Google models via Kunavo</div>
          </div>
          <div className="stat reveal" style={{ "--accent": "var(--blue)", animationDelay: "0.16s" } as React.CSSProperties}>
            <div className="num">11+</div>
            <div className="lbl">image models, cheapest provider per model</div>
          </div>
          <div className="stat reveal" style={{ "--accent": "var(--amber)", animationDelay: "0.22s" } as React.CSSProperties}>
            <div className="num">auto</div>
            <div className="lbl">failover the moment a provider errors</div>
          </div>
          <div className="stat reveal" style={{ "--accent": "var(--violet)", animationDelay: "0.28s" } as React.CSSProperties}>
            <div className="num">USD</div>
            <div className="lbl">real per-call cost tracking, built in</div>
          </div>
        </section>
      </main>

      <footer className="footer">
        <div className="wrap footer__row">
          <span>ai-lcr — MIT · Least Cost Routing, the way carriers have done it for decades</span>
          <span className="footer__links">
            <a href="/status">Status</a>
            <a href={GITHUB_URL} target="_blank" rel="noreferrer">GitHub</a>
            <a href={NPM_URL} target="_blank" rel="noreferrer">npm</a>
            <a href={DOCS_URL} target="_blank" rel="noreferrer">Docs</a>
          </span>
        </div>
      </footer>
    </>
  );
}
