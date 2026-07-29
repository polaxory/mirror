// Holder-base exit-liquidity risk. PURE — profiles and prices arrive as arguments.
//
// The question every memecoin buyer asks and nobody sells the answer to: *will
// these holders dump on me?* Existing risk tools score a token's STRUCTURE —
// contract authorities, LP locks, holder concentration, sniper bundles. All of that
// describes the container. None of it describes the people, and the people are what
// sells.
//
// This scores the holders behaviorally: how quickly they normally exit, whether
// they are sitting in profit (which the disposition effect says they will realize),
// and — the part that turns a propensity into a price — how much the pool would
// move if the ones most likely to sell actually did.
//
// Grounding, all from the research digest:
//   * Odean 1998 measured PGR/PLR ≈ 1.5: gains are realized about half again as
//     readily as losses. So being in profit RAISES sell pressure, and being deep
//     underwater LOWERS it — the bagholder sits. That asymmetry is the single most
//     load-bearing fact in this file, and it is why "profit overhang" is a separate
//     component rather than a footnote.
//   * Panic index and hold-time habits come from each holder's own realized history.
//   * Exit impact uses the same constant-product arithmetic as valuation.js, because
//     a propensity to sell is only a risk in proportion to what the sale does to
//     the price.

import { clamp01, mean } from './stats.js'
import { identify } from './known.js'

// A holder must have at least this much realized history for a behavioral claim.
const MIN_TRADES_FOR_PROFILE = 8
// Score gates. Below either of these no score is stated, because a holder base is
// not "low risk" just because we failed to read most of it.
const MIN_PROFILED_HOLDERS = 5
// Of the value we COULD read, how much did we profile.
const MIN_VALUE_COVERAGE = 0.35
// Of the value that could plausibly be a person at all, how much is even readable.
// These are different questions and collapsing them was wrong in both directions: a
// live scan showed most large holdings are unreadable (so counting them as coverage
// failures withheld every real token), while a single unreadable whale can also hold
// 99% of a float (so ignoring them would score a rounding error and call it the
// holder base).
const MIN_BEHAVIORAL_SHARE = 0.15
// A propensity above this counts a holder's value as paper-handed.
const PAPER_HAND_CUT = 0.6
// Expected selling equal to this share of pool depth saturates the pressure term.
// 20% of depth is already a ~17% price move on a constant-product pool, which is
// as bad as overhead supply needs to get before the score should be pinned.
const PRESSURE_SATURATION = 0.2

const hi = (v, scale) => (Number.isFinite(v) ? clamp01(v / scale) : null)
const lo = (v, scale) => (Number.isFinite(v) ? clamp01(1 - v / scale) : null)

// ---------------------------------------------------------------- per holder

// profile: the behavioral summary of this wallet (from the engine, realized-only).
// position: what they hold of THIS token.
export function holderPressure(h) {
  const p = h.profile
  const reasons = []

  // Infrastructure first. A pool, a bonding curve, a program vault or an exchange
  // hot wallet is not a participant, and lumping it in with "no history" made every
  // token whose top holders are its own pool look unreadable. Naming it moves the
  // balance out of the denominator instead of dragging coverage down with it.
  const known = identify(h.owner)
  if (known) {
    return {
      propensity: null,
      classification: 'infrastructure',
      infrastructure: known,
      reasons: [`${known.label} — ${known.kind === 'custodian'
        ? 'a custodial balance held for many people, so a behavioral read of it would be meaningless'
        : known.kind === 'burn'
          ? 'this supply is destroyed, not held'
          : 'protocol infrastructure rather than a participant'}.`],
    }
  }

  // Could not be read, as distinct from nothing to read. Kept separate because
  // conflating them let a rate-limited scan report a token as opaque.
  if (h.unreadable) {
    return {
      propensity: null,
      classification: 'unreadable',
      reasons: ['This wallet\u2019s history could not be retrieved, so nothing is claimed about it either way.'],
    }
  }

  if (!p || !Number.isFinite(p.closedTrades) || p.closedTrades < MIN_TRADES_FOR_PROFILE) {
    return {
      propensity: null,
      classification: p && p.closedTrades === 0 ? 'no-history' : 'thin-history',
      reasons: [p && p.closedTrades === 0
        ? 'No realized swap history — could be a pool, a program, an exchange, or simply a wallet that has never sold.'
        : `Only ${p?.closedTrades ?? 0} closed trades; too thin for a behavioral claim.`],
    }
  }

  // How fast does this wallet normally leave a winner? Under ~4h reads as a fast
  // habit; days-long reads as patient.
  const fastHabit = lo(p.medianHoldWinMin, 240) ?? 0.4
  if (fastHabit > 0.7) reasons.push(`exits winners in a median ${Math.round(p.medianHoldWinMin)} min`)

  const panic = hi(p.panicIndex, 0.6) ?? 0.3
  if (panic > 0.6) reasons.push(`cuts ${Math.round(p.panicIndex * 100)}% of losses inside ten minutes`)

  // The disposition effect, applied. r = unrealized return on THIS position.
  const r = Number.isFinite(h.position?.unrealizedReturn) ? h.position.unrealizedReturn : null
  let gainPressure = 0.35
  if (r !== null) {
    gainPressure = Math.max(0.05, clamp01(0.35 + 0.5 * Math.max(-1, Math.min(1, r))))
    if (r > 0.3) reasons.push(`sitting on a ${Math.round(r * 100)}% gain — the disposition effect says gains get realized`)
    if (r < -0.4) reasons.push(`${Math.round(-r * 100)}% underwater — bagholders tend to sit rather than sell`)
  } else {
    reasons.push('cost basis unknown, so profit pressure is assumed neutral')
  }

  const churn = hi(p.tradesPerDay, 8) ?? 0.2
  if (churn > 0.6) reasons.push(`trades ${p.tradesPerDay.toFixed(1)}x per day`)

  // Damping: deep underwater AND held far past their own habit. The position has
  // become a bag, and bags do not get sold — claiming otherwise would invert the
  // very effect this file is built on.
  let stuck = 0
  if (r !== null && r < -0.3 && Number.isFinite(h.position?.heldForMin) && Number.isFinite(p.medianHoldLossMin) && p.medianHoldLossMin > 0) {
    const overdue = h.position.heldForMin / p.medianHoldLossMin
    stuck = clamp01((overdue - 2) / 4)
    if (stuck > 0.4) reasons.push(`has held ${overdue.toFixed(1)}x longer than it normally holds a loser`)
  }

  const base = 0.30 * fastHabit + 0.25 * panic + 0.35 * gainPressure + 0.10 * churn
  const propensity = clamp01(base * (1 - 0.5 * stuck))

  return {
    propensity,
    classification: 'trader',
    components: { fastHabit, panic, gainPressure, churn, stuck },
    reasons,
  }
}

