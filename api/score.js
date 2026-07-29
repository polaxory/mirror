// GET /api/score?mint=<mint>  ->  holder-base exit-liquidity risk
//
// The B2B product. Same engine as the Mirror, pointed at a token's holder set
// instead of one wallet: profile each large holder's behavior, value their position,
// and size the selling their habits imply against what the pool can absorb.
//
// Orchestration only. Every number comes from pure code in holders.js, valuation.js
// and engine.js; this file fetches, bounds concurrency, caches, and assembles.

import { createHash } from 'node:crypto'
import { analyze } from './_lib/engine.js'
import { scoreHolderBase, HOLDER_PARAMS } from './_lib/holders.js'
import { fetchTransactions, fetchTokenHolders, fetchMintDecimals, mapWithLimit, isAddress } from './_lib/chain.js'
import { fetchPriceBook } from './_lib/prices.js'
import { readProfile, writeProfile } from './_lib/store.js'

// Bounded so a scan neither trips the rate limiter nor exceeds the function budget.
//
// Depth per holder beats breadth across holders, and a live run is what proved it.
// At 2 pages each, real holders came back with 1-3 closed trades and NOTHING cleared
// the 8-trade profile floor — the endpoint could not have scored any token, ever. A
// wallet's swap history is sparse relative to its transaction count (a live wallet
// showed 36 swaps in 134 transactions, yielding 9 closed round trips only at 4 pages).
//
// So: fewer holders, profiled properly. 10 x 4 pages = 40 reads, which the observed
// latency fits inside the budget below. Lowering the profile floor instead would have
// been the wrong fix — that floor is what makes a behavioral claim mean anything.
//
// The profile cache changes this economics over time: a holder already scanned by the
// Mirror, or by a previous scan of any token, costs nothing. Coverage improves on its
// own as traffic accrues.
// LIVE FINDING that reshaped this endpoint: the top holders of a real token are
// almost never traders. On BONK, 10 of the 10 largest holders had zero closed trades;
// on WIF, 7 of 10. They are exchanges, treasuries, market makers and pool accounts.
// Balance rank targets precisely the least behaviourally legible slice of a holder
// base, so scanning only the top could never produce a score.
//
// The behaviour lives further down the distribution. So: pull a WIDE ranked list (one
// call returns up to a thousand), then walk down it profiling until enough readable
// wallets are found or the budget runs out. Institutional whales still get counted and
// valued — their size is real — they just stop being mistaken for coverage failures.
const HOLDERS_FETCHED = 40
const PROFILE_TARGET = 10
const HOLDERS_MAX = 60
const CONCURRENCY = 3 // free-tier Helius throttles hard above this at 4 pages each
const PAGES_PER_HOLDER = 4

