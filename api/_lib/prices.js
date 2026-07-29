// Price adapter. One of three named I/O adapters under api/_lib (with store.js and
// chain.js); every other file in the analytical core is pure.
//
// Source: DexScreener's public token endpoint. Chosen over a plain price oracle for
// three reasons that matter specifically for memecoin bags:
//   * priceNative is quoted in the pair's quote token, so a SOL-quoted pair gives a
//     SOL price directly — the same unit as our cost basis, no conversion guesswork;
//   * it returns pool LIQUIDITY, which is what makes a mark honest. A price with no
//     depth behind it is a number, not an exit;
//   * free, no key, so the $0 deployment keeps working.
//
// Every failure mode returns ok:false rather than throwing. An unavailable price
// source must degrade the read to cost basis, never break it.

const ENDPOINT = 'https://api.dexscreener.com/latest/dex/tokens/'
const MAX_MINTS_PER_CALL = 30
const WSOL = 'So11111111111111111111111111111111111111112'

// Pick the pair a mark should be read from: the deepest SOL-quoted pool whose price
// AGREES WITH ITS PEERS, falling back to the deepest pool of any quote.
//
// Depth alone is not enough. The SOL/USD bug above proved a manipulated pool can
// carry six figures of reported liquidity while quoting a price off by four orders of
// magnitude, so "deepest" can still be "wrong". The consensus filter requires the
// chosen pool to sit within a band of the median price across its peers — a lie has
// to be told by most of the pools, not one, before it sets a mark.
const CONSENSUS_BAND = 5

function bestPair(pairs, mint) {
  const mine = (pairs || []).filter(
    (p) => p && p.baseToken?.address === mint && Number(p.priceNative) > 0,
  )
  if (!mine.length) return null
  const liq = (p) => Number(p.liquidity?.usd) || 0
  const solQuoted = mine.filter((p) => p.quoteToken?.address === WSOL)
  const field = solQuoted.length ? solQuoted : mine

  const mid = median(field.map((p) => Number(p.priceNative)))
  const byDepth = [...field].sort((a, b) => liq(b) - liq(a))
  if (!Number.isFinite(mid) || mid <= 0 || field.length < 3) return byDepth[0] || null

  const agrees = byDepth.filter((p) => {
    const n = Number(p.priceNative)
    return n / mid <= CONSENSUS_BAND && mid / n <= CONSENSUS_BAND
  })
  // If nothing agrees with the median there is no consensus to defer to, so fall
  // back to depth rather than inventing one.
  return agrees[0] || byDepth[0] || null
}

// SOL/USD, needed to express pool depth in SOL when a pool reports only USD
// liquidity. WSOL rides along in every request batch to supply it.
//
// TAKE THE MEDIAN, never the first match. A live check found the first WSOL pair in
// DexScreener's response order quoting SOL at $0.008 — a pool against a lookalike
// "USDC.s" on an obscure venue — while the median of twenty pairs was $73.14. Reading
// the first match scaled every derived depth figure by roughly nine thousand times.
//
// A liquidity floor would NOT have caught it: that pool reported $153k of liquidity.
// Only the median is robust here, because it needs a majority of pools to be wrong
// rather than one. This is the class of defect no synthetic fixture ever produces,
// since a generator does not invent scam pools.
function median(xs) {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

function solUsdFrom(pairs) {
  const direct = []
  const implied = []
  for (const p of pairs || []) {
    const usd = Number(p?.priceUsd)
    if (!Number.isFinite(usd) || usd <= 0) continue
    if (p.baseToken?.address === WSOL) direct.push(usd)
    else if (p.quoteToken?.address === WSOL) {
      const nat = Number(p.priceNative)
      if (Number.isFinite(nat) && nat > 0) implied.push(usd / nat)
    }
  }
  return median(direct) ?? median(implied)
}

async function callOnce(batch, timeoutMs) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetch(`${ENDPOINT}${batch.join(',')}`, {
      signal: ctl.signal,
      headers: { accept: 'application/json' },
    })
    if (!res.ok) return null
    const json = await res.json()
    // Tolerate either { pairs: [...] } or a bare array — an unexpected shape is
    // treated as no data rather than parsed optimistically.
    const pairs = Array.isArray(json?.pairs) ? json.pairs : Array.isArray(json) ? json : null
    return pairs
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

// Exported for regression testing. The median-anchor bug below was found on live
// data and cannot be caught by any synthetic fixture, so the real payload shape that
// broke it is pinned in tests/prices.mjs.
export const __test = { solUsdFrom, bestPair, median }

// mints: array of mint addresses, ideally ordered by importance (largest basis
// first) since anything past the request cap is reported as skipped, not guessed.
export async function fetchPriceBook(mints, { timeoutMs = 4500, maxMints = MAX_MINTS_PER_CALL } = {}) {
  const wanted = [...new Set((mints || []).filter((m) => typeof m === 'string' && m.length > 30))]
  if (!wanted.length) {
    return { ok: false, source: 'dexscreener', entries: {}, skipped: [], solUsd: null,
      note: 'No mints to price.' }
  }
  const take = wanted.slice(0, maxMints)
  const skipped = wanted.slice(maxMints)

  // WSOL is requested alongside the real targets purely as a SOL/USD anchor, so a
  // token with no SOL-quoted pool can still have its depth expressed in SOL.
  const requested = take.includes(WSOL) ? take : [...take, WSOL]
  const pairs = await callOnce(requested, timeoutMs)
  if (!pairs) {
    return { ok: false, source: 'dexscreener', entries: {}, skipped: wanted, solUsd: null,
      note: 'Price source unavailable or returned an unexpected shape; open positions fall back to cost basis.' }
  }

  const solUsd = solUsdFrom(pairs)
  const entries = {}
  for (const mint of take) {
    const p = bestPair(pairs, mint)
    if (!p) continue
    const solPrice = Number(p.priceNative)
    if (!Number.isFinite(solPrice) || solPrice <= 0) continue
    const liqUsd = Number(p.liquidity?.usd)
    // Quote-side depth is the SOL actually in the pool. Prefer it; otherwise derive
    // from USD liquidity and the implied SOL price.
    const quoteSol = p.quoteToken?.address === WSOL ? Number(p.liquidity?.quote) : NaN
    const liqSol = Number.isFinite(quoteSol) && quoteSol > 0
      ? quoteSol
      : Number.isFinite(liqUsd) && solUsd ? liqUsd / solUsd : null
    entries[mint] = {
      solPrice,
      usdPrice: Number.isFinite(Number(p.priceUsd)) ? Number(p.priceUsd) : null,
      liquiditySol: Number.isFinite(liqSol) ? liqSol : null,
      liquidityUsd: Number.isFinite(liqUsd) ? liqUsd : null,
      quoteIsSol: p.quoteToken?.address === WSOL,
      dex: p.dexId || null,
    }
  }

  const found = Object.keys(entries).length
  return {
    ok: found > 0,
    source: 'dexscreener',
    entries,
    skipped,
    solUsd,
    note: found === 0
      ? 'No tradable pool found for any open position; they are shown at cost basis.'
      : `Marked ${found} of ${take.length} requested position${take.length === 1 ? '' : 's'} from the deepest available pool.`,
  }
}