// ---------------------------------------------------------------- aggregate

export function scoreHolderBase({
  mint,
  holders = [],
  tokenSolPrice = null,
  poolLiquiditySol = null,
  totalHolders = null,
  truncated = false,
  priceNote = null,
} = {}) {
  const priced = Number.isFinite(tokenSolPrice) && tokenSolPrice > 0
  const hasDepth = Number.isFinite(poolLiquiditySol) && poolLiquiditySol > 0

  // Coerced, not defaulted. A default parameter only fires on `undefined`, so an
  // explicit `holders: null` from a caller sailed past it and threw on .map — the
  // exact shape an upstream fetch failure produces.
  const list = (Array.isArray(holders) ? holders : []).filter((h) => h && typeof h === 'object')

  const rows = list.map((h) => {
    // Position size is knowable from the balance and the price alone. Whether they
    // are in profit needs their own buy history, which we often will not have — so
    // the two are computed separately and reported separately.
    const markSol = priced && Number.isFinite(h.amountUi) ? h.amountUi * tokenSolPrice : null
    const impactShare = markSol !== null && hasDepth ? markSol / poolLiquiditySol : null
    const realizableSol = impactShare !== null ? markSol / (1 + impactShare) : null
    const press = holderPressure(h)
    return {
      owner: h.owner,
      amountUi: h.amountUi,
      shareOfScanned: h.shareOfScanned ?? null,
      markSol,
      realizableSol,
      impactShare,
      costSol: h.position?.costSol ?? null,
      unrealizedReturn: h.position?.unrealizedReturn ?? null,
      heldForMin: h.position?.heldForMin ?? null,
      archetype: h.profile?.archetype ?? null,
      closedTrades: h.profile?.closedTrades ?? null,
      expectancy: h.profile?.expectancy ?? null,
      ...press,
    }
  })

  const traders = rows.filter((r) => r.classification === 'trader' && Number.isFinite(r.propensity))
  const infra = rows.filter((r) => r.classification === 'infrastructure')
  // A wallet with no realized history at all is not a trader we failed to read — a
  // live scan found the top holders of major tokens are 70-100% exchanges,
  // treasuries and market makers. Counting their balances as coverage failures made
  // the gate unsatisfiable on every real token, so they are reported as size and
  // excluded from the coverage denominator alongside named infrastructure.
  //
  // "Thin history" is different and stays IN the denominator: those wallets do trade,
  // we simply could not see enough of it, and that genuinely is a coverage shortfall.
  const opaque = rows.filter((r) => r.classification === 'no-history')
  const unreadable = rows.filter((r) => r.classification === 'unreadable')
  const readable = rows.filter((r) => r.classification === 'trader' || r.classification === 'thin-history')
  const valued = readable.filter((r) => Number.isFinite(r.markSol))
  const sum = (xs, f) => xs.reduce((s, x) => s + (Number.isFinite(f(x)) ? f(x) : 0), 0)

  const infraValueSol = infra.length ? sum(infra, (r) => r.markSol) : null
  const opaqueValueSol = opaque.length ? sum(opaque, (r) => r.markSol) : null
  const scannedValueSol = valued.length ? sum(valued, (r) => r.markSol) : null
  // Named infrastructure is excluded outright — it is not a person. Opaque balances
  // stay in this denominator because they MIGHT be, and we cannot tell.
  const ambiguousTotal = (scannedValueSol || 0) + (opaqueValueSol || 0)
  const behavioralShare = ambiguousTotal > 0 ? (scannedValueSol || 0) / ambiguousTotal : null
  const profiledValueSol = traders.length ? sum(traders, (r) => r.markSol) : null
  const coverage =
    scannedValueSol && scannedValueSol > 0 && profiledValueSol !== null
      ? profiledValueSol / scannedValueSol
      : null

  // Expected selling: propensity-weighted position value. This is the number the
  // whole endpoint exists to produce.
  const expectedSellSol = traders.length ? sum(traders, (r) => r.propensity * r.markSol) : null
  const expectedPressure =
    expectedSellSol !== null && hasDepth ? expectedSellSol / poolLiquiditySol : null
  // What that selling would do to the price, same CPMM arithmetic as a single exit.
  const congestionImpact =
    expectedPressure !== null ? expectedPressure / (1 + expectedPressure) : null

  const paperHandShare =
    profiledValueSol && profiledValueSol > 0
      ? sum(traders.filter((r) => r.propensity >= PAPER_HAND_CUT), (r) => r.markSol) / profiledValueSol
      : null
  const inProfit = traders.filter((r) => Number.isFinite(r.unrealizedReturn) && r.unrealizedReturn > 0)
  const knownBasis = traders.filter((r) => Number.isFinite(r.unrealizedReturn))
  const knownBasisValue = knownBasis.length ? sum(knownBasis, (r) => r.markSol) : null
  // Overhang is measured against the value whose basis we actually know, not against
  // everything — otherwise unknown basis would masquerade as "not in profit".
  const profitOverhang =
    knownBasisValue && knownBasisValue > 0 ? sum(inProfit, (r) => r.markSol) / knownBasisValue : null

  const holderQuality = traders.length ? mean(traders.map((r) => r.expectancy).filter(Number.isFinite)) : null

  // ---- score, gated
  const gates = []
  if (traders.length < MIN_PROFILED_HOLDERS) gates.push(`fewer than ${MIN_PROFILED_HOLDERS} holders could be profiled`)
  if (!(coverage >= MIN_VALUE_COVERAGE)) gates.push(`profiled holders cover under ${Math.round(MIN_VALUE_COVERAGE * 100)}% of readable holder value`)
  if (!(behavioralShare >= MIN_BEHAVIORAL_SHARE)) {
    gates.push(`only ${Math.round((behavioralShare || 0) * 100)}% of scanned holder value has any readable trading history, so most of this float is an unknown rather than a measured risk`)
  }
  if (unreadable.length > rows.length / 3) {
    gates.push(`${unreadable.length} of ${rows.length} holder histories could not be retrieved, so coverage is unreliable rather than low`)
  }
  if (!hasDepth) gates.push('no pool depth available, so selling pressure cannot be sized against liquidity')
  if (!priced) gates.push('no price available, so positions cannot be valued')

  // Pressure is the core term and the other two only amplify it — a PRODUCT, not a
  // weighted sum.
  //
  // The first draft summed them, and a scenario preview immediately exposed why that
  // is wrong: a base of pure paper hands, all in profit, sitting on a 4000 SOL pool
  // scored 51 while its expected selling was 0.46% of depth and its price impact
  // rounded to zero. Holders who cannot move the price are not a risk however
  // twitchy they are; deep liquidity absorbs them. This is the same error the
  // exploitability score made in v1 — readability contributing risk with no leak to
  // amplify — reintroduced in a new file, which is exactly why the scenario preview
  // exists alongside the unit tests.
  //
  // The amplifier is floored at 0.45: real selling pressure still matters somewhat
  // even from patient holders who are underwater, because pressure is measured from
  // their actual positions, not their moods.
  let score = null
  let grade = 'Not scored'
  let components = null
  if (gates.length === 0) {
    components = {
      pressure: clamp01((expectedPressure || 0) / PRESSURE_SATURATION),
      paperHands: paperHandShare ?? 0,
      profitOverhang: profitOverhang ?? 0,
    }
    components.amplifier = 0.45 + 0.55 * (0.6 * components.paperHands + 0.4 * components.profitOverhang)
    score = Math.round(100 * clamp01(components.pressure * components.amplifier))
    grade = score >= 70 ? 'Standing on a trapdoor'
      : score >= 45 ? 'Heavy overhead supply'
      : score >= 20 ? 'Ordinary holder risk'
      : 'Patient holder base'
  }

  return {
    mint,
    score,
    grade,
    components,
    formula: 'score = 100 x pressure x [0.45 + 0.55 x (0.6 x paperHands + 0.4 x profitOverhang)], where pressure = expected selling / (20% of pool depth), capped at 1',
    gates,
    scored: gates.length === 0,

    holders: rows.sort((a, b) => (b.markSol ?? 0) - (a.markSol ?? 0)),

    totals: {
      scanned: rows.length,
      totalHolders,
      truncated,
      profiled: traders.length,
      infrastructure: infra.length,
      infrastructureValueSol: infraValueSol,
      // Balances with no realized history: real size, no behavioural claim possible.
      opaqueHolders: opaque.length,
      opaqueValueSol: opaqueValueSol,
      unreadableHolders: unreadable.length,
      behavioralShare,
      infrastructureLabels: infra.map((r) => r.infrastructure?.label).filter(Boolean),
      noHistory: rows.filter((r) => r.classification === 'no-history').length,
      thinHistory: rows.filter((r) => r.classification === 'thin-history').length,
      scannedValueSol,
      profiledValueSol,
      coverage,
      poolLiquiditySol: hasDepth ? poolLiquiditySol : null,
      tokenSolPrice: priced ? tokenSolPrice : null,
      expectedSellSol,
      expectedPressure,
      congestionImpact,
      paperHandShare,
      profitOverhang,
      holderQuality,
      basisKnownFor: knownBasis.length,
    },

    reading: buildReading({
      score, grade, gates, traders: traders.length, coverage,
      expectedPressure, congestionImpact, paperHandShare, profitOverhang, holderQuality,
      poolLiquiditySol, expectedSellSol,
    }),

    limits: [
      'Behavioral propensity is estimated from each holder\'s own realized history — how fast they normally exit and how they behave in profit versus underwater. It is not a prediction that any particular wallet will sell.',
      'Expected selling is propensity-weighted position value, then sized against pool depth with the same constant-product arithmetic used for a single exit: no swap fees, no routing, no allowance for the price moving as the queue forms. A bound, not a forecast.',
      'Holders are taken in balance order and profiled down the list until enough readable wallets are found, so concentration below the cut is invisible.',
      'Balances with no realized trading history — exchanges, treasuries, market makers, pool accounts — are counted as size but carry no behavioural claim, and are excluded from the coverage denominator. A live scan found these make up most of the LARGEST holdings in real tokens, so treating them as unread traders would withhold a score on essentially everything.',
      'Known pools, programs, bonding curves and exchange wallets are identified by address and excluded from coverage entirely — they are not holders we failed to read. The list is incomplete by construction, so an unlabelled pool still degrades to "no realized history", which is the honest fallback rather than a wrong guess.',
      priceNote,
    ].filter(Boolean),
  }
}

