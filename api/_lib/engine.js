// Polaxory behavioral engine v1.
//
// Design rules, in order of priority:
//   1. Never state a number without its uncertainty or its sample size.
//   2. Never state a behavioral verdict the sample cannot support.
//   3. Separate what the market did to the wallet (selection) from what the
//      house took (toll). A trader cannot fix what they cannot attribute.
//   4. Report strengths with the same prominence as leaks.
//   5. Every claim must be auditable: expose the trade ledger that produced it.
//
// Pipeline: classify -> FIFO ledger -> scorecard -> behavior -> counterfactuals
//           -> archetype mixture -> strengths/leaks -> exploitability

import {
  mean, median, std, variance, quantile, wilson, bootstrapCI, betaShrink, meanShrink,
  softmax, percentileAgainst, maxDrawdown, clamp01, hashSeed,
} from './stats.js'
import {
  WIN_RATE_PRIOR, EXPECTANCY_PRIOR, LADDERS, REFERENCE_VERSION, confidenceFor,
} from './reference.js'
import { valueBags, combinePosition } from './valuation.js'

const WSOL = 'So11111111111111111111111111111111111111112'
const DUST_SOL = 0.001
const LAMPORTS = 1e9
const PANIC_WINDOW_MIN = 10
const REVENGE_WINDOW_MIN = 60

// ============================================================ 1. CLASSIFY

function solLegs(tx, wallet) {
  const inflows = []
  const outflows = []
  for (const t of tx.nativeTransfers || []) {
    const amt = t.amount / LAMPORTS
    if (amt <= 0) continue
    if (t.toUserAccount === wallet) inflows.push({ amt, counter: t.fromUserAccount })
    else if (t.fromUserAccount === wallet) outflows.push({ amt, counter: t.toUserAccount })
  }
  for (const t of tx.tokenTransfers || []) {
    if (t.mint !== WSOL) continue
    const amt = t.tokenAmount
    if (!amt || amt <= 0) continue
    if (t.toUserAccount === wallet) inflows.push({ amt, counter: t.fromUserAccount })
    else if (t.fromUserAccount === wallet) outflows.push({ amt, counter: t.toUserAccount })
  }
  return { inflows, outflows }
}

function tokenDeltas(tx, wallet) {
  const d = new Map()
  for (const t of tx.tokenTransfers || []) {
    if (!t.mint || t.mint === WSOL) continue
    const amt = t.tokenAmount
    if (!amt) continue
    let cur = d.get(t.mint) || 0
    if (t.toUserAccount === wallet) cur += amt
    else if (t.fromUserAccount === wallet) cur -= amt
    d.set(t.mint, cur)
  }
  for (const [k, v] of d) if (Math.abs(v) < 1e-12) d.delete(k)
  return d
}

// Toll = what left the wallet without buying exposure: network fee plus
// side-transfers that are small relative to the main swap leg (interface fees,
// Jito tips, referral cuts). This is a VISIBLE-toll lower bound: a fee routed
// pool -> fee-wallet never touches this wallet and cannot be seen here. Net PnL
// is unaffected either way; only the attribution is incomplete.
function tollOf(tx, wallet, legs) {
  const networkFee = tx.feePayer === wallet && tx.fee ? tx.fee / LAMPORTS : 0
  const all = [...legs.outflows].sort((a, b) => b.amt - a.amt)
  if (all.length <= 1) return { networkFee, aux: 0 }
  const mainLeg = all[0].amt
  let aux = 0
  for (let i = 1; i < all.length; i++) {
    if (all[i].amt <= mainLeg * 0.2) aux += all[i].amt
  }
  return { networkFee, aux }
}

export function classify(tx, wallet) {
  if (!tx || !tx.timestamp) return null
  const legs = solLegs(tx, wallet)
  const inSol = legs.inflows.reduce((s, x) => s + x.amt, 0)
  const outSol = legs.outflows.reduce((s, x) => s + x.amt, 0)
  const netSol = inSol - outSol
  const toks = tokenDeltas(tx, wallet)
  const gained = [...toks].filter(([, v]) => v > 0)
  const lost = [...toks].filter(([, v]) => v < 0)
  const toll = tollOf(tx, wallet, legs)

  if (netSol < -DUST_SOL && gained.length === 1 && lost.length === 0) {
    return { kind: 'buy', mint: gained[0][0], qty: gained[0][1], sol: -netSol, ts: tx.timestamp, toll, sig: tx.signature }
  }
  if (netSol > DUST_SOL && lost.length === 1 && gained.length === 0) {
    return { kind: 'sell', mint: lost[0][0], qty: -lost[0][1], sol: netSol, ts: tx.timestamp, toll, sig: tx.signature }
  }
  if (gained.length >= 1 && lost.length >= 1) {
    // A rotation carries its own historical valuation, which is why it no longer
    // has to be skipped. A router that goes A -> SOL -> B credits and then debits
    // the wallet's WSOL account inside the same transaction, so the GROSS legs are
    // both present even though the net delta is ~zero. Those gross amounts are what
    // the trade was worth at the moment it happened — exact, from the chain, and
    // not something a current-price lookup could ever tell us.
    return {
      kind: 'rotation',
      ts: tx.timestamp,
      toll,
      sig: tx.signature,
      soldMint: lost.length === 1 ? lost[0][0] : null,
      soldQty: lost.length === 1 ? -lost[0][1] : null,
      boughtMint: gained.length === 1 ? gained[0][0] : null,
      boughtQty: gained.length === 1 ? gained[0][1] : null,
      grossSolIn: inSol,
      grossSolOut: outSol,
      multi: gained.length > 1 || lost.length > 1,
    }
  }
  return null
}

// ============================================================ 2. LEDGER

// FIFO consumption, shared by the sell path and the rotation path so the two can
// never disagree about how a position is unwound.
function consumeFifo(arr, qtyWanted, atTs) {
  let remaining = qtyWanted
  let costConsumed = 0
  let qtyConsumed = 0
  let weightedAge = 0
  const entryTs = arr.length ? arr[0].ts : null
  while (remaining > 1e-12 && arr.length > 0) {
    const lot = arr[0]
    const take = Math.min(lot.qty, remaining)
    const costShare = lot.qty > 0 ? lot.cost * (take / lot.qty) : 0
    costConsumed += costShare
    qtyConsumed += take
    weightedAge += take * (atTs - lot.ts)
    lot.qty -= take
    lot.cost -= costShare
    remaining -= take
    if (lot.qty <= 1e-12) arr.shift()
  }
  return {
    costConsumed,
    qtyConsumed,
    entryTs,
    holdMin: qtyConsumed > 0 ? weightedAge / qtyConsumed / 60 : null,
    shortfall: remaining > 1e-9,
  }
}

