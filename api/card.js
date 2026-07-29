// GET /api/card?address=<pubkey>  ->  1200x630 PNG
//
// The image social platforms fetch. It re-analyzes from the address rather than
// accepting the verdict as URL parameters: a card whose contents can be forged in
// a query string is a card that can put our name on a claim the machine never
// made. Costs a Helius read per cold cache, which the CDN absorbs.
//
// Read-only by design — the card never contributes to the cohort. Crawlers would
// otherwise be voting on the reference distribution.

import { ImageResponse } from '@vercel/og'
import { analyze } from './_lib/engine.js'
import { buildLadders } from './_lib/cohort.js'
import { readRecords } from './_lib/store.js'
import { buildCardModel, cardTree, genericCardModel, CARD_SIZE } from './_lib/card.js'
import { fetchTransactions, isAddress } from './_lib/chain.js'

export const config = { runtime: 'edge' }

const PAGES = 3 // the card needs the verdict, not the ledger

const png = (tree) =>
  new ImageResponse(tree, {
    ...CARD_SIZE,
    headers: {
      // Long CDN life, because a wallet's history changes slowly and crawlers hit
      // this repeatedly. Stale-while-revalidate keeps it warm without blocking.
      'Cache-Control': 'public, s-maxage=1800, stale-while-revalidate=86400',
    },
  })

export default async function handler(req) {
  const url = new URL(req.url)
  const address = (url.searchParams.get('address') || '').trim()

  // A broken image in a shared post is worse than a plain one, so every failure
  // path renders the generic card instead of an error.
  if (!isAddress(address) || !process.env.HELIUS_API_KEY) {
    return png(cardTree(genericCardModel()))
  }

  try {
    const { txs } = await fetchTransactions(address, { pages: PAGES })
    if (txs.length === 0) return png(cardTree(genericCardModel()))

    let ladders, cohort
    try {
      const built = buildLadders(await readRecords())
      ladders = built.ladders
      cohort = built.cohort
    } catch { /* priors */ }

    const result = analyze(txs, address, { ladders, cohort })
    return png(cardTree(buildCardModel(result)))
  } catch {
    return png(cardTree(genericCardModel()))
  }
}
