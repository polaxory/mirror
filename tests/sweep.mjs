// Calibration sweep: run the engine across a spectrum of known wallet profiles
// and print what it says about each. A scoring system that puts everything in the
// middle is useless however well its unit tests pass — this checks that the
// output actually spreads, and that each profile gets the archetype it should.
//
// Run: node tests/sweep.mjs

import { analyze } from '../api/_lib/engine.js'
import { makeWallet, DEFAULTS } from './synth.js'

const PROFILES = [
  { name: 'Textbook exit liquidity', expect: 'exit_liquidity', p: {
    nTrades: 80, winRate: 0.22, winRet: 1.25, lossRet: 0.45, holdWinMin: 6, holdLossMin: 40,
    gapAfterLossMin: 6, gapAfterWinMin: 30, buySizeCV: 1.2, revengeSizeMult: 1.8,
    interfaceFeeRate: 0.01, seed: 5001 } },
  { name: 'Chronic bagholder', expect: 'bagholder', p: {
    nTrades: 70, winRate: 0.42, winRet: 1.3, lossRet: 0.5, holdWinMin: 9, holdLossMin: 900,
    openBags: 8, interfaceFeeRate: 0.008, seed: 5002 } },
  { name: 'Panic seller', expect: 'panic_seller', p: {
    nTrades: 70, winRate: 0.38, winRet: 1.5, lossRet: 0.7, holdWinMin: 120, holdLossMin: 4,
    gapAfterLossMin: 12, gapAfterWinMin: 90, seed: 5003 } },
  { name: 'Serial rotator (churn)', expect: 'serial_rotator', p: {
    nTrades: 120, winRate: 0.44, winRet: 1.2, lossRet: 0.82, holdWinMin: 4, holdLossMin: 5,
    gapAfterLossMin: 3, gapAfterWinMin: 3, interfaceFeeRate: 0.01, seed: 5004 } },
  { name: 'Tilted martingale', expect: 'tilted', p: {
    nTrades: 70, winRate: 0.35, winRet: 1.4, lossRet: 0.55, holdWinMin: 25, holdLossMin: 30,
    gapAfterLossMin: 3, gapAfterWinMin: 180, revengeSizeMult: 3.0, buySizeCV: 0.15, seed: 5005 } },
  { name: 'Profitable sniper', expect: 'sniper', p: {
    nTrades: 90, winRate: 0.56, winRet: 1.6, lossRet: 0.8, holdWinMin: 6, holdLossMin: 8,
    gapAfterLossMin: 40, gapAfterWinMin: 40, buySizeCV: 0.2, retJitter: 0.08, seed: 5006 } },
  { name: 'Disciplined allocator', expect: 'disciplined', p: {
    nTrades: 80, winRate: 0.55, winRet: 1.55, lossRet: 0.8, holdWinMin: 200, holdLossMin: 190,
    gapAfterLossMin: 240, gapAfterWinMin: 240, buySizeCV: 0.04, retJitter: 0.06, seed: 5007 } },
  { name: 'Coin-flipper (no edge)', expect: null, p: {
    nTrades: 80, winRate: 0.5, winRet: 1.3, lossRet: 0.77, holdWinMin: 60, holdLossMin: 60,
    gapAfterLossMin: 60, gapAfterWinMin: 60, buySizeCV: 0.5, seed: 5008 } },
  { name: 'Thin history (n=9)', expect: null, p: { nTrades: 9, winRate: 0.33, seed: 5009 } },
]

const pad = (s, n) => String(s).padEnd(n)
const padL = (s, n) => String(s).padStart(n)
const f2 = (x) => (x === null || x === undefined ? '  —  ' : padL(x.toFixed(2), 5))
const pctS = (x) => (x === null || x === undefined ? ' — ' : padL(Math.round(x * 100) + '%', 4))

console.log('\nCALIBRATION SWEEP — engine-v1\n')
console.log(pad('profile', 26) + pad('archetype (p)', 26) + padL('score', 6) + padL('CI', 10) +
  padL('leak', 6) + padL('read', 6) + padL('cad', 6) + padL('expct', 7) + padL('n', 5) + '  tier')
console.log('-'.repeat(122))

