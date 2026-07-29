// Statistical primitives for the Polaxory behavioral engine.
// Every estimate the product displays must carry uncertainty. These are the tools
// that produce it. Deterministic by design: same wallet -> same intervals, so a
// screenshot is reproducible.

// ---------- deterministic RNG ----------

export function hashSeed(str) {
  let h = 2166136261 >>> 0
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h >>> 0
}

export function mulberry32(seed) {
  let a = seed >>> 0
  return function rand() {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---------- descriptives ----------

export const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)

export const variance = (xs) => {
  if (xs.length < 2) return null
  const m = mean(xs)
  return xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1)
}

export const std = (xs) => {
  const v = variance(xs)
  return v === null ? null : Math.sqrt(v)
}

export function quantile(xs, p) {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  if (s.length === 1) return s[0]
  const idx = p * (s.length - 1)
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return s[lo]
  return s[lo] + (s[hi] - s[lo]) * (idx - lo)
}

export const median = (xs) => quantile(xs, 0.5)

// ---------- proportion interval ----------

// Wilson score interval: correct at small n and near the boundaries, where the
// normal approximation produces intervals that run past 0 or 1.
export function wilson(k, n, z = 1.96) {
  if (!n) return null
  const p = k / n
  const denom = 1 + (z * z) / n
  const center = (p + (z * z) / (2 * n)) / denom
  const half = (z / denom) * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))
  return { point: p, lo: Math.max(0, center - half), hi: Math.min(1, center + half), n }
}

// ---------- bootstrap ----------

// Percentile bootstrap over a sample of trades. Used for statistics whose
// sampling distribution we have no closed form for (profit factor, expectancy,
// payoff ratio) and where trade PnL is heavy-tailed enough that normal-theory
// intervals would lie.
export function bootstrapCI(items, statFn, { B = 2000, seed = 1, alpha = 0.05 } = {}) {
  const n = items.length
  if (n < 3) return null
  const rand = mulberry32(seed)
  const stats = []
  const buf = new Array(n)
  for (let b = 0; b < B; b++) {
    for (let i = 0; i < n; i++) buf[i] = items[(rand() * n) | 0]
    const s = statFn(buf)
    if (s !== null && Number.isFinite(s)) stats.push(s)
  }
  if (stats.length < B * 0.5) return null
  const point = statFn(items)
  return {
    point: Number.isFinite(point) ? point : null,
    lo: quantile(stats, alpha / 2),
    hi: quantile(stats, 1 - alpha / 2),
    n,
  }
}

// ---------- shrinkage ----------

// Empirical-Bayes posterior for a rate, Beta(a,b) prior. priorStrength is in
// units of pseudo-trades: a wallet with n << priorStrength is reported as
// mostly-prior, which is the honest read of a short history.
export function betaShrink(k, n, priorMean, priorStrength) {
  const a = priorMean * priorStrength
  const b = (1 - priorMean) * priorStrength
  const postMean = (a + k) / (a + b + n)
  const postN = a + b + n
  // Beta posterior sd
  const sd = Math.sqrt((postMean * (1 - postMean)) / (postN + 1))
  return { value: postMean, sd, weightOnData: n / (n + priorStrength), priorMean }
}

// James-Stein / hierarchical shrinkage of a mean toward a population mean.
// betweenVar is the assumed variance of true wallet means around the population
// mean; it is an assumption and is reported as one.
export function meanShrink(sampleMean, sampleVar, n, priorMean, betweenVar) {
  if (sampleMean === null || n < 1) return null
  if (sampleVar === null || !Number.isFinite(sampleVar) || betweenVar <= 0) {
    return { value: sampleMean, weightOnData: 1, priorMean }
  }
  const w = betweenVar / (betweenVar + sampleVar / n)
  return { value: w * sampleMean + (1 - w) * priorMean, weightOnData: w, priorMean }
}

// ---------- misc ----------

export function softmax(scores, temperature = 1) {
  const vals = scores.map((s) => s / temperature)
  const max = Math.max(...vals)
  const exps = vals.map((v) => Math.exp(v - max))
  const sum = exps.reduce((a, b) => a + b, 0)
  return exps.map((e) => e / sum)
}

// Percentile of a value against a reference quantile ladder
// ladder: [{p, v}] ascending in v. Returns 0..1, linearly interpolated.
export function percentileAgainst(value, ladder, { higherIsWorse = true } = {}) {
  if (value === null || value === undefined || !ladder.length) return null
  let pct
  if (value <= ladder[0].v) pct = ladder[0].p
  else if (value >= ladder[ladder.length - 1].v) pct = ladder[ladder.length - 1].p
  else {
    pct = ladder[ladder.length - 1].p
    for (let i = 0; i < ladder.length - 1; i++) {
      const a = ladder[i]
      const b = ladder[i + 1]
      if (value >= a.v && value <= b.v) {
        const t = b.v === a.v ? 0 : (value - a.v) / (b.v - a.v)
        pct = a.p + t * (b.p - a.p)
        break
      }
    }
  }
  return higherIsWorse ? pct : 1 - pct
}

export function maxDrawdown(cumSeries) {
  if (!cumSeries.length) return { abs: 0, peak: 0 }
  let peak = cumSeries[0]
  let maxDD = 0
  for (const v of cumSeries) {
    if (v > peak) peak = v
    const dd = peak - v
    if (dd > maxDD) maxDD = dd
  }
  return { abs: maxDD, peak }
}

export const clamp01 = (x) => Math.max(0, Math.min(1, x))
