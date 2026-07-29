// GET /w/<address>  (rewritten here by vercel.json)
//
// A share URL has two audiences with incompatible needs:
//   * crawlers (X, Discord, Slack, iMessage) do not run JavaScript, so the meta
//     tags must exist in the HTML the server returns;
//   * humans want the live app.
// So this returns a small document carrying the tags and bouncing people into the
// SPA. That is the whole reason this route exists rather than reusing index.html —
// a Vite SPA's static tags can only ever describe the site, never the wallet.
//
// The verdict text is fetched server-side so the card's title and description
// match the image. Failure degrades to generic copy rather than an error page.

import { analyze } from './_lib/engine.js'
import { fetchTransactions, isAddress } from './_lib/chain.js'

export const config = { runtime: 'edge' }

const PAGES = 3

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

const GENERIC = {
  title: 'Polaxory Mirror — see what the machine sees',
  desc: 'Paste a Solana wallet. The engine rebuilds every closed trade, measures the habits behind it, and states only what the sample can prove.',
}

export default async function handler(req) {
  const url = new URL(req.url)
  const address = (url.searchParams.get('address') || '').trim()
  const origin = url.origin
  const valid = isAddress(address)

  let meta = { ...GENERIC }
  let image = `${origin}/api/card`

  if (valid) {
    image = `${origin}/api/card?address=${encodeURIComponent(address)}`
    try {
      const { txs } = await fetchTransactions(address, { pages: PAGES })
      if (txs.length) {
        const res = analyze(txs, address)
        const arch = res.archetype?.primary?.name
        const score = Number.isFinite(res.score?.value) ? `${res.score.value}/100 ${res.score.grade}` : 'not scored'
        meta = {
          title: `${res.diagnosis.headline} — Polaxory Mirror`,
          desc: `${arch ? `${arch}. ` : ''}Exploitability ${score}. ${res.scorecard.closedTrades} closed trades, ${res.confidence.label.toLowerCase()} read.`,
        }
      }
    } catch { /* generic copy */ }
  }

  // Humans land here too (the rewrite is audience-blind), so bounce them into the
  // app with the address in a query param the SPA reads on mount.
  const target = valid ? `/?w=${encodeURIComponent(address)}` : '/'

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(meta.title)}</title>
<meta name="description" content="${esc(meta.desc)}" />
<meta property="og:type" content="website" />
<meta property="og:title" content="${esc(meta.title)}" />
<meta property="og:description" content="${esc(meta.desc)}" />
<meta property="og:image" content="${esc(image)}" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${esc(meta.title)}" />
<meta name="twitter:description" content="${esc(meta.desc)}" />
<meta name="twitter:image" content="${esc(image)}" />
<link rel="canonical" href="${esc(origin)}${esc(target)}" />
<meta http-equiv="refresh" content="0; url=${esc(target)}" />
<style>
  body{background:#0d0d0d;color:#c3c2b7;font-family:system-ui,sans-serif;margin:0;
       display:flex;align-items:center;justify-content:center;height:100vh;text-align:center}
  a{color:#9085e9}
</style>
</head>
<body>
<div>
  <p>Opening the Mirror…</p>
  <p><a href="${esc(target)}">Continue</a></p>
</div>
<script>location.replace(${JSON.stringify(target)})</script>
</body>
</html>`

  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, s-maxage=1800, stale-while-revalidate=86400',
    },
  })
}
