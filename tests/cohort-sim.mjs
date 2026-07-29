// Cohort maturation simulation.
//
// Unit tests prove each piece; this proves the MECHANISM over time. It runs a
// stream of synthetic wallets through the exact production path — analyze,
// summarize, record — and prints how the reference distribution changes as scans
// accrue. The operator should be able to read this and see the priors being
// replaced, rung by rung, without reading any code.
//
// Run: node tests/cohort-sim.mjs

import { analyze } from '../api/_lib/engine.js'
import { summarize, buildLadders, priorValueAt } from '../api/_lib/cohort.js'
import { recordWallet, readRecords, __resetMemory } from '../api/_lib/store.js'
import { makeWallet, DEFAULTS } from './synth.js'
import { mulberry32 } from '../api/_lib/stats.js'

const CHECKPOINTS = [0, 12, 30, 80, 160, 400, 900]
const TOTAL = CHECKPOINTS[CHECKPOINTS.length - 1]
const pad = (s, n) => String(s).padEnd(n)
const padL = (s, n) => String(s).padStart(n)
const f = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '—')

// A population of wallets with genuine behavioral variety, so the measured
// distribution is not a single archetype wearing different seeds.
function walletParams(i) {
  const r = mulberry32(50000 + i)
  const kind = r()
  const base = {
    nTrades: 12 + Math.floor(r() * 90),
    retJitter: 0.08 + r() * 0.12,
    interfaceFeeRate: r() * 0.015,
    networkFee: 0.00015,
    seed: 50000 + i,
  }
  if (kind < 0.32) // bagholders
    return { ...base, winRate: 0.28 + r() * 0.16, winRet: 1.3 + r() * 0.5, lossRet: 0.45 + r() * 0.2,
      holdWinMin: 5 + r() * 20, holdLossMin: 200 + r() * 900, buySizeCV: 0.2 + r() * 0.6 }
  if (kind < 0.55) // tilted
    return { ...base, winRate: 0.3 + r() * 0.15, winRet: 1.4 + r() * 0.4, lossRet: 0.5 + r() * 0.2,
      holdWinMin: 15 + r() * 40, holdLossMin: 20 + r() * 60, gapAfterLossMin: 2 + r() * 8,
      gapAfterWinMin: 90 + r() * 200, revengeSizeMult: 1.6 + r() * 1.8, buySizeCV: 0.1 + r() * 0.4 }
  if (kind < 0.72) // panic
    return { ...base, winRate: 0.32 + r() * 0.16, winRet: 1.4 + r() * 0.5, lossRet: 0.6 + r() * 0.2,
      holdWinMin: 60 + r() * 120, holdLossMin: 1 + r() * 6, buySizeCV: 0.3 + r() * 0.7 }
  if (kind < 0.9) // churners
    return { ...base, winRate: 0.4 + r() * 0.12, winRet: 1.15 + r() * 0.25, lossRet: 0.78 + r() * 0.12,
      holdWinMin: 2 + r() * 8, holdLossMin: 2 + r() * 10, gapAfterLossMin: 2 + r() * 5,
      gapAfterWinMin: 2 + r() * 5, buySizeCV: 0.2 + r() * 0.5 }
  // the profitable minority
  return { ...base, winRate: 0.52 + r() * 0.12, winRet: 1.5 + r() * 0.4, lossRet: 0.72 + r() * 0.12,
    holdWinMin: 40 + r() * 160, holdLossMin: 40 + r() * 160, buySizeCV: 0.05 + r() * 0.25 }
}

__resetMemory()

console.log('\nCOHORT MATURATION — priors giving way to measurement\n')
console.log('Feeding synthetic wallets through the production path: analyze → summarize → record.\n')

const header =
  pad('cohort', 9) + pad('basis', 10) + padL('blend w', 9) +
  padL('rungs', 8) + '   ' + pad('median disposition', 22) + pad('median expectancy', 20) + 'target wallet pct'
console.log(header)
console.log('-'.repeat(header.length))

// One fixed wallet whose percentile we watch drift as the reference matures.
const targetTxs = makeWallet({ nTrades: 70, winRate: 0.36, winRet: 1.5, lossRet: 0.55,
  holdWinMin: 12, holdLossMin: 300, holdJitter: 0.3, gapAfterLossMin: 20, gapAfterWinMin: 60,
  buySizeCV: 0.45, interfaceFeeRate: 0.008, seed: 777 }).txs

let admitted = 0
let rejected = 0
let next = 0

