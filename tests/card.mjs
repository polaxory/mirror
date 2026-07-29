// Share card validation.
//
// The card is the most public thing the machine says, so it gets the strictest
// reading of the rule that nothing may claim more than the sample supports. These
// tests exist because a preview render caught the score printing "62/100 Farmable"
// beside a diagnosis reading "too early to say".
//
// Run: node tests/card.mjs

import { analyze } from '../api/_lib/engine.js'
import { buildCardModel, cardTree, genericCardModel, CARD_SIZE } from '../api/_lib/card.js'
import { buildLadders } from '../api/_lib/cohort.js'
import { makeWallet, DEFAULTS } from './synth.js'
import { mulberry32 } from '../api/_lib/stats.js'

let pass = 0, fail = 0
const failures = []
const ok = (c, name, detail = '') => {
  if (c) { pass++; console.log(`  \x1b[32mPASS\x1b[0m ${name}`) }
  else { fail++; failures.push(`${name} — ${detail}`); console.log(`  \x1b[31mFAIL\x1b[0m ${name}  ${detail}`) }
}
const section = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`)
const wallet = (p) => analyze(makeWallet(p).txs, DEFAULTS.wallet)

// Walk the satori tree and collect every string of text it will render.
function allText(node, out = []) {
  if (!node) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { node.forEach((n) => allText(n, out)); return out }
  const kids = node?.props?.children
  if (Array.isArray(kids)) kids.forEach((k) => allText(k, out))
  else if (kids !== undefined) allText(kids, out)
  return out
}

section('A. The card never prints a number the engine refused to claim')
{
  for (const [label, n] of [['n=9', 9], ['n=14', 14], ['n=19', 19]]) {
    const r = wallet({ nTrades: n, winRate: 0.28, winRet: 1.3, lossRet: 0.5,
      holdWinMin: 8, holdLossMin: 300, seed: 8300 + n })
    const m = buildCardModel(r)
    ok(r.score.value === null, `${label}: engine declines to score below the floor`,
      `got ${r.score.value}`)
    ok(m.score.value === null, `${label}: card shows no score number`, `got ${m.score.value}`)
    const txt = allText(cardTree(m)).join(' | ')
    ok(!/\/100\s*\d/.test(txt) && /not scored/i.test(txt),
      `${label}: rendered text says "not scored" and carries no score digits`,
      txt.slice(0, 120))
  }
  const scored = wallet({ nTrades: 40, winRate: 0.28, winRet: 1.3, lossRet: 0.5,
    holdWinMin: 8, holdLossMin: 300, seed: 8320 })
  ok(Number.isFinite(scored.score.value), 'n=40 does get scored', `${scored.score.value}`)
  ok(buildCardModel(scored).score.value === scored.score.value, 'card carries the engine score verbatim')
}

section('B. Card headline and diagnosis never disagree')
{
  const cases = [
    { nTrades: 90, winRate: 0.22, winRet: 1.25, lossRet: 0.45, holdWinMin: 6, holdLossMin: 40,
      gapAfterLossMin: 6, gapAfterWinMin: 30, buySizeCV: 1.2, interfaceFeeRate: 0.01, seed: 8401 },
    { nTrades: 80, winRate: 0.55, winRet: 1.55, lossRet: 0.8, holdWinMin: 200, holdLossMin: 190,
      gapAfterLossMin: 240, gapAfterWinMin: 240, buySizeCV: 0.04, retJitter: 0.06, seed: 8402 },
    { nTrades: 46, winRate: 0.48, winRet: 1.9, lossRet: 0.62, retJitter: 0.42,
      holdWinMin: 70, holdLossMin: 66, buySizeCV: 0.12, seed: 8403 },
    { nTrades: 12, winRate: 0.4, seed: 8404 },
  ]
  for (const p of cases) {
    const r = wallet(p)
    const m = buildCardModel(r)
    ok(m.headline === r.diagnosis.headline, `seed ${p.seed}: headline is the diagnosis headline verbatim`,
      `${m.headline} vs ${r.diagnosis.headline}`)
    ok(r.diagnosis.reading.startsWith(m.subline.replace(/…$/, '').trim().slice(0, 40)),
      `seed ${p.seed}: subline is a truncation of the reading, not a rewrite`)
    ok(m.axes[0].value === r.diagnosis.edge && m.axes[1].value === r.diagnosis.process,
      `seed ${p.seed}: axes match the diagnosis`)
  }
}

section('C. The sample size and reference basis always ride along')
{
  const r = wallet({ nTrades: 70, winRate: 0.34, holdWinMin: 10, holdLossMin: 300, seed: 8501 })
  const m = buildCardModel(r)
  ok(m.seam.includes(`${r.scorecard.closedTrades} closed trades`), 'seam states the trade count', m.seam)
  ok(m.seam.includes(r.confidence.label), 'seam states the confidence tier', m.seam)
  ok(/research-derived priors/.test(m.seam), 'seam discloses a prior basis when there is no cohort', m.seam)
  ok(!/ read read/.test(m.seam), 'seam has no duplicated wording', m.seam)

  // With a measured cohort the seam must say so instead.
  const rand = mulberry32(21)
  const recs = Array.from({ length: 640 }, (_, i) => ({ h: `c${i}`, n: 40,
    dispositionRatio: 1 + rand() * 40, panicIndex: rand(), revengeRatio: 1 + rand() * 15,
    sizingCV: rand() * 2, expectancy: -0.5 + rand(), profitFactor: rand() * 3, tollRate: rand() * 0.05 }))
  const { ladders, cohort } = buildLadders(recs)
  const rc = analyze(makeWallet({ nTrades: 70, winRate: 0.34, holdWinMin: 10, holdLossMin: 300, seed: 8501 }).txs,
    DEFAULTS.wallet, { ladders, cohort })
  const mc = buildCardModel(rc)
  ok(/640 measured wallets/.test(mc.seam), 'seam reports the measured cohort size', mc.seam)
  ok(/cohort-v1|measured basis/.test(mc.engine), 'engine line reports the measured basis', mc.engine)

  // Zero-trade wallets get a sentence, not a broken template.
  const empty = buildCardModel(analyze([], 'nobody'))
  ok(/no closed SOL-quoted trades/.test(empty.seam), 'empty wallet seam reads as a sentence', empty.seam)
  ok(empty.score.value === null, 'empty wallet is not scored')
}

section('D. Layout is renderable and bounded')
{
  const long = wallet({ nTrades: 128, winRate: 0.31, winRet: 1.62, lossRet: 0.56, retJitter: 0.09,
    holdWinMin: 11, holdLossMin: 310, buySizeCV: 0.5, seed: 8601 })
  const m = buildCardModel(long)
  ok(m.headline.length <= 46, 'headline stays short enough for one or two lines', `${m.headline.length} chars`)
  ok(m.subline.length <= 149, 'subline is clamped', `${m.subline.length} chars`)
  ok(!m.subline.includes('  '), 'no double spaces from clamping')
  ok(m.archetype === null || m.archetype.tagline.length <= 65, 'tagline clamped')

  for (const model of [m, genericCardModel(), buildCardModel(analyze([], 'nobody'))]) {
    const tree = cardTree(model)
    ok(tree.props.style.width === '1200px' && tree.props.style.height === '630px',
      'tree is 1200x630')
    const flat = JSON.stringify(tree)
    ok(!flat.includes('undefined'), 'no undefined leaks into the tree')
    ok(!/null,null/.test(flat), 'no null holes left in children arrays')
    // Satori only handles flexbox; a container with children must declare it.
    ok(!/"display":"(grid|inline)/.test(flat), 'no unsupported display modes')
  }
  ok(CARD_SIZE.width === 1200 && CARD_SIZE.height === 630, 'exported size is the OG standard')
}

section('E. The review ribbon is present until comms signs off')
{
  const txt = allText(cardTree(buildCardModel(wallet({ nTrades: 60, seed: 8701 })))).join(' | ')
  ok(/DRAFT - COMMS REVIEW REQUIRED/.test(txt), 'ribbon text is rendered on the card')
  ok(/POLAXORY/.test(txt), 'wordmark present')
  ok(/The Mirror/.test(txt), 'product name present')
}

section('F. No card ever renders advice, a prediction, or a profit claim')
{
  const models = [
    genericCardModel(),
    buildCardModel(analyze([], 'nobody')),
    ...[8801, 8802, 8803, 8804].map((seed, i) =>
      buildCardModel(wallet([
        { nTrades: 90, winRate: 0.22, winRet: 1.25, lossRet: 0.45, holdWinMin: 6, holdLossMin: 40, seed },
        { nTrades: 80, winRate: 0.55, winRet: 1.55, lossRet: 0.8, holdWinMin: 200, holdLossMin: 190, buySizeCV: 0.04, seed },
        { nTrades: 120, winRate: 0.44, winRet: 1.2, lossRet: 0.82, holdWinMin: 4, holdLossMin: 5, seed },
        { nTrades: 30, winRate: 0.36, holdWinMin: 20, holdLossMin: 200, seed },
      ][i])),
    ),
  ]
  // Language that would turn a research artifact into a solicitation.
  const FORBIDDEN = /\b(buy|sell|should|guarantee|profit potential|expected profits?|will (?:rise|fall|moon)|recommend|signal|alpha call)\b/i
  for (const m of models) {
    const txt = allText(cardTree(m)).join(' ')
    ok(!FORBIDDEN.test(txt), `card copy carries no advice or profit language (${m.headline.slice(0, 28)})`,
      (txt.match(FORBIDDEN) || [''])[0])
  }
}

console.log(`\n${'='.repeat(64)}`)
console.log(`\x1b[1mCARD VALIDATION\x1b[0m  ${pass} passed, ${fail} failed`)
if (fail) { console.log('\n\x1b[31mFailures:\x1b[0m'); failures.forEach((f) => console.log(`  - ${f}`)) }
console.log('='.repeat(64))
process.exit(fail ? 1 : 0)