const rows = []
for (const prof of PROFILES) {
  const { txs } = makeWallet(prof.p)
  const r = analyze(txs, DEFAULTS.wallet)
  const a = r.archetype
  const c = r.score.components
  const archStr = a.unread ? 'unread' : `${a.primary.key} ${Math.round(a.primary.p * 100)}%`
  const match = prof.expect === null ? '' : a.primary?.key === prof.expect ? ' ok' : ` EXPECTED ${prof.expect}`
  console.log(
    pad(prof.name, 26) + pad(archStr, 26) +
    padL(r.score.value ?? '—', 6) +
    padL(r.score.ci ? `${r.score.ci.lo}-${r.score.ci.hi}` : '—', 10) +
    (c ? pctS(c.leak) + pctS(c.readability) + pctS(c.cadence) : padL('—', 4) + padL('—', 6) + padL('—', 6)) +
    f2(r.scorecard.expectancy?.point) +
    padL(r.scorecard.closedTrades, 5) + '  ' + r.confidence.label + match,
  )
  rows.push({ name: prof.name, score: r.score.value, arch: a.primary?.key, r })
}

console.log('\nSPREAD CHECK')
const scored = rows.filter((x) => x.score !== null).map((x) => x.score)
console.log(`  scores: ${scored.join(', ')}`)
console.log(`  range: ${Math.min(...scored)} to ${Math.max(...scored)} (span ${Math.max(...scored) - Math.min(...scored)})`)
const distinctArch = new Set(rows.map((x) => x.arch).filter(Boolean))
console.log(`  distinct archetypes assigned: ${distinctArch.size} of ${PROFILES.filter((p) => p.expect).length} targeted`)

console.log('\nDIAGNOSIS — the two axes (edge x process)')
console.log('  ' + pad('profile', 26) + pad('edge', 11) + pad('process', 10) + 'headline')
for (const x of rows) {
  const d = x.r.diagnosis
  console.log('  ' + pad(x.name, 26) + pad(d.edge, 11) + pad(d.process, 10) + d.headline)
}

console.log('\nFINDINGS DENSITY (outcome / process split)')
for (const x of rows) {
  const c = x.r.diagnosis.counts
  console.log(`  ${pad(x.name, 26)} strengths +${c.outcomeStrengths}out/+${c.processStrengths}proc   ` +
    `leaks -${c.outcomeLeaks}out/-${c.processLeaks}proc   cf: ${x.r.counterfactuals.length}`)
}

console.log('\nWORKED EXAMPLE — Tilted martingale, full reflective output')
{
  const { txs } = makeWallet(PROFILES[4].p)
  const r = analyze(txs, DEFAULTS.wallet)
  console.log(`  archetype mixture: ${r.archetype.mixture.map((m) => `${m.key} ${Math.round(m.p * 100)}%`).join(', ')}`)
  console.log(`  net ${r.scorecard.netPnlSol.toFixed(2)} SOL  |  toll ${r.scorecard.tollSol.toFixed(3)} SOL ` +
    `(${(r.scorecard.tollRate * 100).toFixed(2)}% of turnover)  |  selection-only ${r.scorecard.selectionPnlSol.toFixed(2)} SOL`)
  console.log(`  win rate ${(r.scorecard.winRate.point * 100).toFixed(0)}% ` +
    `[${(r.scorecard.winRate.lo * 100).toFixed(0)}-${(r.scorecard.winRate.hi * 100).toFixed(0)}%] ` +
    `shrunk ${(r.scorecard.winRateShrunk.value * 100).toFixed(0)}% (data weight ${(r.scorecard.winRateShrunk.weightOnData * 100).toFixed(0)}%)`)
  console.log(`  max drawdown ${r.scorecard.maxDrawdownSol.toFixed(2)} SOL | peak capital ${r.scorecard.peakCapitalSol.toFixed(2)} SOL | RoC ${(r.scorecard.returnOnCapital * 100).toFixed(0)}%`)
  console.log('  counterfactuals:')
  for (const c of r.counterfactuals) {
    const amt = c.deltaSol !== null && c.deltaSol !== undefined ? `${c.deltaSol >= 0 ? '+' : ''}${c.deltaSol.toFixed(2)} SOL` :
      c.pct !== undefined ? `${Math.round(c.pct * 100)}%` : 'exposure only'
    console.log(`    ${pad(c.label, 46)} ${padL(amt, 12)}${c.hindsight ? '  (hindsight)' : ''}`)
  }
  console.log('  leaks:')
  for (const l of r.leaks) console.log(`    - ${l.title}: ${l.evidence}`)
  console.log('  strengths:')
  if (!r.strengths.length) console.log('    (none detected)')
  for (const s of r.strengths) console.log(`    + ${s.title}: ${s.evidence}`)
}
console.log('')
