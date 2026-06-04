// Tailwind v4 only generates utilities/preflight for CSS files that
// `@import "tailwindcss"` — currently just app/docs/docs.css. The hand-rolled
// app/globals.css doesn't import it, so the marketing pages stay untouched.
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};

export default config;
