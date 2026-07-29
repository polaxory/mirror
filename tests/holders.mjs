// Holder-base scoring validation.
//
// This is the B2B product, so it gets the strictest reading of "never claim more
// than the sample supports" — a token is not safe because we failed to read its
// holders. The load-bearing behavioral fact under test is the disposition
// asymmetry: holders in profit sell, holders deep underwater sit. Getting that
// backwards would invert the entire score.
//
// Run: node tests/holders.mjs

import { scoreHolderBase, holderPressure, HOLDER_PARAMS } from '../api/_lib/holders.js'

let pass = 0, fail = 0
const failures = []
const ok = (c, name, detail = '') => {
  if (c) { pass++; console.log(`  \x1b[32mPASS\x1b[0m ${name}`) }
  else { fail++; failures.push(`${name} — ${detail}`); console.log(`  \x1b[31mFAIL\x1b[0m ${name}  ${detail}`) }
}
const f = (x) => (Number.isFinite(x) ? x.toFixed(4) : String(x))
const near = (a, b, tol, name) => ok(Number.isFinite(a) && Math.abs(a - b) <= tol, name, `got ${f(a)} want ${f(b)} ±${tol}`)
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`)

// A profiled trader with sane defaults; override what a case is about.
const trader = (o = {}) => ({
  closedTrades: 40, expectancy: -0.1, panicIndex: 0.2, dispositionRatio: 2,
  medianHoldWinMin: 120, medianHoldLossMin: 600, tradesPerDay: 2, archetype: 'bagholder',
  ...o,
})
const holder = (owner, amountUi, profile = trader(), position = null) =>
  ({ owner, amountUi, profile, position, shareOfScanned: null })
const pos = (o = {}) => ({ costSol: 1, unrealizedReturn: 0, heldForMin: 600, ...o })

const base = (holders, o = {}) => scoreHolderBase({
  mint: 'MINTxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  holders, tokenSolPrice: 0.001, poolLiquiditySol: 100, totalHolders: holders.length, ...o,
})

// ------------------------------------------------- disposition asymmetry

section('A. The disposition effect points the right way')
{
  const inProfit = holderPressure(holder('a', 1000, trader(), pos({ unrealizedReturn: 1.2 })))
  const flat = holderPressure(holder('b', 1000, trader(), pos({ unrealizedReturn: 0 })))
  const under = holderPressure(holder('c', 1000, trader(), pos({ unrealizedReturn: -0.7, heldForMin: 600 })))

  ok(inProfit.propensity > flat.propensity, 'a holder in profit is likelier to sell than a flat one',
    `${f(inProfit.propensity)} vs ${f(flat.propensity)}`)
  ok(under.propensity < flat.propensity, 'a holder underwater is LESS likely to sell than a flat one',
    `${f(under.propensity)} vs ${f(flat.propensity)}`)
  ok(inProfit.propensity > under.propensity * 1.5, 'the gap between profit and loss is substantial',
    `${f(inProfit.propensity)} vs ${f(under.propensity)}`)
  ok(inProfit.reasons.some((r) => /disposition effect/.test(r)), 'the reason names the effect')
  ok(under.reasons.some((r) => /bagholders tend to sit/.test(r)), 'the underwater reason explains the sit')
}

section('B. Stuck bags damp further, not less')
{
  const fresh = holderPressure(holder('a', 1000, trader({ medianHoldLossMin: 600 }),
    pos({ unrealizedReturn: -0.6, heldForMin: 600 })))
  const overdue = holderPressure(holder('b', 1000, trader({ medianHoldLossMin: 600 }),
    pos({ unrealizedReturn: -0.6, heldForMin: 600 * 8 })))
  ok(overdue.propensity < fresh.propensity, 'held 8x past habit while underwater lowers propensity further',
    `${f(overdue.propensity)} vs ${f(fresh.propensity)}`)
  ok(overdue.reasons.some((r) => /longer than it normally holds a loser/.test(r)), 'the reason is stated')
  // Damping must not apply to a winner: a profitable position held a long time is
  // not a bag, and suppressing its pressure would hide real overhead supply.
  const winnerHeldLong = holderPressure(holder('c', 1000, trader({ medianHoldLossMin: 600 }),
    pos({ unrealizedReturn: 1.5, heldForMin: 600 * 8 })))
  ok(winnerHeldLong.components.stuck === 0, 'a long-held WINNER is not treated as stuck',
    f(winnerHeldLong.components.stuck))
}

section('C. Behavioral habits move propensity')
{
  const fastPanicky = holderPressure(holder('a', 1000,
    trader({ medianHoldWinMin: 8, panicIndex: 0.85, tradesPerDay: 12 }), pos()))
  const patient = holderPressure(holder('b', 1000,
    trader({ medianHoldWinMin: 4000, panicIndex: 0.02, tradesPerDay: 0.2 }), pos()))
  ok(fastPanicky.propensity > patient.propensity * 2, 'a fast panicky wallet far outranks a patient one',
    `${f(fastPanicky.propensity)} vs ${f(patient.propensity)}`)
  ok(fastPanicky.reasons.length >= 3, 'multiple reasons given for a high-propensity holder',
    String(fastPanicky.reasons.length))
  ok(patient.classification === 'trader', 'a patient wallet is still classified as a trader')
}

section('D. No behavioral claim without history')
{
  const none = holderPressure(holder('a', 1000, trader({ closedTrades: 0 })))
  ok(none.propensity === null, 'zero closed trades -> no propensity')
  ok(none.classification === 'no-history', 'classified no-history', none.classification)
  ok(/pool, a program, an exchange/.test(none.reasons[0]),
    'the reason admits it could be infrastructure rather than guessing')

  const thin = holderPressure(holder('b', 1000, trader({ closedTrades: 3 })))
  ok(thin.propensity === null, 'three closed trades -> no propensity')
  ok(thin.classification === 'thin-history', 'classified thin-history', thin.classification)

  for (let n = 0; n < HOLDER_PARAMS.MIN_TRADES_FOR_PROFILE; n++) {
    ok(holderPressure(holder('x', 1, trader({ closedTrades: n }))).propensity === null,
      `n=${n} is below the profile floor`)
  }
  ok(holderPressure(holder('y', 1, trader({ closedTrades: HOLDER_PARAMS.MIN_TRADES_FOR_PROFILE }))).propensity !== null,
    `n=${HOLDER_PARAMS.MIN_TRADES_FOR_PROFILE} clears the floor`)
}

// ------------------------------------------------- aggregate arithmetic

section('E. Expected selling is propensity-weighted value, sized against depth')
{
  // Two holders, 1000 tokens each at 0.001 SOL = 1 SOL of position each.
  // Identical profiles -> identical propensity p. Expected sell = 2p.
  const hs = [holder('a', 1000), holder('b', 1000)]
  const r = base(hs, { poolLiquiditySol: 100 })
  const p = r.holders[0].propensity
  near(r.totals.scannedValueSol, 2, 1e-9, 'scanned value = 2 SOL')
  near(r.totals.expectedSellSol, 2 * p, 1e-9, 'expected selling = sum of propensity x mark')
  near(r.totals.expectedPressure, (2 * p) / 100, 1e-9, 'pressure = expected selling / pool depth')
  near(r.totals.congestionImpact, r.totals.expectedPressure / (1 + r.totals.expectedPressure), 1e-12,
    'congestion impact uses the same CPMM form as a single exit')
  ok(r.totals.congestionImpact < r.totals.expectedPressure, 'impact is below the raw pressure ratio')
}

section('F. Deeper pools absorb the same holders')
{
  const hs = Array.from({ length: 8 }, (_, i) => holder(`h${i}`, 1000))
  const thin = base(hs, { poolLiquiditySol: 3 })
  const deep = base(hs, { poolLiquiditySol: 3000 })
  ok(thin.score > deep.score, 'the same holder base scores riskier on a thin pool',
    `${thin.score} vs ${deep.score}`)
  near(thin.totals.expectedSellSol, deep.totals.expectedSellSol, 1e-9,
    'expected selling is identical — only what the pool can absorb differs')
  ok(deep.totals.congestionImpact < 0.01, 'a deep pool barely moves', f(deep.totals.congestionImpact))
}

section('G. Coverage is by value, and gates the score')
{
  // One whale profiled, several dust holders unreadable: coverage should be HIGH.
  const hs = [
    holder('whale', 100000),
    ...Array.from({ length: 5 }, (_, i) => holder(`d${i}`, 100, trader({ closedTrades: 0 }))),
  ]
  const r = base(hs)
  ok(r.totals.profiled === 1, 'one holder profiled')
  ok(r.totals.coverage > 0.99, 'coverage by value is ~99%, not 1/6', f(r.totals.coverage))
  ok(r.score === null, 'still no score — the profiled-holder count gate bites',
    `score ${r.score}, gates ${JSON.stringify(r.gates)}`)
  ok(r.gates.some((g) => /fewer than 5 holders/.test(g)), 'the gate names the reason')

  // Enough holders but thin value coverage.
  const many = [
    holder('whale', 1000000, trader({ closedTrades: 0 })),
    ...Array.from({ length: 6 }, (_, i) => holder(`s${i}`, 100)),
  ]
  const r2 = base(many)
  ok(r2.totals.profiled === 6, 'six profiled')
  // Coverage is now "of readable value, how much profiled" — which is 100% here,
  // because the unreadable whale is not counted as a trader we failed to read.
  near(r2.totals.coverage, 1, 1e-9, 'coverage of READABLE value is complete')
  ok(r2.totals.behavioralShare < HOLDER_PARAMS.MIN_BEHAVIORAL_SHARE,
    'but almost none of the float is readable at all', f(r2.totals.behavioralShare))
  ok(r2.score === null, 'no score when an unreadable holder dominates the float')
  ok(r2.gates.some((g) => /readable trading history/.test(g)),
    'the gate says most of the float is an unknown, not that coverage is low', JSON.stringify(r2.gates))
}

section('H. Missing price or depth suppresses the score, not the report')
{
  const hs = Array.from({ length: 8 }, (_, i) => holder(`h${i}`, 1000))
  const noDepth = base(hs, { poolLiquiditySol: null })
  ok(noDepth.score === null, 'no score without pool depth')
  ok(noDepth.gates.some((g) => /pool depth/.test(g)), 'gate names depth')
  ok(noDepth.totals.expectedSellSol > 0, 'expected selling is still reported in SOL')
  ok(noDepth.totals.expectedPressure === null, 'but never sized against a depth we do not have')

  const noPrice = base(hs, { tokenSolPrice: null })
  ok(noPrice.score === null, 'no score without a price')
  ok(noPrice.totals.scannedValueSol === null, 'no position values claimed')
  ok(noPrice.holders.every((h) => h.markSol === null), 'every mark is null')

  const empty = base([])
  ok(empty.score === null, 'no holders -> no score')
  ok(empty.totals.scanned === 0, 'scanned count is zero')
  ok(Array.isArray(empty.limits) && empty.limits.length > 0, 'limits still stated')
}

section('I. Score responds to the right things, in the right direction')
{
  const mk = (o) => Array.from({ length: 8 }, (_, i) => holder(`h${i}`, 1000, trader(o.profile), o.position))

  const patientUnderwater = base(mk({
    profile: { medianHoldWinMin: 5000, panicIndex: 0.02, tradesPerDay: 0.2, medianHoldLossMin: 600 },
    position: pos({ unrealizedReturn: -0.7, heldForMin: 6000 }),
  }), { poolLiquiditySol: 60 })

  const paperInProfit = base(mk({
    profile: { medianHoldWinMin: 6, panicIndex: 0.9, tradesPerDay: 14, medianHoldLossMin: 5 },
    position: pos({ unrealizedReturn: 2.0, heldForMin: 30 }),
  }), { poolLiquiditySol: 60 })

  console.log(`     patient+underwater ${patientUnderwater.score} (${patientUnderwater.grade})`)
  console.log(`     paper+in profit    ${paperInProfit.score} (${paperInProfit.grade})`)
  ok(paperInProfit.score > patientUnderwater.score + 25,
    'paper hands sitting on gains score far riskier than patient bagholders',
    `${paperInProfit.score} vs ${patientUnderwater.score}`)
  ok(patientUnderwater.score < 45, 'a patient underwater base is not flagged as heavy', String(patientUnderwater.score))
  ok(paperInProfit.components.paperHands > 0.9, 'paper-hand share is near total', f(paperInProfit.components.paperHands))
  ok(paperInProfit.components.profitOverhang > 0.9, 'profit overhang is near total', f(paperInProfit.components.profitOverhang))
  ok(patientUnderwater.components.profitOverhang === 0, 'no overhang when nobody is in profit')

  // The formula must be exactly what it says it is.
  for (const r of [patientUnderwater, paperInProfit]) {
    const c = r.components
    const amp = 0.45 + 0.55 * (0.6 * c.paperHands + 0.4 * c.profitOverhang)
    const expected = Math.round(100 * Math.min(1, c.pressure * amp))
    ok(r.score === expected, `score matches the stated formula (${r.score})`, `recomputed ${expected}`)
    near(c.amplifier, amp, 1e-12, 'reported amplifier matches the formula')
  }
}

section('I2. Liquidity that can absorb them means they are not a risk')
{
  // The regression a scenario preview caught: a base of pure paper hands, entirely
  // in profit, scored 51 on a pool deep enough that their selling could not move the
  // price. Paper hands amplify pressure; they must never manufacture it.
  const paperHands = trader({ medianHoldWinMin: 5, panicIndex: 0.95, tradesPerDay: 15 })
  const hs = Array.from({ length: 10 }, (_, i) => holder(`h${i}`, 20000, paperHands, pos({ unrealizedReturn: 1.5 })))

  const deep = base(hs, { tokenSolPrice: 0.0001, poolLiquiditySol: 4000 })
  const thin = base(hs, { tokenSolPrice: 0.0001, poolLiquiditySol: 25 })

  ok(deep.components.paperHands > 0.95 && deep.components.profitOverhang > 0.95,
    'the deep-pool case really is all paper hands in profit',
    `${f(deep.components.paperHands)}/${f(deep.components.profitOverhang)}`)
  ok(deep.totals.expectedPressure < 0.01, 'their selling is under 1% of depth', f(deep.totals.expectedPressure))
  ok(deep.score < 10, 'so the score is near zero despite maximal paper hands', String(deep.score))
  ok(deep.grade === 'Patient holder base' || deep.grade === 'Ordinary holder risk',
    'and the grade does not cry wolf', deep.grade)
  ok(thin.score > 80, 'the identical holders on a thin pool score severely', String(thin.score))
  ok(thin.score - deep.score > 70, 'depth alone separates the two cases by a wide margin',
    `${thin.score} vs ${deep.score}`)

  // Monotonic in depth: no non-monotonic surprises between the extremes.
  const scores = [10, 40, 160, 640, 2560].map((d) =>
    base(hs, { tokenSolPrice: 0.0001, poolLiquiditySol: d }).score)
  ok(scores.every((s, i) => i === 0 || s <= scores[i - 1]), 'score is non-increasing as depth grows',
    JSON.stringify(scores))
}

section('J. Profit overhang is measured against KNOWN basis only')
{
  // Four in profit with known basis, four with unknown basis. Overhang should read
  // 100% of what is known, not 50% of everything — unknown basis must not
  // masquerade as "not in profit".
  const hs = [
    ...Array.from({ length: 4 }, (_, i) => holder(`k${i}`, 1000, trader(), pos({ unrealizedReturn: 0.8 }))),
    ...Array.from({ length: 4 }, (_, i) => holder(`u${i}`, 1000, trader(), null)),
  ]
  const r = base(hs)
  ok(r.totals.basisKnownFor === 4, 'basis known for four holders', String(r.totals.basisKnownFor))
  near(r.totals.profitOverhang, 1, 1e-9, 'overhang is 100% of known-basis value, not 50% of all value')
  ok(r.holders.filter((h) => h.unrealizedReturn === null).length === 4, 'unknown basis stays null, never zero')
  ok(r.holders.some((h) => h.reasons?.some((x) => /cost basis unknown/.test(x))),
    'a holder with unknown basis says so')
}

section('K. Owners are never double-counted and output is ordered')
{
  const hs = [holder('small', 10), holder('big', 100000), holder('mid', 5000)]
  const r = base(hs)
  const marks = r.holders.map((h) => h.markSol)
  ok(marks[0] >= marks[1] && marks[1] >= marks[2], 'holders sorted by position value descending',
    JSON.stringify(marks))
  ok(new Set(r.holders.map((h) => h.owner)).size === 3, 'no owner appears twice')
}

section('L. The reading is explanatory, and honest when it cannot be')
{
  const scored = base(Array.from({ length: 8 }, (_, i) =>
    holder(`h${i}`, 1000, trader({ medianHoldWinMin: 8, panicIndex: 0.8 }), pos({ unrealizedReturn: 1.5 }))),
    { poolLiquiditySol: 20 })
  ok(/SOL of selling/.test(scored.reading), 'reading quantifies expected selling in SOL', scored.reading.slice(0, 80))
  ok(/of pool depth/.test(scored.reading), 'reading sizes it against depth')
  ok(/Covers \d+% of scanned holder value/.test(scored.reading), 'reading states its own coverage')

  const ungated = base([holder('a', 1000)])
  ok(/^No score:/.test(ungated.reading), 'unscored reading leads with the refusal', ungated.reading.slice(0, 40))
  ok(/not patient just because it could not be measured/.test(ungated.reading),
    'unscored reading refuses to imply safety')
  ok(scored.limits.some((l) => /not a prediction that any particular wallet will sell/.test(l)),
    'limits disclaim per-wallet prediction')
  ok(scored.limits.some((l) => /concentration below the cut is invisible/.test(l)),
    'limits disclose the scan cut')
  ok(scored.limits.some((l) => /no realized trading history/.test(l)),
    'limits explain how unreadable balances are treated')
}

section('M. Degenerate input does not crash')
{
  for (const [name, arg] of [
    ['no args', undefined],
    ['null holders', { holders: null }],
    ['holder without profile', { holders: [{ owner: 'x', amountUi: 1 }] }],
    ['NaN amount', { holders: [holder('x', NaN)] }],
    ['negative price', { holders: [holder('x', 100)], tokenSolPrice: -1 }],
    ['junk position', { holders: [{ owner: 'x', amountUi: 1, profile: trader(), position: { costSol: 'a' } }] }],
  ]) {
    let out = null, threw = false
    try { out = scoreHolderBase(arg) } catch (e) { threw = true }
    ok(!threw && out && Array.isArray(out.holders), `${name}: returns a report without throwing`)
    ok(out && (out.score === null || Number.isFinite(out.score)), `${name}: score is null or a number`)
  }
}

section('N. Infrastructure leaves the coverage denominator, not the report')
{
  const RAYDIUM = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8'
  const BINANCE = '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9'
  const BURN = '1nc1nerator11111111111111111111111111111111'

  // The exact distortion this closes: a token whose top holders are its own pool,
  // an exchange and a burn address, with a perfectly legible retail base beneath.
  const hs = [
    { owner: RAYDIUM, amountUi: 5000000, profile: trader({ closedTrades: 0 }), position: null },
    { owner: BINANCE, amountUi: 3000000, profile: trader({ closedTrades: 0 }), position: null },
    { owner: BURN, amountUi: 2000000, profile: trader({ closedTrades: 0 }), position: null },
    ...Array.from({ length: 6 }, (_, i) => holder(`retail${i}`, 20000, trader(), pos({ unrealizedReturn: 0.8 }))),
  ]
  const r = base(hs, { tokenSolPrice: 0.0001, poolLiquiditySol: 60 })

  ok(r.totals.infrastructure === 3, 'three infrastructure holders identified', String(r.totals.infrastructure))
  ok(r.totals.infrastructureLabels.includes('Raydium AMM v4'), 'the pool is named', JSON.stringify(r.totals.infrastructureLabels))
  ok(r.totals.infrastructureLabels.includes('Binance hot wallet'), 'the exchange is named')
  ok(r.totals.profiled === 6, 'all six retail holders profiled', String(r.totals.profiled))
  ok(r.totals.coverage > 0.99, 'coverage is ~100% of readable value, not 6/9', f(r.totals.coverage))
  ok(r.scored === true, 'the token IS scored — infrastructure no longer blocks it', JSON.stringify(r.gates))
  ok(r.totals.infrastructureValueSol > r.totals.scannedValueSol,
    'infrastructure value is reported separately and dwarfs the retail base',
    `${f(r.totals.infrastructureValueSol)} vs ${f(r.totals.scannedValueSol)}`)

  // Without the list, the identical holder base is withheld — which is the bug.
  const unlabelled = base([
    ...hs.slice(3),
    { owner: 'UnknownPoolxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', amountUi: 10000000, profile: trader({ closedTrades: 0 }), position: null },
  ], { tokenSolPrice: 0.0001, poolLiquiditySol: 60 })
  ok(unlabelled.scored === false, 'an UNLABELLED pool still withholds the score — honest fallback, not a guess')
  ok(unlabelled.gates.some((g) => /readable trading history/.test(g)),
    'and says the float is mostly unreadable', JSON.stringify(unlabelled.gates))

  const infraRow = r.holders.find((h) => h.owner === RAYDIUM)
  ok(infraRow.classification === 'infrastructure', 'the row is classified as infrastructure')
  ok(infraRow.propensity === null, 'no propensity claimed for a pool')
  ok(/rather than a participant/.test(infraRow.reasons[0]), 'the reason explains why', infraRow.reasons[0])
  ok(r.limits.some((l) => /incomplete by construction/.test(l)), 'limits admit the list is incomplete')
}

console.log(`\n${'='.repeat(64)}`)
console.log(`\x1b[1mHOLDER SCORE VALIDATION\x1b[0m  ${pass} passed, ${fail} failed`)
if (fail) { console.log('\n\x1b[31mFailures:\x1b[0m'); failures.forEach((x) => console.log(`  - ${x}`)) }
console.log('='.repeat(64))
process.exit(fail ? 1 : 0)