export function buildLedger(events) {
  const lots = new Map() // mint -> [{qty, cost, ts, rolledFrom?}]
  const closed = []
  const buys = []
  // Rotation outcomes, counted separately because they are three different claims.
  const rot = { total: 0, valued: 0, rolled: 0, ambiguous: 0, multiLeg: 0, unmatched: 0 }
  let unmatchedSells = 0
  let tollTotal = 0
  let networkTotal = 0
  let openBasis = 0
  let peakCapital = 0

  const addLot = (mint, lot) => {
    const arr = lots.get(mint) || []
    arr.push(lot)
    lots.set(mint, arr)
  }

  for (const ev of events) {
    tollTotal += (ev.toll?.aux || 0) + (ev.toll?.networkFee || 0)
    networkTotal += ev.toll?.networkFee || 0

    // ---------------------------------------------------------- rotation
    if (ev.kind === 'rotation') {
      rot.total++

      // More than one token in or out: the sold basis cannot be attributed to a
      // particular acquisition, so nothing is claimed.
      if (ev.multi || !ev.soldMint || !ev.boughtMint || !(ev.soldQty > 0) || !(ev.boughtQty > 0)) {
        rot.multiLeg++
        continue
      }

      const arr = lots.get(ev.soldMint)
      const DUST = DUST_SOL
      // Both gross legs present -> the router passed through SOL and told us what
      // each side was worth AT THE TIME. Exactly one leg, or neither, means the
      // amount cannot be attributed and no PnL is claimed.
      const solPivoted = ev.grossSolIn > DUST && ev.grossSolOut > DUST

      if (!arr || arr.length === 0) {
        // Sold side has no basis in the window. The bought side can still be opened
        // when we know what was actually paid, so the eventual sale of it is not
        // orphaned too.
        if (solPivoted) {
          addLot(ev.boughtMint, { qty: ev.boughtQty, cost: ev.grossSolOut, ts: ev.ts })
          openBasis += ev.grossSolOut
          if (openBasis > peakCapital) peakCapital = openBasis
        }
        rot.unmatched++
        continue
      }

      const c = consumeFifo(arr, ev.soldQty, ev.ts)
      if (c.qtyConsumed <= 1e-12 || c.costConsumed <= 0) { rot.unmatched++; continue }
      const trackedShare = Math.min(1, c.qtyConsumed / ev.soldQty)
      openBasis = Math.max(0, openBasis - c.costConsumed)

      if (solPivoted) {
        // A genuine realized trade: the sold side closes at the SOL the router
        // actually returned, and the bought side opens at the SOL it actually cost.
        // Both figures are observed, not modelled.
        const proceeds = ev.grossSolIn * trackedShare
        closed.push({
          mint: ev.soldMint,
          pnl: proceeds - c.costConsumed,
          cost: c.costConsumed,
          proceeds,
          ret: proceeds / c.costConsumed - 1,
          holdMin: c.holdMin,
          entryTs: c.entryTs,
          exitTs: ev.ts,
          partial: c.shortfall,
          via: 'rotation',
        })
        addLot(ev.boughtMint, { qty: ev.boughtQty, cost: ev.grossSolOut, ts: ev.ts })
        openBasis += ev.grossSolOut
        if (openBasis > peakCapital) peakCapital = openBasis
        rot.valued++
      } else {
        // Direct token-to-token with no SOL leg: nothing was realized in SOL, so
        // claiming a PnL would be inventing one. The basis rolls into the new
        // position instead, which is what makes the eventual sale correct — the
        // whole chain from the original purchase settles at once. Previously both
        // sides were lost: the sold lot lingered as a phantom bag and the bought
        // token had no basis, so selling it counted as an unmatched sell.
        addLot(ev.boughtMint, {
          qty: ev.boughtQty,
          cost: c.costConsumed,
          ts: ev.ts,
          rolledFrom: ev.soldMint,
        })
        openBasis += c.costConsumed
        if (openBasis > peakCapital) peakCapital = openBasis
        if (ev.grossSolIn > DUST || ev.grossSolOut > DUST) rot.ambiguous++
        else rot.rolled++
      }
      continue
    }

    // ---------------------------------------------------------- buy
    if (ev.kind === 'buy') {
      addLot(ev.mint, { qty: ev.qty, cost: ev.sol, ts: ev.ts })
      buys.push({ ts: ev.ts, sol: ev.sol, mint: ev.mint })
      openBasis += ev.sol
      if (openBasis > peakCapital) peakCapital = openBasis
      continue
    }

    // ---------------------------------------------------------- sell
    const arr = lots.get(ev.mint)
    if (!arr || arr.length === 0) { unmatchedSells++; continue }
    const c = consumeFifo(arr, ev.qty, ev.ts)
    if (c.qtyConsumed <= 1e-12 || c.costConsumed <= 0) { unmatchedSells++; continue }
    const trackedShare = Math.min(1, c.qtyConsumed / ev.qty)
    const proceeds = ev.sol * trackedShare
    openBasis = Math.max(0, openBasis - c.costConsumed)
    closed.push({
      mint: ev.mint,
      pnl: proceeds - c.costConsumed,
      cost: c.costConsumed,
      proceeds,
      ret: proceeds / c.costConsumed - 1,
      holdMin: c.holdMin,
      entryTs: c.entryTs,
      exitTs: ev.ts,
      partial: c.shortfall,
      via: 'sol',
    })
  }

  const bags = []
  for (const [mint, arr] of lots) {
    const cost = arr.reduce((s, l) => s + l.cost, 0)
    const qty = arr.reduce((s, l) => s + l.qty, 0)
    if (cost > 0.005) {
      bags.push({
        mint, costSol: cost, qty,
        firstTs: arr.length ? arr[0].ts : null,
        rolledFrom: arr.find((l) => l.rolledFrom)?.rolledFrom || null,
      })
    }
  }
  bags.sort((a, b) => b.costSol - a.costSol)
  closed.sort((a, b) => a.exitTs - b.exitTs)

  return {
    closed, bags, buys,
    rotations: rot.total,
    rotationDetail: rot,
    unmatchedSells, tollTotal, networkTotal, peakCapital,
  }
}

// ============================================================ 3. SCORECARD

const pf = (trades) => {
  const w = trades.filter((t) => t.pnl > 0).reduce((s, t) => s + t.pnl, 0)
  const l = Math.abs(trades.filter((t) => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0))
  if (l === 0) return w > 0 ? 10 : null // cap for bootstrap stability; displayed as ">10"
  return w / l
}
const expectancyOf = (trades) => {
  const c = trades.reduce((s, t) => s + t.cost, 0)
  if (c <= 0) return null
  return trades.reduce((s, t) => s + t.pnl, 0) / c
}
const totalPnlOf = (trades) => trades.reduce((s, t) => s + t.pnl, 0)
const winRateOf = (trades) => (trades.length ? trades.filter((t) => t.pnl > 0).length / trades.length : null)

