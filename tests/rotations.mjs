// Rotation validation.
//
// The claim being tested: a buy -> rotate -> sell chain must settle for the same
// total whichever shape the middle leg took, and the engine must never invent a
// realized figure for a leg where no SOL moved.
//
// Before this, both sides of a rotation were lost — the sold lot lingered as a
// phantom bag and the bought token had no basis, so selling it counted as an
// unmatched sell. A chain that made 1.4 SOL recorded nothing at all.
//
// Run: node tests/rotations.mjs

import { analyze, classify, buildLedger } from '../api/_lib/engine.js'
import { makeRotationChain, makeRotationWallet, makeWallet, DEFAULTS } from './synth.js'

let pass = 0, fail = 0
const failures = []
const ok = (c, name, detail = '') => {
  if (c) { pass++; console.log(`  \x1b[32mPASS\x1b[0m ${name}`) }
  else { fail++; failures.push(`${name} — ${detail}`); console.log(`  \x1b[31mFAIL\x1b[0m ${name}  ${detail}`) }
}
const f = (x) => (Number.isFinite(x) ? x.toFixed(4) : String(x))
const near = (a, b, tol, name) => ok(Number.isFinite(a) && Math.abs(a - b) <= tol, name, `got ${f(a)} want ${f(b)} ±${tol}`)
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`)
const run = (txs) => analyze(txs, DEFAULTS.wallet)

section('A. classify() extracts both gross SOL legs from a routed rotation')
{
  const { txs } = makeRotationChain({ routed: true, rotateSol: 1.6, tag: 'a' })
  const rotTx = txs.find((t) => t.signature.startsWith('rc-rot'))
  const ev = classify(rotTx, DEFAULTS.wallet)
  ok(ev?.kind === 'rotation', 'rotation classified', ev?.kind)
  near(ev.grossSolIn, 1.6, 1e-9, 'gross SOL in recovered from the WSOL credit')
  near(ev.grossSolOut, 1.6, 1e-9, 'gross SOL out recovered from the WSOL debit')
  ok(ev.soldMint === 'ROTAa' && ev.boughtMint === 'ROTBa', 'sold and bought mints identified')
  ok(!ev.multi, 'single-token rotation not flagged multi-leg')

  const direct = classify(
    makeRotationChain({ routed: false, tag: 'b' }).txs.find((t) => t.signature.startsWith('rc-rot')),
    DEFAULTS.wallet,
  )
  ok(direct.grossSolIn === 0 && direct.grossSolOut === 0, 'direct rotation has no SOL legs',
    `${f(direct.grossSolIn)}/${f(direct.grossSolOut)}`)
}

section('B. A routed chain realizes BOTH legs at their observed values')
{
  const { txs, truth } = makeRotationChain({ routed: true, buySol: 1.0, rotateSol: 1.6, sellSol: 2.4, tag: 'c' })
  const r = run(txs)
  ok(r.scorecard.closedTrades === 2, 'two closed trades', String(r.scorecard.closedTrades))
  near(r.scorecard.netPnlSol, truth.chainPnl, 1e-9, 'chain PnL = final SOL out - initial SOL in (1.40)')

  const byMint = Object.fromEntries(r.trades.map((t) => [t.mint, t]))
  near(byMint[truth.A].pnl, truth.legAPnl, 1e-9, 'leg A realized at the rotation SOL value (+0.60)')
  near(byMint[truth.B].pnl, truth.legBPnl, 1e-9, 'leg B realized from the rotation cost (+0.80)')
  near(byMint[truth.B].cost, truth.rotateSol, 1e-9, "leg B's basis is what the rotation actually paid")
  ok(byMint[truth.A].via === 'rotation', 'leg A tagged as closed via rotation')
  ok(byMint[truth.B].via === 'sol', 'leg B tagged as closed via a SOL sale')
  ok(r.sample.rotations.valued === 1, 'one rotation valued', String(r.sample.rotations.valued))
  ok(r.openBags.count === 0, 'nothing left open — no phantom bag')
}

section('C. A direct chain rolls basis and claims no phantom PnL')
{
  const { txs, truth } = makeRotationChain({ routed: false, buySol: 1.0, sellSol: 2.4, tag: 'd' })
  const r = run(txs)
  ok(r.scorecard.closedTrades === 1, 'one closed trade, not two', String(r.scorecard.closedTrades))
  near(r.scorecard.netPnlSol, truth.chainPnl, 1e-9, 'chain PnL still recovered in full (1.40)')
  const t = r.trades[0]
  ok(t.mint === truth.B, 'the closed trade is the token actually sold for SOL', t.mint)
  near(t.cost, 1.0, 1e-9, "basis rolled from A: cost is A's original 1.0 SOL, not zero")
  ok(r.sample.rotations.basisRolled === 1, 'one basis rollover recorded', String(r.sample.rotations.basisRolled))
  ok(r.sample.rotations.valued === 0, 'no rotation was valued (correctly — no SOL moved)')
  ok(r.openBags.count === 0, 'no phantom bag left behind')
  ok(r.sample.excluded.sellsWithoutBasis === 0, 'the final sale is no longer an unmatched sell')
}

section('D. Both shapes settle to the same total — attribution differs, sum does not')
{
  for (const [buySol, sellSol] of [[1, 2.4], [2, 0.5], [0.4, 0.41], [5, 12]]) {
    const routed = run(makeRotationChain({ routed: true, buySol, sellSol, rotateSol: (buySol + sellSol) / 2, tag: 'e' }).txs)
    const direct = run(makeRotationChain({ routed: false, buySol, sellSol, tag: 'f' }).txs)
    near(routed.scorecard.netPnlSol, sellSol - buySol, 1e-9, `routed ${buySol}->${sellSol}: nets ${(sellSol - buySol).toFixed(2)}`)
    near(direct.scorecard.netPnlSol, sellSol - buySol, 1e-9, `direct ${buySol}->${sellSol}: nets the same`)
    near(routed.scorecard.netPnlSol, direct.scorecard.netPnlSol, 1e-9,
      `${buySol}->${sellSol}: shape of the middle leg does not change the total`)
  }
}

section('E. Multi-hop rollover chains settle correctly')
{
  // A -> B -> C -> sold. Basis must survive two direct rotations.
  const L = 1e9
  const POOL = 'PoOLxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
  const W = DEFAULTS.wallet
  let ts = DEFAULTS.startTs
  const tx = (sig, native, tokens) => ({
    timestamp: (ts += 1800), signature: sig, feePayer: W, fee: 100000,
    nativeTransfers: native, tokenTransfers: tokens,
  })
  const txs = [
    tx('m-buy', [{ fromUserAccount: W, toUserAccount: POOL, amount: Math.round(3 * L) }],
      [{ fromUserAccount: POOL, toUserAccount: W, mint: 'MA', tokenAmount: 1000 }]),
    tx('m-r1', [], [
      { fromUserAccount: W, toUserAccount: POOL, mint: 'MA', tokenAmount: 1000 },
      { fromUserAccount: POOL, toUserAccount: W, mint: 'MB', tokenAmount: 500 },
    ]),
    tx('m-r2', [], [
      { fromUserAccount: W, toUserAccount: POOL, mint: 'MB', tokenAmount: 500 },
      { fromUserAccount: POOL, toUserAccount: W, mint: 'MC', tokenAmount: 250 },
    ]),
    tx('m-sell', [{ fromUserAccount: POOL, toUserAccount: W, amount: Math.round(7.5 * L) }],
      [{ fromUserAccount: W, toUserAccount: POOL, mint: 'MC', tokenAmount: 250 }]),
  ].sort((a, b) => b.timestamp - a.timestamp)

  const r = run(txs)
  ok(r.scorecard.closedTrades === 1, 'one closed trade after two rollovers', String(r.scorecard.closedTrades))
  near(r.scorecard.netPnlSol, 4.5, 1e-9, 'basis survives two hops: 7.5 out - 3.0 in = 4.50')
  near(r.trades[0].cost, 3, 1e-9, 'cost is the original 3.0 SOL')
  ok(r.sample.rotations.basisRolled === 2, 'two rollovers counted', String(r.sample.rotations.basisRolled))
  ok(r.openBags.count === 0, 'no phantom bags across the chain')
}

section('F. Partial rotations and leftovers')
{
  const L = 1e9
  const POOL = 'PoOLxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
  const W = DEFAULTS.wallet
  let ts = DEFAULTS.startTs
  const tx = (sig, native, tokens) => ({
    timestamp: (ts += 1800), signature: sig, feePayer: W, fee: 100000,
    nativeTransfers: native, tokenTransfers: tokens,
  })
  // Buy 1000 A for 4 SOL, rotate only half of it directly, sell the rest for SOL.
  const txs = [
    tx('p-buy', [{ fromUserAccount: W, toUserAccount: POOL, amount: Math.round(4 * L) }],
      [{ fromUserAccount: POOL, toUserAccount: W, mint: 'PA', tokenAmount: 1000 }]),
    tx('p-rot', [], [
      { fromUserAccount: W, toUserAccount: POOL, mint: 'PA', tokenAmount: 500 },
      { fromUserAccount: POOL, toUserAccount: W, mint: 'PB', tokenAmount: 300 },
    ]),
    tx('p-sellA', [{ fromUserAccount: POOL, toUserAccount: W, amount: Math.round(1.5 * L) }],
      [{ fromUserAccount: W, toUserAccount: POOL, mint: 'PA', tokenAmount: 500 }]),
    tx('p-sellB', [{ fromUserAccount: POOL, toUserAccount: W, amount: Math.round(3.5 * L) }],
      [{ fromUserAccount: W, toUserAccount: POOL, mint: 'PB', tokenAmount: 300 }]),
  ].sort((a, b) => b.timestamp - a.timestamp)

  const r = run(txs)
  ok(r.scorecard.closedTrades === 2, 'two closed trades: the A remainder and the rolled B')
  near(r.scorecard.netPnlSol, 1.5 + 3.5 - 4, 1e-9, 'total nets 1.00 SOL across the split')
  const byMint = Object.fromEntries(r.trades.map((t) => [t.mint, t]))
  near(byMint.PA.cost, 2, 1e-9, 'half the basis stayed with A (2.0 SOL)')
  near(byMint.PB.cost, 2, 1e-9, 'half the basis rolled into B (2.0 SOL)')
  ok(r.openBags.count === 0, 'nothing left open')
}

section('G. Nothing is invented when the sold side has no basis')
{
  const rot = run(makeRotationWallet())
  ok(rot.scorecard.closedTrades === 0, 'rotations with no prior basis produce no closed trades')
  ok(rot.sample.rotations.total === 6, 'all six rotations counted', String(rot.sample.rotations.total))
  ok(rot.sample.rotations.noBasis === 6, 'all six reported as having no basis', String(rot.sample.rotations.noBasis))
  ok(rot.sample.rotations.valued === 0, 'none valued')
  ok(rot.scorecard.netPnlSol === null, 'no PnL claimed')

  // A routed rotation with no basis for the sold side still opens the bought side,
  // so the eventual sale is not orphaned as well.
  const L = 1e9
  const POOL = 'PoOLxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
  const W = DEFAULTS.wallet
  const WSOL = 'So11111111111111111111111111111111111111112'
  let ts = DEFAULTS.startTs
  const txs = [
    { timestamp: (ts += 60), signature: 'nb-rot', feePayer: W, fee: 100000, nativeTransfers: [],
      tokenTransfers: [
        { fromUserAccount: W, toUserAccount: POOL, mint: 'ORPHAN', tokenAmount: 900 },
        { fromUserAccount: POOL, toUserAccount: W, mint: 'NEWB', tokenAmount: 400 },
        { fromUserAccount: POOL, toUserAccount: W, mint: WSOL, tokenAmount: 2 },
        { fromUserAccount: W, toUserAccount: POOL, mint: WSOL, tokenAmount: 2 },
      ] },
    { timestamp: (ts += 3600), signature: 'nb-sell', feePayer: W, fee: 100000,
      nativeTransfers: [{ fromUserAccount: POOL, toUserAccount: W, amount: Math.round(3 * L) }],
      tokenTransfers: [{ fromUserAccount: W, toUserAccount: POOL, mint: 'NEWB', tokenAmount: 400 }] },
  ].sort((a, b) => b.timestamp - a.timestamp)

  const r = run(txs)
  ok(r.sample.rotations.noBasis === 1, 'sold side reported as having no basis')
  ok(r.scorecard.closedTrades === 1, 'the bought side is still tracked and its sale closes')
  near(r.trades[0].cost, 2, 1e-9, "bought side basis is the SOL the router actually spent")
  near(r.scorecard.netPnlSol, 1, 1e-9, 'PnL measured only over the part we can account for')
}

section('H. Accounting identities survive rotations')
{
  const cases = [
    makeRotationChain({ routed: true, buySol: 1, rotateSol: 1.6, sellSol: 2.4, tag: 'h1' }).txs,
    makeRotationChain({ routed: false, buySol: 2, sellSol: 0.7, tag: 'h2' }).txs,
    makeRotationChain({ routed: true, buySol: 3, rotateSol: 1, sellSol: 0.2, tag: 'h3' }).txs,
  ]
  for (const [i, txs] of cases.entries()) {
    const r = run(txs)
    const sc = r.scorecard
    const sumTrades = r.trades.reduce((s, t) => s + t.pnl, 0)
    near(sumTrades, sc.netPnlSol, 1e-9, `case ${i}: sum of trade PnL == net PnL`)
    near(sc.grossWinSol - sc.grossLossSol, sc.netPnlSol, 1e-9, `case ${i}: gross win - gross loss == net`)
    near(sc.selectionPnlSol, sc.netPnlSol + sc.tollSol, 1e-9, `case ${i}: selection == net + toll`)
    ok(sc.equity.length === sc.closedTrades, `case ${i}: equity length == trade count`)
    if (sc.closedTrades) {
      near(sc.equity[sc.equity.length - 1].cum, sc.netPnlSol, 1e-9, `case ${i}: equity ends at net PnL`)
    }
  }
}

section('I. Rotations do not disturb a SOL-only wallet')
{
  // The regression that matters: everything measured before this change must be
  // untouched for wallets that never rotate.
  for (const seed of [9601, 9602, 9603]) {
    const txs = makeWallet({ nTrades: 50, winRate: 0.4, holdWinMin: 12, holdLossMin: 200,
      interfaceFeeRate: 0.008, openBags: 2, seed }).txs
    const r = run(txs)
    ok(r.sample.rotations.total === 0, `seed ${seed}: no rotations detected in a SOL-only wallet`)
    ok(r.scorecard.closedTrades === 50, `seed ${seed}: all 50 trades still closed`, String(r.scorecard.closedTrades))
    ok(r.trades.every((t) => t.via === 'sol'), `seed ${seed}: every trade tagged via sol`)
    ok(r.limits.some((l) => /No token-to-token rotations/.test(l)), `seed ${seed}: limits say so plainly`)
  }
}

section('J. The payload discloses each rotation outcome separately')
{
  const r = run([
    ...makeRotationChain({ routed: true, tag: 'j1' }).txs,
    ...makeRotationChain({ routed: false, tag: 'j2' }).txs,
    ...makeRotationWallet(),
  ].sort((a, b) => b.timestamp - a.timestamp))
  const rr = r.sample.rotations
  ok(rr.total === 8, 'eight rotations in total', String(rr.total))
  ok(rr.valued === 1, 'one valued', String(rr.valued))
  ok(rr.basisRolled === 1, 'one basis rollover', String(rr.basisRolled))
  ok(rr.noBasis === 6, 'six with no basis', String(rr.noBasis))
  ok(rr.valued + rr.basisRolled + rr.ambiguous + rr.multiLeg + rr.noBasis === rr.total,
    'the outcomes account for every rotation', JSON.stringify(rr))
  ok(rr.closedFromRotations === 1, 'one closed trade came from a rotation', String(rr.closedFromRotations))
  const line = r.limits.find((l) => /rotation/.test(l))
  ok(/1 valued/.test(line) && /1 carried their cost basis/.test(line),
    'the limits sentence reports the split', line)
}

console.log(`\n${'='.repeat(64)}`)
console.log(`\x1b[1mROTATION VALIDATION\x1b[0m  ${pass} passed, ${fail} failed`)
if (fail) { console.log('\n\x1b[31mFailures:\x1b[0m'); failures.forEach((x) => console.log(`  - ${x}`)) }
console.log('='.repeat(64))
process.exit(fail ? 1 : 0)
