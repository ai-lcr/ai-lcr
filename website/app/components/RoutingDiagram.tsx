"use client";

import { useEffect, useState } from "react";

// Brand palette (mirrors globals.css :root so the viz matches the site).
const C = {
  panel: "#0b1120",
  panel2: "#0e1626",
  line: "#273253",
  text: "#e9eef9",
  muted: "#97a3c0",
  faint: "#5b678a",
  green: "#4fe39a",
  blue: "#62a0ff",
  amber: "#ffb35c",
  red: "#ff5f6e",
};

// Cheapest $0.30 vs the priciest $0.50 → −40%. Keep SAVE in sync with the rows.
const SAVE = "−40%";
const ROW_X = 116;
const ROW_W = 312;
const ROW_H = 42;
const ROWS = [
  { name: "TokenMart", price: "$0.30 / 1M", y: 70 },
  { name: "OpenRouter", price: "$0.43 / 1M", y: 124 },
  { name: "Anthropic API", price: "$0.50 / 1M", y: 178 },
];
const REQ = { x: 18, y: 145, w: 60 }; // request token (vertically centred on the ladder)

type Phase = {
  active: number;
  down: number | null;
  flash: number | null;
  caption: string;
  tone: string;
};

const PHASES: Phase[] = [
  { active: 0, down: null, flash: null, tone: C.green, caption: "Serves the cheapest healthy provider — −40% vs the priciest route." },
  { active: 1, down: 0, flash: null, tone: C.amber, caption: "Cheapest errors → fails over to the next, mid-request." },
  { active: 0, down: null, flash: 0, tone: C.green, caption: "Re-probes the cheapest every ~60s → snaps back to the −40% route." },
];
const DURS = [2800, 2600, 2200];

export default function RoutingDiagram({ maxWidth = 520 }: { maxWidth?: number }) {
  const [i, setI] = useState(0);
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (mq.matches) {
      setReduced(true);
      return;
    }
    let t: ReturnType<typeof setTimeout>;
    const tick = (n: number) => {
      setI(n);
      t = setTimeout(() => tick((n + 1) % PHASES.length), DURS[n]);
    };
    t = setTimeout(() => tick(1), DURS[0]);
    return () => clearTimeout(t);
  }, []);

  const p = PHASES[reduced ? 0 : i];
  const cy = ROWS[p.active].y + ROW_H / 2;
  const wirePath = `M${REQ.x + REQ.w + 4},${REQ.y} C${REQ.x + REQ.w + 26},${REQ.y} ${ROW_X - 20},${cy} ${ROW_X},${cy}`;

  return (
    <svg viewBox="0 0 480 270" role="img" width="100%"
      aria-label="How ai-lcr routes: it serves the cheapest provider (−40% vs the priciest), fails over to the next when it errors, and snaps back to the cheapest once it recovers."
      style={{ maxWidth, margin: "8px auto", display: "block" }}>
      <defs>
        <filter id="rd-glow" x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation="2.2" result="b" />
          <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>

      {/* header */}
      <text x={ROW_X} y={40} fill={C.faint} fontSize={10.5} fontWeight={600} letterSpacing="0.6">
        CHEAPEST-FIRST LIST
      </text>

      {/* always-on savings badge — the headline */}
      <g>
        <rect x={338} y={26} width={124} height={24} rx={12} fill={C.panel} stroke={C.green} strokeWidth={1} />
        <circle cx={357} cy={38} r={3.4} fill={C.green} filter="url(#rd-glow)">
          {!reduced && <animate attributeName="opacity" values="1;0.3;1" dur="1.8s" repeatCount="indefinite" />}
        </circle>
        <text x={369} y={42} fontSize={12}>
          <tspan fill={C.muted}>saving </tspan>
          <tspan fill={C.green} fontWeight={700}>{SAVE}</tspan>
        </text>
      </g>

      {/* connector request → active provider */}
      <path d={wirePath} fill="none" stroke={p.tone} strokeWidth={2} opacity={0.85} />
      {!reduced && (
        <circle r={3.4} fill={p.tone} filter="url(#rd-glow)">
          <animateMotion key={`${i}`} dur="0.9s" repeatCount="indefinite" path={wirePath} calcMode="linear" />
        </circle>
      )}

      {/* request token */}
      <g>
        <rect x={REQ.x} y={REQ.y - 17} width={REQ.w} height={34} rx={9} fill={C.panel2} stroke={C.line} />
        <text x={REQ.x + REQ.w / 2} y={REQ.y - 2} textAnchor="middle" fill={C.text} fontSize={11.5} fontWeight={600}>call</text>
        <text x={REQ.x + REQ.w / 2} y={REQ.y + 11} textAnchor="middle" fill={C.faint} fontSize={8.5}>lcr("smart")</text>
      </g>

      {/* provider rows */}
      {ROWS.map((r, idx) => {
        const isDown = p.down === idx;
        const isActive = p.active === idx && !isDown;
        const isFlash = p.flash === idx;
        const isCheapest = idx === 0;
        const stroke = isDown ? C.red : isActive || isFlash ? C.green : C.line;
        const dim = !isActive && !isDown && !isFlash;
        return (
          <g key={r.name} opacity={dim ? 0.55 : 1}>
            <rect x={ROW_X} y={r.y} width={ROW_W} height={ROW_H} rx={11}
              fill={C.panel} stroke={stroke}
              strokeWidth={isActive || isDown || isFlash ? 1.8 : 1}
              filter={isActive ? "url(#rd-glow)" : undefined} />
            <circle cx={ROW_X + 20} cy={r.y + ROW_H / 2} r={4}
              fill={isDown ? C.red : isActive || isFlash ? C.green : C.faint}
              filter={isActive ? "url(#rd-glow)" : undefined} />
            <text x={ROW_X + 36} y={r.y + 18} fill={C.text} fontSize={12.5} fontWeight={600}>{r.name}</text>
            <text x={ROW_X + 36} y={r.y + 33} fill={C.muted} fontSize={10.5}>
              {r.price}
              {isCheapest && !isDown && <tspan fill={C.green} fontWeight={700} dx="5">· {SAVE}</tspan>}
            </text>
            <text x={ROW_X + ROW_W - 12} y={r.y + ROW_H / 2 + 4} textAnchor="end" fontSize={10.5} fontWeight={700}
              fill={isDown ? C.red : isActive ? C.green : isFlash ? C.green : C.faint}>
              {isDown ? "✕ down" : isActive ? "● serving" : isFlash ? "↩ recovered" : isCheapest ? "cheapest" : ""}
            </text>
          </g>
        );
      })}

      {/* caption */}
      <circle cx={18} cy={236} r={3.4} fill={p.tone} filter="url(#rd-glow)" />
      <text x={30} y={240} fill={C.muted} fontSize={11}>{p.caption}</text>
    </svg>
  );
}
