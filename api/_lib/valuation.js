// Valuing open positions. PURE — prices arrive as an argument, never fetched here.
//
// The hard part is not multiplying quantity by price. It is refusing to pretend
// that the product is an exit. A memecoin bag marked at 3.4 SOL against a pool
// holding 2 SOL of depth is not worth 3.4 SOL to anyone, and printing that number
// unqualified would be the most consequential overclaim in the product — it is the
// figure a user would actually act on.
//
// So every priced bag carries two numbers:
//   markSol        spot quantity x price. What "unrealized" conventionally means.
//   realizableSol  what selling the whole bag into the pool would actually return.
//
// The second comes from constant-product AMM arithmetic, not a fudge factor. For
// reserves (T tokens, S SOL) with spot price p = S/T, selling dt tokens returns
// S*dt/(T+dt), while the mark claims dt*p. The ratio is T/(T+dt), and since
// dt/T = (dt*p)/S = markSol/liquiditySol:
//
//     realizableSol = markSol / (1 + markSol / liquiditySol)
//
// A bag worth 10% of pool depth realizes ~91% of its mark; a bag equal to pool
// depth realizes ~50%. Stated limits: single deepest pool, no swap fees, no routing
// across venues, and no allowance for anyone else selling into the same pool at the
// same time. It is a bound on optimism, not a quote.

// Impact above this share of pool depth is called out rather than buried.
const MATERIAL_IMPACT = 0.02
// Below this pool depth a mark is treated as decorative regardless of arithmetic.
const MIN_POOL_SOL = 0.5

export function valueBags(bags, priceBook, { materialImpact = MATERIAL_IMPACT } = {}) {
  const list = Array.isArray(bags) ? bags : []
  const entries = priceBook?.entries || {}
  const items = []

  for (const b of list) {
    const px = entries[b.mint]
    const base = {
      mint: b.mint,
      qty: b.qty,
      costSol: b.costSol,
      firstTs: b.firstTs ?? null,
      priced: false,
      solPrice: null,
      markSol: null,
      realizableSol: null,
      unrealizedSol: null,
      impactShare: null,
      liquiditySol: null,
      dex: null,
      flags: [],
    }

    if (!px || !Number.isFinite(px.solPrice) || px.solPrice <= 0 || !Number.isFinite(b.qty) || b.qty <= 0) {
      base.flags.push('unpriced')
      items.push(base)
      continue
    }

    const markSol = b.qty * px.solPrice
    const liq = Number.isFinite(px.liquiditySol) && px.liquiditySol > 0 ? px.liquiditySol : null
    const impactShare = liq ? markSol / liq : null
    const realizableSol = liq ? markSol / (1 + markSol / liq) : null

    const flags = []
    if (!liq) flags.push('depth-unknown')
    else if (liq < MIN_POOL_SOL) flags.push('pool-negligible')
    else if (impactShare >= 1) flags.push('exceeds-pool-depth')
    else if (impactShare >= materialImpact) flags.push('material-impact')
    if (!px.quoteIsSol) flags.push('non-sol-quote')

    items.push({
      ...base,
      priced: true,
      solPrice: px.solPrice,
      markSol,
      realizableSol,
      // Unrealized is stated against the MARK, which is what the word conventionally
      // means; the realizable figure sits beside it rather than silently replacing
      // it. Substituting one for the other would be a different claim wearing the
      // same label.
      unrealizedSol: markSol - b.costSol,
      unrealizedRealizableSol: realizableSol === null ? null : realizableSol - b.costSol,
      impactShare,
      liquiditySol: liq,
      liquidityUsd: px.liquidityUsd ?? null,
      dex: px.dex || null,
      flags,
    })
  }

  const priced = items.filter((i) => i.priced)
  const unpriced = items.filter((i) => !i.priced)
  const sum = (xs, f) => xs.reduce((s, x) => s + (Number.isFinite(f(x)) ? f(x) : 0), 0)

  const costSol = sum(items, (i) => i.costSol)
  const pricedCostSol = sum(priced, (i) => i.costSol)
  const markSol = sum(priced, (i) => i.markSol)
  const realizableSol = priced.every((i) => Number.isFinite(i.realizableSol))
    ? sum(priced, (i) => i.realizableSol)
    : null

  const basis =
    items.length === 0 ? 'none'
      : priced.length === 0 ? 'cost'
      : unpriced.length === 0 ? 'marked'
      : 'partial'

  items.sort((a, b) => (b.costSol || 0) - (a.costSol || 0))

  return {
    items,
    basis,
    partial: basis === 'partial',
    totals: {
      count: items.length,
      pricedCount: priced.length,
      unpricedCount: unpriced.length,
      costSol,
      pricedCostSol,
      unpricedCostSol: costSol - pricedCostSol,
      // Coverage is by COST, not by count: five dust bags going unpriced matters
      // far less than one large one, and a count would hide that.
      coverage: costSol > 0 ? pricedCostSol / costSol : null,
      markSol: priced.length ? markSol : null,
      realizableSol,
      unrealizedSol: priced.length ? markSol - pricedCostSol : null,
      unrealizedRealizableSol: realizableSol === null ? null : realizableSol - pricedCostSol,
      materialImpactCount: priced.filter((i) =>
        i.flags.includes('material-impact') || i.flags.includes('exceeds-pool-depth') || i.flags.includes('pool-negligible'),
      ).length,
    },
    source: priceBook?.source || null,
    note: priceBook?.note || null,
    skipped: priceBook?.skipped?.length || 0,
  }
}

// The combined figure a person actually wants, assembled so it can never be
// mistaken for a behavioral measurement. Realized PnL is a settled fact; the open
// portion is a live mark on positions that have not resolved. They are added here
// for disclosure and nowhere else in the engine.
export function combinePosition(realizedPnlSol, valuation) {
  if (!Number.isFinite(realizedPnlSol)) return null
  const t = valuation?.totals
  if (!t || !Number.isFinite(t.unrealizedSol)) {
    return {
      realizedSol: realizedPnlSol,
      unrealizedSol: null,
      totalSol: null,
      basis: valuation?.basis || 'none',
      caveat: 'Open positions could not be marked, so no combined figure is stated. Realized PnL stands alone.',
    }
  }
  return {
    realizedSol: realizedPnlSol,
    unrealizedSol: t.unrealizedSol,
    unrealizedRealizableSol: t.unrealizedRealizableSol,
    totalSol: realizedPnlSol + t.unrealizedSol,
    totalRealizableSol: Number.isFinite(t.unrealizedRealizableSol)
      ? realizedPnlSol + t.unrealizedRealizableSol
      : null,
    basis: valuation.basis,
    coverage: t.coverage,
    caveat: valuation.partial
      ? `Combined figure covers only the ${Math.round((t.coverage || 0) * 100)}% of open cost basis that could be marked; ${t.unpricedCount} position${t.unpricedCount === 1 ? ' remains' : 's remain'} unpriced.`
      : 'Open positions are marked at spot on the deepest pool found. A mark is not an exit — see the realizable figure beside it.',
  }
}