// Wall-clock budget for the profiling phase. When it runs out we stop starting new
// holders and report what we have — partial coverage is already a first-class
// concept with its own gates, so a slow scan degrades into "scored with 8 of 12
// profiled" or an honest withheld, never into a 504. A timeout is the one failure
// mode that produces no information at all.
const PROFILE_BUDGET_MS = 9000
const SALT = process.env.COHORT_SALT || 'polaxory-cohort-v1'
const hashAddr = (a) => createHash('sha256').update(`${SALT}:${a}`).digest('hex').slice(0, 24)

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  const mint = (req.query.mint || '').trim()
  if (!isAddress(mint)) {
    return res.status(400).json({ error: 'That does not look like a Solana mint address.' })
  }
  if (!process.env.HELIUS_API_KEY) {
    return res.status(500).json({ error: 'Server missing HELIUS_API_KEY.' })
  }

  const asked = Number.parseInt(req.query.limit, 10)
  const scanLimit = Number.isFinite(asked) ? Math.max(10, Math.min(HOLDERS_MAX, asked)) : HOLDERS_FETCHED

  // ---- who holds it, and what is it worth
  const [holderRes, priceBook, decimals] = await Promise.all([
    fetchTokenHolders(mint, { limit: scanLimit }),
    fetchPriceBook([mint]),
    fetchMintDecimals(mint),
  ])

  if (!holderRes.ok) {
    return res.status(404).json({ error: holderRes.note || 'No holders found for that mint.' })
  }

  const px = priceBook.entries?.[mint] || null
  const dec = Number.isInteger(decimals) ? decimals : null
  const toUi = (raw) => (dec === null ? null : raw / 10 ** dec)
  const totalScannedRaw = holderRes.holders.reduce((s, h) => s + h.amountRaw, 0)

  // ---- profile down the ranked list until enough readable wallets are found
  const deadline = Date.now() + PROFILE_BUDGET_MS
  let ranOut = 0
  let readable = 0
  const profiles = await mapWithLimit(holderRes.holders, CONCURRENCY, async (h) => {
    const key = hashAddr(h.owner)
    const cached = await readProfile(key)
    if (cached) {
      if ((cached.profile?.closedTrades ?? 0) >= 8) readable++
      return { owner: h.owner, profile: cached.profile, bags: cached.bags, cached: true }
    }

    // Stop once there are enough readable wallets, or the budget is spent. Either way
    // the remaining holders come back unprofiled, which the aggregator already knows
    // how to count and disclose — and their balances still count toward the token's
    // size, they simply carry no behavioural claim.
    if (readable >= PROFILE_TARGET || Date.now() > deadline) {
      if (Date.now() > deadline) ranOut++
      return { owner: h.owner, profile: emptyProfile(), bags: [], cached: false, skipped: true }
    }

    const fetched = await fetchTransactions(h.owner, { pages: PAGES_PER_HOLDER })
    const { txs } = fetched
    // A wallet we could not read is not a wallet that never traded. Pass the
    // distinction through so the aggregator can keep them apart.
    if (fetched.truncated) {
      return { owner: h.owner, profile: emptyProfile(), bags: [], cached: false, unreadable: true }
    }
    if (!txs.length) return { owner: h.owner, profile: emptyProfile(), bags: [], cached: false }

    const r = analyze(txs, h.owner, px ? { prices: priceBook } : {})
    const profile = {
      closedTrades: r.scorecard.closedTrades,
      expectancy: r.scorecard.expectancy?.point ?? null,
      panicIndex: r.behavior.panic?.point ?? null,
      dispositionRatio: r.behavior.disposition?.point ?? null,
      medianHoldWinMin: r.behavior.medianHoldWinMin ?? null,
      medianHoldLossMin: r.behavior.medianHoldLossMin ?? null,
      tradesPerDay: r.scorecard.tradesPerDay ?? null,
      archetype: r.archetype?.unread ? null : r.archetype?.primary?.key ?? null,
    }
    // Only the bag for THIS mint matters here; the rest of their book is theirs.
    const bags = (r.openBags?.items || [])
      .filter((b) => b.mint === mint)
      .map((b) => ({ costSol: b.costSol, qty: b.qty, firstTs: b.firstTs }))

    if (profile.closedTrades >= 8) readable++
    await writeProfile(key, { profile, bags })
    return { owner: h.owner, profile, bags, cached: false }
  })

  const nowSec = Math.floor(Date.now() / 1000)
  const holders = holderRes.holders.map((h, i) => {
    const p = profiles[i] || { profile: emptyProfile(), bags: [] }
    const amountUi = toUi(h.amountRaw)
    const bag = p.bags?.[0] || null
    // Their return on THIS position, only where their own buys give us a basis.
    let position = null
    if (bag && Number.isFinite(bag.costSol) && bag.costSol > 0 && px && amountUi !== null) {
      const markSol = amountUi * px.solPrice
      position = {
        costSol: bag.costSol,
        unrealizedReturn: markSol / bag.costSol - 1,
        heldForMin: Number.isFinite(bag.firstTs) ? (nowSec - bag.firstTs) / 60 : null,
      }
    }
    return {
      owner: h.owner,
      amountUi,
      shareOfScanned: totalScannedRaw > 0 ? h.amountRaw / totalScannedRaw : null,
      profile: p.profile,
      unreadable: !!p.unreadable,
      position,
    }
  })

  const out = scoreHolderBase({
    mint,
    holders,
    tokenSolPrice: px?.solPrice ?? null,
    poolLiquiditySol: px?.liquiditySol ?? null,
    totalHolders: holderRes.total,
    truncated: holderRes.truncated,
    priceNote: priceBook.ok ? null : priceBook.note,
  })

  out.meta = {
    engineVersion: 'engine-v1',
    scoreVersion: 'holder-score-v1',
    scanned: holderRes.holders.length,
    scanLimit,
    profileTarget: PROFILE_TARGET,
    readableFound: readable,
    unreadableForRateLimit: profiles.filter((p) => p?.unreadable).length,
    holdersKnown: holderRes.total,
    // Disclosed rather than hidden: a scan that ran out of budget produced thinner
    // coverage, and the reader is entitled to know that is why.
    unprofiledForTime: ranOut,
    budgetMs: PROFILE_BUDGET_MS,
    decimals: dec,
    pagesPerHolder: PAGES_PER_HOLDER,
    cacheHits: profiles.filter((p) => p?.cached).length,
    params: HOLDER_PARAMS,
    dex: px?.dex ?? null,
    generatedAt: new Date().toISOString(),
  }

  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=1800')
  return res.status(200).json(out)
}

const emptyProfile = () => ({
  closedTrades: 0, expectancy: null, panicIndex: null, dispositionRatio: null,
  medianHoldWinMin: null, medianHoldLossMin: null, tradesPerDay: null, archetype: null,
})
