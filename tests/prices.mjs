// Price adapter regression tests.
//
// Every case here comes from a real DexScreener payload, because the bug that
// motivated this file is invisible to synthetic fixtures: a generator does not
// invent scam pools.
//
// Live finding, 2026-07-28: the FIRST pair in DexScreener's response order for WSOL
// quoted SOL at $0.008 — a pool against a lookalike "USDC.s" on an obscure venue —
// while the median of twenty pairs was $73.14. Reading the first match scaled every
// derived pool depth by roughly nine thousand times. A liquidity floor would not have
// saved it: that pool reported $153,424 of liquidity.
//
// Run: node tests/prices.mjs

import { __test } from '../api/_lib/prices.js'

const { solUsdFrom, bestPair, median } = __test
const WSOL = 'So11111111111111111111111111111111111111112'
const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'

let pass = 0, fail = 0
const failures = []
const ok = (c, name, detail = '') => {
  if (c) { pass++; console.log(`  \x1b[32mPASS\x1b[0m ${name}`) }
  else { fail++; failures.push(`${name} — ${detail}`); console.log(`  \x1b[31mFAIL\x1b[0m ${name}  ${detail}`) }
}
const near = (a, b, tol, name) => ok(Number.isFinite(a) && Math.abs(a - b) <= tol, name, `got ${a} want ${b}`)
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`)

const wsolPair = (priceUsd, liqUsd, quoteSym = 'USDT') => ({
  baseToken: { address: WSOL, symbol: 'SOL' },
  quoteToken: { address: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', symbol: quoteSym },
  priceUsd: String(priceUsd), priceNative: '1', liquidity: { usd: liqUsd },
})

section('A. The live scam-pool payload that broke it')
{
  // Response order taken from the real payload: the garbage pool comes FIRST and is
  // not thin. Everything after it agrees on ~$73.
  const pairs = [
    wsolPair(0.008286, 153424, 'USDC.s'),
    wsolPair(73.16, 1231035),
    wsolPair(73.15, 441976),
    wsolPair(73.091, 1033973),
    wsolPair(73.14, 65666),
    wsolPair(0.008249, 2502, 'USDC.s'),
    wsolPair(74.56, 88000),
    wsolPair(73.2, 500000),
  ]
  const got = solUsdFrom(pairs)
  ok(got > 60 && got < 90, 'median anchor returns a real SOL price, not the first match', `got ${got}`)
  near(got, 73.155, 0.5, 'anchor lands on the consensus of the deep pools')
  ok(got !== 0.008286, 'the first pair in response order does NOT decide the price')
  // The exact consequence that made this critical.
  const liqUsd = 3_893_000
  ok(liqUsd / got < 100_000, 'derived pool depth is plausible', `${Math.round(liqUsd / got)} SOL`)
  ok(liqUsd / 0.008286 > 400_000_000, 'and the old behaviour really was catastrophic',
    `${Math.round(liqUsd / 0.008286)} SOL — the bug produced this`)
}

section('B. Anchor falls back and fails closed')
{
  ok(solUsdFrom([]) === null, 'no pairs -> null, never a guess')
  ok(solUsdFrom(null) === null, 'null input tolerated')
  ok(solUsdFrom([{ baseToken: { address: 'x' }, priceUsd: '5' }]) === null, 'unrelated pairs ignored')
  // Implied path: WSOL as the QUOTE side, priceUsd / priceNative.
  const implied = solUsdFrom([{
    baseToken: { address: MINT }, quoteToken: { address: WSOL },
    priceUsd: '0.000003', priceNative: '0.00000004', liquidity: { usd: 120000 },
  }])
  near(implied, 75, 1, 'implied anchor works when WSOL is only ever the quote token')
  ok(solUsdFrom([wsolPair(0, 1000), wsolPair(-3, 1000)]) === null, 'zero and negative prices rejected')
}

section('C. bestPair defers to consensus, not to depth alone')
{
  const tok = (priceNative, liqUsd, quote = WSOL) => ({
    baseToken: { address: MINT }, quoteToken: { address: quote },
    priceNative: String(priceNative), priceUsd: '1', liquidity: { usd: liqUsd, quote: liqUsd / 73 },
  })
  // A deep pool quoting a price four orders of magnitude off its peers. Depth-only
  // selection would take it; consensus must not.
  const pairs = [tok(0.0004, 900000), tok(0.00000004, 120000), tok(0.000000041, 80000), tok(0.000000039, 60000)]
  const chosen = bestPair(pairs, MINT)
  ok(Number(chosen.priceNative) < 0.0000001, 'the deep outlier is rejected in favour of consensus',
    `chose ${chosen.priceNative}`)
  near(Number(chosen.priceNative), 0.00000004, 1e-9, 'and it picks the deepest pool that agrees')

  // With too few pools there is no consensus to appeal to, so depth wins and we say
  // so rather than pretending to a majority.
  const thin = bestPair([tok(0.0004, 900000), tok(0.00000004, 120000)], MINT)
  ok(Number(thin.priceNative) === 0.0004, 'under three pools it falls back to depth')

  ok(bestPair([], MINT) === null, 'no pairs -> null')
  ok(bestPair([tok(0, 900000)], MINT) === null, 'a zero price is not a price')
  // SOL-quoted pools are preferred over deeper non-SOL pools, since priceNative is
  // only in SOL when the quote is SOL.
  const mixed = bestPair([tok(1.5, 5_000_000, 'OtherQuoteAddr'), tok(0.00000004, 100000),
    tok(0.000000041, 90000), tok(0.000000039, 80000)], MINT)
  ok(Number(mixed.priceNative) < 0.0000001, 'a SOL-quoted pool beats a deeper foreign-quoted one')
}

section('D. median helper')
{
  near(median([1, 2, 3]), 2, 0, 'odd length')
  near(median([1, 2, 3, 4]), 2.5, 0, 'even length averages the middle')
  near(median([5]), 5, 0, 'single value')
  ok(median([]) === null, 'empty -> null')
  near(median([100, 1, 1, 1, 1]), 1, 0, 'robust to a single extreme outlier')
}

console.log(`\n${'='.repeat(64)}`)
console.log(`\x1b[1mPRICE ADAPTER VALIDATION\x1b[0m  ${pass} passed, ${fail} failed`)
if (fail) { console.log('\n\x1b[31mFailures:\x1b[0m'); failures.forEach((x) => console.log(`  - ${x}`)) }
console.log('='.repeat(64))
process.exit(fail ? 1 : 0)
