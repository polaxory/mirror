// PREFLIGHT — the first time this code touches reality.
//
// Everything in this repo was built and tested against synth.js: 536 assertions,
// six suites, zero real transactions. That is a foundation nobody has stood on yet,
// and this script is how you find out whether it holds before a user does.
//
// It checks every live assumption the product makes, in dependency order, and prints
// exactly what to do about each failure. Read-only: it writes nothing anywhere.
//
//   HELIUS_API_KEY=xxxx node scripts/preflight.mjs
//   HELIUS_API_KEY=xxxx node scripts/preflight.mjs <wallet> <mint>

import { fetchTransactions, fetchTokenHolders, fetchMintDecimals, isAddress } from '../api/_lib/chain.js'
import { fetchPriceBook } from '../api/_lib/prices.js'
import { analyze, classify } from '../api/_lib/engine.js'
import { buildCardModel } from '../api/_lib/card.js'
import { summarize } from '../api/_lib/cohort.js'
import { storeStatus } from '../api/_lib/store.js'

const C = { ok: '\x1b[32m', bad: '\x1b[31m', warn: '\x1b[33m', dim: '\x1b[2m', off: '\x1b[0m', b: '\x1b[1m' }
let failures = 0
let warnings = 0

const step = (n, t) => console.log(`\n${C.b}${n}. ${t}${C.off}`)
const pass = (m, d = '') => console.log(`   ${C.ok}OK${C.off}   ${m}${d ? ` ${C.dim}${d}${C.off}` : ''}`)
const warn = (m, fix) => { warnings++; console.log(`   ${C.warn}WARN${C.off} ${m}\n        ${C.dim}${fix}${C.off}`) }
const fail = (m, fix) => { failures++; console.log(`   ${C.bad}FAIL${C.off} ${m}\n        ${C.dim}FIX: ${fix}${C.off}`) }

// Read targets only. Pass your own as arguments — a wallet whose history you
// remember makes step 4 far more informative, because you can check the numbers
// against what you know actually happened.
// Verified live 2026-07-28: an ordinary retail wallet with real swap history, found
// by scanning a memecoin's holder list — which is how the product finds wallets
// anyway. USDC was the original fixture and it was a bad one: as a quote token it has
// no pairs where it is the base against SOL, so it exercised none of the paths that
// matter. A memecoin is the real target.
const WALLET = process.argv[2] || 'CZu7w4JRtsa8Ny6c8Fux6qEsCV2FCeGxQ2S7cWbCFGMw'
const MINT = process.argv[3] || 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm' // WIF

console.log(`${C.b}POLAXORY PREFLIGHT${C.off} — first contact with real data`)
console.log(`${C.dim}wallet ${WALLET}`)
console.log(`mint   ${MINT}${C.off}`)

function report() {
  console.log(`\n${'='.repeat(68)}`)
  if (failures === 0 && warnings === 0) {
    console.log(`${C.ok}${C.b}PREFLIGHT CLEAN${C.off} — the code holds on real data. Ship it.`)
  } else if (failures === 0) {
    console.log(`${C.warn}${C.b}PREFLIGHT PASSED with ${warnings} warning(s)${C.off} — safe to deploy; read them.`)
  } else {
    console.log(`${C.bad}${C.b}PREFLIGHT FAILED — ${failures} blocker(s), ${warnings} warning(s)${C.off}`)
    console.log(`${C.dim}Do not deploy until the blockers clear. Each prints its own fix.${C.off}`)
  }
  console.log('='.repeat(68))
}

// ---------------------------------------------------------------- 1. environment
step(1, 'Environment')
if (!process.env.HELIUS_API_KEY) {
  fail('HELIUS_API_KEY is not set — nothing below can run.',
    'Free key at https://dev.helius.xyz then: HELIUS_API_KEY=xxx node scripts/preflight.mjs')
  report()
  process.exit(1)
}
pass('HELIUS_API_KEY present')
const store = storeStatus()
if (store.durable) pass('Cohort store is durable', 'Redis reachable, percentiles will accrue')
else warn('No cohort store configured, so percentiles stay on research-derived priors.',
  'Free Vercel KV or Upstash, then set KV_REST_API_URL + KV_REST_API_TOKEN. This is the only compounding asset in the project; every scan without it is thrown away.')
if (!process.env.COHORT_SALT) {
  warn('COHORT_SALT unset, so the default salt is in use.',
    'Set it to any random string before going live, or stored hashes are reversible against a wallet list by anyone reading the source.')
}

