"use client";

import { useEffect, useState } from "react";

/* geometry */
const MX = 172; // model chip right edge / wire start
const PX = 828; // provider chip left edge / wire end
const HX = 500; // hub x
const HY = 300; // hub y
const K = 158; // curve strength

function wire(my: number, py: number) {
  return `M${MX},${my} C${MX + K},${my} ${HX - K},${HY} ${HX},${HY} C${
    HX + K
  },${HY} ${PX - K},${py} ${PX},${py}`;
}

type Provider = { id: string; name: string; sub: string; y: number };

const providers: Provider[] = [
  { id: "kunavo", name: "Kunavo", sub: "−20% EVERY MODEL", y: 110 },
  { id: "openrouter", name: "OpenRouter", sub: "WIDEST COVERAGE", y: 250 },
  { id: "fal", name: "fal.ai", sub: "IMAGE · VIDEO", y: 390 },
  { id: "runware", name: "Runware", sub: "CHEAPEST COMPUTE", y: 520 },
];

type Model = {
  id: string;
  name: string;
  kind: "TEXT" | "IMAGE";
  y: number;
  color: string;
  to: string; // primary provider id
  price: string;
  fb?: { to: string; toName: string }; // fallback target
};

const models: Model[] = [
  {
    id: "gemini",
    name: "Gemini 3 Pro",
    kind: "TEXT",
    y: 80,
    color: "var(--blue)",
    to: "kunavo",
    price: "−20% → Kunavo",
    fb: { to: "openrouter", toName: "OpenRouter" },
  },
  {
    id: "deepseek",
    name: "DeepSeek V4",
    kind: "TEXT",
    y: 190,
    color: "var(--teal)",
    to: "openrouter",
    price: "$0.43/M → OpenRouter",
  },
  {
    id: "nano",
    name: "Nano Banana 2",
    kind: "IMAGE",
    y: 300,
    color: "var(--green)",
    to: "kunavo",
    price: "$0.047 → Kunavo",
    fb: { to: "runware", toName: "Runware" },
  },
  {
    id: "imagen",
    name: "Imagen 4 Ultra",
    kind: "IMAGE",
    y: 410,
    color: "var(--violet)",
    to: "fal",
    price: "$0.060 → fal",
  },
  {
    id: "flux",
    name: "Flux Schnell",
    kind: "IMAGE",
    y: 520,
    color: "var(--pink)",
    to: "runware",
    price: "$0.0013 → Runware",
  },
];

const provY = (id: string) => providers.find((p) => p.id === id)!.y;

function Packets({
  id,
  color,
  n = 2,
  dur = 3,
}: {
  id: string;
  color: string;
  n?: number;
  dur?: number;
}) {
  return (
    <>
      {Array.from({ length: n }).map((_, i) => (
        <circle key={i} r={3.4} fill={color} filter="url(#glow)">
          <animateMotion
            dur={`${dur}s`}
            repeatCount="indefinite"
            begin={`-${(dur / n) * i}s`}
            calcMode="linear"
          >
            <mpath href={`#${id}`} xlinkHref={`#${id}`} />
          </animateMotion>
        </circle>
      ))}
    </>
  );
}

