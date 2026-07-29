// POST-DEPLOY SMOKE TEST — verifies a live deployment end to end.
//
// Preflight proves the code works against real chain data on your machine. This
// proves the DEPLOYMENT works: routes resolve, env vars are set, edge functions run,
// the share card renders as a real PNG, and the rewrite that makes share links work
// is actually wired.
//
//   node scripts/smoke.mjs https://your-deployment.vercel.app
//
// Read-only against your own deployment. Exits non-zero on any blocker.

const BASE = (process.argv[2] || '').replace(/\/$/, '')
const C = { ok: '\x1b[32m', bad: '\x1b[31m', warn: '\x1b[33m', dim: '\x1b[2m', off: '\x1b[0m', b: '\x1b[1m' }
let failures = 0
let warnings = 0
const pass = (m, d = '') => console.log(`   ${C.ok}OK${C.off}   ${m}${d ? ` ${C.dim}${d}${C.off}` : ''}`)
const warn = (m, f) => { warnings++; console.log(`   ${C.warn}WARN${C.off} ${m}\n        ${C.dim}${f}${C.off}`) }
const fail = (m, f) => { failures++; console.log(`   ${C.bad}FAIL${C.off} ${m}\n        ${C.dim}FIX: ${f}${C.off}`) }
const step = (n, t) => console.log(`\n${C.b}${n}. ${t}${C.off}`)

if (!BASE || !/^https?:\/\//.test(BASE)) {
  console.log(`${C.bad}Usage:${C.off} node scripts/smoke.mjs https://your-deployment.vercel.app`)
  process.exit(1)
}

// A wallet verified to have real swap history, and a real memecoin mint.
const WALLET = 'CZu7w4JRtsa8Ny6c8Fux6qEsCV2FCeGxQ2S7cWbCFGMw'
const MINT = 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm'

const get = async (path, opts = {}) => {
  const t0 = Date.now()
  try {
    const r = await fetch(`${BASE}${path}`, { redirect: 'manual', ...opts })
    return { r, ms: Date.now() - t0 }
  } catch (e) {
    return { r: null, ms: Date.now() - t0, err: e.message }
  }
}

console.log(`${C.b}POLAXORY SMOKE TEST${C.off} — ${BASE}`)

step(1, 'The page loads')
{
  const { r, ms, err } = await get('/')
  if (!r) fail(`Could not reach the deployment. ${err || ''}`, 'Check the URL and that the deploy succeeded.')
  else if (r.status !== 200) fail(`GET / returned ${r.status}`, 'The build may have failed. Check the Vercel deployment log.')
  else {
    const html = await r.text()
    pass(`GET / -> 200`, `${ms}ms`)
    if (/See what the machine sees/.test(html)) pass('Page shell rendered')
    else fail('Page HTML does not contain the expected heading', 'The build output may be wrong; confirm output directory is dist.')
    if (/og:image/.test(html)) pass('Generic OG tags present')
    else warn('No OG tags on the root page', 'Shares of the bare domain will have no card.')
  }
}

step(2, 'The analyze API — env var and engine')
{
  const { r, ms } = await get(`/api/analyze?address=${WALLET}`)
  if (!r) fail('No response from /api/analyze', 'Is the api/ directory deployed as functions?')
  else if (r.status === 500) {
    const b = await r.text()
    fail(`/api/analyze returned 500: ${b.slice(0, 120)}`,
      'Almost certainly HELIUS_API_KEY is not set in Vercel. Project -> Settings -> Environment Variables, then redeploy.')
  } else if (r.status !== 200) {
    fail(`/api/analyze returned ${r.status}`, 'Check the function log in Vercel.')
  } else {
    const j = await r.json()
    pass(`/api/analyze -> 200`, `${ms}ms`)
    if (j.scorecard && j.diagnosis) pass('Returned a full read', `${j.scorecard.closedTrades} closed trades, ${j.confidence?.label}`)
    else fail('Response is missing scorecard/diagnosis', 'The engine did not run; check the function log.')
    if (j.cohort?.store?.durable) pass('Cohort store is LIVE — percentiles will accrue', j.cohort.version)
    else warn('Cohort store not configured, so every scan is thrown away.',
      'Add a free Vercel KV / Upstash database and set KV_REST_API_URL + KV_REST_API_TOKEN. This is the only compounding asset in the project.')
    if (j.openBags?.basis && j.openBags.basis !== 'none') {
      pass(`Open positions basis: ${j.openBags.basis}`, j.openBags.basis === 'cost' ? 'no price source reached' : 'marks are live')
    }
    if (ms > 9000) warn(`Slow: ${ms}ms`, 'Close to the function timeout. Consider fewer pages in api/analyze.js.')
  }
}

