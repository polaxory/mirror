// Synthetic wallet generator: produces Helius-shaped transactions from KNOWN
// behavioral parameters, so the engine can be tested on whether it recovers them.
// Every validation claim in tests/validate.mjs rests on this file.

import { mulberry32 } from '../api/_lib/stats.js'

const LAMPORTS = 1e9
const POOL = 'PoOLxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
const FEEWALLET = 'FEExxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'

export const DEFAULTS = {
  wallet: 'TESTWALLETxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  nTrades: 40,
  winRate: 0.4,
  winRet: 1.5, // proceeds multiple on a winner
  lossRet: 0.5, // proceeds multiple on a loser
  retJitter: 0.1, // lognormal-ish noise on the multiple
  holdWinMin: 20,
  holdLossMin: 20,
  holdJitter: 0.35,
  buySize: 1.0,
  buySizeCV: 0.0,
  gapAfterWinMin: 60,
  gapAfterLossMin: 60,
  revengeSizeMult: 1.0, // size multiplier on the buy that follows a loss
  networkFee: 0.0001,
  interfaceFeeRate: 0.0, // fraction of buy size sent to a fee wallet
  openBags: 0,
  openBagSize: 1.0,
  startTs: 1735689600, // 2025-01-01
  seed: 42,
}

// Returns { txs, truth } — txs newest-first (matching Helius), truth = the
// parameters the engine should recover.
export function makeWallet(overrides = {}) {
  const p = { ...DEFAULTS, ...overrides }
  const rand = mulberry32(p.seed)
  const norm = () => {
    // Box-Muller
    const u = Math.max(1e-9, rand())
    const v = rand()
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
  }
  const jitter = (base, cv) => Math.max(1e-6, base * (1 + cv * norm()))

  const txs = []
  let ts = p.startTs
  let lastWasLoss = false
  const truth = {
    wins: 0, losses: 0, grossWin: 0, grossLoss: 0, basis: 0,
    holdWin: [], holdLoss: [], buySizes: [], toll: 0, netPnl: 0,
    gapsAfterWin: [], gapsAfterLoss: [], lastExitTs: null,
  }

  const pushBuy = (mint, sol, qty, at) => {
    const feeCut = sol * p.interfaceFeeRate
    const native = [{ fromUserAccount: p.wallet, toUserAccount: POOL, amount: Math.round(sol * LAMPORTS) }]
    if (feeCut > 0) {
      native.push({ fromUserAccount: p.wallet, toUserAccount: FEEWALLET, amount: Math.round(feeCut * LAMPORTS) })
    }
    txs.push({
      timestamp: at, signature: `buy-${mint}-${at}`, feePayer: p.wallet,
      fee: Math.round(p.networkFee * LAMPORTS),
      nativeTransfers: native,
      tokenTransfers: [{ fromUserAccount: POOL, toUserAccount: p.wallet, mint, tokenAmount: qty }],
    })
    truth.toll += feeCut + p.networkFee
  }
  const pushSell = (mint, sol, qty, at) => {
    txs.push({
      timestamp: at, signature: `sell-${mint}-${at}`, feePayer: p.wallet,
      fee: Math.round(p.networkFee * LAMPORTS),
      nativeTransfers: [{ fromUserAccount: POOL, toUserAccount: p.wallet, amount: Math.round(sol * LAMPORTS) }],
      tokenTransfers: [{ fromUserAccount: p.wallet, toUserAccount: POOL, mint, tokenAmount: qty }],
    })
    truth.toll += p.networkFee
  }

  for (let i = 0; i < p.nTrades; i++) {
    // inter-trade gap depends on whether the previous close was a loss
    if (i > 0) {
      const gap = lastWasLoss
        ? jitter(p.gapAfterLossMin, 0.25) * 60
        : jitter(p.gapAfterWinMin, 0.25) * 60
      if (lastWasLoss) truth.gapsAfterLoss.push(gap / 60)
      else truth.gapsAfterWin.push(gap / 60)
      ts += Math.round(gap)
    }

    const isWin = rand() < p.winRate
    const sizeMult = lastWasLoss ? p.revengeSizeMult : 1
    const size = jitter(p.buySize * sizeMult, p.buySizeCV)
    const qty = 1000 + Math.floor(rand() * 1000)
    const mint = `MINT${i}`

    pushBuy(mint, size, qty, ts)
    truth.buySizes.push(size)
    truth.basis += size

    const holdMin = isWin ? jitter(p.holdWinMin, p.holdJitter) : jitter(p.holdLossMin, p.holdJitter)
    const exitTs = ts + Math.round(holdMin * 60)
    const mult = Math.max(0.01, (isWin ? p.winRet : p.lossRet) * (1 + p.retJitter * norm()))
    const proceeds = size * mult
    pushSell(mint, proceeds, qty, exitTs)

    if (proceeds - size > 0) {
      truth.wins++
      truth.grossWin += proceeds - size
      truth.holdWin.push(holdMin)
    } else {
      truth.losses++
      truth.grossLoss += size - proceeds
      truth.holdLoss.push(holdMin)
    }
    truth.netPnl += proceeds - size
    truth.lastExitTs = exitTs
    lastWasLoss = proceeds - size <= 0
    ts = exitTs
  }

  // open bags: bought, never sold
  for (let i = 0; i < p.openBags; i++) {
    ts += 3600
    pushBuy(`BAG${i}`, p.openBagSize, 5000, ts)
    truth.buySizes.push(p.openBagSize)
  }

  truth.nTrades = p.nTrades
  truth.winRateTrue = p.winRate
  truth.expectancyTrue = truth.basis > 0 ? truth.netPnl / (truth.basis - p.openBags * p.openBagSize) : null
  truth.profitFactor = truth.grossLoss > 0 ? truth.grossWin / truth.grossLoss : null
  truth.openBagCost = p.openBags * p.openBagSize
  truth.params = p

  // Helius returns newest-first
  txs.sort((a, b) => b.timestamp - a.timestamp)
  return { txs, truth }
}

