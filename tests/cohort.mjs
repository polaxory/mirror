// Cohort validation: does measuring the reference distribution actually work,
// and does it refuse to overclaim when the cohort is thin?
//
// Run: node tests/cohort.mjs

import { analyze } from '../api/_lib/engine.js'
import {
  summarize, buildLadders, buildMetricLadder, quantileSufficient, priorValueAt, COHORT_METRICS,
} from '../api/_lib/cohort.js'
import { readRecords, recordWallet, __resetMemory, storeStatus } from '../api/_lib/store.js'
import {
  LADDERS as PRIOR, QUANTILE_GRID, COHORT_BLEND_K, COHORT_ABSOLUTE_FLOOR, COHORT_MIN_TRADES,
} from '../api/_lib/reference.js'
import { makeWallet, DEFAULTS } from './synth.js'
import { quantile, mulberry32 } from '../api/_lib/stats.js'

let pass = 0, fail = 0
const failures = []
const ok = (c, name, detail = '') => {
  if (c) { pass++; console.log(`  \x1b[32mPASS\x1b[0m ${name}`) }
  else { fail++; failures.push(`${name} — ${detail}`); console.log(`  \x1b[31mFAIL\x1b[0m ${name}  ${detail}`) }
}
const fmt = (x) => (x === null || x === undefined ? 'null' : typeof x === 'number' ? x.toFixed(4) : String(x))
const near = (a, b, tol, name) => ok(Number.isFinite(a) && Math.abs(a - b) <= tol, name, `got ${fmt(a)} want ${fmt(b)} ±${tol}`)
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`)

// Synthesize a cohort record directly, bypassing the chain, so distributions are
// exactly known. Mirrors the shape summarize() produces.
const rec = (h, vals) => ({ h, n: 40, ...vals })

// ---------------------------------------------------------------- sufficiency

section('A. Per-quantile sufficiency refuses to measure what it cannot')
{
  ok(!quantileSufficient(0.5, 10), 'median not measured at n=10 (below absolute floor)')
  ok(quantileSufficient(0.5, 30), 'median measured at n=30')
  ok(!quantileSufficient(0.9, 30), 'p90 not measured at n=30 (needs 80)')
  ok(quantileSufficient(0.9, 80), 'p90 measured at n=80')
  ok(!quantileSufficient(0.98, 100), 'p98 not measured at n=100 (needs 400)')
  ok(quantileSufficient(0.98, 400), 'p98 measured at n=400')
  ok(!quantileSufficient(0.5, 0), 'nothing measured from an empty cohort')
  // Boundary exactness: the enforced threshold must equal the documented one at
  // every grid point, including where float division overshoots an integer.
  for (const p of QUANTILE_GRID) {
    const tail = Math.min(p, 1 - p)
    const stated = Math.max(COHORT_ABSOLUTE_FLOOR, Math.round(8 / tail))
    ok(quantileSufficient(p, stated) && !quantileSufficient(p, stated - 1),
      `p${p * 100}: threshold is exactly ${stated}, not one more`,
      `${quantileSufficient(p, stated)} at ${stated}, ${quantileSufficient(p, stated - 1)} at ${stated - 1}`)
  }
}

section('B. An empty cohort is exactly the prior, unchanged')
{
  const { ladders, cohort } = buildLadders([])
  ok(cohort.wallets === 0, 'empty cohort reports 0 wallets')
  ok(cohort.basis === 'prior', 'empty cohort basis = prior', cohort.basis)
  ok(/prior-v0/.test(cohort.version), 'version stamp still says prior-v0', cohort.version)
  for (const m of COHORT_METRICS) {
    const worst = Math.max(...ladders[m].map((r) => Math.abs(r.v - priorValueAt(m, r.p))))
    ok(worst < 1e-9, `${m}: ladder equals the prior at every rung`, `max dev ${fmt(worst)}`)
  }
}

section('C. A thin cohort cannot flip the basis')
{
  const thin = Array.from({ length: 12 }, (_, i) => rec(`h${i}`, {
    dispositionRatio: 3 + i, panicIndex: 0.3, revengeRatio: 2, sizingCV: 0.5,
    expectancy: -0.1, profitFactor: 0.8, tollRate: 0.01,
  }))
  const { cohort } = buildLadders(thin)
  ok(cohort.wallets === 12, '12 wallets admitted')
  ok(cohort.basis === 'prior', '12 wallets is still prior basis', cohort.basis)
  ok(Object.values(cohort.perMetric).every((p) => p.measuredRungs === 0),
    'no rung is measured below the absolute floor')
}

section('D. Records below the trade minimum are refused entry')
{
  const mixed = [
    rec('a', { expectancy: -0.2 }),
    { h: 'b', n: COHORT_MIN_TRADES - 1, expectancy: 5 },  // too few trades
    { h: 'c', n: 2, expectancy: -9 },                      // too few trades
  ]
  const { cohort } = buildLadders(mixed)
  ok(cohort.wallets === 1, 'only the qualifying record joins', `got ${cohort.wallets}`)
}

// ---------------------------------------------------------------- recovery

section('E. With a large cohort, measured quantiles recover the true distribution')
{
  // Known distribution: disposition ratio uniform on [1, 21] -> true median 11,
  // p20 = 5, p80 = 17.
  const N = 600
  const rand = mulberry32(7)
  const vals = Array.from({ length: N }, () => 1 + rand() * 20)
  const records = vals.map((v, i) => rec(`u${i}`, { dispositionRatio: v }))
  const { ladder, provenance } = buildMetricLadder(records, 'dispositionRatio')
  const w = N / (N + COHORT_BLEND_K)

  ok(provenance.basis === 'measured', 'large cohort reports measured basis', provenance.basis)
  ok(provenance.measuredRungs === QUANTILE_GRID.length, 'every rung measured at n=600',
    `${provenance.measuredRungs}/${QUANTILE_GRID.length}`)
  near(w, 0.9375, 0.001, 'blend weight = n/(n+K) at n=600')

  for (const p of [0.2, 0.5, 0.8]) {
    const trueQ = quantile(vals, p)
    const expected = w * trueQ + (1 - w) * priorValueAt('dispositionRatio', p)
    const got = ladder.find((r) => r.p === p).v
    near(got, expected, 0.05, `p${p * 100}: rung equals blend(measured, prior)`)
    // and the blend must sit much closer to the measurement than to the prior
    const dMeasured = Math.abs(got - trueQ)
    const dPrior = Math.abs(got - priorValueAt('dispositionRatio', p))
    ok(dMeasured < dPrior, `p${p * 100}: blended value is nearer the measurement than the prior`,
      `Δmeasured ${fmt(dMeasured)} vs Δprior ${fmt(dPrior)}`)
  }
}

section('F. Blending moves monotonically from prior toward measurement as n grows')
{
  const mk = (n) => {
    const rand = mulberry32(11)
    return Array.from({ length: n }, (_, i) => rec(`g${n}_${i}`, { dispositionRatio: 12 + rand() * 0.001 }))
  }
  // A cohort concentrated at 12 — every measured quantile should be ~12.
  const at = {}
  for (const n of [30, 80, 400, 2000]) {
    const { ladder } = buildMetricLadder(mk(n), 'dispositionRatio')
    at[n] = ladder.find((r) => r.p === 0.5).v
  }
  const prior = priorValueAt('dispositionRatio', 0.5)
  console.log(`     prior median ${fmt(prior)} → n=30 ${fmt(at[30])} → n=80 ${fmt(at[80])} → n=400 ${fmt(at[400])} → n=2000 ${fmt(at[2000])}`)
  ok(Math.abs(at[30] - 12) > Math.abs(at[80] - 12), 'n=80 closer to the measurement than n=30')
  ok(Math.abs(at[80] - 12) > Math.abs(at[400] - 12), 'n=400 closer than n=80')
  ok(Math.abs(at[2000] - 12) < 0.3, 'n=2000 essentially equals the measurement', fmt(at[2000]))
}

section('G. Ladders stay monotone in v (percentile interpolation depends on it)')
{
  // Adversarial: a cohort whose distribution inverts the prior's ordering.
  const rand = mulberry32(3)
  const records = Array.from({ length: 500 }, (_, i) => rec(`m${i}`, {
    dispositionRatio: 30 - rand() * 29,
    panicIndex: rand(),
    revengeRatio: 20 - rand() * 19,
    sizingCV: rand() * 3,
    expectancy: 1 - rand() * 2,
    profitFactor: rand() * 5,
    tollRate: rand() * 0.2,
  }))
  const { ladders } = buildLadders(records)
  for (const m of COHORT_METRICS) {
    let mono = true
    for (let i = 1; i < ladders[m].length; i++) if (ladders[m][i].v < ladders[m][i - 1].v) mono = false
    ok(mono, `${m}: ladder is non-decreasing in v`)
    ok(ladders[m].every((r) => Number.isFinite(r.v)), `${m}: every rung is finite`)
  }
}

// ---------------------------------------------------------------- integration

section('H. summarize() produces admissible records from real engine output')
{
  const r = analyze(makeWallet({ nTrades: 60, winRate: 0.35, holdWinMin: 9, holdLossMin: 400,
    interfaceFeeRate: 0.01, seed: 9001 }).txs, DEFAULTS.wallet)
  const s = summarize(r, 'hash-abc')
  ok(!!s, 'record produced for a 60-trade wallet')
  ok(s.h === 'hash-abc' && !JSON.stringify(s).includes(DEFAULTS.wallet),
    'record carries the hash and never the address')
  ok(s.n === r.scorecard.closedTrades, 'trade count carried')
  near(s.dispositionRatio, r.behavior.disposition.point, 0.001, 'disposition carried')
  near(s.expectancy, r.scorecard.expectancy.point, 0.001, 'expectancy carried')
  ok(Object.keys(s).length <= 9, 'record stays compact', `${Object.keys(s).length} keys`)

  const thin = analyze(makeWallet({ nTrades: 4, seed: 9002 }).txs, DEFAULTS.wallet)
  ok(summarize(thin, 'hash-thin') === null, 'wallet below the trade minimum is not admitted')

  const empty = analyze([], 'nobody')
  ok(summarize(empty, 'hash-empty') === null, 'empty analysis produces no record')
}

section('I. Store dedupes repeat scans and degrades without a backend')
{
  __resetMemory()
  ok(storeStatus().backend === 'memory', 'no KV env -> memory backend', storeStatus().backend)
  ok(storeStatus().durable === false, 'memory backend reports itself non-durable')

  const a = await recordWallet(rec('dup', { expectancy: -0.2 }))
  const b = await recordWallet(rec('dup', { expectancy: -0.9 }))
  ok(a.admitted === true, 'first write admitted')
  ok(b.admitted === false, 'duplicate wallet hash refused', b.reason)
  const recs = await readRecords({ force: true })
  ok(recs.length === 1, 'cohort holds one record after a duplicate write', `got ${recs.length}`)
  ok(recs[0].expectancy === -0.2, 'first write is the one retained')

  const bad = await recordWallet(null)
  ok(bad.admitted === false, 'null record refused without throwing')
}

section('J. End to end: the engine reads percentiles against the supplied cohort')
{
  // A cohort where nearly everyone has a disposition ratio near 30 — so a wallet
  // at ~27 should sit LOW in this cohort, whereas against the prior ladder (whose
  // p98 is 25) it sits at the very top. Same wallet, different reference.
  const rand = mulberry32(5)
  const records = Array.from({ length: 800 }, (_, i) => rec(`hi${i}`, {
    dispositionRatio: 28 + rand() * 8,
  }))
  const { ladders, cohort } = buildLadders(records)
  const txs = makeWallet({ nTrades: 60, winRate: 0.4, holdWinMin: 10, holdLossMin: 270,
    holdJitter: 0.1, seed: 9101 }).txs

  const onPrior = analyze(txs, DEFAULTS.wallet)
  const onCohort = analyze(txs, DEFAULTS.wallet, { ladders, cohort })

  const d = onCohort.behavior.disposition.point
  console.log(`     wallet disposition ${fmt(d)}x → prior pct ${fmt(onPrior.behavior.disposition.pctWorst)} · cohort pct ${fmt(onCohort.behavior.disposition.pctWorst)}`)
  ok(onCohort.behavior.disposition.pctWorst < onPrior.behavior.disposition.pctWorst,
    'percentile falls when the cohort is more extreme than the prior')
  near(onCohort.behavior.disposition.point, onPrior.behavior.disposition.point, 1e-9,
    'the measured METRIC is untouched by the reference change')

  ok(/cohort-v1/.test(onCohort.referenceVersion), 'payload stamps cohort-v1 when measured',
    onCohort.referenceVersion)
  ok(/prior-v0/.test(onPrior.referenceVersion), 'payload stamps prior-v0 without a cohort',
    onPrior.referenceVersion)
  ok(onCohort.cohort.wallets === 800, 'payload reports the cohort size')
  ok(onCohort.assumptions.some((a) => /cohort-v1/.test(a)), 'assumptions text reflects the measured basis')
  ok(onPrior.assumptions.some((a) => /research-derived priors/.test(a)),
    'prior run still discloses that percentiles are prior-based')
}

section('K. Cohort provenance is reported per metric, not just globally')
{
  // 500 wallets carry disposition only; expectancy is absent from every record.
  const rand = mulberry32(13)
  const records = Array.from({ length: 500 }, (_, i) => rec(`p${i}`, {
    dispositionRatio: 2 + rand() * 10, expectancy: null,
  }))
  const { cohort } = buildLadders(records)
  ok(cohort.perMetric.dispositionRatio.basis === 'measured',
    'disposition measured where data exists', cohort.perMetric.dispositionRatio.basis)
  ok(cohort.perMetric.expectancy.basis === 'prior',
    'expectancy stays prior where no data exists', cohort.perMetric.expectancy.basis)
  ok(cohort.perMetric.expectancy.n === 0, 'per-metric n reflects only usable values')
  ok(cohort.basis === 'blended', 'mixed provenance reports blended overall', cohort.basis)
}

console.log(`\n${'='.repeat(64)}`)
console.log(`\x1b[1mCOHORT VALIDATION\x1b[0m  ${pass} passed, ${fail} failed`)
if (fail) { console.log('\n\x1b[31mFailures:\x1b[0m'); failures.forEach((f) => console.log(`  - ${f}`)) }
console.log('='.repeat(64))
process.exit(fail ? 1 : 0)
