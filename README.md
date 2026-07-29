# Polaxory Mirror

Paste a Solana wallet. The engine rebuilds every closed trade, separates what the
market did to you from what the house took, measures the habits behind it, and
states only what the sample can prove.

Built to [`STUDIO.md`](./STUDIO.md) — the operating code. Read it first; it explains
why the files sit where they sit, and it is the reason this codebase prints its own
formulas and refuses to score a thin sample.

**Before deploying, run `npm run preflight` with a real Helius key.** Everything in
this repo was built and tested against synthetic data — 549 assertions, zero real
transactions. Preflight is the first contact with reality and it takes about a minute.

**Cost to run: $0.** Free Helius tier, free Vercel hosting.

---

## Knolling — one job per file, and the name is the job

```
mirror/
├── api/
│   ├── analyze.js            HTTP edge: validate, page Helius, hash, contribute. No math.
│   ├── card.js               edge: 1200x630 PNG of the verdict. Read-only.
│   ├── score.js              holder-base exit-liquidity risk for a mint. The B2B product.
│   ├── share.js              edge: /w/<address> — per-wallet meta tags for crawlers
│   └── _lib/
│       ├── card.js             share-card model + layout tree. Pure. One definition.
│       ├── valuation.js       open-position marks + AMM exit-impact bound. Pure.
│       ├── engine.js           THE ENGINE — the pipeline, one exported stage each. Pure.
│       ├── stats.js            intervals, bootstrap, shrinkage, percentiles, drawdown. Pure.
│       ├── cohort.js           measured quantiles, sufficiency gating, prior blending. Pure.
│       ├── reference.js        EVERY tuned parameter, each citing its source
│       ├── holders.js         holder-base exit-liquidity risk. Pure.
│       ├── known.js           named pools, programs and exchange wallets. Pure.
│       ├── store.js            I/O ADAPTER — cohort + profile cache (Redis or memory)
│       ├── prices.js           I/O ADAPTER — marks and pool depth (DexScreener, no key)
│       └── chain.js            I/O ADAPTER — Helius reads (txs, holders, decimals)
├── src/                      THE SURFACE — renders what the engine returned. Computes nothing.
│   ├── App.jsx                 layout and page state
│   ├── components/
│   │   ├── Panels.jsx           every panel: diagnosis, archetype, score, scorecard, findings
│   │   └── EquityCurve.jsx      realized PnL chart with crosshair
│   ├── fmt.js                  formatting only — never derives a claim
│   ├── styles.css              one shape per row type, one fill hue per meter
│   └── demo.js                 AUTO-GENERATED. Do not hand-edit.
├── tests/                    THE PROVING GROUND
│   ├── validate.mjs            131 assertions: recovery, invariants, interval coverage
│   ├── cohort.mjs              83 assertions: sufficiency, blending, provenance, dedupe
│   ├── card.mjs                57 assertions: gating, provenance, forbidden language
│   ├── valuation.mjs           85 assertions: impact bound, fallback, the price invariant
│   ├── rotations.mjs           88 assertions: gross-leg valuation, basis rollover
│   ├── holders.mjs             92 assertions: disposition asymmetry, depth absorption
│   ├── cohort-sim.mjs          maturation simulation — priors giving way to measurement
│   ├── sweep.mjs               9 known profiles on one screen
│   └── synth.js                fabricates wallets with known behavior
└── scripts/
    ├── gen-demo.mjs          regenerates src/demo.js by running the real engine
    ├── preview-card.mjs      renders every card case to card-preview/index.html
    ├── preview-score.mjs     seven holder-base scenarios, readable without a key
    └── preflight.mjs         validates every live assumption against a real key
```

The zones never cross. `engine.js`, `stats.js`, `cohort.js`, `valuation.js` and
`card.js` are pure — no network, no clock, no environment — so the whole analytical
core can be lifted into a worker, a cron job or a B2B endpoint without touching a
line. Exactly two files do I/O, both named adapters that return data and never reach
back in: `store.js` and `prices.js`. That is why the engine consumes a measured
cohort and live market prices without ever learning a database or an HTTP client
exists.

## The pipeline

```
classify → FIFO ledger → scorecard → behavior → counterfactuals
        → archetype mixture → findings → diagnosis → exploitability
```

Each stage is a pure exported function in `engine.js`, in that order. New behavior
joins the pipeline; it does not sneak in sideways.

## Commands