export function buildScorecard(ledger, seed) {
  const { closed, buys, tollTotal, networkTotal, peakCapital } = ledger
  const n = closed.length
  const wins = closed.filter((t) => t.pnl > 0)
  const losses = closed.filter((t) => t.pnl <= 0)
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0)
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0))
  const netPnl = grossWin - grossLoss
  const turnover = buys.reduce((s, b) => s + b.sol, 0)
  const basis = closed.reduce((s, t) => s + t.cost, 0)

  const boot = (fn) => bootstrapCI(closed, fn, { seed, B: 2000 })

  // equity curve on realized exits
  const equity = []
  let cum = 0
  for (const t of closed) {
    cum += t.pnl
    equity.push({ ts: t.exitTs, cum })
  }
  const dd = maxDrawdown(equity.map((e) => e.cum))

  // per-trade return stats -> a trade-level Sharpe. Labeled honestly: this is
  // per-trade, not annualized by calendar time, because memecoin holding periods
  // are wildly uneven and annualizing them would be fiction.
  const rets = closed.map((t) => t.ret)
  const retMean = mean(rets)
  const retSd = std(rets)
  const tradeSharpe = retSd && retSd > 0 ? retMean / retSd : null

  const spanSec = n ? closed[n - 1].exitTs - Math.min(...buys.map((b) => b.ts), closed[0].entryTs) : 0
  const spanDays = spanSec > 0 ? spanSec / 86400 : null

  const sortedByPnl = [...closed].sort((a, b) => b.pnl - a.pnl)
  const top3 = sortedByPnl.slice(0, 3).reduce((s, t) => s + Math.max(0, t.pnl), 0)

  const wrRaw = wilson(wins.length, n)
  const wrShrunk = n ? betaShrink(wins.length, n, WIN_RATE_PRIOR.mean, WIN_RATE_PRIOR.strength) : null
  const expRaw = expectancyOf(closed)
  const perSolPnl = closed.map((t) => t.pnl / t.cost)
  const expShrunk =
    n && expRaw !== null
      ? meanShrink(expRaw, variance(perSolPnl), n, EXPECTANCY_PRIOR.mean, EXPECTANCY_PRIOR.betweenVar)
      : null

  return {
    closedTrades: n,
    tokensTraded: new Set(closed.map((t) => t.mint)).size,
    winsLosses: [wins.length, losses.length],

    netPnlSol: n ? netPnl : null,
    netPnlCI: boot(totalPnlOf),
    grossWinSol: grossWin,
    grossLossSol: grossLoss,

    // attribution: the toll is money that never had a chance to be right
    tollSol: tollTotal,
    networkFeeSol: networkTotal,
    interfaceTollSol: Math.max(0, tollTotal - networkTotal),
    tollRate: turnover > 0 ? tollTotal / turnover : null,
    selectionPnlSol: n ? netPnl + tollTotal : null, // PnL if the toll had been zero

    turnoverSol: turnover,
    basisSol: basis,
    peakCapitalSol: peakCapital,
    returnOnCapital: peakCapital > 0 && n ? netPnl / peakCapital : null,

    winRate: wrRaw,
    winRateShrunk: wrShrunk,
    profitFactor: boot(pf),
    expectancy: { point: expRaw, ...(boot(expectancyOf) || {}) },
    expectancyShrunk: expShrunk,
    avgWinSol: mean(wins.map((t) => t.pnl)),
    avgLossSol: mean(losses.map((t) => Math.abs(t.pnl))),
    payoffRatio:
      wins.length && losses.length
        ? mean(wins.map((t) => t.pnl)) / mean(losses.map((t) => Math.abs(t.pnl)))
        : null,
    tradeSharpe,
    maxDrawdownSol: dd.abs,
    top3ShareOfGrossWin: grossWin > 0 ? top3 / grossWin : null,
    medianTradeRet: median(rets),
    bestTradeSol: n ? sortedByPnl[0].pnl : null,
    worstTradeSol: n ? sortedByPnl[n - 1].pnl : null,

    tradesPerDay: spanDays && spanDays > 0 ? n / spanDays : null,
    spanDays,
    equity,
  }
}

// ============================================================ 4. BEHAVIOR

function verdictFrom(pctWorst, labels) {
  if (pctWorst === null) return null
  if (pctWorst >= 0.85) return ['critical', labels[3]]
  if (pctWorst >= 0.6) return ['serious', labels[2]]
  if (pctWorst >= 0.35) return ['warning', labels[1]]
  return ['good', labels[0]]
}

// `ladders` is injected rather than imported so the reference distribution can be
// a measured cohort without this file ever learning that a database exists. The
// priors are the default, which keeps the engine runnable standalone in tests.
export function buildBehavior(ledger, scorecard, seed, ladders = LADDERS) {
  const { closed, buys, bags } = ledger
  const wins = closed.filter((t) => t.pnl > 0)
  const losses = closed.filter((t) => t.pnl <= 0)
  const buysAsc = [...buys].sort((a, b) => a.ts - b.ts)

  const holdWin = wins.map((t) => t.holdMin)
  const holdLoss = losses.map((t) => t.holdMin)
  const mHoldWin = median(holdWin)
  const mHoldLoss = median(holdLoss)
  const disposition = mHoldWin && mHoldWin > 0 && mHoldLoss !== null ? mHoldLoss / mHoldWin : null
  const dispositionCI =
    wins.length >= 3 && losses.length >= 3
      ? bootstrapCI(
          closed,
          (sample) => {
            const w = sample.filter((t) => t.pnl > 0).map((t) => t.holdMin)
            const l = sample.filter((t) => t.pnl <= 0).map((t) => t.holdMin)
            if (w.length < 2 || l.length < 2) return null
            const mw = median(w)
            return mw > 0 ? median(l) / mw : null
          },
          { seed: seed + 7, B: 1200 },
        )
      : null

  const panicK = losses.filter((t) => t.holdMin < PANIC_WINDOW_MIN).length
  const panic = losses.length ? wilson(panicK, losses.length) : null

  const gapAfter = (exitTs) => {
    const nb = buysAsc.find((b) => b.ts > exitTs)
    return nb ? (nb.ts - exitTs) / 60 : null
  }
  const gapsLoss = losses.map((t) => gapAfter(t.exitTs)).filter((g) => g !== null)
  const gapsWin = wins.map((t) => gapAfter(t.exitTs)).filter((g) => g !== null)
  const mGapLoss = median(gapsLoss)
  const mGapWin = median(gapsWin)
  const revengeRatio =
    mGapLoss !== null && mGapWin !== null && mGapLoss > 0 ? mGapWin / mGapLoss : null

  const buySizes = buys.map((b) => b.sol)
  const avgBuy = mean(buySizes)
  const sizingCV = avgBuy > 0 && buys.length > 2 ? std(buySizes) / avgBuy : null

  // Size escalation: post-loss buys vs buys that did NOT follow a loss.
  // The baseline must exclude the post-loss buys themselves — comparing them to
  // an average that contains them dilutes the effect toward 1 in proportion to
  // how often the wallet loses, which is exactly the wallets we care about.
  const lossExitTs = losses.map((t) => t.exitTs).sort((a, b) => a - b)
  const followsLoss = (ts) =>
    lossExitTs.some((et) => ts > et && ts - et < REVENGE_WINDOW_MIN * 60)
  const postLoss = []
  const baseline = []
  for (const b of buysAsc) (followsLoss(b.ts) ? postLoss : baseline).push(b.sol)
  const escalation =
    postLoss.length >= 3 && baseline.length >= 3 && mean(baseline) > 0
      ? mean(postLoss) / mean(baseline)
      : null

  // improvement: first half vs second half expectancy
  let trend = null
  if (closed.length >= 16) {
    const mid = Math.floor(closed.length / 2)
    const a = expectancyOf(closed.slice(0, mid))
    const b = expectancyOf(closed.slice(mid))
    if (a !== null && b !== null) trend = { first: a, second: b, delta: b - a }
  }

  const L = ladders || LADDERS
  const pct = {
    disposition: percentileAgainst(disposition, L.dispositionRatio, { higherIsWorse: true }),
    panic: percentileAgainst(panic?.point ?? null, L.panicIndex, { higherIsWorse: true }),
    revenge: percentileAgainst(revengeRatio, L.revengeRatio, { higherIsWorse: true }),
    sizing: percentileAgainst(sizingCV, L.sizingCV, { higherIsWorse: true }),
    expectancy: percentileAgainst(scorecard.expectancy?.point ?? null, L.expectancy, { higherIsWorse: false }),
    profitFactor: percentileAgainst(scorecard.profitFactor?.point ?? null, L.profitFactor, { higherIsWorse: false }),
    tollRate: percentileAgainst(scorecard.tollRate, L.tollRate, { higherIsWorse: true }),
  }

  return {
    medianHoldWinMin: mHoldWin,
    medianHoldLossMin: mHoldLoss,
    disposition: { point: disposition, ci: dispositionCI, pctWorst: pct.disposition, nWin: wins.length, nLoss: losses.length,
      verdict: verdictFrom(pct.disposition, ['balanced exits', 'slight lean to losers', 'marrying losers', 'chronic bagholding']) },
    panic: { ...(panic || {}), pctWorst: pct.panic,
      verdict: verdictFrom(pct.panic, ['composed exits', 'occasional flinch', 'frequent panic exits', 'reflex selling']) },
    revenge: { point: revengeRatio, medGapAfterLossMin: mGapLoss, medGapAfterWinMin: mGapWin,
      nLoss: gapsLoss.length, nWin: gapsWin.length, pctWorst: pct.revenge,
      verdict: verdictFrom(pct.revenge, ['no tilt signal', 'mild urgency after losses', 'tilt pattern', 'severe tilt']) },
    sizing: { cv: sizingCV, escalation, nPostLoss: postLoss.length, nBaseline: baseline.length,
      medianBuySol: median(buySizes), nBuys: buys.length, pctWorst: pct.sizing,
      verdict: verdictFrom(pct.sizing, ['consistent sizing', 'mostly consistent', 'erratic sizing', 'no size discipline']) },
    toll: { rate: scorecard.tollRate, pctWorst: pct.tollRate,
      verdict: verdictFrom(pct.tollRate, ['lean execution', 'normal toll', 'heavy toll', 'bleeding on fees']) },
    bags: { count: bags.length, costSol: bags.reduce((s, b) => s + b.costSol, 0) },
    trend,
    percentiles: pct,
  }
}

