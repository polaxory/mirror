// Cohort: turning measured wallets into the reference distribution.
//
// PURE. No I/O, no clock, no env — every function here is a transformation of
// values you hand it. Persistence lives in store.js and nowhere else, so the
// engine and this file can be reasoned about, tested, and lifted anywhere.
//
// The honest problem this file solves: a prior ladder is a guess, and a measured
// ladder from 12 wallets is a worse guess with more confidence attached. So the
// replacement is gradual and PER-QUANTILE:
//
//   1. A wallet joins the cohort only if it has enough closed trades to carry a
//      meaningful metric at all.
//   2. A quantile is only measured if the cohort is large enough to estimate THAT
//      quantile — the median needs far fewer wallets than the 98th percentile.
//   3. Where measurement qualifies, it is BLENDED with the prior by cohort size,
//      not switched on. A hard cutover would make a user's percentile jump when
//      an unrelated wallet was scanned.
//
// The result is a ladder that starts as pure prior, becomes mostly measured, and
// says which it is at every step.

import { quantile } from './stats.js'
import {
  LADDERS as PRIOR_LADDERS, QUANTILE_GRID, COHORT_MIN_TRADES, COHORT_QUANTILE_K,
  COHORT_ABSOLUTE_FLOOR, COHORT_BLEND_K, REFERENCE_VERSION,
} from './reference.js'

// Metrics that carry a ladder. Keys match LADDERS in reference.js.
export const COHORT_METRICS = [
  'dispositionRatio', 'panicIndex', 'revengeRatio', 'sizingCV',
  'expectancy', 'profitFactor', 'tollRate',
]

// ---------- 1. summarize a result into a cohort record

// Compact by design: one short record per wallet. The wallet is stored as a HASH,
// never an address — the cohort needs to dedupe repeat scans, it does not need to
// know whose wallet it was. Cheap to store, and nothing identifying to leak.
export function summarize(result, walletHash) {
  const sc = result.scorecard
  const b = result.behavior
  if (!sc || sc.closedTrades < COHORT_MIN_TRADES) return null

  const pick = (x) => (Number.isFinite(x) ? Math.round(x * 1e4) / 1e4 : null)
  const rec = {
    h: walletHash,
    n: sc.closedTrades,
    dispositionRatio: pick(b.disposition?.point),
    panicIndex: pick(b.panic?.point),
    revengeRatio: pick(b.revenge?.point),
    sizingCV: pick(b.sizing?.cv),
    expectancy: pick(sc.expectancy?.point),
    profitFactor: pick(sc.profitFactor?.point),
    tollRate: pick(sc.tollRate),
  }
  // A record with no usable metric is not worth persisting.
  const any = COHORT_METRICS.some((m) => rec[m] !== null)
  return any ? rec : null
}

// ---------- 2. per-quantile sufficiency

// To estimate quantile p you need enough observations in the thin part of the
// distribution. Rule: n >= K / min(p, 1-p), with an absolute floor. At K=8 the
// median needs 16 (floor raises it to COHORT_ABSOLUTE_FLOOR), p=0.9 needs 80, and
// p=0.98 needs 400. Stated as a rule rather than tuned per metric so it cannot be
// quietly bent to make a ladder look measured.
export function quantileSufficient(p, n) {
  const tail = Math.min(p, 1 - p)
  if (tail <= 0) return false
  // The epsilon is load-bearing, not cosmetic. `1 - 0.9` is 0.09999999999999998,
  // so 8/tail evaluates to 80.00000000000001 and a bare ceil() demands 81 wallets
  // for a rule that documents 80. A threshold that enforces something other than
  // what it states is the same defect class as prose contradicting its own sign.
  const required = Math.ceil(COHORT_QUANTILE_K / tail - 1e-9)
  return n >= Math.max(COHORT_ABSOLUTE_FLOOR, required)
}

// ---------- 3. read a prior ladder at an arbitrary p (linear interpolation)

export function priorValueAt(metric, p) {
  const ladder = PRIOR_LADDERS[metric]
  if (!ladder || !ladder.length) return null
  if (p <= ladder[0].p) return ladder[0].v
  if (p >= ladder[ladder.length - 1].p) return ladder[ladder.length - 1].v
  for (let i = 0; i < ladder.length - 1; i++) {
    const a = ladder[i]
    const c = ladder[i + 1]
    if (p >= a.p && p <= c.p) {
      const t = c.p === a.p ? 0 : (p - a.p) / (c.p - a.p)
      return a.v + t * (c.v - a.v)
    }
  }
  return ladder[ladder.length - 1].v
}

// ---------- 4. build one metric's ladder from records

export function buildMetricLadder(records, metric) {
  const vals = records.map((r) => r[metric]).filter((v) => Number.isFinite(v))
  const n = vals.length
  const weight = n / (n + COHORT_BLEND_K)
  const rungs = []
  let measuredRungs = 0

  for (const p of QUANTILE_GRID) {
    const prior = priorValueAt(metric, p)
    if (quantileSufficient(p, n)) {
      const measured = quantile(vals, p)
      if (Number.isFinite(measured)) {
        rungs.push({ p, v: weight * measured + (1 - weight) * prior, measured: true })
        measuredRungs++
        continue
      }
    }
    rungs.push({ p, v: prior, measured: false })
  }

  // A ladder must be non-decreasing in v for percentileAgainst to interpolate
  // sanely. Blending two monotone ladders preserves monotonicity in theory; float
  // error and partial replacement can still produce a flat inversion, so clamp.
  for (let i = 1; i < rungs.length; i++) {
    if (rungs[i].v < rungs[i - 1].v) rungs[i].v = rungs[i - 1].v
  }

  return {
    ladder: rungs.map(({ p, v }) => ({ p, v })),
    provenance: {
      metric,
      n,
      weight,
      measuredRungs,
      totalRungs: rungs.length,
      // "measured" only when the blend actually leans on data at most rungs
      basis: measuredRungs === 0 ? 'prior' : weight >= 0.5 && measuredRungs >= rungs.length / 2 ? 'measured' : 'blended',
    },
  }
}

// ---------- 5. build the full ladder set

export function buildLadders(records) {
  const clean = (records || []).filter((r) => r && Number.isFinite(r.n) && r.n >= COHORT_MIN_TRADES)
  const ladders = {}
  const provenance = {}
  for (const m of COHORT_METRICS) {
    const { ladder, provenance: p } = buildMetricLadder(clean, m)
    ladders[m] = ladder
    provenance[m] = p
  }
  const wallets = clean.length
  const bases = Object.values(provenance).map((p) => p.basis)
  const overall =
    wallets === 0 ? 'prior'
      : bases.every((b) => b === 'measured') ? 'measured'
      : bases.some((b) => b !== 'prior') ? 'blended'
      : 'prior'

  return {
    ladders,
    cohort: {
      wallets,
      basis: overall,
      version:
        overall === 'prior'
          ? REFERENCE_VERSION
          : `cohort-v1 (${overall}, ${wallets} wallet${wallets === 1 ? '' : 's'} measured; prior-v0 fallback on thin quantiles)`,
      perMetric: provenance,
      rule: `a quantile is measured only when cohort n >= max(${COHORT_ABSOLUTE_FLOOR}, ${COHORT_QUANTILE_K}/min(p,1-p)); measured values are blended with the prior at weight n/(n+${COHORT_BLEND_K})`,
    },
  }
}