function buildReading(x) {
  if (x.gates.length) {
    return `No score: ${x.gates.join('; ')}. What could be read is reported below, but a holder base is not patient just because it could not be measured.`
  }
  const pct = (v) => `${Math.round((v || 0) * 100)}%`
  const parts = []
  parts.push(
    `Across the holders that could be profiled, behavior consistent with about ${x.expectedSellSol.toFixed(2)} SOL of selling — ${pct(x.expectedPressure)} of pool depth, which would move the price roughly ${pct(x.congestionImpact)} if it arrived together.`,
  )
  if (Number.isFinite(x.paperHandShare) && x.paperHandShare > 0.4) {
    parts.push(`${pct(x.paperHandShare)} of profiled value sits with wallets that exit quickly by habit.`)
  }
  if (Number.isFinite(x.profitOverhang) && x.profitOverhang > 0.5) {
    parts.push(`${pct(x.profitOverhang)} of the value whose basis is known is in profit, and gains get realized far more readily than losses.`)
  }
  if (Number.isFinite(x.holderQuality)) {
    parts.push(
      x.holderQuality < -0.05
        ? 'These holders lose money on average, which makes them more likely to be reacting than positioning.'
        : x.holderQuality > 0.05
          ? 'These holders make money on average, so their selling is more likely to be deliberate than panicked.'
          : 'These holders are roughly break-even on average.',
    )
  }
  parts.push(`Covers ${pct(x.coverage)} of scanned holder value across ${x.traders} profiled wallets.`)
  return parts.join(' ')
}

export const HOLDER_PARAMS = {
  MIN_TRADES_FOR_PROFILE, MIN_PROFILED_HOLDERS, MIN_VALUE_COVERAGE,
  MIN_BEHAVIORAL_SHARE, PAPER_HAND_CUT, PRESSURE_SATURATION,
}