// ============================================================ 5. COUNTERFACTUALS

// Each counterfactual answers "what would this behavior pattern have cost or paid
// if it had been different", computed on the actual ledger. `hindsight: true`
// marks the ones that use outcome knowledge and therefore overstate what was
// achievable in real time.
export function buildCounterfactuals(ledger, scorecard, behavior) {
  const { closed, buys } = ledger
  const out = []
  const n = closed.length
  if (!n) return out

  // 1. Zero toll — exact, no hindsight.
  if (ledger.tollTotal > 0) {
    out.push({
      key: 'no_toll',
      label: 'If the house took nothing',
      deltaSol: ledger.tollTotal,
      note: `Visible toll paid across ${buys.length + n} legs: ${ledger.networkFeeSol > 0 ? '' : ''}network fees plus interface/tip outflows. Lower bound — fees routed pool-to-interface never touch your wallet and cannot be counted.`,
      hindsight: false,
    })
  }

  // 2. Revenge trades removed — entries inside the tilt window after a loss.
  const losses = closed.filter((t) => t.pnl <= 0)
  const lossExits = losses.map((t) => t.exitTs).sort((a, b) => a - b)
  const isRevenge = (entryTs) =>
    lossExits.some((et) => entryTs > et && entryTs - et < REVENGE_WINDOW_MIN * 60)
  const revengeTrades = closed.filter((t) => isRevenge(t.entryTs))
  if (revengeTrades.length >= 2) {
    const revPnl = revengeTrades.reduce((s, t) => s + t.pnl, 0)
    out.push({
      key: 'no_revenge',
      label: `If you'd waited an hour after each loss`,
      deltaSol: -revPnl,
      note: `${revengeTrades.length} of ${n} trades were entered within ${REVENGE_WINDOW_MIN} minutes of closing a loser. Together they ${revPnl >= 0 ? 'made' : 'lost'} ${Math.abs(revPnl).toFixed(2)} SOL.`,
      hindsight: false,
      count: revengeTrades.length,
    })
  }

  // 3. Flat sizing — every position at the median size.
  // SIGN CONVENTION, uniform across every counterfactual in this list: deltaSol is
  // what the ALTERNATIVE behavior would have paid you, so positive always means
  // your actual behavior cost you that much. An earlier note inverted this in
  // prose while the arithmetic was right, which is worse than a wrong number.
  const medBuy = median(buys.map((b) => b.sol))
  if (medBuy > 0 && n >= 5) {
    let flat = 0
    for (const t of closed) flat += t.cost > 0 ? t.pnl * (medBuy / t.cost) : 0
    const delta = flat - scorecard.netPnlSol
    out.push({
      key: 'flat_size',
      label: 'If every position were the same size',
      deltaSol: delta,
      note:
        delta > 0
          ? `Sizing every trade at ${medBuy.toFixed(2)} SOL would have returned ${delta.toFixed(2)} SOL more than you actually made. Your conviction sizing worked against you: the bigger bets were the worse ones.`
          : `Sizing every trade at ${medBuy.toFixed(2)} SOL would have returned ${Math.abs(delta).toFixed(2)} SOL less. Your conviction sizing earned its keep — you put more behind the trades that worked.`,
      hindsight: false,
    })
  }

  // 4. Symmetric patience — losers held past the time winners are given.
  // Bounded deliberately: the counterfactual price path is unknowable from the
  // ledger, so no PnL is claimed. The unit is SOL-days (capital x time), which is
  // the honest measure of tied-up capital. Reporting a bare SOL sum here would
  // read as "152 SOL sat frozen" when the true peak concurrent exposure was a
  // fraction of that.
  if (behavior.disposition?.point > 1.5 && behavior.medianHoldWinMin) {
    const winHold = behavior.medianHoldWinMin
    let solDays = 0
    let nOverheld = 0
    for (const t of losses) {
      const excess = Math.max(0, t.holdMin - winHold)
      if (excess > 0) { nOverheld++; solDays += t.cost * (excess / 1440) }
    }
    out.push({
      key: 'symmetric_patience',
      label: 'Capital tied up in losers past your winner-hold time',
      deltaSol: null,
      exposure: { solDays, count: nOverheld },
      note: `You give winners a median ${winHold.toFixed(0)} min. ${nOverheld} losing positions were held beyond that, costing ${solDays.toFixed(1)} SOL-days of tied-up capital (position size multiplied by the extra time held, summed). Not a loss and not a peak exposure — it is capital that could not be redeployed. No PnL claim: the counterfactual price path is unknowable from your ledger alone.`,
      hindsight: false,
    })
  }

  // 5. Concentration — how much of the gross win came from the top 3.
  if (scorecard.top3ShareOfGrossWin !== null && n >= 8) {
    out.push({
      key: 'concentration',
      label: 'Share of all profit from your best 3 trades',
      pct: scorecard.top3ShareOfGrossWin,
      deltaSol: null,
      note:
        scorecard.top3ShareOfGrossWin > 0.8
          ? `${Math.round(scorecard.top3ShareOfGrossWin * 100)}% of your gross profit came from 3 trades. Strip them and the rest of the book is the real signal.`
          : `${Math.round(scorecard.top3ShareOfGrossWin * 100)}% of gross profit from your best 3 — reasonably distributed rather than one lucky hit carrying the book.`,
      hindsight: true,
    })
  }

  return out
}

// ============================================================ 6. ARCHETYPES