// ---------------------------------------------------------------- 2. transactions
step(2, 'Helius transactions — the shape every metric depends on')
const txRes = await fetchTransactions(WALLET, { pages: 4 })
if (!txRes.ok) {
  fail(`No transactions returned. ${txRes.note || ''}`,
    'Check the key is valid and the wallet has history. If the key is fine, the v0 endpoint may have changed — see fetchTransactions in api/_lib/chain.js.')
} else {
  pass(`${txRes.txs.length} transactions over ${txRes.pages} page(s)`)
  const t = txRes.txs[0]
  const fields = ['timestamp', 'signature', 'nativeTransfers', 'tokenTransfers', 'feePayer', 'fee']
  const missing = fields.filter((f) => t[f] === undefined)
  if (missing.length) {
    fail(`Transaction objects missing: ${missing.join(', ')}`,
      'The engine reads exactly these. Missing fields make classify() return nulls silently — compare the Helius schema against solLegs()/tokenDeltas() in engine.js.')
  } else pass('Every field the engine reads is present', fields.join(', '))

  const classified = txRes.txs.map((x) => classify(x, WALLET)).filter(Boolean)
  const kinds = classified.reduce((m, e) => ({ ...m, [e.kind]: (m[e.kind] || 0) + 1 }), {})
  if (classified.length === 0) {
    fail('Zero transactions classified as buy/sell/rotation.',
      'This is the failure that would invalidate everything downstream. Either this wallet never swapped, or real transfer shapes differ from synth.js. Retry with a known active trading wallet before concluding the parser is wrong.')
  } else {
    pass(`${classified.length} of ${txRes.txs.length} classified`, JSON.stringify(kinds))
    // Cross-check against Helius's own labelling. If it calls something a SWAP and
    // the classifier does not, activity is being dropped silently — the single most
    // dangerous failure here, because every metric would look plausible and be wrong.
    const heliusSwaps = txRes.txs.filter((t) => t.type === 'SWAP')
    if (heliusSwaps.length) {
      const missed = heliusSwaps.filter((t) => !classify(t, WALLET))
      if (missed.length === 0) {
        pass(`Classifier catches all ${heliusSwaps.length} transactions Helius labels SWAP`, 'no activity dropped')
      } else {
        const rate = missed.length / heliusSwaps.length
        const msg = `${missed.length} of ${heliusSwaps.length} Helius SWAPs not classified (${Math.round(rate * 100)}%)`
        if (rate > 0.25) fail(msg, `Real swap shapes are being dropped. Dump one: ${missed[0].signature} — compare its transfers against classify() in engine.js.`)
        else warn(msg, `Some routes are unrecognised. Sample: ${missed[0].signature}. Tolerable if these are multi-token routes; investigate if the share grows.`)
      }
    }
    if (kinds.rotation) {
      const routed = classified.filter((e) => e.kind === 'rotation' && e.grossSolIn > 0).length
      if (routed) pass(`${routed} rotation(s) carry gross wrapped-SOL legs`, 'the v2.4 valuation path is live')
      else warn(`${kinds.rotation} rotation(s), none with visible wrapped-SOL legs.`,
        'Expected for direct pool swaps, which basis-rollover handles. But if NO rotation ever shows gross legs on real data, the routed-valuation path is dead code — confirm against a known Jupiter swap.')
    }
  }
}

// ---------------------------------------------------------------- 3. prices
step(3, 'DexScreener prices — the adapter most likely to have drifted')
const book = await fetchPriceBook([MINT])
if (!book.ok) {
  warn(`No price returned. ${book.note || ''}`,
    'This is the designed fail-closed path, so open positions fall back to cost basis. But if it never succeeds, marks are dead code — verify the response against bestPair() in api/_lib/prices.js.')
} else {
  const e = book.entries[MINT]
  pass('Price returned', `${e.solPrice} SOL/token via ${e.dex || 'unknown dex'}`)
  if (Number.isFinite(e.liquiditySol) && e.liquiditySol > 0) {
    pass('Pool depth in SOL available', `${e.liquiditySol.toFixed(1)} SOL — exit-impact bound works`)
  } else {
    fail('No SOL-denominated pool depth.',
      'Without depth there is no exit-impact bound and no holder pressure, so /api/score cannot produce a number. Check liquidity.quote / liquidity.usd in the DexScreener payload.')
  }
}

