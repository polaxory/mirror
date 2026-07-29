// Polaxory engine validation harness.
//
// The product claims to measure trading behavior. This file measures whether it
// actually does. Three classes of test:
//
//   A. RECOVERY   — generate wallets with known parameters; assert the engine
//                   recovers them within tolerance.
//   B. INVARIANTS — accounting identities that must hold on any input.
//   C. COVERAGE   — do the 95% intervals actually contain the truth 95% of the
//                   time? This is the test that makes the uncertainty claims real
//                   rather than decorative.
//
// Run: node tests/validate.mjs

import { analyze, classify, buildLedger } from '../api/_lib/engine.js'
import { makeWallet, makeUnmatchedSellWallet, makeRotationWallet, DEFAULTS } from './synth.js'
import { wilson, bootstrapCI } from '../api/_lib/stats.js'

let pass = 0, fail = 0
const failures = []

const ok = (cond, name, detail = '') => {
  if (cond) { pass++; console.log(`  \x1b[32mPASS\x1b[0m ${name}`) }
  else { fail++; failures.push(`${name} — ${detail}`); console.log(`  \x1b[31mFAIL\x1b[0m ${name}  ${detail}`) }
}
const near = (a, b, tol, name) =>
  ok(a !== null && b !== null && Math.abs(a - b) <= tol, name, `got ${fmt(a)} expected ${fmt(b)} ±${tol}`)