// Soft mixture. Each archetype scores evidence terms in [0,1]; a softmax over the
// weighted sums yields probabilities. No hard thresholds, no single winner-takes-all.
const ARCHETYPES = [
  {
    key: 'exit_liquidity', name: 'Prime Exit Liquidity',
    tagline: 'The machine has a folder on you.',
    desc: 'High turnover, low hit rate, negative expectancy. This is the flow other systems are built to harvest.',
    ev: (s, b) => [
      [neg(s.expectancy?.point, 0.35), 1.4],
      [lowRate(s.winRate?.point, 0.42), 1.0],
      [hi(s.tradesPerDay, 6), 0.7],
    ],
  },
  {
    key: 'bagholder', name: 'The Bagholder',
    tagline: 'You call it conviction. The ledger calls it denial.',
    desc: 'Winners sold fast, losers held indefinitely. The disposition effect, measured on your own exits.',
    ev: (s, b) => [
      [hi(b.disposition?.point, 6), 1.5],
      [hi(b.bags?.count, 6), 0.8],
      [neg(s.expectancy?.point, 0.3), 0.5],
    ],
  },
  {
    key: 'panic_seller', name: 'The Panic Seller',
    tagline: 'Your stop loss is your amygdala.',
    desc: 'Losers cut within minutes, usually into weakness, then re-entered soon after.',
    ev: (s, b) => [
      [hi(b.panic?.point, 0.75), 1.5],
      [lo(b.disposition?.point, 0.6), 0.9],
      [hi(b.revenge?.point, 3), 0.6],
    ],
  },
  {
    key: 'serial_rotator', name: 'The Serial Rotator',
    tagline: 'Everything for five minutes. Nothing forever.',
    desc: 'Constant motion between tokens. Each rotation pays the toll twice; motion is not edge.',
    // Churn is only a leak if it costs something. The third term requires either
    // toll drag or negative expectancy, so a profitable fast trader reads as a
    // sniper rather than a churner — an earlier version mislabelled exactly that.
    ev: (s, b) => [
      [hi(s.tradesPerDay, 12), 1.2],
      [lo(b.medianHoldWinMin, 20), 0.7],
      // Toll drag is the rotator's signature cost; a general loss is only half
      // evidence, otherwise this archetype swallows every fast-trading leaker and
      // starves the exit-liquidity read, whose signature is bad SELECTION.
      [Math.max(hi(b.toll?.rate, 0.04), 0.5 * neg(s.expectancy?.point, 0.4)), 1.0],
    ],
  },
  {
    key: 'tilted', name: 'The Tilted',
    tagline: 'Every loss is a countdown to a bigger buy.',
    desc: 'Re-enters faster after losses than after wins, and sizes up to recover. Martingale with extra steps.',
    ev: (s, b) => [
      [hi(b.revenge?.point, 5), 1.5],
      [hi(b.sizing?.escalation, 2), 1.1],
      [hi(b.sizing?.cv, 1.5), 0.5],
    ],
  },
  {
    key: 'sniper', name: 'The Sniper',
    tagline: 'In, out, paid.',
    desc: 'Fast entries and exits with positive expectancy. The question is whether it survives size.',
    ev: (s, b) => [
      [lo(b.medianHoldWinMin, 15), 0.9],
      [pos(s.expectancy?.point, 0.25), 1.6],
      [hiRate(s.winRate?.point, 0.5), 0.6],
    ],
  },
  {
    key: 'disciplined', name: 'The Disciplined One',
    tagline: 'Boring. Which is the point.',
    desc: 'Consistent sizing, symmetric exits, positive expectancy. Hard to model, harder to farm.',
    ev: (s, b) => [
      [lo(b.sizing?.cv, 0.4), 1.1],
      [pos(s.expectancy?.point, 0.25), 1.3],
      [lo(b.panic?.point, 0.2), 0.8],
      [near(b.disposition?.point, 1, 1.2), 0.6],
    ],
  },
]

// evidence helpers: map a metric to [0,1] evidence strength
const hi = (v, scale) => (v === null || v === undefined ? 0 : clamp01(v / scale))
const lo = (v, scale) => (v === null || v === undefined ? 0 : clamp01(1 - v / scale))
const pos = (v, scale) => (v === null || v === undefined ? 0 : clamp01(v / scale))
const neg = (v, scale) => (v === null || v === undefined ? 0 : clamp01(-v / scale))
const hiRate = (v, t) => (v === null || v === undefined ? 0 : clamp01((v - t) / (1 - t)))
const lowRate = (v, t) => (v === null || v === undefined ? 0 : clamp01((t - v) / t))
const near = (v, target, tol) => (v === null || v === undefined ? 0 : clamp01(1 - Math.abs(v - target) / tol))

export function buildArchetypeMixture(scorecard, behavior) {
  const raw = ARCHETYPES.map((a) => {
    const terms = a.ev(scorecard, behavior)
    const wsum = terms.reduce((s, [, w]) => s + w, 0)
    const score = terms.reduce((s, [e, w]) => s + e * w, 0) / (wsum || 1)
    return { key: a.key, name: a.name, tagline: a.tagline, desc: a.desc, score, terms }
  })
  const total = raw.reduce((s, r) => s + r.score, 0)
  // If nothing scores, the wallet is genuinely unread rather than defaulted.
  if (total < 0.25) {
    return {
      unread: true,
      primary: {
        key: 'unread', name: 'The Unread', tagline: 'Not enough signal. Yet.',
        desc: 'Too little SOL-quoted closing activity to separate one behavioral pattern from another. Illegibility is itself a defense.',
      },
      mixture: [],
    }
  }
  // Temperature is sample-size aware. The base (0.16) makes a clearly dominant
  // pattern read ~60-80%; the 12/n term flattens the distribution when there is
  // little data, so a 9-trade wallet gets a spread of possibilities rather than a
  // confident label it has not earned. Less evidence, flatter posterior.
  const n = scorecard.closedTrades || 1
  const temperature = 0.16 * (1 + 12 / n)
  const probs = softmax(raw.map((r) => r.score), temperature)
  const mixture = raw
    .map((r, i) => ({ ...r, p: probs[i] }))
    .sort((a, b) => b.p - a.p)
  return {
    unread: false,
    primary: mixture[0],
    mixture: mixture.filter((m) => m.p >= 0.04).slice(0, 4),
    temperature,
    hedged: n < 25,
  }
}

// ============================================================ 7. STRENGTHS / LEAKS