step(3, 'The share card renders as a real image')
{
  const { r, ms } = await get(`/api/card?address=${WALLET}`)
  if (!r) fail('No response from /api/card', 'Edge function may not have deployed.')
  else if (r.status !== 200) fail(`/api/card returned ${r.status}`, 'Check the edge function log; @vercel/og must be installed.')
  else {
    const type = r.headers.get('content-type') || ''
    const buf = Buffer.from(await r.arrayBuffer())
    if (!/image\/png/.test(type)) fail(`Card content-type is "${type}", not image/png`, 'Social platforms will not render it.')
    else pass('Card is a PNG', `${(buf.length / 1024).toFixed(0)}kB, ${ms}ms`)
    // PNG magic number — proves it is a real image, not an error page with a good header.
    if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
      pass('PNG signature valid — this is a genuine image')
    } else fail('Bytes are not a valid PNG', 'The image renderer failed; check the edge log.')
    if (r.headers.get('cache-control')?.includes('s-maxage')) pass('CDN caching set', r.headers.get('cache-control'))
  }
}

step(4, 'Share links — the rewrite that makes crawlers work')
{
  const { r } = await get(`/w/${WALLET}`)
  if (!r) fail('No response from /w/<address>', 'The rewrite in vercel.json may not have applied.')
  else if (r.status !== 200) fail(`/w/<address> returned ${r.status}`, 'Confirm vercel.json rewrites deployed.')
  else {
    const html = await r.text()
    pass('/w/<address> -> 200')
    const og = html.match(/property="og:title" content="([^"]+)"/)
    if (og) pass('Per-wallet OG title present', `"${og[1].slice(0, 60)}"`)
    else fail('No per-wallet og:title', 'Crawlers will show generic copy. Check api/share.js.')
    if (/twitter:card" content="summary_large_image/.test(html)) pass('Twitter large-image card declared')
    else warn('No twitter:card tag', 'X may render a small card.')
    if (new RegExp(`/api/card\\?address=${WALLET}`).test(html)) pass('Card URL points at this wallet')
    else fail('og:image does not reference the wallet', 'The card would be generic.')
    if (/location\.replace/.test(html)) pass('Humans get bounced into the app')
  }
}

step(5, 'The Score endpoint')
{
  const { r, ms } = await get(`/api/score?mint=${MINT}`)
  if (!r) fail('No response from /api/score', 'Check the function deployed.')
  else if (r.status === 504) {
    fail(`/api/score timed out (504) after ${ms}ms`,
      'Lower HOLDERS_FETCHED or PROFILE_BUDGET_MS in api/score.js, or raise maxDuration in vercel.json if your plan allows.')
  } else if (r.status !== 200) {
    const b = await r.text()
    fail(`/api/score returned ${r.status}: ${b.slice(0, 120)}`, 'Check the function log.')
  } else {
    const j = await r.json()
    pass(`/api/score -> 200`, `${ms}ms`)
    const t = j.totals || {}
    console.log(`        ${C.dim}score ${j.score ?? '—'} (${j.grade}) · scanned ${t.scanned} · profiled ${t.profiled} · depth ${t.poolLiquiditySol?.toFixed(0) ?? '—'} SOL${C.off}`)
    if (j.score === null && j.gates?.length) {
      pass('Withheld with stated reasons rather than guessing', j.gates[0].slice(0, 70))
    }
    if (t.scanned > 0) pass(`Holder scan works`, `${t.scanned} holders of ${t.totalHolders} known`)
    else fail('Zero holders scanned', 'getTokenAccounts may not be enabled for this key.')
    if (ms > 20000) warn(`Slow: ${ms}ms`, 'Tune PROFILE_BUDGET_MS in api/score.js.')
  }
}

step(6, 'Bad input fails cleanly')
{
  const { r } = await get('/api/analyze?address=notawallet')
  if (r?.status === 400) pass('Invalid address -> 400 with a message')
  else warn(`Invalid address returned ${r?.status}`, 'Should be a 400.')
  const { r: r2 } = await get('/api/card?address=notawallet')
  if (r2?.status === 200 && /image\/png/.test(r2.headers.get('content-type') || '')) {
    pass('Invalid address still yields a generic card', 'a broken image in a post is worse than a plain one')
  } else warn('Card did not fall back to the generic image', 'Check the guard in api/card.js.')
}

console.log(`\n${'='.repeat(68)}`)
if (!failures && !warnings) console.log(`${C.ok}${C.b}DEPLOYMENT CLEAN${C.off} — every surface is live. Ship the link.`)
else if (!failures) console.log(`${C.warn}${C.b}DEPLOYMENT LIVE with ${warnings} warning(s)${C.off} — usable now; read them.`)
else console.log(`${C.bad}${C.b}DEPLOYMENT HAS ${failures} BLOCKER(S)${C.off}, ${warnings} warning(s)`)
console.log('='.repeat(68))
process.exit(failures ? 1 : 0)