```bash
npm install
npm run dev          # UI with demo mode — no API key needed
npm test             # 549 assertions across six suites; 0 failed before shipping
npm run sweep        # 9 known profiles on one screen — read it before shipping
npm run cards        # render every share card, then LOOK at card-preview/index.html
npm run scores       # holder-base scenarios — read the table, not just the assertions
npm run sim          # cohort maturation: watch priors give way to measurement
npm run gen-demo     # regenerate src/demo.js from the real engine
npm run build

HELIUS_API_KEY=xxx npm run preflight            # FIRST contact with real data
HELIUS_API_KEY=xxx npm run preflight <wallet> <mint>   # better: a wallet you know
```

`npm test` proves the engine recovers known truth. `npm run sweep` is for your
eyes: it prints the whole behavioral spectrum so drift is visible at a glance.
Unit tests caught three bugs in v1; the sweep caught four they were blind to; the
sim caught one more; rendering the cards caught five; the score preview caught a
conceptual error that unit tests passed straight over. Run all of them, and actually
**look** at the two previews — half the real defects in this project were found by
reading a table or a picture, not by an assertion.

## Share cards

`/w/<address>` is the share URL. It exists because crawlers do not run JavaScript,
so a SPA's static meta tags can only describe the site, never a wallet:

- `api/share.js` returns per-wallet OG/Twitter tags and bounces humans to
  `/?w=<address>`, which the app reads on mount and analyzes immediately.
- `api/card.js` renders the 1200x630 PNG, CDN-cached for 30 minutes. It
  **re-analyzes from the address** instead of trusting query parameters — a card
  whose contents can be forged in a URL would put the Polaxory name on a claim the
  machine never made.
- The card carries the same gates as the page: under 20 closed trades it prints
  "not scored", thin samples say "hedged", and the sample size plus reference basis
  always ride along.

## Token-to-token rotations

A rotation swaps token A for token B with no SOL leg in the wallet's net balance, so
it used to be skipped — which cost more than it sounds. Both sides were lost: the
sold lot lingered as a phantom open position, and the bought token had no basis, so
selling it later counted as an unmatched sell. A chain that made 1.4 SOL recorded
nothing.

The transaction itself carries the answer, and no price feed is involved:

- **Routed through SOL** — a router doing `A → SOL → B` credits then debits the
  wallet's wrapped-SOL account inside the same transaction. Net ≈ 0, but the gross
  legs are both there, and they are what each side was worth *at that moment*. The
  sold side closes at the SOL returned; the bought side opens at the SOL spent.
- **Direct A/B pool** — no SOL moved, so nothing was realized in SOL and no PnL is
  claimed. The cost basis rolls into the new position, which is what makes the
  eventual sale settle the whole chain at once, across as many hops as it took.
- **Unattributed** — several tokens at once, one SOL leg only, or a token acquired
  before the window. Nothing claimed, and counted separately.

The shape of the middle leg changes the *attribution*, never the total.

## The Score endpoint — holder-base exit-liquidity risk

`GET /api/score?mint=<mint>`

Every other risk tool scores a token's **structure**: contract authorities, LP locks,
holder concentration, sniper bundles. That describes the container. This scores **the
people**, which is what actually sells:

1. **Propensity** — each large holder profiled through the same engine the Mirror
   uses. How fast do they normally exit, how often do they panic, how much do they
   churn. Plus the load-bearing fact: Odean's disposition asymmetry means a holder
   **in profit is more likely to sell**, and one **deep underwater is less likely** —
   the bagholder sits. Held far past their own habit while underwater damps further.
2. **Size** — propensity-weighted position value, in SOL.
3. **Consequence** — sized against pool depth with the same constant-product
   arithmetic used for a single exit. This is what turns a propensity into a risk.

`score = 100 x pressure x [0.45 + 0.55 x (0.6 x paperHands + 0.4 x profitOverhang)]`

Paper hands and profit overhang **amplify** pressure; they never manufacture it.
Holders who cannot move the price are not a risk however twitchy they are — a base of
pure paper hands entirely in profit scores 2 on a deep pool and 100 on a thin one.

Withheld, never guessed: under five profiled holders, under 35% of scanned holder
value covered, no price, or no pool depth each suppress the score with a stated
reason. Every unscored reading opens with the refusal, because a token is not patient
just because we could not read it.

## The reference distribution

Percentiles need something to be a percentile OF. The Mirror starts on
research-derived priors and replaces them with measurement as scans accrue:

- Every scanned wallet with 8+ closed trades contributes one compact record —
  keyed by a **salted hash, never the address**. The cohort needs to dedupe repeat
  scans; it has no business knowing whose wallet it was.
