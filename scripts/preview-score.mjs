// Renders the holder-score endpoint's output for a set of constructed token
// scenarios, so the B2B report can be read and judged without a live API key.
//
// The scenarios are built from wallet histories run through the REAL engine, so the
// behavioral profiles are genuine engine output rather than hand-written fixtures.
// Only the holder list and pool depth are constructed.
//
// Run: node scripts/preview-score.mjs

import { analyze } from '../api/_lib/engine.js'
import { scoreHolderBase } from '../api/_lib/holders.js'
import { makeWallet, DEFAULTS } from '../tests/synth.js'

const pad = (s, n) => String(s).padEnd(n)
const padL = (s, n) => String(s).padStart(n)
const f = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '—')
const pc = (x) => (Number.isFinite(x) ? `${Math.round(x * 100)}%` : '—')

// Turn a synthetic wallet into the profile shape the endpoint extracts.
function profileOf(params) {
  const r = analyze(makeWallet(params).txs, DEFAULTS.wallet)
  return {
    closedTrades: r.scorecard.closedTrades,
    expectancy: r.scorecard.expectancy?.point ?? null,
    panicIndex: r.behavior.panic?.point ?? null,
    dispositionRatio: r.behavior.disposition?.point ?? null,
    medianHoldWinMin: r.behavior.medianHoldWinMin ?? null,
    medianHoldLossMin: r.behavior.medianHoldLossMin ?? null,
    tradesPerDay: r.scorecard.tradesPerDay ?? null,
    archetype: r.archetype?.unread ? null : r.archetype?.primary?.key ?? null,
  }
}

const PANICKY = { nTrades: 60, winRate: 0.38, winRet: 1.5, lossRet: 0.7, holdWinMin: 7,
  holdLossMin: 3, gapAfterLossMin: 10, gapAfterWinMin: 20, seed: 5501 }
const PATIENT = { nTrades: 60, winRate: 0.52, winRet: 1.6, lossRet: 0.8, holdWinMin: 2600,
  holdLossMin: 2400, gapAfterLossMin: 400, gapAfterWinMin: 400, buySizeCV: 0.06, seed: 5502 }
const CHURNER = { nTrades: 120, winRate: 0.44, winRet: 1.2, lossRet: 0.82, holdWinMin: 4,
  holdLossMin: 5, gapAfterLossMin: 3, gapAfterWinMin: 3, seed: 5503 }
const NONE = { nTrades: 0, openBags: 1, seed: 5504 }

const P = {
  panicky: profileOf(PANICKY),
  patient: profileOf(PATIENT),
  churner: profileOf(CHURNER),
  none: profileOf(NONE),
}

const holder = (owner, amountUi, profile, position = null) => ({ owner, amountUi, profile, position })
const pos = (ret, heldMin = 600) => ({ costSol: 1, unrealizedReturn: ret, heldForMin: heldMin })

const SCENARIOS = [
  {
    name: 'Paper hands, all in profit, thin pool',
    depth: 25,
    holders: Array.from({ length: 10 }, (_, i) => holder(`p${i}`, 20000, P.panicky, pos(1.8, 40))),
  },
  {
    name: 'Patient base, deep underwater',
    depth: 25,
    holders: Array.from({ length: 10 }, (_, i) => holder(`q${i}`, 20000, P.patient, pos(-0.72, 9000))),
  },
  {
    name: 'Churners in profit, deep pool',
    depth: 4000,
    holders: Array.from({ length: 10 }, (_, i) => holder(`c${i}`, 20000, P.churner, pos(0.9, 120))),
  },
  {
    name: 'Mixed base, mid pool',
    depth: 120,
    holders: [
      ...Array.from({ length: 4 }, (_, i) => holder(`m${i}`, 30000, P.panicky, pos(1.2, 60))),
      ...Array.from({ length: 4 }, (_, i) => holder(`n${i}`, 20000, P.patient, pos(-0.5, 5000))),
      ...Array.from({ length: 2 }, (_, i) => holder(`o${i}`, 15000, P.churner, null)),
    ],
  },
  {
    name: 'Whale unreadable (pool or CEX)',
    depth: 200,
    holders: [
      holder('whale', 4000000, P.none),
      ...Array.from({ length: 6 }, (_, i) => holder(`r${i}`, 8000, P.panicky, pos(0.4))),
    ],
  },
  {
    name: 'Too few readable holders',
    depth: 100,
    holders: [holder('a', 50000, P.panicky, pos(0.5)), holder('b', 40000, P.none), holder('c', 30000, P.none)],
  },
  {
    name: 'No pool depth known',
    depth: null,
    holders: Array.from({ length: 8 }, (_, i) => holder(`s${i}`, 20000, P.panicky, pos(0.6))),
  },
]