// Findings are gated on statistical support, not on a favourable point estimate.
// Rules, learned from a calibration sweep where a coin-flip wallet was awarded six
// "strengths":
//   - Rate and expectancy claims require the 95% interval to EXCLUDE the neutral
//     value, not merely for the point estimate to sit on the good side of it.
//   - Every claim carries a minimum sample, per-claim, on the specific subsample
//     it is computed from (losing exits, winning exits, post-loss buys).
//   - Contradictions are suppressed: a wallet that sizes up after losses does not
//     get told it has size discipline, whatever its baseline variance looks like.
export function buildFindings(scorecard, behavior) {
  const strengths = []
  const leaks = []
  // kind: 'outcome' = did the money work; 'process' = was the behavior sound.
  // These are separated deliberately. A wallet can have clean process and no edge
  // (the most common honest verdict) or an edge held together by nothing. Telling
  // someone which of the two they are is the whole point of a mirror.
  const S = (kind, t, d, ev) => strengths.push({ kind, title: t, detail: d, evidence: ev })
  const L = (kind, t, d, ev) => leaks.push({ kind, title: t, detail: d, evidence: ev })
  const n = scorecard.closedTrades
  const exp = scorecard.expectancy
  const pfC = scorecard.profitFactor
  const dsp = behavior.disposition
  const pan = behavior.panic
  const rev = behavior.revenge
  const siz = behavior.sizing
  const num = (x) => x !== null && x !== undefined && Number.isFinite(x)

  // A wallet that breaks its own sizing under stress does not have size discipline.
  const escalates = num(siz?.escalation) && siz.escalation > 1.35 && siz.nPostLoss >= 5 && siz.nBaseline >= 5

  // ---------- strengths (each requires its interval to clear the neutral value)
  if (n >= 20 && num(exp?.lo) && exp.lo > 0)
    S('outcome', 'Positive expectancy',
      `You make ${exp.point.toFixed(2)} SOL per SOL of basis risked, and the interval stays above zero. Most of the reference cohort is negative here.`,
      `expectancy +${exp.point.toFixed(3)}, 95% CI +${exp.lo.toFixed(3)} to +${exp.hi.toFixed(3)} over ${n} trades`)

  if (n >= 20 && num(pfC?.lo) && pfC.lo > 1)
    S('outcome', 'Wins genuinely outweigh losses',
      `Profit factor ${pfC.point.toFixed(2)} with the whole interval above 1.0 — this is not a sampling artifact.`,
      `PF 95% CI ${pfC.lo.toFixed(2)} to ${pfC.hi.toFixed(2)}, ${n} trades`)

  if (num(siz?.cv) && siz.cv < 0.5 && siz.nBuys >= 12 && !escalates)
    S('process', 'Size discipline',
      `Buy sizes barely vary (CV ${siz.cv.toFixed(2)}) and you do not break sizing after losses. Consistent sizing is what lets an edge compound instead of gambling.`,
      `${siz.nBuys} buys, CV ${siz.cv.toFixed(2)}${num(siz.escalation) ? `, post-loss sizing ${siz.escalation.toFixed(2)}x baseline` : ''}`)

  if (num(pan?.hi) && pan.hi < 0.35 && pan.n >= 10)
    S('process', 'You do not flinch',
      `At most ${Math.round(pan.hi * 100)}% of losing exits happened inside ${PANIC_WINDOW_MIN} minutes, interval included. You are not selling on reflex.`,
      `${Math.round(pan.point * 100)}% of ${pan.n} losing exits, 95% CI ${Math.round(pan.lo * 100)}-${Math.round(pan.hi * 100)}%`)

  if (num(dsp?.point) && dsp.point >= 0.7 && dsp.point <= 1.5 && dsp.nWin >= 5 && dsp.nLoss >= 5 &&
      (!dsp.ci || (dsp.ci.lo > 0.45 && dsp.ci.hi < 2.4)))
    S('process', 'Symmetric exits',
      `You hold winners and losers for comparable time (ratio ${dsp.point.toFixed(2)}). Rarer than it sounds — the default human setting is the opposite.`,
      `${dsp.nWin} winners, ${dsp.nLoss} losers${dsp.ci ? `, ratio 95% CI ${dsp.ci.lo.toFixed(2)}-${dsp.ci.hi.toFixed(2)}` : ''}`)

  if (n >= 30 && num(behavior.trend?.delta) && behavior.trend.delta > 0.15)
    S('outcome', 'You are improving',
      `Expectancy in your recent half is ${behavior.trend.delta.toFixed(2)} SOL-per-SOL better than your earlier half.`,
      `first half ${behavior.trend.first.toFixed(2)} to second half ${behavior.trend.second.toFixed(2)}, ${n} trades split`)

  if (num(scorecard.payoffRatio) && scorecard.payoffRatio > 1.8 &&
      scorecard.winsLosses[0] >= 6 && scorecard.winsLosses[1] >= 6)
    S('outcome', 'Asymmetric payoff',
      `Your average win is ${scorecard.payoffRatio.toFixed(1)}x your average loss. You can be wrong more often than right and still profit.`,
      `avg win ${scorecard.avgWinSol?.toFixed(2)} vs avg loss ${scorecard.avgLossSol?.toFixed(2)} SOL over ${scorecard.winsLosses[0]}W/${scorecard.winsLosses[1]}L`)

  if (n >= 20 && num(behavior.toll?.rate) && behavior.toll.rate < 0.01 && scorecard.turnoverSol > 5)
    S('process', 'Lean execution',
      `Visible toll is ${(behavior.toll.rate * 100).toFixed(2)}% of turnover. You are not donating to interfaces.`,
      `${scorecard.tollSol.toFixed(3)} SOL toll on ${scorecard.turnoverSol.toFixed(1)} SOL turnover`)

  // ---------- leaks
  if (num(dsp?.point) && dsp.point > 2.5 && dsp.nWin >= 4 && dsp.nLoss >= 4 &&
      (!dsp.ci || dsp.ci.lo > 1.3))
    L('process', 'Disposition effect',
      `Losers are held ${dsp.point.toFixed(1)}x longer than winners. Odean measured this in 1998; your ledger repeats it.`,
      `median hold: winners ${dsp.nWin && behavior.medianHoldWinMin?.toFixed(0)}m, losers ${behavior.medianHoldLossMin?.toFixed(0)}m${dsp.ci ? `, ratio 95% CI ${dsp.ci.lo.toFixed(1)}-${dsp.ci.hi.toFixed(1)}` : ''}`)

  if (num(rev?.point) && rev.point > 2.5 && rev.nLoss >= 6 && rev.nWin >= 4)
    L('process', 'Tilt after losses',
      `You re-enter ${rev.point.toFixed(1)}x faster after a loss than after a win. That is the tilt signature, and it is the single most modellable thing a wallet can do.`,
      `median gap after loss ${rev.medGapAfterLossMin?.toFixed(0)}m vs after win ${rev.medGapAfterWinMin?.toFixed(0)}m (${rev.nLoss} losses, ${rev.nWin} wins)`)

  if (escalates && siz.escalation > 1.5)
    L('process', 'Sizing up to recover',
      `Buys inside an hour of a losing exit average ${siz.escalation.toFixed(1)}x the size of your other buys. Martingale sizing turns a bad session into a bad month.`,
      `${siz.nPostLoss} post-loss buys vs ${siz.nBaseline} baseline buys`)

  if (num(pan?.lo) && pan.lo > 0.4 && pan.n >= 10)
    L('process', 'Reflex exits',
      `At least ${Math.round(pan.lo * 100)}% of losses were closed within ${PANIC_WINDOW_MIN} minutes of entry — the interval never drops below that.`,
      `${Math.round(pan.point * 100)}% of ${pan.n} losing exits, 95% CI ${Math.round(pan.lo * 100)}-${Math.round(pan.hi * 100)}%`)

  if (num(behavior.toll?.rate) && behavior.toll.rate > 0.03 && scorecard.turnoverSol > 1)
    L('process', 'Toll drag',
      `${(behavior.toll.rate * 100).toFixed(1)}% of everything you traded went to fees, tips and interface cuts — ${scorecard.tollSol.toFixed(2)} SOL that never had a chance to be right.`,
      `on ${scorecard.turnoverSol.toFixed(1)} SOL of turnover, visible portion only`)

  if (n >= 20 && num(exp?.hi) && exp.hi < 0)
    L('outcome', 'Negative expectancy',
      `Every SOL of basis you deploy returns ${exp.point.toFixed(2)} SOL, and the entire interval sits below zero. Trading more often multiplies this; it does not fix it.`,
      `${n} trades, 95% CI ${exp.lo.toFixed(2)} to ${exp.hi.toFixed(2)}`)

  // Deliberately price-free. Marks exist elsewhere in the payload, but a finding
  // that quoted them would make the diagnosis move when a price API did, and the
  // behavioral read has to be reproducible from chain data alone.
  if (behavior.bags?.count > 4)
    L('process', 'Open bag pile',
      `${behavior.bags.count} positions still open with ${behavior.bags.costSol.toFixed(2)} SOL of cost basis. Whether that is a loss depends on the marks listed below; none of it sits in any realized figure above.`,
      `${behavior.bags.count} open positions, excluded from every realized metric`)

  if (n >= 15 && num(scorecard.top3ShareOfGrossWin) && scorecard.top3ShareOfGrossWin > 0.85)
    L('outcome', 'One-hit dependence',
      `${Math.round(scorecard.top3ShareOfGrossWin * 100)}% of gross profit came from 3 trades. Strip them and the remaining book is what your process actually produces.`,
      `${n} trades total`)

  if (n >= 30 && num(behavior.trend?.delta) && behavior.trend.delta < -0.2)
    L('outcome', 'Getting worse',
      `Recent-half expectancy is ${Math.abs(behavior.trend.delta).toFixed(2)} worse than your earlier half.`,
      `first half ${behavior.trend.first.toFixed(2)} to second half ${behavior.trend.second.toFixed(2)}`)

  return { strengths, leaks }
}

