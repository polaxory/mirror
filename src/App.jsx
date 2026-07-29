import React, { useEffect, useState } from 'react'
import { DEMO_RESULT } from './demo.js'
import EquityCurve from './components/EquityCurve.jsx'
import {
  Diagnosis, ArchetypeMix, ScorePanel, Scorecard, PositionSummary,
  BehaviorPanel, Counterfactuals, Findings, OpenBags, Method,
} from './components/Panels.jsx'
import { shortAddr, pct } from './fmt.js'

const LOADING_LINES = [
  'Rebuilding your ledger, FIFO…',
  'Separating what you paid from what you picked…',
  'Timing your re-entries…',
  'Bootstrapping intervals…',
  'Checking which claims the sample can carry…',
]

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

export default function App() {
  const [address, setAddress] = useState('')
  const [state, setState] = useState('idle')
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')
  const [line, setLine] = useState(0)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (state !== 'loading') return
    const id = setInterval(() => setLine((l) => (l + 1) % LOADING_LINES.length), 1300)
    return () => clearInterval(id)
  }, [state])

  // A shared link lands on /w/<address>, which the share function rewrites to
  // /?w=<address> after emitting the crawler meta tags. Pick it up and read the
  // wallet straight away, so the person arriving from a post sees the same verdict
  // the card promised rather than an empty input box.
  useEffect(() => {
    const w = new URLSearchParams(window.location.search).get('w')
    if (w && BASE58.test(w.trim())) {
      setAddress(w.trim())
      run(w.trim())
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const run = async (addr) => {
    setState('loading'); setError('')
    try {
      const r = await fetch(`/api/analyze?address=${encodeURIComponent(addr)}`)
      // Anything that is not JSON is infrastructure, not an answer: a gateway
      // timeout page, a proxy error, or the dev server handing back the function's
      // own source. Parsing it and surfacing the parse failure showed the user
      // "Unexpected token '/'", which reads as a broken product rather than a
      // service that is momentarily unavailable.
      const body = await r.text()
      let data
      try { data = JSON.parse(body) } catch {
        throw new Error(
          r.ok
            ? 'The machine answered with something that was not a reading. This usually means the API is not running — in local development, use `vercel dev` so the functions execute.'
            : `The machine is unreachable right now (${r.status}). Try again in a moment.`,
        )
      }
      if (!r.ok) throw new Error(data.error || `The machine refused that request (${r.status}).`)
      setResult(data); setState('done')
      window.scrollTo({ top: 0 })
    } catch (e) {
      setError(e.message || 'Something broke.'); setState('error')
    }
  }

  const runDemo = () => {
    setState('loading')
    setTimeout(() => { setResult(DEMO_RESULT); setState('done'); window.scrollTo({ top: 0 }) }, 1800)
  }

  const reset = () => {
    setResult(null); setAddress(''); setState('idle'); setError(''); setCopied(false)
    if (window.location.search) window.history.replaceState({}, '', '/')
  }

  // The share URL is /w/<address>, not a query string on the app: only that route
  // returns server-rendered meta tags, and crawlers do not run the SPA. The demo
  // has no wallet behind it, so it shares the site itself.
  const shareUrl =
    result && !result.demo && BASE58.test(result.wallet || '')
      ? `${window.location.origin}/w/${result.wallet}`
      : (typeof window !== 'undefined' ? window.location.origin : '')

  const shareText = result
    ? `The machine read my wallet.\n\n${result.diagnosis.headline}\n${result.archetype.primary.name}${Number.isFinite(result.archetype.primary?.p) ? ` (${pct(result.archetype.primary.p)})` : ''} · exploitability ${Number.isFinite(result.score.value) ? `${result.score.value}/100` : 'not scored'} · ${result.scorecard.closedTrades} closed trades\n\nSee what it sees:`
    : ''

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2200)
    } catch { /* clipboard blocked — the tweet intent still carries the URL */ }
  }

  return (
    <div className="page">
      <header className="head">
        <button className="wordmark" onClick={reset}>POLAXORY</button>
        <div className="product">The Mirror</div>
        <div className="ver">engine v1</div>
      </header>

      {state !== 'done' && (
        <section className="hero">
          <h1>See what the machine sees<span className="accent">.</span></h1>
          <p className="sub">
            Paste a Solana wallet. The engine rebuilds every closed trade, separates what the market did to you
            from what the house took, measures the habits behind it, and states only what the sample can prove.
          </p>
          <div className="inputrow">
            <input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="Solana wallet address"
              spellCheck={false}
              onKeyDown={(e) => e.key === 'Enter' && address && run(address.trim())}
            />
            <button className="go" disabled={!address || state === 'loading'} onClick={() => run(address.trim())}>
              {state === 'loading' ? 'Reading…' : 'Read me'}
            </button>
          </div>
          <button className="demolink" onClick={runDemo} disabled={state === 'loading'}>
            or watch it read a demo wallet →
          </button>
          {state === 'loading' && <div className="loadline">{LOADING_LINES[line]}</div>}
          {state === 'error' && <div className="errline">{error}</div>}
          <div className="promise">
            <div className="promise-h">What this will and will not tell you</div>
            <ul>
              <li>Every rate carries a 95% interval. A claim only appears when its interval clears the neutral value.</li>
              <li>Strengths are reported as prominently as leaks, and split into outcome versus process.</li>
              <li>A thin history produces silence, not flattery. Under twenty closed trades, nothing is scored.</li>
              <li>Open bags are marked at spot and adjusted for what exiting them would actually return — a mark is never presented as an exit.</li>
              <li>No price predictions, no signals, no advice. It reads your past behavior and shows the arithmetic.</li>
            </ul>
          </div>
        </section>
      )}

      {state === 'done' && result && (
        <section className="result">
          <div className="rhead">
            <span className="rwallet">{result.demo ? 'demo wallet' : shortAddr(result.wallet)}</span>
            <button className="again" onClick={reset}>Read another →</button>
          </div>

          <Diagnosis diagnosis={result.diagnosis} confidence={result.confidence} sample={result.sample} />

          <div className="two">
            <ArchetypeMix archetype={result.archetype} />
            <ScorePanel score={result.score} />
          </div>

          <Scorecard sc={result.scorecard} behavior={result.behavior} />
          {result.openBags?.count > 0 && (
            <PositionSummary position={result.position} bags={result.openBags} />
          )}
          <EquityCurve equity={result.scorecard.equity} maxDD={result.scorecard.maxDrawdownSol} />
          <BehaviorPanel b={result.behavior} cohort={result.cohort} />
          <Counterfactuals items={result.counterfactuals} />
          <Findings strengths={result.strengths} leaks={result.leaks} diagnosis={result.diagnosis} />
          <OpenBags bags={result.openBags} />
          <Method result={result} />

          <div className="actions">
            <a className="share"
              href={`https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText)}&url=${encodeURIComponent(shareUrl)}`}
              target="_blank" rel="noreferrer">
              Post the verdict on X
            </a>
            <button className="again" onClick={copyLink}>
              {copied ? 'Link copied' : 'Copy share link'}
            </button>
            <button className="again" onClick={reset}>Read another wallet</button>
          </div>
          {!result.demo && (
            <div className="sharenote">
              The link renders its own card — verdict, archetype, score, and the sample it rests on.
              The card is generated from the wallet, so it always shows what the machine actually says.
            </div>
          )}
        </section>
      )}

      <footer className="foot">
        <div>Polaxory — behavioral research on public on-chain flow. Methods public, parameters private.</div>
        <div className="foot-legal">
          Research and entertainment. Not investment advice, not a signal service, no predictions.
          Reads public blockchain data only.
        </div>
      </footer>

      <div className="watermark">DRAFT - COMMS REVIEW REQUIRED</div>
    </div>
  )
}
