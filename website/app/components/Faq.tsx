// Server component. Renders a visible FAQ accordion (native <details>, no JS)
// plus matching FAQPage JSON-LD so the same Q&A is eligible for rich results.

interface QA {
  q: string;
  // Plain-text answer for the JSON-LD (must match the visible text).
  a: string;
}

const FAQS: QA[] = [
  {
    q: "Does ai-lcr work with the Vercel AI SDK?",
    a: "Yes. lcr(\"model-id\") returns a standard AI SDK language model, so it drops straight into generateText, streamText, generateObject, tool calls and agents with no other code changes. ai-lcr only decides which provider serves the call.",
  },
  {
    q: "How is ai-lcr different from OpenRouter or the Vercel AI Gateway?",
    a: "Those are hosted proxies that sit between you and the model and add their own markup. ai-lcr is a client-side router you configure in your own app: it calls each vendor's own API directly, with your own keys, at zero markup. You list the providers for a model cheapest-first — mixing aggregators and native vendor APIs — and ai-lcr picks the cheapest healthy one per call.",
  },
  {
    q: "What happens when a provider goes down?",
    a: "ai-lcr automatically falls back to the next cheapest healthy provider for that model. Failover is streaming-safe, so a provider erroring mid-stream reroutes without dropping the call.",
  },
  {
    q: "How does ai-lcr know a cheaper provider is actually safe to route to?",
    a: "A discount is worthless if the provider quietly breaks the wire protocol. ai-lcr ships a zero-dependency probe that verifies tool calls, that max_tokens is honored, that there is no hidden-prompt injection, that tokens aren't over-counted versus a trusted baseline, and that prompt caching works. Results run daily and are published live on the status page.",
  },
  {
    q: "Can I keep using my own API keys?",
    a: "Yes. ai-lcr routes straight to each vendor's own endpoint using the keys you provide, so you keep your billing relationship, rate limits and native features. There is no ai-lcr account and no proxy in the middle.",
  },
  {
    q: "Is ai-lcr free?",
    a: "Yes. ai-lcr is MIT-licensed, free and open source. You pay the underlying providers directly at their own rates — ai-lcr adds no fee or markup.",
  },
  {
    q: "Which providers and models are supported?",
    a: "ai-lcr routes across OpenRouter, TokenMart, DeepInfra, fal and Runware today, covering 80+ text, image and video models. The cheapest provider for each model is listed on the prices page, and you can add any OpenAI-compatible provider yourself.",
  },
];

export default function Faq() {
  const ld = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: FAQS.map((f) => ({
      "@type": "Question",
      name: f.q,
      acceptedAnswer: { "@type": "Answer", text: f.a },
    })),
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(ld) }}
      />
      <div className="faq">
        {FAQS.map((f) => (
          <details className="faq__item" key={f.q}>
            <summary className="faq__q">
              <span>{f.q}</span>
              <span className="faq__mark" aria-hidden />
            </summary>
            <p className="faq__a">{f.a}</p>
          </details>
        ))}
      </div>
    </>
  );
}