export default function Switchboard() {
  const [offline, setOffline] = useState(false);
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    if (mq.matches) return;

    let t: ReturnType<typeof setTimeout>;
    const down = () => {
      setOffline(true);
      t = setTimeout(() => {
        setOffline(false);
        t = setTimeout(down, 4400);
      }, 2700);
    };
    t = setTimeout(down, 3800);
    return () => clearTimeout(t);
  }, []);

  return (
    <svg className="board" viewBox="0 0 1000 600" role="img"
      aria-label="Live routing diagram: each model routes to its cheapest provider, with automatic fallback when a provider goes offline.">
      <defs>
        <filter id="glow" x="-80%" y="-80%" width="260%" height="260%">
          <feGaussianBlur stdDeviation="2.6" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <filter id="softglow" x="-80%" y="-80%" width="260%" height="260%">
          <feGaussianBlur stdDeviation="6" />
        </filter>
        <radialGradient id="hub" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="var(--green)" stopOpacity="0.4" />
          <stop offset="1" stopColor="var(--green)" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* column headers */}
      <text x={94} y={40} textAnchor="middle" className="colhead">
        MODELS YOU CALL
      </text>
      <text x={HX} y={40} textAnchor="middle" className="colhead">
        ai-lcr ROUTER
      </text>
      <text x={906} y={40} textAnchor="middle" className="colhead">
        CHEAPEST PROVIDER
      </text>

      {/* wires — glow + crisp; mpath references the crisp path id */}
      <g fill="none">
        {models.map((m) => {
          const d = wire(m.y, provY(m.to));
          const dim = offline && m.to === "kunavo";
          return (
            <g key={m.id} className="grp" style={{ opacity: dim ? 0.12 : 1 }}>
              <path d={d} stroke={m.color} strokeWidth={5} opacity={0.16} filter="url(#softglow)" />
              <path id={`w-${m.id}`} d={d} stroke={m.color} strokeWidth={1.7} opacity={0.6} />
            </g>
          );
        })}

        {/* fallback wires — only visible while offline */}
        {models
          .filter((m) => m.fb)
          .map((m) => {
            const d = wire(m.y, provY(m.fb!.to));
            const show = offline && m.to === "kunavo";
            return (
              <g key={`fb-${m.id}`} className="grp" style={{ opacity: show ? 1 : 0 }}>
                <path d={d} stroke="var(--amber)" strokeWidth={5} opacity={0.18} filter="url(#softglow)" />
                <path
                  id={`wfb-${m.id}`}
                  d={d}
                  stroke="var(--amber)"
                  strokeWidth={1.7}
                  strokeDasharray="2 5"
                  opacity={0.9}
                />
              </g>
            );
          })}
      </g>

      {/* packets */}
      {!reduced && (
        <>
          {models.map((m) => {
            const dim = offline && m.to === "kunavo";
            return (
              <g key={`p-${m.id}`} className="grp" style={{ opacity: dim ? 0.1 : 1 }}>
                <Packets id={`w-${m.id}`} color={m.color} n={2} dur={3.1} />
              </g>
            );
          })}
          {models
            .filter((m) => m.fb)
            .map((m) => {
              const show = offline && m.to === "kunavo";
              return (
                <g key={`pfb-${m.id}`} className="grp" style={{ opacity: show ? 1 : 0 }}>
                  <Packets id={`wfb-${m.id}`} color="var(--amber)" n={2} dur={2.6} />
                </g>
              );
            })}
        </>
      )}

      {/* router hub */}
      <g>
        <circle cx={HX} cy={HY} r={62} fill="url(#hub)" />
        {!reduced && (
          <circle cx={HX} cy={HY} r={33} fill="none" stroke="var(--green)" strokeWidth={1.4}>
            <animate attributeName="r" values="33;60" dur="2.6s" repeatCount="indefinite" />
            <animate attributeName="opacity" values="0.5;0" dur="2.6s" repeatCount="indefinite" />
          </circle>
        )}
        <circle
          className="ring-spin"
          cx={HX}
          cy={HY}
          r={45}
          fill="none"
          stroke="var(--green)"
          strokeWidth={1}
          strokeDasharray="3 9"
          opacity={0.55}
        />
        <circle cx={HX} cy={HY} r={33} fill="var(--panel)" stroke="var(--green)" strokeWidth={1.5} filter="url(#glow)" />
        <text x={HX} y={HY + 1} textAnchor="middle" className="router-label">
          ai-lcr
        </text>
        <text x={HX} y={HY + 14} textAnchor="middle" className="router-sub">
          ROUTE
        </text>
      </g>

      {/* model chips */}
      {models.map((m) => (
        <g key={`m-${m.id}`}>
          <rect className="chip-box" x={16} y={m.y - 23} width={156} height={46} rx={11} />
          <circle cx={36} cy={m.y - 3} r={4} fill={m.color} filter="url(#glow)" />
          <text x={50} y={m.y - 1} className="chip-name">
            {m.name}
          </text>
          <text x={50} y={m.y + 14} className="chip-sub">
            {m.kind}
          </text>
        </g>
      ))}

      {/* price labels riding near each source */}
      {models.map((m) => {
        const reroute = offline && m.to === "kunavo";
        return (
          <text
            key={`pl-${m.id}`}
            x={192}
            y={m.y - 12}
            className="price"
            style={{ fill: reroute ? "var(--amber)" : m.color }}
          >
            {reroute ? `↻ ${m.fb!.toName}` : m.price}
          </text>
        );
      })}

      {/* provider chips */}
      {providers.map((p) => {
        const off = offline && p.id === "kunavo";
        return (
          <g key={`prov-${p.id}`} className={`prov-${p.id} ${off ? "is-offline" : ""}`}>
            <rect className="chip-box" x={PX} y={p.y - 23} width={156} height={46} rx={11} />
            <text x={PX + 16} y={p.y - 1} className="chip-name" style={{ fill: off ? "var(--red)" : undefined }}>
              {p.name}
            </text>
            <text x={PX + 16} y={p.y + 14} className="chip-sub" style={{ fill: off ? "var(--red)" : undefined }}>
              {off ? "● OFFLINE — REROUTING" : p.sub}
            </text>
            {!off && (
              <text x={PX + 140} y={p.y + 3} textAnchor="end" fill="var(--green)" fontSize={13} filter="url(#glow)">
                ★
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
