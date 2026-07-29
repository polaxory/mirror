// Helius adapter. The THIRD and last sanctioned I/O file under api/_lib, alongside
// store.js (cohort persistence) and prices.js (open-position marks). Everything
// else in the analytical core stays pure.
//
// This exists because the same transaction-paging loop had been copy-pasted into
// analyze.js, card.js and share.js, and the holder endpoint would have made it a
// fourth. Three copies of a fetch loop is exactly the drift "work to code" forbids:
// a retry policy or a page cap fixed in one of them silently stays broken in the
// others.

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
const PAGE_LIMIT = 100

export const isAddress = (s) => typeof s === 'string' && BASE58.test(s.trim())

const key = () => process.env.HELIUS_API_KEY || ''

// ---------------------------------------------------------------- transactions

// Returns { ok, txs, pages, note }. Never throws: a caller that cannot reach the
// chain should degrade, not 500.
export async function fetchTransactions(address, { pages = 4, timeoutMs = 9000 } = {}) {
  if (!isAddress(address)) return { ok: false, txs: [], pages: 0, note: 'Not a Solana address.' }
  if (!key()) return { ok: false, txs: [], pages: 0, note: 'HELIUS_API_KEY is not set.' }

  const txs = []
  let before = ''
  let fetched = 0
  let rateLimited = false

  for (let p = 0; p < pages; p++) {
    const url =
      `https://api.helius.xyz/v0/addresses/${address}/transactions` +
      `?api-key=${key()}&limit=${PAGE_LIMIT}${before ? `&before=${before}` : ''}`
    // 429 gets retried with backoff rather than abandoned. A live holder scan at
    // concurrency 5 x 4 pages tripped the free-tier limiter constantly, and bailing
    // on the first 429 returned a truncated history that downstream code could not
    // distinguish from a wallet that had simply never traded. Reporting a throttled
    // wallet as "no trading history" is the exact class of quiet dishonesty this
    // project is built against.
    let batch = null
    for (let attempt = 0; attempt < 3; attempt++) {
      const ctl = new AbortController()
      const timer = setTimeout(() => ctl.abort(), timeoutMs)
      try {
        const res = await fetch(url, { signal: ctl.signal })
        if (res.status === 429) {
          rateLimited = true
          await new Promise((r) => setTimeout(r, 400 * (attempt + 1)))
          continue
        }
        if (!res.ok) break
        batch = await res.json()
        break
      } catch {
        break
      } finally {
        clearTimeout(timer)
      }
    }
    if (!Array.isArray(batch) || batch.length === 0) break
    txs.push(...batch)
    fetched++
    if (batch.length < PAGE_LIMIT) break
    before = batch[batch.length - 1].signature
  }

  // `truncated` is the load-bearing flag: it means the history we have is INCOMPLETE
  // for a reason that has nothing to do with the wallet. Callers must not treat it as
  // an absence of activity.
  return {
    ok: txs.length > 0,
    txs,
    pages: fetched,
    rateLimited,
    truncated: rateLimited && txs.length === 0,
    note: rateLimited
      ? 'Rate limited before the history was complete.'
      : txs.length === 0 ? 'No transaction history found.' : null,
  }
}

// ---------------------------------------------------------------- holders

// Helius DAS getTokenAccounts returns owner and amount together, which is what
// makes a holder scan one call instead of one call per token account. Returns
// holders sorted by balance, largest first.
export async function fetchTokenHolders(mint, { limit = 25, timeoutMs = 9000 } = {}) {
  if (!isAddress(mint)) return { ok: false, holders: [], total: 0, note: 'Not a mint address.' }
  if (!key()) return { ok: false, holders: [], total: 0, note: 'HELIUS_API_KEY is not set.' }

  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetch(`https://mainnet.helius-rpc.com/?api-key=${key()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctl.signal,
      body: JSON.stringify({
        jsonrpc: '2.0', id: 'polaxory-holders', method: 'getTokenAccounts',
        params: { mint, limit: 1000, page: 1, options: { showZeroBalance: false } },
      }),
    })
    if (!res.ok) return { ok: false, holders: [], total: 0, note: `Holder lookup failed (${res.status}).` }
    const json = await res.json()
    const accounts = json?.result?.token_accounts
    if (!Array.isArray(accounts)) {
      return { ok: false, holders: [], total: 0, note: 'Holder lookup returned an unexpected shape.' }
    }

    // One owner can hold across several token accounts; merge before ranking or the
    // same wallet would be profiled twice and counted as two holders.
    const byOwner = new Map()
    for (const a of accounts) {
      const owner = a?.owner
      const amt = Number(a?.amount)
      if (!isAddress(owner) || !Number.isFinite(amt) || amt <= 0) continue
      byOwner.set(owner, (byOwner.get(owner) || 0) + amt)
    }
    const all = [...byOwner].map(([owner, amountRaw]) => ({ owner, amountRaw }))
    all.sort((a, b) => b.amountRaw - a.amountRaw)
    const totalRaw = all.reduce((s, h) => s + h.amountRaw, 0)

    return {
      ok: all.length > 0,
      holders: all.slice(0, limit),
      total: all.length,
      totalRawSeen: totalRaw,
      truncated: all.length > limit,
      note: all.length === 0 ? 'No holders with a positive balance found.' : null,
    }
  } catch {
    return { ok: false, holders: [], total: 0, note: 'Could not reach the chain for holders.' }
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------- token decimals

// Raw amounts are meaningless without decimals, and a wrong exponent silently
// scales every position by orders of magnitude.
export async function fetchMintDecimals(mint, { timeoutMs = 6000 } = {}) {
  if (!isAddress(mint) || !key()) return null
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetch(`https://mainnet.helius-rpc.com/?api-key=${key()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctl.signal,
      body: JSON.stringify({
        jsonrpc: '2.0', id: 'polaxory-mint', method: 'getAsset', params: { id: mint },
      }),
    })
    if (!res.ok) return null
    const json = await res.json()
    const d = json?.result?.token_info?.decimals
    return Number.isInteger(d) ? d : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------- concurrency

// Bounded parallelism. A holder scan is dozens of wallet histories; firing them all
// at once gets the key rate-limited, and running them serially exceeds the function
// timeout. Neither failure is acceptable, so the pool size is explicit.
export async function mapWithLimit(items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const i = next++
      if (i >= items.length) return
      try { out[i] = await fn(items[i], i) } catch { out[i] = null }
    }
  })
  await Promise.all(workers)
  return out
}
