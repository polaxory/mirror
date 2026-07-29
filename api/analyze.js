// Vercel serverless function: GET /api/analyze?address=<solana pubkey>
//
// Orchestration only — validate, fetch, hand to the engine, contribute to the
// cohort. No analysis happens in this file.
//
// Env: HELIUS_API_KEY (required)
//      KV_REST_API_URL + KV_REST_API_TOKEN (optional; enables the measured cohort)

import { createHash } from 'node:crypto'
import { analyze } from './_lib/engine.js'
import { buildLadders, summarize } from './_lib/cohort.js'
import { readRecords, recordWallet, storeStatus } from './_lib/store.js'
import { fetchPriceBook } from './_lib/prices.js'
import { fetchTransactions, isAddress } from './_lib/chain.js'

const MAX_PAGES = 4

// The cohort dedupes repeat scans but has no business knowing whose wallet it was.
// A salted hash gives us identity-free dedupe; set COHORT_SALT to make the mapping
// unreproducible by anyone holding the stored records.
const SALT = process.env.COHORT_SALT || 'polaxory-cohort-v1'
const hashWallet = (addr) => createHash('sha256').update(`${SALT}:${addr}`).digest('hex').slice(0, 24)

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  const address = (req.query.address || '').trim()
  if (!isAddress(address)) {
    return res.status(400).json({ error: 'That does not look like a Solana address.' })
  }
  const key = process.env.HELIUS_API_KEY
  if (!key) return res.status(500).json({ error: 'Server missing HELIUS_API_KEY.' })

  // ---- fetch
  const chain = await fetchTransactions(address, { pages: MAX_PAGES })
  if (chain.rateLimited && chain.txs.length === 0) {
    return res.status(429).json({ error: 'The machine is rate-limited right now. Try again in a minute.' })
  }
  if (chain.txs.length === 0) {
    return res.status(404).json({ error: chain.note || 'No transaction history found for that address.' })
  }
  const txs = chain.txs

  // ---- reference distribution: measured where the cohort can carry it
  let ladders
  let cohort
  try {
    const records = await readRecords()
    const built = buildLadders(records)
    ladders = built.ladders
    cohort = { ...built.cohort, store: storeStatus() }
  } catch {
    ladders = undefined // engine falls back to priors
    cohort = undefined
  }

  // ---- open positions need a first pass to know WHICH mints to price. Running
  // the engine twice is cheap (it is pure, in-memory arithmetic) and far cleaner
  // than teaching the engine to fetch, which would end its purity for one field.
  const dry = analyze(txs, address, { ladders, cohort })
  let prices
  if (dry.openBags.count > 0) {
    try {
      // Cost-ordered and wider than the display list, since the totals cover every
      // bag. Anything past the adapter's cap is reported as skipped, never guessed.
      prices = await fetchPriceBook(dry.openBags.pricingMints)
    } catch { /* cost basis */ }
  }

  // ---- analyze
  const result = prices ? analyze(txs, address, { ladders, cohort, prices }) : dry

  // ---- contribute back, after the response is composed and never blocking it.
  // A cohort write must never be able to fail a read.
  const rec = summarize(result, hashWallet(address))
  const contribute = rec ? recordWallet(rec) : Promise.resolve({ admitted: false, reason: 'below cohort minimum' })

  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=3600')
  res.status(200).json(result)

  try { await contribute } catch { /* never surfaces */ }
}