// ---------------------------------------------------------------- 4. the engine
step(4, 'Engine on real data — does the read survive reality')
if (txRes.ok) {
  const r = analyze(txRes.txs, WALLET, book.ok ? { prices: book } : {})
  const sc = r.scorecard
  pass(`${sc.closedTrades} closed trades, ${r.confidence.label} confidence`)
  if (sc.closedTrades > 0) {
    console.log(`        ${C.dim}net ${sc.netPnlSol?.toFixed(3)} SOL · toll ${sc.tollSol?.toFixed(4)} SOL · win rate ${(sc.winRate.point * 100).toFixed(0)}%${C.off}`)
    console.log(`        ${C.dim}${r.diagnosis.headline} — ${r.archetype.primary?.name || 'unread'}${C.off}`)

    const ids = [
      ['gross win - gross loss = net', Math.abs(sc.grossWinSol - sc.grossLossSol - sc.netPnlSol)],
      ['selection = net + toll', Math.abs(sc.selectionPnlSol - (sc.netPnlSol + sc.tollSol))],
      ['equity ends at net', Math.abs(sc.equity[sc.equity.length - 1].cum - sc.netPnlSol)],
      ['wins + losses = trades', Math.abs(sc.winsLosses[0] + sc.winsLosses[1] - sc.closedTrades)],
    ]
    const broken = ids.filter(([, d]) => d > 1e-6)
    if (broken.length) {
      fail(`Accounting identities broken on real data: ${broken.map(([n]) => n).join('; ')}`,
        'The ledger produces inconsistent totals on real transaction shapes. Do not ship. Save these transactions as a fixture and reproduce in tests/.')
    } else pass('All four accounting identities hold on real data')

    const nonFinite = ['netPnlSol', 'tollSol', 'turnoverSol', 'peakCapitalSol']
      .filter((k) => sc[k] !== null && !Number.isFinite(sc[k]))
    if (nonFinite.length) fail(`Non-finite scorecard values: ${nonFinite.join(', ')}`,
      'A NaN or Infinity is leaking from real data. Trace it before shipping.')
    else pass('No NaN or Infinity in the scorecard')

    const card = buildCardModel(r)
    if (!card.headline || !card.seam) {
      fail('Card model incomplete on real data', 'The share card would render blank.')
    } else pass('Share-card model builds', `"${card.headline}"`)

    const rec = summarize(r, 'preflight-hash')
    if (sc.closedTrades >= 8 && !rec) {
      warn('Wallet qualifies but produced no cohort record.',
        'Check summarize(). The cohort cannot accrue if real wallets fail to produce records.')
    } else if (rec) {
      const leaks = JSON.stringify(rec).includes(WALLET)
      if (leaks) fail('The cohort record contains the wallet address.', 'It must only ever carry the hash.')
      else pass('Produces a clean cohort record', `${Object.keys(rec).length} fields, no address inside`)
    }
  } else {
    warn('This wallet has no closed SOL-quoted trades, so the engine was not exercised.',
      'Re-run with an active trading wallet as the first argument. This step is the entire point of preflight.')
  }
}

// ---------------------------------------------------------------- 5. holders
step(5, 'Holder scan — the /api/score path, never once run live')
const dec = await fetchMintDecimals(MINT)
if (dec === null) {
  fail('Could not read mint decimals.',
    'Without decimals every holder position is scaled wrong by orders of magnitude. Check getAsset -> result.token_info.decimals in fetchMintDecimals.')
} else pass(`Mint decimals: ${dec}`)

const hRes = await fetchTokenHolders(MINT, { limit: 12 })
if (!hRes.ok) {
  fail(`Holder lookup failed. ${hRes.note || ''}`,
    'Confirm the getTokenAccounts DAS method is enabled for your key and that result.token_accounts[].owner/.amount still exist. Without this /api/score cannot run at all.')
} else {
  pass(`${hRes.holders.length} holders returned of ${hRes.total} known`)
  const top = hRes.holders[0]
  if (!isAddress(top.owner)) {
    fail('Holder owner is not an address', 'The owner field may have moved in the DAS response.')
  } else if (dec !== null) {
    pass('Top holder parsed', `${Math.round(top.amountRaw / 10 ** dec).toLocaleString()} tokens`)
    console.log(`        ${C.dim}Large holders are often pools, programs or exchange wallets. They have no`)
    console.log(`        realized history and are correctly excluded — but they dilute coverage, which`)
    console.log(`        is why the known-address list is the cheapest real fix for /api/score.${C.off}`)
  }
}

report()
process.exit(failures ? 1 : 0)