console.log('\nHOLDER-BASE EXIT-LIQUIDITY RISK — scenario preview\n')
console.log('Behavioral profiles are real engine output over synthetic wallet histories;')
console.log('holder lists and pool depth are constructed to isolate each case.\n')

const header = pad('scenario', 34) + padL('score', 6) + '  ' + pad('grade', 24) +
  padL('sell', 8) + padL('/depth', 8) + padL('impact', 8) + padL('paper', 7) + padL('profit', 7) + padL('cover', 7)
console.log(header)
console.log('-'.repeat(header.length))

const reports = []
for (const s of SCENARIOS) {
  const r = scoreHolderBase({
    mint: 'MINTxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    holders: s.holders,
    tokenSolPrice: 0.0001,
    poolLiquiditySol: s.depth,
    totalHolders: s.holders.length,
  })
  reports.push({ s, r })
  const t = r.totals
  console.log(
    pad(s.name, 34) + padL(r.score ?? '—', 6) + '  ' + pad(r.grade, 24) +
    padL(f(t.expectedSellSol, 1), 8) + padL(pc(t.expectedPressure), 8) +
    padL(pc(t.congestionImpact), 8) + padL(pc(t.paperHandShare), 7) +
    padL(pc(t.profitOverhang), 7) + padL(pc(t.coverage), 7),
  )
}

console.log('\nSPREAD')
const scored = reports.map(({ r }) => r.score).filter((x) => x !== null)
console.log(`  scored ${scored.length} of ${reports.length} scenarios: ${scored.join(', ')}`)
console.log(`  range ${Math.min(...scored)} to ${Math.max(...scored)}`)

console.log('\nWHY EACH WAS OR WAS NOT SCORED')
for (const { s, r } of reports) {
  console.log(`  ${pad(s.name, 34)} ${r.scored ? 'scored' : `withheld — ${r.gates.join('; ')}`}`)
}

console.log('\nWORKED EXAMPLE — Mixed base, mid pool')
{
  const { r } = reports.find((x) => x.s.name === 'Mixed base, mid pool')
  console.log(`  ${r.reading}\n`)
  console.log('  ' + pad('holder', 10) + padL('mark', 9) + padL('if exit', 9) + padL('impact', 8) +
    padL('return', 8) + padL('dump', 7) + '  why')
  for (const h of r.holders) {
    const why = (h.reasons || []).slice(0, 2).join('; ')
    console.log('  ' + pad(h.owner, 10) + padL(f(h.markSol), 9) + padL(f(h.realizableSol), 9) +
      padL(pc(h.impactShare), 8) + padL(pc(h.unrealizedReturn), 8) +
      padL(h.propensity === null ? '—' : f(h.propensity), 7) + '  ' + why.slice(0, 74))
  }
  console.log('\n  limits:')
  for (const l of r.limits) console.log(`    - ${l.slice(0, 110)}${l.length > 110 ? '…' : ''}`)
}

console.log('\nHONESTY CHECK — the unscored cases must not read as safe')
for (const { s, r } of reports.filter((x) => !x.r.scored)) {
  const impliesSafe = /low risk|safe|patient/i.test(r.reading) && !/No score/.test(r.reading)
  console.log(`  ${pad(s.name, 34)} ${impliesSafe ? 'PROBLEM — reads as safe' : 'ok — refuses to imply safety'}`)
}
console.log('')
