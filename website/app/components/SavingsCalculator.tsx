"use client";

import { useMemo, useState } from "react";
import type { TextSaving } from "@/lib/prices";
import Select from "./Select";

const PROVIDER_LABEL: Record<string, string> = {
  openrouter: "OpenRouter",
  kunavo: "Kunavo",
  tokenmart: "TokenMart",
};

function money(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
}

export default function SavingsCalculator({ models }: { models: TextSaving[] }) {
  const [id, setId] = useState(models[0]?.id ?? "");
  const [spend, setSpend] = useState(2000);

  const model = useMemo(() => models.find((m) => m.id === id) ?? models[0], [models, id]);

  if (!model) return null;

  const d = model.discountPct / 100;
  const saved = Math.round(spend * d);
  const after = spend - saved;
  const provider = PROVIDER_LABEL[model.cheapestProvider] ?? model.cheapestProvider;

  return (
    <div className="calc">
      <div className="calc__controls">
        <label className="calc__field">
          <span className="calc__lbl">Model</span>
          <Select
            value={id}
            onChange={setId}
            ariaLabel="Model"
            options={models.map((m) => ({
              value: m.id,
              label: m.name,
              hint: `−${m.discountPct}%`,
            }))}
          />
        </label>

        <label className="calc__field">
          <span className="calc__lbl">Monthly spend at list price</span>
          <div className="calc__money">
            <span className="calc__cur">$</span>
            <input
              type="number"
              min={0}
              step={100}
              value={spend}
              onChange={(e) => setSpend(Math.max(0, Number(e.target.value) || 0))}
              aria-label="Monthly spend in US dollars"
            />
            <span className="calc__per">/ mo</span>
          </div>
        </label>
      </div>

      <div className="calc__out">
        <div className="calc__bigrow">
          <div className="calc__big">
            <span className="calc__bignum">${money(saved)}</span>
            <span className="calc__bigsub">saved / month</span>
          </div>
          <div className="calc__big calc__big--alt">
            <span className="calc__bignum calc__bignum--alt">${money(saved * 12)}</span>
            <span className="calc__bigsub">/ year</span>
          </div>
        </div>
        <p className="calc__line">
          ai-lcr routes <b>{model.name}</b> to <b className="calc__prov">{provider}</b>{" — "}
          you&apos;d pay <b>${money(after)}/mo</b> instead of ${money(spend)}, a{" "}
          <b>−{model.discountPct}%</b> cut.
        </p>
      </div>

      <p className="calc__note">
        Estimate: list price (OpenRouter) vs the cheapest <b>verified</b> route, blended input + output.
        Your real mix and volume shift the number — see the full table on{" "}
        <a href="/prices">Prices</a>.
      </p>
    </div>
  );
}