- A quantile is only measured when the cohort can carry it:
  `n >= max(30, 8/min(p, 1-p))`. The median needs 30 wallets, p90 needs 80, p98
  needs 400. Until then that rung stays on the prior.
- Where measurement qualifies it is **blended**, not switched: weight
  `n/(n+40)`. A hard cutover would make your percentile jump because an unrelated
  wallet got scanned.
- Provenance is reported per metric and rendered in the interface — a solid bar is
  measured, a hatched bar still rests on a prior. The payload stamps
  `prior-v0` or `cohort-v1` accordingly.

No cohort store configured is a supported state: the app runs on priors and says
so. A free deployment never breaks because nobody provisioned a database.

## Open positions

Realized PnL leaves out whatever is still held, which was the largest honest gap in
the read. Now:

- Bags are marked at spot from the deepest pool DexScreener reports (free, no key,
  and it returns `priceNative` already in SOL plus pool liquidity).
- Every mark is paired with an exit figure from constant-product arithmetic against
  that position's own size: `realizable = mark / (1 + mark/liquidity)`. A bag worth
  10% of pool depth returns ~91% of its mark; one equal to pool depth, ~50%.
- Coverage is reported **by cost, not by count** — one large bag priced and four
  dust bags unpriced is 98% coverage, not 20%.
- No price source, a dead endpoint, an unexpected response shape, a zero or negative
  price, or a token with no pool all degrade to cost basis and say so. This is the
  well-tested path, not an afterthought.

**Verify the price adapter on first deploy.** `prices.js` tolerates several
response shapes and treats anything unexpected as "no data", so a changed upstream
API degrades quietly to cost basis rather than showing garbage. Confirm real marks
appear once deployed; if they never do, that is the adapter failing closed exactly
as designed.

## Deploy (~10 minutes)

1. Free Helius key at https://dev.helius.xyz
2. Push to GitHub, import at https://vercel.com/new (Vite auto-detected)
3. Add env var `HELIUS_API_KEY`
4. Deploy

**Then verify the deployment:**

```bash
node scripts/smoke.mjs https://your-deployment.vercel.app
```

Checks every surface against the live URL — page, analyze API, card as a real PNG
(magic-number verified, not just a content-type header), the `/w/` rewrite crawlers
depend on, the Score endpoint, and that bad input fails cleanly. Exits non-zero on any
blocker and prints the fix.

**Optional — enable the measured cohort.** Create a free Vercel KV or Upstash
Redis database and set `KV_REST_API_URL` + `KV_REST_API_TOKEN` (Vercel KV injects
these names automatically; Upstash uses the same REST shape). Also set
`COHORT_SALT` to any random string so the stored hashes cannot be reversed against
a wallet list. Without these the app is fully functional on priors.

## What the engine will not claim

Enforced in code, not in intent:

- No score under 20 closed trades, matching the bar for any edge claim.
- No rate claim unless its 95% interval excludes the neutral value.
- No "size discipline" credit for a wallet that sizes up after losses.
- No mark presented as an exit. Every marked position also shows what selling it
  would actually return, and a bag larger than its own pool is flagged.
- No price ever reaches a metric, finding, diagnosis or score. Marks are disclosure
  only, so the read is reproducible from chain data alone even if every price API
  is down.
- No PnL for sells whose basis predates the scan window; they are excluded and counted.
- No price predictions, no signals, no advice.

## v0 honesty notes, shown in the product too

- Token-to-token rotations are accounted for, three ways, each disclosed: valued
  from the gross wrapped-SOL legs the router left in the transaction; basis carried
  forward when no SOL moved at all; or left unattributed when the amount cannot be
  split. Never valued from a current price — that would price a past swap at today's
  number.
- Toll is a visible lower bound; pool→interface fees never enter the wallet.
- Exit-impact figures assume the deepest single pool, no swap fees, no routing, and
  nobody else selling. An upper bound on optimism, not a quote.
- Percentiles compare against research-derived priors, not measured traffic.
  Stamped `prior-v0 (research-derived, unmeasured)` in every payload.
- Per-trade Sharpe is per-trade, never annualized.

## Review ribbon

Two places carry it, both removable in one line each once comms has approved the
design for public release:

- the page — the `.watermark` div at the bottom of `src/App.jsx` (and its CSS rule)
- the share card — the final `box()` in the footer band of `api/_lib/card.js`, then
  `npm run cards` to confirm

The card is the piece that leaves the building, so it is worth having the
communications team look at that one specifically before the ribbon comes off.
