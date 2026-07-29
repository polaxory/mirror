// Renders the share card locally so the layout can be eyeballed without a deploy.
//
// Uses the SAME cardTree() the edge function uses — satori ships inside
// @vercel/og, so this needs no extra dependency and cannot drift from production.
// Satori emits SVG; the edge function pipes that same SVG through resvg for PNG.
//
// Run: node scripts/preview-card.mjs   -> writes .card-preview/*.svg + index.html

import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import satori from 'satori'
import { analyze } from '../api/_lib/engine.js'
import { buildCardModel, cardTree, genericCardModel, CARD_SIZE } from '../api/_lib/card.js'
import { buildLadders } from '../api/_lib/cohort.js'
import { makeWallet, DEFAULTS } from '../tests/synth.js'
import { mulberry32 } from '../api/_lib/stats.js'

// Satori needs real font bytes. Production uses @vercel/og's bundled font; for the
// local preview any system sans will do — this only affects the preview's metrics.
const FONT_CANDIDATES = [
  '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
  '/System/Library/Fonts/Helvetica.ttc',
  '/System/Library/Fonts/Supplemental/Arial.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
]
const fontPath = FONT_CANDIDATES.find((p) => existsSync(p))
if (!fontPath) {
  console.error('No system font found for preview. Production is unaffected — @vercel/og bundles its own.')
  process.exit(1)
}
const fontData = readFileSync(fontPath)
const fonts = [
  { name: 'sans-serif', data: fontData, weight: 400, style: 'normal' },
  { name: 'sans-serif', data: fontData, weight: 700, style: 'normal' },
  { name: 'sans-serif', data: fontData, weight: 800, style: 'normal' },
]

// Cases worth looking at: the ones most likely to break layout or overclaim.
const CASES = [
  ['generic', genericCardModel()],
  ['exit-liquidity', model({ nTrades: 90, winRate: 0.22, winRet: 1.25, lossRet: 0.45,
    holdWinMin: 6, holdLossMin: 40, gapAfterLossMin: 6, gapAfterWinMin: 30,
    buySizeCV: 1.2, revengeSizeMult: 1.8, interfaceFeeRate: 0.01, seed: 7001 })],
  ['bagholder', model({ nTrades: 128, winRate: 0.31, winRet: 1.62, lossRet: 0.56, retJitter: 0.09,
    holdWinMin: 11, holdLossMin: 310, buySizeCV: 0.5, gapAfterLossMin: 7, gapAfterWinMin: 95,
    revengeSizeMult: 2.1, interfaceFeeRate: 0.009, openBags: 7, seed: 20260727 })],
  ['disciplined', model({ nTrades: 80, winRate: 0.55, winRet: 1.55, lossRet: 0.8,
    holdWinMin: 200, holdLossMin: 190, gapAfterLossMin: 240, gapAfterWinMin: 240,
    buySizeCV: 0.04, retJitter: 0.06, seed: 7002 })],
  // Named for what it actually produces: a provable positive edge. The unproven
  // quadrant is covered by just-under-floor below.
  ['positive-edge', model({ nTrades: 46, winRate: 0.48, winRet: 1.9, lossRet: 0.62, retJitter: 0.42,
    holdWinMin: 70, holdLossMin: 66, gapAfterLossMin: 80, gapAfterWinMin: 80,
    buySizeCV: 0.12, seed: 7013 })],
  // Below the scoring floor: the card must show a grade, never a number.
  ['thin-history', model({ nTrades: 9, winRate: 0.33, seed: 7004 })],
  ['just-under-floor', model({ nTrades: 18, winRate: 0.28, winRet: 1.3, lossRet: 0.5,
    holdWinMin: 8, holdLossMin: 300, seed: 7006 })],
  ['no-trades', buildCardModel(analyze([], 'nobody'))],
  ['with-cohort', modelWithCohort()],
]

function model(params) {
  return buildCardModel(analyze(makeWallet(params).txs, DEFAULTS.wallet))
}

function modelWithCohort() {
  const r = mulberry32(4)
  const recs = Array.from({ length: 640 }, (_, i) => ({
    h: `h${i}`, n: 40,
    dispositionRatio: 1 + r() * 40, panicIndex: r(), revengeRatio: 1 + r() * 15,
    sizingCV: r() * 2, expectancy: -0.5 + r(), profitFactor: r() * 3, tollRate: r() * 0.05,
  }))
  const { ladders, cohort } = buildLadders(recs)
  const res = analyze(
    makeWallet({ nTrades: 96, winRate: 0.3, winRet: 1.55, lossRet: 0.5, retJitter: 0.1,
      holdWinMin: 9, holdLossMin: 420, gapAfterLossMin: 5, gapAfterWinMin: 140,
      revengeSizeMult: 2.4, interfaceFeeRate: 0.012, seed: 7005 }).txs,
    DEFAULTS.wallet, { ladders, cohort },
  )
  return buildCardModel(res)
}

const outDir = new URL('../card-preview/', import.meta.url)
mkdirSync(outDir, { recursive: true })

const written = []
for (const [name, m] of CASES) {
  const svg = await satori(cardTree(m), { ...CARD_SIZE, fonts })
  writeFileSync(new URL(`${name}.svg`, outDir), svg)
  written.push({ name, m })
  console.log(`  ${name.padEnd(18)} "${m.headline}"`)
  console.log(`  ${''.padEnd(18)} score ${m.score.value ?? '—'} ${m.score.grade} · ${m.seam}`)
}

// One page to review every case at once, at real card proportions.
const html = `<!doctype html><meta charset="utf-8"><title>Polaxory card preview</title>
<style>
  body{background:#141414;color:#c3c2b7;font-family:system-ui,sans-serif;margin:0;padding:28px}
  h1{font-size:15px;letter-spacing:.18em;font-weight:800;color:#fff;margin:0 0 4px}
  p.note{font-size:12.5px;color:#898781;margin:0 0 26px;max-width:860px;line-height:1.6}
  figure{margin:0 0 30px}
  figcaption{font-size:12px;color:#898781;margin-bottom:8px;font-family:ui-monospace,Menlo,monospace}
  img{width:100%;max-width:1000px;display:block;border:1px solid rgba(255,255,255,.1);border-radius:12px}
</style>
<h1>POLAXORY — SHARE CARD PREVIEW</h1>
<p class="note">Rendered from the same cardTree() the edge function uses. Satori emits this SVG; production
pipes the identical tree through resvg to PNG. Layout, wrapping and gating are therefore faithful — only font
metrics differ, since the preview borrows a system font.</p>
${written.map(({ name }) => `<figure><figcaption>${name}.svg</figcaption><img src="${name}.svg" alt="${name} card"></figure>`).join('\n')}
`
writeFileSync(new URL('index.html', outDir), html)
console.log(`\n  ${written.length} cards -> card-preview/index.html`)
