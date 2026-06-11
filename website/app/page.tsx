import RoutingDiagram from "./components/RoutingDiagram";
import CopyInstall from "./components/CopyInstall";
import CodeSample from "./components/CodeSample";
import SavingsCalculator from "./components/SavingsCalculator";
import StatusStrip from "./components/StatusStrip";
import Faq from "./components/Faq";
import { MODEL_COUNT, TEXT_MODEL_COUNT, textSavings } from "@/lib/prices";
import { statusSummary } from "@/lib/status-summary";

const REPO = "ai-lcr/ai-lcr";
const PKG = "ai-lcr";
const GITHUB_URL = `https://github.com/${REPO}`;
const NPM_URL = `https://www.npmjs.com/package/${PKG}`;
const DOCS_URL = "/docs";

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

function KeyIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
      <circle cx="8" cy="8" r="4.5" strokeLinecap="round" />
      <path d="M11.2 11.2 19 19M16 16l2-2M14 18l2-2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function LayersIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
      <path d="M12 3 21 8l-9 5-9-5 9-5Z" strokeLinejoin="round" />
      <path d="M3 13l9 5 9-5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function FailoverIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
      <path d="M4 9a8 8 0 0 1 13.7-3.3L20 8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M20 4v4h-4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M20 15a8 8 0 0 1-13.7 3.3L4 16" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4 20v-4h4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ReceiptIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
      <path d="M6 3h12v18l-2.5-1.5L13 21l-2.5-1.5L8 21l-2-1.5V3Z" strokeLinejoin="round" />
      <path d="M9.5 8h5M9.5 12h5" strokeLinecap="round" />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
      <path d="M12 3 20 6v6c0 4.5-3.2 7.6-8 9-4.8-1.4-8-4.5-8-9V6l8-3Z" strokeLinejoin="round" />
      <path d="m9 12 2 2 4-4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function TagIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
      <path d="M3.5 12.5 11 5h7v7l-7.5 7.5a1.5 1.5 0 0 1-2.1 0l-4.9-4.9a1.5 1.5 0 0 1 0-2.1Z" strokeLinejoin="round" />
      <circle cx="15" cy="9" r="1.4" fill="currentColor" stroke="none" />
    </svg>
  );
}