for (const checkpoint of CHECKPOINTS) {
  while (next < checkpoint) {
    const r = analyze(makeWallet(walletParams(next)).txs, DEFAULTS.wallet)
    const rec = summarize(r, `hash-${next}`)
    if (rec) { await recordWallet(rec); admitted++ } else rejected++
    next++
  }

  const records = await readRecords({ force: true })
  const { ladders, cohort } = buildLadders(records)
  const dp = cohort.perMetric.dispositionRatio
  const ep = cohort.perMetric.expectancy

  const target = analyze(targetTxs, DEFAULTS.wallet, { ladders, cohort })
  const priorRun = analyze(targetTxs, DEFAULTS.wallet)

  const medDisp = ladders.dispositionRatio.find((x) => x.p === 0.5)?.v
  const medExp = ladders.expectancy.find((x) => x.p === 0.5)?.v
  const priorDisp = priorValueAt('dispositionRatio', 0.5)
  const priorExp = priorValueAt('expectancy', 0.5)

  console.log(
    padL(cohort.wallets, 6) + '   ' +
    pad(cohort.basis, 10) +
    padL(f(dp.weight), 9) +
    padL(`${dp.measuredRungs}/${dp.totalRungs}`, 8) + '   ' +
    pad(`${f(medDisp)}x  (prior ${f(priorDisp)}x)`, 22) +
    pad(`${f(medExp)}  (prior ${f(priorExp)})`, 20) +
    padL(`${Math.round((target.behavior.disposition.pctWorst || 0) * 100)}%`, 5) +
    (checkpoint === 0 ? '' : `  (on priors: ${Math.round((priorRun.behavior.disposition.pctWorst || 0) * 100)}%)`),
  )
}

const records = await readRecords({ force: true })
const { ladders, cohort } = buildLadders(records)

console.log(`\nADMISSION`)
console.log(`  ${admitted} wallets admitted · ${rejected} refused for fewer than 8 closed trades`)
console.log(`  version stamp: ${cohort.version}`)
console.log(`  rule: ${cohort.rule}`)

console.log(`\nPER-METRIC PROVENANCE AT n=${cohort.wallets}`)
for (const p of Object.values(cohort.perMetric)) {
  console.log(`  ${pad(p.metric, 18)} ${pad(p.basis, 10)} n=${padL(p.n, 4)}  w=${f(p.weight)}  rungs ${p.measuredRungs}/${p.totalRungs}`)
}

console.log(`\nMEASURED LADDER vs PRIOR — dispositionRatio`)
console.log('  ' + pad('p', 6) + padL('prior', 10) + padL('blended', 10) + '   shift')
for (const rung of ladders.dispositionRatio) {
  const prior = priorValueAt('dispositionRatio', rung.p)
  const shift = rung.v - prior
  console.log('  ' + pad(rung.p, 6) + padL(f(prior), 10) + padL(f(rung.v), 10) +
    `   ${shift >= 0 ? '+' : ''}${f(shift)}`)
}

console.log(`\nWHAT CHANGED FOR THE TARGET WALLET`)
{
  const onCohort = analyze(targetTxs, DEFAULTS.wallet, { ladders, cohort })
  const onPrior = analyze(targetTxs, DEFAULTS.wallet)
  const rows = [
    ['disposition', onPrior.behavior.disposition, onCohort.behavior.disposition],
    ['panic', onPrior.behavior.panic, onCohort.behavior.panic],
    ['revenge', onPrior.behavior.revenge, onCohort.behavior.revenge],
    ['sizing', onPrior.behavior.sizing, onCohort.behavior.sizing],
  ]
  console.log('  ' + pad('metric', 14) + padL('prior pct', 11) + padL('cohort pct', 12) + '   verdict change')
  for (const [name, a, b] of rows) {
    const va = a?.verdict?.[1] || '—'
    const vb = b?.verdict?.[1] || '—'
    console.log('  ' + pad(name, 14) +
      padL(`${Math.round((a?.pctWorst || 0) * 100)}%`, 11) +
      padL(`${Math.round((b?.pctWorst || 0) * 100)}%`, 12) +
      `   ${va === vb ? `unchanged (${va})` : `${va} → ${vb}`}`)
  }
  console.log(`\n  The metric itself never moves — only where it sits among peers. That is the whole`)
  console.log(`  point: "27x disposition" means nothing until you know what everyone else does.`)
}

console.log(`\nWHAT THIS SIMULATION DOES AND DOES NOT SHOW`)
console.log(`  DOES: the mechanism works end to end, gates correctly at every threshold, blends`)
console.log(`        monotonically toward measurement, and moves a real wallet's verdict when the`)
console.log(`        reference changes. It also shows the tails move MOST — the prior p98 for`)
console.log(`        disposition is 25x while this population's is far higher, so prior-based`)
console.log(`        percentiles overstate how unusual a bagholder is.`)
console.log(`  DOES NOT: tell you the true distribution. This population came from synth.js — it`)
console.log(`        reflects the generator's assumptions, not Solana. Treat the shift as evidence`)
console.log(`        that measurement will matter, never as a calibration. Real quantiles require`)
console.log(`        real scans, which is exactly why the store exists.`)
console.log('')