// A wallet whose sells have no matching buy in the window (pre-window basis).
export function makeUnmatchedSellWallet(wallet = DEFAULTS.wallet) {
  const txs = []
  let ts = DEFAULTS.startTs
  for (let i = 0; i < 5; i++) {
    ts += 3600
    txs.push({
      timestamp: ts, signature: `orphan-${i}`, feePayer: wallet, fee: 100000,
      nativeTransfers: [{ fromUserAccount: POOL, toUserAccount: wallet, amount: Math.round(0.5 * LAMPORTS) }],
      tokenTransfers: [{ fromUserAccount: wallet, toUserAccount: POOL, mint: `ORPHAN${i}`, tokenAmount: 1000 }],
    })
  }
  return txs.sort((a, b) => b.timestamp - a.timestamp)
}

// A rotation chain: buy A for SOL, rotate A -> B, sell B for SOL.
//
// `routed` controls which kind of rotation is produced:
//   true  — the swap passes through SOL, so the wallet's WSOL account is credited
//           and debited in the same transaction. Gross legs present, net ~0. This
//           is what a Jupiter-style route looks like and it carries its own
//           historical valuation.
//   false — a direct A/B pool. No SOL leg at all, so nothing is realized in SOL.
//
// truth reports what the whole chain should net, which is the number the engine
// has to recover however the middle leg was shaped.
export function makeRotationChain({
  wallet = DEFAULTS.wallet,
  buySol = 1.0,
  rotateSol = 1.6,   // what A was worth at rotation time
  sellSol = 2.4,     // what B fetched at the end
  qtyA = 1000,
  qtyB = 700,
  routed = true,
  networkFee = 0.0001,
  startTs = DEFAULTS.startTs,
  tag = '',
} = {}) {
  const L = 1e9
  const A = `ROTA${tag}`
  const B = `ROTB${tag}`
  const POOL = 'PoOLxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
  const txs = []
  let ts = startTs

  // 1. buy A with SOL
  txs.push({
    timestamp: ts, signature: `rc-buy-${tag}`, feePayer: wallet, fee: Math.round(networkFee * L),
    nativeTransfers: [{ fromUserAccount: wallet, toUserAccount: POOL, amount: Math.round(buySol * L) }],
    tokenTransfers: [{ fromUserAccount: POOL, toUserAccount: wallet, mint: A, tokenAmount: qtyA }],
  })

  // 2. rotate A -> B
  ts += 3600
  const rotTokens = [
    { fromUserAccount: wallet, toUserAccount: POOL, mint: A, tokenAmount: qtyA },
    { fromUserAccount: POOL, toUserAccount: wallet, mint: B, tokenAmount: qtyB },
  ]
  if (routed) {
    // WSOL credited by the first hop then debited by the second: gross in and out
    // both visible, net ~zero. Exactly the shape the valuation depends on.
    rotTokens.push(
      { fromUserAccount: POOL, toUserAccount: wallet, mint: WSOL_MINT, tokenAmount: rotateSol },
      { fromUserAccount: wallet, toUserAccount: POOL, mint: WSOL_MINT, tokenAmount: rotateSol },
    )
  }
  txs.push({
    timestamp: ts, signature: `rc-rot-${tag}`, feePayer: wallet, fee: Math.round(networkFee * L),
    nativeTransfers: [],
    tokenTransfers: rotTokens,
  })

  // 3. sell B for SOL
  ts += 3600
  txs.push({
    timestamp: ts, signature: `rc-sell-${tag}`, feePayer: wallet, fee: Math.round(networkFee * L),
    nativeTransfers: [{ fromUserAccount: POOL, toUserAccount: wallet, amount: Math.round(sellSol * L) }],
    tokenTransfers: [{ fromUserAccount: wallet, toUserAccount: POOL, mint: B, tokenAmount: qtyB }],
  })

  return {
    txs: txs.sort((a, b) => b.timestamp - a.timestamp),
    truth: {
      A, B, routed, buySol, rotateSol, sellSol,
      // Chain PnL is the same either way: SOL out at the end minus SOL in at the
      // start. Only its ATTRIBUTION differs between the two shapes.
      chainPnl: sellSol - buySol,
      // Routed: two closed trades (A at rotation, B at sale). Direct: one closed
      // trade for B carrying A's basis.
      expectClosed: routed ? 2 : 1,
      legAPnl: routed ? rotateSol - buySol : null,
      legBPnl: routed ? sellSol - rotateSol : null,
    },
  }
}

const WSOL_MINT = 'So11111111111111111111111111111111111111112'

// A wallet that only does token-to-token rotations.
export function makeRotationWallet(wallet = DEFAULTS.wallet) {
  const txs = []
  let ts = DEFAULTS.startTs
  for (let i = 0; i < 6; i++) {
    ts += 1800
    txs.push({
      timestamp: ts, signature: `rot-${i}`, feePayer: wallet, fee: 100000,
      nativeTransfers: [],
      tokenTransfers: [
        { fromUserAccount: wallet, toUserAccount: POOL, mint: `A${i}`, tokenAmount: 500 },
        { fromUserAccount: POOL, toUserAccount: wallet, mint: `B${i}`, tokenAmount: 700 },
      ],
    })
  }
  return txs.sort((a, b) => b.timestamp - a.timestamp)
}
