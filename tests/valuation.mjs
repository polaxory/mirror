// Valuation validation.
//
// Two things must hold, and the second matters more than the first:
//   1. The arithmetic is right, including the AMM impact bound.
//   2. Injecting prices changes NOTHING about the behavioral read. A measurement
//      that moves when an external API answers differently is not a measurement,
//      and this suite is what stops that from drifting in.
//
// Run: node tests/valuation.mjs

import { analyze } from '../api/_lib/engine.js'
import { valueBags, combinePosition } from '../api/_lib/valuation.js'
import { makeWallet, DEFAULTS } from './synth.js'

let pass = 0, fail = 0
const failures = []
const ok = (c, name, detail = '') => {
  if (c) { pass++; console.log(`  \x1b[32mPASS\x1b[0m ${name}`) }
  else { fail++; failures.push(`${name} — ${detail}`); console.log(`  \x1b[31mFAIL\x1b[0m ${name}  ${detail}`) }
}
const f = (x) => (Number.isFinite(x) ? x.toFixed(4) : String(x))
const near = (a, b, tol, name) => ok(Number.isFinite(a) && Math.abs(a - b) <= tol, name, `got ${f(a)} want ${f(b)} ±${tol}`)
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`)

const bag = (mint, qty, costSol) => ({ mint, qty, costSol, firstTs: 1735689600 })
const book = (entries, extra = {}) => ({ ok: true, source: 'test', entries, skipped: [], ...extra })
const px = (solPrice, liquiditySol, quoteIsSol = true) => ({
  solPrice, liquiditySol, usdPrice: null, liquidityUsd: null, quoteIsSol, dex: 'raydium',
})

// ---------------------------------------------------------------- arithmetic

section('A. Mark arithmetic')
{
  const v = valueBags([bag('A', 1000, 2)], book({ A: px(0.005, 500) }))
  const it = v.items[0]
  ok(it.priced, 'bag with a positive price is marked')
  near(it.markSol, 5, 1e-9, 'mark = qty x price')
  near(it.unrealizedSol, 3, 1e-9, 'unrealized = mark - cost')
  near(v.totals.markSol, 5, 1e-9, 'total mark')
  near(v.totals.unrealizedSol, 3, 1e-9, 'total unrealized')
  ok(v.basis === 'marked', 'basis = marked when every bag is priced', v.basis)
  ok(!v.partial, 'not partial')
}

section('B. The impact bound is CPMM-exact, not a fudge')
{
  // realizable = mark / (1 + mark/liquidity)
  const cases = [
    { mark: 1, liq: 100, expect: 1 / 1.01 },
    { mark: 10, liq: 100, expect: 10 / 1.1 },
    { mark: 100, liq: 100, expect: 50 },
    { mark: 400, liq: 100, expect: 80 },
  ]
  for (const c of cases) {
    // qty x price = mark, with price 1 so qty = mark
    const v = valueBags([bag('X', c.mark, 0)], book({ X: px(1, c.liq) }))
    near(v.items[0].realizableSol, c.expect, 1e-9,
      `mark ${c.mark} into ${c.liq} SOL depth realizes ${c.expect.toFixed(2)}`)
    near(v.items[0].impactShare, c.mark / c.liq, 1e-9, `impact share = mark/depth (${c.mark}/${c.liq})`)
  }
  // The bound must never exceed the mark, and never go negative.
  for (const [mark, liq] of [[0.001, 1000], [5, 5], [1000, 0.6]]) {
    const v = valueBags([bag('Y', mark, 0)], book({ Y: px(1, liq) }))
    const i = v.items[0]
    ok(i.realizableSol <= i.markSol + 1e-12, `realizable never exceeds mark (${mark}/${liq})`)
    ok(i.realizableSol > 0, `realizable stays positive (${mark}/${liq})`)
  }
}

section('C. Depth honesty flags')
{
  const deep = valueBags([bag('A', 1, 1)], book({ A: px(1, 10000) }))
  ok(deep.items[0].flags.length === 0, 'deep pool, small bag: no flags', JSON.stringify(deep.items[0].flags))

  const material = valueBags([bag('A', 10, 1)], book({ A: px(1, 100) }))
  ok(material.items[0].flags.includes('material-impact'), 'bag at 10% of depth flags material impact')

  const over = valueBags([bag('A', 200, 1)], book({ A: px(1, 100) }))
  ok(over.items[0].flags.includes('exceeds-pool-depth'), 'bag larger than the pool is flagged')

  const dust = valueBags([bag('A', 1, 1)], book({ A: px(1, 0.2) }))
  ok(dust.items[0].flags.includes('pool-negligible'), 'negligible pool is flagged regardless of arithmetic')

  const noDepth = valueBags([bag('A', 1, 1)], book({ A: { solPrice: 1, liquiditySol: null, quoteIsSol: true } }))
  ok(noDepth.items[0].flags.includes('depth-unknown'), 'missing depth is flagged')
  ok(noDepth.items[0].realizableSol === null, 'no realizable claim without depth')
  ok(noDepth.totals.realizableSol === null, 'totals refuse a realizable sum when any bag lacks depth')

  const alt = valueBags([bag('A', 1, 1)], book({ A: px(1, 100, false) }))
  ok(alt.items[0].flags.includes('non-sol-quote'), 'a non-SOL-quoted pool is disclosed')
}

section('D. Fallback to cost basis is total and honest')
{
  const none = valueBags([bag('A', 1000, 2), bag('B', 500, 1)], null)
  ok(none.basis === 'cost', 'no price book -> cost basis', none.basis)
  ok(none.totals.markSol === null, 'no mark claimed')
  ok(none.totals.unrealizedSol === null, 'no unrealized claimed')
  near(none.totals.costSol, 3, 1e-9, 'cost basis still totalled')
  ok(none.totals.pricedCount === 0 && none.totals.unpricedCount === 2, 'counts reflect the failure')
  ok(none.items.every((i) => i.flags.includes('unpriced')), 'every bag flagged unpriced')

  const zero = valueBags([bag('A', 1000, 2)], book({ A: px(0, 100) }))
  ok(zero.items[0].priced === false, 'a zero price is not a price')
  const neg = valueBags([bag('A', 1000, 2)], book({ A: px(-1, 100) }))
  ok(neg.items[0].priced === false, 'a negative price is not a price')
  const noQty = valueBags([{ mint: 'A', qty: 0, costSol: 2 }], book({ A: px(1, 100) }))
  ok(noQty.items[0].priced === false, 'a zero-quantity bag is not marked')
}

section('E. Partial coverage is measured by cost, not by count')
{
  // One large bag priced, four dust bags unpriced: coverage should read HIGH.
  const bags = [bag('BIG', 100, 10), bag('d1', 1, 0.05), bag('d2', 1, 0.05), bag('d3', 1, 0.05), bag('d4', 1, 0.05)]
  const v = valueBags(bags, book({ BIG: px(0.2, 1000) }))
  ok(v.basis === 'partial', 'basis = partial', v.basis)
  ok(v.partial === true, 'partial flag set')
  near(v.totals.coverage, 10 / 10.2, 1e-9, 'coverage is the priced share of COST (98%), not of count (20%)')
  near(v.totals.pricedCostSol, 10, 1e-9, 'priced cost basis')
  near(v.totals.unpricedCostSol, 0.2, 1e-9, 'unpriced cost basis')
  // Unrealized must be computed against PRICED cost only, never total cost.
  near(v.totals.unrealizedSol, 20 - 10, 1e-9, 'unrealized compares mark to priced cost only')
}

section('F. Combined position never overstates what it knows')
{
  const v = valueBags([bag('A', 1000, 2)], book({ A: px(0.005, 500) }))
  const c = combinePosition(-36.79, v)
  near(c.realizedSol, -36.79, 1e-9, 'realized carried through')
  near(c.unrealizedSol, 3, 1e-9, 'unrealized carried through')
  near(c.totalSol, -33.79, 1e-9, 'total = realized + unrealized')
  ok(/not an exit/.test(c.caveat), 'caveat states a mark is not an exit', c.caveat)

  const unpriced = combinePosition(-36.79, valueBags([bag('A', 1000, 2)], null))
  ok(unpriced.totalSol === null, 'no combined figure when nothing could be marked')
  ok(/Realized PnL stands alone/.test(unpriced.caveat), 'caveat says realized stands alone')

  const partial = combinePosition(-10, valueBags(
    [bag('BIG', 100, 10), bag('d', 1, 5)], book({ BIG: px(0.2, 1000) })))
  ok(/covers only/.test(partial.caveat), 'partial caveat quantifies the coverage', partial.caveat)
  ok(combinePosition(null, v) === null, 'no combined figure without realized PnL')
}

// ------------------------------------------------- the invariant that matters

section('G. Prices change the disclosure and NOTHING else')
{
  const txs = makeWallet({ nTrades: 90, winRate: 0.32, winRet: 1.6, lossRet: 0.55,
    holdWinMin: 11, holdLossMin: 320, buySizeCV: 0.5, gapAfterLossMin: 7, gapAfterWinMin: 95,
    revengeSizeMult: 2.1, interfaceFeeRate: 0.009, openBags: 6, openBagSize: 1.4, seed: 9301 }).txs

  const plain = analyze(txs, DEFAULTS.wallet)
  const mints = plain.openBags.pricingMints
  ok(mints.length === 6, 'six open bags to price', String(mints.length))

  // Three price books that disagree wildly about what the bags are worth.
  const books = {
    moon: book(Object.fromEntries(mints.map((m) => [m, px(10, 100000)]))),
    zero: book(Object.fromEntries(mints.map((m) => [m, px(1e-9, 100000)]))),
    thin: book(Object.fromEntries(mints.map((m) => [m, px(1, 0.4)]))),
  }

  // Everything the read is made of must be byte-identical across all of them.
  const fingerprint = (r) => JSON.stringify({
    scorecard: r.scorecard, behavior: r.behavior, diagnosis: r.diagnosis,
    archetype: r.archetype, score: r.score, strengths: r.strengths, leaks: r.leaks,
    counterfactuals: r.counterfactuals, confidence: r.confidence, sample: r.sample,
  })
  const baseline = fingerprint(plain)
  for (const [name, b] of Object.entries(books)) {
    const priced = analyze(txs, DEFAULTS.wallet, { prices: b })
    ok(fingerprint(priced) === baseline,
      `"${name}" prices leave scorecard, behavior, diagnosis, score and findings untouched`)
    ok(priced.openBags.basis === 'marked', `"${name}" still marks the bags`, priced.openBags.basis)
    ok(priced.position.totalSol !== null, `"${name}" produces a combined figure`)
  }

  // And the marks themselves must differ, or the test above proves nothing.
  const moon = analyze(txs, DEFAULTS.wallet, { prices: books.moon })
  const zero = analyze(txs, DEFAULTS.wallet, { prices: books.zero })
  ok(moon.openBags.totals.markSol > zero.openBags.totals.markSol * 1000,
    'the disclosure DOES move with prices (so the invariant above is meaningful)',
    `${f(moon.openBags.totals.markSol)} vs ${f(zero.openBags.totals.markSol)}`)
  ok(moon.position.totalSol > plain.scorecard.netPnlSol,
    'a mooning bag lifts the combined figure above realized')
  ok(zero.position.totalSol < plain.scorecard.netPnlSol,
    'a worthless bag drags the combined figure below realized')
}

section('H. Engine payload discloses its own basis')
{
  const txs = makeWallet({ nTrades: 40, openBags: 4, openBagSize: 1, seed: 9401 }).txs
  const noPrice = analyze(txs, DEFAULTS.wallet)
  ok(noPrice.openBags.basis === 'cost', 'basis = cost with no price book', noPrice.openBags.basis)
  ok(noPrice.limits.some((l) => /no mark was available/.test(l)), 'limits disclose the missing mark')
  ok(noPrice.limits.some((l) => /realized-only/.test(l)), 'limits state metrics are realized-only')

  const mints = noPrice.openBags.pricingMints
  const withPrice = analyze(txs, DEFAULTS.wallet, {
    prices: book(Object.fromEntries(mints.map((m) => [m, px(0.5, 800)]))),
  })
  ok(withPrice.openBags.basis === 'marked', 'basis = marked with prices')
  ok(withPrice.limits.some((l) => /realizable figure beside it/.test(l)),
    'limits point at the realizable bound')
  ok(/disclosure only/.test(withPrice.openBags.excludedFromMetrics),
    'payload states marks are disclosure only')
  ok(withPrice.openBags.pricingMints.length <= 30, 'pricing list is capped')
}

section('I. Degenerate inputs do not crash')
{
  for (const [name, args] of [
    ['null bags', [null, null]],
    ['empty bags', [[], book({})]],
    ['bags but empty book', [[bag('A', 1, 1)], book({})]],
    ['book with junk entry', [[bag('A', 1, 1)], book({ A: { solPrice: 'x', liquiditySol: 'y' } })]],
    ['NaN quantity', [[{ mint: 'A', qty: NaN, costSol: 1 }], book({ A: px(1, 100) })]],
    ['missing mint field', [[{ qty: 1, costSol: 1 }], book({ A: px(1, 100) })]],
  ]) {
    let out = null
    let threw = false
    try { out = valueBags(...args) } catch { threw = true }
    ok(!threw && out && Array.isArray(out.items), `${name}: returns a valuation without throwing`)
    ok(out && ['none', 'cost', 'partial', 'marked'].includes(out.basis), `${name}: basis is a known value`, out?.basis)
  }
  const empty = valueBags([], null)
  ok(empty.basis === 'none' && empty.totals.count === 0, 'no bags -> basis none')
}

console.log(`\n${'='.repeat(64)}`)
console.log(`\x1b[1mVALUATION VALIDATION\x1b[0m  ${pass} passed, ${fail} failed`)
if (fail) { console.log('\n\x1b[31mFailures:\x1b[0m'); failures.forEach((x) => console.log(`  - ${x}`)) }
console.log('='.repeat(64))
process.exit(fail ? 1 : 0)
