// Share card: model and layout.
//
// PURE. No I/O, no rendering engine imported here. Two consumers use this one
// definition — api/card.js turns the tree into a PNG at the edge, and
// scripts/preview-card.mjs turns the same tree into an SVG on disk so the layout
// can be eyeballed without deploying. Work to code: one layout, two consumers,
// never a second copy that drifts.
//
// The card is the viral unit, which makes it the place where overclaiming would be
// most tempting and most damaging. Every gate the product applies applies here:
// an unscored wallet says "not scored", a hedged archetype says so, and the
// sample size rides on the card itself rather than being left off because it is
// unflattering.

const C = {
  page: '#0d0d0d',
  surface: '#1a1a19',
  hairline: 'rgba(255,255,255,0.10)',
  grid: '#2c2c2a',
  ink: '#ffffff',
  ink2: '#c3c2b7',
  muted: '#898781',
  accent: '#9085e9',
  good: '#0ca30c',
  warning: '#fab219',
  serious: '#ec835a',
  critical: '#d03b3b',
}

const AXIS_COLOR = {
  edge: { positive: C.good, negative: C.critical, unproven: C.warning },
  process: { sound: C.good, leaky: C.warning, broken: C.critical, unclear: C.ink2 },
}
const GLYPH = { [C.good]: '▲', [C.warning]: '◆', [C.serious]: '▼', [C.critical]: '▼', [C.ink2]: '●' }

// ---------------------------------------------------------------- model

export function buildCardModel(result) {
  if (!result || !result.diagnosis) {
    return {
      kind: 'empty',
      headline: 'No read available',
      subline: 'The machine found no closed SOL-quoted trades to work with.',
      archetype: null, score: null, axes: [], seam: 'nothing measured',
    }
  }
  const d = result.diagnosis
  const a = result.archetype
  const s = result.score
  const sc = result.scorecard
  const conf = result.confidence

  const scored = Number.isFinite(s?.value)
  const archName = a?.unread ? a.primary?.name : a?.primary?.name
  const archPct = a?.unread || !Number.isFinite(a?.primary?.p) ? null : Math.round(a.primary.p * 100)

  // The seam line. Sample size and reference basis always ride along — a card
  // that shows a verdict without its sample is the thing v0 got wrong, published.
  const basis = result.cohort?.basis || 'prior'
  const cohortBit =
    basis === 'prior'
      ? 'vs research-derived priors'
      : `vs ${result.cohort.wallets} measured wallet${result.cohort.wallets === 1 ? '' : 's'}`

  const trades = sc?.closedTrades ?? 0
  const seam =
    trades === 0
      ? 'no closed SOL-quoted trades in the scan window'
      : `${trades} closed trades · ${conf?.label || '—'} confidence · ${cohortBit}`

  return {
    kind: 'read',
    headline: d.headline,
    // Keep the reading short enough to stay legible at card size; the page carries
    // the full text.
    subline: clamp(d.reading, 148),
    archetype: archName ? { name: archName, pct: archPct, hedged: !!a?.hedged, tagline: clamp(a?.primary?.tagline || '', 64) } : null,
    score: scored
      ? { value: s.value, grade: s.grade, ci: s.ci ? `${s.ci.lo}–${s.ci.hi}` : null }
      : { value: null, grade: (s?.grade || 'not scored').toLowerCase(), ci: null },
    axes: [
      { label: 'Edge', value: d.edge, color: AXIS_COLOR.edge[d.edge] || C.ink2 },
      { label: 'Process', value: d.process, color: AXIS_COLOR.process[d.process] || C.ink2 },
      { label: 'Confidence', value: (conf?.label || '—').toLowerCase(), color: C.ink2 },
    ],
    seam,
    engine: `${result.engineVersion || 'engine'} · ${basis} basis`,
  }
}

const clamp = (s, n) => {
  if (!s) return ''
  if (s.length <= n) return s
  const cut = s.slice(0, n)
  const sp = cut.lastIndexOf(' ')
  return `${(sp > n * 0.6 ? cut.slice(0, sp) : cut).trimEnd()}…`
}

// ---------------------------------------------------------------- layout
//
// Satori element tree as plain objects — no JSX, so no build step and the same
// tree renders in the edge runtime and in a local node script. Satori supports a
// flexbox subset only: every container with children declares display flex.

const box = (style, children) => ({ type: 'div', props: { style: { display: 'flex', ...style }, children } })
const text = (style, content) => ({ type: 'div', props: { style: { display: 'flex', ...style }, children: content } })

