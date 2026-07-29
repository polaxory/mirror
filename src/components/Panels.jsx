import React, { useState } from 'react'
import { sol, pct, num, pfmt, dur, ratio, ci, ciPct, isNum, shortMint, when, STATUS_GLYPH } from '../fmt.js'

// ---------- diagnosis hero
//
// This panel leads the page, and the ordering is deliberate. The reader is
// assumed to be distracted and self-interested: the verdict arrives first, the
// two axes that explain it arrive second, and the confidence qualifier rides
// along beside them rather than standing in front of the payload. Depth is
// available below for whoever wants it; it never gates the punch.

export function Diagnosis({ diagnosis, confidence, sample }) {
  const axis = (label, value, map) => (
    <div className="axis">
      <div className="axis-label">{label}</div>
      <div className={`axis-val av-${map[value] || 'neutral'}`}>
        <span className="glyph">{STATUS_GLYPH[map[value] || 'neutral']}</span> {value}
      </div>
    </div>
  )
  const pos = { none: 0, sketch: 0.12, provisional: 0.38, indicative: 0.66, substantive: 1 }[confidence.key] ?? 0
  return (
    <div className="diag">
      <div className="diag-head">{diagnosis.headline}</div>
      <p className="diag-read">{diagnosis.reading}</p>
      <div className="axes">
        {axis('Edge', diagnosis.edge, { positive: 'good', negative: 'critical', unproven: 'warning' })}
        {axis('Process', diagnosis.process, { sound: 'good', leaky: 'warning', broken: 'critical', unclear: 'neutral' })}
        <div className="axis conf-axis">
          <div className="axis-label">Confidence</div>
          <div className="axis-val av-neutral">{confidence.label}</div>
          <div className="conf-track">
            <div className="conf-fill" style={{ width: `${Math.max(3, pos * 100)}%` }} />
          </div>
          <div className="conf-blurb">
            {confidence.n} closed trades of {sample.txScanned} tx scanned. {confidence.blurb}
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------- archetype mixture

export function ArchetypeMix({ archetype }) {
  if (archetype.unread) {
    return (
      <div className="panel">
        <div className="panel-h">Behavioral archetype</div>
        <div className="arch-name">{archetype.primary.name}</div>
        <div className="arch-tag">“{archetype.primary.tagline}”</div>
        <p className="arch-desc">{archetype.primary.desc}</p>
      </div>
    )
  }
  const p = archetype.primary
  return (
    <div className="panel">
      <div className="panel-h">
        Behavioral archetype
        {archetype.hedged && <span className="panel-sub">hedged — thin sample spreads the read</span>}
      </div>
      <div className="arch-name">{p.name} <span className="arch-p">{pct(p.p)}</span></div>
      <div className="arch-tag">“{p.tagline}”</div>
      <p className="arch-desc">{p.desc}</p>
      <div className="mixlist">
        {archetype.mixture.map((m) => (
          <div className="mixrow" key={m.key}>
            <span className="mixname">{m.name}</span>
            <div className="mixtrack"><div className="mixbar" style={{ width: `${Math.max(2, m.p * 100)}%` }} /></div>
            <span className="mixp">{pct(m.p)}</span>
          </div>
        ))}
      </div>
      <div className="chart-note">
        A mixture, not a label. Probabilities come from a softmax over weighted behavioral evidence; the
        spread widens automatically when the sample is thin.
      </div>
    </div>
  )
}

// ---------- exploitability

export function ScorePanel({ score }) {
  if (score.value === null) {
    return (
      <div className="panel score-panel">
        <div className="panel-h">Exploitability</div>
        <div className="score-null">Not scored</div>
        <div className="chart-note">{score.why}</div>
      </div>
    )
  }
  const c = score.components
  const bars = [
    ['Leak', c.leak, 'value given up per SOL risked'],
    ['Readability', c.readability, 'how scriptable the reactions are'],
    ['Cadence', c.cadence, 'decisions per day'],
  ]
  return (
    <div className="panel score-panel">
      <div className="panel-h">Exploitability</div>
      <div className="score-row">
        <div className="score-num">{score.value}</div>
        <div className="score-meta">
          <div className="score-grade">{score.grade}</div>
          {score.ci && <div className="score-ci">95% CI {score.ci.lo}–{score.ci.hi}</div>}
        </div>
      </div>
      <div className="complist">
        {bars.map(([label, v, note]) => (
          <div className="comprow" key={label}>
            <span className="compname">{label}</span>
            <div className="comptrack"><div className="compbar" style={{ width: `${Math.max(1.5, v * 100)}%` }} /></div>
            <span className="compv">{pct(v)}</span>
            <span className="compnote">{note}</span>
          </div>
        ))}
      </div>
      <div className="chart-note"><code>{score.formula}</code><br />{score.why}</div>
    </div>
  )
}

// ---------- trading scorecard

function Row({ label, value, sub, status }) {
  return (
    <div className="srow">
      <span className="skey">{label}</span>
      <span className="sval">{value}</span>
      {status ? (
        <span className={`sstat s-${status[0]}`}><span className="glyph">{STATUS_GLYPH[status[0]]}</span> {status[1]}</span>
      ) : (
        <span className="ssub">{sub || ''}</span>
      )}
    </div>
  )
}

export function Scorecard({ sc, behavior }) {
  const expStat = !isNum(sc.expectancy?.lo) ? null
    : sc.expectancy.lo > 0 ? ['good', 'proven positive']
    : sc.expectancy.hi < 0 ? ['critical', 'proven negative']
    : ['warning', 'not distinguishable from zero']
  const pfStat = !isNum(sc.profitFactor?.lo) ? null
    : sc.profitFactor.lo > 1 ? ['good', 'proven above 1']
    : sc.profitFactor.hi < 1 ? ['critical', 'proven below 1']
    : ['warning', 'straddles 1']

  return (
    <div className="panel">
      <div className="panel-h">
        Trading scorecard
        <span className="panel-sub">the same metrics a strategy would be judged on</span>
      </div>
      <div className="sgrid">
        <div className="scol">
          <Row label="Realized PnL" value={`${sol(sc.netPnlSol)} SOL`}
            sub={ci(sc.netPnlCI, (x) => sol(x, { sign: false, dp: 1 })) ? `95% CI ${ci(sc.netPnlCI, (x) => sol(x, { dp: 1 }))}` : ''} />
          <Row label="Expectancy / SOL risked" value={num(sc.expectancy?.point)} status={expStat} />
          <Row label="…shrunk to cohort" value={num(sc.expectancyShrunk?.value)}
            sub={`${pct(sc.expectancyShrunk?.weightOnData)} weight on your data`} />
          <Row label="Win rate" value={pct(sc.winRate?.point)}
            sub={ciPct(sc.winRate) ? `95% CI ${ciPct(sc.winRate)}` : ''} />
          <Row label="…shrunk to cohort" value={pct(sc.winRateShrunk?.value)}
            sub={`${pct(sc.winRateShrunk?.weightOnData)} weight on your data`} />
          <Row label="Profit factor" value={pfmt(sc.profitFactor?.point)} status={pfStat} />
          <Row label="Payoff ratio" value={isNum(sc.payoffRatio) ? `${num(sc.payoffRatio, 1)}x` : '—'}
            sub={`avg win ${sol(sc.avgWinSol, { sign: false })} / avg loss ${sol(sc.avgLossSol, { sign: false })}`} />
        </div>
        <div className="scol">
          <Row label="Trades (W/L)" value={sc.closedTrades}
            sub={`${sc.winsLosses?.[0]}W / ${sc.winsLosses?.[1]}L · ${sc.tokensTraded} tokens`} />
          <Row label="Toll paid" value={`${sol(sc.tollSol, { sign: false })} SOL`}
            status={behavior.toll?.verdict} />
          <Row label="PnL before toll" value={`${sol(sc.selectionPnlSol)} SOL`}
            sub={`${pct(sc.tollRate, 2)} of turnover went to fees`} />
          <Row label="Peak capital at risk" value={`${sol(sc.peakCapitalSol, { sign: false })} SOL`}
            sub={`${sol(sc.turnoverSol, { sign: false, dp: 0 })} SOL cycled through it`} />
          <Row label="Return on that capital" value={pct(sc.returnOnCapital)}
            sub={isNum(sc.returnOnCapital) && sc.returnOnCapital < -1 ? `lost ${num(-sc.returnOnCapital, 1)}x your peak stack` : ''} />
          <Row label="Max drawdown" value={`${sol(sc.maxDrawdownSol, { sign: false })} SOL`} />
          <Row label="Per-trade Sharpe" value={num(sc.tradeSharpe)}
            sub="per trade, not annualized" />
          <Row label="Top-3 share of profit" value={pct(sc.top3ShareOfGrossWin)} />
        </div>
      </div>
    </div>
  )
}

// ---------- behavior with percentile bars

// A percentile is meaningless without knowing what it was measured against, so
// every bar carries its own provenance: measured from real wallets, blended, or
// still resting on a research-derived prior.
const BASIS_LABEL = {
  measured: (p) => `measured · ${p.n} wallets`,
  blended: (p) => `part measured · ${p.n} wallets`,
  prior: () => 'prior estimate',
}

function BehaviorRow({ label, value, ciText, pctWorst, verdict, detail, prov }) {
  const basis = prov?.basis || 'prior'
  return (
    <div className="brow">
      <div className="btop">
        <span className="bkey">{label}</span>
        <span className="bval">{value}</span>
        {verdict && (
          <span className={`sstat s-${verdict[0]}`}><span className="glyph">{STATUS_GLYPH[verdict[0]]}</span> {verdict[1]}</span>
        )}
      </div>
      {isNum(pctWorst) && (
        <div className="ptrack" title={`${pct(pctWorst)} of the reference distribution sits below this value`}>
          <div className={`pfill pf-${basis}`} style={{ width: `${Math.max(1.5, pctWorst * 100)}%` }} />
          <span className="plabel">
            {pct(pctWorst)} below you
            <span className={`pbasis pb-${basis}`}>{(BASIS_LABEL[basis] || BASIS_LABEL.prior)(prov || {})}</span>
          </span>
        </div>
      )}
      <div className="bdetail">{detail}{ciText ? ` · 95% CI ${ciText}` : ''}</div>
    </div>
  )
}

export function BehaviorPanel({ b, cohort }) {
  const pm = cohort?.perMetric || {}
  const basis = cohort?.basis || 'prior'
  return (
    <div className="panel">
      <div className="panel-h">
        Behavioral read
        <span className="panel-sub">
          each with its interval and its position against{' '}
          {basis === 'prior'
            ? 'research-derived priors'
            : `${cohort.wallets} measured wallet${cohort.wallets === 1 ? '' : 's'}`}
        </span>
      </div>
      <BehaviorRow
        label="Disposition (losers held vs winners)"
        value={ratio(b.disposition?.point)}
        ciText={b.disposition?.ci ? ci(b.disposition.ci, (x) => `${num(x, 1)}x`) : null}
        pctWorst={b.disposition?.pctWorst}
        prov={pm.dispositionRatio}
        verdict={b.disposition?.verdict}
        detail={`winners ${dur(b.medianHoldWinMin)} · losers ${dur(b.medianHoldLossMin)} (medians, ${b.disposition?.nWin}W/${b.disposition?.nLoss}L)`}
      />
      <BehaviorRow
        label="Panic index (losses cut <10 min)"
        value={pct(b.panic?.point)}
        ciText={ciPct(b.panic)}
        pctWorst={b.panic?.pctWorst}
        prov={pm.panicIndex}
        verdict={b.panic?.verdict}
        detail={`${b.panic?.n || 0} losing exits examined`}
      />
      <BehaviorRow
        label="Revenge tempo (re-entry after loss vs win)"
        value={ratio(b.revenge?.point)}
        pctWorst={b.revenge?.pctWorst}
        prov={pm.revengeRatio}
        verdict={b.revenge?.verdict}
        detail={`next buy after a loss: ${dur(b.revenge?.medGapAfterLossMin)} · after a win: ${dur(b.revenge?.medGapAfterWinMin)}`}
      />
      <BehaviorRow
        label="Sizing consistency"
        value={isNum(b.sizing?.cv) ? `CV ${num(b.sizing.cv)}` : '—'}
        pctWorst={b.sizing?.pctWorst}
        prov={pm.sizingCV}
        verdict={b.sizing?.verdict}
        detail={`median buy ${sol(b.sizing?.medianBuySol, { sign: false })} SOL across ${b.sizing?.nBuys} buys${isNum(b.sizing?.escalation) ? ` · post-loss buys ${num(b.sizing.escalation, 1)}x baseline` : ''}`}
      />
      {b.trend && (
        <BehaviorRow
          label="Trajectory (first half vs second)"
          value={`${sol(b.trend.delta)} /SOL`}
          verdict={b.trend.delta > 0.1 ? ['good', 'improving'] : b.trend.delta < -0.1 ? ['serious', 'deteriorating'] : ['neutral', 'flat']}
          detail={`expectancy ${num(b.trend.first)} → ${num(b.trend.second)}`}
        />
      )}
    </div>
  )
}

// ---------- counterfactuals

export function Counterfactuals({ items }) {
  if (!items.length) return null
  return (
    <div className="panel">
      <div className="panel-h">
        What your habits cost
        <span className="panel-sub">computed on your own ledger</span>
      </div>
      {items.map((c) => (
        <div className="cfrow" key={c.key}>
          <div className="cftop">
            <span className="cflabel">{c.label}</span>
            <span className={`cfval ${isNum(c.deltaSol) ? (c.deltaSol > 0 ? 'cf-up' : 'cf-down') : ''}`}>
              {isNum(c.deltaSol) ? `${sol(c.deltaSol)} SOL`
                : isNum(c.pct) ? pct(c.pct)
                : c.exposure ? `${num(c.exposure.solDays, 1)} SOL-days`
                : '—'}
            </span>
            {c.hindsight && <span className="cfhind">hindsight</span>}
          </div>
          <div className="cfnote">{c.note}</div>
        </div>
      ))}
    </div>
  )
}

// ---------- findings

export function Findings({ strengths, leaks, diagnosis }) {
  const group = (items, kind) => items.filter((i) => i.kind === kind)
  const block = (title, items, cls) =>
    items.length === 0 ? null : (
      <div className={`fblock ${cls}`}>
        <div className="fblock-h">{title}</div>
        {items.map((f) => (
          <div className="fitem" key={f.title}>
            <div className="ftitle">{f.title}</div>
            <div className="fdetail">{f.detail}</div>
            <div className="fev">{f.evidence}</div>
          </div>
        ))}
      </div>
    )
  const none = strengths.length === 0 && leaks.length === 0
  return (
    <div className="panel">
      <div className="panel-h">
        Findings
        <span className="panel-sub">only claims the sample can support</span>
      </div>
      {none && (
        <div className="thin">
          Nothing here clears the evidence bar yet. Every finding requires its 95% interval to exclude the
          neutral value on a minimum subsample, so a thin history produces silence rather than flattery.
        </div>
      )}
      <div className="fgrid">
        {block('Outcome — did the money work', group(strengths, 'outcome'), 'good')}
        {block('Outcome — where it did not', group(leaks, 'outcome'), 'bad')}
        {block('Process — habits working for you', group(strengths, 'process'), 'good')}
        {block('Process — habits taxing you', group(leaks, 'process'), 'bad')}
      </div>
    </div>
  )
}

// ---------- open bags

const FLAG_NOTE = {
  'material-impact': 'selling this would move the pool',
  'exceeds-pool-depth': 'bag is larger than the whole pool',
  'pool-negligible': 'pool too shallow to price meaningfully',
  'depth-unknown': 'pool depth unknown',
  'non-sol-quote': 'marked via a non-SOL pool',
  unpriced: 'no tradable pool found',
}

// The combined figure, kept visually distinct from the scorecard so it can never be
// mistaken for a behavioral measurement. Realized is settled; the open portion is a
// live mark on positions that have not resolved.
export function PositionSummary({ position, bags }) {
  if (!position) return null
  const marked = isNum(position.unrealizedSol)
  return (
    <div className="panel posn">
      <div className="panel-h">
        Position to date
        <span className="panel-sub">realized fact plus an open mark — not a behavioral metric</span>
      </div>
      <div className="posrow">
        <div className="posbit">
          <div className="poslabel">Realized</div>
          <div className="posval">{sol(position.realizedSol)} SOL</div>
          <div className="possub">settled, from closed trades</div>
        </div>
        <div className="posop">{marked && position.unrealizedSol >= 0 ? '+' : marked ? '−' : '·'}</div>
        <div className="posbit">
          <div className="poslabel">Unrealized</div>
          <div className="posval">{marked ? `${sol(Math.abs(position.unrealizedSol), { sign: false })} SOL` : '—'}</div>
          <div className="possub">
            {marked
              ? isNum(position.unrealizedRealizableSol)
                ? `${sol(position.unrealizedRealizableSol)} after exit impact`
                : 'mark at spot'
              : 'could not be marked'}
          </div>
        </div>
        <div className="posop">=</div>
        <div className="posbit postotal">
          <div className="poslabel">Total</div>
          <div className="posval">{isNum(position.totalSol) ? `${sol(position.totalSol)} SOL` : '—'}</div>
          <div className="possub">
            {isNum(position.totalRealizableSol)
              ? `${sol(position.totalRealizableSol)} if you exited now`
              : 'realized only'}
          </div>
        </div>
      </div>
      <div className="chart-note">{position.caveat}</div>
    </div>
  )
}

export function OpenBags({ bags }) {
  if (!bags || !bags.count) return null
  const t = bags.totals || {}
  const marked = bags.basis === 'marked' || bags.basis === 'partial'
  return (
    <div className="panel">
      <div className="panel-h">
        Open positions
        <span className="panel-sub">
          {marked
            ? `marked at spot · ${t.pricedCount} of ${t.count} priced${isNum(t.coverage) ? ` (${pct(t.coverage)} of cost basis)` : ''}`
            : 'at cost basis — no mark available'}
        </span>
      </div>
      <div className="bagsum">
        {bags.count} position{bags.count === 1 ? '' : 's'} · {sol(t.costSol, { sign: false })} SOL of basis
        {marked && isNum(t.markSol) && <> · marked at {sol(t.markSol, { sign: false })} SOL</>}
        {marked && isNum(t.unrealizedSol) && (
          <span className={t.unrealizedSol >= 0 ? 'bagup' : 'bagdown'}>
            {' '}({sol(t.unrealizedSol)} unrealized)
          </span>
        )}
      </div>
      <div className="baglist">
        <div className="bagrow2 baghead">
          <span>token</span><span>basis</span><span>mark</span><span>if exited</span><span>opened</span>
        </div>
        {bags.items.map((b) => (
          <div className="bagrow2" key={b.mint}>
            <span className="bagmint">{shortMint(b.mint)}</span>
            <span className="bagnum">{sol(b.costSol, { sign: false })}</span>
            <span className={`bagnum ${b.priced ? (b.unrealizedSol >= 0 ? 'bagup' : 'bagdown') : 'bagnone'}`}>
              {b.priced ? sol(b.markSol, { sign: false }) : '—'}
            </span>
            {/* Coloured against BASIS, not against the mark, so a position whose
                mark reads as a gain while its exit reads as a loss shows that flip
                in the row. That inversion is the whole point of the column. */}
            <span
              className={`bagnum ${
                isNum(b.realizableSol)
                  ? b.realizableSol >= b.costSol ? 'bagup' : 'bagdown'
                  : 'bagnone'
              }`}
            >
              {isNum(b.realizableSol) ? sol(b.realizableSol, { sign: false }) : '—'}
            </span>
            <span className="bagage">{b.firstTs ? when(b.firstTs) : ''}</span>
            {b.flags?.length > 0 && (
              <span className="bagflags">
                {b.flags.map((fl) => FLAG_NOTE[fl] || fl).join(' · ')}
              </span>
            )}
          </div>
        ))}
      </div>
      <div className="chart-note">
        {marked ? (
          <>
            <b>A mark is not an exit.</b> “If exited” applies constant-product pool arithmetic to your own
            position size: a bag worth 10% of pool depth returns about 91% of its mark, one equal to pool depth
            about 50%. It assumes the deepest pool found, no swap fees, no routing, and nobody else selling —
            an upper bound on optimism, not a quote.
            {t.materialImpactCount > 0 && (
              <> {t.materialImpactCount} position{t.materialImpactCount === 1 ? '' : 's'} could not be sold at
              anything close to the marked price.</>
            )}
            {bags.partial && isNum(t.unpricedCostSol) && (
              <> {sol(t.unpricedCostSol, { sign: false })} SOL of basis had no tradable pool and is excluded
              from every marked figure.</>
            )}
            {bags.skipped > 0 && <> {bags.skipped} smaller position{bags.skipped === 1 ? '' : 's'} were not requested.</>}
            {' '}Marks are disclosure only: no metric, finding, diagnosis or score above reads a price.
          </>
        ) : (
          <>
            No tradable pool was found for these positions, so no market value is claimed and no unrealized PnL
            is stated. Cost basis is what you paid — treat it as exposure, not as a loss or a gain.
            {bags.note ? ` ${bags.note}` : ''}
          </>
        )}
      </div>
    </div>
  )
}

// ---------- audit trail

export function Method({ result }) {
  const [open, setOpen] = useState(false)
  const s = result.sample
  return (
    <div className="panel method">
      <button className="disclose" onClick={() => setOpen(!open)}>
        {open ? '▾' : '▸'} How it read you — method, assumptions, limits, and the ledger
      </button>
      {open && (
        <div className="method-body">
          <div className="mh">Sample</div>
          <ul>
            <li>{s.txScanned} transactions scanned · {s.swapEvents} SOL-quoted swap legs · {s.closedTrades} closed trades (FIFO)</li>
            <li>Excluded: {s.excluded.sellsWithoutBasis} sells with no matching buy in window, {s.excluded.nonSwapTx} non-swap transactions</li>
            <li>Window spans {num(s.spanDays, 1)} days · engine {result.engineVersion} · reference {result.referenceVersion}</li>
          </ul>
          {s.rotations && (
            <>
              <div className="mh">Token-to-token rotations</div>
              {s.rotations.total === 0 ? (
                <ul><li>None in this window — every trade went through SOL.</li></ul>
              ) : (
                <ul>
                  <li>
                    {s.rotations.total} rotation{s.rotations.total === 1 ? '' : 's'} found, contributing{' '}
                    {s.rotations.closedFromRotations} closed trade
                    {s.rotations.closedFromRotations === 1 ? '' : 's'} above.
                  </li>
                  {s.rotations.valued > 0 && (
                    <li>
                      <b>{s.rotations.valued} valued exactly.</b> The router passed through SOL, so the wallet's
                      wrapped-SOL account was credited and debited inside the same transaction — those gross
                      amounts are what each side was worth at the moment it happened. Observed, not modelled,
                      and not something a current price could tell us about a past swap.
                    </li>
                  )}
                  {s.rotations.basisRolled > 0 && (
                    <li>
                      <b>{s.rotations.basisRolled} carried their basis forward.</b> A direct token-to-token pool
                      with no SOL leg realizes nothing in SOL, so no profit or loss is claimed. The cost basis
                      moves into the new position instead, which is what makes the eventual sale settle the
                      whole chain at once.
                    </li>
                  )}
                  {(s.rotations.ambiguous + s.rotations.multiLeg + s.rotations.noBasis) > 0 && (
                    <li>
                      {s.rotations.ambiguous + s.rotations.multiLeg + s.rotations.noBasis} left unattributed
                      {s.rotations.multiLeg > 0 && ` (${s.rotations.multiLeg} moved several tokens at once)`}
                      {s.rotations.noBasis > 0 && ` (${s.rotations.noBasis} sold a token acquired before the window)`}
                      {s.rotations.ambiguous > 0 && ` (${s.rotations.ambiguous} had only one SOL leg, so the amount could not be split)`}
                      .
                    </li>
                  )}
                </ul>
              )}
            </>
          )}
          <div className="mh">Reference distribution</div>
          <ul>
            <li>
              Basis: <b>{result.cohort?.basis || 'prior'}</b> — {result.cohort?.version || result.referenceVersion}
            </li>
            {result.cohort?.rule && <li>{result.cohort.rule}</li>}
            {result.cohort?.perMetric && (
              <li>
                Per metric:{' '}
                {Object.values(result.cohort.perMetric)
                  .map((p) => `${p.metric} ${p.basis}${p.n ? ` (n=${p.n})` : ''}`)
                  .join(' · ')}
              </li>
            )}
            {result.cohort?.store && <li>Cohort store: {result.cohort.store.note}</li>}
          </ul>
          <div className="mh">Assumptions</div>
          <ul>{result.assumptions.map((a, i) => <li key={i}>{a}</li>)}</ul>
          <div className="mh">Limits</div>
          <ul>{result.limits.map((l, i) => <li key={i}>{l}</li>)}</ul>
          <div className="mh">Trade ledger (most recent {result.trades.length})</div>
          <div className="ledger">
            <div className="lrow lhead">
              <span>token</span><span>held</span><span>basis</span><span>proceeds</span><span>PnL</span><span>exit</span>
            </div>
            {result.trades.map((t, i) => (
              <div className={`lrow ${t.pnl > 0 ? 'l-up' : 'l-down'}`} key={i}>
                <span>{shortMint(t.mint)}</span>
                <span>{dur(t.holdMin)}</span>
                <span>{sol(t.cost, { sign: false })}</span>
                <span>{sol(t.proceeds, { sign: false })}</span>
                <span>{sol(t.pnl)}</span>
                <span>{when(t.exitTs)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
