// REFERENCE COHORT — stated priors, not measured from this app's traffic.
//
// Every percentile and every shrinkage target in the engine reads from this file.
// It is deliberately one file so the assumptions are auditable in one place, and
// so they can be replaced wholesale by measured quantiles once real scan volume
// exists. Each entry cites where the number comes from. This is the "methods
// public, parameters private" line: the structure is open, the calibration is
// versioned and will be swapped for measured data.
//
// STATUS: v0 priors, research-derived. These are the FALLBACK. As scan volume
// accrues, cohort.js measures real quantiles and blends them over these, per
// quantile, by cohort size — so the ladders below are the starting position, not
// the permanent answer. Every payload reports which basis it actually used.

export const REFERENCE_VERSION = 'prior-v0 (research-derived, unmeasured)'

// ---------- cohort measurement parameters (consumed by cohort.js)

// The p-grid every measured ladder is evaluated on. Denser in the interior, where
// most wallets live and where quantiles are cheapest to estimate honestly.
export const QUANTILE_GRID = [0.05, 0.1, 0.2, 0.35, 0.5, 0.65, 0.8, 0.9, 0.95, 0.98]

// A wallet joins the cohort only with at least this many closed trades. Below it,
// its behavioral metrics are noise and would pollute the reference it feeds.
export const COHORT_MIN_TRADES = 8

// Sufficiency: n >= K / min(p, 1-p). K=8 means the median needs 16 observations,
// p=0.9 needs 80, p=0.98 needs 400.
export const COHORT_QUANTILE_K = 8

// No quantile is measured below this cohort size, however interior it is.
export const COHORT_ABSOLUTE_FLOOR = 30

// Blend weight on measured values: n / (n + K). At n=40 the ladder is half
// measured; at n=400 it is 91% measured. Same shrinkage logic the engine already
// applies to a single wallet's win rate, applied to the cohort itself.
export const COHORT_BLEND_K = 40

// Trade-level hit rate prior.
// Basis: pump.fun monthly profitable-wallet share ran 30-73% across 2024-2026
// (CoinGecko/Dune analyses); wallet-level profitability is a weaker bar than
// trade-level hit rate, so the trade-level prior sits below the midpoint.
export const WIN_RATE_PRIOR = { mean: 0.42, strength: 20 } // strength in pseudo-trades

// Expectancy (net PnL per SOL of cost basis) prior.
// Basis: ~96% of pump.fun wallets lose money or clear under $500; the population
// mean is negative. betweenVar is the assumed spread of true wallet expectancies.
export const EXPECTANCY_PRIOR = { mean: -0.12, betweenVar: 0.09 }

// Quantile ladders for percentile framing. p = fraction of the reference cohort
// at or below v.
export const LADDERS = {
  // Median hold on losers / median hold on winners. >1 means holding losers longer.
  // Basis: Odean 1998 measured PGR/PLR ~1.5 in equities; on-chain memecoin
  // behavior is more extreme, so the ladder is stretched upward.
  dispositionRatio: [
    { p: 0.05, v: 0.4 },
    { p: 0.2, v: 0.8 },
    { p: 0.5, v: 1.6 },
    { p: 0.75, v: 3.5 },
    { p: 0.9, v: 8 },
    { p: 0.98, v: 25 },
  ],
  // Fraction of losing exits closed inside 10 minutes.
  panicIndex: [
    { p: 0.1, v: 0.05 },
    { p: 0.35, v: 0.2 },
    { p: 0.6, v: 0.4 },
    { p: 0.85, v: 0.65 },
    { p: 0.97, v: 0.85 },
  ],
  // Median time-to-next-buy after a win divided by same after a loss.
  // >1 means re-entering faster after losses than after wins.
  revengeRatio: [
    { p: 0.15, v: 0.7 },
    { p: 0.4, v: 1.0 },
    { p: 0.65, v: 1.6 },
    { p: 0.85, v: 3.0 },
    { p: 0.97, v: 7.0 },
  ],
  // Coefficient of variation of buy sizes. Higher = more erratic sizing.
  sizingCV: [
    { p: 0.1, v: 0.25 },
    { p: 0.35, v: 0.5 },
    { p: 0.6, v: 0.8 },
    { p: 0.85, v: 1.4 },
    { p: 0.97, v: 2.5 },
  ],
  // Realized PnL per SOL of cost basis.
  expectancy: [
    { p: 0.03, v: -0.9 },
    { p: 0.2, v: -0.45 },
    { p: 0.5, v: -0.14 },
    { p: 0.72, v: 0.0 },
    { p: 0.9, v: 0.25 },
    { p: 0.99, v: 1.2 },
  ],
  // Gross wins / gross losses.
  profitFactor: [
    { p: 0.05, v: 0.15 },
    { p: 0.25, v: 0.45 },
    { p: 0.5, v: 0.8 },
    { p: 0.72, v: 1.0 },
    { p: 0.9, v: 1.6 },
    { p: 0.99, v: 3.5 },
  ],
  // Toll (network + visible interface/tip outflow) as a share of turnover.
  tollRate: [
    { p: 0.1, v: 0.004 },
    { p: 0.4, v: 0.012 },
    { p: 0.7, v: 0.025 },
    { p: 0.92, v: 0.05 },
    { p: 0.99, v: 0.1 },
  ],
}

// Confidence tiers by closed-trade count. Claims are gated on these.
export const CONFIDENCE_TIERS = [
  { min: 0, key: 'none', label: 'No read', blurb: 'No closed SOL-quoted trades in the window. Nothing to reflect.' },
  { min: 1, key: 'sketch', label: 'Sketch', blurb: 'Under 8 closed trades. Directional at best; treat every number as a rumor.' },
  { min: 8, key: 'provisional', label: 'Provisional', blurb: '8-24 closed trades. Patterns are visible but intervals are wide.' },
  { min: 25, key: 'indicative', label: 'Indicative', blurb: '25-79 closed trades. Behavioral tendencies are measurable.' },
  { min: 80, key: 'substantive', label: 'Substantive', blurb: '80+ closed trades. Rates are tight enough to act on.' },
]

export function confidenceFor(n) {
  let tier = CONFIDENCE_TIERS[0]
  for (const t of CONFIDENCE_TIERS) if (n >= t.min) tier = t
  return { ...tier, n }
}