export function cardTree(model, { site = 'polaxory' } = {}) {
  const headlineSize = model.headline.length > 30 ? 58 : model.headline.length > 22 ? 66 : 76

  // The score block only claims a measurement when there is one. On the generic
  // card there is no wallet, so the "exploitability / 100" label is omitted
  // entirely rather than captioning an em-dash.
  const isRead = model.kind === 'read'
  const scoreBlock = box({ flexDirection: 'column', alignItems: 'flex-end' },
    model.score.value !== null
      ? [
          text({ fontSize: 96, fontWeight: 800, lineHeight: 0.9 }, String(model.score.value)),
          text({ fontSize: 15, color: C.muted, marginTop: 10 }, 'exploitability / 100'),
          text({ fontSize: 19, fontWeight: 700, color: C.ink2, marginTop: 3 }, model.score.grade),
          model.score.ci ? text({ fontSize: 14, color: C.muted, marginTop: 3 }, `95% CI ${model.score.ci}`) : null,
        ].filter(Boolean)
      : isRead
        ? [
            text({ fontSize: 44, fontWeight: 800, color: C.ink2, lineHeight: 1 }, 'not scored'),
            text({ fontSize: 15, color: C.muted, marginTop: 10, maxWidth: '260px', textAlign: 'right' },
              'exploitability needs 20+ closed trades'),
          ]
        : [text({ fontSize: 22, fontWeight: 700, color: C.accent }, model.score.grade)],
  )

  // Three bands distributed by space-between rather than a growing middle. A
  // flexGrow on the verdict pushed the footer past the fixed 630px edge and
  // clipped the ribbon; a card has an exact height, so the layout allocates
  // rather than expands.
  return box(
    {
      width: '1200px', height: '630px', backgroundColor: C.page, color: C.ink,
      flexDirection: 'column', justifyContent: 'space-between',
      padding: '46px 60px 28px', fontFamily: 'sans-serif',
    },
    [
      // ---- masthead
      box({ alignItems: 'baseline', justifyContent: 'space-between' }, [
        box({ alignItems: 'baseline' }, [
          text({ fontSize: 24, fontWeight: 800, letterSpacing: '0.22em' }, 'POLAXORY'),
          text({ fontSize: 20, color: C.muted, marginLeft: 16 }, 'The Mirror'),
        ]),
        text({ fontSize: 16, color: C.muted, letterSpacing: '0.04em' }, model.engine),
      ]),

      // ---- verdict, leading. The distracted reader gets the payload first.
      box({ flexDirection: 'column' }, [
        text(
          { fontSize: headlineSize, fontWeight: 800, letterSpacing: '-0.02em', lineHeight: 1.04, maxWidth: '760px' },
          model.headline,
        ),
        text(
          { fontSize: 22, color: C.ink2, marginTop: 18, lineHeight: 1.42, maxWidth: '700px' },
          model.subline,
        ),
        model.archetype
          ? box({ alignItems: 'baseline', marginTop: 22 }, [
              text({ fontSize: 27, fontWeight: 700, color: C.accent }, model.archetype.name),
              model.archetype.pct !== null
                ? text({ fontSize: 21, color: C.accent, marginLeft: 12, opacity: 0.85 }, `${model.archetype.pct}%`)
                : null,
              model.archetype.hedged
                ? text({ fontSize: 15, color: C.muted, marginLeft: 14 }, 'hedged — thin sample')
                : null,
            ].filter(Boolean))
          : null,
      ].filter(Boolean)),

      // ---- footer band: axes + score, then the attribution/ribbon row
      box({ flexDirection: 'column' }, [
      box({ borderTop: `1px solid ${C.hairline}`, paddingTop: 20, alignItems: 'flex-end', justifyContent: 'space-between' }, [
        box({ flexDirection: 'column', paddingRight: '40px' }, [
          box({}, model.axes.map((ax, i) =>
            box({ flexDirection: 'column', marginRight: i < model.axes.length - 1 ? 46 : 0 }, [
              text({ fontSize: 14, color: C.muted, letterSpacing: '0.1em', textTransform: 'uppercase' }, ax.label),
              box({ alignItems: 'center', marginTop: 7 }, [
                text({ fontSize: 13, color: ax.color, marginRight: 7 }, GLYPH[ax.color] || '●'),
                text({ fontSize: 25, fontWeight: 700, color: ax.color }, ax.value),
              ]),
            ]),
          )),
          text({ fontSize: 15, color: C.muted, marginTop: 18, maxWidth: '640px' }, model.seam),
        ]),
        scoreBlock,
      ]),

      // ---- review ribbon, in normal flow with its own allocated row.
      // It was absolutely positioned bottom-right in a first draft and printed
      // straight through the score's grade and interval. Knolling: allocate space,
      // never overlay. Required on visual media until comms signs off; see README
      // for the one-line removal.
      box({ marginTop: 18, alignItems: 'center', justifyContent: 'space-between' }, [
        text({ fontSize: 14, color: C.muted }, `${site} · behavioral research on public on-chain flow`),
        box({ border: `1px solid ${C.hairline}`, borderRadius: '6px', padding: '5px 9px' }, [
          text({ fontSize: 11, color: C.muted, letterSpacing: '0.08em' }, 'DRAFT - COMMS REVIEW REQUIRED'),
        ]),
      ]),
      ]),
    ],
  )
}

// A card for the bare site, with no wallet behind it.
export function genericCardModel() {
  return {
    kind: 'generic',
    headline: 'See what the machine sees.',
    subline: 'Paste a Solana wallet. The engine rebuilds every closed trade, separates what the market did to you from what the house took, and states only what the sample can prove.',
    archetype: null,
    score: { value: null, grade: 'read your wallet', ci: null },
    axes: [
      { label: 'Measures', value: 'behavior', color: C.ink2 },
      { label: 'Claims', value: 'only proven', color: C.good },
      { label: 'Advice', value: 'none', color: C.ink2 },
    ],
    seam: 'every rate carries a 95% interval · a thin history produces silence, not flattery',
    engine: 'engine-v1',
  }
}

export const CARD_SIZE = { width: 1200, height: 630 }
export const CARD_COLORS = C