export default async function Home() {
  const [stars, version, status] = await Promise.all([getStars(), getVersion(), statusSummary()]);
  const displayVersion = version ?? FALLBACK_VERSION;
  const savings = textSavings();
  const topSaving = savings[0];

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
            <a href="/prices" title="Cheapest provider per model">
              <span className="label-hide">Prices</span>
            </a>
            <a className="nav__docs" href={DOCS_URL}>
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
            TokenMart, fal &amp; Runware — lowest price per token, every time. Built for the
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
            <div style={{ padding: "8px 20px 16px" }}>
              <RoutingDiagram maxWidth={640} />
            </div>
          </div>
          <p className="caption">
            ai-lcr takes the <b>cheapest healthy provider</b> — saving ~40% — and when
            one goes offline, reroutes mid-flight to the next cheapest. No dropped calls.
          </p>
        </section>

        <section className="block">
          <div className="block__head">
            <span className="eyebrow">
              <span className="dot" style={{ background: "var(--blue)" }} />
              Drop-in · one config
            </span>
            <h2 className="h2">
              List your providers <span className="accent">cheapest-first</span>. Call it like any
              AI SDK model.
            </h2>
            <p className="sub" style={{ marginTop: 12 }}>
              Mix a vendor&apos;s own official API with aggregators in one list. <code className="ic">lcr(&quot;…&quot;)</code>{" "}
              returns a standard model — it works with <code className="ic">generateText</code>,{" "}
              <code className="ic">streamText</code>, <code className="ic">generateObject</code>, tools and agents,
              unchanged.
            </p>
          </div>
          <CodeSample />
        </section>

        <section className="block">
          <div className="block__head">
            <span className="eyebrow">
              <span className="dot" style={{ background: "var(--green)" }} />
              What you&apos;d save
            </span>
            <h2 className="h2">
              {topSaving
                ? <>Cut your bill up to <span className="accent">−{topSaving.discountPct}%</span> — without changing a line of app code.</>
                : <>See what you&apos;d <span className="accent">save</span>.</>}
            </h2>
            <p className="sub" style={{ marginTop: 12 }}>
              The same model costs different amounts on different providers. Pick yours and your
              monthly spend — ai-lcr routes to the cheapest <strong>verified</strong> route and tracks
              the real cost per call.
            </p>
          </div>
          <SavingsCalculator models={savings} />
        </section>

        <section className="block">
          <div className="block__head">
            <span className="eyebrow">
              <span className="dot" style={{ background: "var(--amber)" }} />
              Same model, fully tested at a cheaper price
            </span>
            <h2 className="h2">
              A discount is worthless if the provider <span className="accent">quietly breaks the wire</span>.
            </h2>
            <p className="sub" style={{ marginTop: 12 }}>
              List price ≠ effective price. ai-lcr ships a zero-dependency probe that vets the things
              that actually cost you money or corrupt output — <strong>per model</strong> — so a cheaper
              route only gets ranked if it behaves. Results are live on the{" "}
              <a href="/status" className="ilink">status page</a>.
            </p>
          </div>
          <div className="checks">
            {[
              ["Tool calls", "single + multi-step round-trips with content: null — the shape every agent loop sends"],
              ["max_tokens honored", "the cap actually bounds output, so you aren't billed past your limit"],
              ["No hidden-prompt injection", "flags providers that react to a system prompt you never sent"],
              ["Token over-counting", "compares reported tokens to a trusted baseline — >1.5× means the bill is inflated"],
              ["Prompt caching", "checks that cache_control produces a real cache_read on repeats"],
              ["Native features intact", "route to a vendor's own API — no markup, no silently-stripped capabilities"],
            ].map(([title, desc]) => (
              <div className="check" key={title}>
                <span className="check__tick" aria-hidden>✓</span>
                <div>
                  <div className="check__title">{title}</div>
                  <div className="check__desc">{desc}</div>
                </div>
              </div>
            ))}
          </div>
          <StatusStrip providers={status.providers} allUp={status.allUp} anyData={status.anyData} />
        </section>

        <section className="features">
          {[
            { icon: <KeyIcon />, accent: "var(--green)", title: "Zero markup, your keys", desc: "Routes straight to each vendor's own API with your own keys — no proxy, no per-token fee, no lock-in." },
            { icon: <LayersIcon />, accent: "var(--blue)", title: `${TEXT_MODEL_COUNT + MODEL_COUNT} models priced`, desc: "Text, image & video routes compared per model. See the cheapest provider for each →", href: "/prices" },
            { icon: <FailoverIcon />, accent: "var(--amber)", title: "Automatic failover", desc: "When a provider errors — even mid-stream — traffic reroutes to the next cheapest healthy one." },
            { icon: <ShieldIcon />, accent: "var(--green)", title: "Quarantines bad providers", desc: "A circuit breaker most fallback libraries skip: one that keeps failing is benched, not re-probed on every call — then auto-recovered." },
            { icon: <TagIcon />, accent: "var(--blue)", title: "Zero-config pricing", desc: "A bundled price table prices native-maker routes with no hand-typed cost — add discount for a flat-rate reseller." },
            { icon: <ReceiptIcon />, accent: "var(--violet)", title: "Real cost tracking", desc: "An onCost callback fires the actual USD per call, so you can see and attribute every dollar." },
          ].map((f, i) => {
            const inner = (
              <>
                <span className="feature__ic" style={{ color: f.accent }}>{f.icon}</span>
                <div className="feature__title">{f.title}</div>
                <div className="feature__desc">{f.desc}</div>
              </>
            );
            const style = { "--accent": f.accent, animationDelay: `${0.1 + i * 0.06}s` } as React.CSSProperties;
            return f.href ? (
              <a key={f.title} href={f.href} className="feature reveal" style={style}>{inner}</a>
            ) : (
              <div key={f.title} className="feature reveal" style={style}>{inner}</div>
            );
          })}
        </section>

        <section className="block">
          <div className="block__head">
            <span className="eyebrow">
              <span className="dot" style={{ background: "var(--blue)" }} />
              FAQ
            </span>
            <h2 className="h2">
              Questions, <span className="accent">answered</span>.
            </h2>
          </div>
          <Faq />
        </section>

        <section className="finale reveal">
          <span className="eyebrow">
            <span className="dot" />
            MIT · drop-in · zero lock-in
          </span>
          <h2 className="finale__h">
            Stop paying list price for the <span className="accent">same tokens</span>.
          </h2>
          <p className="finale__sub">
            One config across every provider, cheapest healthy route on every call, automatic
            failover, and the receipts to prove the discount is real. Add it in one line.
          </p>
          <div className="finale__install">
            <CopyInstall />
          </div>
          <div className="cta cta--center">
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
            <a className="btn btn--ghost" href={DOCS_URL}>
              Read the docs
              <ArrowIcon />
            </a>
          </div>
        </section>
      </main>

      <footer className="footer">
        <div className="wrap footer__row">
          <span>ai-lcr — MIT · Least Cost Routing, the way carriers have done it for decades</span>
          <span className="footer__links">
            <a href="/status">Status</a>
            <a href="/prices">Prices</a>
            <a href={GITHUB_URL} target="_blank" rel="noreferrer">GitHub</a>
            <a href={NPM_URL} target="_blank" rel="noreferrer">npm</a>
            <a href={DOCS_URL}>Docs</a>
          </span>
        </div>
      </footer>
    </>
  );
}