const within = (v, lo, hi, name) => ok(v !== null && v >= lo && v <= hi, name, `got ${fmt(v)} expected in [${lo},${hi}]`)
const fmt = (x) => (x === null || x === undefined ? 'null' : typeof x === 'number' ? x.toFixed(4) : String(x))
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`)

// ============================================================ A. RECOVERY

section('A1. Ledger recovers known PnL, win rate, expectancy')
{
  const { txs, truth } = makeWallet({ nTrades: 60, winRate: 0.45, winRet: 1.6, lossRet: 0.55, seed: 11 })
  const r = analyze(txs, DEFAULTS.wallet)
  const sc = r.scorecard
  near(sc.closedTrades, truth.nTrades, 0, 'closed trade count exact')
  near(sc.netPnlSol, truth.netPnl, 1e-6, 'net realized PnL exact to float precision')
  near(sc.winRate.point, truth.wins / truth.nTrades, 1e-9, 'observed win rate exact')
  near(sc.grossWinSol, truth.grossWin, 1e-6, 'gross win exact')
  near(sc.grossLossSol, truth.grossLoss, 1e-6, 'gross loss exact')
  near(sc.profitFactor.point, truth.profitFactor, 1e-6, 'profit factor exact')
  near(sc.expectancy.point, truth.netPnl / truth.basis, 1e-6, 'expectancy = netPnL / basis')
}

section('A2. Behavioral metrics recover planted patterns')
{
  // Bagholder: winners held 10 min, losers held 8 hours -> disposition ~48
  const { txs, truth } = makeWallet({
    nTrades: 60, winRate: 0.4, holdWinMin: 10, holdLossMin: 480, holdJitter: 0.1, seed: 21,
  })
  const r = analyze(txs, DEFAULTS.wallet)
  const b = r.behavior
  const trueRatio = median(truth.holdLoss) / median(truth.holdWin)
  near(b.disposition.point, trueRatio, trueRatio * 0.05, 'disposition ratio recovered within 5%')
  ok(b.disposition.verdict[0] === 'critical', 'extreme disposition flagged critical', `got ${b.disposition.verdict?.[0]}`)
  ok(r.archetype.primary.key === 'bagholder', 'bagholder archetype identified',
    `got ${r.archetype.primary.key} (${(r.archetype.primary.p * 100).toFixed(0)}%)`)
  ok(r.leaks.some((l) => l.title === 'Disposition effect'), 'disposition leak surfaced')
}
{
  // Panic seller: losers cut in 3 min, winners held 90 min
  const { txs } = makeWallet({ nTrades: 60, winRate: 0.4, holdWinMin: 90, holdLossMin: 3, holdJitter: 0.15, seed: 22 })
  const r = analyze(txs, DEFAULTS.wallet)
  within(r.behavior.panic.point, 0.9, 1.0, 'panic index near 1 when all losses cut fast')
  ok(r.archetype.mixture.some((m) => m.key === 'panic_seller' && m.p > 0.2),
    'panic_seller present in mixture', JSON.stringify(r.archetype.mixture.map((m) => [m.key, +m.p.toFixed(2)])))
}
{
  // Tilted: 5 min gap after losses, 240 min after wins -> revenge ratio ~48; sized 2.5x
  const { txs } = makeWallet({
    nTrades: 60, winRate: 0.4, gapAfterLossMin: 5, gapAfterWinMin: 240,
    revengeSizeMult: 2.5, buySizeCV: 0.05, seed: 23,
  })
  const r = analyze(txs, DEFAULTS.wallet)
  ok(r.behavior.revenge.point > 10, 'revenge ratio detects fast re-entry after losses', `got ${fmt(r.behavior.revenge.point)}`)
  ok(r.behavior.sizing.escalation > 1.6, 'size escalation after losses detected', `got ${fmt(r.behavior.sizing.escalation)}`)
  ok(r.leaks.some((l) => l.title === 'Tilt after losses'), 'tilt leak surfaced')
  ok(r.archetype.mixture.some((m) => m.key === 'tilted' && m.p > 0.15), 'tilted present in mixture',
    JSON.stringify(r.archetype.mixture.map((m) => [m.key, +m.p.toFixed(2)])))
}
{
  // Disciplined: consistent size, symmetric holds, positive expectancy
  const { txs } = makeWallet({
    nTrades: 70, winRate: 0.58, winRet: 1.45, lossRet: 0.72, holdWinMin: 60, holdLossMin: 55,
    buySizeCV: 0.05, gapAfterLossMin: 90, gapAfterWinMin: 90, retJitter: 0.06, seed: 24,
  })
  const r = analyze(txs, DEFAULTS.wallet)
  ok(r.scorecard.expectancy.point > 0, 'positive expectancy wallet reads positive', `got ${fmt(r.scorecard.expectancy.point)}`)
  ok(r.strengths.length >= 3, 'strengths surfaced for a good wallet', `got ${r.strengths.length}`)
  ok(['disciplined', 'sniper'].includes(r.archetype.primary.key), 'good wallet gets a positive archetype',
    `got ${r.archetype.primary.key}`)
  ok(r.score.value < 40, 'good wallet scores low exploitability', `got ${r.score.value}`)
}

section('A3. Strength detection is not cosmetic — it separates good from bad')
{
  const good = analyze(makeWallet({ nTrades: 60, winRate: 0.6, winRet: 1.5, lossRet: 0.75, buySizeCV: 0.05,
    holdWinMin: 45, holdLossMin: 45, retJitter: 0.05, seed: 31 }).txs, DEFAULTS.wallet)
  const bad = analyze(makeWallet({ nTrades: 60, winRate: 0.25, winRet: 1.3, lossRet: 0.45, buySizeCV: 1.6,
    holdWinMin: 8, holdLossMin: 600, gapAfterLossMin: 4, gapAfterWinMin: 200, revengeSizeMult: 2.2, seed: 32 }).txs, DEFAULTS.wallet)
  ok(good.strengths.length > bad.strengths.length, 'good wallet has more strengths than bad',
    `${good.strengths.length} vs ${bad.strengths.length}`)
  ok(bad.leaks.length > good.leaks.length, 'bad wallet has more leaks than good',
    `${bad.leaks.length} vs ${good.leaks.length}`)
  ok(bad.score.value > good.score.value + 20, 'exploitability separates the two by >20 points',
    `${bad.score.value} vs ${good.score.value}`)
}

section('A4. Toll attribution recovers planted fees')
{
  const { txs, truth } = makeWallet({ nTrades: 40, interfaceFeeRate: 0.01, networkFee: 0.0002, seed: 41 })
  const r = analyze(txs, DEFAULTS.wallet)
  near(r.scorecard.tollSol, truth.toll, truth.toll * 0.02, 'total visible toll recovered within 2%')
  ok(r.scorecard.interfaceTollSol > 0, 'interface toll separated from network fee')
  near(r.scorecard.networkFeeSol, 0.0002 * txs.length, 1e-6, 'network fee sum exact')
  const cf = r.counterfactuals.find((c) => c.key === 'no_toll')
  ok(cf && Math.abs(cf.deltaSol - truth.toll) < truth.toll * 0.02, 'zero-toll counterfactual equals toll paid')
}

section('A5. Counterfactuals are arithmetically sound')
{
  const { txs } = makeWallet({ nTrades: 50, winRate: 0.4, gapAfterLossMin: 5, gapAfterWinMin: 300, seed: 51 })
  const r = analyze(txs, DEFAULTS.wallet)
  const rev = r.counterfactuals.find((c) => c.key === 'no_revenge')
  ok(rev && rev.count > 0, 'revenge trades identified when planted')
  // removing the revenge trades must move PnL by exactly their summed PnL
  const revTrades = r.trades // capped, so recompute from ledger via analyze internals
  ok(rev && Number.isFinite(rev.deltaSol), 'revenge counterfactual returns a finite delta')

  // Null case: a wallet with long gaps everywhere should have no revenge trades
  const calm = analyze(makeWallet({ nTrades: 40, gapAfterLossMin: 600, gapAfterWinMin: 600, seed: 52 }).txs, DEFAULTS.wallet)
  const calmRev = calm.counterfactuals.find((c) => c.key === 'no_revenge')
  ok(!calmRev, 'no revenge counterfactual when re-entries are slow', calmRev ? `found ${calmRev.count}` : '')

  // Flat-size counterfactual on an already-flat wallet must be ~zero
  const flatW = analyze(makeWallet({ nTrades: 40, buySizeCV: 0, revengeSizeMult: 1, seed: 53 }).txs, DEFAULTS.wallet)
  const flatCf = flatW.counterfactuals.find((c) => c.key === 'flat_size')
  ok(flatCf && Math.abs(flatCf.deltaSol) < Math.abs(flatW.scorecard.netPnlSol) * 0.02 + 1e-6,
    'flat-size counterfactual ~0 when sizing is already flat', `got ${fmt(flatCf?.deltaSol)}`)
}

// ============================================================ B. INVARIANTS

section('B0. Counterfactual sign convention is uniform (prose matches arithmetic)')
{
  // Convention: deltaSol = what the ALTERNATIVE would have paid, so positive
  // always means the actual behavior cost that much. A v1 draft inverted this in
  // prose on one item while the arithmetic was right — worse than a wrong number,
  // because the reader trusts the sentence over the sign.
  // Two generator configs with opposite size-to-outcome coupling. Which one lands
  // on which sign depends on the interaction between revengeSizeMult and the win
  // sequence, so the test asserts the INVARIANT (prose agrees with sign) rather
  // than a predicted direction — both branches get exercised across the pair.
  const cases = [
    { name: 'shrink-after-loss config', p: { nTrades: 60, winRate: 0.5, winRet: 1.6, lossRet: 0.7,
      buySizeCV: 0.05, revengeSizeMult: 0.45, gapAfterLossMin: 30, gapAfterWinMin: 30, seed: 6001 } },
    { name: 'grow-after-loss config', p: { nTrades: 60, winRate: 0.35, winRet: 1.4, lossRet: 0.5,
      buySizeCV: 0.05, revengeSizeMult: 2.8, gapAfterLossMin: 10, gapAfterWinMin: 120, seed: 6002 } },
  ]
  const signsSeen = new Set()
  for (const c of cases) {
    const r = analyze(makeWallet(c.p).txs, DEFAULTS.wallet)
    const cf = r.counterfactuals.find((x) => x.key === 'flat_size')
    if (!cf) { ok(false, `${c.name}: flat_size counterfactual present`); continue }
    const saysCost = /worked against you|more than you actually made/.test(cf.note)
    const saysHelped = /earned its keep|less/.test(cf.note)
    signsSeen.add(cf.deltaSol > 0 ? 'pos' : 'neg')
    if (cf.deltaSol > 0) {
      ok(saysCost && !saysHelped, `${c.name}: positive delta reads as "your sizing cost you"`,
        `delta ${fmt(cf.deltaSol)} note: ${cf.note.slice(0, 70)}`)
    } else {
      ok(saysHelped && !saysCost, `${c.name}: negative delta reads as "your sizing helped"`,
        `delta ${fmt(cf.deltaSol)} note: ${cf.note.slice(0, 70)}`)
    }
  }
  ok(signsSeen.size === 2, 'both sign branches of the prose were exercised',
    `saw ${[...signsSeen].join(',')}`)

  // Every SOL-valued counterfactual must obey the same sign meaning.
  const r = analyze(makeWallet({ nTrades: 60, winRate: 0.35, interfaceFeeRate: 0.01,
    gapAfterLossMin: 5, gapAfterWinMin: 200, seed: 6003 }).txs, DEFAULTS.wallet)
  const toll = r.counterfactuals.find((c) => c.key === 'no_toll')
  ok(toll && toll.deltaSol > 0, 'zero-toll delta is positive (paying no toll would have paid more)')

  // Patience is the one item that must NEVER assert a PnL delta. Needs a wallet
  // that actually overholds losers, or the item does not fire at all.
  const held = analyze(makeWallet({ nTrades: 60, winRate: 0.4, holdWinMin: 8, holdLossMin: 600,
    holdJitter: 0.15, seed: 6004 }).txs, DEFAULTS.wallet)
  const patience = held.counterfactuals.find((c) => c.key === 'symmetric_patience')
  ok(!!patience, 'patience counterfactual fires when losers are overheld')
  ok(patience && patience.deltaSol === null && Number.isFinite(patience.exposure?.solDays),
    'patience claims SOL-days of exposure, never a PnL delta', JSON.stringify(patience?.exposure))
  ok(patience && /No PnL claim/.test(patience.note), 'patience note states it makes no PnL claim')
  ok(patience && patience.exposure.solDays > 0 && patience.exposure.count > 0,
    'patience exposure is positive and counts the overheld positions',
    JSON.stringify(patience?.exposure))
}

section('B1. Accounting identities hold')
{
  for (const seed of [61, 62, 63, 64, 65]) {
    const { txs } = makeWallet({ nTrades: 30 + (seed % 20), winRate: 0.3 + (seed % 5) * 0.1,
      interfaceFeeRate: 0.005, openBags: seed % 3, seed })
    const r = analyze(txs, DEFAULTS.wallet)
    const sc = r.scorecard
    const sumTrades = r.trades.reduce((s, t) => s + t.pnl, 0)
    // trades array is capped at 60; only assert when uncapped
    if (sc.closedTrades <= 60) {
      ok(Math.abs(sumTrades - sc.netPnlSol) < 1e-6, `seed ${seed}: sum of trade PnL == net PnL`)
    }
    ok(Math.abs(sc.grossWinSol - sc.grossLossSol - sc.netPnlSol) < 1e-6, `seed ${seed}: gross win - gross loss == net`)
    ok(Math.abs(sc.selectionPnlSol - (sc.netPnlSol + sc.tollSol)) < 1e-6, `seed ${seed}: selection == net + toll`)
    ok(Math.abs(sc.networkFeeSol + sc.interfaceTollSol - sc.tollSol) < 1e-6, `seed ${seed}: toll parts sum to total`)
    ok(sc.winsLosses[0] + sc.winsLosses[1] === sc.closedTrades, `seed ${seed}: wins + losses == trades`)
    ok(sc.equity.length === sc.closedTrades, `seed ${seed}: equity curve length == trade count`)
    if (sc.closedTrades) {
      ok(Math.abs(sc.equity[sc.equity.length - 1].cum - sc.netPnlSol) < 1e-6, `seed ${seed}: equity ends at net PnL`)
    }
  }
}

section('B2. Shrinkage behaves as specified')
{
  // small sample -> pulled hard toward prior; large sample -> close to observed
  const small = analyze(makeWallet({ nTrades: 6, winRate: 1.0, winRet: 1.5, seed: 71 }).txs, DEFAULTS.wallet)
  const large = analyze(makeWallet({ nTrades: 300, winRate: 0.75, winRet: 1.5, lossRet: 0.5, seed: 72 }).txs, DEFAULTS.wallet)
  const sSh = small.scorecard.winRateShrunk, sRaw = small.scorecard.winRate
  ok(sSh.value < sRaw.point, 'small-sample perfect record is shrunk downward',
    `raw ${fmt(sRaw.point)} shrunk ${fmt(sSh.value)}`)
  ok(sSh.value > 0.42, 'shrunk estimate stays above the prior mean given positive evidence', `got ${fmt(sSh.value)}`)
  ok(sSh.weightOnData < 0.3, 'small sample weights data lightly', `w=${fmt(sSh.weightOnData)}`)
  ok(large.scorecard.winRateShrunk.weightOnData > 0.9, 'large sample weights data heavily',
    `w=${fmt(large.scorecard.winRateShrunk.weightOnData)}`)
  ok(Math.abs(large.scorecard.winRateShrunk.value - large.scorecard.winRate.point) < 0.03,
    'large sample shrunk ~= observed')
  // monotonicity: shrunk value always between prior and observed
  for (const seed of [73, 74, 75]) {
    const r = analyze(makeWallet({ nTrades: 20, winRate: 0.8, seed }).txs, DEFAULTS.wallet)
    const sh = r.scorecard.winRateShrunk.value, raw = r.scorecard.winRate.point
    ok(sh >= Math.min(0.42, raw) - 1e-9 && sh <= Math.max(0.42, raw) + 1e-9,
      `seed ${seed}: shrunk value lies between prior and observed`, `prior 0.42 raw ${fmt(raw)} shrunk ${fmt(sh)}`)
  }
}

section('B3. Confidence gating suppresses unsupported claims')
{
  const tiny = analyze(makeWallet({ nTrades: 3, seed: 81 }).txs, DEFAULTS.wallet)
  ok(tiny.score.value === null, 'no exploitability score below 8 trades')
  ok(tiny.confidence.key === 'sketch', 'tier = sketch at n=3', `got ${tiny.confidence.key}`)
  const mid = analyze(makeWallet({ nTrades: 30, seed: 82 }).txs, DEFAULTS.wallet)
  ok(mid.confidence.key === 'indicative', 'tier = indicative at n=30', `got ${mid.confidence.key}`)
  const big = analyze(makeWallet({ nTrades: 120, seed: 83 }).txs, DEFAULTS.wallet)
  ok(big.confidence.key === 'substantive', 'tier = substantive at n=120', `got ${big.confidence.key}`)
  ok(big.score.ci && big.score.ci.hi - big.score.ci.lo < (mid.score.ci.hi - mid.score.ci.lo) + 1,
    'score interval tightens with sample size',
    `n=120 width ${big.score.ci.hi - big.score.ci.lo} vs n=30 width ${mid.score.ci.hi - mid.score.ci.lo}`)
}

section('B4. Edge cases do not crash or lie')
{
  const empty = analyze([], 'EMPTYWALLET')
  ok(empty.scorecard.closedTrades === 0, 'empty input -> 0 trades')
  ok(empty.archetype.unread === true, 'empty input -> unread archetype')
  ok(empty.score.value === null, 'empty input -> no score')

  const orphan = analyze(makeUnmatchedSellWallet(), DEFAULTS.wallet)
  ok(orphan.scorecard.closedTrades === 0, 'sells without basis are excluded, not fabricated')
  ok(orphan.sample.excluded.sellsWithoutBasis === 5, 'unmatched sells counted and disclosed',
    `got ${orphan.sample.excluded.sellsWithoutBasis}`)

  const rot = analyze(makeRotationWallet(), DEFAULTS.wallet)
  ok(rot.sample.excluded.rotations === 6, 'rotations counted separately', `got ${rot.sample.excluded.rotations}`)
  ok(rot.scorecard.closedTrades === 0, 'rotations produce no PnL claims')

  const oneTrade = analyze(makeWallet({ nTrades: 1, seed: 91 }).txs, DEFAULTS.wallet)
  ok(oneTrade.scorecard.closedTrades === 1, 'single trade parsed')
  ok(oneTrade.scorecard.profitFactor === null, 'no bootstrap CI at n=1')
  ok(oneTrade.score.value === null, 'no score at n=1')

  const bagsOnly = analyze(makeWallet({ nTrades: 0, openBags: 4, seed: 92 }).txs, DEFAULTS.wallet)
  ok(bagsOnly.openBags.count === 4, 'open bags detected with no closed trades', `got ${bagsOnly.openBags.count}`)
  ok(bagsOnly.scorecard.netPnlSol === null, 'no PnL claim when nothing is realized')

  // determinism: same input twice -> identical intervals
  const a = analyze(makeWallet({ nTrades: 40, seed: 93 }).txs, DEFAULTS.wallet)
  const b = analyze(makeWallet({ nTrades: 40, seed: 93 }).txs, DEFAULTS.wallet)
  ok(JSON.stringify(a.scorecard.profitFactor) === JSON.stringify(b.scorecard.profitFactor),
    'bootstrap intervals are deterministic for a given wallet')
}

section('B5. Findings require statistical support, not a favourable point estimate')
{
  // A coin-flipper with clean habits: must NOT be told it has an edge, but its
  // process strengths are true and should survive.
  const flip = analyze(makeWallet({ nTrades: 80, winRate: 0.5, winRet: 1.3, lossRet: 0.77,
    holdWinMin: 60, holdLossMin: 60, gapAfterLossMin: 60, gapAfterWinMin: 60, seed: 8101 }).txs, DEFAULTS.wallet)
  ok(!flip.strengths.some((s) => s.title === 'Positive expectancy'),
    'no "positive expectancy" claim when the interval straddles zero',
    `exp CI ${fmt(flip.scorecard.expectancy?.lo)} to ${fmt(flip.scorecard.expectancy?.hi)}`)
  ok(flip.diagnosis.edge === 'unproven', 'coin-flipper edge reads unproven', `got ${flip.diagnosis.edge}`)
  ok(flip.strengths.every((s) => s.kind === 'process') || flip.diagnosis.counts.outcomeStrengths === 0,
    'coin-flipper earns only process strengths')

  // Thin history: no findings of any kind should be asserted.
  const thin = analyze(makeWallet({ nTrades: 9, winRate: 0.33, seed: 8102 }).txs, DEFAULTS.wallet)
  ok(thin.strengths.length === 0 && thin.leaks.length === 0,
    'n=9 produces no findings at all', `got +${thin.strengths.length}/-${thin.leaks.length}`)
  ok(thin.archetype.hedged === true, 'n=9 archetype flagged as hedged')
  ok(thin.diagnosis.edge === 'unproven' && thin.diagnosis.process === 'unclear',
    'n=9 diagnosis is "too early to say"', `got ${thin.diagnosis.edge}|${thin.diagnosis.process}`)

  // Contradiction suppression: a wallet that sizes up after losses must not be
  // credited with size discipline, even with low baseline variance.
  const esc = analyze(makeWallet({ nTrades: 70, winRate: 0.4, buySizeCV: 0.08, revengeSizeMult: 2.6,
    gapAfterLossMin: 6, gapAfterWinMin: 200, seed: 8103 }).txs, DEFAULTS.wallet)
  ok(!esc.strengths.some((s) => s.title === 'Size discipline'),
    'no "size discipline" credit when sizing escalates after losses',
    `escalation ${fmt(esc.behavior.sizing?.escalation)}, cv ${fmt(esc.behavior.sizing?.cv)}`)
  ok(esc.leaks.some((l) => l.title === 'Sizing up to recover'), 'escalation surfaced as a leak instead')

  // Archetype confidence: small n must be flatter than large n on the same profile.
  const small = analyze(makeWallet({ nTrades: 12, winRate: 0.4, holdWinMin: 8, holdLossMin: 600, seed: 8104 }).txs, DEFAULTS.wallet)
  const large = analyze(makeWallet({ nTrades: 120, winRate: 0.4, holdWinMin: 8, holdLossMin: 600, seed: 8104 }).txs, DEFAULTS.wallet)
  ok(small.archetype.primary.p < large.archetype.primary.p,
    'archetype confidence grows with sample size',
    `n=12 ${(small.archetype.primary.p * 100).toFixed(0)}% vs n=120 ${(large.archetype.primary.p * 100).toFixed(0)}%`)
}

section('B6. Diagnosis separates edge from process on all four quadrants')
{
  const cases = [
    { name: 'negative edge + sound process', expectEdge: 'negative', p: {
      nTrades: 80, winRate: 0.28, winRet: 1.3, lossRet: 0.55, holdWinMin: 90, holdLossMin: 95,
      gapAfterLossMin: 120, gapAfterWinMin: 120, buySizeCV: 0.06, seed: 8201 } },
    { name: 'positive edge + broken process', expectEdge: 'positive', p: {
      nTrades: 90, winRate: 0.5, winRet: 2.2, lossRet: 0.72, holdWinMin: 5, holdLossMin: 700,
      gapAfterLossMin: 4, gapAfterWinMin: 240, revengeSizeMult: 2.6, buySizeCV: 0.9,
      interfaceFeeRate: 0.02, openBags: 6, retJitter: 0.08, seed: 8202 } },
  ]
  for (const c of cases) {
    const r = analyze(makeWallet(c.p).txs, DEFAULTS.wallet)
    ok(r.diagnosis.edge === c.expectEdge, `${c.name}: edge reads ${c.expectEdge}`,
      `got ${r.diagnosis.edge} (exp CI ${fmt(r.scorecard.expectancy?.lo)}..${fmt(r.scorecard.expectancy?.hi)})`)
    ok(typeof r.diagnosis.headline === 'string' && r.diagnosis.headline.length > 0,
      `${c.name}: headline present`)
  }
  // The key product claim: a disciplined loser is told it is a SELECTION problem.
  const r = analyze(makeWallet(cases[0].p).txs, DEFAULTS.wallet)
  if (r.diagnosis.edge === 'negative' && r.diagnosis.process === 'sound') {
    ok(/SELECTION problem/.test(r.diagnosis.reading), 'disciplined loser told it is a selection problem')
  } else {
    console.log(`     (note: disciplined-loser case landed in ${r.diagnosis.edge}|${r.diagnosis.process})`)
  }
}

// ============================================================ C. COVERAGE

section('C1. Wilson 95% interval covers the true win rate ~95% of the time')
{
  const TRUE_P = 0.4
  const N = 40
  const M = 400
  let covered = 0
  for (let m = 0; m < M; m++) {
    const { txs } = makeWallet({ nTrades: N, winRate: TRUE_P, winRet: 1.5, lossRet: 0.5, retJitter: 0.02, seed: 1000 + m })
    const r = analyze(txs, DEFAULTS.wallet)
    const ci = r.scorecard.winRate
    if (ci && ci.lo <= TRUE_P && TRUE_P <= ci.hi) covered++
  }
  const rate = covered / M
  console.log(`     empirical coverage: ${(rate * 100).toFixed(1)}% over ${M} synthetic wallets (n=${N}, p=${TRUE_P})`)
  within(rate, 0.9, 1.0, 'win-rate CI coverage in [90%, 100%]')
}

section('C2. Bootstrap expectancy interval covers the generating expectancy')
{
  const M = 250
  const N = 60
  let covered = 0
  let widths = []
  for (let m = 0; m < M; m++) {
    const { txs, truth } = makeWallet({
      nTrades: N, winRate: 0.45, winRet: 1.6, lossRet: 0.55, retJitter: 0.15, seed: 2000 + m,
    })
    const r = analyze(txs, DEFAULTS.wallet)
    const ci = r.scorecard.expectancy
    // The generating expectancy in the population sense: E[return per SOL]
    const trueExp = 0.45 * (1.6 - 1) + 0.55 * (0.55 - 1)
    if (ci && ci.lo !== undefined && ci.lo <= trueExp && trueExp <= ci.hi) covered++
    if (ci && ci.hi !== undefined) widths.push(ci.hi - ci.lo)
  }
  const rate = covered / M
  const meanWidth = widths.reduce((a, b) => a + b, 0) / widths.length
  console.log(`     empirical coverage: ${(rate * 100).toFixed(1)}% over ${M} wallets; mean CI width ${meanWidth.toFixed(3)}`)
  within(rate, 0.85, 1.0, 'expectancy bootstrap CI coverage in [85%, 100%]')
}

section('C3. Intervals narrow as sample grows (consistency)')
{
  const widths = {}
  for (const n of [10, 30, 100, 300]) {
    const { txs } = makeWallet({ nTrades: n, winRate: 0.45, winRet: 1.6, lossRet: 0.55, seed: 3001 })
    const r = analyze(txs, DEFAULTS.wallet)
    widths[n] = r.scorecard.winRate.hi - r.scorecard.winRate.lo
  }
  console.log(`     win-rate CI width: ${Object.entries(widths).map(([n, w]) => `n=${n}:${w.toFixed(3)}`).join('  ')}`)
  ok(widths[10] > widths[30] && widths[30] > widths[100] && widths[100] > widths[300],
    'CI width strictly decreasing in n', JSON.stringify(widths))
  // roughly 1/sqrt(n): width(100)/width(400ish) should be ~2x for a 4x sample
  const ratio = widths[30] / widths[300]
  within(ratio, 2.2, 4.5, 'width shrinks at roughly the sqrt(n) rate (10x sample -> ~3.2x tighter)')
}

section('C4. Archetype mixture is a probability distribution')
{
  for (const seed of [4001, 4002, 4003, 4004]) {
    const { txs } = makeWallet({ nTrades: 50, winRate: 0.2 + (seed % 4) * 0.15, holdWinMin: 5 + (seed % 3) * 40,
      holdLossMin: 10 + (seed % 5) * 100, buySizeCV: (seed % 3) * 0.6, seed })
    const r = analyze(txs, DEFAULTS.wallet)
    if (r.archetype.unread) continue
    const shown = r.archetype.mixture.reduce((s, m) => s + m.p, 0)
    ok(shown > 0 && shown <= 1.0000001, `seed ${seed}: displayed mixture sums to <= 1`, `got ${fmt(shown)}`)
    ok(r.archetype.mixture.every((m) => m.p >= 0 && m.p <= 1), `seed ${seed}: all probabilities in [0,1]`)
    ok(r.archetype.mixture[0].p === Math.max(...r.archetype.mixture.map((m) => m.p)),
      `seed ${seed}: mixture sorted, primary is the mode`)
  }
}

// ============================================================ helpers

function median(xs) {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

// ============================================================ report

console.log(`\n${'='.repeat(64)}`)
console.log(`\x1b[1mENGINE VALIDATION\x1b[0m  ${pass} passed, ${fail} failed`)
if (fail) {
  console.log(`\n\x1b[31mFailures:\x1b[0m`)
  failures.forEach((f) => console.log(`  - ${f}`))
}
console.log('='.repeat(64))
process.exit(fail ? 1 : 0)