// ---------- diagnosis: the two axes that actually matter
//
// Edge = is the money working, and can we prove it? Process = is the behavior
// sound? Separating them turns a one-line insult into something a person can act
// on: a losing wallet with clean process has a SELECTION problem, not a
// discipline problem, and those have opposite fixes. A profitable wallet with
// broken process is one bad streak from giving it all back.
export function buildDiagnosis(scorecard, behavior, findings, confidence) {
  const n = scorecard.closedTrades
  const exp = scorecard.expectancy
  const proven = n >= 20 && exp && Number.isFinite(exp.lo) && Number.isFinite(exp.hi)

  let edge
  if (!proven) edge = 'unproven'
  else if (exp.lo > 0) edge = 'positive'
  else if (exp.hi < 0) edge = 'negative'
  else edge = 'unproven'

  const processLeaks = findings.leaks.filter((l) => l.kind === 'process').length
  const processStrengths = findings.strengths.filter((s) => s.kind === 'process').length
  const process =
    processLeaks === 0 && processStrengths >= 2 ? 'sound'
      : processLeaks >= 3 ? 'broken'
      : processLeaks >= 1 ? 'leaky'
      : 'unclear'

  const MATRIX = {
    'positive|sound': ['Edge and discipline', 'Both, and provably. This is the rare quadrant — the machine finds you hard to model and there is nothing to harvest even if it could.'],
    'positive|leaky': ['Winning with a limp', 'Your expectancy is genuinely positive, but specific habits are taxing it. Fixing them is the cheapest money available to you.'],
    'positive|broken': ['Winning despite yourself', 'The edge is real and the process is not holding it. Streaks built like this give it back; the leaks below are the mechanism.'],
    'negative|sound': ['Clean process, wrong picks', 'Your behavior is disciplined and your selection is losing money. That is a SELECTION problem, not a discipline problem — the fix is what you buy, not how you hold it.'],
    'negative|leaky': ['Losing, with reasons', 'Negative expectancy plus identifiable habit leaks. The leaks are the tractable part; start there before touching selection.'],
    'negative|broken': ['Compounding the wrong things', 'Negative expectancy and multiple behavioral leaks reinforcing each other. This is the profile a behavioral system is built to trade against.'],
    'unproven|sound': ['Clean process, unproven edge', 'Your habits are sound; the sample cannot yet say whether you have an edge. Keep the process and let the trade count grow — this is the good version of "not enough data".'],
    'unproven|leaky': ['Unproven, and leaking', 'No demonstrable edge either way, plus fixable habits. The habits are worth fixing regardless of what the edge turns out to be.'],
    'unproven|broken': ['Nothing is working yet', 'No demonstrable edge and multiple behavioral leaks. Nothing here is fatal; almost none of it is measured yet either.'],
    'unproven|unclear': ['Too early to say', 'Not enough closed trades to separate skill from noise or to see behavioral patterns. Illegibility is a defense, for now.'],
  }
  const key = `${edge}|${process}`
  const [headline, reading] = MATRIX[key] || MATRIX[`${edge}|unclear`] || MATRIX['unproven|unclear']

  return {
    edge, process, headline, reading,
    provable: proven,
    counts: { processLeaks, processStrengths,
      outcomeStrengths: findings.strengths.filter((s) => s.kind === 'outcome').length,
      outcomeLeaks: findings.leaks.filter((l) => l.kind === 'outcome').length },
  }
}

// ============================================================ 8. EXPLOITABILITY

// Exploitability = how much value a system modelling this wallet could actually
// extract. That is a PRODUCT, not a sum:
//
//     leak x (how legible the reactions are) x (how often decisions happen)
//
// The distinction matters and an earlier version got it wrong. Readability and
// cadence are amplifiers on an existing leak, never contributors in their own
// right: you can predict a profitable trader's next move perfectly and still
// make nothing from it. So a wallet with no leak scores zero however legible it
// is — and its readability is reported separately, because "profitable but very
// legible" is a real and useful thing to know about yourself.
//
// The amplifier blends readability and cadence rather than multiplying them:
// they are substitutes, not joint requirements. Either a legible reaction OR a
// high decision rate is enough to make a leak harvestable, so multiplying two
// sub-1 terms would double-discount and crush obvious exit liquidity into the
// "readable" band. It is floored at 0.4 — an erratic, infrequent leaker is still
// harvestable, just less efficiently — and reaches 1.0 only when both max out.
export function buildScore(ledger, scorecard, behavior, seed) {
  const n = scorecard.closedTrades
  // The floor is 20, matching the bar for any edge claim in buildFindings — and it
  // is 20 rather than 8 because of a share card. At n=8 the score was free to
  // print "62/100 Farmable" while the diagnosis beside it read "too early to say"
  // and no finding was allowed to mention expectancy at all. The score's dominant
  // term IS expectancy, so a gate looser than the finding gate let the headline
  // number make a claim the prose was forbidden from making.
  const MIN = 20
  if (n < MIN) {
    return { value: null, ci: null, grade: 'Not scored', components: null,
      why: `Exploitability rests on expectancy, and no expectancy claim is made below ${MIN} closed trades. Found ${n}.` }
  }

  // Readability: how scriptable this wallet's reactions are. Reflexive behavior
  // (tilt, panic, asymmetric exits) dominates, because that is what creates a
  // tradable prediction; consistent sizing only helps size the trade against it.
  const sizingLegible =
    behavior.sizing?.cv === null || behavior.sizing?.cv === undefined
      ? 0.3
      : clamp01(1 - behavior.sizing.cv / 2)
  const reactive = clamp01(
    0.4 * hi(behavior.revenge?.point, 5) +
      0.35 * hi(behavior.panic?.point, 0.8) +
      0.25 * clamp01(Math.abs((behavior.disposition?.point ?? 1) - 1) / 5),
  )
  const readability = clamp01(0.3 * sizingLegible + 0.7 * reactive)
  const cadence = clamp01((scorecard.tradesPerDay ?? 0) / 10)
  const amp = 0.4 + 0.6 * (0.6 * readability + 0.4 * cadence)

  const leakOf = (e) => clamp01(-(e ?? 0) / 0.5)
  const leak = leakOf(scorecard.expectancy?.point)
  const value = Math.round(100 * leak * amp)

  // Interval covers sampling noise in the leak term — the only component
  // estimated from individual trades. Structural terms are held fixed.
  const boot = bootstrapCI(
    ledger.closed,
    (sample) => 100 * leakOf(expectancyOf(sample)) * amp,
    { seed: seed + 13, B: 1500 },
  )

  const grade =
    value >= 70 ? 'Prime exit liquidity'
      : value >= 45 ? 'Farmable'
      : value >= 20 ? 'Readable'
      : leak === 0 ? 'Hard target — no leak to harvest'
      : 'Hard target'

  return {
    value,
    ci: boot ? { lo: Math.max(0, Math.round(boot.lo)), hi: Math.round(boot.hi) } : null,
    grade,
    components: { leak, readability, cadence, amplifier: amp },
    formula: 'score = 100 x leak x [0.4 + 0.6 x (0.6 x readability + 0.4 x cadence)]',
    why:
      leak === 0
        ? 'Your expectancy is not negative, so there is no leak to harvest. Readability is reported anyway: it is how legible your patterns would be if your edge ever decayed.'
        : 'A stated formula over three measured components, not a fitted model. Readability and cadence only amplify an existing leak — they never create one.',
  }
}

