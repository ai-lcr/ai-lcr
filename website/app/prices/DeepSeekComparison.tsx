import styles from "./DeepSeekComparison.module.css";

const rates = [
  { model: "V4.1 Flash", kind: "Fresh input", officialOffPeak: 0.15, tokenifyOffPeak: 0.09, tokenifyPeak: 0.15, officialPeak: 0.3 },
  { model: "V4.1 Flash", kind: "Cache read", officialOffPeak: 0.003, tokenifyOffPeak: 0.003, tokenifyPeak: 0.006, officialPeak: 0.006 },
  { model: "V4.1 Flash", kind: "Output", officialOffPeak: 0.6, tokenifyOffPeak: 0.36, tokenifyPeak: 0.6, officialPeak: 1.2 },
  { model: "V4 Pro", kind: "Fresh input", officialOffPeak: 0.66, tokenifyOffPeak: 0.66, tokenifyPeak: 0.66, officialPeak: 1.32 },
  { model: "V4 Pro", kind: "Cache read", officialOffPeak: 0.022, tokenifyOffPeak: 0.044, tokenifyPeak: 0.044, officialPeak: 0.044 },
  { model: "V4 Pro", kind: "Output", officialOffPeak: 1.98, tokenifyOffPeak: 1.98, tokenifyPeak: 1.98, officialPeak: 3.96 },
] as const;

function usd(value: number): string {
  return `$${value.toFixed(3)}`;
}

export default function DeepSeekComparison() {
  return (
    <section className={styles.section} aria-labelledby="deepseek-pricing-title">
      <div className={styles.heading}>
        <div>
          <p className={styles.eyebrow}>DeepSeek · time-of-day pricing</p>
          <h2 id="deepseek-pricing-title">Where does each route win?</h2>
        </div>
        <span className={styles.date}>Rates checked Sep 30, 2026</span>
      </div>

      <div className={styles.takeaways}>
        <div className={styles.direct}>
          <span className={styles.kicker}>Official wins on V4 Pro cache</span>
          <strong>Off-peak only</strong>
          <p>Fresh input and output tie Tokenify; cached input costs half as much direct.</p>
        </div>
        <div className={styles.reseller}>
          <span className={styles.kicker}>Tokenify wins on generation</span>
          <strong>Flash all day · Pro at peak</strong>
          <p>Flash fresh input and output are 40% cheaper off-peak and 50% cheaper at peak; Pro saves 50% at peak.</p>
        </div>
      </div>

      <div className={styles.scroll}>
        <table className={styles.table}>
          <caption>USD per million tokens for the same DeepSeek model</caption>
          <thead>
            <tr>
              <th scope="col">Model</th>
              <th scope="col">Tokens</th>
              <th scope="col">DeepSeek off-peak</th>
              <th scope="col">Tokenify off-peak</th>
              <th scope="col">Tokenify peak</th>
              <th scope="col">DeepSeek peak</th>
            </tr>
          </thead>
          <tbody>
            {rates.map((rate) => (
              <tr key={`${rate.model}-${rate.kind}`}>
                <th scope="row">{rate.model}</th>
                <td>{rate.kind}</td>
                <td className={rate.officialOffPeak < rate.tokenifyOffPeak ? styles.directBest : undefined}>
                  {usd(rate.officialOffPeak)}
                  {rate.officialOffPeak < rate.tokenifyOffPeak && <span className={styles.srOnly}> cheaper off-peak</span>}
                </td>
                <td className={rate.tokenifyOffPeak < rate.officialOffPeak ? styles.resellerBest : undefined}>
                  {usd(rate.tokenifyOffPeak)}
                  {rate.tokenifyOffPeak < rate.officialOffPeak && <span className={styles.srOnly}> cheaper off-peak</span>}
                </td>
                <td className={rate.tokenifyPeak < rate.officialPeak ? styles.resellerBest : undefined}>
                  {usd(rate.tokenifyPeak)}
                  {rate.tokenifyPeak < rate.officialPeak && <span className={styles.srOnly}> cheaper at peak</span>}
                </td>
                <td>{usd(rate.officialPeak)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <aside className={styles.probe} aria-label="Tokenify live billing spot check">
        <div className={styles.probeAmount}>
          <span>3 live API calls · Sep 29 PT</span>
          <strong>$0.000778</strong>
          <span>Tokenify dashboard spend</span>
        </div>
        <p>
          A repeated V4.1 Flash prompt returned <strong>4,736 cache-read input tokens</strong>.
          The first call cost $0.000725; the repeated call cost $0.000043. A V4 Pro call cost
          $0.000010. The three API charges sum to the $0.000778 increase shown in Tokenify&apos;s
          dashboard. This is a small billing and cache spot check, not a model-quality benchmark.
        </p>
      </aside>

      <p className={styles.footnote}>
        DeepSeek peak pricing covers 35 hours per week. In Pacific Daylight Time: Sunday–Thursday
        18:00–21:00 and 23:00–03:00 the next day; Pacific Standard Time is one hour earlier
        (official UTC rule: Monday–Friday 01:00–04:00 and 06:00–10:00). All other hours are off-peak.
        Tokenify now publishes separate off-peak prices for V4.1 Flash in its <code>/v1/models</code> API;
        its V4 Pro price remains fixed. Tokenify&apos;s Flash cache-read rate matches DeepSeek in both windows.
        The retired V4 Flash is excluded because DeepSeek now routes that legacy ID to V4.1 Flash.
        Sources: <a href="https://api-docs.deepseek.com/quick_start/pricing/">DeepSeek</a>
        {" · "}<a href="https://api.tokenify.dev/v1/models">Tokenify models API</a>.
        {" "}<a href="/docs/providers/tokenify">Set up time-based routing</a>.
      </p>
    </section>
  );
}
