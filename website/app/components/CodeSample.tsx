// Server component — static quick-start snippet with a tiny built-in
// highlighter so the homepage shows the real API surface, not just `npm install`.
import type { ReactNode } from "react";

const CODE = `import { createLCR, DEFAULT_PROVIDERS } from "ai-lcr";
import { generateText } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createDeepSeek } from "@ai-sdk/deepseek";

const tokenify = createOpenAICompatible({
  name: "tokenify",
  baseURL: DEFAULT_PROVIDERS.tokenify.baseURL,
  apiKey: process.env.TOKENIFY_API_KEY,
});
const deepseek = createDeepSeek({ apiKey: process.env.DEEPSEEK_API_KEY });

// DeepSeek V4.1 Flash peak rates; switch chains by time of day for off-peak.
const lcr = createLCR({
  autoSort: true,                  // order each model's providers cheapest-first
  models: {
    "deepseek-flash": [
      { model: tokenify("deepseek/deepseek-v4.1-flash"), cost: { input: 0.15, output: 0.60 } },
      { model: deepseek("deepseek-flash"), cost: { input: 0.30, output: 1.20 } },
    ],
  },
  onCost: ({ provider, costUsd }) => console.log(provider, costUsd),
});

// a standard AI SDK model — drop into streamText, generateObject, tools, agents
const { text } = await generateText({
  model: lcr("deepseek-flash"),
  prompt: "Explain Least Cost Routing in one sentence.",
});`;

const KEYWORDS = new Set(["import", "from", "const", "await", "true", "false", "new", "return"]);
const TOKEN = /("(?:[^"\\]|\\.)*"|\b\d+\.?\d*\b|[A-Za-z_$][\w$]*|\s+|[^\sA-Za-z_$"]+)/g;

function highlight(code: string): ReactNode[] {
  return code.split("\n").map((line, li) => {
    let body = line;
    let comment = "";
    const ci = line.indexOf("//");
    if (ci !== -1) {
      body = line.slice(0, ci);
      comment = line.slice(ci);
    }

    const nodes: ReactNode[] = [];
    let m: RegExpExecArray | null;
    let k = 0;
    TOKEN.lastIndex = 0;
    while ((m = TOKEN.exec(body))) {
      const t = m[0];
      if (t.startsWith('"')) nodes.push(<span key={k++} className="t-str">{t}</span>);
      else if (/^\d/.test(t)) nodes.push(<span key={k++} className="t-num">{t}</span>);
      else if (KEYWORDS.has(t)) nodes.push(<span key={k++} className="t-kw">{t}</span>);
      else if (/^[A-Za-z_$]/.test(t) && /^\s*\(/.test(body.slice(TOKEN.lastIndex)))
        nodes.push(<span key={k++} className="t-fn">{t}</span>);
      else nodes.push(<span key={k++}>{t}</span>);
    }
    if (comment) nodes.push(<span key="c" className="t-com">{comment}</span>);

    return (
      <span key={li}>
        {nodes}
        {"\n"}
      </span>
    );
  });
}

export default function CodeSample() {
  return (
    <pre className="code" aria-label="ai-lcr quick start">
      <code>{highlight(CODE)}</code>
    </pre>
  );
}