// ============================================================ TOP LEVEL

export function analyze(transactions, wallet, opts = {}) {
  const seed = hashSeed(wallet || 'seed')
  const events = []
  for (const tx of transactions) {
    const ev = classify(tx, wallet)
    if (ev) events.push(ev)
  }
  events.sort((a, b) => a.ts - b.ts)
  const ledger = buildLedger(events)
  const scorecard = buildScorecard(ledger, seed)
  const behavior = buildBehavior(ledger, scorecard, seed, opts.ladders)
  const counterfactuals = buildCounterfactuals(ledger, scorecard, behavior)
  const archetype = buildArchetypeMixture(scorecard, behavior)
  const findings = buildFindings(scorecard, behavior)
  const score = buildScore(ledger, scorecard, behavior, seed)
  const confidence = confidenceFor(scorecard.closedTrades)
  const diagnosis = buildDiagnosis(scorecard, behavior, findings, confidence)
  // Valued last, on purpose: it consumes the ledger and nothing consumes it back.
  const valuation = valueBags(ledger.bags, opts.prices)

  const swapEvents = events.filter((e) => e.kind !== 'rotation').length

  return {
    wallet,
    engineVersion: 'engine-v1',
    // Provenance of the reference distribution the percentiles were read against.
    // Defaults to the prior stamp; the caller overrides it with cohort provenance
    // when it supplied measured ladders. The payload always says which it was.
    referenceVersion: opts.cohort?.version || REFERENCE_VERSION,
    cohort: opts.cohort || {
      wallets: 0,
      basis: 'prior',
      version: REFERENCE_VERSION,
      note: 'No measured cohort supplied; percentiles read against research-derived priors.',
    },
    confidence,
    sample: {
      txScanned: transactions.length,
      swapEvents,
      closedTrades: scorecard.closedTrades,
      excluded: {
        rotations: ledger.rotationDetail.multiLeg + ledger.rotationDetail.unmatched,
        sellsWithoutBasis: ledger.unmatchedSells,
        nonSwapTx: transactions.length - events.length,
      },
      // Rotations are no longer a single "skipped" bucket, because they are not one
      // thing. Each outcome is a different claim and gets counted as one.
      rotations: {
        total: ledger.rotationDetail.total,
        valued: ledger.rotationDetail.valued,
        basisRolled: ledger.rotationDetail.rolled,
        ambiguous: ledger.rotationDetail.ambiguous,
        multiLeg: ledger.rotationDetail.multiLeg,
        noBasis: ledger.rotationDetail.unmatched,
        closedFromRotations: ledger.closed.filter((t) => t.via === 'rotation').length,
      },
      firstTs: events.length ? events[0].ts : null,
      lastTs: events.length ? events[events.length - 1].ts : null,
      spanDays: scorecard.spanDays,
    },
    diagnosis,
    scorecard,
    behavior,
    counterfactuals,
    archetype,
    strengths: findings.strengths,
    leaks: findings.leaks,
    score,
    // Open positions. Prices are injected, so this block is the ONLY part of the
    // payload that depends on a live external input — and deliberately the only
    // part. Nothing above it (expectancy, findings, diagnosis, score, archetype)
    // consults a price, which is why the same wallet reads identically whether or
    // not the price source answered. A behavioral measurement that changed when an
    // API went down would not be a measurement.
    openBags: {
      count: valuation.totals.count,
      costSol: valuation.totals.costSol,
      basis: valuation.basis,
      partial: valuation.partial,
      totals: valuation.totals,
      items: valuation.items.slice(0, 10),
      // The display cap and the pricing cap are different concerns: the interface
      // shows ten rows, but the TOTALS are computed over every bag, so pricing
      // should reach further than the list does. Cost-ordered, so if the adapter's
      // request cap bites it bites on dust.
      pricingMints: valuation.items.slice(0, 30).map((i) => i.mint),
      source: valuation.source,
      note: valuation.note,
      skipped: valuation.skipped,
      excludedFromMetrics: 'Marks are disclosure only. No behavioral metric, finding, diagnosis or score reads a price.',
    },
    position: combinePosition(scorecard.netPnlSol, valuation),
    trades: ledger.closed.slice(-60).reverse(),
    assumptions: [
      opts.cohort && opts.cohort.basis !== 'prior'
        ? `Reference cohort: ${opts.cohort.version}. ${opts.cohort.rule || ''}`
        : `Reference cohort: ${REFERENCE_VERSION}. Percentiles compare you to research-derived priors, not to measured Mirror traffic. They are replaced with measured quantiles, per quantile, as scan volume accrues.`,
      `Win-rate shrinkage prior: mean ${WIN_RATE_PRIOR.mean} with strength ${WIN_RATE_PRIOR.strength} pseudo-trades. Expectancy prior mean ${EXPECTANCY_PRIOR.mean}.`,
      'Toll is a visible lower bound: fees routed from pool to interface never enter your wallet and cannot be attributed.',
      'Trade Sharpe is per-trade, not annualized. Memecoin holding periods are too uneven for calendar annualization to mean anything.',
      'Counterfactuals marked "hindsight" use outcome knowledge and overstate what was achievable in real time.',
    ],
    limits: [
      ledger.rotationDetail.total === 0
        ? 'No token-to-token rotations in the window.'
        : `${ledger.rotationDetail.total} token-to-token rotation${ledger.rotationDetail.total === 1 ? '' : 's'}: ${ledger.rotationDetail.valued} valued at the SOL the router actually moved through the wallet, ${ledger.rotationDetail.rolled} carried their cost basis into the new position with no PnL claimed (nothing was realized in SOL), ${ledger.rotationDetail.ambiguous + ledger.rotationDetail.multiLeg + ledger.rotationDetail.unmatched} left unattributed.`,
      valuation.basis === 'cost' || valuation.basis === 'none'
        ? 'Every behavioral metric is realized-only. Open positions are listed at cost basis; no mark was available.'
        : 'Every behavioral metric is realized-only. Open positions are marked at spot for disclosure and feed nothing else. A mark assumes the deepest pool found, no swap fees, no routing, and nobody else selling — the realizable figure beside it is the honest bound.',
      'Sells of tokens acquired before the scan window have unknown basis and are excluded.',
      `Scan window: last ${transactions.length} transactions.`,
    ],
  }
}
